/**
 * SIMULATED capture adapter with a real durable outbox.
 *
 * This is the reference implementation of the adapter side of docs/06 §11: every
 * event is appended to a local outbox BEFORE delivery is attempted, and is removed
 * only when the service's cursor has passed it. On reconnect it says hello, learns
 * the cursor, and replays everything above it.
 *
 * It is labelled simulated because it is not attached to any real assistant
 * runtime: tests, the DEMO seed and the CLI feed it events by hand. A real
 * runtime-hook adapter (Phase 2) reuses this class and replaces only the event
 * source. It never invents user turns: whatever calls `emit` vouches for the role.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomId } from "../domain/ids.ts";
import type { CaptureEvent, DeliveryMode } from "../domain/types.ts";
import type { DeliveryAck, DeliveryItem } from "./intake.ts";
import { contentDigest } from "./intake.ts";

/** The four capture operations, as an adapter sees them (in-process or over loopback HTTP). */
export interface CaptureTransport {
  hello(input: { adapter_id: string; stream_id: string; session_id?: string; last_seq: number; binding_id?: string | null }): { cursor: number };
  deliver(input: { adapter_id: string; stream_id: string; events: DeliveryItem[] }): { results: DeliveryAck[]; cursor: number };
  heartbeat(input: { adapter_id: string; stream_id: string; last_seq: number }): { cursor: number };
  close(input: { adapter_id: string; stream_id: string; final_seq: number }): { cursor: number };
}

export type EmitInput = Pick<CaptureEvent, "kind" | "role" | "attested_by" | "occurred_at"> & {
  text?: string | null;
  language?: string;
  binding?: Partial<CaptureEvent["binding"]>;
};

interface OutboxEntry {
  event: CaptureEvent;
  attempts: number;
}

export class LocalOutboxAdapter {
  readonly adapterId: string;
  readonly streamId: string;
  private outboxPath: string | null;
  private outbox: OutboxEntry[] = [];
  private lastSeq = 0;
  private bindingId: string | null;
  private sessionId: string | undefined;
  private connected = false;
  private ackedThrough = 0;

  /** `outboxPath: null` keeps the outbox in memory (tests that do not simulate an adapter crash). */
  constructor(opts: { adapter_id: string; stream_id: string; outbox_path: string | null; binding_id?: string | null; session_id?: string }) {
    this.adapterId = opts.adapter_id;
    this.streamId = opts.stream_id;
    this.outboxPath = opts.outbox_path;
    this.bindingId = opts.binding_id ?? null;
    this.sessionId = opts.session_id;
    if (this.outboxPath && existsSync(this.outboxPath)) {
      // Resume after an adapter crash: the outbox is the source of truth for what was emitted.
      for (const line of readFileSync(this.outboxPath, "utf8").split("\n").filter(Boolean)) {
        const entry = JSON.parse(line) as { event: CaptureEvent } | { acked_through: number };
        if ("event" in entry) {
          this.outbox.push({ event: entry.event, attempts: 1 });
          this.lastSeq = Math.max(this.lastSeq, entry.event.source_seq);
        } else this.outbox = this.outbox.filter((o) => o.event.source_seq > entry.acked_through);
      }
    }
  }

  get lastSequence(): number {
    return this.lastSeq;
  }

  get pending(): number {
    return this.outbox.length;
  }

  private persist(line: unknown): void {
    if (!this.outboxPath) return;
    mkdirSync(dirname(this.outboxPath), { recursive: true });
    appendFileSync(this.outboxPath, JSON.stringify(line) + "\n");
  }

  /** Write one event to the outbox. Nothing is delivered yet. */
  emit(input: EmitInput): CaptureEvent {
    const sendsText = input.kind === "user_turn" || input.kind === "review_action" || input.kind === "edit_observed";
    const text = sendsText ? (input.text ?? null) : null;
    const event: CaptureEvent = {
      schema_version: "cl.capture_event/1", capture_id: randomId("cap"), adapter_id: this.adapterId, stream_id: this.streamId, source_seq: ++this.lastSeq,
      kind: input.kind, occurred_at: input.occurred_at, role: input.role, attested_by: input.attested_by,
      binding: { binding_id: input.binding?.binding_id ?? this.bindingId, project_id: input.binding?.project_id ?? null, ...(input.binding?.artifact_id ? { artifact_id: input.binding.artifact_id } : {}), ...(input.binding?.content_hash ? { content_hash: input.binding.content_hash } : {}) },
      // Agent and tool output is sent as a digest only; its text never leaves the runtime.
      content: sendsText && text !== null ? { text, language: input.language ?? "en" } : null,
      content_state: sendsText && text !== null ? "present" : "not_sent",
      content_digest: contentDigest(sendsText ? text : (input.text ?? "")),
      ...(input.kind === "heartbeat" || input.kind === "session_end" ? { final_seq: this.lastSeq } : {}),
    };
    this.outbox.push({ event, attempts: 0 });
    this.persist({ event });
    return event;
  }

  /**
   * Say hello, then deliver everything above the service's cursor in one batch.
   * Returns false (and keeps everything) if the service cannot be reached.
   */
  flush(transport: CaptureTransport): { delivered: boolean; cursor: number; results: DeliveryAck[] } {
    let cursor = this.ackedThrough;
    if (!this.connected) {
      // (Re)connect: learn the service's cursor, then replay everything above it.
      try {
        cursor = transport.hello({ adapter_id: this.adapterId, stream_id: this.streamId, last_seq: this.lastSeq, binding_id: this.bindingId, ...(this.sessionId ? { session_id: this.sessionId } : {}) }).cursor;
      } catch {
        for (const o of this.outbox) o.attempts++;
        return { delivered: false, cursor: this.ackedThrough, results: [] };
      }
      this.connected = true;
      this.acknowledge(cursor);
    }
    if (!this.outbox.length) return { delivered: true, cursor, results: [] };
    const events = this.outbox.map((o) => ({ event: o.event, delivery: (o.attempts > 0 ? "replay" : "live") as DeliveryMode }));
    for (const o of this.outbox) o.attempts++;
    try {
      const ack = transport.deliver({ adapter_id: this.adapterId, stream_id: this.streamId, events });
      this.acknowledge(ack.cursor);
      return { delivered: true, cursor: ack.cursor, results: ack.results };
    } catch {
      this.connected = false;
      return { delivered: false, cursor, results: [] };
    }
  }

  /** Remove from the outbox only what the cursor has passed. */
  private acknowledge(cursor: number): void {
    this.ackedThrough = Math.max(this.ackedThrough, cursor);
    const before = this.outbox.length;
    this.outbox = this.outbox.filter((o) => o.event.source_seq > cursor);
    if (this.outbox.length !== before) this.persist({ acked_through: cursor });
  }

  close(transport: CaptureTransport): { cursor: number } {
    return transport.close({ adapter_id: this.adapterId, stream_id: this.streamId, final_seq: this.lastSeq });
  }

  /** Compact the outbox file (optional housekeeping). */
  compact(): void {
    if (!this.outboxPath) return;
    writeFileSync(this.outboxPath, this.outbox.map((o) => JSON.stringify({ event: o.event })).join("\n") + (this.outbox.length ? "\n" : ""));
  }
}
