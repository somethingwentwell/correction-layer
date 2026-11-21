/**
 * The check engine: a pure function (docs/03 §7).
 *
 *   run = evaluate(artifact, action, context, rule_revisions, source_snapshots,
 *                  exceptions, as_of)
 *
 * No I/O, no wall clock, no model. Every in-scope rule gets a result; nothing is
 * trimmed, ranked or skipped silently. "Unknown never silently passes": on a
 * must-pass rule it stops the action, on a note rule it is displayed.
 */
import { digestOf } from "../domain/canonical.ts";
import { addDays, daysBetween } from "../domain/time.ts";
import type {
  ActionEnvelope, Enforcement, Finding, NormalizedArtifact, Outcome, ResolvedContext, RuleResult, RuleRevisionContent,
  RuleStatus, RunCounts, SourceSnapshot, SourceUse, Verdict,
} from "../domain/types.ts";
import type { CheckKindSpec, KindResult } from "../policy/catalogue.ts";
import { CATALOGUE, relate } from "../policy/catalogue.ts";
import { evaluatePredicate } from "../policy/predicate.ts";
import type { EvalEnv } from "./fields.ts";
import { resolveTarget } from "./fields.ts";

export const ENGINE_VERSION = "0.1.0";

export interface EngineRule {
  content: RuleRevisionContent;
  status: RuleStatus;
  content_digest: string;
}

export interface AppliedException {
  exception_id: string;
  rule_id: string;
}

export interface EngineInput {
  run_id: string;
  artifact: NormalizedArtifact;
  action: ActionEnvelope;
  context: ResolvedContext;
  /** The complete in-scope set, selected deterministically by the scope index. */
  rules: EngineRule[];
  /** Latest snapshot per source the rules name. Lookups never read live files. */
  sources: SourceSnapshot[];
  exceptions: AppliedException[];
  as_of: string;
  /** Injectable for tests (e.g. a kind that throws); defaults to the frozen catalogue. */
  catalogue?: Readonly<Record<string, CheckKindSpec>>;
}

export interface EngineOutput {
  results: RuleResult[];
  verdict: Verdict;
  counts: RunCounts;
  sources: SourceUse[];
  coverage_gaps: Array<{ component: string; state: string; detail?: string }>;
  ruleset_digest: string;
  inputs_digest: string;
}

/** Digest over the in-scope rule ids, revisions and applied exceptions (docs/06 §3). */
export function rulesetDigest(rules: Array<{ rule_id: string; revision: number }>, exceptions: string[] = []): string {
  return digestOf({
    rules: rules.map((r) => [r.rule_id, r.revision] as const).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1])),
    exceptions: [...exceptions].sort(),
  });
}

export function sourceUse(snapshot: SourceSnapshot, maxAgeDays: number, asOf: string): SourceUse {
  const freshUntil = addDays(snapshot.confirmed_at, maxAgeDays);
  return {
    source_id: snapshot.source_id, snapshot_id: snapshot.snapshot_id, imported_at: snapshot.imported_at, confirmed_at: snapshot.confirmed_at,
    age_days: Math.max(0, daysBetween(snapshot.confirmed_at, asOf)), fresh: asOf <= freshUntil, fresh_until: freshUntil,
  };
}

/** Effective enforcement: capped at `warn` for trial rules and AI opinions (docs/03 §4.2). */
export function effectiveEnforcement(rule: RuleRevisionContent, status: RuleStatus): Enforcement {
  return status === "trial" || rule.method === "model_review" ? "warn" : rule.enforcement;
}

const READABLE = new Set(["parsed", "absent"]);

function evaluateRule(input: EngineInput, rule: EngineRule, env: EvalEnv, uses: Map<string, SourceUse>): { outcome: Outcome; reason: string; compared?: number; kind?: KindResult; snapshotId?: string } {
  const r = rule.content;
  const spec = (input.catalogue ?? CATALOGUE)[r.check.kind];
  if (!spec) return { outcome: "error", reason: `check kind ${r.check.kind} is not in the catalogue` };
  if (spec.availability === "unavailable" || !spec.evaluate) {
    // An AI opinion is a note only and may be skipped; anything else is unknown, never a pass.
    if (r.method === "model_review") return { outcome: "skipped", reason: "AI opinion rules are not available in this build (note only)" };
    return { outcome: "unknown", reason: `the check kind "${r.check.kind}" is not available in this build, so this rule could not be verified` };
  }
  // 1. Needs.
  for (const component of r.requires.components) {
    const state = input.artifact.coverage.find((c) => c.component === component)?.state ?? "unsupported";
    if (!READABLE.has(state)) return { outcome: "unknown", reason: `a part of the file this rule needs (${component}) was not read: ${state}` };
  }
  for (const field of r.requires.fields) {
    const found = resolveTarget(env, field);
    if (!found.length) return { outcome: "unknown", reason: `a field this rule needs (${field}) was not found in the document` };
    const bad = found.find((f) => !f.usable);
    if (bad) return { outcome: "unknown", reason: `a field this rule needs (${bad.path}) could not be relied on: ${bad.why}` };
  }
  // Trusted source: stale or missing is unknown (docs/03 §8).
  let snapshot: SourceSnapshot | null = null;
  if (r.source) {
    snapshot = input.sources.find((s) => s.source_id === r.source!.source_id) ?? null;
    if (!snapshot) return { outcome: "unknown", reason: "the trusted source this rule reads has no imported version" };
    const use = sourceUse(snapshot, r.source.max_age_days, input.as_of);
    uses.set(snapshot.snapshot_id, use);
    if (!use.fresh) return { outcome: "unknown", reason: `the trusted source is out of date (last confirmed ${use.age_days} days ago; limit ${r.source.max_age_days})`, snapshotId: snapshot.snapshot_id };
    if (r.source.require_latest && snapshot.superseded) return { outcome: "unknown", reason: "a newer version of the trusted source exists", snapshotId: snapshot.snapshot_id };
  }
  // 2. Content condition.
  if (r.applies_when) {
    const p = evaluatePredicate(env, r.applies_when);
    if (p.result === "undecidable") return { outcome: "unknown", reason: `could not decide whether this rule applies: ${p.detail}` };
    if (p.result === "false") return { outcome: "not_applicable", reason: `the rule's condition is false: ${p.detail}` };
  }
  // 3. Requirement.
  const kind = spec.evaluate({ rule: r, env, snapshot, asOf: input.as_of });
  return { outcome: kind.outcome, reason: kind.reason, compared: kind.compared, kind, ...(snapshot ? { snapshotId: snapshot.snapshot_id } : {}) };
}

export function evaluate(input: EngineInput): EngineOutput {
  const env: EvalEnv = { artifact: input.artifact, action: input.action, context: input.context };
  const rules = [...input.rules].sort((a, b) => (a.content.rule_id < b.content.rule_id ? -1 : a.content.rule_id > b.content.rule_id ? 1 : 0));
  const uses = new Map<string, SourceUse>();

  // Statically unsatisfiable pairs of MUST-PASS rules are both `conflict`; neither wins (docs/04 §6). A note-only
  // rule (trial, shadow, warn) cannot make blocking unsatisfiable, so it yields: it is evaluated and shown as a note.
  const conflicted = new Set<string>();
  const blocks = (r: EngineRule): boolean => effectiveEnforcement(r.content, r.status) === "block";
  for (let i = 0; i < rules.length; i++) {
    for (let j = i + 1; j < rules.length; j++) {
      if (blocks(rules[i]!) && blocks(rules[j]!) && relate(rules[i]!.content, rules[j]!.content) === "conflict") {
        conflicted.add(rules[i]!.content.rule_id);
        conflicted.add(rules[j]!.content.rule_id);
      }
    }
  }

  let findingSeq = 0;
  const results: RuleResult[] = rules.map((rule) => {
    const r = rule.content;
    let evaluated: ReturnType<typeof evaluateRule>;
    try {
      evaluated = evaluateRule(input, rule, env, uses);
    } catch (error) {
      // A check never ends early: this rule is `error`, the others still run (docs/03 §7).
      evaluated = { outcome: "error", reason: `the rule could not be evaluated: ${error instanceof Error ? error.message : String(error)}` };
    }
    let { outcome, reason } = evaluated;
    let findings: Finding[] = (evaluated.kind?.findings ?? []).map((f) => ({ finding_id: `fnd_${digestOf([input.run_id, r.rule_id, findingSeq++]).slice(7, 23).toUpperCase()}`, ...f }));
    if (conflicted.has(r.rule_id) && outcome !== "not_applicable") {
      outcome = "conflict";
      reason = "this rule and another rule in scope cannot both be met; neither is treated as winning";
      findings = [];
    }
    const exception = input.exceptions.find((e) => e.rule_id === r.rule_id);
    if (exception && outcome !== "not_applicable") {
      reason = `skipped by exception ${exception.exception_id}; underlying result: ${outcome} (${reason})`;
      outcome = "waived";
    }
    const effective = effectiveEnforcement(r, rule.status);
    if (outcome === "skipped" && effective !== "warn") {
      outcome = "unknown"; // `skipped` is permitted only for note rules.
    }
    if (rule.status === "trial" && outcome === "fail") reason += ". This rule is on trial, so it is a note only";
    return {
      rule_id: r.rule_id, revision: r.revision, title: r.title, rule_status: rule.status, method: r.method, enforcement: r.enforcement,
      effective_enforcement: effective, outcome, reason,
      ...(evaluated.snapshotId ? { source_snapshot_id: evaluated.snapshotId } : {}),
      ...(evaluated.compared !== undefined ? { compared: evaluated.compared } : {}),
      findings,
    };
  });

  const coverage_gaps = input.artifact.coverage
    .filter((c) => c.content_bearing && ["partial", "detected_not_parsed", "unsupported"].includes(c.state))
    .map((c) => ({ component: c.component, state: c.state, ...(c.detail ? { detail: c.detail } : {}) }));

  const counts: RunCounts = { in_scope: results.length, pass: 0, fail: 0, unknown: 0, not_applicable: 0, error: 0, conflict: 0, waived: 0, skipped: 0, notes: 0, blocking_findings: 0 };
  let needsChanges = false;
  let cannotVerify = false;
  for (const res of results) {
    const troubled = res.outcome === "fail" || res.outcome === "unknown" || res.outcome === "error" || res.outcome === "conflict";
    if (troubled && res.effective_enforcement === "warn") {
      counts.notes++;
      continue;
    }
    counts[res.outcome]++;
    if (res.outcome === "fail") {
      needsChanges = true;
      counts.blocking_findings += res.findings.length;
    } else if (troubled) cannotVerify = true;
  }
  // An unread, content-bearing part of the file can never be Ready for a real action (docs/05 §8).
  if (coverage_gaps.length && input.action.type !== "check_only") cannotVerify = true;
  const verdict: Verdict = needsChanges ? "needs_changes" : cannotVerify ? "could_not_verify" : "ready";

  const ruleset_digest = rulesetDigest(rules.map((r) => r.content), input.exceptions.map((e) => e.exception_id));
  const inputs_digest = digestOf({
    engine_version: ENGINE_VERSION,
    artifact: { content_hash: input.artifact.version.content_hash, parser: input.artifact.parser },
    action: input.action,
    context: input.context,
    rules: rules.map((r) => [r.content.rule_id, r.content.revision, r.content_digest, r.status]),
    sources: input.sources.map((s) => s.snapshot_id).sort(),
    exceptions: input.exceptions,
    as_of: input.as_of,
  });
  return { results, verdict, counts, sources: [...uses.values()], coverage_gaps, ruleset_digest, inputs_digest };
}
