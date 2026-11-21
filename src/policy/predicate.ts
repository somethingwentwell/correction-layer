/**
 * The closed predicate grammar for `applies_when` (docs/03 §5): a tree of all/any/not
 * over {field, op, value} leaves. Nothing else: no expressions, no scripts.
 * A leaf whose field cannot be read is UNDECIDABLE, which the engine reports as
 * `unknown` - an unreadable document does not escape a conditional rule.
 */
import type { Predicate } from "../domain/types.ts";
import type { EvalEnv } from "../engine/fields.ts";
import { decimalCompare, isDecimal, resolveTarget, scalar } from "../engine/fields.ts";

export type Tri = "true" | "false" | "undecidable";
export interface PredicateResult {
  result: Tri;
  /** Plain account of the deciding value, shown with `not_applicable`. */
  detail: string;
}

const OPS = ["eq", "ne", "in", "not_in", "lt", "le", "gt", "ge", "exists"] as const;

export function predicateProblems(p: unknown, at = "applies_when"): string[] {
  if (p === null || typeof p !== "object" || Array.isArray(p)) return [`${at}: must be an object`];
  const o = p as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length === 1 && (keys[0] === "all" || keys[0] === "any")) {
    const list = o[keys[0]!];
    if (!Array.isArray(list) || list.length === 0) return [`${at}.${keys[0]}: needs at least one predicate`];
    return list.flatMap((sub, i) => predicateProblems(sub, `${at}.${keys[0]}[${i}]`));
  }
  if (keys.length === 1 && keys[0] === "not") return predicateProblems(o.not, `${at}.not`);
  if (typeof o.field === "string" && (OPS as readonly string[]).includes(o.op as string) && keys.every((k) => ["field", "op", "value"].includes(k))) {
    if ((o.op === "in" || o.op === "not_in") && !Array.isArray(o.value)) return [`${at}: ${o.op} needs a list value`];
    if (o.op !== "exists" && o.value === undefined) return [`${at}: ${o.op} needs a value`];
    return [];
  }
  return [`${at}: not part of the predicate grammar (all, any, not, or {field, op, value})`];
}

function leaf(env: EvalEnv, p: { field: string; op: string; value?: unknown }): PredicateResult {
  const resolved = resolveTarget(env, p.field);
  if (p.op === "exists") return { result: resolved.length ? "true" : "false", detail: `${p.field} ${resolved.length ? "is present" : "is absent"}` };
  if (resolved.length !== 1 || !resolved[0]!.usable) return { result: "undecidable", detail: `${p.field} could not be read${resolved[0]?.why ? `: ${resolved[0].why}` : ""}` };
  const s = scalar(resolved[0]!.value);
  if (!s) return { result: "undecidable", detail: `${p.field} has no comparable value` };
  const detail = `${p.field} is ${s.value}`;
  const equal = (v: unknown): boolean => (s.kind === "number" && isDecimal(String(v)) ? decimalCompare(s.value, String(v)) === 0 : s.value === String(v));
  const yes = (b: boolean): PredicateResult => ({ result: b ? "true" : "false", detail });
  switch (p.op) {
    case "eq": return yes(equal(p.value));
    case "ne": return yes(!equal(p.value));
    case "in": return yes((p.value as unknown[]).some(equal));
    case "not_in": return yes(!(p.value as unknown[]).some(equal));
    default: {
      const other = String(p.value);
      let cmp: number;
      if (s.kind === "number" && isDecimal(other)) cmp = decimalCompare(s.value, other);
      else if (s.kind === "date" && /^\d{4}-\d{2}-\d{2}$/.test(other)) cmp = s.value < other ? -1 : s.value > other ? 1 : 0;
      else return { result: "undecidable", detail: `${p.field} cannot be ordered against ${other}` };
      return yes(p.op === "lt" ? cmp < 0 : p.op === "le" ? cmp <= 0 : p.op === "gt" ? cmp > 0 : cmp >= 0);
    }
  }
}

export function evaluatePredicate(env: EvalEnv, p: Predicate): PredicateResult {
  if ("all" in p || "any" in p) {
    const isAll = "all" in p;
    const parts = (isAll ? p.all : (p as { any: Predicate[] }).any).map((sub) => evaluatePredicate(env, sub));
    const decisive = parts.find((r) => r.result === (isAll ? "false" : "true"));
    if (decisive) return decisive;
    const undecidable = parts.find((r) => r.result === "undecidable");
    if (undecidable) return undecidable;
    return { result: isAll ? "true" : "false", detail: parts.map((r) => r.detail).join("; ") };
  }
  if ("not" in p) {
    const inner = evaluatePredicate(env, p.not);
    return inner.result === "undecidable" ? inner : { result: inner.result === "true" ? "false" : "true", detail: inner.detail };
  }
  return leaf(env, p);
}

/** Every field path a predicate reads (used to reject learned rules that read protected targets). */
export function predicateFields(p: Predicate | null | undefined): string[] {
  if (!p) return [];
  if ("all" in p) return p.all.flatMap(predicateFields);
  if ("any" in p) return p.any.flatMap(predicateFields);
  if ("not" in p) return predicateFields(p.not);
  return [p.field];
}
