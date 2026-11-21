/**
 * Rule templates: the plain options a person picks from when adding a correction
 * by hand (UX-7), and the only shapes the deterministic compiler produces.
 *
 * A template is a fixed mapping from a few typed, person-supplied values to one
 * entry of the closed check catalogue. The rule sentence is rendered from the typed
 * fields by a fixed template (ADR-009), never paraphrased. There is no free-form
 * syntax: no paths, no JSON, no expressions are typed by the person.
 *
 * The field dictionary is the set of document values the `text-labelled` reader
 * actually produces for sales proposals. A template that names a field outside it
 * cannot be built.
 */
import { ValidationError } from "../domain/errors.ts";
import type { Enforcement, RuleRevisionContent, RuleScope } from "../domain/types.ts";

export const FIELD_DICTIONARY = Object.freeze({
  "quote.reference": { label: "quote reference", words: ["quote reference", "quote number", "quote ref", "reference number"] },
  "customer.name": { label: "customer name", words: ["customer name", "customer", "client name"] },
  "quote.valid_until": { label: "valid-until date", words: ["valid until date", "valid-until date", "valid until", "validity date", "expiry date", "expiration date"] },
  "quote.total": { label: "total", words: ["grand total", "total"] },
} as const);
export type DictionaryField = keyof typeof FIELD_DICTIONARY;
export const isDictionaryField = (f: unknown): f is DictionaryField => typeof f === "string" && Object.hasOwn(FIELD_DICTIONARY, f);

export const CURRENCIES = Object.freeze(["SGD", "USD", "EUR", "GBP", "JPY", "AUD", "CAD", "CHF", "CNY", "HKD", "INR", "MYR", "NZD", "IDR", "THB", "KRW"]);

export type TemplateInput =
  | { template: "currency"; currency: string }
  | { template: "required_field"; field: DictionaryField }
  | { template: "required_phrase"; phrase: string }
  | { template: "forbidden_phrase"; phrase: string }
  | { template: "required_section"; heading: string }
  | { template: "validity_window"; min_days: number }
  | { template: "totals_add_up" }
  | { template: "no_placeholders" }
  | { template: "customer_matches_project" }
  | { template: "price_matches_source"; source_id: string; key_column: string; value_column: string; max_age_days: number };
export type TemplateId = TemplateInput["template"];

export const TEMPLATES: ReadonlyArray<{ id: TemplateId; label: string; needs: string[] }> = Object.freeze([
  { id: "currency", label: "All amounts must be in one currency", needs: ["currency"] },
  { id: "required_field", label: "The document must state a value", needs: ["field"] },
  { id: "required_phrase", label: "A phrase must appear", needs: ["phrase"] },
  { id: "forbidden_phrase", label: "A phrase must never appear", needs: ["phrase"] },
  { id: "required_section", label: "A section with a heading must exist", needs: ["heading"] },
  { id: "validity_window", label: "The valid-until date must be far enough ahead", needs: ["min_days"] },
  { id: "totals_add_up", label: "Line amounts and the total must add up", needs: [] },
  { id: "no_placeholders", label: "No placeholders such as TBD or [[...]] may remain", needs: [] },
  { id: "customer_matches_project", label: "The customer named must be this project's customer", needs: [] },
  { id: "price_matches_source", label: "Unit prices must match a trusted price list", needs: ["source_id", "key_column", "value_column"] },
]);

const clean = (s: unknown, max: number, what: string): string => {
  const v = typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "";
  if (!v || v.length > max) throw new ValidationError("rule", [`${what}: between 1 and ${max} characters`]);
  return v;
};

/** Parse loosely typed form values into a template input. Throws a ValidationError naming the field. */
export function templateInput(raw: Record<string, unknown>): TemplateInput {
  const t = raw.template;
  switch (t) {
    case "currency": {
      const c = String(raw.currency ?? "").trim().toUpperCase();
      if (!CURRENCIES.includes(c)) throw new ValidationError("rule", [`currency: one of ${CURRENCIES.join(", ")}`]);
      return { template: t, currency: c };
    }
    case "required_field":
      if (!isDictionaryField(raw.field)) throw new ValidationError("rule", [`field: one of ${Object.values(FIELD_DICTIONARY).map((f) => f.label).join(", ")}`]);
      return { template: t, field: raw.field };
    case "required_phrase":
    case "forbidden_phrase":
      return { template: t, phrase: clean(raw.phrase, 200, "phrase") };
    case "required_section":
      return { template: t, heading: clean(raw.heading, 120, "heading") };
    case "validity_window": {
      const n = Number(raw.min_days);
      if (!Number.isInteger(n) || n < 1 || n > 365) throw new ValidationError("rule", ["min_days: a whole number of days from 1 to 365"]);
      return { template: t, min_days: n };
    }
    case "totals_add_up":
    case "no_placeholders":
    case "customer_matches_project":
      return { template: t };
    case "price_matches_source": {
      const age = raw.max_age_days === undefined || raw.max_age_days === "" ? 30 : Number(raw.max_age_days);
      if (!Number.isInteger(age) || age < 1 || age > 365) throw new ValidationError("rule", ["max_age_days: 1 to 365"]);
      return { template: t, source_id: clean(raw.source_id, 40, "source_id"), key_column: clean(raw.key_column, 60, "key_column"), value_column: clean(raw.value_column, 60, "value_column"), max_age_days: age };
    }
    default:
      throw new ValidationError("rule", [`template: one of ${TEMPLATES.map((x) => x.id).join(", ")}`]);
  }
}

type Built = Pick<RuleRevisionContent, "title" | "statement" | "method" | "check" | "requires" | "source" | "message">;

/** The typed requirement for a template. Titles name the project; the sentence is fixed per template. */
export function buildRequirement(input: TemplateInput, projectName: string): Built {
  const none = { fields: [] as string[], components: [] as string[] };
  switch (input.template) {
    case "currency":
      return {
        title: `${projectName} quotes are in ${input.currency}`, statement: `Every line in the pricing table, and the total, must be in ${input.currency}.`, method: "deterministic", source: null,
        check: { kind: "field_in_set", targets: ["quote.line_items[*].currency", "quote.total.currency"], params: { allowed: [input.currency] } },
        requires: { fields: ["quote.line_items[*].currency", "quote.total"], components: ["body.tables"] },
        message: { problem: `Currency is not ${input.currency}`, fix_hint: `Quote this project in ${input.currency}.` },
      };
    case "required_field": {
      const label = FIELD_DICTIONARY[input.field].label;
      return {
        title: `Quotes state the ${label}`, statement: `The ${label} must be stated.`, method: "deterministic", source: null,
        check: { kind: "field_present", targets: [input.field], params: {} }, requires: none,
        message: { problem: `The ${label} is missing`, fix_hint: `Add the ${label}.` },
      };
    }
    case "required_phrase":
      return {
        title: `Quotes say "${input.phrase}"`, statement: `The text must include "${input.phrase}".`, method: "deterministic", source: null,
        check: { kind: "text_contains", targets: ["content"], params: { phrase: input.phrase, mode: "must" } }, requires: { fields: [], components: ["body.text"] },
        message: { problem: `"${input.phrase}" does not appear`, fix_hint: `Add "${input.phrase}".` },
      };
    case "forbidden_phrase":
      return {
        title: `Quotes never say "${input.phrase}"`, statement: `The text must not include "${input.phrase}".`, method: "deterministic", source: null,
        check: { kind: "text_contains", targets: ["content"], params: { phrase: input.phrase, mode: "must_not" } }, requires: { fields: [], components: ["body.text"] },
        message: { problem: `"${input.phrase}" appears`, fix_hint: `Remove "${input.phrase}".` },
      };
    case "required_section":
      return {
        title: `Quotes have a "${input.heading}" section`, statement: `A section headed "${input.heading}" must be present.`, method: "deterministic", source: null,
        check: { kind: "section_present", targets: ["content"], params: { heading: input.heading } }, requires: { fields: [], components: ["body.text"] },
        message: { problem: `No "${input.heading}" section`, fix_hint: `Add a section headed "${input.heading}".` },
      };
    case "validity_window":
      return {
        title: `Quotes are valid for at least ${input.min_days} days`, statement: `The valid-until date must be at least ${input.min_days} days after the check.`, method: "deterministic", source: null,
        check: { kind: "date_window", targets: ["quote.valid_until"], params: { min_days_ahead: input.min_days } }, requires: none,
        message: { problem: `The quote is valid for less than ${input.min_days} days`, fix_hint: `Set the valid-until date at least ${input.min_days} days ahead.` },
      };
    case "totals_add_up":
      return {
        title: "Line amounts and the total add up", statement: "Each line amount must equal quantity times unit price, and the total must equal the sum of the lines.", method: "deterministic", source: null,
        check: { kind: "arithmetic_consistency", targets: ["quote.line_items[*].amount", "quote.total"], params: { rows: "quote.line_items[*]", quantity: "quantity", unit_price: "unit_price", amount: "amount", total: "quote.total" } },
        requires: { fields: [], components: ["body.tables"] }, message: { problem: "The amounts do not add up", fix_hint: "Recalculate the line amounts and the total." },
      };
    case "no_placeholders":
      return {
        title: "No placeholders are left in quotes", statement: "The text must not contain placeholders such as TBD, TODO or [[...]].", method: "deterministic", source: null,
        check: { kind: "no_unresolved_markup", targets: ["content"], params: {} }, requires: none, message: { problem: "A placeholder is still in the text", fix_hint: "Replace the placeholder with the real content." },
      };
    case "customer_matches_project":
      return {
        title: `Quotes name ${projectName}'s customer`, statement: "The customer named in the document must be this project's confirmed customer.", method: "deterministic", source: null,
        check: { kind: "fields_agree", targets: ["customer.name", "context.project.facts.customer_name"], params: { normalize: "casefold" } }, requires: none,
        message: { problem: "The customer named is not this project's customer", fix_hint: "Use the customer name confirmed for this project." },
      };
    case "price_matches_source":
      return {
        title: `Unit prices match the trusted price list`, statement: `Each unit price must equal the ${input.value_column} in the trusted price list for its ${input.key_column}.`, method: "source_backed",
        source: { source_id: input.source_id, max_age_days: input.max_age_days, require_latest: true, missing_key: "unknown" },
        check: { kind: "field_matches_source", targets: ["quote.line_items[*].unit_price"], params: { lookup_key: { [input.key_column]: "quote.line_items[*].item_code" }, source_value: input.value_column, compare: "money_equal" } },
        requires: { fields: [], components: ["body.tables"] }, message: { problem: "The price differs from the trusted price list", fix_hint: "Use the price from the current price list." },
      };
  }
}

/** Recover the template a stored rule was built from, so a person can change it with the same plain options. Null if it was not template-shaped. */
export function templateOf(rule: Pick<RuleRevisionContent, "check" | "source">): TemplateInput | null {
  const { kind, targets, params } = rule.check;
  const t = targets.join(",");
  if (kind === "field_in_set" && t === "quote.line_items[*].currency,quote.total.currency" && Array.isArray(params.allowed) && params.allowed.length === 1) return { template: "currency", currency: String(params.allowed[0]) };
  if (kind === "field_present" && targets.length === 1 && isDictionaryField(targets[0])) return { template: "required_field", field: targets[0] };
  if (kind === "text_contains" && typeof params.phrase === "string") return { template: params.mode === "must" ? "required_phrase" : "forbidden_phrase", phrase: params.phrase };
  if (kind === "section_present" && typeof params.heading === "string") return { template: "required_section", heading: params.heading };
  if (kind === "date_window" && t === "quote.valid_until" && typeof params.min_days_ahead === "number" && params.max_days_ahead === undefined) return { template: "validity_window", min_days: params.min_days_ahead };
  if (kind === "arithmetic_consistency" && params.rows === "quote.line_items[*]") return { template: "totals_add_up" };
  if (kind === "no_unresolved_markup" && params.placeholders === undefined) return { template: "no_placeholders" };
  if (kind === "fields_agree" && t === "customer.name,context.project.facts.customer_name") return { template: "customer_matches_project" };
  if (kind === "field_matches_source" && rule.source) {
    const key = Object.keys(params.lookup_key as object)[0];
    if (key) return { template: "price_matches_source", source_id: rule.source.source_id, key_column: key, value_column: String(params.source_value), max_age_days: rule.source.max_age_days };
  }
  return null;
}

/** Scope from the plain options (UX-7b): this project, or one document. Never wider from the editor. */
export function scopeFor(o: { workspace_id: string; project_id: string; work_type: string; artifact_id?: string | null }): RuleScope {
  return {
    level: o.artifact_id ? "artifact" : "project", workspace_id: o.workspace_id, project_selector: null, project_id: o.project_id, area_id: null, artifact_id: o.artifact_id ?? null,
    work_types: [o.work_type], artifact_types: ["document"], actions: [],
  };
}

export const ENFORCEMENT_WORDS: Readonly<Record<Enforcement, string>> = Object.freeze({ block: "Must be fixed before a gated action", warn: "Shown as a note" });
