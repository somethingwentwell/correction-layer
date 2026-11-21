/**
 * Rule management by a person (UX-7, OBS-2): templates, duplicate gate (AT-G4),
 * dry run, real examples, revise, pause with an end date (AT-O3), the narrow
 * automatic pause primitive, and exceptions (AT-E7, AT-I4). FICTIONAL test data.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ClError, PermissionDenied, ValidationError } from "../src/domain/errors.ts";
import type { Scenario } from "./helpers.ts";
import { draftAndCorrect, quote, scenario } from "./helpers.ts";

const agent = { kind: "agent" as const, id: "agt_ASSIST01", display_name: "assistant" };
const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return e instanceof ClError ? e.code : String(e);
  }
  return "no error";
};

/** A project with a USD draft and an SGD version of one quote, and a person-made SGD rule turned on with real examples. */
function withSgdRule(s: Scenario = scenario(null)) {
  const p = s.project.project_id;
  const usd = s.app.checks.observe({ project_id: p, name: "Quote.md", bytes: quote({ currency: "USD" }) });
  const sgd = s.app.checks.observe({ project_id: p, name: "Quote.md", bytes: quote({ currency: "SGD" }) });
  const rule = s.app.authoring.create({ project_id: p, template: { template: "currency", currency: "SGD" }, words: "Kestrel quotes are always in SGD" }, s.marcus);
  s.app.authoring.addExample(rule.rule_id, { artifact_id: usd.artifact_id, content_hash: usd.content_hash, kind: "negative" }, s.marcus);
  s.app.authoring.addExample(rule.rule_id, { artifact_id: sgd.artifact_id, content_hash: sgd.content_hash, kind: "positive" }, s.marcus);
  s.app.rules.approveAndActivate(rule.rule_id, s.marcus);
  return { ...s, ruleId: rule.rule_id, usd, sgd };
}

test("UX-7: a correction added by hand from plain options - rendered sentence, dry run on real work, real examples, then a separate act turns it on", () => {
  const s = scenario(null);
  const p = s.project.project_id;
  s.app.checks.observe({ project_id: p, name: "A.md", bytes: quote({ currency: "SGD" }) });
  const usd = s.app.checks.observe({ project_id: p, name: "B.md", bytes: quote({ currency: "USD" }) });
  const preview = s.app.authoring.preview({ project_id: p, template: { template: "currency", currency: "SGD" } });
  assert.deepEqual(preview.problems, []);
  assert.equal(preview.content.statement, "Every line in the pricing table, and the total, must be in SGD.");
  assert.deepEqual(preview.dry_run.map((d) => [d.name, d.outcome]), [["A.md", "pass"], ["B.md", "fail"]]);
  assert.equal(s.app.rules.listAll().length, 0, "a preview stores nothing");
  assert.ok(code(() => s.app.authoring.create({ project_id: p, template: { template: "currency", currency: "XYZ" } }, s.marcus)) === "validation_failed");
  assert.throws(() => s.app.authoring.create({ project_id: p, template: { template: "currency", currency: "SGD" } }, agent), PermissionDenied);

  const rule = s.app.authoring.create({ project_id: p, template: { template: "currency", currency: "SGD" }, words: "Always SGD for Kestrel" }, s.marcus);
  assert.equal(rule.status, "candidate");
  assert.equal(rule.owner, s.marcus.id);
  assert.equal(rule.scope.level, "project");
  assert.deepEqual(rule.scope.actions, [], "applies whenever this kind of work is checked");
  const journey = s.app.ledger.byRef("correction_id", rule.origin.correction_id!);
  assert.deepEqual(journey.map((e) => e.type), ["correction.recorded", "rule.candidate_created"]);
  // Must-pass needs a real blocking and a real allowing example.
  assert.equal(code(() => s.app.rules.approveAndActivate(rule.rule_id, s.marcus)), "invariant_violation");
  const sgdA = s.app.checks.latestVersions(p).find((v) => v.name === "A.md")!;
  assert.equal(code(() => s.app.authoring.addExample(rule.rule_id, { artifact_id: sgdA.artifact_id, content_hash: sgdA.content_hash, kind: "negative" }, s.marcus)), "invariant_violation", "an example the rule does not actually block is refused");
  s.app.authoring.addExample(rule.rule_id, { artifact_id: usd.artifact_id, content_hash: usd.content_hash, kind: "negative" }, s.marcus);
  s.app.authoring.addExample(rule.rule_id, { artifact_id: sgdA.artifact_id, content_hash: sgdA.content_hash, kind: "positive" }, s.marcus);
  const on = s.app.rules.approveAndActivate(rule.rule_id, s.marcus);
  assert.equal(on.status, "active");
  assert.deepEqual(on.cases.map((c) => [c.kind, c.last_result]), [["negative", "fail"], ["positive", "pass"]]);
  // Other plain options build valid rules too.
  for (const template of [{ template: "required_field", field: "quote.reference" }, { template: "forbidden_phrase", phrase: "pre-approved" }, { template: "validity_window", min_days: 30 }, { template: "totals_add_up" }, { template: "no_placeholders" }, { template: "required_section", heading: "Terms" }]) {
    assert.deepEqual(s.app.authoring.preview({ project_id: p, template }).problems, [], template.template);
  }
});

test("AT-G4: an overlapping rule is shown before the candidate can be created; saving needs the person to have seen it", () => {
  const s = withSgdRule();
  const p = s.project.project_id;
  let details: any = null;
  try {
    s.app.authoring.create({ project_id: p, template: { template: "currency", currency: "SGD" } }, s.marcus);
  } catch (e) {
    assert.ok(e instanceof ClError && e.code === "overlapping_rules");
    details = e.details;
  }
  assert.deepEqual(details.duplicates.map((d: any) => d.rule_id), [s.ruleId]);
  assert.equal(details.duplicates[0].statement, "Every line in the pricing table, and the total, must be in SGD.");
  // A contradicting currency is a conflict, shown the same way.
  assert.equal(code(() => s.app.authoring.create({ project_id: p, template: { template: "currency", currency: "USD" } }, s.marcus)), "overlapping_rules");
  assert.equal(s.app.authoring.preview({ project_id: p, template: { template: "currency", currency: "USD" } }).conflicts[0]!.rule_id, s.ruleId);
  const before = s.app.rules.listAll().length;
  const created = s.app.authoring.create({ project_id: p, template: { template: "currency", currency: "SGD" } }, s.marcus, [s.ruleId]);
  assert.equal(created.status, "candidate");
  assert.equal(s.app.rules.listAll().length, before + 1);
});

test("revise: a person changes a rule; examples are re-tested; receipts that relied on the old revision lapse", () => {
  const s = withSgdRule();
  const p = s.project.project_id;
  s.app.gateway.setActionPolicy(p, "release", "self", s.marcus);
  const ready = s.app.checks.check({ project_id: p, name: "Quote.md", bytes: quote({ currency: "SGD" }), action: { type: "release" }, actor: s.marcus });
  assert.ok(ready.receipt_id);
  // Changing SGD to EUR breaks both stored examples: refused as must-pass, allowed on trial.
  assert.equal(code(() => s.app.authoring.revise(s.ruleId, { template: { template: "currency", currency: "EUR" } }, s.marcus)), "invariant_violation");
  assert.equal(s.app.rules.get(s.ruleId).revision, 1, "nothing was written");
  const trial = s.app.authoring.revise(s.ruleId, { template: { template: "currency", currency: "EUR" } }, s.marcus, { trial: true });
  assert.deepEqual([trial.revision, trial.status, trial.check.params.allowed], [2, "trial", ["EUR"]]);
  assert.deepEqual(trial.cases.map((c) => c.last_result), ["fail", "fail"], "the examples were re-run on the new revision");
  const standing = s.app.gateway.receiptStanding(ready.receipt_id!);
  assert.equal(standing.usable, false);
  assert.ok(standing.failed.some((f) => f.step === 6));
  const revised = s.app.ledger.byRef("rule_id", s.ruleId).find((e) => e.type === "rule.revised")!;
  assert.equal(revised.actor.id, s.marcus.id);
  assert.equal(revised.payload!.examples_regressed, 1, "the USD draft still fails under EUR; only the SGD version regressed");
  assert.throws(() => s.app.authoring.revise(s.ruleId, { template: { template: "currency", currency: "GBP" } }, agent), PermissionDenied);
});

test("AT-O3: a pause by a person always has an end date; paused rules are out of scope; the pause ends on its date with an event", () => {
  const s = withSgdRule();
  const p = s.project.project_id;
  assert.throws(() => s.app.rules.suspend(s.ruleId, s.marcus, "", "audit"), ValidationError, "no end date: refused");
  assert.throws(() => s.app.rules.suspend(s.ruleId, s.marcus, "2027-06-01", "audit"), ValidationError, "more than 90 days: refused");
  assert.throws(() => s.app.rules.suspend(s.ruleId, s.marcus, "2026-11-17", "audit"), ValidationError, "today is not in the future");
  assert.throws(() => s.app.rules.suspend(s.ruleId, agent, "2026-11-20", "audit"), PermissionDenied);
  s.app.rules.suspend(s.ruleId, s.marcus, "2026-11-20", "customer is re-pricing this week");
  assert.equal(s.app.rules.get(s.ruleId).status, "suspended");
  const during = s.app.checks.check({ project_id: p, name: "Quote.md", bytes: quote({ currency: "USD" }), action: { type: "check_only" }, actor: s.marcus });
  assert.equal(during.counts!.in_scope, 0);
  s.app.clock.set("2026-11-20T00:00:01Z");
  const after = s.app.checks.check({ project_id: p, name: "Quote.md", bytes: quote({ currency: "USD" }), action: { type: "check_only" }, actor: s.marcus });
  assert.equal(after.verdict, "needs_changes", "the rule is back on the date the person set");
  const resumed = s.app.ledger.byRef("rule_id", s.ruleId).find((e) => e.type === "rule.resumed")!;
  assert.equal(resumed.actor.on_behalf_of, s.marcus.id);
  assert.match(resumed.summary, /ended on 2026-11-20, as set/);
  const activity = s.app.ledger.recent({ projectId: p, limit: 100 }).map((e) => e.type);
  assert.ok(activity.includes("rule.suspended") && activity.includes("rule.resumed"));
});

test("automatic pause is narrow: only a learned, unconfirmed rule moves to note only; Resume restores it; approved rules are untouched", () => {
  const s = scenario("auto_low_risk");
  const p = s.project.project_id;
  draftAndCorrect(s, "No, Kestrel's quotes must always be in SGD.");
  s.adapter.flush(s.app.intake);
  s.app.checks.observe({ project_id: p, name: "Kestrel-Supply-Quote.md", bytes: quote({ currency: "SGD" }) });
  const learned = s.app.rules.listForProject(p).find((r) => r.authority?.kind === "delegated_learning")!;
  assert.equal(learned.status, "active");
  const out = s.app.rules.autoPause(learned.rule_id, "disputes", "two documents were disputed.");
  assert.equal(out.paused, true);
  const paused = s.app.rules.get(learned.rule_id);
  assert.equal(paused.status, "trial");
  assert.equal(paused.authority?.auto_paused?.reason, "disputes");
  const check = s.app.checks.check({ project_id: p, name: "Other.md", bytes: quote({ currency: "USD" }), action: { type: "release" }, actor: s.marcus });
  assert.equal(check.verdict, "ready", "in shadow it is a note: it cannot block");
  assert.equal(check.counts!.notes, 1);
  assert.throws(() => s.app.rules.resumeAutoPaused(learned.rule_id, agent), PermissionDenied);
  assert.equal(s.app.rules.resumeAutoPaused(learned.rule_id, s.marcus).status, "active");
  // Kept by a person: never pauses by itself again.
  s.app.rules.confirm(learned.rule_id, s.marcus);
  assert.deepEqual(s.app.rules.autoPause(learned.rule_id, "direct_contradiction", "x"), { paused: false, reason: "the rule was approved by a person; only automatically added rules can pause by themselves" });
  assert.equal(s.app.rules.get(learned.rule_id).status, "active");
});

test("AT-E7 / AT-I4: an exception asked for by anyone, granted only by a person, shows `waived` with the underlying result, ends with an event, and never crosses projects", () => {
  const s = withSgdRule();
  const p = s.project.project_id;
  s.app.gateway.setActionPolicy(p, "release", "self", s.marcus);
  const blocked = s.app.checks.check({ project_id: p, name: "Order-77.md", bytes: quote({ currency: "USD" }), action: { type: "release" }, actor: s.marcus });
  assert.equal(blocked.verdict, "needs_changes");
  const order = s.app.checks.getRun(blocked.run_id!).artifact;
  const req = s.app.exceptions.request({ project_id: p, rule_id: s.ruleId, artifact_id: order.artifact_id, reason: "Customer asked for USD on this one order", days: 3 }, agent);
  assert.equal(req.status, "requested");
  assert.equal(s.app.checks.check({ project_id: p, name: "Order-77.md", bytes: quote({ currency: "USD" }), action: { type: "release" }, actor: s.marcus }).verdict, "needs_changes", "asking changes nothing");
  assert.throws(() => s.app.exceptions.grant(req.exception_id, agent), PermissionDenied);
  assert.throws(() => s.app.exceptions.request({ project_id: p, rule_id: s.ruleId, artifact_id: order.artifact_id, reason: "x", days: 31 }, agent), ValidationError, "at most the rule's limit");
  const granted = s.app.exceptions.grant(req.exception_id, s.marcus);
  assert.equal(granted.expires_at, "2026-11-20T06:00:00Z");
  const waived = s.app.checks.check({ project_id: p, name: "Order-77.md", bytes: quote({ currency: "USD" }), action: { type: "release" }, actor: s.marcus });
  assert.equal(waived.verdict, "ready");
  const result = s.app.checks.getRun(waived.run_id!).results[0]!;
  assert.equal(result.outcome, "waived");
  assert.match(result.reason, new RegExp(`exception ${req.exception_id}; underlying result: fail`));
  assert.deepEqual(s.app.gateway.getReceipt(waived.receipt_id!).exceptions_applied, [req.exception_id]);
  assert.equal(s.app.gateway.receiptStanding(waived.receipt_id!).usable, true);

  // A byte-identical copy in another project: the exception does not apply there (AT-I4).
  const other = scenario(null, { app: s.app, name: "Other project (TEST)", folder: "/test/other" });
  s.app.authoring.create({ project_id: other.project.project_id, template: { template: "currency", currency: "SGD" } }, s.marcus);
  const copy = s.app.checks.check({ project_id: other.project.project_id, name: "Order-77.md", bytes: quote({ currency: "USD" }), action: { type: "check_only" }, actor: s.marcus });
  assert.equal(s.app.checks.getRun(copy.run_id!).results.every((r) => r.outcome !== "waived"), true);

  // After expiry the rule blocks again, an event records the expiry, and the receipt no longer stands.
  s.app.clock.set("2026-11-20T06:00:01Z");
  const again = s.app.checks.check({ project_id: p, name: "Order-77.md", bytes: quote({ currency: "USD" }), action: { type: "release" }, actor: s.marcus });
  assert.equal(again.verdict, "needs_changes");
  assert.equal(s.app.exceptions.get(req.exception_id).status, "expired");
  assert.equal(s.app.ledger.all().filter((e) => e.type === "exception.expired" && e.subject.id === req.exception_id).length, 1);
  assert.equal(s.app.gateway.receiptStanding(waived.receipt_id!).usable, false);
  assert.equal(s.app.ledger.verify().ok, true);
});
