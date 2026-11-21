/**
 * Capture adapter with a real durable outbox (the adapter side of docs/06 §11).
 *
 * This is the reference implementation of the adapter side of docs/06 §11: every
 * event is appended to a local outbox BEFORE delivery is attempted, and is removed
 * only when the service's cursor has passed it. On reconnect it says hello, learns
 * the cursor, and replays everything above it.
 *
 * It is not attached to any assistant runtime. Tests and the DEMO seed feed it in
 * process (paired as SIMULATED); the command line (`correction-layer capture ...`)
 * feeds it from a person or a script and delivers over the loopback HTTP API with
 * `HttpCaptureTransport` (paired by a person as a command-line adapter). It never
 * invents user turns: whatever calls `emit` vouches for the role.
 *
 * Backfill: events recovered from a runtime transcript are sent with
 * `delivery: "backfill"` and `attested_by: "runtime_transcript"`, so the intake and
 * the decision treat them as late, not the person's live words (capped at the inbox).
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

/** The same four operations over an asynchronous channel (the loopback HTTP API). */
export interface AsyncCaptureTransport {
  hello(input: { adapter_id: string; stream_id: string; session_id?: string; last_seq: number; binding_id?: string | null }): Promise<{ cursor: number }>;
  deliver(input: { adapter_id: string; stream_id: string; events: DeliveryItem[] }): Promise<{ results: DeliveryAck[]; cursor: number }>;
  heartbeat(input: { adapter_id: string; stream_id: string; last_seq: number }): Promise<{ cursor: number }>;
  close(input: { adapter_id: string; stream_id: string; final_seq: number }): Promise<{ cursor: number }>;
}

const LOOPBACK_URL = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;

/** Delivers to the local service over loopback HTTP. Refuses any non-loopback address: capture never leaves the machine. */
export class HttpCaptureTransport implements AsyncCaptureTransport {
  private base: string;
  constructor(baseUrl: string) {
    const base = baseUrl.replace(/\/+$/, "");
    if (!LOOPBACK_URL.test(base)) throw new Error(`the capture service must be a loopback http address (got ${baseUrl})`);
    this.base = base;
  }
  private async post<T>(op: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.base}/api/v1/capture/${op}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const json = (await res.json()) as any;
    if (!res.ok) throw new Error(`${json?.error?.code ?? res.status}: ${json?.error?.message ?? "request failed"}`);
    return json as T;
  }
  hello(input: Parameters<AsyncCaptureTransport["hello"]>[0]): Promise<{ cursor: number }> {
    return this.post("hello", input);
  }
  deliver(input: Parameters<AsyncCaptureTransport["deliver"]>[0]): Promise<{ results: DeliveryAck[]; cursor: number }> {
    return this.post("deliver", input);
  }
  heartbeat(input: Parameters<AsyncCaptureTransport["heartbeat"]>[0]): Promise<{ cursor: number }> {
    return this.post("heartbeat", input);
  }
  close(input: Parameters<AsyncCaptureTransport["close"]>[0]): Promise<{ cursor: number }> {
    return this.post("close", input);
  }
}

export type EmitInput = Pick<CaptureEvent, "kind" | "role" | "attested_by" | "occurred_at"> & {
  text?: string | null;
  language?: string;
  binding?: Partial<CaptureEvent["binding"]>;
};

interface OutboxEntry {
  event: CaptureEvent;
  attempts: number;
  backfill?: boolean;
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
        const entry = JSON.parse(line) as { event: CaptureEvent; backfill?: boolean } | { acked_through: number };
        if ("event" in entry) {
          this.outbox.push({ event: entry.event, attempts: 1, ...(entry.backfill ? { backfill: true } : {}) });
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

  /**
   * Recover a turn from a runtime transcript (AT-L3 backfill). It is marked as such
   * end to end: attested by the transcript, delivered as backfill. It never counts
   * as the person's live words.
   */
  backfill(input: Omit<EmitInput, "attested_by">): CaptureEvent {
    return this.emit({ ...input, attested_by: "runtime_transcript" }, true);
  }

  /** Write one event to the outbox. Nothing is delivered yet. */
  emit(input: EmitInput, backfill = false): CaptureEvent {
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
    this.outbox.push({ event, attempts: 0, ...(backfill ? { backfill: true } : {}) });
    this.persist(backfill ? { event, backfill: true } : { event });
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
    const events = this.batch();
    try {
      const ack = transport.deliver({ adapter_id: this.adapterId, stream_id: this.streamId, events });
      this.acknowledge(ack.cursor);
      return { delivered: true, cursor: ack.cursor, results: ack.results };
    } catch {
      this.connected = false;
      return { delivered: false, cursor, results: [] };
    }
  }

  private batch(): DeliveryItem[] {
    const events = this.outbox.map((o) => ({ event: o.event, delivery: (o.backfill ? "backfill" : o.attempts > 0 ? "replay" : "live") as DeliveryMode }));
    for (const o of this.outbox) o.attempts++;
    return events;
  }

  /** `flush` over an asynchronous transport (loopback HTTP). Same guarantees: nothing leaves the outbox until acknowledged. */
  async flushAsync(transport: AsyncCaptureTransport): Promise<{ delivered: boolean; cursor: number; results: DeliveryAck[]; error: string | null }> {
    let cursor = this.ackedThrough;
    if (!this.connected) {
      try {
        cursor = (await transport.hello({ adapter_id: this.adapterId, stream_id: this.streamId, last_seq: this.lastSeq, binding_id: this.bindingId, ...(this.sessionId ? { session_id: this.sessionId } : {}) })).cursor;
      } catch (error) {
        for (const o of this.outbox) o.attempts++;
        return { delivered: false, cursor: this.ackedThrough, results: [], error: error instanceof Error ? error.message : String(error) };
      }
      this.connected = true;
      this.acknowledge(cursor);
    }
    if (!this.outbox.length) return { delivered: true, cursor, results: [], error: null };
    try {
      const ack = await transport.deliver({ adapter_id: this.adapterId, stream_id: this.streamId, events: this.batch() });
      this.acknowledge(ack.cursor);
      return { delivered: true, cursor: ack.cursor, results: ack.results, error: null };
    } catch (error) {
      this.connected = false;
      return { delivered: false, cursor, results: [], error: error instanceof Error ? error.message : String(error) };
    }
  }

  async closeAsync(transport: AsyncCaptureTransport): Promise<{ cursor: number }> {
    return transport.close({ adapter_id: this.adapterId, stream_id: this.streamId, final_seq: this.lastSeq });
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
    writeFileSync(this.outboxPath, this.outbox.map((o) => JSON.stringify(o.backfill ? { event: o.event, backfill: true } : { event: o.event })).join("\n") + (this.outbox.length ? "\n" : ""));
  }
}
