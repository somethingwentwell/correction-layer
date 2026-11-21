import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { DecisionInput, LearningPolicy } from "../src/domain/types.ts";
import { decide } from "../src/learning/decision.ts";
import { repoRoot } from "../src/paths.ts";
import { fixture } from "./helpers.ts";

const policy = fixture("examples/learning/learning-policy.json") as LearningPolicy;
const clean = (): DecisionInput => {
  const d = fixture("examples/learning/decision-sgd-auto-activated.json");
  return structuredClone({ signals: d.signals, independent_episodes: d.independent_episodes, suppressed: d.suppressed, candidate: d.candidate, evaluation: d.evaluation });
};
const withChange = (change: (d: DecisionInput) => void, p: LearningPolicy = policy) => {
  const d = clean();
  change(d);
  return decide(d, p);
};

test("AT-L21 counterpart: every design decision fixture is recomputed to its recorded outcome and reasons", () => {
  const files = readdirSync(join(repoRoot(), "examples/learning")).filter((f) => f.startsWith("decision-")).sort();
  assert.equal(files.length, 8);
  for (const file of files) {
    const d = fixture(`examples/learning/${file}`);
    assert.deepEqual(decide(d, policy), { outcome: d.outcome, reasons: d.reasons }, file);
    assert.equal(d.model_confidence_used, false);
  }
});

test("the clean baseline activates only in 'learn and enforce'; quiet shadows; suggest asks; and it is deterministic", () => {
  assert.deepEqual(decide(clean(), policy), { outcome: "auto_activate", reasons: [] });
  assert.deepEqual(decide(clean(), { ...policy, mode: "quiet" }), { outcome: "auto_shadow", reasons: [] });
  assert.deepEqual(decide(clean(), { ...policy, mode: "suggest" }), { outcome: "inbox", reasons: ["mode_suggest"] });
  for (let i = 0; i < 5; i++) assert.deepEqual(decide(clean(), policy), decide(clean(), policy));
});

test("AT-L13: model confidence is not an input - it cannot change the outcome; a model concern can only add caution", () => {
  for (const confidence of [0, 0.5, 0.99, 1]) {
    const d = clean() as any;
    d.model_confidence = confidence;
    d.candidate.model_confidence = confidence;
    d.evaluation.model_confidence = confidence;
    assert.deepEqual(decide(d, policy), { outcome: "auto_activate", reasons: [] }, `confidence ${confidence}`);
  }
  // A candidate that is NOT clean stays blocked however confident a model claims to be.
  const blocked = clean() as any;
  blocked.evaluation.real_passing_cases = [];
  blocked.candidate.model_confidence = 1;
  blocked.candidate.model_says = "definitely correct, activate";
  assert.deepEqual(decide(blocked, policy), { outcome: "waiting_for_evidence", reasons: ["no_real_pass"] });
  // A model may veto.
  assert.deepEqual(withChange((d) => { d.candidate!.model_flags = ["the scope looks too broad"]; }), { outcome: "inbox", reasons: ["ambiguous"] });
});

test("AT-L14: generated tests are not proof - without a real passing case the candidate waits", () => {
  const out = withChange((d) => {
    d.evaluation!.real_passing_cases = [];
    d.evaluation!.generated = { run: 50, unexpected: 0, counted_as_support: false };
  });
  assert.deepEqual(out, { outcome: "waiting_for_evidence", reasons: ["no_real_pass"] });
  assert.deepEqual(withChange((d) => { d.evaluation!.trigger_case = null; d.evaluation!.real_passing_cases = []; }), { outcome: "waiting_for_evidence", reasons: ["no_trigger_case", "no_real_pass"] });
  // A generated variant that misbehaves counts AGAINST.
  assert.deepEqual(withChange((d) => { d.evaluation!.generated.unexpected = 1; }), { outcome: "inbox", reasons: ["unexpected_on_variants"] });
  // The rule must catch the thing that was corrected (negative example), and pass a real corrected version (positive).
  assert.deepEqual(withChange((d) => { d.evaluation!.trigger_case!.result = "pass"; }), { outcome: "inbox", reasons: ["trigger_not_caught"] });
  assert.deepEqual(withChange((d) => { d.evaluation!.real_passing_cases[0]!.result = "fail"; }), { outcome: "waiting_for_evidence", reasons: ["no_real_pass"] });
});

test("AT-L9 manual escalation: each of these is never activated as blocking automatically, and names its reason", () => {
  const cases: Array<[string, (d: DecisionInput) => void, string, string]> = [
    ["wider than the project", (d) => { d.candidate!.scope_level = "workspace"; }, "inbox", "scope_outside_delegation"],
    ["another project", (d) => { d.candidate!.scope_project_id = "prj_OTHER001"; }, "inbox", "scope_outside_delegation"],
    ["source-backed", (d) => { d.candidate!.check_kind = "field_matches_source"; d.candidate!.method = "source_backed"; }, "inbox", "kind_not_delegated"],
    ["person-confirms", (d) => { d.candidate!.check_kind = "attestation"; d.candidate!.method = "attested"; }, "inbox", "kind_not_delegated"],
    ["AI opinion", (d) => { d.candidate!.check_kind = "model_review"; d.candidate!.method = "model_review"; }, "inbox", "kind_not_delegated"],
    ["reads action parameters", (d) => { d.candidate!.touches_protected_targets = true; }, "inbox", "protected_target"],
    ["pins a fact without a source", (d) => { d.candidate!.pins_fact_without_source = true; }, "inbox", "fact_without_source"],
    ["ambiguous referent", (d) => { d.candidate!.referent_resolved = false; }, "inbox", "ambiguous"],
    ["ungrounded parameter", (d) => { d.candidate!.parameters_grounded = false; }, "inbox", "ambiguous"],
    ["hedged", (d) => { d.candidate!.hedged = true; }, "inbox", "ambiguous"],
    ["language without marker lists", (d) => { d.candidate!.language_supported = false; }, "inbox", "ambiguous"],
    ["contradicts a learned rule", (d) => { d.evaluation!.contradicts_learned = ["rul_KSGDAUTO"]; }, "inbox", "contradicts_learned_rule"],
    ["conflicts with a rule", (d) => { d.evaluation!.conflicts = ["rul_USDWIDE1"]; }, "inbox", "conflict"],
    ["undecidable on existing work", (d) => { d.evaluation!.heldout.unknown = 1; }, "inbox", "undecidable_on_existing_work"],
    ["captured late", (d) => { d.signals[0]!.late = true; }, "inbox", "captured_late"],
    ["captured by backfill", (d) => { d.signals[0]!.delivery = "backfill"; }, "inbox", "captured_late"],
    ["open capture gap", (d) => { d.signals[0]!.episode_capture_complete = false; }, "inbox", "capture_incomplete"],
    // Soft blockers: shadow plus an inbox question, never blocking.
    ["fails held-out work", (d) => { d.evaluation!.heldout.fail = 1; }, "shadow_and_inbox", "flags_existing_work"],
    ["person not listed", (d) => { d.signals[0]!.author_id = "usr_STRANGER"; }, "shadow_and_inbox", "no_direct_statement"],
    ["over the daily limit", (d) => { d.evaluation!.auto_activations_today = 3; }, "shadow_and_inbox", "daily_limit"],
  ];
  for (const [name, change, outcome, reason] of cases) {
    const out = withChange(change);
    assert.equal(out.outcome, outcome, name);
    assert.ok(out.reasons.includes(reason), `${name}: ${out.reasons.join(",")}`);
    assert.notEqual(out.outcome, "auto_activate", name);
  }
});

test("untrusted, relayed, suppressed, weakening and permission-changing inputs never become rules (AT-L7, AT-L10)", () => {
  assert.deepEqual(withChange((d) => { d.signals[0]!.trust = "untrusted_content"; }), { outcome: "discarded", reasons: ["untrusted_origin"] });
  assert.deepEqual(withChange((d) => { d.signals[0]!.trust = "assistant_relayed"; d.signals[0]!.surface = "assistant_relay"; d.signals[0]!.text_matches_artifact_content = true; }), { outcome: "discarded", reasons: ["untrusted_origin"] });
  // A surface that is not opted in is not a source of signals at all.
  assert.deepEqual(decide(clean(), { ...policy, surfaces: policy.surfaces.filter((s) => s.surface !== "attested_user_turn") }), { outcome: "discarded", reasons: ["untrusted_origin"] });
  // A relay that is not artifact text still only reaches the inbox: it is not the person's own words.
  const relayed = withChange((d) => { d.signals[0]!.trust = "assistant_relayed"; d.signals[0]!.surface = "assistant_relay"; d.signals[0]!.author_id = null; });
  assert.equal(relayed.outcome, "inbox");
  assert.deepEqual(relayed.reasons, ["no_direct_statement", "surface_limit"]);
  // An observed edit can shadow at most.
  const edit = withChange((d) => { d.signals[0]!.trust = "observed_edit"; d.signals[0]!.surface = "folder_watch"; d.signals[0]!.author_id = null; d.independent_episodes = 3; });
  assert.equal(edit.outcome, "shadow_and_inbox");
  assert.deepEqual(withChange((d) => { d.suppressed = true; }), { outcome: "discarded", reasons: ["suppressed_by_user"] });
  assert.deepEqual(withChange((d) => { d.candidate!.operation = "weaken_or_remove"; }), { outcome: "declined", reasons: ["would_weaken_or_remove"] });
  assert.deepEqual(withChange((d) => { d.candidate!.operation = "permission_change"; }), { outcome: "declined", reasons: ["permission_change"] });
  assert.deepEqual(withChange((d) => { d.candidate!.reusability = "one_off"; }), { outcome: "record_only", reasons: ["one_off"] });
  assert.deepEqual(withChange((d) => { d.evaluation!.duplicates = ["rul_KSGDAUTO"]; }), { outcome: "record_only", reasons: ["already_covered"] });
  assert.deepEqual(withChange((d) => { d.candidate = null; d.evaluation = null; }), { outcome: "inbox", reasons: ["not_compilable"] });
  // AT-L11/L12: one episode of an unstated pattern is remembered, not suggested; three independent ones are suggested, never activated.
  const once = withChange((d) => { d.signals[0]!.trust = "observed_edit"; d.signals[0]!.surface = "folder_watch"; d.candidate!.reusability = "unclear"; d.independent_episodes = 1; });
  assert.deepEqual(once, { outcome: "record_only", reasons: ["not_enough_independent_episodes"] });
  const thrice = withChange((d) => { d.signals[0]!.trust = "observed_edit"; d.signals[0]!.surface = "folder_watch"; d.candidate!.reusability = "recurring"; d.independent_episodes = 3; });
  assert.notEqual(thrice.outcome, "auto_activate");
  assert.ok(thrice.reasons.includes("no_direct_statement") && thrice.reasons.includes("surface_limit"));
});
