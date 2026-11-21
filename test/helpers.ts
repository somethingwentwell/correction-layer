/**
 * Test harness. Every app here is an in-memory workspace with a fixed clock, so
 * runs are hermetic and deterministic. All names and amounts are FICTIONAL test
 * data (adapted from the design's illustrative examples); nothing here is a
 * measurement or a claim about real work.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { App, AppOptions } from "../src/app.ts";
import { createApp } from "../src/app.ts";
import { LocalOutboxAdapter } from "../src/capture/local-adapter.ts";
import type { Project } from "../src/context/projects.ts";
import { FixedClock } from "../src/domain/time.ts";
import type { Actor, LearningMode, RuleRevisionContent } from "../src/domain/types.ts";
import { repoRoot } from "../src/paths.ts";

export const T0 = "2026-11-17T06:00:00Z";
export const enc = (text: string): Uint8Array => new TextEncoder().encode(text);

export interface TestApp extends App {
  clock: FixedClock;
}

export function makeApp(opts: Partial<AppOptions> = {}): TestApp {
  const clock = new FixedClock(T0);
  return createApp({ dbPath: ":memory:", clock, displayTz: "Asia/Singapore", workspaceId: "ws_TEST0001", localUserId: "usr_MARCUS01", localUserName: "Marcus Lim (test)", ...opts }) as TestApp;
}

export function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "correction-layer-test-"));
}

export function fixture(path: string): any {
  return JSON.parse(readFileSync(join(repoRoot(), path), "utf8"));
}

/** A fictional sales quote in the Markdown layout the `text-labelled` adapter reads. */
export function quote(opts: { currency?: string; customer?: string; total?: string; extra?: string; money?: (amount: string) => string } = {}): Uint8Array {
  const cur = opts.currency ?? "USD";
  const money = opts.money ?? ((amount: string) => `${cur} ${amount}`);
  return enc(`# Supply quote for ${opts.customer ?? "Kestrel Dental Group"}

Customer: ${opts.customer ?? "Kestrel Dental Group"}
Quote reference: KQ-2026-014
Valid until: 12 January 2027
${opts.extra ?? ""}
| Item | Qty | Unit price | Amount |
|------|-----|------------|--------|
| HX-200 Flow Sensor | 12 | ${money("1,180.00")} | ${money("14,160.00")} |
| CAL-1Y Calibration Plan | 12 | ${money("300.00")} | ${money("3,600.00")} |
| Total | | | ${money(opts.total ?? "17,760.00")} |
`);
}

export interface Scenario {
  app: TestApp;
  marcus: Actor;
  priya: Actor;
  project: Project;
  bindingId: string;
  adapter: LocalOutboxAdapter;
}

/**
 * One project with a folder, two people, and (unless mode is null) a learning
 * policy set by Marcus that lists both. Priya's assistant has a paired, SIMULATED
 * runtime-hook adapter with an in-memory outbox.
 */
export function scenario(mode: LearningMode | null = "auto_low_risk", opts: { app?: TestApp; name?: string; folder?: string; outboxPath?: string | null; streamId?: string } = {}): Scenario {
  const app = opts.app ?? makeApp();
  const marcus = app.localUser;
  const priya = app.projects.ensurePerson("usr_PRIYA001", "Priya Nair (test)");
  const project = app.projects.createProject({ name: opts.name ?? "Kestrel Dental Group - 2026 supply (TEST)", default_work_type: "sales_proposal", facts: { customer_id: "cust_kestrel" } }, marcus);
  const bindingId = app.projects.registerFolder(project.project_id, opts.folder ?? `/test/${project.project_id}`, marcus);
  if (mode) app.policies.set({ project_id: project.project_id, mode, learn_from: [priya.id, marcus.id] }, marcus);
  // Priya pairs the adapter for her own assistant, so its attested user turns are hers.
  if (!app.intake.adapters().some((a) => a.adapter_id === "adp_TURNHOOK")) {
    app.intake.pairAdapter({ adapter_id: "adp_TURNHOOK", kind: "runtime_hook", label: "Priya's assistant (SIMULATED test adapter)", simulated: true, attests_user_turns: true, durable_outbox: true, supports_replay: true, supports_backfill: false }, priya);
  }
  const adapter = new LocalOutboxAdapter({ adapter_id: "adp_TURNHOOK", stream_id: opts.streamId ?? `str_${project.project_id.slice(4, 20)}`, outbox_path: opts.outboxPath ?? null, binding_id: bindingId });
  return { app, marcus, priya, project: app.projects.get(project.project_id), bindingId, adapter };
}

/** Emit the classic exchange: assistant drafts a quote, the person corrects it. Returns the anchor. */
export function draftAndCorrect(s: Scenario, text: string, draft: Uint8Array = quote({ currency: "USD" }), name = "Kestrel-Supply-Quote.md"): { artifact_id: string; content_hash: string } {
  const v = s.app.checks.observe({ project_id: s.project.project_id, name, bytes: draft });
  const at = s.app.clock.now().toISOString().replace(/\.\d{3}Z$/, "Z");
  s.adapter.emit({ kind: "session_start", role: "system", attested_by: "runtime_hook", occurred_at: at });
  s.adapter.emit({ kind: "agent_output", role: "agent", attested_by: "runtime_hook", occurred_at: at, text: "draft", binding: { artifact_id: v.artifact_id, content_hash: v.content_hash } });
  s.adapter.emit({ kind: "user_turn", role: "user", attested_by: "runtime_hook", occurred_at: at, text });
  return { artifact_id: v.artifact_id, content_hash: v.content_hash };
}

/** A minimal person-authored rule for engine and scope tests. */
export function ruleContent(app: App, over: Partial<RuleRevisionContent> & { rule_id: string }): RuleRevisionContent {
  return {
    schema_version: "cl.rule/1", revision: 1, supersedes: null, title: `Rule ${over.rule_id}`, statement: "Every line in the pricing table, and the total, must be in SGD.",
    origin: { kind: "starter_pack", pack: "test" }, owner: app.localUser.id, review_by: "2027-05-10",
    scope: { level: "workspace", workspace_id: app.workspaceId, project_selector: null, project_id: null, area_id: null, artifact_id: null, work_types: ["sales_proposal"], artifact_types: ["document"], actions: [] },
    applies_when: null, method: "deterministic", enforcement: "block", locked: false,
    check: { kind: "field_in_set", targets: ["quote.line_items[*].currency", "quote.total.currency"], params: { allowed: ["SGD"] } },
    requires: { fields: ["quote.line_items[*].currency", "quote.total"], components: ["body.tables"] }, source: null,
    message: { problem: "Currency is not SGD", fix_hint: "Quote in SGD." },
    cases: [
      { case_id: `case_${over.rule_id.slice(4)}N`, kind: "negative", description: "test negative", artifact_hash: "sha256:" + "0".repeat(64), expect: "fail" },
      { case_id: `case_${over.rule_id.slice(4)}P`, kind: "positive", description: "test positive", artifact_hash: "sha256:" + "1".repeat(64), expect: "pass" },
    ],
    ...over,
  };
}

/** Create and individually approve a rule as the local person. */
export function activeRule(app: App, over: Partial<RuleRevisionContent> & { rule_id: string }, trial = false): void {
  app.rules.createCandidate(ruleContent(app, over), app.localUser);
  app.rules.approveAndActivate(over.rule_id, app.localUser, { trial });
}
