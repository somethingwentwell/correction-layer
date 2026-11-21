import assert from "node:assert/strict";
import { test } from "node:test";
import { all, get } from "../src/store/db.ts";
import { draftAndCorrect, quote, scenario } from "./helpers.ts";

const SGD_SENTENCE = "No, Kestrel's quotes must always be in SGD.";

test("AT-L8 scoped low-risk auto-add: only under a person's learning policy, only with real failing and passing evidence", () => {
  const s = scenario("auto_low_risk");
  const { app, project } = s;
  // Three earlier quotes already in SGD: held-out work nobody complained about.
  for (const n of [1, 2, 3]) app.checks.observe({ project_id: project.project_id, name: `Earlier-Quote-${n}.md`, bytes: quote({ currency: "SGD", total: `${n}7,760.00` }) });
  const anchor = draftAndCorrect(s, SGD_SENTENCE);
  const flushed = s.adapter.flush(app.intake);
  assert.equal(flushed.delivered, true);
  assert.deepEqual(flushed.results.map((r) => r.result), ["accepted", "accepted", "accepted"]);

  // Compiled and tested, but NOT on: there is no real passing version yet.
  let queue = app.learning.queue(project.project_id);
  assert.equal(queue.turned_on.length, 0);
  assert.deepEqual(queue.waiting.map((w) => w.reasons), [["no_real_pass"]]);
  const candidate = app.rules.listForProject(project.project_id).find((r) => r.origin.kind === "human_correction")!;
  assert.equal(candidate.status, "candidate");

  // The corrected version appears (the assistant changed it at the person's request).
  app.checks.observe({ project_id: project.project_id, name: "Kestrel-Supply-Quote.md", bytes: quote({ currency: "SGD" }) });
  const rule = app.rules.get(candidate.rule_id);
  assert.equal(rule.status, "active");
  assert.equal(rule.authority?.kind, "delegated_learning");
  assert.equal(rule.authority?.zero_click, true);
  assert.equal(rule.authority?.delegated_by, s.marcus.id);
  assert.equal(rule.scope.level, "project");
  assert.equal(rule.scope.project_id, project.project_id);
  assert.equal(rule.check.kind, "field_in_set");
  assert.deepEqual(rule.check.params, { allowed: ["SGD"] });
  assert.ok(rule.cases.some((c) => c.kind === "negative" && c.artifact_hash === anchor.content_hash), "real blocking example recorded");
  assert.ok(rule.cases.some((c) => c.kind === "positive"), "real allowing example recorded");

  const decision = app.learning.decisions(project.project_id)[0]!;
  assert.equal(decision.outcome, "auto_activate");
  assert.deepEqual(decision.reasons, []);
  assert.equal(decision.model_confidence_used, false);
  assert.equal(decision.evaluation.trigger_case.result, "fail");
  assert.equal(decision.evaluation.heldout.artifacts, 3);
  assert.equal(decision.evaluation.heldout.pass, 3);
  assert.equal(decision.evaluation.generated.counted_as_support, false);
  assert.equal(app.learning.notices(project.project_id).length, 1, "a notice with Undo is shown");
  queue = app.learning.queue(project.project_id);
  assert.equal(queue.turned_on.length, 1);
  assert.equal(queue.funnel.activated, 1);

  // AT-R6 hop by hop, through stored references and caused_by only.
  const events = app.ledger.all();
  const one = (type: string, pred: (e: any) => boolean) => {
    const found = events.find((e) => e.type === type && pred(e));
    assert.ok(found, `missing hop: ${type}`);
    return found;
  };
  const policySet = one("learning.policy_set", (e) => e.actor.kind === "human");
  const signal = one("learning.signal_detected", (e) => e.refs.learning_policy_id === policySet.refs.learning_policy_id && e.seq > policySet.seq);
  const extracted = one("learning.correction_extracted", (e) => e.caused_by.includes(signal.event_id));
  const created = one("rule.candidate_created", (e) => e.caused_by.includes(extracted.event_id));
  const evaluated = events.filter((e) => e.type === "learning.candidate_evaluated" && e.refs.rule_id === created.refs.rule_id).at(-1)!;
  const decided = one("learning.decision_made", (e) => e.caused_by.includes(evaluated.event_id) && e.payload.outcome === "auto_activate");
  const activated = one("rule.activated", (e) => e.caused_by.includes(decided.event_id) && e.refs.rule_id === created.refs.rule_id);
  assert.notEqual(activated.actor.kind, "human", "no person clicked");
  assert.equal(app.ledger.verify().ok, true);

  // The learned rule now does what any rule does: it produces findings.
  const blocked = app.checks.check({ project_id: project.project_id, name: "Kestrel-Addendum-Quote.md", bytes: quote({ currency: "USD", total: "9,999.00" }), action: { type: "release" }, actor: s.priya });
  assert.equal(blocked.verdict, "needs_changes");
  assert.equal(blocked.receipt_id, null);

  // AT-L20: learning created or changed no artifact, approval, action request or execution.
  for (const table of ["action_requests", "approvals", "executions"]) assert.equal(get<{ n: number }>(app.db, `SELECT COUNT(*) AS n FROM ${table}`)!.n, 0, `${table} untouched by learning`);
  assert.equal(all(app.db, "SELECT 1 FROM events WHERE type LIKE 'action.%' AND type NOT IN ('action.blocked')").length, 0);
});

test("without a learning policy nothing is captured for learning and nothing is learned (default Off)", () => {
  const s = scenario(null);
  draftAndCorrect(s, SGD_SENTENCE);
  const flushed = s.adapter.flush(s.app.intake);
  assert.deepEqual(flushed.results.map((r) => r.result), ["accepted", "accepted", "consent_blocked"]);
  assert.equal(get<any>(s.app.db, "SELECT content_text, content_state FROM capture_events WHERE kind = 'user_turn'")!.content_text, null, "content dropped on arrival");
  assert.equal(get<{ n: number }>(s.app.db, "SELECT COUNT(*) AS n FROM signals")!.n, 0);
  assert.equal(s.app.rules.listAll().length, 0);
  assert.equal(s.app.learning.queue(s.project.project_id).not_captured_no_consent, 1, "only a count is kept");
});

test("Undo and Keep are acts of a person (AT-L16)", () => {
  const s = scenario("auto_low_risk");
  draftAndCorrect(s, SGD_SENTENCE);
  s.adapter.flush(s.app.intake);
  s.app.checks.observe({ project_id: s.project.project_id, name: "Kestrel-Supply-Quote.md", bytes: quote({ currency: "SGD" }) });
  const rule = s.app.rules.listForProject(s.project.project_id)[0]!;
  assert.equal(rule.status, "active");
  assert.throws(() => s.app.rules.retire(rule.rule_id, { kind: "system", id: "sys_LEARNING" }, "auto"), /done by a person/);
  assert.throws(() => s.app.rules.confirm(rule.rule_id, { kind: "agent", id: "agt_ASSIST01" }), /done by a person/);
  const kept = s.app.rules.confirm(rule.rule_id, s.priya);
  assert.equal(kept.authority?.kind, "individual_approval");
  assert.equal(kept.authority?.confirmed?.by, s.priya.id);
  const undone = s.app.rules.retire(rule.rule_id, s.priya, "undone");
  assert.equal(undone.status, "retired");
  assert.ok(s.app.ledger.byRef("rule_id", rule.rule_id).length >= 4, "history intact");
});
