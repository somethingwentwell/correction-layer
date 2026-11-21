/**
 * Observing artifact versions and running checks (docs/03 §7, docs/06 §2).
 *
 * A check: identify and normalize the bytes -> resolve context -> select the
 * in-scope rules by index -> evaluate every one of them -> record the run, its
 * events and (only if Ready and a gateway handles the action) a receipt, in one
 * transaction. A check finds problems; it never edits an artifact, never approves
 * and never performs an action.
 */
import { assertValid } from "../contracts/schemas.ts";
import { sha256, digestOf } from "../domain/canonical.ts";
import { ClError, NotFound } from "../domain/errors.ts";
import type { IdGen } from "../domain/ids.ts";
import { SYS } from "../domain/ids.ts";
import type { Clock } from "../domain/time.ts";
import { ts } from "../domain/time.ts";
import type { ActionEnvelope, Actor, Finding, NormalizedArtifact, Outcome, ResolvedContext, RuleRevisionContent, RunRecord, SourceSnapshot, Verdict } from "../domain/types.ts";
import type { ExceptionService } from "../policy/exceptions.ts";
import type { ProjectService } from "../context/projects.ts";
import type { EngineOutput } from "../engine/evaluate.ts";
import { ENGINE_VERSION, effectiveEnforcement, evaluate } from "../engine/evaluate.ts";
import type { ReadResult } from "../formats/adapters.ts";
import { readArtifact } from "../formats/adapters.ts";
import type { Gateway } from "../gate/gateway.ts";
import type { Ledger } from "../ledger/ledger.ts";
import type { RuleService, Selection } from "../policy/rules.ts";
import type { Db } from "../store/db.ts";
import { all, get, json, parse, run, tx } from "../store/db.ts";
import type { AppliedException } from "../engine/evaluate.ts";
import type { ContentDiffResult } from "./diff.ts";
import { diffArtifacts } from "./diff.ts";

export interface ObservedVersion {
  artifact_id: string;
  name: string;
  project_id: string;
  version_seq: number;
  content_hash: string;
  normalized: NormalizedArtifact | null;
  parse_error: string | null;
  is_new_version: boolean;
  event_id: string | null;
}

export interface CheckResponse {
  /** Guidance and checkpoint integrations are both advisory (docs/06 §1). */
  enforcement_tier: "advisory";
  run_id: string | null;
  context: { status: ResolvedContext["status"]; project_id: string | null; work_type: string; context_changed: boolean };
  policy_rev: number;
  verdict: Verdict | null;
  /** Rendered by the service; clients show it verbatim. Always begins "Advisory check". */
  human_summary: string;
  counts: RunRecord["counts"] | null;
  review_url: string | null;
  receipt_id: string | null;
  /** Why no receipt exists, when the verdict was Ready but none was issued. */
  receipt_unavailable_reason: string | null;
}

export interface CheckRequest {
  project_id?: string | null;
  path?: string | null;
  name: string;
  bytes: Uint8Array;
  action: ActionEnvelope;
  actor: Actor;
  trigger?: RunRecord["trigger"];
  session_id?: string;
}

export interface RerunReport {
  run_id: string;
  status: "identical" | "mismatch" | "purged" | "inputs_missing";
  problems: Array<{ kind: "mismatch" | "purged" | "not_recorded" | "not_reproducible" | "unreadable"; detail: string }>;
  results: Array<{ rule_id: string; title: string; recorded: string; now: string | null; same: boolean }>;
  verdict: Verdict | null;
  inputs_digest_matches: boolean;
}

export type VersionListener = (version: ObservedVersion) => void;

const VERDICT_WORDS: Record<Verdict, string> = { ready: "Ready", needs_changes: "Needs changes", could_not_verify: "Couldn't verify" };

export class CheckService {
  private db: Db;
  private ledger: Ledger;
  private clock: Clock;
  private ids: IdGen;
  private rules: RuleService;
  private projects: ProjectService;
  private gateway: Gateway;
  private exceptions: ExceptionService;
  private displayTz: string;
  private listeners: VersionListener[] = [];
  private lastSessionProject = new Map<string, string>();

  constructor(deps: { db: Db; ledger: Ledger; clock: Clock; ids: IdGen; rules: RuleService; projects: ProjectService; gateway: Gateway; exceptions: ExceptionService; displayTz: string }) {
    this.db = deps.db;
    this.ledger = deps.ledger;
    this.clock = deps.clock;
    this.ids = deps.ids;
    this.rules = deps.rules;
    this.projects = deps.projects;
    this.gateway = deps.gateway;
    this.exceptions = deps.exceptions;
    this.displayTz = deps.displayTz;
  }

  /** Called after a new artifact version is stored (learning re-tests waiting candidates on it). */
  onNewVersion(listener: VersionListener): void {
    this.listeners.push(listener);
  }

  // ------------------------------------------------------------ versions
  /**
   * Record a version of an artifact: bytes into the blob store, normalized form
   * beside them. Lineage in Phase 1 is (project, file name); a known hash is the
   * same version. Attribution is explicit or "unknown editor" - never guessed.
   */
  observe(input: { project_id: string; name: string; bytes: Uint8Array; declared_by?: Actor; is_demo?: boolean; fix_id?: string }): ObservedVersion {
    const project = this.projects.get(input.project_id);
    const contentHash = sha256(input.bytes);
    const observed = tx(this.db, (): ObservedVersion => {
      const now = ts(this.clock.now());
      let artifact = get<{ artifact_id: string }>(this.db, "SELECT artifact_id FROM artifacts WHERE project_id = ? AND name = ?", project.project_id, input.name);
      if (!artifact) {
        artifact = { artifact_id: this.ids("art") };
        run(this.db, "INSERT INTO artifacts (artifact_id, workspace_id, project_id, name, is_demo, created_at) VALUES (?,?,?,?,?,?)", artifact.artifact_id, project.workspace_id, project.project_id, input.name, input.is_demo || project.is_demo ? 1 : 0, now);
      }
      const known = get<any>(this.db, "SELECT version_seq, normalized_json, parse_error FROM artifact_versions WHERE artifact_id = ? AND content_hash = ?", artifact.artifact_id, contentHash);
      if (known) {
        return { artifact_id: artifact.artifact_id, name: input.name, project_id: project.project_id, version_seq: known.version_seq, content_hash: contentHash, normalized: parse(known.normalized_json), parse_error: known.parse_error, is_new_version: false, event_id: null };
      }
      const previous = get<{ version_seq: number; content_hash: string }>(this.db, "SELECT version_seq, content_hash FROM artifact_versions WHERE artifact_id = ? ORDER BY version_seq DESC LIMIT 1", artifact.artifact_id);
      const seq = (previous?.version_seq ?? 0) + 1;
      const read: ReadResult = readArtifact(input.bytes, input.name, project.default_work_type);
      const normalized: NormalizedArtifact | null = read.parsed
        ? { schema_version: "cl.artifact/1", artifact_id: artifact.artifact_id, name: input.name, version: { seq, content_hash: contentHash, size_bytes: input.bytes.length, observed_at: now }, identity: read.identity, ...read.parsed }
        : null;
      if (normalized) assertValid("artifact", normalized, "normalized artifact");
      run(this.db, "INSERT INTO blobs (content_hash, bytes, size_bytes) VALUES (?,?,?) ON CONFLICT (content_hash) DO NOTHING", contentHash, input.bytes, input.bytes.length);
      run(this.db, "INSERT INTO artifact_versions (artifact_id, version_seq, content_hash, size_bytes, normalized_json, parse_error, observed_at) VALUES (?,?,?,?,?,?,?)",
        artifact.artifact_id, seq, contentHash, input.bytes.length, normalized ? json(normalized) : null, read.error?.message ?? null, now);
      const event = this.ledger.append({
        type: "artifact.observed", project_id: project.project_id, actor: { kind: "system", id: SYS.service }, subject: { kind: "artifact", id: artifact.artifact_id },
        refs: { artifact_id: artifact.artifact_id, content_hash: contentHash }, summary: `Version ${seq} of ${input.name} was seen${read.error ? " (it could not be read)" : ""}.`,
        payload: { version_seq: seq, detected_type: read.identity.detected_type, extension_matches: read.identity.extension_matches, readable: !read.error, risk_flags: (read.parsed?.risk_flags ?? []).map((f) => f.flag) },
      });
      if (previous) {
        // The engine never edits artifacts. Who changed the file is declared or unknown.
        const by = input.declared_by;
        this.ledger.append({
          type: "change.recorded", project_id: project.project_id, actor: by ?? { kind: "system", id: SYS.service }, subject: { kind: "artifact", id: artifact.artifact_id },
          refs: { artifact_id: artifact.artifact_id, content_hash: contentHash, change_id: this.ids("chg"), ...(input.fix_id ? { fix_id: input.fix_id } : {}) }, caused_by: [event.event_id],
          summary: `${input.name} changed from version ${previous.version_seq} to ${seq}, ${by ? (by.kind === "human" ? `declared by ${by.display_name ?? by.id}` : `declared by ${by.display_name ?? by.id} (an assistant${by.on_behalf_of ? `, for ${by.on_behalf_of}` : ""}; not verified)`) : "by an unknown editor"}${input.fix_id ? `, applying proposal ${input.fix_id}` : ""}.`,
          payload: { before_hash: previous.content_hash, after_hash: contentHash, attribution: by ? (by.kind === "human" ? "declared" : "declared_by_assistant") : "unknown_editor", ...(input.fix_id ? { applied_fix: input.fix_id } : {}) },
        });
      }
      return { artifact_id: artifact.artifact_id, name: input.name, project_id: project.project_id, version_seq: seq, content_hash: contentHash, normalized, parse_error: read.error?.message ?? null, is_new_version: true, event_id: event.event_id };
    });
    if (observed.is_new_version) for (const listener of this.listeners) listener(observed);
    return observed;
  }

  latestVersions(projectId: string): Array<{ artifact_id: string; name: string; version_seq: number; content_hash: string; normalized: NormalizedArtifact | null; parse_error: string | null; observed_at: string; is_demo: boolean }> {
    return all<any>(this.db, `SELECT a.artifact_id, a.name, a.is_demo, v.version_seq, v.content_hash, v.normalized_json, v.parse_error, v.observed_at FROM artifacts a JOIN artifact_versions v ON v.artifact_id = a.artifact_id
      WHERE a.project_id = ? AND v.version_seq = (SELECT MAX(version_seq) FROM artifact_versions WHERE artifact_id = a.artifact_id) ORDER BY a.name`, projectId)
      .map((r) => ({ artifact_id: r.artifact_id, name: r.name, version_seq: r.version_seq, content_hash: r.content_hash, normalized: parse(r.normalized_json), parse_error: r.parse_error, observed_at: r.observed_at, is_demo: !!r.is_demo }));
  }

  versions(artifactId: string): Array<{ version_seq: number; content_hash: string; normalized: NormalizedArtifact | null; observed_at: string }> {
    return all<any>(this.db, "SELECT version_seq, content_hash, normalized_json, observed_at FROM artifact_versions WHERE artifact_id = ? ORDER BY version_seq", artifactId)
      .map((r) => ({ version_seq: r.version_seq, content_hash: r.content_hash, normalized: parse(r.normalized_json), observed_at: r.observed_at }));
  }

  artifact(artifactId: string): { artifact_id: string; project_id: string; name: string } {
    const row = get<any>(this.db, "SELECT artifact_id, project_id, name FROM artifacts WHERE artifact_id = ?", artifactId);
    if (!row) throw new NotFound("artifact", artifactId);
    return row;
  }

  // ------------------------------------------------------------ checks
  private sourcesFor(selection: Selection): SourceSnapshot[] {
    const ids = [...new Set(selection.rules.map((r) => r.content.source?.source_id).filter((s): s is string => !!s))];
    return ids.map((id) => this.projects.latestSnapshot(id)).filter((s): s is SourceSnapshot => s !== null);
  }

  check(req: CheckRequest): CheckResponse {
    // Scheduled ends recorded first: a pause or an exception that has run out no longer applies.
    this.rules.endDueSuspensions();
    this.exceptions.expireDue();
    const context = this.projects.resolve({ project_id: req.project_id, path: req.path });
    const policyRev = this.rules.policyRev();
    if (context.status !== "resolved" || !context.project_id) {
      // Unknown origin: stop and ask. No run, no receipt (docs/04 §4).
      return {
        enforcement_tier: "advisory", run_id: null, context: { status: context.status, project_id: null, work_type: context.work_type, context_changed: false }, policy_rev: policyRev,
        verdict: null, human_summary: "Advisory check: not checked. This file is not in a registered project folder. Ask the user which project to check it as.",
        counts: null, review_url: null, receipt_id: null, receipt_unavailable_reason: "context_unresolved",
      };
    }
    const projectId = context.project_id;
    const sessionKey = req.session_id ?? req.actor.session_id;
    const contextChanged = !!sessionKey && this.lastSessionProject.has(sessionKey) && this.lastSessionProject.get(sessionKey) !== projectId;
    if (sessionKey) this.lastSessionProject.set(sessionKey, projectId);

    const version = this.observe({ project_id: projectId, name: req.name, bytes: req.bytes });
    return tx(this.db, () => {
      const now = ts(this.clock.now());
      const runId = this.ids("run");
      const artifactType = version.normalized?.artifact_type ?? "document";
      const selection = this.rules.selectInScope({ project_id: projectId, area_ids: context.area_ids, artifact_id: version.artifact_id, work_type: context.work_type, artifact_type: artifactType, action: req.action.type });
      let output: EngineOutput;
      const sources = this.sourcesFor(selection);
      const exceptions = version.normalized ? this.exceptions.applicable(projectId, version.artifact_id, now) : [];
      if (version.normalized) {
        output = evaluate({ run_id: runId, artifact: version.normalized, action: req.action, context, rules: selection.rules, sources, exceptions, as_of: now });
      } else {
        // The file could not be read: every in-scope rule is `unknown`, and the verdict cannot be Ready.
        const results = selection.rules.map((r) => ({
          rule_id: r.content.rule_id, revision: r.content.revision, title: r.content.title, rule_status: r.status, method: r.content.method, enforcement: r.content.enforcement,
          effective_enforcement: effectiveEnforcement(r.content, r.status), outcome: "unknown" as const, reason: `the file could not be read: ${version.parse_error}`, findings: [] as Finding[],
        }));
        const notes = results.filter((r) => r.effective_enforcement === "warn").length;
        output = {
          results, verdict: "could_not_verify", sources: [], coverage_gaps: [{ component: "file", state: "unsupported", detail: version.parse_error ?? "unreadable" }], ruleset_digest: selection.ruleset_digest,
          counts: { in_scope: results.length, pass: 0, fail: 0, unknown: results.length - notes, not_applicable: 0, error: 0, conflict: 0, waived: 0, skipped: 0, notes, blocking_findings: 0 },
          inputs_digest: digestOf({ content_hash: version.content_hash, unreadable: true, rules: selection.rules.map((r) => [r.content.rule_id, r.content.revision]), as_of: now }),
        };
      }
      const record: RunRecord = {
        schema_version: "cl.run/1", run_id: runId, trace_id: `trc_${version.artifact_id.slice(4)}`,
        trigger: req.trigger ?? { kind: req.action.type !== "check_only" ? "pre_action" : req.actor.kind === "agent" ? "agent_call" : "user_request", reason: `Check requested by ${req.actor.display_name ?? req.actor.id} for ${req.action.type}` },
        started_at: now, completed_at: now, as_of: now, display_tz: this.displayTz,
        actor: { kind: "system", id: SYS.engine, display_name: "Check engine", on_behalf_of: req.actor.on_behalf_of ?? req.actor.id },
        context: { workspace_id: context.workspace_id, project_id: projectId, area_ids: context.area_ids, work_type: context.work_type, status: context.status, basis: context.basis },
        artifact: { artifact_id: version.artifact_id, name: version.name, version_seq: version.version_seq, content_hash: version.content_hash, artifact_type: artifactType, parser: version.normalized?.parser ?? { id: "none", version: "0" } },
        action: { type: req.action.type, params_digest: req.action.params && Object.keys(req.action.params).length ? digestOf(req.action.params) : null },
        policy: { policy_rev: policyRev, ruleset_digest: output.ruleset_digest, engine_version: ENGINE_VERSION },
        sources: output.sources,
        inventory: { workspace_active_rules: selection.workspace_active_rules, in_scope: selection.in_scope, out_of_scope: selection.out_of_scope, out_of_scope_recomputable: true },
        coverage_gaps: output.coverage_gaps, results: output.results, verdict: output.verdict, counts: output.counts, fix_proposal_ids: [], receipt_id: null,
        reproducibility: { deterministic: true, inputs_digest: output.inputs_digest, non_reproducible_rules: [] },
      };
      const failed = output.results.filter((r) => r.outcome === "fail");
      const previousRun = get<{ run_id: string; record_json: string }>(this.db, "SELECT run_id, record_json FROM runs WHERE artifact_id = ? ORDER BY completed_at DESC, rowid DESC LIMIT 1", version.artifact_id);
      const resolved = previousRun ? this.diffFindings(parse<RunRecord>(previousRun.record_json), record).resolved.map((f) => f.finding_id) : [];
      const completed = this.ledger.append({
        type: "run.completed", project_id: projectId, actor: record.actor, subject: { kind: "run", id: runId },
        refs: { run_id: runId, trace_id: record.trace_id, artifact_id: version.artifact_id, content_hash: version.content_hash },
        caused_by: [version.event_id ?? this.ledger.byRef("artifact_id", version.artifact_id).find((e) => e.type === "artifact.observed" && e.refs.content_hash === version.content_hash)?.event_id],
        summary: `Checked version ${version.version_seq} of ${version.name} for ${req.action.type}: ${VERDICT_WORDS[output.verdict]}.`,
        payload: {
          verdict: output.verdict, counts: output.counts, failed_rules: failed.map((r) => r.rule_id), findings: failed.flatMap((r) => r.findings.map((f) => f.finding_id)),
          resolved_findings: resolved, previous_run_id: previousRun?.run_id ?? null, ruleset_digest: output.ruleset_digest,
        },
      });
      // A receipt only for Ready, and only where a gateway actually handles the action.
      let receiptReason: string | null = null;
      if (output.verdict !== "ready") receiptReason = "verdict_not_ready";
      else if (!this.gateway.gateable(req.action.type)) receiptReason = req.action.type === "check_only" ? "check_only" : "no_gated_route_for_action";
      else {
        try {
          record.receipt_id = tx(this.db, () => this.gateway.issueReceipt(record, completed.event_id, exceptions.map((e) => e.exception_id)).receipt_id);
        } catch (error) {
          // Fail closed: the check stands, but nothing that looks like permission exists.
          receiptReason = `receipt_could_not_be_issued: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
      assertValid("run", record, "run record");
      run(this.db, "INSERT INTO runs (run_id, trace_id, workspace_id, project_id, artifact_id, version_seq, content_hash, action_type, verdict, policy_rev, ruleset_digest, record_json, completed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        runId, record.trace_id, context.workspace_id, projectId, version.artifact_id, version.version_seq, version.content_hash, req.action.type, output.verdict, policyRev, output.ruleset_digest, json(record), now);
      // The exact inputs, so the run can be re-run as recorded (AT-O7).
      run(this.db, "INSERT INTO run_inputs (run_id, facts_json, snapshot_ids_json, exceptions_json, rules_json, inputs_digest, recorded_at) VALUES (?,?,?,?,?,?,?)",
        runId, json(context.facts), json(version.normalized ? sources.map((x) => x.snapshot_id) : []), json(exceptions), json(selection.rules.map((r) => [r.content.rule_id, r.content.revision, r.content_digest, r.status])), output.inputs_digest, now);
      for (const r of output.results) run(this.db, "INSERT INTO check_results (run_id, rule_id, revision, outcome, effective_enforcement) VALUES (?,?,?,?,?)", runId, r.rule_id, r.revision, r.outcome, r.effective_enforcement);
      if (output.verdict !== "ready" && req.action.type !== "check_only") {
        this.ledger.append({
          type: "action.blocked", project_id: projectId, actor: { kind: "system", id: SYS.service }, subject: { kind: "run", id: runId }, refs: { run_id: runId, artifact_id: version.artifact_id }, caused_by: [completed.event_id],
          summary: `${req.action.type} cannot go ahead through Correction Layer: the check is ${VERDICT_WORDS[output.verdict]}.`, payload: { verdict: output.verdict, blocking_findings: output.counts.blocking_findings },
        });
      }
      return {
        enforcement_tier: "advisory" as const, run_id: runId, context: { status: context.status, project_id: projectId, work_type: context.work_type, context_changed: contextChanged }, policy_rev: policyRev,
        verdict: output.verdict, human_summary: this.summary(output, req.action.type), counts: output.counts, review_url: `/runs/${runId}`, receipt_id: record.receipt_id, receipt_unavailable_reason: record.receipt_id ? null : receiptReason,
      };
    });
  }

  private summary(output: EngineOutput, action: string): string {
    const c = output.counts;
    const notes = c.notes ? ` ${c.notes} note${c.notes === 1 ? "" : "s"}.` : "";
    const forAction = action === "check_only" ? "" : ` for ${action.replace(/_/g, " ")}`;
    if (output.verdict === "ready") return `Advisory check: Ready${forAction}. ${c.in_scope} rule${c.in_scope === 1 ? "" : "s"} applied.${notes} A pass is not permission.`;
    if (output.verdict === "needs_changes") return `Advisory check: Needs changes. ${c.blocking_findings} thing${c.blocking_findings === 1 ? "" : "s"} to fix${forAction ? ` before this can go ahead${forAction}` : ""}.${notes}`;
    const unverified = c.unknown + c.error + c.conflict;
    return `Advisory check: Couldn't verify. ${unverified || output.coverage_gaps.length} item${(unverified || output.coverage_gaps.length) === 1 ? "" : "s"} could not be verified.${notes}`;
  }

  // ------------------------------------------------------------ one rule on stored work (examples, dry runs)
  /** Evaluate one rule revision on one stored version, as of now, in that version's project. Unreadable work decides nothing: `unknown`. */
  evaluateRuleOn(rule: RuleRevisionContent, artifactId: string, contentHash: string): { outcome: Outcome; reason: string; findings: Finding[]; version_seq: number | null } {
    const a = this.artifact(artifactId);
    const v = this.versions(artifactId).find((x) => x.content_hash === contentHash);
    if (!v) return { outcome: "unknown", reason: "that version is not stored", findings: [], version_seq: null };
    if (!v.normalized) return { outcome: "unknown", reason: "that version could not be read", findings: [], version_seq: v.version_seq };
    const now = ts(this.clock.now());
    const out = evaluate({
      run_id: `run_DRY${digestOf([rule.rule_id, rule.revision, contentHash]).slice(7, 20).toUpperCase()}`, artifact: v.normalized, action: { type: rule.scope.actions[0] ?? "release" },
      context: this.projects.resolve({ project_id: a.project_id }), rules: [{ content: rule, status: "active", content_digest: digestOf(rule) }],
      sources: rule.source ? [this.projects.latestSnapshot(rule.source.source_id)].filter((x): x is SourceSnapshot => x !== null) : [], exceptions: [], as_of: now,
    });
    const r = out.results[0]!;
    return { outcome: r.outcome, reason: r.reason, findings: r.findings, version_seq: v.version_seq };
  }

  /** Dry run (UX-7c): the rule against the latest version of every document in the project. Changes nothing. */
  dryRun(rule: RuleRevisionContent, projectId: string): Array<{ artifact_id: string; name: string; version_seq: number; content_hash: string; outcome: Outcome; reason: string; findings: number }> {
    return this.latestVersions(projectId).map((v) => {
      const r = this.evaluateRuleOn(rule, v.artifact_id, v.content_hash);
      return { artifact_id: v.artifact_id, name: v.name, version_seq: v.version_seq, content_hash: v.content_hash, outcome: r.outcome, reason: r.reason, findings: r.findings.length };
    });
  }

  getRun(runId: string): RunRecord {
    const row = get<{ record_json: string }>(this.db, "SELECT record_json FROM runs WHERE run_id = ?", runId);
    if (!row) throw new NotFound("run", runId);
    return parse<RunRecord>(row.record_json);
  }

  listRuns(filter: { project_id?: string; artifact_id?: string; trace_id?: string; limit?: number }): RunRecord[] {
    const where: string[] = [];
    const params: unknown[] = [];
    for (const [column, value] of [["project_id", filter.project_id], ["artifact_id", filter.artifact_id], ["trace_id", filter.trace_id]] as const) {
      if (value) {
        where.push(`${column} = ?`);
        params.push(value);
      }
    }
    return all<{ record_json: string }>(this.db, `SELECT record_json FROM runs ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY completed_at DESC, rowid DESC LIMIT ?`, ...params, filter.limit ?? 50).map((r) => parse<RunRecord>(r.record_json));
  }

  /** How often a rule was evaluated, by outcome: plain counts, no causal claims (docs/02 §8). */
  ruleOutcomeCounts(ruleId: string): Record<string, number> {
    return Object.fromEntries(all<any>(this.db, "SELECT outcome, COUNT(*) AS n FROM check_results WHERE rule_id = ? GROUP BY outcome", ruleId).map((r) => [r.outcome, r.n]));
  }

  /**
   * Findings resolved, introduced and remaining between two runs. This is the only
   * sense in which the product says something "improved": someone changed the work,
   * and a recheck no longer reports the finding.
   */
  diffFindings(before: RunRecord, after: RunRecord): { resolved: Finding[]; introduced: Finding[]; remaining: Finding[] } {
    const key = (ruleId: string, f: Finding): string => `${ruleId}|${f.field_path ?? f.location.locator}`;
    const index = (r: RunRecord): Map<string, Finding> => new Map(r.results.filter((x) => x.outcome === "fail").flatMap((x) => x.findings.map((f) => [key(x.rule_id, f), f] as const)));
    const [a, b] = [index(before), index(after)];
    return {
      resolved: [...a].filter(([k]) => !b.has(k)).map(([, f]) => f),
      introduced: [...b].filter(([k]) => !a.has(k)).map(([, f]) => f),
      remaining: [...b].filter(([k]) => a.has(k)).map(([, f]) => f),
    };
  }

  /** The normalized form of one stored version (null if unreadable or unknown). */
  normalizedOf(artifactId: string, contentHash: string): NormalizedArtifact | null {
    return parse<NormalizedArtifact | null>(get<{ normalized_json: string | null }>(this.db, "SELECT normalized_json FROM artifact_versions WHERE artifact_id = ? AND content_hash = ?", artifactId, contentHash)?.normalized_json ?? null);
  }

  compare(beforeRunId: string, afterRunId: string): { before: RunRecord; after: RunRecord; same_artifact: boolean; resolved: Finding[]; introduced: Finding[]; remaining: Finding[]; content_diff: ContentDiffResult } {
    const [before, after] = [this.getRun(beforeRunId), this.getRun(afterRunId)];
    if (before.context.project_id !== after.context.project_id) throw new ClError("cross_project_compare", "runs of different projects cannot be compared", 409);
    const findings = this.diffFindings(before, after);
    const content_diff: ContentDiffResult = before.artifact.content_hash === after.artifact.content_hash
      ? { available: true, passages: [], fields: [], unchanged_passages: this.normalizedOf(after.artifact.artifact_id, after.artifact.content_hash)?.content.blocks.length ?? 0, unread: [] }
      : diffArtifacts(this.normalizedOf(before.artifact.artifact_id, before.artifact.content_hash), this.normalizedOf(after.artifact.artifact_id, after.artifact.content_hash), findings);
    return { before, after, same_artifact: before.artifact.artifact_id === after.artifact.artifact_id, ...findings, content_diff };
  }

  /** Check the newest stored version of a document again (after a fix was applied, or when a person chose the newer version). */
  recheckLatest(artifactId: string, action: ActionEnvelope, actor: Actor, reason: string): CheckResponse {
    const a = this.artifact(artifactId);
    const latest = this.versions(artifactId).at(-1);
    if (!latest) throw new NotFound("artifact version", artifactId);
    const bytes = get<{ bytes: Uint8Array }>(this.db, "SELECT bytes FROM blobs WHERE content_hash = ?", latest.content_hash)?.bytes;
    if (!bytes) throw new ClError("bytes_not_stored", "the bytes of the newest version are no longer stored; check the file again", 409);
    return this.check({ project_id: a.project_id, name: a.name, bytes: new Uint8Array(bytes), action, actor, trigger: { kind: "auto_recheck", reason } });
  }

  /**
   * Re-run as recorded (AT-O7): rebuild the engine input from what was stored for
   * the run - the checked bytes (by hash), the rule revisions (by id, revision and
   * digest), the source snapshots, the exceptions and the project facts - and
   * evaluate again at the recorded time. Read-only. Anything altered is a mismatch;
   * anything no longer stored is reported as purged; nothing is guessed.
   */
  rerun(runId: string): RerunReport {
    const original = this.getRun(runId);
    const problems: RerunReport["problems"] = [];
    const inputs = get<any>(this.db, "SELECT * FROM run_inputs WHERE run_id = ?", runId);
    if (!inputs) return { run_id: runId, status: "inputs_missing", problems: [{ kind: "not_recorded", detail: "This check was made before re-run support; its inputs were not recorded." }], results: [], verdict: null, inputs_digest_matches: false };
    const blob = get<{ bytes: Uint8Array }>(this.db, "SELECT bytes FROM blobs WHERE content_hash = ?", original.artifact.content_hash);
    if (!blob) problems.push({ kind: "purged", detail: "The checked bytes are no longer stored." });
    else if (sha256(blob.bytes) !== original.artifact.content_hash) problems.push({ kind: "mismatch", detail: "The stored bytes no longer hash to the recorded content hash." });
    if (original.action.params_digest) problems.push({ kind: "not_reproducible", detail: "The action parameters were kept only as a digest." });
    const rules: Array<{ content: RuleRevisionContent; status: RunRecord["results"][number]["rule_status"]; content_digest: string }> = [];
    for (const [ruleId, revision, digest, status] of parse<Array<[string, number, string, string]>>(inputs.rules_json)) {
      const row = get<{ content_json: string; content_digest: string }>(this.db, "SELECT content_json, content_digest FROM rule_revisions WHERE rule_id = ? AND revision = ?", ruleId, revision);
      if (!row) { problems.push({ kind: "purged", detail: `Rule ${ruleId} revision ${revision} is no longer stored.` }); continue; }
      const content = parse<RuleRevisionContent>(row.content_json);
      if (row.content_digest !== digest || digestOf({ ...content, cases: [] }) !== digest) problems.push({ kind: "mismatch", detail: `Rule ${ruleId} revision ${revision} no longer matches its recorded digest.` });
      rules.push({ content, status: status as never, content_digest: digest });
    }
    const sources: SourceSnapshot[] = [];
    for (const snapshotId of parse<string[]>(inputs.snapshot_ids_json)) {
      const row = get<any>(this.db, "SELECT * FROM source_snapshots WHERE snapshot_id = ?", snapshotId);
      if (!row) { problems.push({ kind: "purged", detail: `Trusted-source snapshot ${snapshotId} is no longer stored.` }); continue; }
      const rows = parse<SourceSnapshot["rows"]>(row.rows_json);
      if (digestOf(rows) !== row.content_hash) problems.push({ kind: "mismatch", detail: `Trusted-source snapshot ${snapshotId} no longer matches its recorded hash.` });
      sources.push({ source_id: row.source_id, snapshot_id: row.snapshot_id, imported_at: row.imported_at, confirmed_at: row.confirmed_at, superseded: false, rows });
    }
    const exceptions = parse<AppliedException[]>(inputs.exceptions_json);
    const facts = parse<Record<string, string>>(inputs.facts_json);
    if (!blob || problems.some((p) => p.kind === "purged" && /bytes/.test(p.detail))) return { run_id: runId, status: "purged", problems, results: [], verdict: null, inputs_digest_matches: false };
    const versionRow = get<any>(this.db, "SELECT version_seq, size_bytes, observed_at FROM artifact_versions WHERE artifact_id = ? AND content_hash = ?", original.artifact.artifact_id, original.artifact.content_hash);
    const read = readArtifact(new Uint8Array(blob.bytes), original.artifact.name, original.context.work_type);
    if (!read.parsed) {
      return { run_id: runId, status: problems.length ? "mismatch" : "identical", problems: [...problems, { kind: "unreadable", detail: `The file could not be read, then or now: ${read.error?.message}` }], results: [], verdict: original.verdict === "could_not_verify" ? "could_not_verify" : null, inputs_digest_matches: false };
    }
    if (read.parsed.parser.id !== original.artifact.parser.id || read.parsed.parser.version !== original.artifact.parser.version) problems.push({ kind: "mismatch", detail: `The reader changed since the check (${original.artifact.parser.id} ${original.artifact.parser.version} -> ${read.parsed.parser.id} ${read.parsed.parser.version}).` });
    const artifact: NormalizedArtifact = { schema_version: "cl.artifact/1", artifact_id: original.artifact.artifact_id, name: original.artifact.name, version: { seq: original.artifact.version_seq, content_hash: original.artifact.content_hash, size_bytes: versionRow?.size_bytes ?? blob.bytes.length, observed_at: versionRow?.observed_at ?? original.as_of }, identity: read.identity, ...read.parsed };
    const context: ResolvedContext = { workspace_id: original.context.workspace_id, project_id: original.context.project_id, area_ids: original.context.area_ids, work_type: original.context.work_type, status: "resolved", basis: original.context.basis, facts };
    const out = evaluate({ run_id: runId, artifact, action: { type: original.action.type }, context, rules, sources, exceptions, as_of: original.as_of });
    const digestMatches = out.inputs_digest === original.reproducibility.inputs_digest;
    if (!digestMatches && !problems.length) problems.push({ kind: "mismatch", detail: "The rebuilt inputs do not match the recorded inputs digest." });
    const results = original.results.map((r) => {
      const again = out.results.find((x) => x.rule_id === r.rule_id);
      return { rule_id: r.rule_id, title: r.title, recorded: r.outcome, now: again?.outcome ?? null, same: !!again && again.outcome === r.outcome && again.findings.length === r.findings.length };
    });
    for (const r of results.filter((x) => !x.same)) problems.push({ kind: "mismatch", detail: `${r.title}: recorded ${r.recorded}, re-run ${r.now ?? "missing"}.` });
    if (out.verdict !== original.verdict) problems.push({ kind: "mismatch", detail: `Verdict: recorded ${original.verdict}, re-run ${out.verdict}.` });
    return { run_id: runId, status: problems.length ? (problems.some((p) => p.kind === "purged") ? "purged" : "mismatch") : "identical", problems, results, verdict: out.verdict, inputs_digest_matches: digestMatches };
  }
}
