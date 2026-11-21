import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { SCHEMA_BY_VERSION, assertValid, problems } from "../src/contracts/schemas.ts";
import type { SchemaName } from "../src/contracts/schemas.ts";
import { ValidationError } from "../src/domain/errors.ts";
import { CHECK_KINDS } from "../src/domain/types.ts";
import { repoRoot } from "../src/paths.ts";
import { CATALOGUE, isCheckKind } from "../src/policy/catalogue.ts";
import { predicateProblems } from "../src/policy/predicate.ts";
import { ruleProblems } from "../src/policy/rules.ts";
import { fixture, makeApp, ruleContent } from "./helpers.ts";

function exampleFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name));
      else if (entry.name.endsWith(".json")) out.push(join(dir, entry.name));
    }
  };
  walk(join(repoRoot(), "examples"));
  return out.sort();
}

test("every design example validates against its proposed schema (same answer as tools/check_repo.py)", () => {
  let validated = 0;
  for (const file of exampleFiles()) {
    const doc = JSON.parse(readFileSync(file, "utf8"));
    const name = SCHEMA_BY_VERSION[doc.schema_version];
    if (!name) continue;
    assert.deepEqual(problems(name as SchemaName, doc), [], file);
    validated++;
  }
  assert.equal(validated, 28, "the checker reports 28 schema-validated example files");
});

test("contract validation is deterministic and rejects malformed records", () => {
  const rule = fixture("examples/learning/rule-kestrel-sgd.json");
  assert.deepEqual(problems("rule", rule), []);
  assert.ok(problems("rule", { ...rule, rule_id: "not an id" }).some((p) => p.includes("does not match")));
  assert.ok(problems("rule", { ...rule, surprise: true }).some((p) => p.includes("unexpected property")));
  assert.ok(problems("rule", { ...rule, enforcement: "maybe" }).length > 0);
  const { owner: _owner, ...missing } = rule;
  assert.ok(problems("rule", missing).some((p) => p.includes('missing required property "owner"')));
  assert.throws(() => assertValid("capture-event", { kind: "user_turn" }), ValidationError);
  assert.deepEqual(problems("common", { all: [{ field: "quote.total", op: "ge", value: "100000" }] }, "#/$defs/predicate"), []);
  assert.ok(problems("common", { script: "return true" }, "#/$defs/predicate").length > 0);
});

test("the check catalogue is closed: rules are data from a fixed list, never scripts (ADR-003)", () => {
  const app = makeApp();
  assert.ok(Object.isFrozen(CATALOGUE));
  assert.deepEqual(Object.keys(CATALOGUE).sort(), [...CHECK_KINDS].sort(), "exactly the kinds the rule schema allows");
  assert.throws(() => {
    (CATALOGUE as any).run_script = { kind: "run_script" };
  }, TypeError);
  for (const forged of ["run_script", "javascript", "shell", "eval", "__proto__", "constructor", "toString"]) {
    assert.equal(isCheckKind(forged), false, forged);
    const rule = ruleContent(app, { rule_id: "rul_FORGED01", check: { kind: forged as any, targets: ["quote.total"], params: { code: "process.exit(1)" } } });
    assert.throws(() => app.rules.createCandidate(rule, app.localUser), ValidationError, `kind ${forged} is refused`);
  }
  // Parameters are typed per kind; anything else (including code-like params) is refused.
  assert.ok(ruleProblems(ruleContent(app, { rule_id: "rul_BADPARAM", check: { kind: "field_in_set", targets: ["quote.total.currency"], params: { allowed: ["SGD"], script: "x" } } })).some((p) => p.includes("params.script")));
  assert.ok(ruleProblems(ruleContent(app, { rule_id: "rul_BADPARAM", check: { kind: "text_contains", targets: ["content"], params: { phrase: "x", mode: "must", pattern: "(a+)+$" } } })).some((p) => p.includes("patterns are not available")));
  assert.ok(ruleProblems(ruleContent(app, { rule_id: "rul_BADPARAM", check: { kind: "field_in_set", targets: ["quote.total.currency"], params: { allowed: [] } } })).length > 0);
  // The predicate grammar is closed as well.
  assert.deepEqual(predicateProblems({ all: [{ field: "quote.total", op: "ge", value: "100000" }, { not: { field: "x", op: "exists" } }] }), []);
  for (const bad of [{ js: "1==1" }, { field: "x", op: "matches", value: ".*" }, { all: [] }, { field: "x", op: "eq", value: 1, then: "pass" }, "true"]) assert.ok(predicateProblems(bad).length > 0, JSON.stringify(bad));
  assert.equal(app.rules.listAll().length, 0, "nothing was stored");
});

test("AT-E9: a model_review rule can never block; method must match the check kind", () => {
  const app = makeApp();
  const opinion = ruleContent(app, { rule_id: "rul_OPINION1", method: "model_review", enforcement: "block", check: { kind: "model_review", targets: ["content"], params: { criterion: "reads well" } }, requires: { fields: [], components: [] } });
  assert.throws(() => app.rules.createCandidate(opinion, app.localUser), /AI opinion never blocks/);
  assert.ok(ruleProblems(ruleContent(app, { rule_id: "rul_METHOD01", method: "attested" })).some((p) => p.includes("is deterministic")));
  assert.ok(ruleProblems(ruleContent(app, { rule_id: "rul_SCOPE001", scope: { ...ruleContent(app, { rule_id: "rul_X00001" }).scope, level: "project" } })).some((p) => p.includes("scope.project_id")));
});
