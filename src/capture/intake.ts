/**
 * Capture intake (docs/06 §11): durable receipt of events from opted-in capture
 * adapters. At-least-once in, effectively-once out.
 *
 *   intake(delivery):                      # per stream; state: received, cursor
 *     if delivery.seq already received:
 *         same digest      -> DUPLICATE          (acknowledge, drop)
 *         different digest -> REJECTED_CONFLICT  (integrity alert)
 *     else:
 *         record seq as received
 *         no consent for this project/surface -> CONSENT_BLOCKED (content dropped, counted)
 *         event not valid or kind unknown     -> DEAD_LETTER     (kept briefly, never processed)
 *         seq == cursor + 1                   -> ACCEPTED
 *         seq  > cursor + 1                   -> HELD_OUT_OF_ORDER
 *     advance cursor while the next seq has been received
 *     return result, cursor                 # the acknowledgement
 *
 * The intake decides nothing about meaning. It stores, acknowledges, de-duplicates,
 * orders, detects gaps, binds each event to a project with the store's own resolver
 * (never trusting the adapter's claim), and enforces consent. A captured event is
 * evidence about what someone said; whether it can change anything is decided later
 * by trust class, tests and the learning policy.
 */
import { problems } from "../contracts/schemas.ts";
import { sha256 } from "../domain/canonical.ts";
import { NotFound, PermissionDenied, ValidationError } from "../domain/errors.ts";
import type { IdGen } from "../domain/ids.ts";
import { SYS, isId } from "../domain/ids.ts";
import type { Clock } from "../domain/time.ts";
import { parseTs, ts } from "../domain/time.ts";
import type { Actor, CaptureEvent, DeliveryMode, IntakeResult, IntakeValidation, StreamHealth, Surface } from "../domain/types.ts";
import { CAPTURE_KINDS } from "../domain/types.ts";
import type { ProjectService } from "../context/projects.ts";
import type { LearningPolicyService } from "../learning/policy.ts";
import type { Ledger } from "../ledger/ledger.ts";
import { requireHuman } from "../policy/rules.ts";
import type { Db } from "../store/db.ts";
import { all, get, json, parse, run, tx } from "../store/db.ts";
import type { SurfaceLabel } from "./registry.ts";
import { KNOWN_RUNTIMES } from "./registry.ts";

export const GAP_TIMEOUT_SECONDS = 60;
export const STALE_AFTER_SECONDS = 300;
const CONTENT_KINDS = new Set(["user_turn", "review_action", "edit_observed"]);

export interface AdapterRecord {
  adapter_id: string;
  kind: "runtime_hook" | "app_native" | "folder_watch" | "app_connector";
  label: string;
  /** True for adapters that exist to exercise the pipeline, not to observe a real runtime. */
  simulated: boolean;
  attests_user_turns: boolean;
  durable_outbox: boolean;
  supports_replay: boolean;
  supports_backfill: boolean;
  revoked: boolean;
}

export interface DeliveryItem {
  event: unknown;
  delivery?: DeliveryMode;
}

export interface DeliveryAck {
  source_seq: number | null;
  capture_id: string | null;
  validation: IntakeValidation;
  result: IntakeResult;
  /** Cursor after this item: every sequence number up to here is safely received. */
  ack_through: number;
}

export interface StreamState {
  stream_id: string;
  adapter_id: string;
  project_id: string | null;
  status: "open" | "closed_complete" | "closed_incomplete";
  health: StreamHealth;
  health_reason: string;
  acked_through: number;
  processed_through: number;
  adapter_last_seq: number;
  final_seq: number | null;
  gaps: Array<{ from_seq: number; to_seq: number; detected_at: string; closed_at: string | null; cause: string; acknowledged_by: string | null; acknowledged_at: string | null }>;
  dead_letters: Array<{ source_seq: number; stage: string; reason: string; at: string }>;
  duplicates_dropped: number;
  held_out_of_order: number;
  consent_blocked: number;
  integrity_flag: string | null;
  opened_at: string;
  closed_at: string | null;
}

/** Which surface an event belongs to, from its kind and who vouches for it. */
export function surfaceOf(e: Pick<CaptureEvent, "kind" | "attested_by">): Surface | null {
  if (e.kind === "edit_observed") return "folder_watch";
  if (e.kind === "review_action") return e.attested_by === "app" ? "review_action" : null;
  if (e.kind === "user_turn") return e.attested_by === "app" ? "app" : e.attested_by === "runtime_hook" || e.attested_by === "runtime_transcript" ? "attested_user_turn" : null;
  return null;
}

/** Digest an adapter must send for a content-bearing event (sha256 of the UTF-8 text). */
export function contentDigest(text: string | null): string {
  return sha256(text ?? "");
}

export class CaptureIntake {
  private db: Db;
  private ledger: Ledger;
  private clock: Clock;
  private ids: IdGen;
  private projects: ProjectService;
  private policies: LearningPolicyService;
  private workspaceId: string;
  private afterAdvance: Array<(streamId: string) => void> = [];

  constructor(deps: { db: Db; ledger: Ledger; clock: Clock; ids: IdGen; projects: ProjectService; policies: LearningPolicyService; workspaceId: string }) {
    this.db = deps.db;
    this.ledger = deps.ledger;
    this.clock = deps.clock;
    this.ids = deps.ids;
    this.projects = deps.projects;
    this.policies = deps.policies;
    this.workspaceId = deps.workspaceId;
  }

  /** Hook for the processing stage. It runs after the receiving transaction has committed. */
  onAdvance(listener: (streamId: string) => void): void {
    this.afterAdvance.push(listener);
  }

  // ------------------------------------------------------------ adapters
  /** Pairing is an explicit act by a person (docs/06 §2.3, §11.8). */
  pairAdapter(input: Omit<AdapterRecord, "revoked" | "adapter_id"> & { adapter_id?: string }, actor: Actor): AdapterRecord {
    requireHuman(actor, "Pairing a capture adapter");
    const adapterId = input.adapter_id ?? this.ids("adp");
    if (!isId(adapterId, "adp")) throw new ValidationError("capture adapter", ["adapter_id: must look like adp_XXXXXX"]);
    run(this.db, "INSERT INTO capture_adapters (adapter_id, workspace_id, kind, label, simulated, record_json, paired_by, paired_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT (adapter_id) DO NOTHING",
      adapterId, this.workspaceId, input.kind, input.label, input.simulated ? 1 : 0, json({ ...input, adapter_id: adapterId }), actor.id, ts(this.clock.now()));
    return this.adapter(adapterId);
  }

  revokeAdapter(adapterId: string, actor: Actor): void {
    requireHuman(actor, "Revoking a capture adapter");
    run(this.db, "UPDATE capture_adapters SET revoked_at = ? WHERE adapter_id = ?", ts(this.clock.now()), adapterId);
  }

  adapter(adapterId: string): AdapterRecord {
    const row = get<any>(this.db, "SELECT record_json, revoked_at FROM capture_adapters WHERE adapter_id = ? AND workspace_id = ?", adapterId, this.workspaceId);
    if (!row) throw new NotFound("capture adapter", adapterId);
    return { ...parse<AdapterRecord>(row.record_json), revoked: !!row.revoked_at };
  }

  adapters(): AdapterRecord[] {
    return all<{ adapter_id: string }>(this.db, "SELECT adapter_id FROM capture_adapters WHERE workspace_id = ? ORDER BY paired_at, adapter_id", this.workspaceId).map((r) => this.adapter(r.adapter_id));
  }

  private requireAdapter(adapterId: string): AdapterRecord {
    let adapter: AdapterRecord;
    try {
      adapter = this.adapter(adapterId);
    } catch {
      throw new PermissionDenied(`capture adapter ${adapterId} is not paired with this workspace`, "adapter_not_paired");
    }
    if (adapter.revoked) throw new PermissionDenied(`capture adapter ${adapterId} was revoked`, "adapter_revoked");
    return adapter;
  }

  // ------------------------------------------------------------ operations
  /**
   * capture_hello: the adapter names its stream and its last sequence number; the
   * service answers with its cursor so the adapter can replay everything above it.
   */
  hello(input: { adapter_id: string; stream_id: string; session_id?: string; last_seq: number; binding_id?: string | null }, internal: { author_id?: string; project_id?: string } = {}): { cursor: number; status: string; consent: { project_id: string | null; surfaces: Surface[] } } {
    this.requireAdapter(input.adapter_id);
    // The author of a stream is the person who paired the adapter for their own assistant; only the
    // app itself (an authenticated person typing in the app) may name the author directly.
    const author = internal.author_id ?? get<any>(this.db, "SELECT paired_by FROM capture_adapters WHERE adapter_id = ?", input.adapter_id)!.paired_by;
    if (!isId(input.stream_id, "str")) throw new ValidationError("capture_hello", ["stream_id: must look like str_XXXXXX"]);
    return tx(this.db, () => {
      const now = ts(this.clock.now());
      const projectId = internal.project_id ?? (input.binding_id ? this.projects.projectOfBinding(input.binding_id) : null);
      const existing = get<any>(this.db, "SELECT adapter_id, cursor, status, project_id FROM capture_streams WHERE stream_id = ?", input.stream_id);
      if (existing && existing.adapter_id !== input.adapter_id) throw new PermissionDenied("this stream belongs to another adapter", "stream_adapter_mismatch");
      if (!existing) {
        run(this.db, "INSERT INTO capture_streams (stream_id, workspace_id, adapter_id, session_id, author_id, project_id, opened_at, adapter_last_seq, last_heard_at) VALUES (?,?,?,?,?,?,?,?,?)",
          input.stream_id, this.workspaceId, input.adapter_id, input.session_id ?? null, author, projectId, now, Math.max(0, input.last_seq), now);
        this.ledger.append({
          type: "capture.stream_opened", project_id: projectId, actor: { kind: "adapter", id: input.adapter_id }, subject: { kind: "capture_stream", id: input.stream_id },
          refs: { stream_id: input.stream_id, adapter_id: input.adapter_id, ...(input.session_id ? { session_id: input.session_id } : {}) }, summary: "A capture stream was opened by a paired adapter.",
        });
      } else {
        run(this.db, "UPDATE capture_streams SET adapter_last_seq = MAX(adapter_last_seq, ?), last_heard_at = ? WHERE stream_id = ?", input.last_seq, now, input.stream_id);
      }
      const state = get<any>(this.db, "SELECT cursor, status, project_id FROM capture_streams WHERE stream_id = ?", input.stream_id)!;
      // A reconnecting adapter that holds more than the cursor: events are missing until it replays them.
      if (existing) this.trackGaps(input.stream_id);
      const surfaces = (["app", "attested_user_turn", "review_action", "folder_watch", "assistant_relay"] as Surface[]).filter((s) => this.policies.consents(state.project_id, s));
      return { cursor: state.cursor, status: state.status, consent: { project_id: state.project_id, surfaces } };
    });
  }

  /**
   * capture_deliver: one or more events, stored in ONE transaction; the answer is a
   * result per event and the new cursor. If the service stops before answering, the
   * adapter re-sends and the repeats are acknowledged as duplicates.
   */
  deliver(input: { adapter_id: string; stream_id: string; events: DeliveryItem[] }): { results: DeliveryAck[]; cursor: number } {
    this.requireAdapter(input.adapter_id);
    const stream = get<any>(this.db, "SELECT adapter_id FROM capture_streams WHERE stream_id = ?", input.stream_id);
    if (!stream) throw new NotFound("capture stream (call capture_hello first)", input.stream_id);
    if (stream.adapter_id !== input.adapter_id) throw new PermissionDenied("this stream belongs to another adapter", "stream_adapter_mismatch");
    if (!Array.isArray(input.events) || input.events.length === 0 || input.events.length > 500) throw new ValidationError("capture_deliver", ["events: between 1 and 500 events are required"]);
    const result = tx(this.db, () => {
      const results = input.events.map((item) => this.receive(input.adapter_id, input.stream_id, item));
      // Gaps are judged once per delivery, after the whole batch is stored.
      this.trackGaps(input.stream_id);
      run(this.db, "UPDATE capture_streams SET last_heard_at = ? WHERE stream_id = ?", ts(this.clock.now()), input.stream_id);
      return { results, cursor: this.cursor(input.stream_id) };
    });
    for (const listener of this.afterAdvance) listener(input.stream_id);
    return result;
  }

  heartbeat(input: { adapter_id: string; stream_id: string; last_seq: number }): { cursor: number; health: StreamHealth } {
    this.requireAdapter(input.adapter_id);
    this.touch(input.stream_id, input.adapter_id, input.last_seq);
    for (const listener of this.afterAdvance) listener(input.stream_id);
    return { cursor: this.cursor(input.stream_id), health: this.stream(input.stream_id).health };
  }

  /** capture_close: the stream ended at sequence N. Anything missing below N is a gap that stays visible. */
  close(input: { adapter_id: string; stream_id: string; final_seq: number }): { cursor: number; status: string } {
    this.requireAdapter(input.adapter_id);
    this.touch(input.stream_id, input.adapter_id, input.final_seq);
    tx(this.db, () => {
      const now = ts(this.clock.now());
      const cursor = this.cursor(input.stream_id);
      const status = cursor >= input.final_seq ? "closed_complete" : "closed_incomplete";
      const before = get<any>(this.db, "SELECT status, project_id FROM capture_streams WHERE stream_id = ?", input.stream_id)!;
      run(this.db, "UPDATE capture_streams SET final_seq = ?, status = ?, closed_at = ? WHERE stream_id = ?", input.final_seq, status, now, input.stream_id);
      this.trackGaps(input.stream_id);
      if (before.status === "open") {
        this.ledger.append({
          type: "capture.stream_closed", project_id: before.project_id, actor: { kind: "adapter", id: input.adapter_id }, subject: { kind: "capture_stream", id: input.stream_id }, refs: { stream_id: input.stream_id, adapter_id: input.adapter_id },
          summary: status === "closed_complete" ? "A capture stream ended; everything the adapter sent was received." : "A capture stream ended with events missing. The gap stays visible.",
          payload: { final_seq: input.final_seq, acked_through: cursor, status },
        });
      }
    });
    for (const listener of this.afterAdvance) listener(input.stream_id);
    const state = this.stream(input.stream_id);
    return { cursor: state.acked_through, status: state.status };
  }

  private touch(streamId: string, adapterId: string, lastSeq: number): void {
    const stream = get<any>(this.db, "SELECT adapter_id FROM capture_streams WHERE stream_id = ?", streamId);
    if (!stream) throw new NotFound("capture stream", streamId);
    if (stream.adapter_id !== adapterId) throw new PermissionDenied("this stream belongs to another adapter", "stream_adapter_mismatch");
    tx(this.db, () => {
      run(this.db, "UPDATE capture_streams SET adapter_last_seq = MAX(adapter_last_seq, ?), last_heard_at = ? WHERE stream_id = ?", Math.max(0, Math.trunc(lastSeq) || 0), ts(this.clock.now()), streamId);
      this.trackGaps(streamId);
    });
  }

  private cursor(streamId: string): number {
    return get<{ cursor: number }>(this.db, "SELECT cursor FROM capture_streams WHERE stream_id = ?", streamId)!.cursor;
  }

  // ------------------------------------------------------------ the intake procedure
  private receive(adapterId: string, streamId: string, item: DeliveryItem): DeliveryAck {
    const now = ts(this.clock.now());
    const raw = (item.event !== null && typeof item.event === "object" ? item.event : {}) as Record<string, unknown>;
    const delivery: DeliveryMode = item.delivery === "replay" || item.delivery === "backfill" ? item.delivery : "live";
    const seq = Number.isInteger(raw.source_seq) && (raw.source_seq as number) >= 1 ? (raw.source_seq as number) : null;
    const captureId = isId(raw.capture_id, "cap") ? raw.capture_id : null;
    const digest = typeof raw.content_digest === "string" ? raw.content_digest : "";
    const log = (validation: IntakeValidation, result: IntakeResult): DeliveryAck => {
      const ack = this.cursor(streamId);
      run(this.db, "INSERT INTO capture_deliveries (stream_id, source_seq, capture_id, delivery, content_digest, validation, result, ack_through, received_at) VALUES (?,?,?,?,?,?,?,?,?)",
        streamId, seq ?? 0, captureId ?? "", delivery, digest, validation, result, ack, now);
      return { source_seq: seq, capture_id: captureId, validation, result, ack_through: ack };
    };
    // An item with no usable position cannot be placed in the stream at all.
    if (seq === null || raw.stream_id !== streamId) {
      const arrival = get<{ n: number }>(this.db, "SELECT COALESCE(MAX(arrival), 0) + 1 AS n FROM capture_deliveries")!.n;
      this.deadLetter(streamId, -arrival, captureId, "intake", seq === null ? "missing_source_seq" : "wrong_stream", raw);
      return log("schema_invalid", "dead_letter");
    }
    const seen = get<{ content_digest: string; result: string }>(this.db, "SELECT content_digest, result FROM capture_received WHERE stream_id = ? AND source_seq = ?", streamId, seq);
    if (seen?.result === "acknowledged_lost") {
      // A person already acknowledged this event as lost and the stream moved past it: set aside visibly, never processed.
      this.deadLetter(streamId, seq, captureId, "intake", "arrived after a person acknowledged it as lost", raw);
      return log("ok", "dead_letter");
    }
    if (seen) {
      if (seen.content_digest === digest) {
        run(this.db, "UPDATE capture_streams SET duplicates_dropped = duplicates_dropped + 1 WHERE stream_id = ?", streamId);
        return log("ok", "duplicate");
      }
      // Same position, different content: refused, and the stream is flagged. Nothing from it is used.
      const first = !get<any>(this.db, "SELECT integrity_flag FROM capture_streams WHERE stream_id = ?", streamId)?.integrity_flag;
      run(this.db, "UPDATE capture_streams SET integrity_flag = ? WHERE stream_id = ?", `digest conflict at sequence ${seq}`, streamId);
      if (first) {
        this.ledger.append({
          type: "capture.health_changed", project_id: null, actor: { kind: "system", id: SYS.intake }, subject: { kind: "capture_stream", id: streamId }, refs: { stream_id: streamId, adapter_id: adapterId },
          summary: `Integrity warning: adapter ${adapterId} re-sent sequence ${seq} with different content. The repeat was refused.`, payload: { health: "degraded", reason: "digest_conflict", source_seq: seq },
        });
      }
      return log("ok", "rejected_conflict");
    }

    // First sight of this sequence number: record it before anything else.
    let validation: IntakeValidation = "ok";
    let reason = "";
    const schemaProblems = problems("capture-event", raw);
    if (typeof raw.kind !== "string" || !(CAPTURE_KINDS as readonly string[]).includes(raw.kind)) [validation, reason] = ["unsupported_event_kind", "unsupported_event_kind"];
    else if (schemaProblems.length) [validation, reason] = ["schema_invalid", schemaProblems[0]!];
    const event = raw as unknown as CaptureEvent;
    if (validation === "ok") {
      const text = event.content?.text ?? null;
      const roleOk = event.kind === "user_turn" || event.kind === "review_action" ? event.role === "user"
        : event.kind === "agent_output" ? event.role === "agent" : event.kind === "tool_output" ? event.role === "tool" : true;
      if (event.adapter_id !== adapterId) [validation, reason] = ["schema_invalid", "the event names another adapter"];
      else if (!roleOk) [validation, reason] = ["schema_invalid", `a ${event.kind} cannot carry the role ${event.role}`];
      // Assistant and tool output is never stored as text: a digest only (docs/12 §12).
      else if ((event.kind === "agent_output" || event.kind === "tool_output") && event.content !== null) [validation, reason] = ["schema_invalid", "agent and tool output must be sent as a digest only"];
      else if (CONTENT_KINDS.has(event.kind) && text !== null && contentDigest(text) !== event.content_digest) [validation, reason] = ["schema_invalid", "content_digest does not match the content"];
    }
    const record = (result: IntakeResult): void => {
      run(this.db, "INSERT INTO capture_received (stream_id, source_seq, capture_id, content_digest, result, received_at) VALUES (?,?,?,?,?,?)", streamId, seq, captureId ?? "", digest, result, now);
    };
    if (validation !== "ok") {
      record("dead_letter");
      this.deadLetter(streamId, seq, captureId, "intake", reason, raw);
      this.advance(streamId);
      return log(validation, "dead_letter");
    }
    const cursorBefore = this.cursor(streamId);
    const inOrder = seq === cursorBefore + 1;
    // Bind with the store's own resolver. The adapter's project claim is never trusted on its own.
    const explicit = this.explicitProject(event);
    const surface = surfaceOf(event);
    let contentState: string = event.content_state;
    let text = event.content?.text ?? null;
    let result: IntakeResult = inOrder ? "accepted" : "held_out_of_order";
    if (explicit.status === "conflict") {
      // The adapter's claim disagrees with the store: unbound, content not kept.
      [text, contentState] = [null, "purged"];
    } else if (CONTENT_KINDS.has(event.kind) && text !== null && (explicit.project_id || inOrder)) {
      const projectId = explicit.project_id ?? get<any>(this.db, "SELECT project_id FROM capture_streams WHERE stream_id = ?", streamId)!.project_id;
      if (!surface || !this.policies.consents(projectId, surface)) {
        // No consent for this project and surface: the content is dropped on arrival; only a count is kept.
        [text, contentState, result, validation] = [null, "purged", "consent_blocked", "consent_missing"];
        this.countConsentBlocked(streamId, projectId, surface ?? "unknown");
      }
    }
    record(result);
    if (!inOrder && result !== "consent_blocked") run(this.db, "UPDATE capture_streams SET held_out_of_order = held_out_of_order + 1 WHERE stream_id = ?", streamId);
    run(this.db, `INSERT INTO capture_events (capture_id, stream_id, source_seq, workspace_id, project_id, bound, kind, role, attested_by, delivery, occurred_at, received_at, content_state, content_text, language, artifact_id, content_hash, content_digest, disposition)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      event.capture_id, streamId, seq, this.workspaceId, explicit.project_id, explicit.project_id ? 1 : 0, event.kind, event.role, event.attested_by, delivery, event.occurred_at, now,
      contentState, text, event.content?.language ?? null, explicit.status === "conflict" ? null : (event.binding.artifact_id ?? null), event.binding.content_hash ?? null, event.content_digest,
      result === "consent_blocked" ? "consent_blocked" : explicit.status === "conflict" ? "unbound" : null);
    if (typeof event.final_seq === "number") run(this.db, "UPDATE capture_streams SET adapter_last_seq = MAX(adapter_last_seq, ?) WHERE stream_id = ?", event.final_seq, streamId);
    run(this.db, "UPDATE capture_streams SET adapter_last_seq = MAX(adapter_last_seq, ?) WHERE stream_id = ?", seq, streamId);
    this.advance(streamId);
    return log(validation, result);
  }

  /** Project named by the event itself (folder binding or artifact), resolved from the store. */
  private explicitProject(event: CaptureEvent): { project_id: string | null; status: "bound" | "inherit" | "conflict" } {
    const viaBinding = event.binding.binding_id ? this.projects.projectOfBinding(event.binding.binding_id) : null;
    const viaArtifact = event.binding.artifact_id ? (get<any>(this.db, "SELECT project_id FROM artifacts WHERE artifact_id = ? AND workspace_id = ?", event.binding.artifact_id, this.workspaceId)?.project_id ?? null) : null;
    const resolved = viaArtifact ?? viaBinding;
    if (viaArtifact && viaBinding && viaArtifact !== viaBinding) return { project_id: null, status: "conflict" };
    if ((event.binding.binding_id || event.binding.artifact_id) && !resolved) return { project_id: null, status: "conflict" };
    if (event.binding.project_id && resolved && event.binding.project_id !== resolved) return { project_id: null, status: "conflict" };
    if (event.binding.project_id && !resolved) return { project_id: null, status: "conflict" }; // a bare claim with nothing the store can verify
    return resolved ? { project_id: resolved, status: "bound" } : { project_id: null, status: "inherit" };
  }

  private countConsentBlocked(streamId: string, projectId: string | null, surface: string): void {
    const now = ts(this.clock.now());
    run(this.db, "UPDATE capture_streams SET consent_blocked = consent_blocked + 1 WHERE stream_id = ?", streamId);
    run(this.db, "INSERT INTO capture_consent_blocked (project_key, surface, count, last_at) VALUES (?, ?, 1, ?) ON CONFLICT (project_key, surface) DO UPDATE SET count = count + 1, last_at = excluded.last_at", projectId ?? "(unbound)", surface, now);
    if (get<{ count: number }>(this.db, "SELECT count FROM capture_consent_blocked WHERE project_key = ? AND surface = ?", projectId ?? "(unbound)", surface)!.count === 1) {
      this.ledger.append({
        type: "capture.consent_blocked", project_id: projectId, actor: { kind: "system", id: SYS.intake }, subject: { kind: "capture_stream", id: streamId }, refs: { stream_id: streamId },
        summary: "Events arrived for a project or surface where learning is not switched on. Their content was not kept; only a count is.", payload: { surface },
      });
    }
  }

  private deadLetter(streamId: string, seq: number, captureId: string | null, stage: "intake" | "processing", reason: string, raw: unknown): void {
    const now = ts(this.clock.now());
    run(this.db, "INSERT INTO capture_dead_letters (stream_id, source_seq, capture_id, stage, reason, raw_json, at) VALUES (?,?,?,?,?,?,?) ON CONFLICT (stream_id, source_seq, stage) DO UPDATE SET attempts = attempts + 1, reason = excluded.reason, at = excluded.at",
      streamId, seq, captureId, stage, reason, raw === null ? null : json(raw), now);
    const projectId = get<any>(this.db, "SELECT project_id FROM capture_streams WHERE stream_id = ?", streamId)?.project_id ?? null;
    this.ledger.append({
      type: "capture.dead_lettered", project_id: projectId, actor: { kind: "system", id: SYS.intake }, subject: { kind: "capture_stream", id: streamId },
      refs: { stream_id: streamId, ...(captureId ? { capture_id: captureId } : {}) }, summary: `1 captured event could not be ${stage === "intake" ? "read" : "processed"} and was set aside. It is never turned into a signal.`,
      payload: { source_seq: seq, stage, reason },
    });
  }

  /** Record a processing failure that exhausted its retries (called by the processing stage). */
  deadLetterProcessing(streamId: string, seq: number, captureId: string, reason: string): void {
    this.deadLetter(streamId, seq, captureId, "processing", reason, null);
  }

  /**
   * Advance the cursor while the next sequence number has been received. Events that
   * were held are admitted here, in order: this is where an event with no binding of
   * its own takes the project of the stream at that position, and where consent for
   * it can finally be decided.
   */
  private advance(streamId: string): void {
    for (;;) {
      const state = get<any>(this.db, "SELECT cursor, project_id FROM capture_streams WHERE stream_id = ?", streamId)!;
      const next = state.cursor + 1;
      if (!get(this.db, "SELECT 1 FROM capture_received WHERE stream_id = ? AND source_seq = ?", streamId, next)) break;
      const event = get<any>(this.db, "SELECT * FROM capture_events WHERE stream_id = ? AND source_seq = ?", streamId, next);
      let streamProject: string | null = state.project_id;
      if (event) {
        if (event.bound) streamProject = event.project_id; // the stream moved to (or stays in) this project
        else if (event.disposition !== "unbound" && streamProject) {
          const surface = surfaceOf(event);
          if (CONTENT_KINDS.has(event.kind) && event.content_text !== null && (!surface || !this.policies.consents(streamProject, surface))) {
            run(this.db, "UPDATE capture_events SET content_text = NULL, content_state = 'purged', disposition = 'consent_blocked' WHERE capture_id = ?", event.capture_id);
            this.countConsentBlocked(streamId, streamProject, surface ?? "unknown");
          }
          run(this.db, "UPDATE capture_events SET project_id = ?, bound = 1 WHERE capture_id = ?", streamProject, event.capture_id);
        } else if (CONTENT_KINDS.has(event.kind)) {
          // Not exactly one project: never guessed. Without a project there is no consent to keep the text.
          run(this.db, "UPDATE capture_events SET content_text = NULL, content_state = 'purged', disposition = 'unbound' WHERE capture_id = ?", event.capture_id);
        }
      }
      run(this.db, "UPDATE capture_streams SET cursor = ?, project_id = ? WHERE stream_id = ?", next, streamProject, streamId);
    }
  }

  /** Open a gap record when something is missing below what was received or announced; close it when the cursor passes. */
  private trackGaps(streamId: string): void {
    const now = ts(this.clock.now());
    const s = get<any>(this.db, "SELECT cursor, adapter_last_seq, final_seq, project_id, adapter_id FROM capture_streams WHERE stream_id = ?", streamId)!;
    for (const gap of all<any>(this.db, "SELECT from_seq, to_seq FROM capture_gaps WHERE stream_id = ? AND closed_at IS NULL", streamId)) {
      if (s.cursor >= gap.to_seq) {
        run(this.db, "UPDATE capture_gaps SET closed_at = ? WHERE stream_id = ? AND from_seq = ? AND to_seq = ?", now, streamId, gap.from_seq, gap.to_seq);
        // A gap a person acknowledged as lost closes without claiming that nothing was lost.
        if (get(this.db, "SELECT 1 FROM capture_gaps WHERE stream_id = ? AND from_seq = ? AND to_seq = ? AND acknowledged_at IS NOT NULL", streamId, gap.from_seq, gap.to_seq)) continue;
        this.ledger.append({
          type: "capture.gap_closed", project_id: s.project_id, actor: { kind: "system", id: SYS.intake }, subject: { kind: "capture_stream", id: streamId }, refs: { stream_id: streamId, adapter_id: s.adapter_id },
          caused_by: this.ledger.byRef("stream_id", streamId).filter((e) => e.type === "capture.gap_detected").slice(-1).map((e) => e.event_id),
          summary: `Missing events ${gap.from_seq} to ${gap.to_seq} arrived by replay. Nothing was lost.`, payload: { from_seq: gap.from_seq, to_seq: gap.to_seq },
        });
      }
    }
    const highest = Math.max(s.adapter_last_seq, s.final_seq ?? 0, get<{ m: number }>(this.db, "SELECT COALESCE(MAX(source_seq), 0) AS m FROM capture_received WHERE stream_id = ?", streamId)!.m);
    if (highest > s.cursor && !get(this.db, "SELECT 1 FROM capture_gaps WHERE stream_id = ? AND closed_at IS NULL", streamId)) {
      const firstAbove = get<{ m: number | null }>(this.db, "SELECT MIN(source_seq) AS m FROM capture_received WHERE stream_id = ? AND source_seq > ?", streamId, s.cursor)!.m;
      const to = firstAbove ? firstAbove - 1 : highest;
      run(this.db, "INSERT INTO capture_gaps (stream_id, from_seq, to_seq, detected_at, cause) VALUES (?,?,?,?,?) ON CONFLICT (stream_id, from_seq, to_seq) DO UPDATE SET closed_at = NULL",
        streamId, s.cursor + 1, to, now, firstAbove ? "A later event arrived before an earlier one." : "The adapter reports more events than have been received.");
      this.ledger.append({
        type: "capture.gap_detected", project_id: s.project_id, actor: { kind: "system", id: SYS.intake }, subject: { kind: "capture_stream", id: streamId }, refs: { stream_id: streamId, adapter_id: s.adapter_id },
        summary: `Events ${s.cursor + 1} to ${to} of a capture stream have not arrived yet.`, payload: { from_seq: s.cursor + 1, to_seq: to },
      });
    }
  }

  // ------------------------------------------------------------ state, health, coverage
  stream(streamId: string): StreamState {
    const s = get<any>(this.db, "SELECT * FROM capture_streams WHERE stream_id = ? AND workspace_id = ?", streamId, this.workspaceId);
    if (!s) throw new NotFound("capture stream", streamId);
    const gaps = all<any>(this.db, "SELECT from_seq, to_seq, detected_at, closed_at, cause, acknowledged_by, acknowledged_at FROM capture_gaps WHERE stream_id = ? ORDER BY from_seq", streamId);
    const dead = all<any>(this.db, "SELECT source_seq, stage, reason, at FROM capture_dead_letters WHERE stream_id = ? AND resolved_at IS NULL ORDER BY at", streamId);
    const now = this.clock.now().getTime();
    const openGap = gaps.find((g) => g.closed_at === null);
    const revoked = this.adapter(s.adapter_id).revoked;
    let health: StreamHealth = "healthy";
    let reason = "Connected; everything sent has been received.";
    if (revoked) [health, reason] = ["disconnected", "The adapter was revoked."];
    else if (s.integrity_flag) [health, reason] = ["degraded", `Integrity warning: ${s.integrity_flag}.`];
    else if (dead.length) [health, reason] = ["degraded", `${dead.length} event${dead.length === 1 ? "" : "s"} could not be read.`];
    else if (gaps.some((g) => g.acknowledged_at)) {
      const lost = gaps.filter((g) => g.acknowledged_at);
      [health, reason] = ["gap", `${lost.map((g) => `Events ${g.from_seq} to ${g.to_seq}`).join("; ")} were lost; ${this.projects.displayName(lost[0]!.acknowledged_by)} acknowledged it. Corrections made then were not seen, and nothing after them turns on by itself.`];
    }
    else if (openGap && (s.status === "closed_incomplete" || now - parseTs(openGap.detected_at).getTime() > GAP_TIMEOUT_SECONDS * 1000)) [health, reason] = ["gap", `Events ${openGap.from_seq} to ${openGap.to_seq} are missing. Corrections made then may not have been seen.`];
    else if (openGap || s.cursor < s.adapter_last_seq) [health, reason] = ["lagging", "The adapter has more than has been delivered so far."];
    else if (s.status === "open" && now - parseTs(s.last_heard_at).getTime() > STALE_AFTER_SECONDS * 1000) [health, reason] = ["stale", "A session is open and nothing has been heard from the adapter recently."];
    return {
      stream_id: s.stream_id, adapter_id: s.adapter_id, project_id: s.project_id, status: s.status, health, health_reason: reason, acked_through: s.cursor, processed_through: s.processed_through,
      adapter_last_seq: s.adapter_last_seq, final_seq: s.final_seq, gaps, dead_letters: dead, duplicates_dropped: s.duplicates_dropped, held_out_of_order: s.held_out_of_order,
      consent_blocked: s.consent_blocked, integrity_flag: s.integrity_flag, opened_at: s.opened_at, closed_at: s.closed_at,
    };
  }

  /** Every delivery attempt of a stream in arrival order (the acknowledgement log). */
  deliveries(streamId: string): Array<{ source_seq: number; capture_id: string; delivery: string; validation: string; result: string; ack_through: number }> {
    return all<any>(this.db, "SELECT source_seq, capture_id, delivery, validation, result, ack_through FROM capture_deliveries WHERE stream_id = ? ORDER BY arrival", streamId);
  }

  streamsForProject(projectId: string): StreamState[] {
    return all<{ stream_id: string }>(this.db, "SELECT DISTINCT s.stream_id FROM capture_streams s LEFT JOIN capture_events e ON e.stream_id = s.stream_id WHERE s.workspace_id = ? AND (s.project_id = ? OR e.project_id = ?) ORDER BY s.opened_at DESC", this.workspaceId, projectId, projectId)
      .map((r) => this.stream(r.stream_id));
  }

  consentBlockedCount(projectId: string): number {
    return get<{ n: number }>(this.db, "SELECT COALESCE(SUM(count), 0) AS n FROM capture_consent_blocked WHERE project_key = ?", projectId)!.n;
  }

  /**
   * A person acknowledges that missing events will not arrive (the adapter lost
   * them). The gap stays visible and the episode stays "capture incomplete" - it
   * only stops processing from waiting for events that will never come.
   */
  acknowledgeGap(streamId: string, fromSeq: number, actor: Actor): void {
    requireHuman(actor, "Acknowledging a capture gap");
    tx(this.db, () => {
      const gap = get<any>(this.db, "SELECT g.*, s.project_id, s.adapter_id FROM capture_gaps g JOIN capture_streams s ON s.stream_id = g.stream_id WHERE g.stream_id = ? AND g.from_seq = ? AND g.closed_at IS NULL AND s.workspace_id = ?", streamId, fromSeq, this.workspaceId);
      if (!gap) throw new NotFound("open capture gap", `${streamId}#${fromSeq}`);
      if (gap.acknowledged_at) return;
      const now = ts(this.clock.now());
      run(this.db, "UPDATE capture_gaps SET acknowledged_by = ?, acknowledged_at = ? WHERE stream_id = ? AND from_seq = ? AND to_seq = ?", actor.id, now, streamId, gap.from_seq, gap.to_seq);
      // The missing positions are recorded as lost so the cursor can pass them and held events can be admitted, in order.
      for (let seq = gap.from_seq; seq <= gap.to_seq; seq++) {
        run(this.db, "INSERT INTO capture_received (stream_id, source_seq, capture_id, content_digest, result, received_at) VALUES (?,?,'','','acknowledged_lost',?) ON CONFLICT (stream_id, source_seq) DO NOTHING", streamId, seq, now);
      }
      this.ledger.append({
        type: "capture.health_changed", project_id: gap.project_id, actor, subject: { kind: "capture_stream", id: streamId }, refs: { stream_id: streamId, adapter_id: gap.adapter_id },
        caused_by: this.ledger.byRef("stream_id", streamId).filter((e) => e.type === "capture.gap_detected").slice(-1).map((e) => e.event_id),
        summary: `${actor.display_name ?? actor.id} acknowledged events ${gap.from_seq} to ${gap.to_seq} as lost. The gap stays visible; nothing from that episode turns on by itself.`, payload: { health: "gap", reason: "acknowledged_lost", from_seq: gap.from_seq, to_seq: gap.to_seq },
      });
      this.advance(streamId);
      this.trackGaps(streamId);
    });
    for (const listener of this.afterAdvance) listener(streamId);
  }

  /**
   * Every place a correction might be made, with exactly one label, generated from
   * the adapters actually paired and the project's learning consent (AT-L6). Known
   * apps without an adapter are named NOT CAPTURED.
   */
  surfaceLabels(projectId: string): SurfaceLabel[] {
    const on = (surface: Surface): boolean => this.policies.consents(projectId, surface);
    const out: SurfaceLabel[] = [];
    out.push({ name: "This app (correction box and \"this was a correction\")", label: on("app") ? "CAPTURED" : "NOT CAPTURED", simulated: false, surface: "app", adapter_id: null, detail: on("app") ? "can lead to an automatic rule within the learning setting" : "learning is off for this project" });
    for (const a of this.adapters().filter((x) => x.kind !== "app_native")) {
      const captured = !a.revoked && on("attested_user_turn");
      out.push({ name: a.label, label: captured ? "CAPTURED" : "NOT CAPTURED", simulated: a.simulated, surface: "attested_user_turn", adapter_id: a.adapter_id, detail: a.revoked ? "the adapter was revoked" : captured ? "durable outbox, acknowledgements, replay" : "learning for attested assistant messages is off in this project" });
    }
    out.push({ name: "Corrections an assistant passes on by itself", label: on("assistant_relay") ? "RELAYED" : "NOT CAPTURED", simulated: false, surface: "assistant_relay", adapter_id: null, detail: on("assistant_relay") ? "best effort, never the person's own words; always asks you" : "learning is off for relayed corrections" });
    for (const k of KNOWN_RUNTIMES) out.push({ name: k.name, label: "NOT CAPTURED", simulated: false, surface: null, adapter_id: null, detail: k.note });
    return out;
  }

  /** A person sets a dead letter aside for good ("Discard"). Processing failures can be retried instead (LearningPipeline.retryDeadLetter). */
  discardDeadLetter(streamId: string, seq: number, actor: Actor): void {
    requireHuman(actor, "Discarding an unreadable event");
    run(this.db, "UPDATE capture_dead_letters SET resolved_at = ? WHERE stream_id = ? AND source_seq = ?", ts(this.clock.now()), streamId, seq);
  }
}
