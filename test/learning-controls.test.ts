/**
 * Learning controls a person uses (docs/12 §9-§12): automatic pause and Resume
 * (AT-L15), "this was a correction" (AT-L19), deleting a signal's wording
 * (AT-L17 deletion), "don't learn this", inbox actions, and the compiler's
 * template patterns. FICTIONAL test data.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ClError, PermissionDenied } from "../src/domain/errors.ts";
import { compileCorrection, findMarkers, matchPattern } from "../src/learning/compiler.ts";
import { all } from "../src/store/db.ts";
import type { Scenario } from "./helpers.ts";
import { draftAndCorrect, enc, quote, scenario, T0 } from "./helpers.ts";

const SGD = "No, Kestrel's quotes must always be in SGD.";
const agent = { kind: "agent" as const, id: "agt_ASSIST01", display_name: "assistant" };
const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return e instanceof ClError ? e.code : String(e);
  }
  return "no error";
};
const say = (s: Scenario, text: string): void => {
  s.adapter.emit({ kind: "user_turn", role: "user", attested_by: "runtime_hook", occurred_at: T0, text });
  s.adapter.flush(s.app.intake);
};
const lastDecision = (s: Scenario) => s.app.learning.decisions(s.project.project_id)[0]!;
function learnSgd(s: Scenario) {
  draftAndCorrect(s, SGD);
  s.adapter.flush(s.app.intake);
  s.app.checks.observe({ project_id: s.project.project_id, name: "Kestrel-Supply-Quote.md", bytes: quote({ currency: "SGD" }) });
  const rule = s.app.rules.listForProject(s.project.project_id).find((r) => r.authority?.kind === "delegated_learning")!;
  assert.equal(rule.status, "active");
  return rule;
}

test("compiler patterns: each maps to one template with literals from the person's own words; anything else is not compiled", () => {
  const cases: Array<[string, unknown]> = [
    ["Quotes must be valid for at least 45 days.", { template: "validity_window", min_days: 45 }],
    ["Always give 30-day validity.", { template: "validity_window", min_days: 30 }],
    ["From now on the totals must add up.", { template: "totals_add_up" }],
    ["Never leave TBD placeholders in a quote.", { template: "no_placeholders" }],
    ['Always include a section headed "Payment terms".', { template: "required_section", heading: "Payment terms" }],
    ['Never write "pre-approved" in a quote.', { template: "forbidden_phrase", phrase: "pre-approved" }],
    ['Every quote must include "Prices exclude GST".', { template: "required_phrase", phrase: "Prices exclude GST" }],
    ["Always include the quote reference.", { template: "required_field", field: "quote.reference" }],
    ["Every quote must state the valid until date.", { template: "required_field", field: "quote.valid_until" }],
  ];
  for (const [text, expected] of cases) assert.deepEqual(matchPattern(text)?.template, expected, text);
  for (const text of ["Always state the delivery lead time on addenda.", "The quote looks nice.", "Never say 'pre-approved'.", "Make it more persuasive.", "Use a friendlier tone always."]) {
    assert.equal(matchPattern(text), null, text);
  }
  const compiled = compileCorrection({
    text: 'Never write "pre-approved" in a quote.', language: "en", signal_type: "standing_instruction", surface: "attested_user_turn", markers: findMarkers('Never write "pre-approved" in a quote.'),
    project: { project_id: "prj_PATTERN1", name: "Pattern (TEST)", default_work_type: "sales_proposal" }, workspace_id: "ws_TEST0001", owner_id: "usr_PRIYA001", rule_id: "rul_PATTERN1", correction_id: "cor_PATTERN1", signal_id: "sig_PATTERN1", review_by: "2027-02-15",
  });
  assert.equal(compiled.rule?.check.kind, "text_contains");
  assert.deepEqual(compiled.rule?.check.params, { phrase: "pre-approved", mode: "must_not" });
  assert.equal(compiled.descriptor?.check_kind, "text_contains");
  assert.match(compiled.fingerprint!, /^text_contains\|content\|/);
});

test("a new pattern learns end to end under the policy, with real failing and passing versions", () => {
  const s = scenario("auto_low_risk");
  const p = s.project.project_id;
  draftAndCorrect(s, 'Never write "pre-approved" in a quote.', quote({ currency: "SGD", extra: "This quote is pre-approved by our director." }));
  s.adapter.flush(s.app.intake);
  assert.equal(lastDecision(s).outcome, "waiting_for_evidence");
  s.app.checks.observe({ project_id: p, name: "Kestrel-Supply-Quote.md", bytes: quote({ currency: "SGD" }) });
  const learned = s.app.rules.listForProject(p).find((r) => r.authority?.kind === "delegated_learning")!;
  assert.equal(learned.status, "active");
  assert.equal(learned.statement, 'The text must not include "pre-approved".');
  assert.equal(lastDecision(s).outcome, "auto_activate");
});

test("AT-L15: automatic pause on two disputes and on conflict with an approved rule; approved rules never pause; Resume from the inbox restores", () => {
  const s = scenario("auto_low_risk");
  const p = s.project.project_id;
  const learned = learnSgd(s);
  const r1 = s.app.checks.check({ project_id: p, name: "One.md", bytes: quote({ currency: "USD" }), action: { type: "release" }, actor: s.marcus });
  const r2 = s.app.checks.check({ project_id: p, name: "Two.md", bytes: quote({ currency: "USD" }), action: { type: "release" }, actor: s.marcus });
  assert.throws(() => s.app.learning.disputeFinding({ run_id: r1.run_id!, rule_id: learned.rule_id, reason: "x" }, agent), PermissionDenied);
  const first = s.app.learning.disputeFinding({ run_id: r1.run_id!, rule_id: learned.rule_id, reason: "Customer pays in USD now" }, s.marcus);
  assert.deepEqual([first.disputes, first.paused], [1, false]);
  assert.equal(s.app.learning.disputeFinding({ run_id: r1.run_id!, rule_id: learned.rule_id, reason: "again" }, s.marcus).disputes, 1, "the same document twice counts once");
  const second = s.app.learning.disputeFinding({ run_id: r2.run_id!, rule_id: learned.rule_id, reason: "Customer pays in USD now" }, s.marcus);
  assert.deepEqual([second.disputes, second.paused], [2, true]);
  assert.equal(s.app.rules.get(learned.rule_id).status, "trial");
  const item = s.app.learning.queue(p).needs_you.find((i) => i.kind === "paused_learned_rule" && i.rule_id === learned.rule_id)!;
  assert.match(item.question, /paused itself/);
  assert.throws(() => s.app.learning.actOnInbox(item.inbox_id, agent, "resume"), PermissionDenied);
  s.app.learning.actOnInbox(item.inbox_id, s.marcus, "resume");
  assert.equal(s.app.rules.get(learned.rule_id).status, "active");
  assert.equal(code(() => s.app.learning.actOnInbox(item.inbox_id, s.marcus, "resume")), "already_answered");

  // A person approves a USD rule that cannot be met together with the learned SGD rule: the learned one yields.
  const usdV = s.app.checks.observe({ project_id: p, name: "Usd-Order.md", bytes: quote({ currency: "USD" }) });
  const sgdV = s.app.checks.latestVersions(p).find((v) => v.name === "Kestrel-Supply-Quote.md")!;
  const usdRule = s.app.authoring.create({ project_id: p, template: { template: "currency", currency: "USD" } }, s.marcus, [learned.rule_id]);
  s.app.authoring.addExample(usdRule.rule_id, { artifact_id: sgdV.artifact_id, content_hash: sgdV.content_hash, kind: "negative" }, s.marcus);
  s.app.authoring.addExample(usdRule.rule_id, { artifact_id: usdV.artifact_id, content_hash: usdV.content_hash, kind: "positive" }, s.marcus);
  s.app.rules.approveAndActivate(usdRule.rule_id, s.marcus);
  const yielded = s.app.rules.get(learned.rule_id);
  assert.equal(yielded.status, "trial");
  assert.equal(yielded.authority?.auto_paused?.reason, "conflict_with_approved_rule");
  assert.equal(s.app.rules.get(usdRule.rule_id).status, "active", "the person-approved rule is untouched");
  // Disputes against the person-approved rule are recorded but never pause it.
  const r3 = s.app.checks.check({ project_id: p, name: "Three.md", bytes: quote({ currency: "SGD" }), action: { type: "release" }, actor: s.marcus });
  const r4 = s.app.checks.check({ project_id: p, name: "Four.md", bytes: quote({ currency: "SGD" }), action: { type: "release" }, actor: s.marcus });
  s.app.learning.disputeFinding({ run_id: r3.run_id!, rule_id: usdRule.rule_id, reason: "x" }, s.marcus);
  const d = s.app.learning.disputeFinding({ run_id: r4.run_id!, rule_id: usdRule.rule_id, reason: "x" }, s.marcus);
  assert.equal(d.paused, false);
  assert.match(d.note, /approved by a person/);
  assert.equal(s.app.rules.get(usdRule.rule_id).status, "active");
  assert.equal(s.app.ledger.verify().ok, true);
});

test("AT-L19: a missed correction is recovered by its author within the review window, as a user_direct signal from the app", () => {
  const s = scenario("auto_low_risk");
  const p = s.project.project_id;
  draftAndCorrect(s, "Validity of at least 90 days on these please.");
  s.adapter.flush(s.app.intake);
  assert.equal(s.app.learning.decisions(p).length, 0, "the detector did not see it as a correction");
  assert.equal(s.app.learning.queue(p).captured_not_seen, 1);
  // Only the author sees their own messages.
  assert.deepEqual(s.app.learning.reviewMine(p, s.marcus), []);
  const mine = s.app.learning.reviewMine(p, s.priya);
  assert.deepEqual(mine.map((m) => m.text), ["Validity of at least 90 days on these please."]);
  assert.throws(() => s.app.learning.markAsCorrection(mine[0]!.capture_id, s.marcus), PermissionDenied, "not the author");
  assert.throws(() => s.app.learning.markAsCorrection(mine[0]!.capture_id, agent), PermissionDenied);
  const agentOutput = all<{ capture_id: string }>(s.app.db, "SELECT capture_id FROM capture_events WHERE kind = 'agent_output'")[0]!.capture_id;
  assert.equal(code(() => s.app.learning.markAsCorrection(agentOutput, s.priya)), "validation_failed", "assistant output can never become a correction");

  const marked = s.app.learning.markAsCorrection(mine[0]!.capture_id, s.priya);
  assert.equal(marked.outcome, "waiting_for_evidence");
  const signal = all<any>(s.app.db, "SELECT trust, surface, author_id FROM signals WHERE signal_id = ?", marked.signal_id)[0];
  assert.deepEqual({ ...signal }, { trust: "user_direct", surface: "app", author_id: s.priya.id });
  assert.equal(code(() => s.app.learning.markAsCorrection(mine[0]!.capture_id, s.priya)), "already_handled");
  // The same stages follow: a corrected version that is valid long enough turns it on under the policy.
  s.app.checks.observe({ project_id: p, name: "Kestrel-Supply-Quote.md", bytes: enc(new TextDecoder().decode(quote()).replace("12 January 2027", "1 March 2027")) });
  const rule = s.app.rules.listForProject(p).find((r) => r.check.kind === "date_window")!;
  assert.equal(rule.status, "active");
  assert.equal(rule.authority?.kind, "delegated_learning");
  const marks = s.app.ledger.byRef("capture_id", mine[0]!.capture_id).map((e) => e.type);
  assert.deepEqual(marks.slice(0, 2), ["correction.recorded", "learning.signal_detected"]);

  // After the review window the text is gone and the message can no longer be marked.
  const s2 = scenario("auto_low_risk", { app: s.app, name: "Second (TEST)", folder: "/test/second", streamId: "str_SECOND0001" });
  draftAndCorrect(s2, "Validity of at least 60 days on these please.");
  s2.adapter.flush(s.app.intake);
  const later = s.app.learning.reviewMine(s2.project.project_id, s.priya)[0]!;
  s.app.clock.advance(15 * 86400);
  s.app.learning.tick();
  assert.deepEqual(s.app.learning.reviewMine(s2.project.project_id, s.priya), []);
  assert.equal(code(() => s.app.learning.markAsCorrection(later.capture_id, s.priya)), "text_not_kept");
});

test("AT-L17 (deletion): a signal's wording is deleted everywhere it was kept; the ledger still verifies; the rule stays", () => {
  const s = scenario("auto_low_risk");
  const learned = learnSgd(s);
  const signalId = learned.origin.signal_ids![0]!;
  const tableText = (): string => all<{ name: string }>(s.app.db, "SELECT name FROM sqlite_master WHERE type = 'table'").map((t) => JSON.stringify(all(s.app.db, `SELECT * FROM "${t.name}"`))).join("\n");
  assert.ok(tableText().includes("must always be in SGD"), "the wording is kept as evidence until deleted");
  assert.throws(() => s.app.learning.deleteSignalText(signalId, agent), PermissionDenied);
  s.app.learning.deleteSignalText(signalId, s.priya);
  assert.equal(tableText().includes("must always be in SGD"), false, "no table holds the wording any more - including decisions, notices and the ledger");
  assert.equal(s.app.ledger.verify().ok, true);
  assert.equal(s.app.rules.get(learned.rule_id).status, "active", "rules made from it stay");
  assert.ok(s.app.ledger.byRef("signal_id", signalId).some((e) => e.type === "redaction.applied" && e.actor.id === s.priya.id));
});

test("\"don't learn this\": the learned rule is retired and the same correction is not raised again; inbox approve attaches the real examples", () => {
  const s = scenario("auto_low_risk");
  const p = s.project.project_id;
  const learned = learnSgd(s);
  const decision = s.app.learning.decisions(p).find((d) => d.outcome === "auto_activate")!;
  assert.throws(() => s.app.learning.suppress(decision.decision_id, agent), PermissionDenied);
  s.app.learning.suppress(decision.decision_id, s.marcus);
  assert.equal(s.app.rules.get(learned.rule_id).status, "retired");
  say(s, "Kestrel's quotes must always be in SGD, every time.");
  assert.deepEqual([lastDecision(s).outcome, lastDecision(s).reasons], ["discarded", ["suppressed_by_user"]]);

  // Suggest mode: the candidate waits in the inbox; approving there attaches the real examples first.
  const t = scenario("suggest", { name: "Suggest (TEST)" });
  draftAndCorrect(t, SGD);
  t.adapter.flush(t.app.intake);
  t.app.checks.observe({ project_id: t.project.project_id, name: "Kestrel-Supply-Quote.md", bytes: quote({ currency: "SGD" }) });
  const item = t.app.learning.queue(t.project.project_id).needs_you.find((i) => i.rule_id)!;
  t.app.learning.actOnInbox(item.inbox_id, t.marcus, "approve");
  const approved = t.app.rules.get(item.rule_id!);
  assert.equal(approved.status, "active");
  assert.equal(approved.authority?.kind, "individual_approval");
  assert.deepEqual(approved.cases.map((c) => [c.kind, c.last_result]), [["negative", "fail"], ["positive", "pass"]]);
});
