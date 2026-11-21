import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../src/app.ts";
import { FixedClock } from "../src/domain/time.ts";
import type { LedgerEvent } from "../src/ledger/ledger.ts";
import { verifyEvents } from "../src/ledger/ledger.ts";
import { all, get, openDb, run } from "../src/store/db.ts";
import { MIGRATIONS, migrate, schemaVersion } from "../src/store/migrations.ts";
import { IMMUTABLE_TABLES } from "../src/store/schema.ts";
import { activeRule, fixture, quote, scenario, T0, tmpDir } from "./helpers.ts";

test("migrations: versioned, applied once, and an edited applied migration is refused", () => {
  const db = openDb(":memory:");
  assert.deepEqual(migrate(db).applied, [1, 2]);
  assert.deepEqual(migrate(db).applied, [], "second run applies nothing");
  assert.equal(schemaVersion(db), MIGRATIONS.length);
  assert.throws(() => migrate(db, [{ ...MIGRATIONS[0]!, sql: MIGRATIONS[0]!.sql + "\n-- edited" }, MIGRATIONS[1]!]), /changed after it was applied/);
  assert.throws(() => migrate(db, [...MIGRATIONS, { version: 4, name: "gap", sql: "SELECT 1" }]), /contiguously/);
  migrate(db, [...MIGRATIONS, { version: 3, name: "additive", sql: "CREATE TABLE later_addition (id TEXT PRIMARY KEY)" }]);
  assert.equal(schemaVersion(db), 3);
  assert.throws(() => migrate(db), /newer than this build/, "an older build refuses a newer store");
  // A Phase 1 store (migration 1 only) is upgraded in place by migration 2.
  const old = openDb(":memory:");
  assert.deepEqual(migrate(old, [MIGRATIONS[0]!]).applied, [1]);
  assert.deepEqual(migrate(old).applied, [2]);
  assert.equal(schemaVersion(old), 2);
});

test("immutable tables reject UPDATE and DELETE (revisions, runs, events, decisions, ...)", () => {
  const s = scenario("auto_low_risk");
  activeRule(s.app, { rule_id: "rul_IMMUTABLE" });
  s.app.checks.check({ project_id: s.project.project_id, name: "q.md", bytes: quote({ currency: "SGD" }), action: { type: "release" }, actor: s.marcus });
  for (const table of IMMUTABLE_TABLES) {
    const row = get<any>(s.app.db, `SELECT rowid AS r FROM ${table} LIMIT 1`);
    if (!row) continue; // a table with no rows yet is still protected by its triggers (checked below)
    assert.throws(() => run(s.app.db, `UPDATE ${table} SET rowid = rowid WHERE rowid = ?`, row.r), /immutable/, `${table} update`);
    assert.throws(() => run(s.app.db, `DELETE FROM ${table} WHERE rowid = ?`, row.r), /immutable/, `${table} delete`);
  }
  const triggers = all<{ name: string }>(s.app.db, "SELECT name FROM sqlite_master WHERE type = 'trigger'").map((t) => t.name);
  for (const table of IMMUTABLE_TABLES) assert.ok(triggers.includes(`${table}_no_update`) && triggers.includes(`${table}_no_delete`), `${table} has both triggers`);
  // A receipt's signed statement is frozen; only its status may move.
  assert.throws(() => run(s.app.db, "UPDATE receipts SET record_json = '{}'"), /immutable/);
  assert.throws(() => run(s.app.db, "UPDATE event_payloads SET payload_json = '{\"forged\":true}'"), /immutable/);
});

test("the ledger is hash-chained, causally ordered, and tampering is located (AT-R4)", () => {
  const dir = tmpDir();
  const app = createApp({ dbPath: join(dir, "workspace.db"), clock: new FixedClock(T0), workspaceId: "ws_TEST0001" });
  const project = app.projects.createProject({ name: "P", default_work_type: "sales_proposal" }, app.localUser);
  app.checks.observe({ project_id: project.project_id, name: "q.md", bytes: quote() });
  const events = app.ledger.all();
  assert.ok(events.length >= 3);
  assert.deepEqual(events.map((e) => e.seq), events.map((_, i) => i + 1), "one contiguous order");
  assert.equal(app.ledger.verify().ok, true);
  assert.throws(() => app.ledger.append({ type: "run.completed", project_id: null, actor: app.localUser, subject: { kind: "run", id: "run_XXXXXX" }, caused_by: ["evt_999999"], summary: "x" }), /not an earlier event/);
  assert.throws(() => app.ledger.append({ type: "not.a.type" as any, project_id: null, actor: app.localUser, subject: { kind: "x", id: "run_XXXXXX" }, summary: "x" }), /unknown event type/);
  // Acts reserved for people cannot be recorded for a system, agent or adapter actor.
  for (const type of ["rule.approved", "rule.retired", "action.approved", "learning.policy_set", "exception.granted"] as const) {
    assert.throws(() => app.ledger.append({ type, project_id: null, actor: { kind: "system", id: "sys_LEARNING" }, subject: { kind: "x", id: "run_XXXXXX" }, summary: "x" }), /must be performed by a person/);
  }
  // Erasing evidence keeps the envelopes verifiable.
  app.ledger.erasePayload(events[1]!.event_id);
  assert.equal(app.ledger.get(events[1]!.event_id).payload, null);
  assert.equal(app.ledger.verify().ok, true);
  // An exported log with one altered event fails at exactly that sequence number.
  const log = app.ledger.exportLog() as { events: LedgerEvent[]; chain: { first_prev_hash: string; first_seq: number } };
  const altered = structuredClone(log.events);
  altered[2]!.summary = "something else happened";
  const result = verifyEvents(altered, log.chain.first_prev_hash, log.chain.first_seq, app.workspaceId);
  assert.equal(result.ok, false);
  assert.equal(result.first_bad_seq, altered[2]!.seq);
  // Tampering directly in the store (bypassing the triggers) is detected too.
  app.db.exec("DROP TRIGGER events_no_update");
  run(app.db, "UPDATE events SET envelope_json = replace(envelope_json, 'created the project', 'deleted the project') WHERE seq = 2");
  const live = app.ledger.verify();
  assert.equal(live.ok, false);
  assert.equal(live.first_bad_seq, 2);
  app.close();
});

test("the ledger verifier agrees with the design's example timelines (cross-check with tools/check_repo.py)", () => {
  for (const path of ["examples/sales-proposal/events.json", "examples/learning/events.json"]) {
    const log = fixture(path);
    const events = log.events as LedgerEvent[]; // payload digests and envelope hashes, exactly as the checker verifies them
    const result = verifyEvents(events, log.chain.first_prev_hash, log.chain.first_seq, log.workspace_id);
    assert.deepEqual(result, { ok: true, events: log.events.length }, path);
    assert.equal(events.at(-1)!.hash, log.chain.head_hash);
  }
});

test("a restart keeps the store, its identity and a verifying history", () => {
  const dir = tmpDir();
  const open = () => createApp({ dbPath: join(dir, "workspace.db"), signingKeyPath: join(dir, "key.pem"), clock: new FixedClock(T0), workspaceId: "ws_TEST0001" });
  const first = open();
  const project = first.projects.createProject({ name: "P", default_work_type: "sales_proposal" }, first.localUser);
  const count = first.ledger.all().length;
  first.close();
  const second = createApp({ dbPath: join(dir, "workspace.db"), signingKeyPath: join(dir, "key.pem"), clock: new FixedClock(T0), workspaceId: "ws_OTHER001" });
  assert.equal(second.workspaceId, "ws_TEST0001", "an existing store keeps its workspace identity");
  assert.equal(second.projects.get(project.project_id).name, "P");
  assert.equal(second.ledger.all().length, count);
  assert.equal(second.ledger.verify().ok, true);
  second.close();
});
