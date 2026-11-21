/**
 * The closed catalogue of check kinds (docs/03 §5, ADR-003).
 *
 * Rules are data. A rule's requirement is exactly one entry of this frozen table
 * with typed parameters. There is no scripting, no expression language beyond the
 * `applies_when` predicate grammar, and no user-level way to add a kind: adding one
 * is a product release.
 *
 * Kinds this build does not evaluate are still declared, with
 * `availability: "unavailable"`. The engine reports them as `unknown` (or
 * `skipped` for note-only AI opinions) - never as `pass`.
 */
import type { CheckKind, Finding, Method, RuleRevisionContent, SourceSnapshot, TypedValue } from "../domain/types.ts";
import { CHECK_KINDS } from "../domain/types.ts";
import type { EvalEnv, Resolved } from "../engine/fields.ts";
import { decimalAbsDiffWithin, decimalCompare, isDecimal, resolveTarget, scalar } from "../engine/fields.ts";

export type KindOutcome = "pass" | "fail" | "unknown";
export type DraftFinding = Omit<Finding, "finding_id">;

export interface KindResult {
  outcome: KindOutcome;
  reason: string;
  compared: number;
  findings: DraftFinding[];
}

export interface KindInput {
  rule: RuleRevisionContent;
  env: EvalEnv;
  /** The snapshot for `rule.source`, already checked for freshness by the engine. */
  snapshot: SourceSnapshot | null;
  /** The evaluation clock (never the wall clock). */
  asOf: string;
}

export interface CheckKindSpec {
  kind: CheckKind;
  method: Method;
  /** "implemented": evaluated by this build. "unavailable": declared, typed, not evaluated yet. */
  availability: "implemented" | "unavailable";
  /** Where the design places it (docs/03 §5 "MVP" column). */
  phase: "mvp" | "with_spreadsheets" | "later";
  sentence: string;
  validateParams(params: Record<string, unknown>, targets: string[]): string[];
  evaluate?: (input: KindInput) => KindResult;
}

const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const onlyKeys = (params: Record<string, unknown>, allowed: string[]): string[] =>
  Object.keys(params).filter((k) => !allowed.includes(k)).map((k) => `params.${k}: not a parameter of this check kind`);
const none = (params: Record<string, unknown>, allowed: string[] = []): string[] => onlyKeys(params, allowed);

function summarize(parts: Array<{ outcome: KindOutcome; reason: string }>, findings: DraftFinding[], passReason: string): KindResult {
  const failed = parts.filter((p) => p.outcome === "fail");
  const unknown = parts.filter((p) => p.outcome === "unknown");
  if (failed.length) return { outcome: "fail", reason: `${failed.length} of ${parts.length} ${parts.length === 1 ? "value does" : "values do"} not meet the rule`, compared: parts.length, findings };
  if (unknown.length) return { outcome: "unknown", reason: unknown[0]!.reason, compared: parts.length, findings: [] };
  return { outcome: "pass", reason: passReason, compared: parts.length, findings: [] };
}

function finding(rule: RuleRevisionContent, r: Resolved, expected: TypedValue, extra: Partial<DraftFinding> = {}): DraftFinding {
  return {
    location: r.locations[0]!,
    field_path: r.path,
    found: r.value,
    expected,
    message: rule.message.problem,
    ...(rule.message.fix_hint ? { fix_hint: rule.message.fix_hint } : {}),
    ...extra,
  };
}

function resolveAll(input: KindInput): { resolved: Resolved[]; missing: string[] } {
  const resolved: Resolved[] = [];
  const missing: string[] = [];
  for (const target of input.rule.check.targets) {
    const found = resolveTarget(input.env, target);
    if (found.length) resolved.push(...found);
    else missing.push(target);
  }
  return { resolved, missing };
}

const cantRead = (r: Resolved): { outcome: KindOutcome; reason: string } => ({ outcome: "unknown", reason: `${r.path} could not be relied on: ${r.why ?? "unreadable"}` });

// ---------------------------------------------------------------- implemented kinds
function fieldPresent(input: KindInput): KindResult {
  const { resolved, missing } = resolveAll(input);
  const parts: Array<{ outcome: KindOutcome; reason: string }> = [];
  const findings: DraftFinding[] = [];
  for (const target of missing) {
    parts.push({ outcome: "fail", reason: `${target} is missing` });
    findings.push({
      location: { locator: "artifact:/", label: "Whole document" }, field_path: target,
      found: { type: "unknown", reason: "no value found" }, expected: { type: "text", text: "a value" }, message: input.rule.message.problem,
      ...(input.rule.message.fix_hint ? { fix_hint: input.rule.message.fix_hint } : {}),
    });
  }
  for (const r of resolved) {
    if (!r.usable) parts.push(cantRead(r));
    else if (scalar(r.value)?.value === "") {
      parts.push({ outcome: "fail", reason: `${r.path} is empty` });
      findings.push(finding(input.rule, r, { type: "text", text: "a value" }));
    } else parts.push({ outcome: "pass", reason: "" });
  }
  return summarize(parts, findings, `${resolved.length} required ${resolved.length === 1 ? "value is" : "values are"} present`);
}

function fieldInSet(input: KindInput): KindResult {
  const allowed = input.rule.check.params.allowed as string[];
  const { resolved, missing } = resolveAll(input);
  if (missing.length) return { outcome: "unknown", reason: `${missing[0]} could not be found in the document`, compared: 0, findings: [] };
  const findings: DraftFinding[] = [];
  const parts = resolved.map((r) => {
    if (!r.usable) return cantRead(r);
    const s = scalar(r.value);
    if (!s || r.value.type === "money") return { outcome: "unknown" as const, reason: `${r.path} is not a single comparable value` };
    if (allowed.includes(s.value)) return { outcome: "pass" as const, reason: "" };
    findings.push(finding(input.rule, r, { type: "text", text: allowed.join(" or ") }));
    return { outcome: "fail" as const, reason: `${r.path} is ${s.value}` };
  });
  const result = summarize(parts, findings, `${resolved.length} ${resolved.length === 1 ? "value is" : "values are"} in the allowed set (${allowed.join(", ")})`);
  if (result.outcome === "fail") result.reason = `${findings.length} of ${resolved.length} ${resolved.length === 1 ? "value is" : "values are"} not ${allowed.join(" or ")}`;
  return result;
}

function numberCompare(input: KindInput): KindResult {
  const { op, value } = input.rule.check.params as { op: string; value: string };
  const { resolved, missing } = resolveAll(input);
  if (missing.length) return { outcome: "unknown", reason: `${missing[0]} could not be found in the document`, compared: 0, findings: [] };
  const findings: DraftFinding[] = [];
  const parts = resolved.map((r) => {
    if (!r.usable) return cantRead(r);
    const s = scalar(r.value);
    if (!s || s.kind !== "number" || !isDecimal(s.value)) return { outcome: "unknown" as const, reason: `${r.path} is not a number` };
    const cmp = decimalCompare(s.value, value);
    const ok = op === "lt" ? cmp < 0 : op === "le" ? cmp <= 0 : op === "gt" ? cmp > 0 : op === "ge" ? cmp >= 0 : op === "eq" ? cmp === 0 : cmp !== 0;
    if (ok) return { outcome: "pass" as const, reason: "" };
    findings.push(finding(input.rule, r, { type: "text", text: `${op} ${value}` }));
    return { outcome: "fail" as const, reason: `${r.path} is ${s.value}` };
  });
  return summarize(parts, findings, `${resolved.length} ${resolved.length === 1 ? "number meets" : "numbers meet"} ${op} ${value}`);
}

const fold = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim();

function textContains(input: KindInput): KindResult {
  const { phrase, mode } = input.rule.check.params as { phrase: string; mode: "must" | "must_not" };
  const coverage = input.env.artifact.coverage.find((c) => c.component === "body.text");
  if (!coverage || coverage.state !== "parsed") return { outcome: "unknown", reason: "the document text could not be fully read", compared: 0, findings: [] };
  const needle = fold(phrase);
  const hits = input.env.artifact.content.blocks.filter((b) => b.text !== undefined && fold(b.text).includes(needle));
  if (mode === "must") {
    if (hits.length) return { outcome: "pass", reason: `the phrase appears ${hits.length} time(s)`, compared: 1, findings: [] };
    return {
      outcome: "fail", reason: "the required phrase does not appear", compared: 1,
      findings: [{ location: { locator: "artifact:/", label: "Whole document" }, found: { type: "text", text: "phrase not found" }, expected: { type: "text", text: phrase }, message: input.rule.message.problem, ...(input.rule.message.fix_hint ? { fix_hint: input.rule.message.fix_hint } : {}) }],
    };
  }
  if (!hits.length) return { outcome: "pass", reason: "the phrase does not appear", compared: 1, findings: [] };
  return {
    outcome: "fail", reason: `the phrase appears ${hits.length} time(s)`, compared: 1,
    findings: hits.map((b) => ({ location: { locator: b.locator, label: b.label ?? b.locator }, found: { type: "text" as const, text: phrase }, expected: { type: "text" as const, text: "phrase absent" }, message: input.rule.message.problem, ...(input.rule.message.fix_hint ? { fix_hint: input.rule.message.fix_hint } : {}) })),
  };
}

function sectionPresent(input: KindInput): KindResult {
  const { heading } = input.rule.check.params as { heading: string };
  const coverage = input.env.artifact.coverage.find((c) => c.component === "body.text");
  if (!coverage || coverage.state !== "parsed") return { outcome: "unknown", reason: "the document structure could not be fully read", compared: 0, findings: [] };
  const found = input.env.artifact.content.blocks.some((b) => b.kind === "heading" && b.text !== undefined && fold(b.text) === fold(heading));
  if (found) return { outcome: "pass", reason: `a section headed "${heading}" is present`, compared: 1, findings: [] };
  return {
    outcome: "fail", reason: `no section headed "${heading}"`, compared: 1,
    findings: [{ location: { locator: "artifact:/", label: "Whole document" }, found: { type: "text", text: "section not found" }, expected: { type: "text", text: heading }, message: input.rule.message.problem, ...(input.rule.message.fix_hint ? { fix_hint: input.rule.message.fix_hint } : {}) }],
  };
}

function fieldMatchesSource(input: KindInput): KindResult {
  const params = input.rule.check.params as { lookup_key: Record<string, string>; source_value: string; compare: "money_equal" | "text_equal"; tolerance?: string };
  const snapshot = input.snapshot;
  const policy = input.rule.source;
  if (!snapshot || !policy) return { outcome: "unknown", reason: "no trusted source snapshot is available", compared: 0, findings: [] };
  const { resolved, missing } = resolveAll(input);
  if (missing.length) return { outcome: "unknown", reason: `${missing[0]} could not be found in the document`, compared: 0, findings: [] };
  const findings: DraftFinding[] = [];
  const parts = resolved.map((r) => {
    if (!r.usable) return cantRead(r);
    const key: Record<string, string> = {};
    for (const [column, path] of Object.entries(params.lookup_key)) {
      let i = 0;
      const concrete = path.replace(/\[\*\]/g, () => `[${r.indices[i++] ?? 0}]`);
      const k = resolveTarget(input.env, concrete);
      const s = k.length === 1 && k[0]!.usable ? scalar(k[0]!.value) : null;
      if (!s) return { outcome: "unknown" as const, reason: `${concrete} is needed to look up the source and could not be read` };
      key[column] = s.value;
    }
    const rows = snapshot.rows.filter((row) => Object.entries(key).every(([c, v]) => row.key[c] === v));
    const where = Object.entries(key).map(([c, v]) => `${c} ${v}`).join(", ");
    if (rows.length > 1) return { outcome: "unknown" as const, reason: `ambiguous key in the trusted source (${where})` };
    if (rows.length === 0) {
      if (policy.missing_key === "unknown") return { outcome: "unknown" as const, reason: `not in the trusted source (${where})` };
      findings.push(finding(input.rule, r, { type: "text", text: "a row in the trusted source" }, { evidence: { source_id: snapshot.source_id, snapshot_id: snapshot.snapshot_id, source_key: key, detail: "no matching row" } }));
      return { outcome: "fail" as const, reason: `not in the trusted source (${where})` };
    }
    const row = rows[0]!;
    const expected = row.values[params.source_value];
    const found = scalar(r.value);
    if (expected === undefined || !found) return { outcome: "unknown" as const, reason: `the trusted source has no usable ${params.source_value} for ${where}` };
    const equal = params.compare === "money_equal"
      ? isDecimal(expected) && isDecimal(found.value) && decimalAbsDiffWithin(found.value, expected, params.tolerance ?? "0")
      : found.value === expected;
    if (params.compare === "money_equal" && (!isDecimal(expected) || !isDecimal(found.value))) return { outcome: "unknown" as const, reason: `${r.path} or the source value is not a number` };
    if (equal) return { outcome: "pass" as const, reason: "" };
    const expectedValue: TypedValue = r.value.type === "money" ? { type: "money", amount: expected, ...(r.value.currency ? { currency: r.value.currency } : {}) } : { type: "text", text: expected };
    findings.push(finding(input.rule, r, expectedValue, { evidence: { source_id: snapshot.source_id, snapshot_id: snapshot.snapshot_id, source_row: row.row, source_key: key } }));
    return { outcome: "fail" as const, reason: `${r.path} differs from the trusted source` };
  });
  const result = summarize(parts, findings, `${resolved.length} ${resolved.length === 1 ? "value matches" : "values match"} the trusted source`);
  if (result.outcome === "fail") result.reason = `${findings.length} of ${resolved.length} ${resolved.length === 1 ? "line does" : "lines do"} not match the trusted source`;
  return result;
}

// ---------------------------------------------------------------- the table
const unavailable = (kind: CheckKind, method: Method, phase: CheckKindSpec["phase"], sentence: string, paramKeys: string[]): CheckKindSpec => ({
  kind, method, availability: "unavailable", phase, sentence, validateParams: (params) => onlyKeys(params, paramKeys),
});

const specs: CheckKindSpec[] = [
  {
    kind: "field_present", method: "deterministic", availability: "implemented", phase: "mvp", sentence: "A field has a value",
    validateParams: (params) => none(params), evaluate: fieldPresent,
  },
  {
    kind: "field_in_set", method: "deterministic", availability: "implemented", phase: "mvp", sentence: "A field's value is one of an allowed set",
    validateParams: (params) => [
      ...onlyKeys(params, ["allowed"]),
      ...(Array.isArray(params.allowed) && params.allowed.length > 0 && params.allowed.every(str) ? [] : ["params.allowed: a non-empty list of text values is required"]),
    ],
    evaluate: fieldInSet,
  },
  {
    kind: "number_compare", method: "deterministic", availability: "implemented", phase: "mvp", sentence: "A number compared with a constant",
    validateParams: (params) => [
      ...onlyKeys(params, ["op", "value"]),
      ...(["lt", "le", "gt", "ge", "eq", "ne"].includes(params.op as string) ? [] : ["params.op: one of lt, le, gt, ge, eq, ne"]),
      ...(isDecimal(params.value) ? [] : ["params.value: a decimal string is required (comparison with another field is not available in this build)"]),
    ],
    evaluate: numberCompare,
  },
  {
    kind: "text_contains", method: "deterministic", availability: "implemented", phase: "mvp", sentence: "A phrase must, or must not, appear",
    validateParams: (params) => [
      ...onlyKeys(params, ["phrase", "mode"]).map((p) => (p.startsWith("params.pattern") ? "params.pattern: restricted patterns are not available in this build; literal phrases only" : p)),
      ...(str(params.phrase) && (params.phrase as string).length <= 500 ? [] : ["params.phrase: a literal phrase of 1 to 500 characters is required"]),
      ...(params.mode === "must" || params.mode === "must_not" ? [] : ["params.mode: must or must_not"]),
    ],
    evaluate: textContains,
  },
  {
    kind: "section_present", method: "deterministic", availability: "implemented", phase: "mvp", sentence: "A heading or named section exists",
    validateParams: (params) => [...onlyKeys(params, ["heading"]), ...(str(params.heading) ? [] : ["params.heading: the section heading is required"])],
    evaluate: sectionPresent,
  },
  {
    kind: "field_matches_source", method: "source_backed", availability: "implemented", phase: "mvp", sentence: "A field equals the value looked up in a trusted source snapshot",
    validateParams: (params) => {
      const key = params.lookup_key;
      const keyOk = key !== null && typeof key === "object" && !Array.isArray(key) && Object.keys(key).length > 0 && Object.values(key as object).every(str);
      return [
        ...onlyKeys(params, ["lookup_key", "source_value", "compare", "tolerance"]),
        ...(keyOk ? [] : ["params.lookup_key: a map of source column to field path is required"]),
        ...(str(params.source_value) ? [] : ["params.source_value: the source value column is required"]),
        ...(params.compare === "money_equal" || params.compare === "text_equal" ? [] : ["params.compare: money_equal or text_equal"]),
        ...(params.tolerance === undefined || isDecimal(params.tolerance) ? [] : ["params.tolerance: a decimal string"]),
      ];
    },
    evaluate: fieldMatchesSource,
  },
  // Declared and typed, not evaluated in the Phase 1 scaffold (see HANDOFF.md "Check kinds").
  unavailable("fields_agree", "deterministic", "mvp", "Two fields, or a field and a project fact, are equal after normalization", ["normalize"]),
  unavailable("date_window", "deterministic", "mvp", "A date relative to the check time or another date", ["min_days_ahead", "max_days_ahead", "relative_to"]),
  unavailable("arithmetic_consistency", "deterministic", "mvp", "Row products and column sums hold within a tolerance", ["rows", "quantity", "unit_price", "amount", "total", "tolerance"]),
  unavailable("no_unresolved_markup", "deterministic", "mvp", "No comments, tracked changes or highlighted placeholders", ["placeholders"]),
  unavailable("attestation", "attested", "mvp", "A person with a named role confirms a statement for this exact version", ["statement", "role"]),
  unavailable("no_hidden_content", "deterministic", "with_spreadsheets", "No hidden sheets, rows, columns or hidden text", ["region"]),
  unavailable("rows_unique", "deterministic", "with_spreadsheets", "No duplicate rows by key columns", ["key_columns"]),
  unavailable("value_is_formula", "deterministic", "with_spreadsheets", "A value is computed by a formula over a stated range", ["range"]),
  unavailable("model_review", "model_review", "later", "An AI model's opinion on a stated criterion (note only)", ["criterion"]),
];

export const CATALOGUE: Readonly<Record<CheckKind, CheckKindSpec>> = Object.freeze(
  Object.fromEntries(specs.map((s) => [s.kind, Object.freeze(s)])) as Record<CheckKind, CheckKindSpec>,
);

export function isCheckKind(kind: unknown): kind is CheckKind {
  return typeof kind === "string" && (CHECK_KINDS as readonly string[]).includes(kind) && Object.hasOwn(CATALOGUE, kind);
}

/**
 * Static pairwise analysis for comparable kinds (docs/03 §10.5). Phase 1 covers
 * allowed sets on the same target; other comparable kinds are a Phase 2 extension.
 */
export type Relation = "duplicate" | "conflict" | "unrelated";
export function relate(a: RuleRevisionContent, b: RuleRevisionContent): Relation {
  if (a.check.kind !== "field_in_set" || b.check.kind !== "field_in_set") return "unrelated";
  const shared = a.check.targets.filter((t) => b.check.targets.includes(t));
  if (!shared.length) return "unrelated";
  const [x, y] = [a.check.params.allowed as string[], b.check.params.allowed as string[]];
  if (!x.some((v) => y.includes(v))) return "conflict";
  const sameSet = x.length === y.length && x.every((v) => y.includes(v));
  const sameTargets = a.check.targets.length === b.check.targets.length && shared.length === a.check.targets.length;
  return sameSet && sameTargets ? "duplicate" : "unrelated";
}
