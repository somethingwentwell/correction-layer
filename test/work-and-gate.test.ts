/**
 * Work and gate functions: CSV trusted-source import (AT-F7), content diff
 * (AT-O5), re-run as recorded (AT-O7), proposed vs applied changes, the local
 * release folder with the newer-version choice (AT-C9, AT-E1), and a pending
 * request surviving a restart (AT-C3). Hermetic: temp folders, in-memory or temp
 * stores. FICTIONAL test data.
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { startServer } from "../src/api/server.ts";
import { createApp } from "../src/app.ts";
import { sha256 } from "../src/domain/canonical.ts";
import { ClError, PermissionDenied, ValidationError } from "../src/domain/errors.ts";
import { FixedClock } from "../src/domain/time.ts";
import { parseCsv } from "../src/context/projects.ts";
import { get, run } from "../src/store/db.ts";
import type { Scenario, TestApp } from "./helpers.ts";
import { enc, quote, scenario, T0, tmpDir } from "./helpers.ts";

const agent = { kind: "agent" as const, id: "agt_ASSIST01", display_name: "assistant" };
const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return e instanceof ClError ? e.code : String(e);
  }
  return "no error";
};
const PRICE_CSV = `item_code,description,unit_price,currency
HX-200,"Flow sensor, standard","1,180.00",SGD
CAL-1Y,Calibration plan,300.00,SGD
FX-9,Old part,=B4*1.1,SGD
EMPTY-1,No price,,SGD
DUP-1,First,10.00,SGD
DUP-1,Second,11.00,SGD
BROKEN,only two cells
`;

function withPriceList(s: Scenario): string {
  const sourceId = s.app.projects.registerSource({ name: "[TEST] Price list", key_columns: ["item_code"], value_columns: ["unit_price"], max_age_days: 30 }, s.marcus);
  return sourceId;
}

test("CSV parsing is RFC 4180: quoted commas, doubled quotes, CRLF", () => {
  assert.deepEqual(parseCsv('a,b\r\n"x, y","say ""hi"""\r\n'), [["a", "b"], ["x, y", 'say "hi"']]);
  assert.deepEqual(parseCsv("﻿k,v\n1,2"), [["k", "v"], ["1", "2"]]);
});

test("AT-F7: a CSV source import reports formula cells without results, empty values, duplicates and malformed rows - none is read as zero", () => {
  const s = scenario(null);
  const sourceId = withPriceList(s);
  assert.throws(() => s.app.projects.importCsv(sourceId, { file_name: "prices.csv", text: PRICE_CSV }, agent), PermissionDenied);
  assert.throws(() => s.app.projects.importCsv(sourceId, { file_name: "bad.csv", text: "code,price\nA,1\n" }, s.marcus), /no column named item_code, unit_price/);
  const { snapshot, report } = s.app.projects.importCsv(sourceId, { file_name: "prices.csv", text: PRICE_CSV }, s.marcus);
  assert.deepEqual(snapshot.rows.map((r) => [r.row, r.key.item_code, r.values.unit_price]), [[2, "HX-200", "1180.00"], [3, "CAL-1Y", "300.00"]]);
  assert.equal(report.rows_imported, 2);
  assert.deepEqual(report.rejected.map((r) => r.row), [4, 5, 6, 7, 8]);
  assert.match(report.rejected[0]!.reason, /formula with no computed result.*never read as zero or blank/);
  assert.match(report.rejected[1]!.reason, /empty; it is never read as zero/);
  assert.match(report.rejected[2]!.reason, /appears more than once/);
  assert.match(report.rejected[4]!.reason, /has 2 cells/);
  assert.deepEqual(s.app.projects.importReport(snapshot.snapshot_id), report);
  // A price rule reads the imported list; the formula row cannot be used for lookups.
  const p = s.project.project_id;
  const rule = s.app.authoring.create({ project_id: p, template: { template: "price_matches_source", source_id: sourceId, key_column: "item_code", value_column: "unit_price" } }, s.marcus);
  s.app.rules.approveAndActivate(rule.rule_id, s.marcus, { trial: true });
  const out = s.app.checks.check({ project_id: p, name: "Q.md", bytes: quote({ currency: "SGD" }), action: { type: "check_only" }, actor: s.marcus });
  assert.equal(s.app.checks.getRun(out.run_id!).results[0]!.outcome, "pass");
  const fx = enc(new TextDecoder().decode(quote({ currency: "SGD" })).replace("HX-200 Flow Sensor", "FX-9 Old part"));
  const unknown = s.app.checks.getRun(s.app.checks.check({ project_id: p, name: "Q2.md", bytes: fx, action: { type: "check_only" }, actor: s.marcus }).run_id!).results[0]!;
  assert.equal(unknown.outcome, "unknown");
  assert.match(unknown.reason, /not in the trusted source \(item_code FX-9\)/);
  // Nothing usable: nothing imported.
  assert.throws(() => s.app.projects.importCsv(sourceId, { file_name: "all-bad.csv", text: "item_code,unit_price\nA,=1+1\n" }, s.marcus), ValidationError);
  assert.equal(s.app.projects.latestSnapshot(sourceId)!.snapshot_id, snapshot.snapshot_id);
});

test("AT-O5: before/after shows each changed passage and value, joined to findings resolved or introduced; unread parts are named", () => {
  const s = scenario(null);
  const p = s.project.project_id;
  s.app.authoring.create({ project_id: p, template: { template: "currency", currency: "SGD" } }, s.marcus);
  const rule = s.app.rules.listAll()[0]!;
  s.app.rules.approveAndActivate(rule.rule_id, s.marcus, { trial: true });
  const before = s.app.checks.check({ project_id: p, name: "Q.md", bytes: quote({ currency: "USD" }), action: { type: "check_only" }, actor: s.marcus });
  const after = s.app.checks.check({ project_id: p, name: "Q.md", bytes: quote({ currency: "SGD", extra: "![logo](logo.png)" }), action: { type: "check_only" }, actor: s.marcus });
  const c = s.app.checks.compare(before.run_id!, after.run_id!);
  assert.equal(c.resolved.length, 3);
  assert.ok(c.content_diff.available);
  if (!c.content_diff.available) return;
  const rows = c.content_diff.passages.filter((x) => x.kind === "changed");
  assert.deepEqual(rows.map((r) => [r.before!.text.includes("USD"), r.after!.text.includes("SGD")]), [[true, true], [true, true], [true, true]]);
  assert.equal(rows.flatMap((r) => r.resolved).length, 3, "every resolved finding is joined to the passage it was in");
  assert.ok(c.content_diff.passages.some((x) => x.kind === "added" && x.after!.text.includes("logo")));
  assert.ok(c.content_diff.fields.some((f) => f.path === "quote.line_items[0].unit_price" && f.before === "USD 1180.00" && f.after === "SGD 1180.00"));
  assert.deepEqual(c.content_diff.unread, [{ component: "text_in_images", state: "detected_not_parsed", side: "after" }]);
  assert.ok(c.content_diff.unchanged_passages > 0);
});

test("AT-O7: re-run as recorded is identical; an altered input is a mismatch; a purged input is reported as purged", () => {
  const s = scenario(null);
  const p = s.project.project_id;
  s.app.projects.setFact(p, "customer_name", "Kestrel Dental Group", s.marcus);
  for (const template of [{ template: "currency", currency: "SGD" }, { template: "customer_matches_project" }]) {
    const r = s.app.authoring.create({ project_id: p, template }, s.marcus);
    s.app.rules.approveAndActivate(r.rule_id, s.marcus, { trial: true });
  }
  const out = s.app.checks.check({ project_id: p, name: "Q.md", bytes: quote({ currency: "USD" }), action: { type: "check_only" }, actor: s.marcus });
  // Later events do not change what was recorded: a fact changes, time moves on.
  s.app.projects.setFact(p, "customer_name", "Someone Else", s.marcus);
  s.app.clock.advance(86400 * 3);
  const same = s.app.checks.rerun(out.run_id!);
  assert.equal(same.status, "identical", JSON.stringify(same.problems));
  assert.equal(same.inputs_digest_matches, true);
  assert.ok(same.results.every((r) => r.same && r.recorded === r.now));
  assert.deepEqual(same.results.map((r) => r.recorded).sort(), ["fail", "pass"], "the customer rule still passes: the fact as recorded, not as now");
  // A deliberate alteration of a stored rule revision.
  const ruleId = s.app.rules.listAll().find((r) => r.check.kind === "field_in_set")!.rule_id;
  s.app.db.exec("DROP TRIGGER rule_revisions_no_update");
  run(s.app.db, "UPDATE rule_revisions SET content_json = replace(content_json, '\"SGD\"', '\"USD\"') WHERE rule_id = ?", ruleId);
  const altered = s.app.checks.rerun(out.run_id!);
  assert.equal(altered.status, "mismatch");
  assert.ok(altered.problems.some((x) => /no longer matches its recorded digest/.test(x.detail)));
  // A purged input.
  run(s.app.db, "DELETE FROM blobs WHERE content_hash = ?", s.app.checks.getRun(out.run_id!).artifact.content_hash);
  const purged = s.app.checks.rerun(out.run_id!);
  assert.equal(purged.status, "purged");
  assert.ok(purged.problems.some((x) => x.kind === "purged" && /bytes/.test(x.detail)));
});

test("a proposed change is not a version; only a person applies it; the applied change names the proposal", () => {
  const s = scenario(null);
  const p = s.project.project_id;
  const phrase = s.app.authoring.create({ project_id: p, template: { template: "required_phrase", phrase: "Prices exclude GST" } }, s.marcus);
  s.app.rules.approveAndActivate(phrase.rule_id, s.marcus, { trial: true });
  const first = s.app.checks.check({ project_id: p, name: "Q.md", bytes: quote({ currency: "SGD" }), action: { type: "check_only" }, actor: s.marcus });
  const engine = s.app.fixes.proposeFromRun(first.run_id!);
  assert.equal(engine.length, 1);
  assert.equal(engine[0]!.source, "engine");
  assert.deepEqual(s.app.fixes.proposeFromRun(first.run_id!), [], "idempotent per check and rule");
  const preview = s.app.fixes.preview(engine[0]!.fix_id);
  assert.ok(preview.diff.available && preview.diff.passages.some((x) => x.kind === "added" && x.after!.text === "Prices exclude GST"));
  const artifactId = s.app.checks.getRun(first.run_id!).artifact.artifact_id;
  assert.equal(s.app.checks.versions(artifactId).length, 1, "a proposal is not a version");
  const client = s.app.fixes.proposeContent({ project_id: p, name: "Q.md", bytes: quote({ currency: "SGD", extra: "Prices exclude GST" }), summary: "add the GST line" }, agent);
  assert.equal(client.source, "client");
  assert.equal(s.app.ledger.byRef("fix_id", client.fix_id)[0]!.actor.kind, "agent");
  assert.throws(() => s.app.fixes.apply(client.fix_id, agent), PermissionDenied);
  const applied = s.app.fixes.apply(client.fix_id, s.marcus);
  assert.equal(applied.version.version_seq, 2);
  const change = s.app.ledger.byRef("fix_id", client.fix_id).find((e) => e.type === "change.recorded")!;
  assert.deepEqual([change.actor.id, change.payload!.attribution, change.payload!.applied_fix], [s.marcus.id, "declared", client.fix_id]);
  // The engine's proposal was for version 1: stale now, refused, nothing applied.
  assert.equal(code(() => s.app.fixes.apply(engine[0]!.fix_id, s.marcus)), "stale_proposal");
  assert.equal(s.app.fixes.get(engine[0]!.fix_id).status, "superseded");
  const recheck = s.app.checks.recheckLatest(artifactId, { type: "check_only" }, s.marcus, "after applying a proposal");
  assert.equal(s.app.checks.getRun(recheck.run_id!).results[0]!.outcome, "pass");
  assert.equal(s.app.checks.getRun(recheck.run_id!).trigger.kind, "auto_recheck");
});

/** A Ready release with a receipt for version 1 of a quote, routed to a local release folder. */
function releaseReady(folder: string) {
  const s = scenario(null);
  const p = s.project.project_id;
  assert.throws(() => s.app.gateway.setReleaseFolder(p, "relative/folder", "self", s.marcus), /absolute path/);
  assert.throws(() => s.app.gateway.setReleaseFolder(p, join(folder, "missing"), "self", s.marcus), /does not exist/);
  assert.throws(() => s.app.gateway.setReleaseFolder(p, folder, "self", agent), PermissionDenied);
  s.app.gateway.setReleaseFolder(p, folder, "self", s.marcus);
  assert.deepEqual(s.app.gateway.coverage(p).filter((c) => c.action === "release").map((c) => [c.label, c.adapter_id, c.simulated]), [["GATED", "adp_RELEASEDIR", false]]);
  const out = s.app.checks.check({ project_id: p, name: "Kestrel Quote.md", bytes: quote({ currency: "SGD" }), action: { type: "release" }, actor: s.marcus });
  assert.ok(out.receipt_id);
  const req = s.app.gateway.requestAction({ receipt_id: out.receipt_id!, type: "release" }, agent).request;
  return { ...s, p, receiptId: out.receipt_id!, actionId: req.action_id };
}

test("AT-C9 / AT-E1: an edit after approval pauses the release; the person chooses; only the checked bytes are ever copied", () => {
  const folder = tmpDir();
  const s = releaseReady(folder);
  s.app.gateway.approve(s.actionId, s.marcus);
  // The file is edited (a newer version is seen) before execution.
  s.app.checks.observe({ project_id: s.p, name: "Kestrel Quote.md", bytes: quote({ currency: "SGD", total: "1.00" }) });
  assert.equal(s.app.gateway.execute(s.actionId, s.marcus).status, "paused_newer_version");
  assert.deepEqual(readdirSync(folder), [], "nothing was released");
  assert.throws(() => s.app.gateway.chooseVersion(s.actionId, "approved_version", agent), PermissionDenied);
  s.app.gateway.chooseVersion(s.actionId, "approved_version", s.marcus);
  const done = s.app.gateway.execute(s.actionId, s.marcus);
  assert.equal(done.status, "executed");
  assert.deepEqual(readdirSync(folder), ["Kestrel Quote.v1.md"]);
  const receipt = s.app.gateway.getReceipt(s.receiptId);
  assert.equal(sha256(readFileSync(join(folder, "Kestrel Quote.v1.md"))), receipt.artifact.content_hash, "the released copy is exactly the checked version");
  assert.equal(done.execution!.executed_content_hash, receipt.artifact.content_hash);
  assert.equal(receipt.status, "consumed");
  assert.equal(code(() => s.app.gateway.execute(s.actionId, s.marcus)), "not_approved", "single use");
  // A yet newer version after the choice pauses again (the choice was for one exact newer version).
  const t = releaseReady(tmpDir());
  t.app.gateway.approve(t.actionId, t.marcus);
  t.app.checks.observe({ project_id: t.p, name: "Kestrel Quote.md", bytes: quote({ currency: "SGD", total: "2.00" }) });
  t.app.gateway.execute(t.actionId, t.marcus);
  t.app.gateway.chooseVersion(t.actionId, "approved_version", t.marcus);
  t.app.checks.observe({ project_id: t.p, name: "Kestrel Quote.md", bytes: quote({ currency: "SGD", total: "3.00" }) });
  assert.equal(t.app.gateway.execute(t.actionId, t.marcus).status, "paused_newer_version");
});

test("AT-C9: choosing the newer version cancels the request and rechecks the newer version; existing files are never overwritten", () => {
  const folder = tmpDir();
  const s = releaseReady(folder);
  s.app.gateway.approve(s.actionId, s.marcus);
  const artifactId = s.app.gateway.getAction(s.actionId).artifact_id;
  s.app.checks.observe({ project_id: s.p, name: "Kestrel Quote.md", bytes: quote({ currency: "SGD", extra: "Delivery in two weeks." }) });
  s.app.gateway.execute(s.actionId, s.marcus);
  assert.equal(s.app.gateway.chooseVersion(s.actionId, "newer_version", s.marcus).status, "cancelled");
  const recheck = s.app.checks.recheckLatest(artifactId, { type: "release" }, s.marcus, "the person chose the newer version");
  assert.equal(s.app.checks.getRun(recheck.run_id!).artifact.version_seq, 2);
  assert.ok(recheck.receipt_id, "a fresh receipt for the newer version; it needs its own request and approval");
  const req = s.app.gateway.requestAction({ receipt_id: recheck.receipt_id!, type: "release" }, s.marcus).request;
  s.app.gateway.approve(req.action_id, s.marcus);
  writeFileSync(join(folder, "Kestrel Quote.v2.md"), "someone else's file");
  const failed = s.app.gateway.execute(req.action_id, s.marcus);
  assert.equal(failed.status, "failed");
  assert.match(failed.status_reason ?? "", /already exists .* nothing was overwritten/);
  assert.equal(readFileSync(join(folder, "Kestrel Quote.v2.md"), "utf8"), "someone else's file");
});

test("AT-C3: a pending request survives assistant and service restart; a fresh hello returns the brief; a check that did not complete left nothing", async () => {
  const dir = tmpDir();
  const open = (): TestApp => createApp({ dbPath: join(dir, "workspace.db"), signingKeyPath: join(dir, "signing-key.pem"), clock: new FixedClock(T0), workspaceId: "ws_TEST0001", localUserId: "usr_MARCUS01" }) as TestApp;
  let app = open();
  const s = scenario(null, { app, folder: join(dir, "Proposals") });
  s.app.authoring.create({ project_id: s.project.project_id, template: { template: "required_field", field: "quote.reference" } }, s.marcus);
  const ruleId = app.rules.listAll()[0]!.rule_id;
  app.rules.approveAndActivate(ruleId, s.marcus, { trial: true });
  app.gateway.setActionPolicy(s.project.project_id, "release", "self", s.marcus);
  const ok = app.checks.check({ project_id: s.project.project_id, name: "Q.md", bytes: quote({ currency: "SGD" }), action: { type: "release" }, actor: agent });
  const pending = app.gateway.requestAction({ receipt_id: ok.receipt_id!, type: "release" }, agent).request;
  // A check that crashes half-way: its transaction leaves no run and no receipt.
  const runsBefore = get<{ n: number }>(app.db, "SELECT COUNT(*) AS n FROM runs")!.n;
  const append = app.ledger.append.bind(app.ledger);
  app.ledger.append = (input) => {
    if (input.type === "run.completed") throw new Error("simulated crash during a check");
    return append(input);
  };
  assert.throws(() => app.checks.check({ project_id: s.project.project_id, name: "Q3.md", bytes: quote({ currency: "SGD", total: "9.00" }), action: { type: "release" }, actor: agent }), /simulated crash/);
  app.close();

  app = open();
  assert.equal(get<{ n: number }>(app.db, "SELECT COUNT(*) AS n FROM runs")!.n, runsBefore);
  assert.equal(get<{ n: number }>(app.db, "SELECT COUNT(*) AS n FROM receipts r LEFT JOIN runs u ON u.run_id = r.run_id WHERE u.run_id IS NULL")!.n, 0, "no receipt without a completed run");
  const server = await startServer(app, { host: "127.0.0.1", port: 0 });
  try {
    const hello = await (await fetch(server.url + "/api/v1/hello", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ location: { kind: "path", value: join(dir, "Proposals", "Q.md") }, session_id: "ses_RESTART01" }) })).json() as any;
    assert.equal(hello.resolution.status, "resolved");
    assert.equal(hello.brief.in_scope_rule_count, 1);
    const status = await (await fetch(`${server.url}/api/v1/status/action/${pending.action_id}`)).json() as any;
    assert.equal(status.status, "awaiting_approval", "still pending in the app; nothing was approved or executed by the restart");
    assert.equal(app.gateway.receiptStanding(ok.receipt_id!).usable, true, "the receipt key persisted with the store");
  } finally {
    await server.close();
    app.close();
  }
  assert.ok(existsSync(join(dir, "signing-key.pem")));
});
