import assert from "node:assert/strict";
import { test } from "node:test";
import { NotImplementedYet } from "../src/domain/errors.ts";
import { FORMAT_ADAPTERS } from "../src/formats/adapters.ts";
import { CATALOGUE } from "../src/policy/catalogue.ts";
import { seedDemo } from "../src/seed/demo.ts";
import { all, get } from "../src/store/db.ts";
import { makeApp, scenario } from "./helpers.ts";

test("DEMO seed: produced by the real pipeline, labelled DEMO everywhere, and only loaded into an empty workspace", () => {
  const app = makeApp();
  const seeded = seedDemo(app);
  assert.equal(seeded.seeded, true);
  const project = app.projects.get(seeded.project_id!);
  assert.match(project.name, /^\[DEMO\]/);
  assert.equal(project.is_demo, true);
  assert.equal(get<{ n: number }>(app.db, "SELECT COUNT(*) AS n FROM artifacts WHERE is_demo = 0")!.n, 0, "every seeded document is flagged as demo");
  assert.ok(app.rules.listAll().every((r) => /\[DEMO\]/.test(r.title)), "every seeded rule title says DEMO");
  assert.ok(app.intake.adapters().filter((a) => a.kind === "runtime_hook").every((a) => a.simulated), "the seeded capture adapter is marked simulated");
  // The learned rule came from the real decision procedure, under a policy a person set.
  const learned = app.rules.listAll().find((r) => r.authority?.kind === "delegated_learning")!;
  assert.equal(learned.status, "active");
  const outcomes = app.learning.decisions(project.project_id).map((d) => d.outcome).sort();
  assert.deepEqual(outcomes, ["auto_activate", "declined", "discarded", "inbox", "record_only", "waiting_for_evidence"]);
  assert.equal(app.ledger.verify().ok, true);
  assert.equal(get<{ n: number }>(app.db, "SELECT COUNT(*) AS n FROM executions")!.n, 0, "the seed sends, pays and releases nothing");
  assert.equal(seedDemo(app).seeded, false, "never mixed into existing data");
  // No invented success metrics: the seed stores no measurements, only records of what the framework did.
  const tables = all<{ name: string }>(app.db, "SELECT name FROM sqlite_master WHERE type = 'table'").map((t) => t.name);
  assert.ok(!tables.some((t) => /metric|score|effectiveness|kpi/.test(t)));
});

test("Phase 2 extension points are explicit: each throws a typed NotImplementedYet naming its contract - never a silent success", () => {
  const s = scenario("auto_low_risk");
  const points: Array<[string, () => unknown]> = [
    ["context.resolveByMarker", () => s.app.projects.resolveByMarker("/some/folder")],
    ["learning.autoPause", () => s.app.learning.autoPause("rul_X000001", "disputes")],
    ["learning.markAsCorrection", () => s.app.learning.markAsCorrection("cap_X000001", s.marcus)],
    ["learning.suppress", () => s.app.learning.suppress("dec_X000001", s.marcus)],
    ["learning.deleteSignalText", () => s.app.learning.deleteSignalText("sig_X000001", s.marcus)],
    ["formats.docx.parse", () => FORMAT_ADAPTERS.find((a) => a.capability.adapter_id === "docx-core")!.parse({ bytes: new Uint8Array(), name: "x.docx", work_type: "sales_proposal" })],
    ["formats.pdf.parse", () => FORMAT_ADAPTERS.find((a) => a.capability.adapter_id === "pdf-digital")!.parse({ bytes: new Uint8Array(), name: "x.pdf", work_type: "sales_proposal" })],
  ];
  for (const [contract, call] of points) {
    assert.throws(call, (e: unknown) => e instanceof NotImplementedYet && e.contract === contract && e.status === 501 && e.code === "unavailable", contract);
  }
  const unavailable = Object.values(CATALOGUE).filter((k) => k.availability === "unavailable").map((k) => k.kind).sort();
  assert.deepEqual(unavailable, ["arithmetic_consistency", "attestation", "date_window", "fields_agree", "model_review", "no_hidden_content", "no_unresolved_markup", "rows_unique", "value_is_formula"]);
  assert.ok(Object.values(CATALOGUE).filter((k) => k.availability === "unavailable").every((k) => k.evaluate === undefined));
});

// ---------------------------------------------------------------------------------------------
// Contracts NOT implemented in Phase 1. Each `todo` names the acceptance test and the function
// contract (see HANDOFF.md, "Next functions"). They are reported as todo - not as passing.
// ---------------------------------------------------------------------------------------------
const PHASE_2: Array<[string, string]> = [
  ["AT-G4", "rules.createCandidate shows a structural duplicate BEFORE a candidate can be created (analysis exists: RuleService.analyse; the UX-7b flow does not)"],
  ["AT-G5 (static half)", "conflict shown when the second rule is proposed, beyond field_in_set pairs (catalogue.relate for numeric bounds, date windows, present/absent, phrases)"],
  ["AT-G8", "engine/adapter upgrade is staged against stored rule examples; changed outcomes hold the upgrade and queue the rule"],
  ["AT-C3", "pending action request survives assistant and service restart with a fresh hello (store side is covered; the session side is not)"],
  ["AT-C4 / AT-C5 / AT-C7 / AT-C8", "context.resolveByMarker: renamed, moved and copied files and folders; foreign markers; the one-time question (ProjectService.resolveByMarker)"],
  ["AT-C6 (second half)", "\"check as which project?\" answered and remembered per lineage"],
  ["AT-C9 / AT-E1", "newer-version pause with the approver choosing a version; a real release-folder adapter that copies the checked bytes"],
  ["AT-F1 (container) / AT-F2 / AT-F3 / AT-F4 / AT-F5", "formats.docx.parse: container inspection, locators, mapping mismatch, embedded workbooks, tracked changes"],
  ["AT-F7", "ProjectService.importSnapshot from CSV/XLSX files, rejecting formula cells without cached results"],
  ["AT-L3 (backfill)", "adapter backfill from a runtime transcript, marked and capped at the inbox"],
  ["AT-L6", "naming unsupported assistants as NOT CAPTURED from a registry of known runtimes (labels exist; the registry does not)"],
  ["AT-L11", "recurrence: three independent episodes of the same hand edit produce a suggestion (needs edit diff compilation and folder watch)"],
  ["AT-L15", "learning.autoPause: contradiction, two disputes, example regression, conflict with an approved rule; Resume"],
  ["AT-L17 (deletion)", "learning.deleteSignalText: wording gone, ledger still verifies, rule shows \"original wording deleted\""],
  ["AT-L19", "learning.markAsCorrection: a missed correction recovered by its author within the review window"],
  ["AT-O5 (content)", "CheckService.compare content_diff: changed cells and passages before and after"],
  ["AT-O7", "re-run as recorded: replay a stored run from its inputs and report mismatches or purged inputs"],
  ["AT-E7", "exceptions: request, grant by the rule's owner, expiry event (engine already reports `waived`)"],
  ["AT-E10 / AT-E11 / AT-E12", "offline matrix, clock-jump hold on receipts, backup and restore"],
  ["AT-I5 / AT-I6", "two workspaces on one machine; translator outbound-request canary (no AI translator exists in Phase 1)"],
  ["AT-U1 to AT-U6, AT-R3", "usability tests with people; not automatable here"],
];
for (const [id, contract] of PHASE_2) test.todo(`${id}: ${contract}`);
