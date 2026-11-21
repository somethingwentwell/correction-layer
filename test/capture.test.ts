import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../src/app.ts";
import { contentDigest } from "../src/capture/intake.ts";
import { LocalOutboxAdapter } from "../src/capture/local-adapter.ts";
import type { CaptureTransport } from "../src/capture/local-adapter.ts";
import { PermissionDenied } from "../src/domain/errors.ts";
import { FixedClock } from "../src/domain/time.ts";
import type { CaptureEvent } from "../src/domain/types.ts";
import { all, get } from "../src/store/db.ts";
import type { Scenario } from "./helpers.ts";
import { draftAndCorrect, fixture, makeApp, quote, scenario, T0, tmpDir } from "./helpers.ts";

const SGD = "No, Kestrel's quotes must always be in SGD.";
const turn = (s: Scenario, text: string, extra: Partial<Parameters<LocalOutboxAdapter["emit"]>[0]> = {}): CaptureEvent =>
  s.adapter.emit({ kind: "user_turn", role: "user", attested_by: "runtime_hook", occurred_at: T0, text, ...extra });
const counts = (s: Scenario) => ({
  signals: get<{ n: number }>(s.app.db, "SELECT COUNT(*) AS n FROM signals")!.n,
  candidates: get<{ n: number }>(s.app.db, "SELECT COUNT(*) AS n FROM learning_candidates")!.n,
  rules: s.app.rules.listAll().length,
});

test("AT-L4: the design's capture stream replays to its recorded results and cursors (duplicate, out-of-order, dead letter)", () => {
  const example = fixture("examples/learning/capture-stream.json");
  const app = makeApp({ workspaceId: example.workspace_id });
  const marcus = app.localUser;
  const priya = app.projects.ensurePerson("usr_PRIYA001", "Priya Nair (test)");
  app.projects.createProject({ project_id: example.project_id, name: "Kestrel (TEST replay of the design fixture)", default_work_type: "sales_proposal" }, marcus);
  app.projects.registerFolder(example.project_id, "/test/kestrel", marcus, "fld_KESTREL01");
  app.policies.set({ project_id: example.project_id, mode: "auto_low_risk", learn_from: [priya.id, marcus.id] }, marcus);
  app.intake.pairAdapter({ adapter_id: example.adapter.adapter_id, kind: "runtime_hook", label: "fixture adapter (SIMULATED)", simulated: true, attests_user_turns: true, durable_outbox: true, supports_replay: true, supports_backfill: false }, priya);
  app.intake.hello({ adapter_id: example.adapter.adapter_id, stream_id: example.stream_id, session_id: example.session_id, last_seq: 0, binding_id: "fld_KESTREL01" });
  // The fixture's digests are illustrative labels; this build defines content_digest as sha256 of the text.
  const bySeq = new Map<number, any>(example.events.map((e: any) => [e.source_seq, { ...e, content_digest: e.content ? contentDigest(e.content.text) : e.content_digest }]));
  for (const d of example.deliveries) {
    // Sequence 7 is the fixture's unreadable event: a kind this build does not know.
    const event = bySeq.get(d.source_seq) ?? { schema_version: "cl.capture_event/1", capture_id: d.capture_id, adapter_id: example.adapter.adapter_id, stream_id: example.stream_id, source_seq: d.source_seq, kind: "screen_recording", content_digest: d.content_digest };
    const ack = app.intake.deliver({ adapter_id: example.adapter.adapter_id, stream_id: example.stream_id, events: [{ event, delivery: d.delivery }] });
    assert.deepEqual([ack.results[0]!.result, ack.results[0]!.ack_through, ack.results[0]!.validation], [d.result, d.ack_through, d.intake_validation], `arrival ${d.arrival} (seq ${d.source_seq})`);
  }
  app.intake.close({ adapter_id: example.adapter.adapter_id, stream_id: example.stream_id, final_seq: 9 });
  const state = app.intake.stream(example.stream_id);
  assert.equal(state.acked_through, example.state.acked_through);
  assert.equal(state.status, example.state.status);
  assert.equal(state.health, example.state.health, "a stream with a dead letter is not healthy");
  assert.equal(state.duplicates_dropped, example.state.duplicates_dropped);
  assert.equal(state.held_out_of_order, example.state.held_out_of_order);
  assert.deepEqual(state.dead_letters.map((d) => [d.source_seq, d.reason]), example.state.dead_letters.map((d: any) => [d.source_seq, d.reason]));
  assert.deepEqual(state.gaps.map((g) => [g.from_seq, g.to_seq, g.closed_at !== null]), [[4, 4, true]], "the gap opened by the early arrival was closed by replay");
  assert.deepEqual(app.intake.deliveries(example.stream_id).map((d) => d.result), example.deliveries.map((d: any) => d.result), "every attempt is logged in arrival order");
  // Processed strictly in sequence order although 5 arrived before 4; the one-off in 4 is honoured.
  const pipeline = all<any>(app.db, "SELECT source_seq, stage, disposition FROM capture_events WHERE kind = 'user_turn' ORDER BY source_seq");
  const recorded = example.pipeline.map((p: any) => [p.source_seq, p.reached, p.disposition]);
  assert.deepEqual(pipeline.slice(0, 3).map((p) => [p.source_seq, p.stage, p.disposition]), recorded.slice(0, 3));
  // KNOWN DEVIATION (HANDOFF.md, "repair requests"): the fixture treats sequence 6 ("Row 2 should be in SGD,
  // please fix it") as a repair request against an open finding of an existing rule, so not a signal. Phase 1
  // does not link turns to open findings; it errs toward a person: identified, not compiled, asked in the inbox.
  assert.deepEqual(recorded[3], [6, "captured", "not_a_signal"]);
  assert.deepEqual([pipeline[3].source_seq, pipeline[3].stage, pipeline[3].disposition], [6, "identified", "waiting_for_person"]);
  const signalOrder = all<any>(app.db, "SELECT c.source_seq FROM signals s JOIN capture_events c ON c.capture_id = s.capture_id ORDER BY s.rowid").map((r) => r.source_seq);
  assert.deepEqual(signalOrder, [4, 5, 6]);
  assert.equal(app.rules.listAll().length, 0, "nothing in this stream compiles to a rule");
  // A repeat with a different digest is refused and the stream is flagged.
  const conflict = app.intake.deliver({ adapter_id: example.adapter.adapter_id, stream_id: example.stream_id, events: [{ event: { ...bySeq.get(4), content: { text: "Always quote in USD.", language: "en" }, content_digest: contentDigest("Always quote in USD.") } }] });
  assert.equal(conflict.results[0]!.result, "rejected_conflict");
  assert.match(app.intake.stream(example.stream_id).integrity_flag ?? "", /digest conflict at sequence 4/);
  assert.equal(get<any>(app.db, "SELECT content_text FROM capture_events WHERE source_seq = 4")!.content_text, "Use the supply quote's layout for this one.", "nothing from the conflicting event is used");
});

test("AT-L1 lost connection: events wait in the adapter's outbox, replay in order, and a correction among them is processed as if live", () => {
  const s = scenario("auto_low_risk");
  const { app } = s;
  for (const n of [1, 2]) app.checks.observe({ project_id: s.project.project_id, name: `Earlier-${n}.md`, bytes: quote({ currency: "SGD", total: `${n}1,000.00` }) });
  const anchor = draftAndCorrect(s, "Please draft the quote."); // session_start, agent_output, a request
  assert.equal(s.adapter.flush(app.intake).cursor, 3);
  // The service becomes unreachable while the person types three messages.
  const down: CaptureTransport = { hello: () => { throw new Error("ECONNREFUSED"); }, deliver: () => { throw new Error("ECONNREFUSED"); }, heartbeat: () => { throw new Error("x"); }, close: () => { throw new Error("x"); } };
  turn(s, "Looks better.");
  turn(s, SGD);
  turn(s, "Thanks.");
  assert.equal(s.adapter.flush(down).delivered, false);
  assert.equal(s.adapter.pending, 3, "nothing is dropped because the service was absent");
  assert.equal(app.intake.stream(s.adapter.streamId).acked_through, 3);
  // The connection returns.
  const back = s.adapter.flush(app.intake);
  assert.deepEqual(back.results.map((r) => [r.source_seq, r.result]), [[4, "accepted"], [5, "accepted"], [6, "accepted"]]);
  assert.equal(back.cursor, s.adapter.lastSequence, "the cursor equals the adapter's last sequence number");
  assert.equal(s.adapter.pending, 0);
  const state = app.intake.stream(s.adapter.streamId);
  assert.equal(state.health, "healthy");
  assert.deepEqual(state.gaps.map((g) => [g.from_seq, g.to_seq, g.closed_at !== null]), [[4, 6, true]], "capture health records a gap that was closed");
  assert.deepEqual(app.intake.deliveries(s.adapter.streamId).slice(-3).map((d) => d.delivery), ["replay", "replay", "replay"]);
  // Exactly as if delivered live: complete capture, not late, so evidence is the only thing missing.
  const signal = get<any>(app.db, "SELECT record_json FROM signals")!;
  assert.deepEqual(JSON.parse(signal.record_json).capture, { stream_id: s.adapter.streamId, capture_ids: [get<any>(app.db, "SELECT capture_id FROM capture_events WHERE source_seq = 5")!.capture_id], source_seqs: [5], delivery: "replay", late: false, episode_capture_complete: true });
  app.checks.observe({ project_id: s.project.project_id, name: "Kestrel-Supply-Quote.md", bytes: quote({ currency: "SGD" }) });
  assert.equal(app.learning.decisions(s.project.project_id)[0]!.outcome, "auto_activate");
  void anchor;
});

test("AT-L2 service restart: an event stored but not acknowledged is re-sent, acknowledged as a duplicate, and creates exactly one signal, candidate and rule", () => {
  const dir = tmpDir();
  const open = () => createApp({ dbPath: join(dir, "workspace.db"), signingKeyPath: join(dir, "key.pem"), clock: new FixedClock(T0), workspaceId: "ws_TEST0001", localUserId: "usr_MARCUS01", localUserName: "Marcus Lim (test)" }) as ReturnType<typeof makeApp>;
  const first = scenario("auto_low_risk", { app: open(), outboxPath: join(dir, "outbox.jsonl"), streamId: "str_RESTART001" });
  draftAndCorrect(first, SGD);
  // The service stores the batch, then dies before the adapter sees the acknowledgement.
  let stored = 0;
  const dying: CaptureTransport = {
    hello: (i) => first.app.intake.hello(i),
    deliver: (i) => { stored = first.app.intake.deliver(i).cursor; throw new Error("connection reset before the acknowledgement arrived"); },
    heartbeat: (i) => first.app.intake.heartbeat(i), close: (i) => first.app.intake.close(i),
  };
  assert.equal(first.adapter.flush(dying).delivered, false);
  assert.equal(stored, 3, "the service did store them");
  assert.equal(first.adapter.pending, 3, "the adapter keeps what was not acknowledged");
  assert.deepEqual(counts(first), { signals: 1, candidates: 1, rules: 1 });
  first.app.close();

  // Restart: a new process, the same store; a new adapter process, the same outbox file.
  const app = open();
  const adapter = new LocalOutboxAdapter({ adapter_id: "adp_TURNHOOK", stream_id: "str_RESTART001", outbox_path: join(dir, "outbox.jsonl"), binding_id: first.bindingId });
  assert.equal(adapter.pending, 3, "the outbox survived the adapter restart");
  const again = adapter.flush(app.intake);
  assert.equal(again.delivered, true);
  assert.equal(again.cursor, 3);
  assert.equal(adapter.pending, 0, "the cursor had already passed them: nothing needed re-sending");
  // Force the re-send anyway (an adapter that never saw the cursor): acknowledged as duplicates, nothing reprocessed.
  const resend = app.intake.deliver({ adapter_id: "adp_TURNHOOK", stream_id: "str_RESTART001", events: all<any>(app.db, "SELECT * FROM capture_events ORDER BY source_seq").map((e) => ({ event: { source_seq: e.source_seq, stream_id: e.stream_id, capture_id: e.capture_id, content_digest: e.content_digest }, delivery: "replay" as const })) });
  assert.deepEqual(resend.results.map((r) => r.result), ["duplicate", "duplicate", "duplicate"]);
  app.learning.tick();
  const restarted = { ...first, app };
  assert.deepEqual(counts(restarted), { signals: 1, candidates: 1, rules: 1 }, "exactly one signal, one candidate, one rule");
  assert.equal(app.intake.stream("str_RESTART001").duplicates_dropped, 3);
  assert.equal(app.ledger.verify().ok, true);
  app.close();
});

test("a crash between receiving and processing loses nothing: unprocessed events are picked up on restart", () => {
  const dir = tmpDir();
  const open = () => createApp({ dbPath: join(dir, "workspace.db"), clock: new FixedClock(T0), workspaceId: "ws_TEST0001", localUserId: "usr_MARCUS01" }) as ReturnType<typeof makeApp>;
  const s = scenario("auto_low_risk", { app: open(), streamId: "str_CRASH00001" });
  draftAndCorrect(s, SGD);
  s.app.learning.beforeProcess = () => { throw new Error("simulated crash while processing"); };
  s.adapter.flush(s.app.intake);
  assert.equal(s.app.intake.stream("str_CRASH00001").acked_through, 3, "received and acknowledged");
  assert.equal(s.app.intake.stream("str_CRASH00001").processed_through, 0, "not yet processed");
  assert.equal(counts(s).signals, 0, "the failed attempt left nothing behind");
  s.app.close();
  const app = open(); // startup runs the processing stage again
  assert.equal(app.intake.stream("str_CRASH00001").processed_through, 3);
  assert.equal(get<{ n: number }>(app.db, "SELECT COUNT(*) AS n FROM signals")!.n, 1);
  app.close();
});

test("failure, retry, dead-letter: a poison event is retried, then set aside visibly; the stream moves on", () => {
  const s = scenario("auto_low_risk");
  draftAndCorrect(s, "Always put the total in SGD.");
  turn(s, SGD);
  let failures = 0;
  s.app.learning.beforeProcess = (captureId) => {
    const row = get<any>(s.app.db, "SELECT source_seq FROM capture_events WHERE capture_id = ?", captureId)!;
    if (row.source_seq === 3) { failures++; throw new Error("cannot process this event"); }
  };
  s.adapter.flush(s.app.intake);
  assert.equal(s.app.intake.stream(s.adapter.streamId).processed_through, 2, "held at the failing event; it will be retried");
  s.app.learning.tick();
  s.app.learning.tick();
  assert.equal(failures, 3);
  const state = s.app.intake.stream(s.adapter.streamId);
  assert.equal(state.processed_through, 4, "after 3 attempts the event is dead-lettered and the stream continues");
  assert.deepEqual(state.dead_letters.map((d) => [d.source_seq, d.stage, d.reason]), [[3, "processing", "cannot process this event"]]);
  assert.equal(state.health, "degraded");
  assert.equal(counts(s).signals, 1, "the event after the poison one was still processed, once");
  assert.ok(s.app.ledger.all().some((e) => e.type === "capture.dead_lettered" && e.payload?.stage === "processing"));
  s.app.intake.discardDeadLetter(s.adapter.streamId, 3, s.marcus);
  assert.equal(s.app.intake.stream(s.adapter.streamId).health, "healthy");
});

test("intake validation: unpaired or revoked adapters are refused; malformed and role-forged events are dead-lettered, never processed", () => {
  const s = scenario("auto_low_risk");
  const { app } = s;
  const base = (seq: number, over: Record<string, unknown> = {}) => ({
    schema_version: "cl.capture_event/1", capture_id: `cap_TEST${String(seq).padStart(6, "0")}`, adapter_id: "adp_TURNHOOK", stream_id: "str_VALIDATE01", source_seq: seq, kind: "user_turn", occurred_at: T0,
    role: "user", attested_by: "runtime_hook", binding: { binding_id: s.bindingId, project_id: null }, content: { text: SGD, language: "en" }, content_state: "present", content_digest: contentDigest(SGD), ...over,
  });
  assert.throws(() => app.intake.hello({ adapter_id: "adp_UNKNOWN01", stream_id: "str_VALIDATE01", last_seq: 0 }), PermissionDenied);
  app.intake.hello({ adapter_id: "adp_TURNHOOK", stream_id: "str_VALIDATE01", last_seq: 0, binding_id: s.bindingId });
  assert.throws(() => app.intake.deliver({ adapter_id: "adp_UNKNOWN01", stream_id: "str_VALIDATE01", events: [{ event: base(1) }] }), PermissionDenied);
  const deliver = (event: unknown) => app.intake.deliver({ adapter_id: "adp_TURNHOOK", stream_id: "str_VALIDATE01", events: [{ event }] }).results[0]!;
  // Tool or agent output dressed up as the person's words; text smuggled in as agent output; a wrong digest; a foreign adapter id.
  assert.deepEqual([deliver(base(1, { kind: "tool_output", role: "user" })).result, deliver(base(2, { role: "agent" })).result], ["dead_letter", "dead_letter"]);
  assert.equal(deliver(base(3, { kind: "agent_output", role: "agent" })).result, "dead_letter", "agent output must be a digest only");
  assert.equal(deliver(base(4, { content_digest: contentDigest("something else") })).result, "dead_letter");
  assert.equal(deliver(base(5, { adapter_id: "adp_OTHER0001" })).result, "dead_letter");
  assert.equal(deliver({ kind: "user_turn", stream_id: "str_VALIDATE01" }).result, "dead_letter", "no sequence number: cannot be placed");
  assert.equal(deliver(base(6, { kind: "telepathy" })).validation, "unsupported_event_kind");
  // Unattested text: nobody vouches for who typed it, so its content is not kept and it is never a signal.
  assert.equal(deliver(base(7, { attested_by: "none" })).result, "consent_blocked");
  assert.equal(get<any>(app.db, "SELECT content_text FROM capture_events WHERE source_seq = 7")!.content_text, null);
  assert.deepEqual(counts(s), { signals: 0, candidates: 0, rules: 0 });
  assert.equal(app.intake.stream("str_VALIDATE01").acked_through, 7, "dead letters do not stall the cursor");
  assert.equal(app.intake.stream("str_VALIDATE01").health, "degraded");
  app.intake.revokeAdapter("adp_TURNHOOK", s.marcus);
  assert.throws(() => deliver(base(8)), /revoked/);
  assert.throws(() => app.intake.pairAdapter({ kind: "runtime_hook", label: "x", simulated: true, attests_user_turns: true, durable_outbox: true, supports_replay: true, supports_backfill: false }, { kind: "agent", id: "agt_ASSIST01" }), /done by a person/);
});

test("AT-L5 project switch: each event is bound to its own project; consent is per project; nothing leaks across", () => {
  const a = scenario("auto_low_risk", { name: "Project A (TEST)", folder: "/test/a", streamId: "str_SWITCH0001" });
  const { app } = a;
  const b = app.projects.createProject({ name: "Project B (TEST)", default_work_type: "sales_proposal" }, a.marcus);
  const bBinding = app.projects.registerFolder(b.project_id, "/test/b", a.marcus);
  const draftA = app.checks.observe({ project_id: a.project.project_id, name: "A.md", bytes: quote({ currency: "USD" }) });
  const hook = { attested_by: "runtime_hook" as const, occurred_at: T0 };
  a.adapter.emit({ kind: "session_start", role: "system", ...hook });
  a.adapter.emit({ kind: "agent_output", role: "agent", ...hook, text: "draft", binding: { artifact_id: draftA.artifact_id, content_hash: draftA.content_hash } });
  // The session moves to project B's folder, where learning is OFF, and the person gives a standing instruction there.
  a.adapter.emit({ kind: "session_start", role: "system", ...hook, binding: { binding_id: bBinding } });
  turn(a, "Always quote this customer in SGD.", { binding: { binding_id: bBinding } });
  turn(a, "From now on every quote must be in SGD."); // no binding of its own... the adapter default is A's folder
  const results = a.adapter.flush(app.intake).results.map((r) => r.result);
  assert.deepEqual(results, ["accepted", "accepted", "accepted", "consent_blocked", "accepted"]);
  const rows = all<any>(app.db, "SELECT source_seq, project_id, content_text, disposition FROM capture_events WHERE kind = 'user_turn' ORDER BY source_seq");
  assert.deepEqual({ ...rows[0] }, { source_seq: 4, project_id: b.project_id, content_text: null, disposition: "consent_blocked" }, "bound to B; its content is not kept");
  assert.equal(rows[1].project_id, a.project.project_id);
  assert.equal(app.learning.queue(b.project_id).not_captured_no_consent, 1, "the count of events not captured for B increases");
  assert.equal(get<{ n: number }>(app.db, "SELECT COUNT(*) AS n FROM signals WHERE project_id = ?", b.project_id)!.n, 0);
  assert.equal(app.rules.listForProject(b.project_id).length, 0);
  const candidates = all<any>(app.db, "SELECT project_id FROM learning_candidates");
  assert.deepEqual(candidates.map((c) => c.project_id), [a.project.project_id], "the instruction given in A becomes a candidate only in A");

  // An adapter's bare project claim is never trusted: it must agree with what the store resolves.
  const claim = (seq: number, binding: Record<string, unknown>) => app.intake.deliver({ adapter_id: "adp_TURNHOOK", stream_id: "str_SWITCH0001", events: [{ event: {
    schema_version: "cl.capture_event/1", capture_id: `cap_CLAIM${String(seq).padStart(5, "0")}`, adapter_id: "adp_TURNHOOK", stream_id: "str_SWITCH0001", source_seq: seq, kind: "user_turn", occurred_at: T0, role: "user",
    attested_by: "runtime_hook", binding, content: { text: "Always quote in EUR.", language: "en" }, content_state: "present", content_digest: contentDigest("Always quote in EUR."),
  } }] });
  claim(6, { binding_id: bBinding, project_id: a.project.project_id }); // says A, but the folder is B's
  claim(7, { binding_id: null, project_id: a.project.project_id }); // a claim with nothing the store can verify
  const forged = all<any>(app.db, "SELECT project_id, content_text, disposition FROM capture_events WHERE source_seq IN (6, 7) ORDER BY source_seq");
  assert.deepEqual(forged.map((f) => ({ ...f })), [{ project_id: null, content_text: null, disposition: "unbound" }, { project_id: null, content_text: null, disposition: "unbound" }]);
  assert.equal(app.learning.inbox(null).filter((i) => i.kind === "which_project").length, 2, "an event that cannot be bound to exactly one project goes to the inbox; it is never guessed");
  assert.equal(all(app.db, "SELECT 1 FROM learning_candidates").length, 1, "and nothing is learned from it");
});

test("AT-L17 consent: learning turned off mid-session drops the content of later events", () => {
  const s = scenario("auto_low_risk");
  draftAndCorrect(s, SGD);
  s.adapter.flush(s.app.intake);
  s.app.policies.set({ project_id: s.project.project_id, mode: "off", learn_from: [] }, s.marcus);
  turn(s, "Always include the quote reference.");
  assert.deepEqual(s.adapter.flush(s.app.intake).results.map((r) => r.result), ["consent_blocked"]);
  const rows = all<any>(s.app.db, "SELECT content_text FROM capture_events WHERE kind = 'user_turn' ORDER BY source_seq");
  assert.deepEqual(rows.map((r) => r.content_text), [SGD, null]);
  assert.equal(counts(s).signals, 1);
  assert.equal(s.app.policies.current(s.project.project_id)!.revoked?.learned_rules, "keep");
});

test("AT-L3: while events are missing the stream is held, then processed as incomplete - and nothing activates automatically from it", () => {
  const s = scenario("auto_low_risk");
  const { app } = s;
  draftAndCorrect(s, SGD);
  // The adapter announces 5 events but only 3 ever arrive (it crashed and lost its outbox).
  app.intake.hello({ adapter_id: "adp_TURNHOOK", stream_id: s.adapter.streamId, last_seq: 5, binding_id: s.bindingId });
  const raw = (s.adapter as any).outbox.map((o: any) => ({ event: o.event }));
  app.intake.deliver({ adapter_id: "adp_TURNHOOK", stream_id: s.adapter.streamId, events: raw });
  let state = app.intake.stream(s.adapter.streamId);
  assert.equal(state.health, "lagging");
  assert.equal(state.processed_through, 0, "held: the missing events might qualify the instruction (\"just this once\")");
  assert.equal(counts(s).signals, 0);
  // The gap timeout passes; the gap stays open and visible.
  app.clock.advance(120);
  app.learning.tick();
  state = app.intake.stream(s.adapter.streamId);
  assert.equal(state.health, "gap");
  assert.deepEqual(state.gaps.map((g) => [g.from_seq, g.to_seq, g.closed_at]), [[4, 5, null]]);
  assert.equal(state.processed_through, 3);
  app.checks.observe({ project_id: s.project.project_id, name: "Kestrel-Supply-Quote.md", bytes: quote({ currency: "SGD" }) });
  const decision = app.learning.decisions(s.project.project_id)[0]!;
  assert.equal(decision.signals[0].episode_capture_complete, false);
  assert.ok(decision.reasons.includes("capture_incomplete"));
  assert.equal(decision.outcome, "inbox");
  assert.equal(app.rules.listAll().filter((r) => r.status === "active").length, 0);
  // Closing the stream short of what the adapter announced leaves it visibly incomplete.
  assert.equal(app.intake.close({ adapter_id: "adp_TURNHOOK", stream_id: s.adapter.streamId, final_seq: 5 }).status, "closed_incomplete");
});
