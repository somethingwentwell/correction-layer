import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../src/app.ts";
import { Unavailable } from "../src/domain/errors.ts";
import { FixedClock } from "../src/domain/time.ts";
import type { ActionAdapter } from "../src/gate/adapters.ts";
import { DEFAULT_ACTION_ADAPTERS, SIMULATED_RELEASE, UNAVAILABLE_EMAIL, UNAVAILABLE_PAYMENT } from "../src/gate/adapters.ts";
import type { Signer } from "../src/gate/signer.ts";
import { all, get, run } from "../src/store/db.ts";
import type { Scenario, TestApp } from "./helpers.ts";
import { activeRule, makeApp, quote, ruleContent, scenario, T0, tmpDir } from "./helpers.ts";

const agent = { kind: "agent" as const, id: "agt_ASSIST01", display_name: "assistant" };
const tableCount = (app: TestApp, table: string) => get<{ n: number }>(app.db, `SELECT COUNT(*) AS n FROM ${table}`)!.n;

/** A project with one must-pass SGD rule, the simulated release route switched on, and a Ready check with a receipt. */
function ready(opts: { app?: TestApp; policy?: "self" | "none_required" } = {}): Scenario & { receiptId: string; runId: string } {
  const s = scenario(null, opts.app ? { app: opts.app } : {});
  activeRule(s.app, { rule_id: "rul_SGD00001" });
  s.app.gateway.setActionPolicy(s.project.project_id, "release", opts.policy ?? "self", s.marcus);
  const out = s.app.checks.check({ project_id: s.project.project_id, name: "Quote.md", bytes: quote({ currency: "SGD" }), action: { type: "release" }, actor: s.priya });
  assert.equal(out.verdict, "ready");
  assert.ok(out.receipt_id);
  return { ...s, receiptId: out.receipt_id!, runId: out.run_id! };
}

test("a receipt binds artifact + policy revision + action + sources, expires, and says it grants no permission", () => {
  const s = ready();
  const receipt = s.app.gateway.getReceipt(s.receiptId);
  const runRecord = s.app.checks.getRun(s.runId);
  assert.equal(receipt.grants_permission, false);
  assert.equal(receipt.single_use, true);
  assert.equal(receipt.status, "valid");
  assert.deepEqual(receipt.artifact, { artifact_id: runRecord.artifact.artifact_id, version_seq: 1, content_hash: runRecord.artifact.content_hash });
  assert.deepEqual(receipt.action, { type: "release", params_digest: null });
  assert.deepEqual(receipt.policy, { policy_rev: runRecord.policy.policy_rev, ruleset_digest: runRecord.policy.ruleset_digest });
  assert.equal(receipt.project_id, s.project.project_id);
  assert.equal(receipt.expires_at, "2026-11-18T06:00:00Z", "default lifetime 24 hours");
  assert.equal(receipt.signature.alg, "ed25519");
  assert.equal(runRecord.receipt_id, s.receiptId);
  assert.deepEqual(s.app.gateway.receiptStanding(s.receiptId).failed, []);
  // No receipt for anything but Ready, for check_only, or for an action no gateway handles.
  const blocked = s.app.checks.check({ project_id: s.project.project_id, name: "Usd.md", bytes: quote({ currency: "USD" }), action: { type: "release" }, actor: s.priya });
  assert.deepEqual([blocked.verdict, blocked.receipt_id, blocked.receipt_unavailable_reason], ["needs_changes", null, "verdict_not_ready"]);
  const only = s.app.checks.check({ project_id: s.project.project_id, name: "Quote.md", bytes: quote({ currency: "SGD" }), action: { type: "check_only" }, actor: s.priya });
  assert.deepEqual([only.verdict, only.receipt_id, only.receipt_unavailable_reason], ["ready", null, "check_only"]);
  const send = s.app.checks.check({ project_id: s.project.project_id, name: "Quote.md", bytes: quote({ currency: "SGD" }), action: { type: "send_external" }, actor: s.priya });
  assert.deepEqual([send.verdict, send.receipt_id, send.receipt_unavailable_reason], ["ready", null, "no_gated_route_for_action"]);
  // A tampered statement no longer verifies.
  s.app.db.exec("DROP TRIGGER receipts_statement_frozen");
  run(s.app.db, "UPDATE receipts SET record_json = replace(record_json, '\"version_seq\":1', '\"version_seq\":7') WHERE receipt_id = ?", s.receiptId);
  assert.ok(s.app.gateway.receiptStanding(s.receiptId).failed.some((f) => f.step === 3 && /signature/.test(f.detail ?? "")));
});

test("validation, permission and action are separate: a check never requests, approves or executes anything", () => {
  const s = ready();
  for (const table of ["action_requests", "approvals", "executions"]) assert.equal(tableCount(s.app, table), 0, table);
  assert.equal(s.app.ledger.all().filter((e) => e.type.startsWith("action.") && e.type !== "action.blocked").length, 0);
  // Requesting records a request awaiting a person. Nothing runs.
  const { request } = s.app.gateway.requestAction({ receipt_id: s.receiptId, type: "release" }, agent);
  assert.equal(request.status, "awaiting_approval");
  assert.equal(tableCount(s.app, "executions"), 0);
  // AT-E3: nothing executes without approval, and a client cannot approve.
  assert.throws(() => s.app.gateway.execute(request.action_id, s.marcus), /nothing executes without approval/);
  assert.throws(() => s.app.gateway.approve(request.action_id, agent), /done by a person/);
  assert.throws(() => s.app.gateway.approve(request.action_id, { kind: "system", id: "sys_GATEWAY1" }), /done by a person/);
  assert.equal(tableCount(s.app, "approvals"), 0);
  // A person approves: still nothing has run. Approval and execution are different events by different actors.
  const approved = s.app.gateway.approve(request.action_id, s.marcus);
  assert.equal(approved.status, "approved");
  assert.equal(approved.approval!.self_approval, false);
  assert.equal(tableCount(s.app, "executions"), 0);
  assert.throws(() => s.app.gateway.execute(request.action_id, agent), /done by a person/, "execution begins only from a person's explicit act");
  const done = s.app.gateway.execute(request.action_id, s.marcus);
  assert.equal(done.status, "executed");
  assert.equal(done.execution!.simulated, true);
  assert.equal(done.execution!.executed_content_hash, s.app.gateway.getReceipt(s.receiptId).artifact.content_hash, "what was checked is what is released");
  assert.deepEqual(done.gate_checks.map((g) => [g.step, g.ok]), [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [n, true]));
  const actors = Object.fromEntries(s.app.ledger.byRef("action_id", request.action_id).map((e) => [e.type, e.actor.kind]));
  assert.deepEqual(actors, { "action.requested": "agent", "action.approved": "human", "action.revalidated": "system", "action.executed": "adapter", "receipt.consumed": "system" });
  // AT-E5: single use.
  assert.equal(s.app.gateway.getReceipt(s.receiptId).status, "consumed");
  assert.throws(() => s.app.gateway.execute(request.action_id, s.marcus), /this request is executed/);
  assert.equal(tableCount(s.app, "executions"), 1);
  assert.equal(s.app.ledger.verify().ok, true);
});

test("idempotency: the same request from two clients is one request (AT-C12); a receipt for one action is not valid for another", () => {
  const s = ready();
  const first = s.app.gateway.requestAction({ receipt_id: s.receiptId, type: "release", params: { note: "v1" } }, agent);
  const second = s.app.gateway.requestAction({ receipt_id: s.receiptId, type: "release", params: { note: "v1" } }, { ...agent, id: "agt_OTHER001" });
  assert.equal(second.deduplicated, true);
  assert.equal(second.request.action_id, first.request.action_id);
  assert.equal(tableCount(s.app, "action_requests"), 1);
  assert.equal(s.app.gateway.requestAction({ receipt_id: s.receiptId, type: "release", params: { note: "v2" } }, agent).deduplicated, false, "different parameters are a different request");
});

test("no automatic external send or pay: those adapters are unavailable, refuse explicitly, and leave a record", () => {
  const s = ready();
  for (const adapter of [UNAVAILABLE_EMAIL, UNAVAILABLE_PAYMENT]) {
    assert.equal(adapter.capability.availability, "unavailable");
    assert.throws(() => adapter.execute({ action_id: "act_X000001", type: adapter.capability.action_types[0]!, params: {}, bytes: new Uint8Array(), content_hash: "" }), Unavailable);
  }
  assert.equal(SIMULATED_RELEASE.capability.simulated, true);
  assert.deepEqual(DEFAULT_ACTION_ADAPTERS.filter((a) => a.capability.availability === "available").map((a) => [a.capability.adapter_id, a.capability.simulated]), [["adp_RELEASESIM", true]], "the only available adapter is simulated");
  for (const type of ["send_external", "pay", "wire_transfer"]) {
    assert.throws(() => s.app.gateway.requestAction({ receipt_id: s.receiptId, type }, s.marcus), (e: unknown) => e instanceof Unavailable && /Nothing was sent, paid or released/.test(e.message), type);
    assert.throws(() => s.app.gateway.setActionPolicy(s.project.project_id, type, "none_required", s.marcus), Unavailable);
  }
  assert.equal(tableCount(s.app, "action_requests"), 0);
  assert.equal(tableCount(s.app, "executions"), 0);
  assert.equal(s.app.ledger.all().filter((e) => e.type === "action.blocked" && /refused/.test(e.summary)).length, 3, "each refusal is visible in the ledger");
  // Coverage labels come from configuration: send and pay are NOT COVERED, release is GATED and marked simulated.
  const coverage = Object.fromEntries(s.app.gateway.coverage(s.project.project_id).map((c) => [c.action, [c.label, c.simulated]]));
  assert.deepEqual([coverage.release, coverage.send_external, coverage.pay], [["GATED", true], ["NOT_COVERED", false], ["NOT_COVERED", false]]);
  // A project where the route was never switched on: not covered, and a request is refused.
  const other = s.app.projects.createProject({ name: "No route (TEST)", default_work_type: "sales_proposal" }, s.marcus);
  assert.equal(s.app.gateway.coverage(other.project_id).find((c) => c.action === "release")!.label, "NOT_COVERED");
  const out = s.app.checks.check({ project_id: other.project_id, name: "Quote.md", bytes: quote({ currency: "SGD" }), action: { type: "release" }, actor: s.priya });
  assert.throws(() => s.app.gateway.requestAction({ receipt_id: out.receipt_id!, type: "release" }, s.marcus), /not switched on for this project/);
});

test("AT-E2: every change a receipt depends on blocks execution until a fresh check (fail closed)", () => {
  const invalidations: Array<[string, (s: ReturnType<typeof ready>) => void, number, string]> = [
    ["a newer version of the file", (s) => { s.app.checks.observe({ project_id: s.project.project_id, name: "Quote.md", bytes: quote({ currency: "SGD", total: "1.00" }) }); }, 5, "paused_newer_version"],
    ["a rule added in scope", (s) => { activeRule(s.app, { rule_id: "rul_NEWRULE1", check: { kind: "field_present", targets: ["quote.reference"], params: {} }, requires: { fields: [], components: [] } }); }, 6, "blocked"],
    ["a rule in scope retired", (s) => { s.app.rules.retire("rul_SGD00001", s.marcus, "test"); }, 6, "blocked"],
    ["time ran out", (s) => { s.app.clock.advance(25 * 3600); }, 3, "blocked"],
    ["the checked bytes are gone", (s) => { run(s.app.db, "DELETE FROM blobs"); }, 4, "blocked"],
    ["the route was switched off", (s) => { run(s.app.db, "DELETE FROM action_policies"); }, 1, "blocked"],
  ];
  for (const [name, change, step, status] of invalidations) {
    const s = ready();
    const { request } = s.app.gateway.requestAction({ receipt_id: s.receiptId, type: "release" }, s.priya);
    s.app.gateway.approve(request.action_id, s.marcus);
    change(s);
    const out = s.app.gateway.execute(request.action_id, s.marcus);
    assert.equal(out.status, status, name);
    assert.equal(out.gate_checks.find((g) => !g.ok)!.step, step, name);
    assert.equal(tableCount(s.app, "executions"), 0, `${name}: nothing executed`);
    assert.ok(s.app.ledger.byRef("action_id", request.action_id).some((e) => e.type === (status === "blocked" ? "action.blocked" : "action.paused")), `${name}: recorded`);
    assert.throws(() => s.app.gateway.execute(request.action_id, s.marcus), /nothing executes without approval/, `${name}: stays blocked`);
  }
  // An unrelated rule change elsewhere does NOT invalidate the receipt (it binds the in-scope set, not the whole workspace).
  const s = ready();
  const elsewhere = s.app.projects.createProject({ name: "Elsewhere (TEST)", default_work_type: "sales_proposal" }, s.marcus);
  activeRule(s.app, { rule_id: "rul_ELSEWHER", scope: { ...ruleContent(s.app, { rule_id: "rul_X00001" }).scope, level: "project", project_id: elsewhere.project_id } });
  assert.equal(s.app.gateway.receiptStanding(s.receiptId).usable, true);
});

test("receipts bind source snapshots: a newer or stale source lapses the receipt, and its lifetime is cut to the source's freshness", () => {
  const s = scenario(null);
  const { app, project } = s;
  app.gateway.setActionPolicy(project.project_id, "release", "self", s.marcus);
  const sourceId = app.projects.registerSource({ name: "Price list (TEST)", key_columns: ["item_code", "currency"], value_columns: ["unit_price"], max_age_days: 1 }, s.marcus);
  const rows = [{ row: 1, key: { item_code: "HX-200", currency: "SGD" }, values: { unit_price: "1180.00" } }, { row: 2, key: { item_code: "CAL-1Y", currency: "SGD" }, values: { unit_price: "300.00" } }];
  const snapshot = app.projects.importSnapshot(sourceId, rows, s.marcus); // vouched for 1 day
  app.clock.advance(2 * 3600); // the check happens two hours later
  activeRule(app, {
    rule_id: "rul_PRICE001", method: "source_backed", source: { source_id: sourceId, max_age_days: 1, require_latest: true, missing_key: "unknown" },
    check: { kind: "field_matches_source", targets: ["quote.line_items[*].unit_price"], params: { lookup_key: { item_code: "quote.line_items[*].item_code", currency: "quote.line_items[*].currency" }, source_value: "unit_price", compare: "money_equal" } },
    requires: { fields: ["quote.line_items[*].unit_price"], components: ["body.tables"] },
  });
  const out = app.checks.check({ project_id: project.project_id, name: "Quote.md", bytes: quote({ currency: "SGD" }), action: { type: "release" }, actor: s.priya });
  assert.equal(out.verdict, "ready");
  const receipt = app.gateway.getReceipt(out.receipt_id!);
  assert.deepEqual(receipt.sources.map((x) => [x.source_id, x.snapshot_id, x.fresh]), [[sourceId, snapshot.snapshot_id, true]]);
  assert.equal(receipt.issued_at, "2026-11-17T08:00:00Z");
  assert.equal(receipt.sources[0]!.fresh_until, "2026-11-18T06:00:00Z");
  assert.equal(receipt.expires_at, "2026-11-18T06:00:00Z", "shortened from 24 hours to the earliest freshness limit of any source used");
  // A newer snapshot: the receipt no longer validates (step 7), and execution is blocked.
  const { request } = app.gateway.requestAction({ receipt_id: receipt.receipt_id, type: "release" }, s.priya);
  app.gateway.approve(request.action_id, s.marcus);
  app.projects.importSnapshot(sourceId, rows, s.marcus);
  const blocked = app.gateway.execute(request.action_id, s.marcus);
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.gate_checks.find((g) => !g.ok)!.step, 7);
  assert.equal(app.gateway.getReceipt(receipt.receipt_id).status, "invalidated");
  // AT-E4: past the freshness window the rule is unknown and nothing can be released until a new snapshot and a recheck.
  app.clock.set("2027-03-01T00:00:00Z");
  const stale = app.checks.check({ project_id: project.project_id, name: "Quote.md", bytes: quote({ currency: "SGD" }), action: { type: "release" }, actor: s.priya });
  assert.deepEqual([stale.verdict, stale.receipt_id], ["could_not_verify", null]);
  assert.throws(() => app.projects.importSnapshot(sourceId, rows, agent), /done by a person/, "a trusted source is designated by a person");
});

test("fail closed on dependency failure: no signing key means no receipt; a failing dependency at the gate blocks", () => {
  const broken: Signer = { keyId: "broken", sign: () => { throw new Error("keychain unavailable"); }, verify: () => false };
  const s = scenario(null, { app: makeApp({ signer: broken }) });
  activeRule(s.app, { rule_id: "rul_SGD00001" });
  const out = s.app.checks.check({ project_id: s.project.project_id, name: "Quote.md", bytes: quote({ currency: "SGD" }), action: { type: "release" }, actor: s.priya });
  assert.equal(out.verdict, "ready", "the check itself completed");
  assert.equal(out.receipt_id, null, "but nothing that looks like permission exists");
  assert.match(out.receipt_unavailable_reason ?? "", /receipt_could_not_be_issued: keychain unavailable/);
  assert.equal(tableCount(s.app, "receipts"), 0);
  assert.equal(s.app.checks.getRun(out.run_id!).receipt_id, null);

  // A source registry that throws during revalidation is a failed binding, not a pass.
  const r = ready();
  const { request } = r.app.gateway.requestAction({ receipt_id: r.receiptId, type: "release" }, r.priya);
  r.app.gateway.approve(request.action_id, r.marcus);
  (r.app.projects as any).resolve = () => { throw new Error("store unreachable"); };
  const blocked = r.app.gateway.execute(request.action_id, r.marcus);
  assert.equal(blocked.status, "blocked");
  assert.match(blocked.status_reason ?? "", /a dependency failed: store unreachable/);
  assert.equal(tableCount(r.app, "executions"), 0);

  // An adapter that fails does so visibly; nothing is retried automatically.
  const failing: ActionAdapter = { capability: { ...SIMULATED_RELEASE.capability }, execute: () => { throw new Error("disk full"); } };
  const f = ready({ app: makeApp({ actionAdapters: [failing] }) });
  const req = f.app.gateway.requestAction({ receipt_id: f.receiptId, type: "release" }, f.priya).request;
  f.app.gateway.approve(req.action_id, f.marcus);
  const failed = f.app.gateway.execute(req.action_id, f.marcus);
  assert.deepEqual([failed.status, failed.status_reason], ["failed", "disk full"]);
  assert.ok(f.app.ledger.all().some((e) => e.type === "action.failed"));
  assert.throws(() => f.app.gateway.execute(req.action_id, f.marcus), /this request is failed/);
});

test("AT-E5: a crash between `executing` and the outcome leaves `outcome_unknown`, which is never retried automatically", () => {
  const dir = tmpDir();
  const open = () => createApp({ dbPath: join(dir, "workspace.db"), signingKeyPath: join(dir, "key.pem"), clock: new FixedClock(T0), workspaceId: "ws_TEST0001", localUserId: "usr_MARCUS01" }) as TestApp;
  const s = ready({ app: open() });
  const { request } = s.app.gateway.requestAction({ receipt_id: s.receiptId, type: "release" }, s.priya);
  s.app.gateway.approve(request.action_id, s.marcus);
  // Simulate the process dying after the request was durably marked executing.
  run(s.app.db, "UPDATE action_requests SET status = 'executing' WHERE action_id = ?", request.action_id);
  s.app.close();
  const app = open(); // startup recovery
  const after = app.gateway.getAction(request.action_id);
  assert.equal(after.status, "outcome_unknown");
  assert.ok(app.ledger.all().some((e) => e.type === "action.outcome_unknown"));
  assert.throws(() => app.gateway.execute(request.action_id, app.localUser), /this request is outcome_unknown/);
  assert.equal(all(app.db, "SELECT 1 FROM executions WHERE completed_at IS NOT NULL").length, 0);
  // The file-backed signing key survives the restart, so the receipt's signature still verifies.
  assert.ok(!app.gateway.receiptStanding(s.receiptId).failed.some((f) => /signature/.test(f.detail ?? "")));
  app.close();
});

test("a standing pre-authorization is a person's recorded decision; even then a person starts the action and the receipt must hold", () => {
  const s = ready({ policy: "none_required" });
  assert.throws(() => s.app.gateway.setActionPolicy(s.project.project_id, "release", "none_required", agent), /done by a person/);
  const { request } = s.app.gateway.requestAction({ receipt_id: s.receiptId, type: "release" }, agent);
  assert.equal(request.status, "approved");
  assert.equal(tableCount(s.app, "executions"), 0, "requesting still executes nothing");
  assert.throws(() => s.app.gateway.execute(request.action_id, agent), /done by a person/);
  s.app.rules.retire("rul_SGD00001", s.marcus, "test");
  assert.equal(s.app.gateway.execute(request.action_id, s.marcus).status, "blocked", "no approval needed is not no validation needed");
});
