import assert from "node:assert/strict";
import { test } from "node:test";
import { digestOf } from "../src/domain/canonical.ts";
import type { NormalizedArtifact, ResolvedContext, RuleRevisionContent, RuleStatus, SourceSnapshot } from "../src/domain/types.ts";
import type { EngineInput, EngineRule } from "../src/engine/evaluate.ts";
import { evaluate } from "../src/engine/evaluate.ts";
import { decimalCompare } from "../src/engine/fields.ts";
import { readArtifact } from "../src/formats/adapters.ts";
import { CATALOGUE } from "../src/policy/catalogue.ts";
import { enc, fixture, makeApp, quote, ruleContent } from "./helpers.ts";

const app = makeApp();
const context: ResolvedContext = { workspace_id: app.workspaceId, project_id: "prj_ENGINE01", area_ids: [], work_type: "sales_proposal", status: "resolved", basis: ["binding"], facts: { customer_id: "cust_kestrel" } };
const AS_OF = "2026-11-12T02:02:40Z";

function artifactFrom(bytes: Uint8Array, name = "q.md"): NormalizedArtifact {
  const read = readArtifact(bytes, name, "sales_proposal");
  assert.ok(read.parsed, read.error?.message);
  return { schema_version: "cl.artifact/1", artifact_id: "art_ENGINE01", name, version: { seq: 1, content_hash: digestOf([...bytes]), observed_at: AS_OF }, identity: read.identity, ...read.parsed };
}
const rule = (over: Partial<RuleRevisionContent> & { rule_id: string }, status: RuleStatus = "active"): EngineRule => {
  const content = ruleContent(app, over);
  return { content, status, content_digest: digestOf(content) };
};
const run = (artifact: NormalizedArtifact, rules: EngineRule[], extra: Partial<EngineInput> = {}) =>
  evaluate({ run_id: "run_ENGINE01", artifact, action: { type: "release" }, context, rules, sources: [], exceptions: [], as_of: AS_OF, ...extra });
const present = (id: string, target: string) => rule({ rule_id: id, check: { kind: "field_present", targets: [target], params: {} }, requires: { fields: [], components: [] } });

test("the engine is a pure function: same inputs, identical output; inputs are not modified", () => {
  const artifact = artifactFrom(quote({ currency: "USD" }));
  const rules = [rule({ rule_id: "rul_SGD00001" })];
  const frozen = structuredClone({ artifact, rules });
  const a = run(artifact, rules);
  const b = run(artifact, rules);
  assert.deepEqual(a, b);
  assert.deepEqual({ artifact, rules }, frozen);
  assert.equal(a.verdict, "needs_changes");
  assert.equal(a.results[0]!.findings.length, 3, "two lines and the total");
  assert.deepEqual(a.results[0]!.findings.map((f) => f.field_path), ["quote.line_items[0].currency", "quote.line_items[1].currency", "quote.total.currency"]);
  assert.match(a.results[0]!.findings[0]!.location.locator, /^text:\/table\[1\]\/row\[2\]$/, "findings carry a locator");
  assert.notEqual(run(artifact, rules, { as_of: "2026-11-13T00:00:00Z" }).inputs_digest, a.inputs_digest, "the clock is an explicit input");
});

test("verdict table: fail blocks, unknown never silently passes, notes do not hold anything up", () => {
  const sgd = artifactFrom(quote({ currency: "SGD" }));
  const usd = artifactFrom(quote({ currency: "USD" }));
  assert.equal(run(sgd, [rule({ rule_id: "rul_SGD00001" })]).verdict, "ready");
  assert.equal(run(usd, [rule({ rule_id: "rul_SGD00001" })]).verdict, "needs_changes");
  // An unknown on a must-pass rule is Couldn't verify - not Ready.
  const missing = run(sgd, [rule({ rule_id: "rul_NEEDS001", requires: { fields: ["quote.discount"], components: [] } })]);
  assert.equal(missing.results[0]!.outcome, "unknown");
  assert.equal(missing.verdict, "could_not_verify");
  // Needs changes outranks Couldn't verify.
  assert.equal(run(usd, [rule({ rule_id: "rul_SGD00001" }), rule({ rule_id: "rul_NEEDS001", requires: { fields: ["quote.discount"], components: [] } })]).verdict, "needs_changes");
  // A warn rule that fails or is unknown is a note; the verdict stays Ready, and the note is counted (not hidden).
  const noted = run(usd, [rule({ rule_id: "rul_SGD00001", enforcement: "warn" })]);
  assert.equal(noted.verdict, "ready");
  assert.equal(noted.counts.notes, 1);
  assert.equal(noted.results[0]!.outcome, "fail");
  const total = (c: typeof noted.counts) => c.pass + c.fail + c.unknown + c.not_applicable + c.error + c.conflict + c.waived + c.skipped + c.notes;
  for (const out of [noted, missing]) assert.equal(total(out.counts), out.counts.in_scope, "every in-scope rule is counted exactly once");
  assert.equal(run(sgd, []).verdict, "ready");
});

test("AT-E8: a rule on trial never blocks, and says so", () => {
  const out = run(artifactFrom(quote({ currency: "USD" })), [rule({ rule_id: "rul_SGD00001" }, "trial")]);
  assert.equal(out.results[0]!.outcome, "fail");
  assert.equal(out.results[0]!.effective_enforcement, "warn");
  assert.equal(out.verdict, "ready");
  assert.match(out.results[0]!.reason, /on trial/);
});

test("AT-G2: a rule that throws is `error`; every other rule still gets a result; the verdict is not Ready", () => {
  const catalogue = { ...CATALOGUE, field_present: { ...CATALOGUE.field_present, evaluate: () => { throw new Error("time budget exceeded"); } } };
  const out = run(artifactFrom(quote({ currency: "SGD" })), [present("rul_BOOM0001", "quote.reference"), rule({ rule_id: "rul_SGD00001" })], { catalogue });
  assert.deepEqual(out.results.map((r) => r.outcome), ["error", "pass"]);
  assert.equal(out.verdict, "could_not_verify");
  assert.equal(out.counts.error, 1);
});

test("check kinds this build cannot evaluate are `unknown` (fail closed), never `pass`; an AI opinion is `skipped` and only a note", () => {
  const artifact = artifactFrom(quote({ currency: "SGD" }));
  for (const spec of Object.values(CATALOGUE).filter((k) => k.availability === "unavailable" && k.kind !== "model_review")) {
    const out = run(artifact, [rule({ rule_id: "rul_UNAVAIL1", method: spec.method, check: { kind: spec.kind, targets: ["quote.total"], params: {} }, requires: { fields: [], components: [] } })]);
    assert.equal(out.results[0]!.outcome, "unknown", spec.kind);
    assert.equal(out.verdict, "could_not_verify", spec.kind);
    assert.match(out.results[0]!.reason, /not available in this build/);
  }
  const opinion = run(artifact, [rule({ rule_id: "rul_OPINION1", method: "model_review", enforcement: "warn", check: { kind: "model_review", targets: ["content"], params: { criterion: "x" } }, requires: { fields: [], components: [] } })]);
  assert.equal(opinion.results[0]!.outcome, "skipped");
  assert.equal(opinion.results[0]!.effective_enforcement, "warn");
  assert.equal(opinion.verdict, "ready");
});

test("AT-F6: a bare \"$\" is not a currency - the currency rule is unknown with advice, not pass and not fail", () => {
  const artifact = artifactFrom(quote({ money: (amount) => `$${amount}` }));
  const out = run(artifact, [rule({ rule_id: "rul_SGD00001" })]);
  assert.equal(out.results[0]!.outcome, "unknown");
  assert.match(out.results[0]!.reason, /currency code such as SGD/);
  assert.equal(out.verdict, "could_not_verify");
});

test("AT-F9: a value suggested by an AI model, or read with low confidence, cannot satisfy a must-pass rule", () => {
  const artifact = artifactFrom(quote({ currency: "SGD" }));
  for (const tweak of [{ method: "model_suggested" as const, confidence: 1 }, { method: "mapping" as const, confidence: 0.6 }]) {
    const doubted = structuredClone(artifact);
    Object.assign(doubted.fields.find((f) => f.path === "quote.total")!, tweak);
    const out = run(doubted, [rule({ rule_id: "rul_SGD00001" })]);
    assert.equal(out.results[0]!.outcome, "unknown", JSON.stringify(tweak));
    assert.equal(out.verdict, "could_not_verify");
  }
});

test("content conditions: false is not_applicable with the deciding value; undecidable is unknown", () => {
  const artifact = artifactFrom(quote({ currency: "SGD" }));
  const big = (value: string, field = "quote.total") => rule({ rule_id: "rul_BIGDEAL1", applies_when: { field, op: "ge", value }, check: { kind: "section_present", targets: ["content"], params: { heading: "Credit terms" } }, requires: { fields: [], components: [] } });
  const small = run(artifact, [big("100000")]);
  assert.equal(small.results[0]!.outcome, "not_applicable");
  assert.match(small.results[0]!.reason, /quote\.total is 17760\.00/);
  assert.equal(small.verdict, "ready");
  const applies = run(artifact, [big("1000")]);
  assert.equal(applies.results[0]!.outcome, "fail", "the section is missing");
  const unreadable = run(artifact, [big("1000", "quote.discount")]);
  assert.equal(unreadable.results[0]!.outcome, "unknown", "an unreadable field does not let a conditional rule escape");
  assert.equal(decimalCompare("100000", "17760.00"), 1);
  assert.equal(decimalCompare("0.10", "0.1"), 0, "exact decimals, never binary floats");
});

test("implemented kinds: field_present, number_compare, text_contains, section_present", () => {
  const artifact = artifactFrom(quote({ currency: "SGD", extra: "\n## Credit terms\n\nNet 30. We guarantee delivery.\n" }));
  const outcome = (r: EngineRule) => run(artifact, [r]).results[0]!.outcome;
  assert.equal(outcome(present("rul_REF00001", "quote.reference")), "pass");
  assert.equal(outcome(present("rul_REF00002", "quote.purchase_order")), "fail");
  const cmp = (op: string, value: string) => rule({ rule_id: "rul_NUM00001", check: { kind: "number_compare", targets: ["quote.line_items[*].quantity"], params: { op, value } }, requires: { fields: [], components: [] } });
  assert.equal(outcome(cmp("le", "12")), "pass");
  assert.equal(outcome(cmp("lt", "12")), "fail");
  const text = (phrase: string, mode: string) => rule({ rule_id: "rul_TXT00001", check: { kind: "text_contains", targets: ["content"], params: { phrase, mode } }, requires: { fields: [], components: [] } });
  assert.equal(outcome(text("guarantee", "must_not")), "fail");
  assert.equal(outcome(text("net 30", "must")), "pass");
  assert.equal(outcome(rule({ rule_id: "rul_SEC00001", check: { kind: "section_present", targets: ["content"], params: { heading: "credit terms" } }, requires: { fields: [], components: [] } })), "pass");
});

test("two rules that cannot both be met are both `conflict`; neither wins (AT-G5, run-time half)", () => {
  const usdRule = rule({ rule_id: "rul_USD00001", check: { kind: "field_in_set", targets: ["quote.line_items[*].currency", "quote.total.currency"], params: { allowed: ["USD"] } } });
  const out = run(artifactFrom(quote({ currency: "SGD" })), [rule({ rule_id: "rul_SGD00001" }), usdRule]);
  assert.deepEqual(out.results.map((r) => r.outcome), ["conflict", "conflict"]);
  assert.equal(out.verdict, "could_not_verify");
});

test("an exception shows as `waived` with the underlying result kept (engine side of AT-E7)", () => {
  const out = run(artifactFrom(quote({ currency: "USD" })), [rule({ rule_id: "rul_SGD00001" })], { exceptions: [{ exception_id: "exc_TEST0001", rule_id: "rul_SGD00001" }] });
  assert.equal(out.results[0]!.outcome, "waived");
  assert.match(out.results[0]!.reason, /underlying result: fail/);
  assert.equal(out.verdict, "ready");
});

test("unread, content-bearing parts are coverage gaps: never Ready for a real action", () => {
  const artifact = artifactFrom(enc("# Quote\n\nCustomer: Kestrel\n\n![scan of the price table](prices.png)\n"));
  assert.deepEqual(run(artifact, []).coverage_gaps.map((g) => g.component), ["text_in_images"]);
  assert.equal(run(artifact, []).verdict, "could_not_verify");
  assert.equal(run(artifact, [], { action: { type: "check_only" } }).verdict, "ready");
});

test("source-backed rules: fresh snapshot compares; stale or missing source is unknown (AT-E4); the design's worked example is reproduced", () => {
  const artifact = fixture("examples/sales-proposal/artifact-v1.json") as NormalizedArtifact;
  const clean = (r: any): EngineRule => {
    const { $schema: _s, _note: _n, status, authority: _a, approval: _p, ...content } = r;
    return { content: { ...content, scope: { ...content.scope, workspace_id: app.workspaceId } }, status, content_digest: digestOf(content) };
  };
  const price = clean(fixture("examples/sales-proposal/rule-current-price.json"));
  const currency = clean(fixture("examples/sales-proposal/rule-customer-currency.json"));
  const example = fixture("examples/sales-proposal/source-snapshot.json");
  const snapshot: SourceSnapshot = { source_id: "src_PRICELST", snapshot_id: "snap_PL2026Q4A", imported_at: example.snapshot.imported_at, confirmed_at: example.snapshot.confirmed_at, superseded: false, rows: example.rows_excerpt };
  const out = run(artifact, [price, currency], { sources: [snapshot] });
  const expected = fixture("examples/sales-proposal/run-1-needs-changes.json");
  const mine = Object.fromEntries(out.results.map((r) => [r.rule_id, r]));
  for (const id of ["rul_PRICECUR", "rul_SGDMERID"]) {
    const theirs = expected.results.find((r: any) => r.rule_id === id);
    assert.equal(mine[id]!.outcome, theirs.outcome, id);
    assert.equal(mine[id]!.compared, theirs.compared, id);
    assert.deepEqual(mine[id]!.findings.map((f) => [f.field_path, f.location, f.found, f.expected]), theirs.findings.map((f: any) => [f.field_path, f.location, f.found, f.expected]), `${id} findings match the worked example`);
  }
  assert.deepEqual(mine.rul_PRICECUR!.findings[0]!.evidence, { source_id: "src_PRICELST", snapshot_id: "snap_PL2026Q4A", source_row: 14, source_key: { item_code: "HX-200", currency: "USD" } });
  assert.equal(out.verdict, "needs_changes");
  assert.deepEqual(out.sources.map((s) => [s.snapshot_id, s.age_days, s.fresh, s.fresh_until]), [["snap_PL2026Q4A", 9, true, "2026-12-18T01:12:05Z"]], "source use is recorded as in the example");

  // Stale is unknown.
  const stale = run(artifact, [price], { sources: [snapshot], as_of: "2027-02-01T00:00:00Z" });
  assert.equal(stale.results[0]!.outcome, "unknown");
  assert.match(stale.results[0]!.reason, /out of date/);
  assert.equal(stale.verdict, "could_not_verify");
  // Missing source: unknown. A superseded snapshot under require_latest: unknown.
  assert.equal(run(artifact, [price]).results[0]!.outcome, "unknown");
  assert.equal(run(artifact, [price], { sources: [{ ...snapshot, superseded: true }] }).results[0]!.outcome, "unknown");
  // An item that is not in the list is unknown by default, never read as a match.
  const unlisted = structuredClone(artifact);
  unlisted.fields.find((f) => f.path === "quote.line_items[1].item_code")!.value = { type: "text", text: "ZZ-999" };
  assert.equal(run(unlisted, [price], { sources: [{ ...snapshot, rows: snapshot.rows }] }).results[0]!.outcome, "fail", "line 1 still fails");
  const onlyUnlisted = structuredClone(unlisted);
  onlyUnlisted.fields.find((f) => f.path === "quote.line_items[0].unit_price")!.value = { type: "money", amount: "1240.00", currency: "USD" };
  assert.equal(run(onlyUnlisted, [price], { sources: [snapshot] }).results[0]!.outcome, "unknown");
});

test("format identification: an extension is a claim; unsupported files are never read as empty (AT-F8, AT-F1 first half)", () => {
  const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
  const docx = readArtifact(zip, "Proposal.docx", "sales_proposal");
  assert.equal(docx.parsed, null);
  assert.equal(docx.error?.code, "unavailable");
  const pdf = readArtifact(enc("%PDF-1.7 ..."), "Scan.pdf", "sales_proposal");
  assert.equal(pdf.parsed, null);
  const renamed = readArtifact(quote(), "Quote.docx", "sales_proposal");
  assert.equal(renamed.identity.detected_type, "text");
  assert.equal(renamed.identity.extension_matches, false);
  assert.ok(renamed.parsed!.risk_flags!.some((f) => f.flag === "extension_mismatch"));
  assert.equal(readArtifact(new Uint8Array([0xff, 0xfe, 0x00, 0x81]), "x.bin", "sales_proposal").error?.code, "unsupported_type");
  // Deterministic: the same bytes give the same normalized artifact.
  assert.deepEqual(readArtifact(quote(), "q.md", "sales_proposal"), readArtifact(quote(), "q.md", "sales_proposal"));
});
