/**
 * Phase 2 check kinds (fields_agree, date_window, arithmetic_consistency,
 * no_unresolved_markup) and the wider static duplicate / conflict analysis
 * (AT-G5 static half). All data is FICTIONAL test data.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { digestOf } from "../src/domain/canonical.ts";
import type { NormalizedArtifact, ResolvedContext, RuleRevisionContent } from "../src/domain/types.ts";
import type { EngineRule } from "../src/engine/evaluate.ts";
import { evaluate } from "../src/engine/evaluate.ts";
import { decimalAdd, decimalMul } from "../src/engine/fields.ts";
import { readArtifact } from "../src/formats/adapters.ts";
import { relate } from "../src/policy/catalogue.ts";
import { ruleProblems } from "../src/policy/rules.ts";
import { enc, makeApp, quote, ruleContent } from "./helpers.ts";

const app = makeApp();
const AS_OF = "2026-11-17T06:00:00Z";
const context: ResolvedContext = { workspace_id: app.workspaceId, project_id: "prj_KINDS001", area_ids: [], work_type: "sales_proposal", status: "resolved", basis: ["binding"], facts: { customer_name: "Kestrel Dental Group" } };

function artifactFrom(bytes: Uint8Array): NormalizedArtifact {
  const read = readArtifact(bytes, "q.md", "sales_proposal");
  assert.ok(read.parsed, read.error?.message);
  return { schema_version: "cl.artifact/1", artifact_id: "art_KINDS001", name: "q.md", version: { seq: 1, content_hash: digestOf([...bytes]), observed_at: AS_OF }, identity: read.identity, ...read.parsed };
}
const content = (id: string, check: RuleRevisionContent["check"]): RuleRevisionContent => ruleContent(app, { rule_id: id, check, requires: { fields: [], components: [] } });
const rule = (id: string, check: RuleRevisionContent["check"]): EngineRule => {
  const c = content(id, check);
  return { content: c, status: "active", content_digest: digestOf(c) };
};
const one = (bytes: Uint8Array, r: EngineRule) => evaluate({ run_id: "run_KINDS001", artifact: artifactFrom(bytes), action: { type: "release" }, context, rules: [r], sources: [], exceptions: [], as_of: AS_OF });

test("exact decimal arithmetic: no binary floating point anywhere in money checks", () => {
  assert.equal(decimalMul("12", "1180.00"), "14160.00");
  assert.equal(decimalMul("0.1", "0.2"), "0.02");
  assert.equal(decimalAdd("0.1", "0.2"), "0.3");
  assert.equal(decimalAdd("-1.50", "1"), "-0.50");
});

test("fields_agree: a document value against a person-confirmed project fact; casefold is explicit", () => {
  const agree = rule("rul_AGREE001", { kind: "fields_agree", targets: ["customer.name", "context.project.facts.customer_name"], params: { normalize: "casefold" } });
  assert.equal(one(quote({ customer: "Kestrel Dental Group" }), agree).results[0]!.outcome, "pass");
  assert.equal(one(quote({ customer: "KESTREL  dental group" }), agree).results[0]!.outcome, "pass");
  const wrong = one(quote({ customer: "Meridian Clinics" }), agree).results[0]!;
  assert.equal(wrong.outcome, "fail");
  assert.equal(wrong.findings[0]!.expected.text, "Kestrel Dental Group");
  assert.equal(wrong.findings[0]!.location.label, "Line 3");
  const exact = rule("rul_AGREE002", { kind: "fields_agree", targets: ["customer.name", "context.project.facts.customer_name"], params: {} });
  assert.equal(one(quote({ customer: "KESTREL dental group" }), exact).results[0]!.outcome, "fail");
  // A missing fact cannot be agreed with: unknown, never pass.
  const missing = rule("rul_AGREE003", { kind: "fields_agree", targets: ["customer.name", "context.project.facts.region"], params: {} });
  assert.equal(one(quote(), missing).results[0]!.outcome, "unknown");
  assert.deepEqual(ruleProblems(content("rul_AGREE004", { kind: "fields_agree", targets: ["customer.name"], params: {} })), ["targets: exactly two paths (the value, and what it must agree with)"]);
});

test("date_window: relative to the check time (never the wall clock); unreadable dates are unknown", () => {
  const thirty = rule("rul_DATE0001", { kind: "date_window", targets: ["quote.valid_until"], params: { min_days_ahead: 30 } });
  const doc = (valid: string): Uint8Array => enc(new TextDecoder().decode(quote()).replace("Valid until: 12 January 2027", `Valid until: ${valid}`));
  assert.equal(one(doc("12 January 2027"), thirty).results[0]!.outcome, "pass", "56 days after 17 Nov 2026");
  assert.equal(one(doc("2026-12-17"), thirty).results[0]!.outcome, "pass", "exactly 30 days is inside");
  const short = one(doc("2026-12-01"), thirty).results[0]!;
  assert.equal(short.outcome, "fail");
  assert.match(short.findings[0]!.expected.text!, /on or after 2026-12-17/);
  assert.equal(one(doc("03/04/2027"), thirty).results[0]!.outcome, "unknown", "an ambiguous date is never guessed");
  const window = rule("rul_DATE0002", { kind: "date_window", targets: ["quote.valid_until"], params: { min_days_ahead: 0, max_days_ahead: 30 } });
  assert.equal(one(doc("12 January 2027"), window).results[0]!.outcome, "fail");
  assert.ok(ruleProblems(content("rul_DATE0003", { kind: "date_window", targets: ["quote.valid_until"], params: {} })).some((p) => /min_days_ahead, max_days_ahead or both/.test(p)));
  assert.ok(ruleProblems(content("rul_DATE0004", { kind: "date_window", targets: ["quote.valid_until"], params: { min_days_ahead: 40, max_days_ahead: 10 } })).some((p) => /after max_days_ahead/.test(p)));
});

test("arithmetic_consistency: line products and the total, exactly; mixed or bare currencies are unknown", () => {
  const sums = rule("rul_ARITH001", { kind: "arithmetic_consistency", targets: ["quote.line_items[*].amount", "quote.total"], params: { rows: "quote.line_items[*]", quantity: "quantity", unit_price: "unit_price", amount: "amount", total: "quote.total" } });
  assert.equal(one(quote({ currency: "SGD" }), sums).results[0]!.outcome, "pass");
  const badTotal = one(quote({ currency: "SGD", total: "17,000.00" }), sums).results[0]!;
  assert.equal(badTotal.outcome, "fail");
  assert.deepEqual(badTotal.findings.map((f) => [f.field_path, f.expected.amount]), [["quote.total", "17760.00"]]);
  const badLine = new TextDecoder().decode(quote({ currency: "SGD" })).replace("SGD 14,160.00", "SGD 14,100.00");
  const lines = one(enc(badLine), sums).results[0]!;
  assert.equal(lines.outcome, "fail");
  assert.ok(lines.findings.some((f) => f.field_path === "quote.line_items[0].amount" && f.expected.amount === "14160.00"));
  assert.equal(one(quote({ money: (a) => `$${a}` }), sums).results[0]!.outcome, "unknown", "a bare $ is not one stated currency");
});

test("no_unresolved_markup: placeholders are found at their location; formats that hide comments cannot pass", () => {
  const markup = rule("rul_MARKUP01", { kind: "no_unresolved_markup", targets: ["content"], params: {} });
  assert.equal(one(quote(), markup).results[0]!.outcome, "pass");
  const tbd = one(quote({ extra: "Delivery: TBD with the customer" }), markup).results[0]!;
  assert.equal(tbd.outcome, "fail");
  assert.equal(tbd.findings[0]!.location.locator, "text:/line[6]");
  assert.equal(one(quote({ extra: "Ships from Tbdville" }), markup).results[0]!.outcome, "pass", "whole-word match for word placeholders");
  // A reader that reports comments as not parsed: the rule cannot rule markup out.
  const artifact = artifactFrom(quote());
  artifact.coverage = artifact.coverage.map((c) => (c.component === "comments" ? { ...c, state: "detected_not_parsed" as const } : c));
  const out = evaluate({ run_id: "run_KINDS002", artifact, action: { type: "release" }, context, rules: [markup], sources: [], exceptions: [], as_of: AS_OF });
  assert.equal(out.results[0]!.outcome, "unknown");
});

test("AT-G5 (static half): duplicates and conflicts beyond allowed sets are found before anything runs", () => {
  const num = (id: string, op: string, value: string) => content(id, { kind: "number_compare", targets: ["quote.line_items[*].quantity"], params: { op, value } });
  assert.equal(relate(num("rul_N0000001", "ge", "10"), num("rul_N0000002", "ge", "10")), "duplicate");
  assert.equal(relate(num("rul_N0000001", "ge", "10"), num("rul_N0000003", "lt", "10")), "conflict");
  assert.equal(relate(num("rul_N0000001", "ge", "10"), num("rul_N0000004", "le", "10")), "unrelated", "they meet at exactly 10");
  assert.equal(relate(num("rul_N0000001", "gt", "10"), num("rul_N0000005", "le", "10")), "conflict");
  assert.equal(relate(num("rul_N0000001", "ne", "10"), num("rul_N0000006", "eq", "11")), "unrelated");
  const phrase = (id: string, mode: string, text: string) => content(id, { kind: "text_contains", targets: ["content"], params: { phrase: text, mode } });
  assert.equal(relate(phrase("rul_P0000001", "must", "Prices exclude GST"), phrase("rul_P0000002", "must_not", "prices  EXCLUDE gst")), "conflict");
  assert.equal(relate(phrase("rul_P0000001", "must", "Prices exclude GST"), phrase("rul_P0000003", "must", "Prices exclude GST")), "duplicate");
  const window = (id: string, min?: number, max?: number) => content(id, { kind: "date_window", targets: ["quote.valid_until"], params: { ...(min !== undefined ? { min_days_ahead: min } : {}), ...(max !== undefined ? { max_days_ahead: max } : {}) } });
  assert.equal(relate(window("rul_W0000001", 30), window("rul_W0000002", undefined, 14)), "conflict");
  assert.equal(relate(window("rul_W0000001", 30), window("rul_W0000003", 30)), "duplicate");
  assert.equal(relate(window("rul_W0000001", 30), window("rul_W0000004", 10, 60)), "unrelated");
  const present = (id: string, t: string) => content(id, { kind: "field_present", targets: [t], params: {} });
  assert.equal(relate(present("rul_F0000001", "quote.reference"), present("rul_F0000002", "quote.reference")), "duplicate");
  assert.equal(relate(present("rul_F0000001", "quote.reference"), present("rul_F0000003", "customer.name")), "unrelated");
  assert.equal(relate(present("rul_F0000001", "quote.reference"), phrase("rul_P0000004", "must", "x")), "unrelated", "different kinds are never guessed at");

  // Both nevertheless active in one context: both `conflict`, Couldn't verify, neither wins (AT-G5 run-time half).
  const [a, b] = [phrase("rul_P0000001", "must", "Prices exclude GST"), phrase("rul_P0000002", "must_not", "Prices exclude GST")];
  const out = evaluate({ run_id: "run_KINDS003", artifact: artifactFrom(quote()), action: { type: "release" }, context, rules: [a, b].map((c) => ({ content: c, status: "active" as const, content_digest: digestOf(c) })), sources: [], exceptions: [], as_of: AS_OF });
  assert.deepEqual(out.results.map((r) => r.outcome), ["conflict", "conflict"]);
  assert.equal(out.verdict, "could_not_verify");
});
