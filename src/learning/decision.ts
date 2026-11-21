/**
 * The learning decision (docs/12 §7.2): a PURE function of recorded inputs.
 * The same inputs always give the same outcome, and the outcome can be recomputed
 * later. This is the TypeScript counterpart of `decide()` in tools/check_repo.py;
 * test/learning-decision.test.ts holds the two to the same answers on every design
 * fixture.
 *
 * What is deliberately NOT here: any model-confidence input. A model may veto
 * (`candidate.model_flags` adds the `ambiguous` blocker); it can never vouch. No
 * field of the input can remove a blocker or raise an outcome.
 */
import type { DecisionInput, DecisionOutcome, LearningPolicy } from "../domain/types.ts";

export const SCOPE_RANK = { artifact: 0, area: 1, project: 2, project_group: 3, workspace: 4 } as const;
export const CAP_RANK = { inbox: 0, shadow: 1, auto: 2 } as const;
export const SOFT_BLOCKERS: ReadonlySet<string> = new Set(["flags_existing_work", "daily_limit", "no_direct_statement", "surface_limit"]);
export const EVIDENCE_BLOCKERS: ReadonlySet<string> = new Set(["no_trigger_case", "no_real_pass"]);

export interface Decision {
  outcome: DecisionOutcome;
  reasons: string[];
}

export type DecisionPolicy = Pick<LearningPolicy, "mode" | "surfaces" | "learn_from" | "scope" | "auto" | "limits">;

const subset = (items: string[], of: ReadonlySet<string>): boolean => items.every((i) => of.has(i));

export function decide(d: DecisionInput, policy: DecisionPolicy): Decision {
  const { signals, candidate: cand, evaluation: ev } = d;
  const lim = policy.limits;
  const caps = new Map(policy.surfaces.filter((s) => s.enabled).map((s) => [s.surface as string, s.max_outcome]));

  // A. Things that are never learned.
  if (signals.some((s) => s.trust === "untrusted_content" || !caps.has(s.surface) || (s.trust === "assistant_relayed" && s.text_matches_artifact_content))) {
    return { outcome: "discarded", reasons: ["untrusted_origin"] };
  }
  if (d.suppressed) return { outcome: "discarded", reasons: ["suppressed_by_user"] };
  if (cand === null) return { outcome: "inbox", reasons: ["not_compilable"] };
  if (cand.operation === "weaken_or_remove") return { outcome: "declined", reasons: ["would_weaken_or_remove"] };
  if (cand.operation === "permission_change") return { outcome: "declined", reasons: ["permission_change"] };

  // B. One-offs.
  const direct = signals.some((s) => s.trust === "user_direct" && s.author_id !== null && policy.learn_from.includes(s.author_id));
  if (cand.reusability === "one_off") return { outcome: "record_only", reasons: ["one_off"] };
  if ((cand.reusability === "unclear" || cand.reusability === "recurring") && !direct && d.independent_episodes < lim.recurrence_min_episodes) {
    return { outcome: "record_only", reasons: ["not_enough_independent_episodes"] };
  }
  if (!ev) throw new TypeError("decision inputs are incomplete: a compiled candidate needs an evaluation");
  if (ev.duplicates.length) return { outcome: "record_only", reasons: ["already_covered"] };

  // C. Everything that stands in the way of automation.
  const blockers: string[] = [];
  const level = cand.scope_level ?? "workspace";
  if (cand.scope_project_id !== policy.scope.project_id || SCOPE_RANK[level] > SCOPE_RANK[policy.auto.max_scope_level]) blockers.push("scope_outside_delegation");
  if (!cand.check_kind || !policy.auto.check_kinds.includes(cand.check_kind) || !cand.method || !policy.auto.methods.includes(cand.method)) blockers.push("kind_not_delegated");
  if (cand.touches_protected_targets) blockers.push("protected_target");
  if (cand.pins_fact_without_source) blockers.push("fact_without_source");
  if (!direct) blockers.push("no_direct_statement");
  const cap = Math.max(...signals.map((s) => CAP_RANK[caps.get(s.surface)!]));
  if (cap < CAP_RANK.auto) blockers.push("surface_limit");
  if (!signals.every((s) => s.episode_capture_complete)) blockers.push("capture_incomplete");
  if (signals.some((s) => s.late || s.delivery === "backfill")) blockers.push("captured_late");
  if (!(cand.referent_resolved && cand.parameters_grounded && cand.language_supported) || cand.hedged || cand.model_flags.length > 0 || cand.reusability === "unclear") blockers.push("ambiguous");
  if (ev.trigger_case === null) blockers.push("no_trigger_case");
  else if (ev.trigger_case.result !== "fail") blockers.push("trigger_not_caught");
  if (ev.real_passing_cases.filter((c) => c.result === "pass").length < lim.min_real_pass) blockers.push("no_real_pass");
  if (ev.heldout.fail > lim.max_heldout_failures) blockers.push("flags_existing_work");
  if (ev.heldout.unknown + ev.heldout.error > 0) blockers.push("undecidable_on_existing_work");
  if (ev.generated.unexpected > 0) blockers.push("unexpected_on_variants");
  if (ev.conflicts.length) blockers.push("conflict");
  if (ev.contradicts_learned.length) blockers.push("contradicts_learned_rule");
  if (ev.auto_activations_today >= lim.max_auto_activations_per_day) blockers.push("daily_limit");

  // D. Outcome.
  if (policy.mode === "suggest") return { outcome: "inbox", reasons: ["mode_suggest", ...blockers] };
  if (blockers.length === 0) return { outcome: policy.mode === "auto_low_risk" ? "auto_activate" : "auto_shadow", reasons: [] };
  if (subset(blockers, EVIDENCE_BLOCKERS)) return { outcome: "waiting_for_evidence", reasons: blockers };
  if (subset(blockers, SOFT_BLOCKERS) && cap >= CAP_RANK.shadow) return { outcome: "shadow_and_inbox", reasons: blockers };
  return { outcome: "inbox", reasons: blockers };
}

/** Plain words for each reason, shown in the learning queue and inbox. */
export const REASON_WORDS: Readonly<Record<string, string>> = Object.freeze({
  untrusted_origin: "ignored: not from a person",
  suppressed_by_user: "you asked not to learn this",
  not_compilable: "no check in this build can read what it asks for",
  would_weaken_or_remove: "cannot be learned: it would switch off or loosen a rule",
  permission_change: "cannot be learned: it would change who may approve or send",
  one_off: "one-off",
  not_enough_independent_episodes: "seen once; not enough to suggest a rule",
  already_covered: "already covered by a rule",
  mode_suggest: "learning is set to Suggest: every candidate waits for your OK",
  scope_outside_delegation: "wider than this project",
  kind_not_delegated: "this kind of rule is never automatic",
  protected_target: "it reads who may do what",
  fact_without_source: "it states a fact that needs a trusted source",
  no_direct_statement: "not said directly by a listed person",
  surface_limit: "this surface can suggest, not enforce",
  capture_incomplete: "some messages around it have not arrived",
  captured_late: "captured late or from a transcript",
  ambiguous: "its meaning is not certain",
  no_trigger_case: "waiting for the work it was about",
  trigger_not_caught: "it would not catch the thing that was corrected",
  no_real_pass: "waiting for a corrected version that passes",
  flags_existing_work: "it would flag work nobody complained about",
  undecidable_on_existing_work: "it cannot be decided on some existing work",
  unexpected_on_variants: "it behaved differently from its own sentence",
  conflict: "it conflicts with a rule in scope",
  contradicts_learned_rule: "it contradicts a rule learned earlier",
  daily_limit: "today's limit of automatic rules was reached",
});
