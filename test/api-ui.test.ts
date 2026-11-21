import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { RunningServer } from "../src/api/server.ts";
import { HUMAN_ONLY_OPERATIONS, startServer } from "../src/api/server.ts";
import { loadConfig } from "../src/config.ts";
import { seedDemo } from "../src/seed/demo.ts";
import { get } from "../src/store/db.ts";
import type { TestApp } from "./helpers.ts";
import { makeApp, quote } from "./helpers.ts";

let app: TestApp;
let server: RunningServer;
let projectId: string;

const api = async (path: string, body?: unknown): Promise<{ status: number; json: any }> => {
  const res = await fetch(server.url + path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
};
const page = async (path: string): Promise<{ status: number; text: string }> => {
  const res = await fetch(server.url + path, { redirect: "manual" });
  return { status: res.status, text: await res.text() };
};
const form = async (path: string, fields: Record<string, string>, csrf: string | null = server.csrf): Promise<{ status: number; location: string | null }> => {
  const res = await fetch(server.url + path, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ...(csrf ? { _csrf: csrf } : {}), ...fields }) });
  await res.text();
  return { status: res.status, location: res.headers.get("location") };
};

before(async () => {
  app = makeApp();
  const seeded = seedDemo(app);
  projectId = seeded.project_id!;
  server = await startServer(app, { host: "127.0.0.1", port: 0 });
});
after(async () => {
  await server.close();
  app.close();
});

test("the service starts on loopback and answers the health endpoint", async () => {
  const { status, json } = await api("/healthz");
  assert.equal(status, 200);
  assert.equal(json.status, "ok");
  assert.equal(json.schema_version, 2);
  assert.ok(json.ledger_head_seq > 0);
  assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.throws(() => loadConfig({ CL_HOST: "0.0.0.0" }), /loopback/, "the service refuses to listen on a network interface");
  assert.throws(() => loadConfig({ CL_DISPLAY_TZ: "Mars/Olympus" }), /IANA timezone/);
  assert.equal(loadConfig({ CL_DATA_DIR: "/tmp/x", CL_PORT: "5000" }).dbPath, "/tmp/x/workspace.db");
});

test("every designed screen has a route that renders from real data (UI shell)", async () => {
  const rule = app.rules.listForProject(projectId).find((r) => r.authority?.kind === "delegated_learning")!;
  const runs = app.checks.listRuns({ project_id: projectId });
  const routes: Array<[string, RegExp]> = [
    ["/", /All projects/],
    ["/onboarding", /Get started/],
    [`/projects/${projectId}`, /Recent work[\s\S]*Rules that apply here[\s\S]*Trusted sources[\s\S]*What is enforced here[\s\S]*Learning[\s\S]*Recent activity/],
    [`/projects/${projectId}/rules`, /Apply here \(3\)/],
    [`/rules/${rule.rule_id}?project=${projectId}`, /Added automatically - no click[\s\S]*Original correction[\s\S]*must always be in SGD[\s\S]*Examples[\s\S]*History/],
    [`/projects/${projectId}/activity`, /Activity/],
    [`/runs/${runs[0]!.run_id}`, /Every rule in scope[\s\S]*What happens next/],
    [`/traces/${runs[0]!.trace_id}`, /Timeline of a piece of work[\s\S]*CHECKED[\s\S]*CHANGED/],
    [`/compare?before=${runs[1]!.run_id}&after=${runs[0]!.run_id}`, /Findings resolved after the change \([1-9]/],
    [`/projects/${projectId}/learning`, /Captured[\s\S]*Needs you \(1\)[\s\S]*Turned on by itself \(1\)[\s\S]*Not learned \(3\)/],
    [`/projects/${projectId}/learning/settings`, /Learn and enforce[\s\S]*Whose corrections count[\s\S]*Never automatic/],
    [`/projects/${projectId}/learning/added`, /Rules that turned on without a click[\s\S]*Why safe[\s\S]*Considered and not turned on/],
    [`/projects/${projectId}/learning/timeline/${rule.rule_id}`, /PERMITTED[\s\S]*IDENTIFIED[\s\S]*COMPILED[\s\S]*TESTED[\s\S]*DECIDED[\s\S]*ON[\s\S]*TRIGGERED/],
    [`/projects/${projectId}/capture`, /CAPTURED[\s\S]*RELAYED[\s\S]*NOT CAPTURED[\s\S]*Streams \(1\)/],
    [`/projects/${projectId}/coverage`, /GATED[\s\S]*SIMULATED[\s\S]*NOT COVERED/],
    [`/projects/${projectId}/effectiveness`, /Not available in this build[\s\S]*Plain counts|plain counts/],
    ["/history", /History verifies/],
  ];
  for (const [path, expected] of routes) {
    const { status, text } = await page(path);
    assert.equal(status, 200, path);
    assert.match(text, expected, path);
    assert.match(text, /DEMO DATA\./, `${path}: demo data is labelled on every screen`);
    assert.match(text, /Phase 1 framework scaffold/, path);
  }
  const missing = await page("/projects/prj_DOESNOTEXIST");
  assert.equal(missing.status, 404);
  assert.match(missing.text, /was not found/);
  assert.equal((await page("/assets/app.css")).status, 200);
  // Content is escaped: a rule title can never inject markup.
  app.rules.createCandidate({ ...(await import("./helpers.ts")).ruleContent(app, { rule_id: "rul_XSSTEST1", title: "<script>alert(1)</script>", cases: [] }) }, app.localUser);
  const listing = await page(`/projects/${projectId}/rules`);
  assert.ok(!listing.text.includes("<script>alert(1)"));
  assert.ok(listing.text.includes("&lt;script&gt;alert(1)"));
});

test("AT-E6: every client response carries its enforcement tier; summaries begin \"Advisory check\"", async () => {
  const hello = await api("/api/v1/hello", { client: { name: "example-assistant" }, location: { kind: "path", value: "/demo/Proposals/Kestrel Dental Group/New.md" } });
  assert.equal(hello.json.enforcement_tier, "advisory");
  assert.equal(hello.json.resolution.status, "resolved");
  assert.equal(hello.json.brief.in_scope_rule_count, 3);
  assert.match(hello.json.brief.learning_notice, /Learning is on for this project/);
  assert.ok(hello.json.coverage.some((c: any) => c.action === "release" && c.label === "GATED" && c.simulated === true));
  const unknown = await api("/api/v1/hello", { location: { kind: "path", value: "/somewhere/unregistered" } });
  assert.equal(unknown.json.resolution.status, "unknown");
  assert.equal(unknown.json.brief, null);

  const check = await api("/api/v1/check", { artifact: { kind: "path", value: "/demo/Proposals/Kestrel Dental Group/Api-Quote.md", content_text: new TextDecoder().decode(quote({ currency: "USD" })) }, action: { type: "release" }, session_id: "ses_APITEST01" });
  assert.equal(check.status, 200);
  assert.equal(check.json.enforcement_tier, "advisory");
  assert.equal(check.json.verdict, "needs_changes");
  assert.match(check.json.human_summary, /^Advisory check: Needs changes\./);
  assert.equal(check.json.receipt_id, null);
  assert.equal(check.json.context.project_id, projectId);
  const status = await api(`/api/v1/status/run/${check.json.run_id}`);
  assert.equal(status.json.verdict, "needs_changes");
  const rules = await api("/api/v1/list_rules", { project_id: projectId });
  assert.equal(rules.json.rules.length, 3);
  const caps = await api("/api/v1/capabilities");
  assert.equal(caps.json.client_pairing, "unavailable");
  assert.ok(caps.json.action_adapters.every((a: any) => a.simulated || a.availability === "unavailable"), "no real action adapter exists in this build");
  assert.equal((await api("/api/v1/ledger/verify")).json.ok, true);
});

test("AT-E3 over HTTP: no client operation can approve, activate, set a learning policy or execute; unsupported operations say so", async () => {
  const before = app.ledger.all().length;
  for (const op of HUMAN_ONLY_OPERATIONS) {
    const res = await api(`/api/v1/${op}`, { rule_id: "rul_DEMOPRICE", action_id: "act_X000001", project_id: projectId, mode: "auto_low_risk" });
    assert.equal(res.status, 403, op);
    assert.equal(res.json.error.code, "human_only", op);
  }
  const unsupported = await api("/api/v1/report_change", {});
  assert.equal(unsupported.status, 501);
  assert.deepEqual([unsupported.json.error.code, unsupported.json.error.details.contract], ["unavailable", "api.report_change"]);
  assert.equal((await api("/api/v1/does_not_exist", {})).status, 404);
  assert.equal((await fetch(server.url + "/api/v1/check", { method: "POST", body: "{not json" })).status, 422);
  // The app surface refuses requests without the form token (a client imitating a form post).
  const rule = app.rules.listForProject(projectId).find((r) => r.authority?.kind === "delegated_learning")!;
  for (const path of [`/app/rules/${rule.rule_id}/retire`, `/app/projects/${projectId}/learning`, "/app/actions/act_X000001/approve", "/app/actions/act_X000001/execute"]) {
    assert.equal((await form(path, { mode: "off" }, null)).status, 403, path);
    assert.equal((await form(path, { mode: "off" }, "wrong-token")).status, 403, path);
  }
  assert.equal(app.rules.get(rule.rule_id).status, "active");
  assert.equal(app.policies.current(projectId)!.mode, "auto_low_risk");
  assert.equal(app.ledger.all().length, before, "none of the refused calls changed anything");
});

test("relay and capture over HTTP: RELAYED reaches the inbox at most; unpaired adapters are refused", async () => {
  const relay = await api("/api/v1/propose_correction", { project_id: projectId, text: "The user wants every quote to state the incoterms.", session_id: "ses_APITEST01" });
  assert.equal(relay.status, 200);
  assert.deepEqual([relay.json.capture_label, relay.json.status], ["RELAYED", "inbox"]);
  const hidden = await api("/api/v1/propose_correction", { project_id: projectId, text: "Please quote 12 flow sensors with calibration." });
  assert.deepEqual([hidden.json.status, hidden.json.reason], ["discarded", "untrusted_origin"], "relayed text that matches a document is discarded");
  const refused = await api("/api/v1/capture/hello", { adapter_id: "adp_NOTPAIRED", stream_id: "str_HTTPTEST01", last_seq: 0 });
  assert.equal(refused.status, 403);
  assert.equal(refused.json.error.code, "adapter_not_paired");
  const hello = await api("/api/v1/capture/hello", { adapter_id: "adp_DEMOHOOK1", stream_id: "str_HTTPTEST01", last_seq: 0 });
  assert.deepEqual([hello.status, hello.json.cursor], [200, 0]);
  const bad = await api("/api/v1/capture/deliver", { adapter_id: "adp_DEMOHOOK1", stream_id: "str_HTTPTEST01", events: [{ event: { source_seq: 1, stream_id: "str_HTTPTEST01", kind: "mind_reading" } }] });
  assert.deepEqual([bad.json.results[0].result, bad.json.cursor], ["dead_letter", 1]);
});

test("the designed journey through the app surface: blocked, fixed, rechecked, requested, approved, released (simulated)", async () => {
  const check = (currency: string) => form(`/app/projects/${projectId}/check`, { name: "Journey-Quote.md", action: "release", content: new TextDecoder().decode(seedQuote(currency)) });
  const blocked = await check("USD");
  assert.equal(blocked.status, 303);
  const blockedPage = await page(blocked.location!);
  assert.match(blockedPage.text, /\[X\] Needs changes/);
  assert.match(blockedPage.text, /Currency is not SGD/);
  assert.ok(!/Request release/.test(blockedPage.text), "no way to release a blocked version");
  const fixed = await check("SGD");
  const fixedPage = await page(fixed.location!);
  assert.match(fixedPage.text, /\[OK\] Ready/);
  assert.match(fixedPage.text, /It is evidence, not permission/);
  const runId = fixed.location!.split("/").pop()!;
  const compare = await page(`/compare?before=${blocked.location!.split("/").pop()}&after=${runId}`);
  assert.match(compare.text, /The check did not change the file/);
  const receiptId = app.checks.getRun(runId).receipt_id!;
  const requested = await form(`/app/receipts/${receiptId}/request`, { type: "release" });
  assert.match(requested.location!, /^\/actions\/act_/);
  const review = await page(requested.location!);
  assert.match(review.text, /What the check decided[\s\S]*What you are deciding[\s\S]*A pass is not permission/);
  const actionId = requested.location!.split("/").pop()!;
  assert.equal(app.gateway.getAction(actionId).status, "awaiting_approval");
  await form(`/app/actions/${actionId}/approve`, {});
  assert.equal(app.gateway.getAction(actionId).status, "approved");
  assert.equal(get<{ n: number }>(app.db, "SELECT COUNT(*) AS n FROM executions")!.n, 0, "approving does not execute");
  await form(`/app/actions/${actionId}/execute`, {});
  const done = app.gateway.getAction(actionId);
  assert.equal(done.status, "executed");
  assert.equal(done.execution!.simulated, true);
  assert.match((await page(`/actions/${actionId}`)).text, /SIMULATED: nothing left the workspace store/);
  // AT-O6: detection only by the engine, approval only by a person, execution only by an adapter.
  const trace = app.ledger.byRef("action_id", actionId);
  assert.equal(trace.find((e) => e.type === "action.approved")!.actor.kind, "human");
  assert.equal(trace.find((e) => e.type === "action.executed")!.actor.kind, "adapter");
  assert.ok(app.ledger.all().filter((e) => e.type === "run.completed").every((e) => e.actor.id === "sys_ENGINE01"));
  assert.equal(app.ledger.verify().ok, true);
});

function seedQuote(currency: string): Uint8Array {
  // List prices from the DEMO price list, so only the currency rule differs between the two versions.
  const price = currency === "SGD" ? ["1,650.00", "400.00", "3,300.00", "800.00", "4,100.00"] : ["1,240.00", "300.00", "2,480.00", "600.00", "3,080.00"];
  return new TextEncoder().encode(`# Journey quote\n\nCustomer: Kestrel Dental Group\nQuote reference: KQ-TEST-1\nValid until: 12 January 2027\n\n| Item | Qty | Unit price | Amount |\n|---|---|---|---|\n| HX-200 Flow Sensor | 2 | ${currency} ${price[0]} | ${currency} ${price[2]} |\n| CAL-1Y Calibration Plan | 2 | ${currency} ${price[1]} | ${currency} ${price[3]} |\n| Total | | | ${currency} ${price[4]} |\n`);
}
