import assert from "node:assert/strict";
import { test } from "node:test";
import { digestOf } from "../src/domain/canonical.ts";
import { get } from "../src/store/db.ts";
import { activeRule, makeApp, quote, ruleContent, scenario } from "./helpers.ts";

const scopeOf = (app: ReturnType<typeof makeApp>, over: Record<string, unknown>) => ({ ...ruleContent(app, { rule_id: "rul_X00001" }).scope, ...over }) as any;

test("AT-G1 (scaled): mandatory rules are selected deterministically by index - exactly the in-scope set, every one evaluated", () => {
  const s = scenario(null);
  const { app } = s;
  const other = app.projects.createProject({ name: "Other project (TEST)", default_work_type: "sales_proposal" }, s.marcus);
  // 240 active rules, of which by construction exactly 80 are in scope for (project, sales_proposal, document, release).
  const expected: string[] = [];
  for (let i = 0; i < 240; i++) {
    const id = `rul_G1N${String(i).padStart(5, "0")}`;
    const kind = i % 6;
    const scope =
      kind === 0 ? scopeOf(app, {}) // workspace, any action: in scope
      : kind === 1 ? scopeOf(app, { level: "project", project_id: s.project.project_id, actions: ["release"] }) // in scope
      : kind === 2 ? scopeOf(app, { level: "project", project_id: other.project_id }) // another project
      : kind === 3 ? scopeOf(app, { work_types: ["vendor_payment"] }) // another work type
      : kind === 4 ? scopeOf(app, { actions: ["send_external"] }) // another action
      : scopeOf(app, { artifact_types: ["spreadsheet"] }); // another artifact type
    // Unique targets so no two rules are structurally comparable.
    activeRule(app, { rule_id: id, title: `Rule ${i}`, scope, check: { kind: "field_present", targets: [`quote.extra_${i}`], params: {} }, requires: { fields: [], components: [] } });
    if (kind === 0 || kind === 1) expected.push(id);
  }
  const query = { project_id: s.project.project_id, area_ids: [], artifact_id: null, work_type: "sales_proposal", artifact_type: "document", action: "release" };
  const selection = app.rules.selectInScope(query);
  assert.deepEqual(selection.rules.map((r) => r.content.rule_id), [...expected].sort());
  assert.equal(selection.in_scope, 80);
  assert.equal(selection.workspace_active_rules, 240);
  // The digest equals one computed independently from the seed.
  const independent = digestOf({ rules: [...expected].sort().map((id) => [id, 1]), exceptions: [] });
  assert.equal(selection.ruleset_digest, independent);
  // Same inputs, same selection: nothing ranks, samples or trims.
  assert.deepEqual(app.rules.selectInScope(query), selection);

  const out = app.checks.check({ project_id: s.project.project_id, name: "q.md", bytes: quote({ currency: "SGD" }), action: { type: "release" }, actor: s.marcus });
  const run = app.checks.getRun(out.run_id!);
  assert.equal(run.results.length, 80, "every in-scope rule has a result");
  assert.deepEqual(run.results.map((r) => r.rule_id), [...expected].sort());
  assert.equal(run.inventory.in_scope, 80);
  assert.equal(run.policy.ruleset_digest, independent);

  // AT-G3: every other active rule is in the inventory with the excluding dimension, and the counts sum.
  const inventory = app.rules.outOfScope(query);
  assert.equal(inventory.length + selection.in_scope, selection.workspace_active_rules);
  const by = (d: string) => inventory.filter((o) => o.excluded_by === d).length;
  assert.deepEqual([by("project"), by("work_type"), by("action"), by("artifact_type")], [40, 40, 40, 40]);
  assert.ok(inventory.filter((o) => o.excluded_by === "project").every((o) => !o.visible), "other projects' rules are counted, not shown");
});

test("AT-G7: the brief may be shortened; the check never is", async () => {
  const { buildRoutes } = await import("../src/api/server.ts");
  const s = scenario(null);
  for (let i = 0; i < 60; i++) activeRule(s.app, { rule_id: `rul_G7N${String(i).padStart(5, "0")}`, check: { kind: "field_present", targets: [`quote.extra_${i}`], params: {} }, requires: { fields: [], components: [] } });
  const hello = buildRoutes(s.app, "t").find((r) => r.method === "POST" && r.pattern.test("/api/v1/hello"))!;
  const response = hello.handler({ body: { location: { kind: "project", value: s.project.project_id } }, params: {}, url: new URL("http://x/"), req: null as any, res: null as any }) as any;
  assert.equal(response.brief.in_scope_rule_count, 60, "the exact count is always given");
  assert.equal(response.brief.truncated, true);
  assert.equal(response.brief.rules.length, 50);
  const out = s.app.checks.check({ project_id: s.project.project_id, name: "q.md", bytes: quote(), action: { type: "release" }, actor: s.marcus });
  assert.equal(s.app.checks.getRun(out.run_id!).results.length, 60);
});

test("AT-C1 / AT-I3: byte-identical files in two projects get each project's own rules; nothing leaks across", () => {
  const a = scenario(null, { name: "Project A (TEST)", folder: "/test/a" });
  const { app } = a;
  const b = app.projects.createProject({ name: "Project B (TEST)", default_work_type: "sales_proposal", folder: "/test/b" }, a.marcus);
  activeRule(app, { rule_id: "rul_ONLYINA1", title: "A wants SGD", scope: scopeOf(app, { level: "project", project_id: a.project.project_id }) });
  activeRule(app, { rule_id: "rul_ONLYINB1", title: "CANARY-B wants USD", scope: scopeOf(app, { level: "project", project_id: b.project_id }), check: { kind: "field_in_set", targets: ["quote.line_items[*].currency", "quote.total.currency"], params: { allowed: ["USD"] } } });
  const bytes = quote({ currency: "USD" });
  const inA = app.checks.check({ path: "/test/a/Quote.md", name: "Quote.md", bytes, action: { type: "release" }, actor: a.marcus });
  const inB = app.checks.check({ path: "/test/b/sub/Quote.md", name: "Quote.md", bytes, action: { type: "release" }, actor: a.marcus });
  const [runA, runB] = [app.checks.getRun(inA.run_id!), app.checks.getRun(inB.run_id!)];
  assert.deepEqual(runA.results.map((r) => r.rule_id), ["rul_ONLYINA1"]);
  assert.deepEqual(runB.results.map((r) => r.rule_id), ["rul_ONLYINB1"]);
  assert.equal(inA.verdict, "needs_changes");
  assert.equal(inB.verdict, "ready");
  assert.deepEqual(runA.context.basis, ["binding", "default_work_type"], "the basis of resolution is recorded");
  assert.equal(runA.artifact.content_hash, runB.artifact.content_hash);
  assert.notEqual(runA.artifact.artifact_id, runB.artifact.artifact_id);
  // AT-I4: the receipt for B's copy is bound to B; A has none.
  assert.equal(inA.receipt_id, null);
  assert.equal(app.gateway.getReceipt(inB.receipt_id!).project_id, b.project_id);
  // What project A can list never contains B's rule.
  assert.ok(!JSON.stringify(app.rules.listForProject(a.project.project_id)).includes("CANARY-B"));
  assert.ok(!JSON.stringify(app.learning.queue(a.project.project_id)).includes("CANARY-B"));
  // Unknown origin: no run, no receipt, an explicit question (AT-C6, first half).
  const nowhere = app.checks.check({ path: "/somewhere/else/Quote.md", name: "Quote.md", bytes, action: { type: "release" }, actor: a.marcus });
  assert.equal(nowhere.run_id, null);
  assert.equal(nowhere.verdict, null);
  assert.equal(nowhere.context.status, "unknown");
  assert.match(nowhere.human_summary, /^Advisory check: not checked/);
});

test("AT-C2: one session moving between projects is told the context changed, and the right rules ran", () => {
  const a = scenario(null, { name: "A (TEST)", folder: "/test/a" });
  const b = a.app.projects.createProject({ name: "B (TEST)", default_work_type: "sales_proposal", folder: "/test/b" }, a.marcus);
  activeRule(a.app, { rule_id: "rul_ONLYINB1", scope: scopeOf(a.app, { level: "project", project_id: b.project_id }) });
  const agent = { kind: "agent" as const, id: "agt_ASSIST01", session_id: "ses_ONE00001" };
  const first = a.app.checks.check({ path: "/test/a/q.md", name: "q.md", bytes: quote(), action: { type: "release" }, actor: agent });
  const second = a.app.checks.check({ path: "/test/b/q.md", name: "q.md", bytes: quote(), action: { type: "release" }, actor: agent });
  assert.equal(first.context.context_changed, false);
  assert.equal(second.context.context_changed, true);
  assert.equal(second.context.project_id, b.project_id);
  assert.deepEqual(a.app.checks.getRun(second.run_id!).results.map((r) => r.rule_id), ["rul_ONLYINB1"]);
});

test("AT-C11: a rule scoped to a project fact follows the fact; changing the fact advances the policy revision and lapses receipts", () => {
  const s = scenario(null);
  const { app } = s;
  const other = app.projects.createProject({ name: "Other (TEST)", default_work_type: "sales_proposal", facts: { customer_id: "cust_other" } }, s.marcus);
  app.gateway.setActionPolicy(s.project.project_id, "release", "self", s.marcus);
  activeRule(app, { rule_id: "rul_CUSTFACT", scope: scopeOf(app, { level: "project_group", project_selector: { fact: "customer_id", equals: "cust_kestrel" } }) });
  const inScope = (projectId: string) => app.rules.selectInScope({ project_id: projectId, area_ids: [], artifact_id: null, work_type: "sales_proposal", artifact_type: "document", action: "release" }).rules.length;
  assert.equal(inScope(s.project.project_id), 1);
  assert.equal(inScope(other.project_id), 0);
  const ready = app.checks.check({ project_id: s.project.project_id, name: "q.md", bytes: quote({ currency: "SGD" }), action: { type: "release" }, actor: s.marcus });
  assert.equal(app.gateway.receiptStanding(ready.receipt_id!).usable, true);
  const before = app.rules.policyRev();
  app.projects.setFact(s.project.project_id, "customer_id", "cust_renamed", s.marcus);
  assert.equal(app.rules.policyRev(), before + 1);
  assert.equal(inScope(s.project.project_id), 0, "the rule no longer reaches the project");
  const standing = app.gateway.receiptStanding(ready.receipt_id!);
  assert.equal(standing.usable, false, "the in-scope rule set changed, so the receipt no longer validates");
  assert.deepEqual(standing.failed.map((f) => f.step), [6]);
  assert.throws(() => app.projects.setFact(s.project.project_id, "customer_id", "x", { kind: "agent", id: "agt_ASSIST01" }), /done by a person/);
  assert.equal(get<any>(app.db, "SELECT value FROM project_facts WHERE project_id = ? AND key = 'customer_id'", s.project.project_id)!.value, "cust_renamed");
});
