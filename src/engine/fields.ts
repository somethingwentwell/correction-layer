/**
 * Target resolution for rules and predicates (docs/03 §5). Three namespaces:
 * semantic fields of the artifact, the action envelope (`action.*`) and context
 * (`context.*`). Nothing here interprets artifact text as instructions: it only
 * looks up typed values by path.
 */
import type { ActionEnvelope, Location, NormalizedArtifact, ResolvedContext, TypedValue } from "../domain/types.ts";

export interface EvalEnv {
  artifact: NormalizedArtifact;
  action: ActionEnvelope;
  context: ResolvedContext;
}

export interface Resolved {
  path: string;
  value: TypedValue;
  locations: Location[];
  /** False when a must-pass rule may not rely on this value (unknown, low confidence, model-suggested). */
  usable: boolean;
  why?: string;
  /** Indices captured by `[*]` in the target, used to line up related fields of the same row. */
  indices: number[];
}

export const MIN_CONFIDENCE = 0.99;
const WHOLE: Location = { locator: "artifact:/", label: "Whole document" };

/** Targets that govern who may do what (docs/12 §7.1 L4). Learning may never read them. */
export function isProtectedTarget(path: string): boolean {
  return path.startsWith("action.") || path.startsWith("context.");
}

function targetRegex(target: string): RegExp {
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\[\\\*\\\]/g, "\\[(\\d+)\\]");
  return new RegExp(`^${escaped}$`);
}

function fromPlain(value: unknown): TypedValue {
  if (typeof value === "string") return { type: "text", text: value };
  if (typeof value === "number") return { type: "number", number: String(value) };
  if (typeof value === "boolean") return { type: "boolean", boolean: value };
  if (Array.isArray(value)) return { type: "list", items: value };
  return { type: "unknown", reason: "value is absent" };
}

function lookupPlain(root: unknown, segments: string[]): unknown {
  let node: any = root;
  for (const s of segments) {
    if (node === null || typeof node !== "object") return undefined;
    node = node[s];
  }
  return node;
}

function assess(value: TypedValue, method: string, confidence: number): Pick<Resolved, "usable" | "why"> {
  if (value.type === "unknown") return { usable: false, why: value.reason ?? "the value could not be read" };
  if (method === "model_suggested") return { usable: false, why: "the value was suggested by an AI model and has not been confirmed by a person" };
  if (confidence < MIN_CONFIDENCE) return { usable: false, why: "the value was read with low confidence and needs confirmation" };
  return { usable: true };
}

function component(parent: TypedValue, part: string): TypedValue | undefined {
  if (parent.type !== "money") return undefined;
  if (part === "currency") return parent.currency ? { type: "text", text: parent.currency } : { type: "unknown", reason: "the currency is not stated unambiguously (write a currency code such as SGD)" };
  if (part === "amount") return parent.amount !== undefined ? { type: "number", number: parent.amount } : { type: "unknown", reason: "the amount could not be read" };
  return undefined;
}

/** Every value a target addresses. An empty list means "nothing readable at that path". */
export function resolveTarget(env: EvalEnv, target: string): Resolved[] {
  if (target.startsWith("action.") || target.startsWith("context.")) {
    const [ns, ...rest] = target.split(".");
    const root = ns === "action" ? env.action : { project: { facts: env.context.facts, project_id: env.context.project_id }, work_type: env.context.work_type };
    const value = lookupPlain(root, rest);
    if (value === undefined || value === null) return [];
    return [{ path: target, value: fromPlain(value), locations: [{ locator: `${ns}:/${rest.join("/")}`, label: ns === "action" ? "Action request" : "Project context" }], usable: true, indices: [] }];
  }
  const out: Resolved[] = [];
  const re = targetRegex(target);
  for (const f of env.artifact.fields) {
    const m = re.exec(f.path);
    if (m) out.push({ path: f.path, value: f.value, locations: f.locations.length ? f.locations : [WHOLE], indices: m.slice(1).map(Number), ...assess(f.value, f.method, f.confidence) });
  }
  if (out.length) return out;
  // Component of a typed value, e.g. `quote.total.currency` where `quote.total` is money.
  const dot = target.lastIndexOf(".");
  if (dot > 0) {
    const part = target.slice(dot + 1);
    const parentRe = targetRegex(target.slice(0, dot));
    for (const f of env.artifact.fields) {
      const m = parentRe.exec(f.path);
      const value = m ? component(f.value, part) : undefined;
      if (m && value) out.push({ path: `${f.path}.${part}`, value, locations: f.locations.length ? f.locations : [WHOLE], indices: m.slice(1).map(Number), ...assess(value, f.method, f.confidence) });
    }
  }
  return out;
}

export interface Scalar {
  kind: "text" | "number" | "date" | "boolean";
  value: string;
}

export function scalar(v: TypedValue): Scalar | null {
  switch (v.type) {
    case "text": return v.text === undefined ? null : { kind: "text", value: v.text };
    case "number": case "percent": return v.number === undefined ? null : { kind: "number", value: v.number };
    case "money": return v.amount === undefined ? null : { kind: "number", value: v.amount };
    case "date": return v.date === undefined ? null : { kind: "date", value: v.date };
    case "boolean": return v.boolean === undefined ? null : { kind: "boolean", value: String(v.boolean) };
    default: return null;
  }
}

const DECIMAL_RE = /^-?\d+(\.\d+)?$/;
export const isDecimal = (s: unknown): s is string => typeof s === "string" && DECIMAL_RE.test(s);

/** Exact decimal comparison on strings: numbers that matter are never binary floats. */
export function decimalCompare(a: string, b: string): number {
  if (!isDecimal(a) || !isDecimal(b)) throw new RangeError(`not a decimal string: ${JSON.stringify(isDecimal(a) ? b : a)}`);
  const scale = Math.max(a.split(".")[1]?.length ?? 0, b.split(".")[1]?.length ?? 0);
  const toBig = (s: string): bigint => {
    const [int, frac = ""] = s.split(".");
    return BigInt(int! + frac.padEnd(scale, "0"));
  };
  const [x, y] = [toBig(a), toBig(b)];
  return x < y ? -1 : x > y ? 1 : 0;
}

export function decimalAbsDiffWithin(a: string, b: string, tolerance: string): boolean {
  const scale = Math.max(...[a, b, tolerance].map((s) => s.split(".")[1]?.length ?? 0));
  const toBig = (s: string): bigint => {
    const [int, frac = ""] = s.split(".");
    return BigInt(int! + frac.padEnd(scale, "0"));
  };
  const diff = toBig(a) - toBig(b);
  return (diff < 0n ? -diff : diff) <= toBig(tolerance);
}
