/**
 * The append-only, hash-chained event ledger (docs/02 §4, schemas/README.md).
 *
 * - `seq` is the authoritative order; there is exactly one writer.
 * - `caused_by` must name earlier events, so journeys are reconstructable from
 *   stored references alone.
 * - The chain covers `payload_digest`, not the payload, so evidence can be erased
 *   without breaking verification.
 */
import { canonical, sha256 } from "../domain/canonical.ts";
import { InvariantViolation, NotFound, ValidationError } from "../domain/errors.ts";
import type { Clock } from "../domain/time.ts";
import { ts } from "../domain/time.ts";
import type { Actor } from "../domain/types.ts";
import type { Db } from "../store/db.ts";
import { all, get, json, parse, run, tx } from "../store/db.ts";

export const EVENT_TYPES = [
  "workspace.created", "project.created", "project.facts_changed", "folder.registered", "folder.rebound", "area.created",
  "mapping.confirmed", "source.registered", "source.snapshot_imported", "source.snapshot_confirmed", "source.snapshot_superseded",
  "source.became_stale", "correction.recorded", "rule.candidate_created", "rule.cases_tested", "rule.backtested", "rule.approved",
  "rule.rejected", "rule.activated", "rule.revised", "rule.suspended", "rule.resumed", "rule.retired", "rule.owner_changed",
  "rule.conflict_detected", "rule.review_due", "exception.requested", "exception.granted", "exception.revoked", "exception.expired",
  "attestation.recorded", "session.opened", "context.resolved", "context.ambiguity_raised", "context.ambiguity_answered",
  "artifact.observed", "artifact.moved", "artifact.copied", "run.completed", "fix.proposed", "fix.dismissed", "change.recorded",
  "feedback.recorded", "receipt.issued", "receipt.invalidated", "receipt.expired", "receipt.consumed", "action.requested",
  "action.approved", "action.rejected", "action.revalidated", "action.paused", "action.blocked", "action.executed", "action.failed",
  "action.outcome_unknown", "ledger.anchored", "ledger.exported", "retention.purged", "redaction.applied", "policy.imported",
  "learning.policy_set", "learning.policy_revoked", "learning.signal_detected", "learning.signal_discarded",
  "learning.correction_extracted", "learning.candidate_evaluated", "learning.decision_made", "learning.inbox_item_opened",
  "learning.inbox_item_resolved", "learning.suppression_added", "rule.auto_paused", "rule.confirmed", "capture.stream_opened",
  "capture.stream_closed", "capture.gap_detected", "capture.gap_closed", "capture.dead_lettered", "capture.health_changed",
  "capture.consent_blocked",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** Acts that only a person may perform. Enforced here as well as in each service (defence in depth). */
export const HUMAN_ONLY_EVENTS: ReadonlySet<EventType> = new Set<EventType>([
  "rule.approved", "rule.rejected", "rule.retired", "rule.suspended", "rule.confirmed", "action.approved",
  "action.rejected", "exception.granted", "exception.revoked", "attestation.recorded", "learning.policy_set",
  "learning.policy_revoked", "learning.inbox_item_resolved", "learning.suppression_added", "project.facts_changed",
]);

export type RefKey =
  | "correction_id" | "rule_id" | "rule_revision" | "run_id" | "trace_id" | "artifact_id" | "content_hash" | "source_id"
  | "snapshot_id" | "receipt_id" | "action_id" | "approval_id" | "fix_id" | "change_id" | "session_id" | "adapter_id"
  | "signal_id" | "decision_id" | "evaluation_id" | "learning_policy_id" | "inbox_id" | "stream_id" | "capture_id";
export type Refs = Partial<Record<RefKey, string | number>>;

export interface LedgerEvent {
  event_id: string;
  seq: number;
  type: EventType;
  occurred_at: string;
  display_tz: string;
  workspace_id: string;
  project_id: string | null;
  actor: Actor;
  subject: { kind: string; id: string };
  refs: Refs;
  caused_by: string[];
  policy_rev: number;
  summary: string;
  payload: Record<string, unknown> | null;
  payload_state: "present" | "erased";
  payload_digest: string;
  classification: "meta" | "rule_text" | "evidence" | "content";
  prev_hash: string;
  hash: string;
  schema_version: "cl.event/1";
}

export interface AppendInput {
  type: EventType;
  project_id: string | null;
  actor: Actor;
  subject: { kind: string; id: string };
  refs?: Refs;
  caused_by?: Array<string | null | undefined>;
  summary: string;
  payload?: Record<string, unknown>;
  classification?: LedgerEvent["classification"];
}

export interface VerifyResult {
  ok: boolean;
  events: number;
  /** The first sequence number at which verification fails (AT-R4). */
  first_bad_seq?: number;
  problem?: string;
}

/**
 * Hash of one envelope, as tools/check_repo.py computes it for the example logs.
 *
 * One deliberate refinement: the envelope is hashed AS WRITTEN, i.e. with
 * `payload_state: "present"`. The proposed algorithm hashes `payload_state` itself,
 * which would make erasing a payload (present -> erased) break the chain - the
 * opposite of what docs/02 §4.1 promises. Hashing the as-written state keeps every
 * non-erased log bit-compatible with the design and lets erasure verify. Recorded
 * as a spec issue in HANDOFF.md.
 */
export function eventHash(event: Omit<LedgerEvent, "hash" | "payload"> | LedgerEvent, prevHash: string): string {
  const envelope: Record<string, unknown> = { ...event, prev_hash: prevHash, payload_state: "present" };
  delete envelope.hash;
  delete envelope.payload;
  return sha256(prevHash + "\n" + canonical(envelope));
}

/**
 * Verify a contiguous segment of a ledger. Pure: used for the live store, for
 * exports, and for the design's example logs.
 */
export function verifyEvents(events: LedgerEvent[], firstPrevHash: string, firstSeq: number, workspaceId: string): VerifyResult {
  let prev = firstPrevHash;
  const seen = new Set<string>();
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    const bad = (problem: string): VerifyResult => ({ ok: false, events: events.length, first_bad_seq: e.seq, problem });
    if (e.seq !== firstSeq + i) return bad("sequence is not contiguous");
    if (e.workspace_id !== workspaceId) return bad("event belongs to another workspace");
    for (const cause of e.caused_by) if (!seen.has(cause)) return bad(`caused_by ${cause} is not an earlier event`);
    const present = e.payload_state === "present";
    if (present !== (e.payload !== null)) return bad("payload_state does not agree with payload");
    if (present && e.payload_digest !== sha256(canonical(e.payload))) return bad("payload_digest does not match payload");
    if (e.prev_hash !== prev) return bad("prev_hash does not match the previous event");
    if (e.hash !== eventHash(e, prev)) return bad("hash does not verify");
    prev = e.hash;
    seen.add(e.event_id);
  }
  return { ok: true, events: events.length };
}

export interface LedgerOptions {
  workspaceId: string;
  displayTz: string;
  clock: Clock;
  policyRev: () => number;
}

export class Ledger {
  private db: Db;
  private opts: LedgerOptions;

  constructor(db: Db, opts: LedgerOptions) {
    this.db = db;
    this.opts = opts;
  }

  genesisHash(): string {
    return sha256(`correction-layer:genesis:${this.opts.workspaceId}`);
  }

  append(input: AppendInput): LedgerEvent {
    if (!(EVENT_TYPES as readonly string[]).includes(input.type)) throw new ValidationError("ledger event", [`unknown event type ${input.type}`]);
    if (HUMAN_ONLY_EVENTS.has(input.type) && input.actor.kind !== "human") {
      throw new InvariantViolation("human_only_act", `${input.type} must be performed by a person, not ${input.actor.kind} ${input.actor.id}`);
    }
    const causedBy = [...new Set((input.caused_by ?? []).filter((c): c is string => typeof c === "string"))];
    return tx(this.db, () => {
      for (const cause of causedBy) {
        if (!get(this.db, "SELECT 1 FROM events WHERE event_id = ?", cause)) throw new InvariantViolation("causal_order", `caused_by ${cause} is not an earlier event`);
      }
      const head = get<{ seq: number; hash: string }>(this.db, "SELECT seq, hash FROM events ORDER BY seq DESC LIMIT 1");
      const seq = (head?.seq ?? 0) + 1;
      const prev = head?.hash ?? this.genesisHash();
      const payload = input.payload ?? {};
      const refs: Refs = {};
      for (const [k, v] of Object.entries(input.refs ?? {})) if (v !== undefined && v !== null) refs[k as RefKey] = v;
      const envelope: Omit<LedgerEvent, "hash" | "payload"> = {
        event_id: `evt_${String(seq).padStart(6, "0")}`,
        seq,
        type: input.type,
        occurred_at: ts(this.opts.clock.now()),
        display_tz: this.opts.displayTz,
        workspace_id: this.opts.workspaceId,
        project_id: input.project_id,
        actor: input.actor,
        subject: input.subject,
        refs,
        caused_by: causedBy,
        policy_rev: this.opts.policyRev(),
        summary: input.summary,
        payload_state: "present",
        payload_digest: sha256(canonical(payload)),
        classification: input.classification ?? "meta",
        prev_hash: prev,
        schema_version: "cl.event/1",
      };
      const hash = eventHash(envelope, prev);
      run(this.db, "INSERT INTO events (seq, event_id, type, occurred_at, workspace_id, project_id, envelope_json, payload_digest, prev_hash, hash) VALUES (?,?,?,?,?,?,?,?,?,?)",
        seq, envelope.event_id, envelope.type, envelope.occurred_at, envelope.workspace_id, envelope.project_id, json(envelope), envelope.payload_digest, prev, hash);
      run(this.db, "INSERT INTO event_payloads (event_id, payload_json, payload_state) VALUES (?, ?, 'present')", envelope.event_id, json(payload));
      for (const [key, value] of Object.entries(refs)) run(this.db, "INSERT INTO event_refs (seq, key, value) VALUES (?, ?, ?)", seq, key, String(value));
      for (const cause of causedBy) run(this.db, "INSERT INTO event_causes (seq, caused_by) VALUES (?, ?)", seq, cause);
      return { ...envelope, payload, hash };
    });
  }

  private hydrate(row: { envelope_json: string; hash: string; payload_json: string | null; payload_state: "present" | "erased" }): LedgerEvent {
    const envelope = parse<Omit<LedgerEvent, "hash" | "payload">>(row.envelope_json);
    return { ...envelope, payload_state: row.payload_state, payload: row.payload_state === "present" ? parse(row.payload_json) : null, hash: row.hash };
  }

  private select(where: string, params: unknown[], order = "ASC", limit = 10000): LedgerEvent[] {
    return all<any>(this.db, `SELECT e.envelope_json, e.hash, p.payload_json, p.payload_state FROM events e JOIN event_payloads p ON p.event_id = e.event_id ${where} ORDER BY e.seq ${order} LIMIT ?`, ...params, limit)
      .map((r) => this.hydrate(r));
  }

  get(eventId: string): LedgerEvent {
    const found = this.select("WHERE e.event_id = ?", [eventId]);
    if (!found[0]) throw new NotFound("event", eventId);
    return found[0];
  }

  all(): LedgerEvent[] {
    return this.select("", []);
  }

  /** Newest first. `projectId: null` lists workspace-level events only; undefined lists everything. */
  recent(filter: { projectId?: string | null; types?: EventType[]; limit?: number } = {}): LedgerEvent[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.projectId !== undefined) {
      where.push(filter.projectId === null ? "e.project_id IS NULL" : "e.project_id = ?");
      if (filter.projectId !== null) params.push(filter.projectId);
    }
    if (filter.types?.length) {
      where.push(`e.type IN (${filter.types.map(() => "?").join(",")})`);
      params.push(...filter.types);
    }
    return this.select(where.length ? "WHERE " + where.join(" AND ") : "", params, "DESC", filter.limit ?? 50);
  }

  /** Every event that references an entity, oldest first (an indexed lookup, not a payload scan). */
  byRef(key: RefKey, value: string | number): LedgerEvent[] {
    return this.select("WHERE e.seq IN (SELECT seq FROM event_refs WHERE key = ? AND value = ?)", [key, String(value)]);
  }

  /** Events directly caused by the given event. */
  effectsOf(eventId: string): LedgerEvent[] {
    return this.select("WHERE e.seq IN (SELECT seq FROM event_causes WHERE caused_by = ?)", [eventId]);
  }

  verify(): VerifyResult {
    return verifyEvents(this.all(), this.genesisHash(), 1, this.opts.workspaceId);
  }

  /** Erase an evidence payload under retention; the envelope and the chain stay verifiable. */
  erasePayload(eventId: string): void {
    const changed = run(this.db, "UPDATE event_payloads SET payload_json = NULL, payload_state = 'erased' WHERE event_id = ?", eventId);
    if (!changed.changes) throw new NotFound("event", eventId);
  }

  /** An exported, contiguous segment in the cl.event_log/1 shape. */
  exportLog(): Record<string, unknown> {
    const events = this.all();
    return {
      schema_version: "cl.event_log/1",
      workspace_id: this.opts.workspaceId,
      display_tz: this.opts.displayTz,
      chain: {
        algorithm: "sha256(prev_hash + newline + canonical JSON of the event without 'hash' and 'payload')",
        first_seq: events[0]?.seq ?? 1,
        last_seq: events.at(-1)?.seq ?? 0,
        first_prev_hash: this.genesisHash(),
        head_hash: events.at(-1)?.hash ?? this.genesisHash(),
      },
      events,
    };
  }
}
