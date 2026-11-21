/**
 * Capture usability (docs/06 §11, docs/12 §4): the registry of unconnected apps
 * (AT-L6), the command-line outbox adapter over loopback HTTP with service and
 * adapter restarts, transcript backfill capped at the inbox (AT-L3 backfill),
 * gap acknowledgement and dead-letter retry. Hermetic: temp files, loopback port 0.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { startServer } from "../src/api/server.ts";
import { createApp } from "../src/app.ts";
import { contentDigest } from "../src/capture/intake.ts";
import { HttpCaptureTransport, LocalOutboxAdapter } from "../src/capture/local-adapter.ts";
import { KNOWN_RUNTIMES } from "../src/capture/registry.ts";
import { PermissionDenied } from "../src/domain/errors.ts";
import { FixedClock } from "../src/domain/time.ts";
import type { CaptureEvent } from "../src/domain/types.ts";
import { get } from "../src/store/db.ts";
import type { TestApp } from "./helpers.ts";
import { draftAndCorrect, quote, scenario, T0, tmpDir } from "./helpers.ts";

const SGD = "No, Kestrel's quotes must always be in SGD.";
const agent = { kind: "agent" as const, id: "agt_ASSIST01", display_name: "assistant" };
const n = (app: TestApp, sql: string, ...p: unknown[]): number => get<{ n: number }>(app.db, sql, ...p)!.n;

test("AT-L6: every known place a correction might be made has exactly one label; unconnected apps are NOT CAPTURED by name", () => {
  const off = scenario(null);
  const labels = off.app.intake.surfaceLabels(off.project.project_id);
  for (const k of KNOWN_RUNTIMES) assert.equal(labels.find((l) => l.name === k.name)?.label, "NOT CAPTURED", k.name);
  assert.equal(labels.find((l) => l.surface === "app")?.label, "NOT CAPTURED", "learning off: not even the app captures");
  assert.equal(labels.find((l) => l.adapter_id === "adp_TURNHOOK")?.label, "NOT CAPTURED");
  const on = scenario("auto_low_risk", { name: "On (TEST)" });
  const labelsOn = on.app.intake.surfaceLabels(on.project.project_id);
  assert.equal(labelsOn.find((l) => l.surface === "app")?.label, "CAPTURED");
  assert.deepEqual([labelsOn.find((l) => l.adapter_id === "adp_TURNHOOK")?.label, labelsOn.find((l) => l.adapter_id === "adp_TURNHOOK")?.simulated], ["CAPTURED", true]);
  assert.equal(labelsOn.find((l) => l.surface === "assistant_relay")?.label, "RELAYED");
  assert.ok(labelsOn.filter((l) => l.surface === null).every((l) => l.label === "NOT CAPTURED"), "learning on changes nothing for apps without an adapter");
  // A correction "typed in ChatGPT" never reaches the product: there is no path for it. A relay reaches the inbox at most.
  const relayed = on.app.learning.relay({ project_id: on.project.project_id, text: "The user said quotes must always be in SGD", agent });
  assert.equal(relayed.status, "inbox");
  assert.equal(on.app.rules.listAll().length, 0);
});

test("command-line outbox adapter over loopback HTTP: service down, adapter crash, service restart - nothing lost, nothing doubled", async () => {
  const dir = tmpDir();
  const clock = new FixedClock(T0);
  const open = (): TestApp => createApp({ dbPath: join(dir, "workspace.db"), clock, workspaceId: "ws_TEST0001", localUserId: "usr_MARCUS01" }) as TestApp;
  assert.throws(() => new HttpCaptureTransport("http://192.168.1.10:4319"), /loopback/, "capture never leaves the machine");

  let app = open();
  const s = scenario("auto_low_risk", { app });
  app.intake.pairAdapter({ adapter_id: "adp_CLIOUTBX", kind: "runtime_hook", label: "Command-line outbox (TEST)", simulated: false, attests_user_turns: true, durable_outbox: true, supports_replay: true, supports_backfill: true }, s.priya);
  let server = await startServer(app, { host: "127.0.0.1", port: 0 });
  const port = server.port;
  const outbox = join(dir, "outbox.jsonl");
  let adapter = new LocalOutboxAdapter({ adapter_id: "adp_CLIOUTBX", stream_id: "str_CLIHTTP001", outbox_path: outbox, binding_id: s.bindingId });
  const draft = app.checks.observe({ project_id: s.project.project_id, name: "Kestrel-Supply-Quote.md", bytes: quote({ currency: "USD" }) });
  adapter.emit({ kind: "agent_output", role: "agent", attested_by: "runtime_hook", occurred_at: T0, text: "draft", binding: { artifact_id: draft.artifact_id, content_hash: draft.content_hash } });
  adapter.emit({ kind: "user_turn", role: "user", attested_by: "runtime_hook", occurred_at: T0, text: SGD });
  let out = await adapter.flushAsync(new HttpCaptureTransport(server.url));
  assert.deepEqual([out.delivered, out.cursor, out.results.map((r) => r.result)], [true, 2, ["accepted", "accepted"]]);
  assert.equal(n(app, "SELECT COUNT(*) AS n FROM signals"), 1);

  // The service stops. The person keeps typing; the adapter keeps everything in its outbox file.
  await server.close();
  app.close();
  adapter.emit({ kind: "user_turn", role: "user", attested_by: "runtime_hook", occurred_at: T0, text: "Please also tidy the intro." });
  adapter.emit({ kind: "user_turn", role: "user", attested_by: "runtime_hook", occurred_at: T0, text: SGD });
  out = await adapter.flushAsync(new HttpCaptureTransport(`http://127.0.0.1:${port}`));
  assert.equal(out.delivered, false);
  assert.equal(adapter.pending, 2);
  // The adapter crashes too: a new process reads the same outbox file.
  adapter = new LocalOutboxAdapter({ adapter_id: "adp_CLIOUTBX", stream_id: "str_CLIHTTP001", outbox_path: outbox, binding_id: s.bindingId });
  assert.deepEqual([adapter.pending, adapter.lastSequence], [2, 4]);

  // The service restarts from its store. The adapter replays; the cursor catches up; a repeat is a duplicate.
  app = open();
  server = await startServer(app, { host: "127.0.0.1", port: 0 });
  out = await adapter.flushAsync(new HttpCaptureTransport(server.url));
  assert.deepEqual([out.delivered, out.cursor, out.results.map((r) => r.result)], [true, 4, ["accepted", "accepted"]]);
  assert.deepEqual(app.intake.deliveries("str_CLIHTTP001").slice(-2).map((d) => d.delivery), ["replay", "replay"]);
  const again = await new HttpCaptureTransport(server.url).deliver({ adapter_id: "adp_CLIOUTBX", stream_id: "str_CLIHTTP001", events: [{ event: readFileSync(outbox, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((e: any) => e.event?.source_seq === 2).event, delivery: "replay" }] });
  assert.equal(again.results[0]!.result, "duplicate");
  assert.equal(n(app, "SELECT COUNT(*) AS n FROM signals"), 2, "two corrections typed, two signals; the repeat added nothing");
  assert.equal(app.rules.listAll().length, 1, "the same requirement said twice is one candidate");
  // An unpaired adapter is refused over HTTP.
  await assert.rejects(new HttpCaptureTransport(server.url).hello({ adapter_id: "adp_NOTPAIRED", stream_id: "str_X0000001", last_seq: 0 }), /adapter_not_paired/);
  assert.equal(app.ledger.verify().ok, true);
  await server.close();
  app.close();
});

test("AT-L3 (backfill): turns recovered from a transcript are marked as backfill and reach the inbox at most", () => {
  const s = scenario("auto_low_risk");
  const draft = s.app.checks.observe({ project_id: s.project.project_id, name: "Kestrel-Supply-Quote.md", bytes: quote({ currency: "USD" }) });
  s.adapter.backfill({ kind: "agent_output", role: "agent", occurred_at: T0, text: "draft", binding: { artifact_id: draft.artifact_id, content_hash: draft.content_hash } });
  s.adapter.backfill({ kind: "user_turn", role: "user", occurred_at: T0, text: SGD });
  const out = s.adapter.flush(s.app.intake);
  assert.deepEqual(out.results.map((r) => r.result), ["accepted", "accepted"]);
  assert.deepEqual(s.app.intake.deliveries(s.adapter.streamId).map((d) => d.delivery), ["backfill", "backfill"]);
  // Even with the corrected version present, nothing turns on by itself.
  s.app.checks.observe({ project_id: s.project.project_id, name: "Kestrel-Supply-Quote.md", bytes: quote({ currency: "SGD" }) });
  const d = s.app.learning.decisions(s.project.project_id)[0]!;
  assert.equal(d.outcome, "inbox");
  assert.ok(d.reasons.includes("captured_late") && d.reasons.includes("no_direct_statement"), d.reasons.join(","));
  assert.equal(d.signals[0].trust, "assistant_relayed", "a transcript is never the person's own words");
  assert.ok(s.app.rules.listAll().every((r) => r.status === "candidate"));
});

test("a gap a person acknowledges as lost lets held events through in order, stays visible, and blocks automation for its episode", () => {
  const s = scenario("auto_low_risk");
  const stream = "str_GAPACK0001";
  s.app.intake.hello({ adapter_id: "adp_TURNHOOK", stream_id: stream, last_seq: 4, binding_id: s.bindingId });
  const draft = s.app.checks.observe({ project_id: s.project.project_id, name: "Kestrel-Supply-Quote.md", bytes: quote({ currency: "USD" }) });
  const ev = (seq: number, kind: CaptureEvent["kind"], text: string | null, binding: Partial<CaptureEvent["binding"]> = {}): CaptureEvent => ({
    schema_version: "cl.capture_event/1", capture_id: `cap_GAPACK000${seq}`, adapter_id: "adp_TURNHOOK", stream_id: stream, source_seq: seq, kind, occurred_at: T0,
    role: kind === "agent_output" ? "agent" : "user", attested_by: "runtime_hook", binding: { binding_id: s.bindingId, project_id: null, ...binding },
    content: kind === "user_turn" ? { text: text!, language: "en" } : null, content_state: kind === "user_turn" ? "present" : "not_sent", content_digest: contentDigest(text),
  });
  // Events 1 and 2 never arrive (the adapter lost them); 3 and 4 do.
  s.app.intake.deliver({ adapter_id: "adp_TURNHOOK", stream_id: stream, events: [{ event: ev(3, "agent_output", null, { artifact_id: draft.artifact_id, content_hash: draft.content_hash }) }, { event: ev(4, "user_turn", SGD) }] });
  assert.equal(s.app.intake.stream(stream).acked_through, 0, "the cursor never passes a missing event on its own");
  assert.equal(n(s.app, "SELECT COUNT(*) AS n FROM signals"), 0);
  assert.throws(() => s.app.intake.acknowledgeGap(stream, 1, agent), PermissionDenied);
  s.app.intake.acknowledgeGap(stream, 1, s.marcus);
  const state = s.app.intake.stream(stream);
  assert.equal(state.acked_through, 4, "held events are admitted, in order");
  assert.equal(state.health, "gap");
  assert.match(state.health_reason, /were lost; .* acknowledged it/);
  assert.equal(state.gaps[0]!.acknowledged_by, s.marcus.id, "the gap stays visible");
  assert.ok(!s.app.ledger.all().some((e) => e.type === "capture.gap_closed"), "never reported as 'nothing was lost'");
  // The correction after the loss is processed, but its episode is incomplete: nothing turns on by itself.
  s.app.checks.observe({ project_id: s.project.project_id, name: "Kestrel-Supply-Quote.md", bytes: quote({ currency: "SGD" }) });
  const d = s.app.learning.decisions(s.project.project_id)[0]!;
  assert.ok(d.reasons.includes("capture_incomplete"), d.reasons.join(","));
  assert.notEqual(d.outcome, "auto_activate");
  // A lost event that turns up after all is set aside visibly, never processed.
  const late = s.app.intake.deliver({ adapter_id: "adp_TURNHOOK", stream_id: stream, events: [{ event: ev(2, "user_turn", "Always use EUR."), delivery: "replay" }] });
  assert.equal(late.results[0]!.result, "dead_letter");
  assert.equal(n(s.app, "SELECT COUNT(*) AS n FROM signals"), 1);
});

test("a person retries an event whose processing failed; it is processed once, and the dead letter is resolved", () => {
  const s = scenario("auto_low_risk");
  draftAndCorrect(s, SGD);
  let broken = true;
  s.app.learning.beforeProcess = () => {
    if (broken) throw new Error("the detector was misconfigured");
  };
  s.adapter.flush(s.app.intake);
  for (let i = 0; i < 8; i++) s.app.learning.tick();
  const state = s.app.intake.stream(s.adapter.streamId);
  assert.equal(state.dead_letters.length, 3, "all three events set aside after their retries");
  broken = false;
  assert.throws(() => s.app.learning.retryDeadLetter(s.adapter.streamId, 3, agent), PermissionDenied);
  for (const seq of [1, 2, 3]) assert.equal(s.app.learning.retryDeadLetter(s.adapter.streamId, seq, s.marcus).retried, true);
  assert.equal(s.app.intake.stream(s.adapter.streamId).dead_letters.length, 0);
  assert.equal(s.app.intake.stream(s.adapter.streamId).health, "healthy");
  assert.equal(n(s.app, "SELECT COUNT(*) AS n FROM signals"), 1);
  assert.throws(() => s.app.learning.retryDeadLetter(s.adapter.streamId, 3, s.marcus), /was not found/, "a resolved dead letter cannot be retried twice");
});
