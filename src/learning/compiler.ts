/**
 * Signal detection and the Phase 1 correction compiler (docs/12 §5-§6).
 *
 * Both are deterministic and rule-based. No AI model is called anywhere in this
 * build; `model_flags` is always empty and exists only so a later translator can
 * add caution (a model may veto, never vouch).
 *
 * MVP BOUNDARY: the compiler is deliberately narrow and path-constrained. It is a
 * fixed list of English patterns, each mapped to one plain template
 * (src/policy/templates.ts), with every literal taken from the person's own words:
 *   - requests that can never be learned (weakening a rule, changing permissions),
 *   - explicit one-offs,
 *   - currency:        "quotes/prices/amounts ... in <ISO currency code>"
 *   - validity window: "valid for at least <N> days"
 *   - totals add up:   "totals/amounts must add up"
 *   - placeholders:    "never leave TBD / placeholders"
 *   - section:         "... a section/heading "<quoted heading>""
 *   - phrases:         "always/must include "<quoted phrase>"" and "never say "<quoted phrase>""
 *   - required value:  "always include/state the <quote reference|customer name|valid-until date|total>"
 * Phrases must be in double quotes, so the exact text is the person's. Anything
 * else is `not_compilable` and goes to a person. There is no semantic
 * understanding: synonyms, paraphrases, other languages and compound requests are
 * not recognized (see PHASE2_COVERAGE.md "Pattern limits").
 */
import type { CaptureEvent, DecisionCandidate, RuleRevisionContent, SignalType, Surface, Trust } from "../domain/types.ts";
import { surfaceOf } from "../capture/intake.ts";
import { canonical } from "../domain/canonical.ts";
import type { TemplateInput } from "../policy/templates.ts";
import { buildRequirement, CURRENCIES as TEMPLATE_CURRENCIES, FIELD_DICTIONARY } from "../policy/templates.ts";

// ---------------------------------------------------------------- markers (English only in the MVP)
export const MARKERS = Object.freeze({
  standing: ["always", "never", "from now on", "every", "each time", "going forward", "by default", "as a rule"],
  obligation: ["must", "should", "don't", "do not", "stop", "wrong", "instead"],
  one_off: ["this time", "for this one", "just here", "only in this document", "just this once"],
  hedge: ["i think", "maybe", "probably", "not sure", "perhaps"],
});

export interface FoundMarkers {
  standing: string[];
  obligation: string[];
  one_off: string[];
  hedge: string[];
}

export function findMarkers(text: string): FoundMarkers {
  const folded = ` ${text.toLowerCase().replace(/[’]/g, "'").replace(/\s+/g, " ")} `;
  const has = (marker: string): boolean => new RegExp(`(^|[^a-z])${marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`).test(folded);
  return {
    standing: MARKERS.standing.filter(has), obligation: MARKERS.obligation.filter(has), one_off: MARKERS.one_off.filter(has),
    hedge: [...MARKERS.hedge.filter(has), ...(text.trim().endsWith("?") ? ["question"] : [])],
  };
}

// ---------------------------------------------------------------- trust and detection
export interface Classified {
  trust: Trust;
  surface: Surface;
}

/**
 * Trust class of a captured event (docs/12 §4). Only a user turn attested by a
 * runtime hook or the app counts as typed by the person. Agent output, tool output
 * and anything unattested is never a signal: it returns null.
 */
export function classify(e: Pick<CaptureEvent, "kind" | "role" | "attested_by">): Classified | null {
  const surface = surfaceOf(e);
  if (!surface) return null;
  if (e.kind === "edit_observed") return { trust: "observed_edit", surface };
  if (e.role !== "user") return null;
  if (e.attested_by === "runtime_hook" || e.attested_by === "app") return { trust: "user_direct", surface };
  // A transcript vouches for less than a live hook: never the person's own words (backfill).
  if (e.attested_by === "runtime_transcript") return { trust: "assistant_relayed", surface };
  return null;
}

export interface Detection {
  type: SignalType;
  markers: FoundMarkers;
}

/**
 * Fixed trigger conditions (docs/12 §5). Returns null for "not a signal": a user
 * turn that asks for work without correcting anything stays merely captured.
 */
export function detect(input: { kind: CaptureEvent["kind"]; text: string | null; surface: Surface; followsAgentOutput: boolean }): Detection | null {
  if (input.kind === "edit_observed") return { type: "human_edit_diff", markers: { standing: [], obligation: [], one_off: [], hedge: [] } };
  if (!input.text || !input.text.trim()) return null;
  const markers = findMarkers(input.text);
  if (input.kind === "review_action") return { type: "rejection_reason", markers };
  // Anything typed into the app's correction box is explicitly a correction.
  if (input.surface === "app" || markers.standing.length) return { type: "standing_instruction", markers };
  // A reply to the assistant's output that says what must change - or that says "just this once".
  if (input.followsAgentOutput && (markers.obligation.length || markers.one_off.length)) return { type: "direct_correction", markers };
  return null;
}

// ---------------------------------------------------------------- compiler
const CURRENCIES = TEMPLATE_CURRENCIES;
const WEAKEN = /\b(stop|quit|no need to|don't|do not|skip|never)\s+(\w+\s+){0,2}(check|checking|verify|verifying|enforc\w*|flag\w*|block\w*)\b|\b(turn|switch)\s+off\b|\bignore the (rule|check)/i;
const PERMISSION = /\bno approval\b|\bwithout\s+(\w+\s+)?approval\b|\blet me (send|release|pay)\b|\bsend without\b|\btreat this (file|list|sheet|document) as\b|\bwho (can|may) (approve|send)\b|\b(can|may) approve\b/i;
const WIDER = /\b(every|all|any)\s+(customer|client|project)s?\b|\beveryone\b|\bacross (the )?(company|workspace)\b/i;
const CURRENCY_CONTEXT = /\b(quote|quotes|price|prices|priced|amount|amounts|currency|total|totals|line|lines)\b/i;

export interface CompileInput {
  text: string | null;
  language: string | null;
  signal_type: SignalType;
  surface: Surface;
  markers: FoundMarkers;
  project: { project_id: string; name: string; default_work_type: string };
  workspace_id: string;
  owner_id: string;
  rule_id: string;
  correction_id: string;
  signal_id: string;
  review_by: string;
}

export interface Compiled {
  /** Null when nothing could be compiled: the item stops at "identified" and goes to a person. */
  descriptor: DecisionCandidate | null;
  /** The typed candidate rule, when a check kind can express the correction. */
  rule: RuleRevisionContent | null;
  /** Structural identity of the requirement, used for duplicates, episodes and suppression. */
  fingerprint: string | null;
  note: string;
}

const base = (input: CompileInput, operation: DecisionCandidate["operation"]): DecisionCandidate => ({
  rule_id: null, revision: null, operation, check_kind: null, method: null, scope_level: "project", scope_project_id: input.project.project_id,
  widening_requested: null, touches_protected_targets: false, pins_fact_without_source: false,
  reusability: input.markers.one_off.length ? "one_off" : input.markers.standing.length || input.surface === "app" ? "explicit_standing" : "unclear",
  referent_resolved: true, parameters_grounded: true, hedged: input.markers.hedge.length > 0,
  language_supported: input.language === "en", model_flags: [], targets_rule_id: null,
});

export function compileCorrection(input: CompileInput): Compiled {
  const text = input.text ?? "";
  // An observed edit carries no words. Compiling a diff is a Phase 2 extension; it is recorded as evidence only.
  if (input.signal_type === "human_edit_diff") {
    return { descriptor: { ...base(input, "add_requirement"), reusability: "unclear" }, rule: null, fingerprint: null, note: "An observed edit: recorded as evidence. Edits are not compiled in this build." };
  }
  // Never learned (docs/12 §11): these are refused whatever the mode.
  if (PERMISSION.test(text)) return { descriptor: base(input, "permission_change"), rule: null, fingerprint: null, note: "Asks to change who may approve, send or what counts as a trusted list. That is changed by an entitled person in Settings." };
  if (WEAKEN.test(text)) return { descriptor: base(input, "weaken_or_remove"), rule: null, fingerprint: null, note: "Asks to switch off or loosen a check. Learning can only add checks; ask the rule's owner for an exception." };
  if (input.markers.one_off.length) return { descriptor: base(input, "add_requirement"), rule: null, fingerprint: null, note: "Explicit one-off: recorded, never a rule." };

  // Grounded parameters: every literal must appear in the person's own words.
  const mentioned = CURRENCIES.filter((c) => new RegExp(`(^|[^A-Za-z])${c}([^A-Za-z]|$)`).test(text));
  if (mentioned.length && CURRENCY_CONTEXT.test(text)) {
    const descriptor = base(input, "add_requirement");
    // Two possible values: ambiguous. Saved as a candidate for a person to decide, never guessed.
    if (mentioned.length > 1) descriptor.referent_resolved = false;
    const currency = mentioned[0]!;
    return finish(input, descriptor, { template: "currency", currency }, `field_in_set|quote.line_items[*].currency,quote.total.currency|${currency}`, `"${currency}" is from the person's own words.`);
  }
  const matched = matchPattern(text);
  if (!matched) return { descriptor: null, rule: null, fingerprint: null, note: "No check type in this build can express this correction." };
  return finish(input, base(input, "add_requirement"), matched.template, null, matched.note);
}

const QUOTED = /["\u201c]([^"\u201c\u201d]{2,120})["\u201d]/;
const NEGATIVE = /\b(never|must not|mustn't|do not|don't|should not|shouldn't|avoid|no longer)\b/i;
const POSITIVE = /\b(always|must|should|needs? to|has to|have to|make sure|every)\b/i;
const VERB = /\b(include|includes|including|state|states|show|shows|have|has|mention|mentions|say|says|contain|contains|add|put|write|use|give)\b/i;

/** The fixed English patterns beyond currency. Each returns a template whose literals come from the text. */
export function matchPattern(text: string): { template: TemplateInput; note: string } | null {
  const days = /\bvalid(?:ity)?\b[^.]*?\b(?:at least|a minimum of|minimum(?: of)?|no less than|for)\s+(\d{1,3})\s+days?\b/i.exec(text) ?? /\b(\d{1,3})[- ]days?\s+(?:of\s+)?validity\b/i.exec(text);
  if (days) {
    const n = Number(days[1]);
    if (n >= 1 && n <= 365) return { template: { template: "validity_window", min_days: n }, note: `"${n} days" is from the person's own words.` };
  }
  if (/\b(totals?|amounts?|lines?|sums?|figures?|numbers?)\b[^.]*\badd up\b/i.test(text)) return { template: { template: "totals_add_up" }, note: "Asks that the amounts add up; nothing was assumed beyond that." };
  if (/\b(placeholders?|TBD|TBC|TODO)\b/.test(text) && (NEGATIVE.test(text) || /\b(remove|no)\b/i.test(text)) && !QUOTED.test(text)) return { template: { template: "no_placeholders" }, note: "Asks that no placeholders remain (TBD, TODO, [[...]])." };
  const quoted = QUOTED.exec(text);
  if (quoted) {
    const phrase = quoted[1]!.trim();
    if (/\b(section|heading)\b/i.test(text) && !NEGATIVE.test(text)) return { template: { template: "required_section", heading: phrase }, note: `The heading "${phrase}" is quoted in the person's own words.` };
    if (NEGATIVE.test(text)) return { template: { template: "forbidden_phrase", phrase }, note: `The phrase "${phrase}" is quoted in the person's own words.` };
    if (POSITIVE.test(text) && VERB.test(text)) return { template: { template: "required_phrase", phrase }, note: `The phrase "${phrase}" is quoted in the person's own words.` };
    return null;
  }
  if (POSITIVE.test(text) && VERB.test(text) && !NEGATIVE.test(text)) {
    const folded = text.toLowerCase();
    for (const [field, d] of Object.entries(FIELD_DICTIONARY)) {
      if (d.words.some((w) => new RegExp(`\\b${w.replace(/[-]/g, "[- ]")}\\b`).test(folded))) return { template: { template: "required_field", field: field as keyof typeof FIELD_DICTIONARY }, note: `Asks that the ${d.label} is stated.` };
    }
  }
  return null;
}

function finish(input: CompileInput, descriptor: DecisionCandidate, template: TemplateInput, fingerprint: string | null, note: string): Compiled {
  const text = input.text ?? "";
  descriptor.check_kind = null;
  if (WIDER.test(text)) descriptor.widening_requested = "workspace";
  const req = buildRequirement(template, input.project.name);
  const rule: RuleRevisionContent = {
    schema_version: "cl.rule/1", rule_id: input.rule_id, revision: 1, supersedes: null,
    // Rendered from the typed fields by a fixed template (ADR-009), never a paraphrase.
    title: req.title, statement: req.statement,
    origin: { kind: "human_correction", correction_id: input.correction_id, signal_ids: [input.signal_id] },
    owner: input.owner_id, review_by: input.review_by,
    scope: {
      level: "project", workspace_id: input.workspace_id, project_selector: null, project_id: input.project.project_id, area_id: null, artifact_id: null,
      work_types: [input.project.default_work_type], artifact_types: ["document"], actions: ["send_external", "release"],
    },
    applies_when: null, method: req.method, enforcement: "block", locked: false,
    check: req.check, requires: req.requires, source: req.source, message: req.message, cases: [],
    exception_policy: { grantable_by: ["rule_owner", "project_steward", "workspace_steward"], max_days: 30 },
  };
  descriptor.check_kind = rule.check.kind;
  descriptor.method = rule.method;
  descriptor.rule_id = rule.rule_id;
  descriptor.revision = 1;
  descriptor.statement = rule.statement;
  return { descriptor, rule, fingerprint: fingerprint ?? `${rule.check.kind}|${rule.check.targets.join(",")}|${canonical(rule.check.params)}`, note };
}
