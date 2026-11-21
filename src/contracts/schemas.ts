/**
 * Deterministic contract validation against the proposed JSON Schemas in /schemas.
 *
 * The schemas deliberately use a small draft 2020-12 subset (schemas/README.md) so a
 * dependency-free validator can check them. This is the TypeScript counterpart of
 * `validate()` in tools/check_repo.py, and the two must agree on the design fixtures
 * (test/contracts.test.ts enforces that for every example file).
 */
import { readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { ValidationError } from "../domain/errors.ts";
import { repoRoot } from "../paths.ts";

type Schema = Record<string, any>;

export const SCHEMA_BY_VERSION: Readonly<Record<string, string>> = Object.freeze({
  "cl.rule/1": "rule", "cl.correction/1": "correction", "cl.source_snapshot/1": "source-snapshot",
  "cl.artifact/1": "artifact", "cl.context/1": "context", "cl.run/1": "run", "cl.receipt/1": "receipt",
  "cl.action/1": "action-request", "cl.event/1": "event", "cl.event_log/1": "event-log", "cl.marker/1": "folder-marker",
  "cl.learning_policy/1": "learning-policy", "cl.learning_signal/1": "learning-signal",
  "cl.learning_decision/1": "learning-decision", "cl.capture_event/1": "capture-event", "cl.capture_stream/1": "capture-stream",
});
export type SchemaName =
  | "rule" | "correction" | "source-snapshot" | "artifact" | "context" | "run" | "receipt" | "action-request" | "event"
  | "event-log" | "folder-marker" | "learning-policy" | "learning-signal" | "learning-decision" | "capture-event"
  | "capture-stream" | "common";

const cache = new Map<string, Schema>();
const schemaDir = (): string => join(repoRoot(), "schemas");

function load(path: string): Schema {
  let schema = cache.get(path);
  if (!schema) {
    schema = JSON.parse(readFileSync(path, "utf8")) as Schema;
    cache.set(path, schema);
  }
  return schema;
}

function resolveRef(ref: string, base: string): [Schema, string] {
  const hash = ref.indexOf("#");
  const filePart = hash === -1 ? ref : ref.slice(0, hash);
  const pointer = hash === -1 ? "" : ref.slice(hash + 1);
  const path = filePart ? normalize(join(dirname(base), filePart)) : base;
  let node: any = load(path);
  for (const part of pointer.split("/").filter(Boolean)) node = node[part.replace(/~1/g, "/").replace(/~0/g, "~")];
  if (node === undefined) throw new Error(`unresolvable $ref ${ref} from ${base}`);
  return [node as Schema, path];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const TYPES: Record<string, (v: unknown) => boolean> = {
  string: (v) => typeof v === "string",
  integer: (v) => typeof v === "number" && Number.isInteger(v),
  number: (v) => typeof v === "number" && Number.isFinite(v),
  boolean: (v) => typeof v === "boolean",
  object: isObj,
  array: Array.isArray,
  null: (v) => v === null,
};

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function check(value: unknown, schema: Schema, base: string, at: string): string[] {
  let out: string[] = [];
  if ("$ref" in schema) {
    const [target, tbase] = resolveRef(schema.$ref, base);
    out = out.concat(check(value, target, tbase, at));
  }
  if ("type" in schema && !TYPES[schema.type]!(value)) return out.concat(`${at}: expected ${schema.type}`);
  if ("const" in schema && !same(value, schema.const)) out.push(`${at}: expected constant ${JSON.stringify(schema.const)}`);
  if ("enum" in schema && !(schema.enum as unknown[]).some((e) => same(e, value))) out.push(`${at}: ${JSON.stringify(value)} is not one of the allowed values`);
  if ("pattern" in schema && typeof value === "string" && !new RegExp(schema.pattern).test(value)) out.push(`${at}: ${JSON.stringify(value)} does not match ${schema.pattern}`);
  if ("minimum" in schema && typeof value === "number" && value < schema.minimum) out.push(`${at}: below minimum ${schema.minimum}`);
  if ("maximum" in schema && typeof value === "number" && value > schema.maximum) out.push(`${at}: above maximum ${schema.maximum}`);
  for (const sub of schema.allOf ?? []) out = out.concat(check(value, sub, base, at));
  if ("anyOf" in schema) {
    const attempts = (schema.anyOf as Schema[]).map((sub) => check(value, sub, base, at));
    if (!attempts.some((a) => a.length === 0)) out.push(`${at}: matches none of the alternatives (${attempts.map((a) => a[0]).join("; ")})`);
  }
  if (isObj(value)) {
    const props: Record<string, Schema> = schema.properties ?? {};
    for (const key of schema.required ?? []) if (!(key in value)) out.push(`${at}: missing required property "${key}"`);
    for (const [key, sub] of Object.entries(value)) {
      if (Object.hasOwn(props, key)) out = out.concat(check(sub, props[key]!, base, `${at}.${key}`));
      else if (schema.additionalProperties === false) out.push(`${at}: unexpected property "${key}"`);
    }
  }
  if (Array.isArray(value)) {
    if (value.length < (schema.minItems ?? 0)) out.push(`${at}: fewer than ${schema.minItems} items`);
    if ("items" in schema) value.forEach((item, i) => { out = out.concat(check(item, schema.items, base, `${at}[${i}]`)); });
  }
  return out;
}

/** Returns the list of problems (empty when valid). `pointer` selects a sub-schema, e.g. "#/$defs/predicate". */
export function problems(name: SchemaName, value: unknown, pointer = ""): string[] {
  const path = join(schemaDir(), `${name}.schema.json`);
  const [schema, base] = pointer ? resolveRef(pointer, path) : [load(path), path];
  return check(value, schema, base, "$");
}

/** Throws ValidationError unless `value` matches the named contract. */
export function assertValid(name: SchemaName, value: unknown, what: string = name): void {
  const found = problems(name, value);
  if (found.length) throw new ValidationError(`${what} does not match schemas/${name}.schema.json`, found);
}
