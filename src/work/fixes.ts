/**
 * Proposed changes, kept apart from applied changes (docs/01 §6, AT-R1).
 *
 *   proposed  - bytes someone suggests for the next version of a document: an
 *               assistant (over the API), or the engine where a rule fully
 *               determines the text (a required phrase or section is missing).
 *               A proposal is NOT a version: checks, receipts and rules never see it.
 *   applied   - a person applies it in the app. Only then does a new version exist,
 *               recorded as a change declared by that person and linked to the
 *               proposal. The product never applies anything by itself.
 *
 * The engine proposes only additive text it can state exactly; it never re-prices,
 * converts currencies, deletes passages or rewrites a sentence. Those are proposed
 * by people or their assistants.
 */
import { sha256 } from "../domain/canonical.ts";
import { Conflict, NotFound, ValidationError } from "../domain/errors.ts";
import type { IdGen } from "../domain/ids.ts";
import { SYS } from "../domain/ids.ts";
import type { Clock } from "../domain/time.ts";
import { ts } from "../domain/time.ts";
import type { Actor, NormalizedArtifact } from "../domain/types.ts";
import { readArtifact } from "../formats/adapters.ts";
import type { Ledger } from "../ledger/ledger.ts";
import { requireHuman } from "../policy/rules.ts";
import type { Db } from "../store/db.ts";
import { all, get, json, parse, run, tx } from "../store/db.ts";
import type { CheckService, ObservedVersion } from "./check.ts";
import type { ContentDiffResult } from "./diff.ts";
import { diffArtifacts } from "./diff.ts";

const MAX_BYTES = 5 * 1024 * 1024;

export interface FixProposal {
  fix_id: string;
  project_id: string;
  artifact_id: string;
  base_version_seq: number;
  base_hash: string;
  run_id: string | null;
  rule_id: string | null;
  finding_id: string | null;
  source: "engine" | "client";
  proposed_by: Actor;
  proposed_at: string;
  summary: string;
  proposed_hash: string;
  status: "open" | "applied" | "dismissed" | "superseded";
  decided_by: string | null;
  decided_at: string | null;
  applied_version_seq: number | null;
}

export class FixService {
  private db: Db;
  private ledger: Ledger;
  private clock: Clock;
  private ids: IdGen;
  private checks: CheckService;
  private workspaceId: string;

  constructor(deps: { db: Db; ledger: Ledger; clock: Clock; ids: IdGen; checks: CheckService; workspaceId: string }) {
    this.db = deps.db;
    this.ledger = deps.ledger;
    this.clock = deps.clock;
    this.ids = deps.ids;
    this.checks = deps.checks;
    this.workspaceId = deps.workspaceId;
  }

  private hydrate(row: any): FixProposal {
    const { proposed_by_json, workspace_id: _w, ...rest } = row;
    return { ...rest, proposed_by: parse<Actor>(proposed_by_json) };
  }

  get(fixId: string): FixProposal {
    const row = get<any>(this.db, "SELECT * FROM fix_proposals WHERE fix_id = ? AND workspace_id = ?", fixId, this.workspaceId);
    if (!row) throw new NotFound("proposed change", fixId);
    return this.hydrate(row);
  }

  list(filter: { artifact_id?: string; project_id?: string; status?: FixProposal["status"] }): FixProposal[] {
    const where = ["workspace_id = ?"];
    const params: unknown[] = [this.workspaceId];
    for (const [k, v] of Object.entries(filter)) if (v) {
      where.push(`${k} = ?`);
      params.push(v);
    }
    return all<any>(this.db, `SELECT * FROM fix_proposals WHERE ${where.join(" AND ")} ORDER BY proposed_at DESC, rowid DESC`, ...params).map((r) => this.hydrate(r));
  }

  private latest(artifactId: string): { version_seq: number; content_hash: string; normalized: NormalizedArtifact | null } {
    const v = this.checks.versions(artifactId).at(-1);
    if (!v) throw new NotFound("artifact version", artifactId);
    return v;
  }

  private store(p: { project_id: string; artifact_id: string; base: { version_seq: number; content_hash: string }; bytes: Uint8Array; summary: string; actor: Actor; source: "engine" | "client"; run_id?: string | null; rule_id?: string | null; finding_id?: string | null }): FixProposal {
    const fixId = this.ids("fix");
    const now = ts(this.clock.now());
    const hash = sha256(p.bytes);
    run(this.db, "INSERT INTO blobs (content_hash, bytes, size_bytes) VALUES (?,?,?) ON CONFLICT (content_hash) DO NOTHING", hash, p.bytes, p.bytes.length);
    run(this.db, "INSERT INTO fix_proposals (fix_id, workspace_id, project_id, artifact_id, base_version_seq, base_hash, run_id, rule_id, finding_id, source, proposed_by_json, proposed_at, summary, proposed_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      fixId, this.workspaceId, p.project_id, p.artifact_id, p.base.version_seq, p.base.content_hash, p.run_id ?? null, p.rule_id ?? null, p.finding_id ?? null, p.source, json(p.actor), now, p.summary, hash);
    this.ledger.append({
      type: "fix.proposed", project_id: p.project_id, actor: p.actor, subject: { kind: "fix", id: fixId },
      refs: { fix_id: fixId, artifact_id: p.artifact_id, content_hash: p.base.content_hash, ...(p.run_id ? { run_id: p.run_id } : {}), ...(p.rule_id ? { rule_id: p.rule_id } : {}) },
      caused_by: p.run_id ? this.ledger.byRef("run_id", p.run_id).filter((e) => e.type === "run.completed").map((e) => e.event_id) : [],
      summary: `A change to version ${p.base.version_seq} was proposed by ${p.actor.display_name ?? p.actor.id}: ${p.summary}. It is a proposal only; nothing changed.`,
      payload: { source: p.source, proposed_hash: hash, base_hash: p.base.content_hash },
    });
    return this.get(fixId);
  }

  /** Anyone - typically an assistant - proposes the full content of the next version of an existing document. */
  proposeContent(input: { project_id: string; name: string; bytes: Uint8Array; summary: string; base_hash?: string | null }, actor: Actor): FixProposal {
    const summary = (input.summary ?? "").trim().slice(0, 300) || "new content";
    if (input.bytes.length === 0 || input.bytes.length > MAX_BYTES) throw new ValidationError("proposed change", ["content: between 1 byte and 5 MB"]);
    const art = get<{ artifact_id: string }>(this.db, "SELECT artifact_id FROM artifacts WHERE project_id = ? AND name = ? AND workspace_id = ?", input.project_id, input.name, this.workspaceId);
    if (!art) throw new NotFound("document in this project", input.name);
    return tx(this.db, () => {
      const base = this.latest(art.artifact_id);
      if (input.base_hash && input.base_hash !== base.content_hash) throw new Conflict("stale_proposal", `the proposal was made for another version; the newest is version ${base.version_seq}`);
      if (sha256(input.bytes) === base.content_hash) throw new ValidationError("proposed change", ["the content is identical to the newest version"]);
      return this.store({ project_id: input.project_id, artifact_id: art.artifact_id, base, bytes: input.bytes, summary, actor, source: "client" });
    });
  }

  /** Engine proposals for one check, where a rule fully determines additive text. Idempotent per run and rule. */
  proposeFromRun(runId: string): FixProposal[] {
    const r = this.checks.getRun(runId);
    const base = this.latest(r.artifact.artifact_id);
    if (base.content_hash !== r.artifact.content_hash || r.artifact.parser.id !== "text-labelled") return [];
    const bytes = get<{ bytes: Uint8Array }>(this.db, "SELECT bytes FROM blobs WHERE content_hash = ?", base.content_hash)?.bytes;
    if (!bytes) return [];
    const text = new TextDecoder().decode(bytes);
    const out: FixProposal[] = [];
    return tx(this.db, () => {
      for (const res of r.results.filter((x) => x.outcome === "fail")) {
        if (get(this.db, "SELECT 1 FROM fix_proposals WHERE run_id = ? AND rule_id = ?", runId, res.rule_id)) continue;
        const rule = get<{ content_json: string }>(this.db, "SELECT content_json FROM rule_revisions WHERE rule_id = ? AND revision = ?", res.rule_id, res.revision);
        if (!rule) continue;
        const check = parse<any>(rule.content_json).check;
        let addition: string | null = null;
        let summary = "";
        if (check.kind === "text_contains" && check.params.mode === "must") [addition, summary] = [String(check.params.phrase), `add the line "${check.params.phrase}" at the end (required by "${res.title}")`];
        if (check.kind === "section_present") [addition, summary] = [`## ${check.params.heading}`, `add a section heading "${check.params.heading}" at the end (required by "${res.title}"); its content is for a person to write`];
        if (addition === null) continue;
        const next = new TextEncoder().encode(`${text.replace(/\s*$/, "")}\n\n${addition}\n`);
        out.push(this.store({ project_id: r.context.project_id!, artifact_id: r.artifact.artifact_id, base, bytes: next, summary, actor: { kind: "system", id: SYS.engine, display_name: "Check engine" }, source: "engine", run_id: runId, rule_id: res.rule_id, finding_id: res.findings[0]?.finding_id ?? null }));
      }
      return out;
    });
  }

  /** What the proposal would change, compared with the newest version. */
  preview(fixId: string): { proposal: FixProposal; diff: ContentDiffResult; stale: boolean } {
    const p = this.get(fixId);
    const base = this.latest(p.artifact_id);
    const name = get<{ name: string }>(this.db, "SELECT name FROM artifacts WHERE artifact_id = ?", p.artifact_id)!.name;
    const bytes = get<{ bytes: Uint8Array }>(this.db, "SELECT bytes FROM blobs WHERE content_hash = ?", p.proposed_hash)?.bytes;
    const read = bytes ? readArtifact(new Uint8Array(bytes), name, "sales_proposal") : null;
    const proposed: NormalizedArtifact | null = read?.parsed ? { schema_version: "cl.artifact/1", artifact_id: p.artifact_id, name, version: { seq: base.version_seq + 1, content_hash: p.proposed_hash, observed_at: p.proposed_at }, identity: read.identity, ...read.parsed } : null;
    const before = this.checks.normalizedOf(p.artifact_id, p.base_hash);
    return { proposal: p, diff: diffArtifacts(before, proposed), stale: base.content_hash !== p.base_hash };
  }

  /** A person applies a proposal: a new version, declared by that person and linked to the proposal. */
  apply(fixId: string, actor: Actor): { proposal: FixProposal; version: ObservedVersion } {
    requireHuman(actor, "Applying a proposed change");
    const p = this.get(fixId);
    if (p.status !== "open") throw new Conflict("proposal_closed", `this proposal is ${p.status}`);
    const base = this.latest(p.artifact_id);
    if (base.content_hash !== p.base_hash) {
      run(this.db, "UPDATE fix_proposals SET status = 'superseded' WHERE fix_id = ?", fixId);
      throw new Conflict("stale_proposal", `the document changed since this was proposed (newest is version ${base.version_seq}); nothing was applied`);
    }
    const bytes = get<{ bytes: Uint8Array }>(this.db, "SELECT bytes FROM blobs WHERE content_hash = ?", p.proposed_hash)?.bytes;
    if (!bytes) throw new Conflict("proposal_bytes_missing", "the proposed content is no longer stored");
    if (get(this.db, "SELECT 1 FROM artifact_versions WHERE artifact_id = ? AND content_hash = ?", p.artifact_id, p.proposed_hash)) throw new Conflict("proposal_is_old_version", "the proposed content is identical to an earlier version of this document");
    const name = get<{ name: string }>(this.db, "SELECT name FROM artifacts WHERE artifact_id = ?", p.artifact_id)!.name;
    const version = this.checks.observe({ project_id: p.project_id, name, bytes: new Uint8Array(bytes), declared_by: actor, fix_id: fixId });
    run(this.db, "UPDATE fix_proposals SET status = 'applied', decided_by = ?, decided_at = ?, applied_version_seq = ? WHERE fix_id = ?", actor.id, ts(this.clock.now()), version.version_seq, fixId);
    return { proposal: this.get(fixId), version };
  }

  dismiss(fixId: string, actor: Actor): FixProposal {
    requireHuman(actor, "Dismissing a proposed change");
    return tx(this.db, () => {
      const p = this.get(fixId);
      if (p.status !== "open") throw new Conflict("proposal_closed", `this proposal is ${p.status}`);
      run(this.db, "UPDATE fix_proposals SET status = 'dismissed', decided_by = ?, decided_at = ? WHERE fix_id = ?", actor.id, ts(this.clock.now()), fixId);
      this.ledger.append({
        type: "fix.dismissed", project_id: p.project_id, actor, subject: { kind: "fix", id: fixId }, refs: { fix_id: fixId, artifact_id: p.artifact_id },
        caused_by: this.ledger.byRef("fix_id", fixId).slice(0, 1).map((e) => e.event_id), summary: `${actor.display_name ?? actor.id} dismissed a proposed change. Nothing was applied.`,
      });
      return this.get(fixId);
    });
  }
}
