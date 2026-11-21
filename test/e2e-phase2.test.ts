/**
 * End to end, over loopback HTTP (client API + app surface), hermetic:
 *
 *   a correction is captured by a paired command-line adapter
 *   -> learned and turned on under the person's learning policy (no click)
 *   -> an old quote, checked for the first time, fails and is blocked
 *   -> an assistant PROPOSES a change (not a version; nothing changes)
 *   -> a person APPLIES it (a new version declared by that person) and it is rechecked: Ready
 *   -> requested, approved, released to a local folder: exactly the checked bytes
 *   -> the journey is reconstructed from stored references and caused_by links only.
 *
 * Plus: each Phase 2 policy change invalidates an outstanding receipt.
 * All names and amounts are FICTIONAL test data.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { startServer } from "../src/api/server.ts";
import { HttpCaptureTransport, LocalOutboxAdapter } from "../src/capture/local-adapter.ts";
import { sha256 } from "../src/domain/canonical.ts";
import type { LedgerEvent } from "../src/ledger/ledger.ts";
import { all, get } from "../src/store/db.ts";
import { correctionJourney } from "../src/work/journey.ts";
import { activeRule, makeApp, quote, scenario, T0, tmpDir } from "./helpers.ts";

const text = (b: Uint8Array): string => new TextDecoder().decode(b);

test("E2E: captured correction -> learned under policy -> old work blocked -> proposed vs applied change -> recheck Ready -> released -> journey reconstructed", async () => {
  const app = makeApp();
  const server = await startServer(app, { host: "127.0.0.1", port: 0 });
  const api = async (path: string, body?: unknown): Promise<any> => {
    const res = await fetch(server.url + path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const json = await res.json();
    assert.ok(res.ok, `${path}: ${JSON.stringify(json)}`);
    return json;
  };
  const form = async (path: string, fields: Record<string, string | string[]>, token: string | null = server.csrf): Promise<{ status: number; location: string }> => {
    const params = new URLSearchParams(token ? { _csrf: token } : {});
    for (const [k, v] of Object.entries(fields)) for (const x of ([] as string[]).concat(v)) params.append(k, x);
    const res = await fetch(server.url + path, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: params });
    await res.text();
    return { status: res.status, location: res.headers.get("location") ?? "" };
  };
  try {
    const me = app.localUser;
    const folder = join(tmpDir(), "Proposals", "Kestrel");
    const releaseDir = tmpDir();

    // A person sets up the project, learning ("Learn and enforce", listing themself), a release folder, and pairs an adapter.
    const created = await form("/app/projects", { name: "Kestrel Dental Group - 2026 supply (TEST)", folder, customer_name: "Kestrel Dental Group" });
    assert.equal(created.status, 303);
    const projectId = /\/projects\/(prj_[0-9A-Z]+)/.exec(created.location)![1]!;
    assert.equal((await form(`/app/projects/${projectId}/learning`, { mode: "auto_low_risk", learn_from: me.id })).status, 303);
    assert.equal((await form(`/app/projects/${projectId}/release-folder`, { folder: releaseDir, approval: "self" })).status, 303);
    assert.equal((await form("/app/capture/adapters", { label: "E2E outbox", back: `/projects/${projectId}/capture` })).status, 303);
    const adapterId = app.intake.adapters().find((a) => a.label.startsWith("E2E outbox"))!.adapter_id;
    const bindingId = app.projects.get(projectId).folders[0]!.binding_id;

    // The assistant drafts a quote in USD and checks it (advisory; no rules yet).
    const draft = await api("/api/v1/check", { artifact: { kind: "path", value: join(folder, "Kestrel-Quote.md"), content_text: text(quote({ currency: "USD" })) }, action: { type: "check_only" } });
    assert.equal(draft.verdict, "ready");
    const draftRun = app.checks.getRun(draft.run_id);

    // The person corrects the assistant; the adapter captures it durably over loopback HTTP.
    const adapter = new LocalOutboxAdapter({ adapter_id: adapterId, stream_id: "str_E2EFLOW01", outbox_path: join(tmpDir(), "outbox.jsonl"), binding_id: bindingId });
    adapter.emit({ kind: "agent_output", role: "agent", attested_by: "runtime_hook", occurred_at: T0, text: "Here is the draft.", binding: { artifact_id: draftRun.artifact.artifact_id, content_hash: draftRun.artifact.content_hash } });
    adapter.emit({ kind: "user_turn", role: "user", attested_by: "runtime_hook", occurred_at: T0, text: "No, Kestrel's quotes must always be in SGD." });
    const flushed = await adapter.flushAsync(new HttpCaptureTransport(server.url));
    assert.deepEqual(flushed.results.map((r) => r.result), ["accepted", "accepted"]);
    assert.equal(app.learning.decisions(projectId)[0]!.outcome, "waiting_for_evidence", "no real corrected version yet: nothing turns on");

    // The assistant produces the corrected version and declares it.
    const corrected = await api("/api/v1/report_change", { project_id: projectId, artifact: { name: "Kestrel-Quote.md", content_text: text(quote({ currency: "SGD" })) }, on_behalf_of: me.id });
    assert.equal(corrected.attribution, "declared_by_assistant");
    const rule = app.rules.listForProject(projectId).find((r) => r.authority?.kind === "delegated_learning")!;
    assert.equal(rule.status, "active");
    assert.equal(rule.authority?.zero_click, true);
    assert.equal(rule.authority?.delegated_by, me.id);
    assert.equal(app.learning.decisions(projectId)[0]!.outcome, "auto_activate");

    // An old quote, written earlier and never checked, is checked for release: it fails the learned rule and is blocked.
    const old = await form(`/app/projects/${projectId}/check`, { name: "Kestrel-Renewal-2025.md", content: text(quote({ currency: "USD", total: "17,760.00" })), action: "release" });
    const blockedRunId = /\/runs\/(run_[0-9A-Z]+)/.exec(old.location)![1]!;
    const blockedRun = app.checks.getRun(blockedRunId);
    assert.equal(blockedRun.verdict, "needs_changes");
    assert.deepEqual(blockedRun.results.filter((r) => r.outcome === "fail").map((r) => r.rule_id), [rule.rule_id]);
    assert.equal(blockedRun.receipt_id, null);

    // The assistant proposes a corrected version. It is a proposal: no version, the check still fails.
    const proposal = await api("/api/v1/propose_change", { project_id: projectId, artifact: { name: "Kestrel-Renewal-2025.md", content_text: text(quote({ currency: "SGD" })) }, summary: "re-priced in SGD from the current list", base_hash: blockedRun.artifact.content_hash });
    assert.equal(app.checks.versions(blockedRun.artifact.artifact_id).length, 1);
    const again = await api("/api/v1/check", { project_id: projectId, artifact: { name: "Kestrel-Renewal-2025.md", content_text: text(quote({ currency: "USD", total: "17,760.00" })) }, action: { type: "release" } });
    assert.equal(again.verdict, "needs_changes", "proposing changed nothing");
    // A client cannot apply it (no form token); a person can.
    assert.equal((await form(`/app/fixes/${proposal.fix_id}/apply`, { action: "release" }, null)).status, 403);
    assert.equal(app.fixes.get(proposal.fix_id).status, "open");
    const applied = await form(`/app/fixes/${proposal.fix_id}/apply`, { action: "release" });
    const recheckRunId = /\/runs\/(run_[0-9A-Z]+)/.exec(applied.location)![1]!;
    const recheck = app.checks.getRun(recheckRunId);
    assert.equal(recheck.artifact.version_seq, 2);
    assert.equal(recheck.verdict, "ready");
    assert.equal(recheck.trigger.kind, "auto_recheck");
    assert.ok(recheck.receipt_id);

    // Release: request, approve, execute - three acts, by the person, through the gateway.
    const requested = await form(`/app/receipts/${recheck.receipt_id}/request`, { type: "release" });
    const actionId = /\/actions\/(act_[0-9A-Z]+)/.exec(requested.location)![1]!;
    assert.equal(app.gateway.getAction(actionId).status, "awaiting_approval", "a pass is not permission");
    await form(`/app/actions/${actionId}/approve`, {});
    await form(`/app/actions/${actionId}/execute`, {});
    const action = app.gateway.getAction(actionId);
    assert.equal(action.status, "executed");
    assert.deepEqual(readdirSync(releaseDir), ["Kestrel-Renewal-2025.v2.md"]);
    assert.equal(sha256(readFileSync(join(releaseDir, "Kestrel-Renewal-2025.v2.md"))), recheck.artifact.content_hash);

    // ------------------------------------------------------------- the journey, from stored references only
    const j = correctionJourney(app.db, app.ledger, rule.origin.correction_id!);
    const byId = new Map(j.events.map((e) => [e.event_id, e]));
    const one = (type: string, pred: (e: LedgerEvent) => boolean = () => true): LedgerEvent => {
      const found = j.events.filter((e) => e.type === type && pred(e));
      assert.equal(found.length, 1, `${type}: ${found.length}`);
      return found[0]!;
    };
    const causeOf = (e: LedgerEvent): LedgerEvent => {
      assert.equal(e.caused_by.length >= 1, true, `${e.type} has a cause`);
      const c = byId.get(e.caused_by[0]!) ?? app.ledger.get(e.caused_by[0]!);
      assert.ok(c.seq < e.seq, "causes come first");
      return c;
    };
    const activated = one("rule.activated", (e) => e.refs.rule_id === rule.rule_id);
    assert.equal(activated.actor.on_behalf_of, me.id);
    const decided = causeOf(activated);
    assert.equal(decided.type, "learning.decision_made");
    const evaluated = causeOf(decided);
    assert.equal(evaluated.type, "learning.candidate_evaluated");
    let hop = evaluated;
    const chain: string[] = [];
    while (hop.caused_by.length) {
      hop = causeOf(hop);
      chain.push(hop.type);
    }
    // The candidate leads back, by caused_by alone, to the captured signal (which itself may cite its capture).
    const fromSignal = chain.slice(0, chain.indexOf("learning.signal_detected") + 1);
    assert.deepEqual(fromSignal.filter((t) => ["rule.candidate_created", "learning.correction_extracted", "learning.signal_detected"].includes(t)), ["rule.candidate_created", "learning.correction_extracted", "learning.signal_detected"]);
    const detected = one("learning.signal_detected");
    const policySet = one("learning.policy_set", (e) => e.refs.learning_policy_id === detected.refs.learning_policy_id);
    assert.equal(policySet.actor.kind, "human");
    assert.ok(policySet.seq < activated.seq, "the person's standing permission came first");
    assert.equal(detected.refs.capture_id !== undefined, true);
    const blockedEvent = one("run.completed", (e) => e.refs.run_id === blockedRunId);
    const blockedAction = j.events.find((e) => e.type === "action.blocked" && e.refs.run_id === blockedRunId)!;
    assert.equal(causeOf(blockedAction).event_id, blockedEvent.event_id);
    const proposed = one("fix.proposed");
    assert.equal(proposed.actor.kind, "agent", "proposed by the assistant");
    assert.equal(proposed.refs.content_hash, blockedRun.artifact.content_hash, "against exactly the blocked version");
    const change = one("change.recorded", (e) => e.refs.fix_id === proposal.fix_id);
    assert.equal(change.actor.kind, "human", "applied by a person");
    assert.equal(change.actor.id, me.id);
    assert.deepEqual([change.payload!.before_hash, change.payload!.after_hash], [blockedRun.artifact.content_hash, recheck.artifact.content_hash]);
    assert.ok(proposed.seq < change.seq);
    const recheckEvent = one("run.completed", (e) => e.refs.run_id === recheckRunId);
    assert.equal(recheckEvent.refs.content_hash, change.payload!.after_hash);
    const receipt = one("receipt.issued", (e) => e.refs.receipt_id === recheck.receipt_id);
    assert.equal(causeOf(receipt).event_id, recheckEvent.event_id);
    const approvedEvt = one("action.approved", (e) => e.refs.action_id === actionId);
    assert.equal(approvedEvt.actor.kind, "human");
    const executed = one("action.executed", (e) => e.refs.action_id === actionId);
    assert.equal(executed.actor.kind, "adapter");
    assert.equal(executed.refs.content_hash, recheck.artifact.content_hash);
    assert.equal(causeOf(executed).type, "action.revalidated");
    one("receipt.consumed", (e) => e.refs.receipt_id === recheck.receipt_id);
    // The journey screen renders the same hops.
    const html = await (await fetch(`${server.url}/corrections/${rule.origin.correction_id}`)).text();
    assert.match(html, /PERMITTED[\s\S]*IDENTIFIED[\s\S]*COMPILED[\s\S]*TESTED[\s\S]*DECIDED[\s\S]*ON[\s\S]*CHECKED[\s\S]*BLOCKED[\s\S]*PROPOSED[\s\S]*CHANGED[\s\S]*RECEIPT[\s\S]*REQUESTED[\s\S]*APPROVED ACTION[\s\S]*EXECUTED/);

    // AT-L20: learning created no artifact, source, approval or request; every approval and release step was a person's act.
    assert.ok(app.ledger.all().filter((e) => ["action.requested", "action.approved", "change.recorded"].includes(e.type) && e.actor.id === "sys_LEARNING").length === 0);
    assert.equal(app.ledger.verify().ok, true);
    assert.equal(get<{ n: number }>(app.db, "SELECT COUNT(*) AS n FROM executions WHERE simulated = 0")!.n, 1);
  } finally {
    await server.close();
    app.close();
  }
});

test("receipt and policy invalidation: every Phase 2 change to what applies makes an outstanding receipt unusable until a fresh check", () => {
  const changes: Array<[string, (s: ReturnType<typeof scenario>, ruleId: string, artifactId: string) => void]> = [
    ["a person pauses the rule", (s, r) => s.app.rules.suspend(r, s.marcus, "2026-11-30", "re-pricing")],
    ["a person changes the rule", (s, r) => s.app.rules.revise({ ...(({ status: _a, authority: _b, approval: _c, ...c }) => c)(s.app.rules.get(r)), revision: 2, supersedes: 1, statement: "Every line must be in SGD (revised)." }, s.marcus, [])],
    ["an exception is granted for the document", (s, r, a) => s.app.exceptions.grant(s.app.exceptions.request({ project_id: s.project.project_id, rule_id: r, artifact_id: a, reason: "one-off order", days: 2 }, s.marcus).exception_id, s.marcus)],
    ["a new trusted-source version is imported from CSV", (s) => {
      const src = s.app.projects.registerSource({ name: "[TEST] list", key_columns: ["item_code"], value_columns: ["unit_price"], max_age_days: 30 }, s.marcus);
      const rule = s.app.authoring.create({ project_id: s.project.project_id, template: { template: "price_matches_source", source_id: src, key_column: "item_code", value_column: "unit_price" } }, s.marcus);
      s.app.projects.importCsv(src, { file_name: "p.csv", text: "item_code,unit_price\nHX-200,1180.00\nCAL-1Y,300.00\n" }, s.marcus);
      s.app.rules.approveAndActivate(rule.rule_id, s.marcus, { trial: true });
    }],
    ["a person approves another rule in scope", (s) => {
      const r = s.app.authoring.create({ project_id: s.project.project_id, template: { template: "required_field", field: "quote.reference" } }, s.marcus);
      s.app.rules.approveAndActivate(r.rule_id, s.marcus, { trial: true });
    }],
  ];
  for (const [what, change] of changes) {
    const s = scenario(null);
    activeRule(s.app, { rule_id: "rul_SGD00001", scope: { level: "project", workspace_id: s.app.workspaceId, project_selector: null, project_id: s.project.project_id, area_id: null, artifact_id: null, work_types: ["sales_proposal"], artifact_types: ["document"], actions: [] } });
    s.app.gateway.setActionPolicy(s.project.project_id, "release", "self", s.marcus);
    const out = s.app.checks.check({ project_id: s.project.project_id, name: "Q.md", bytes: quote({ currency: "SGD" }), action: { type: "release" }, actor: s.marcus });
    assert.equal(s.app.gateway.receiptStanding(out.receipt_id!).usable, true, what);
    change(s, "rul_SGD00001", s.app.checks.getRun(out.run_id!).artifact.artifact_id);
    const standing = s.app.gateway.receiptStanding(out.receipt_id!);
    assert.equal(standing.usable, false, what);
    assert.ok(standing.failed.some((f) => f.step === 6 || f.step === 7), `${what}: ${JSON.stringify(standing.failed)}`);
    // And the gateway refuses to act on it.
    const req = s.app.gateway.requestAction({ receipt_id: out.receipt_id!, type: "release" }, s.marcus).request;
    s.app.gateway.approve(req.action_id, s.marcus);
    assert.equal(s.app.gateway.execute(req.action_id, s.marcus).status, "blocked", what);
    assert.equal(all(s.app.db, "SELECT 1 FROM executions").length, 0, what);
  }
});
