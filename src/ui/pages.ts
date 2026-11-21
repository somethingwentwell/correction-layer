/**
 * The app shell: every screen of the designed UX exists as a route and renders
 * from the real framework services (docs/01, docs/02). Where Phase 2 work remains,
 * the screen says so with an explicit "not available" state - it is never blank
 * and never pretends.
 *
 * Screen ids in comments (UX-n, OBS-n) refer to the wireframes in the design docs.
 */
import type { App } from "../app.ts";
import type { Project } from "../context/projects.ts";
import { displayTime } from "../domain/time.ts";
import type { Rule, RunRecord } from "../domain/types.ts";
import { FORMAT_ADAPTERS } from "../formats/adapters.ts";
import type { LedgerEvent } from "../ledger/ledger.ts";
import { REASON_WORDS } from "../learning/decision.ts";
import { SURFACE_CEILING } from "../learning/policy.ts";
import { CATALOGUE } from "../policy/catalogue.ts";
import type { Safe } from "./html.ts";
import { empty, html, label, outcomeWord, unavailable, verdictBadge } from "./html.ts";

export interface Page {
  title: string;
  body: Safe;
  project?: Project | null;
}

const KIND_WORDS: Record<string, string> = { deterministic: "Exact", source_backed: "Trusted source", attested: "Person confirms", model_review: "AI opinion (note)" };
const STATUS_WORDS: Record<string, string> = { candidate: "Candidate (off)", trial: "On trial (note only)", active: "On", suspended: "Paused", retired: "Retired", rejected: "Rejected" };
const MODE_WORDS: Record<string, string> = { off: "Off", suggest: "Suggest", quiet: "Learn quietly", auto_low_risk: "Learn and enforce" };

export class Pages {
  private app: App;
  private csrf: string;

  constructor(app: App, csrf: string) {
    this.app = app;
    this.csrf = csrf;
  }

  private t(value: string | null | undefined): string {
    return value ? displayTime(value, this.app.displayTz) : "";
  }

  private who(id: string | null | undefined): string {
    return this.app.projects.displayName(id);
  }

  private post(action: string, button: string, fields: Record<string, string> = {}, primary = false): Safe {
    return html`<form class="inline" method="post" action="${action}"><input type="hidden" name="_csrf" value="${this.csrf}">${Object.entries(fields).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}<button type="submit" class="${primary ? "primary" : ""}">${button}</button></form>`;
  }

  private authority(rule: Rule): Safe {
    if (rule.authority?.kind === "delegated_learning") return label("Added automatically - no click", "auto");
    if (rule.authority?.confirmed) return label("Learned, then kept by a person");
    if (rule.authority?.kind === "individual_approval") return label("Approved by a person");
    return html``;
  }

  private events(events: LedgerEvent[]): Safe {
    if (!events.length) return empty("Nothing recorded yet.");
    return html`<table class="timeline"><thead><tr><th>When</th><th>What</th><th>By</th></tr></thead><tbody>${events.map((e) => html`<tr><td>${this.t(e.occurred_at)}</td><td>${e.summary}<div class="muted mono">${e.type} - ${e.event_id}${e.caused_by.length ? ` - because of ${e.caused_by.join(", ")}` : ""}</div></td><td>${e.actor.display_name ?? this.who(e.actor.id)} <span class="muted">(${e.actor.kind})</span></td></tr>`)}</tbody></table>`;
  }

  // ---------------------------------------------------------------- home and onboarding (UX-1 to UX-4)
  home(): Page {
    const projects = this.app.projects.list();
    const unbound = this.app.learning.inbox(null);
    const body = html`
      ${projects.length ? html`<h2>Projects</h2>${projects.map((p) => html`<div class="card"><a href="/projects/${p.project_id}"><strong>${p.name}</strong></a>${p.is_demo ? label("DEMO", "demo-label") : ""}<div class="muted">Sales proposals${p.facts.customer_name ? ` - Customer: ${p.facts.customer_name}` : ""} - ${p.folders.length} folder(s)</div></div>`)}` : html`<div class="card"><strong>No projects yet.</strong> <p>Add a folder of work to get a first check in four steps.</p></div>`}
      <p><a href="/onboarding">+ Add a folder / new project</a></p>
      ${unbound.length ? html`<h2>Needs you (not tied to a project)</h2>${unbound.map((i) => html`<div class="card">${i.question} <div class="muted">${this.t(i.opened_at)}</div>${this.post(`/app/inbox/${i.inbox_id}/resolve`, "Dismiss", { resolution: "dismissed", back: "/" })}</div>`)}` : ""}`;
    return { title: "All projects", body };
  }

  onboarding(): Page {
    const body = html`
      <p>Step 1 of 4: add a folder. Step 2: confirm the project and the kind of work. Then check a first file.</p>
      <form method="post" action="/app/projects"><input type="hidden" name="_csrf" value="${this.csrf}">
        <fieldset><legend>Folder and project</legend>
          <label>Folder on this computer <input type="text" name="folder" placeholder="/Users/you/Documents/Proposals/Customer" required></label>
          <label>Project name <input type="text" name="name" required></label>
          <label>Kind of work <select name="default_work_type"><option value="sales_proposal">Sales proposals</option></select></label>
          <label>Customer name (a project fact you confirm; optional) <input type="text" name="customer_name"></label>
        </fieldset>
        <button class="primary" type="submit">Create project</button>
      </form>
      ${unavailable("suggested project facts, starter rules and trusted-source import during onboarding (UX-2, UX-3)", "Facts are typed and confirmed by you here; nothing is inferred from file contents. Starter packs and spreadsheet import are Phase 2.")}
      ${unavailable("the folder marker file", "The folder is bound in the workspace store only; no marker is written into your folder yet.")}`;
    return { title: "Get started", body };
  }

  // ---------------------------------------------------------------- project home (UX-5)
  project(projectId: string): Page {
    const p = this.app.projects.get(projectId);
    const versions = this.app.checks.latestVersions(projectId);
    const runs = this.app.checks.listRuns({ project_id: projectId, limit: 200 });
    const inScope = this.app.rules.selectInScope({ project_id: projectId, area_ids: [], artifact_id: null, work_type: p.default_work_type, artifact_type: "document", action: "release" }).rules;
    const policy = this.app.policies.current(projectId);
    const coverage = this.app.gateway.coverage(projectId);
    const sources = this.app.projects.listSources();
    const notices = this.app.learning.notices(projectId).slice(0, 3);
    const body = html`
      <p class="muted">Sales proposals${p.facts.customer_name ? ` - Customer: ${p.facts.customer_name}` : ""}</p>
      ${notices.map((n) => html`<div class="card" role="status"><strong>Learned for ${p.name}</strong><p>${n.text}</p><a href="/rules/${n.rule_id}?project=${projectId}">Details / Undo / Keep</a></div>`)}
      <h2>Recent work</h2>
      ${versions.length ? html`<table><tbody>${versions.map((v) => {
        const run = runs.find((r) => r.artifact.artifact_id === v.artifact_id);
        const current = run && run.artifact.content_hash === v.content_hash;
        return html`<tr><td>${v.name}${v.is_demo ? label("DEMO", "demo-label") : ""}</td><td>${current ? verdictBadge(run.verdict) : verdictBadge(null)}${run && !current ? html` <span class="muted">a newer version has not been checked</span>` : ""}</td><td>version ${v.version_seq}, seen ${this.t(v.observed_at)}</td><td>${run ? html`<a href="/runs/${run.run_id}">open check</a>` : ""}</td></tr>`;
      })}</tbody></table>` : empty("No files have been checked in this project yet.")}
      <details><summary><strong>Check a file</strong></summary>
        <form method="post" action="/app/projects/${projectId}/check"><input type="hidden" name="_csrf" value="${this.csrf}">
          <label>File name <input type="text" name="name" value="Quote.md" required></label>
          <label>Content (Markdown or plain text with a pricing table)<textarea name="content" required></textarea></label>
          <label>Check for <select name="action"><option value="release">Release (gated, SIMULATED)</option><option value="check_only">Just check</option><option value="send_external">Send to customer (not available: advisory only)</option></select></label>
          <button class="primary" type="submit">Check</button>
        </form>
        <p class="muted">Readable in this build: ${FORMAT_ADAPTERS.filter((a) => a.capability.availability === "implemented" && !a.capability.fixture_only).map((a) => a.capability.accepts.join(", ")).join("; ")}. Word, Excel and PDF files are reported as Couldn't verify.</p>
      </details>
      <h2>Rules that apply here</h2>
      <p>${inScope.length} rule(s) apply to sales proposals released from this project: ${inScope.filter((r) => r.status === "active" && r.content.enforcement === "block").length} must pass, ${inScope.filter((r) => r.status === "trial" || r.content.enforcement === "warn").length} note only. <a href="/projects/${projectId}/rules">See all rules</a></p>
      <details><summary><strong>+ Add a correction</strong></summary>
        <form method="post" action="/app/projects/${projectId}/corrections"><input type="hidden" name="_csrf" value="${this.csrf}">
          <label>In your own words <input type="text" name="text" placeholder="Quotes for this customer must always be in SGD" required></label>
          <button type="submit">Add</button>
        </form>
        <p class="muted">Typed here, a correction is captured by the app itself. With learning Off it is not kept (the manual rule editor, UX-7, is Phase 2).</p>
      </details>
      <h2>Trusted sources</h2>
      ${sources.length ? html`<table><tbody>${sources.map((s) => html`<tr><td>${s.name}</td><td>vouched by ${this.who(s.owner)}</td><td>${s.latest ? `updated ${this.t(s.latest.imported_at)}` : "no version imported"}</td></tr>`)}</tbody></table>` : empty("No trusted sources are registered.")}
      <h2>Folders</h2>
      ${p.folders.length ? html`<ul>${p.folders.map((f) => html`<li class="mono">${f.path} <span class="muted">connected</span></li>`)}</ul>` : empty("No folder is connected.")}
      <h2>What is enforced here</h2>
      <table><tbody>${coverage.slice(0, 3).map((c) => html`<tr><td>${c.action.replace(/_/g, " ")}</td><td><strong>${c.label.replace("_", " ")}</strong>${c.qualifier ? `, ${c.qualifier.replace("_", " ")}` : ""}${c.simulated ? label("SIMULATED") : ""}</td><td class="muted">${c.note}</td></tr>`)}</tbody></table>
      <p><a href="/projects/${projectId}/coverage">See coverage map</a></p>
      <h2>Learning</h2>
      <p>${policy && policy.mode !== "off" ? `${MODE_WORDS[policy.mode]} - set by ${this.who(policy.set_by.id)}, ${this.t(policy.set_at)}.` : "Off for this project. Corrections are added by hand."} <a href="/projects/${projectId}/learning/settings">Learning settings</a></p>
      <h2>Recent activity</h2>
      ${this.events(this.app.ledger.recent({ projectId, limit: 6 }))}
      <p><a href="/projects/${projectId}/activity">See full history</a></p>`;
    return { title: p.name, body, project: p };
  }

  // ---------------------------------------------------------------- rules overview (OBS-1) and detail (OBS-2)
  rules(projectId: string, action: string): Page {
    const p = this.app.projects.get(projectId);
    const query = { project_id: projectId, area_ids: [], artifact_id: null, work_type: p.default_work_type, artifact_type: "document", action };
    const selection = this.app.rules.selectInScope(query);
    const inScopeIds = new Set(selection.rules.map((r) => r.content.rule_id));
    const all = this.app.rules.listForProject(projectId);
    const row = (r: Rule): Safe => html`<tr><td><a href="/rules/${r.rule_id}?project=${projectId}">${r.title}</a>${this.authority(r)}<div class="muted">${r.statement}</div></td><td>${KIND_WORDS[r.method]}</td><td>${r.status === "trial" || r.enforcement === "warn" ? "Note" : "Must fix"}</td><td>${STATUS_WORDS[r.status]}</td><td>${this.who(r.owner)}</td></tr>`;
    const head = html`<thead><tr><th>Rule</th><th>Kind</th><th>When not met</th><th>Status</th><th>Owner</th></tr></thead>`;
    const applying = all.filter((r) => inScopeIds.has(r.rule_id));
    const others = all.filter((r) => !inScopeIds.has(r.rule_id));
    const hidden = this.app.rules.outOfScope(query).filter((o) => !o.visible).length;
    const body = html`
      <form method="get"><label>View as this project, for <select name="action">${["release", "send_external", "check_only"].map((a) => html`<option value="${a}" ${a === action ? html`selected` : ""}>${a.replace(/_/g, " ")}</option>`)}</select></label> <button type="submit">Show</button></form>
      <h2>Apply here (${applying.length})</h2>
      <p class="muted">Exactly the set the check engine evaluates for a sales proposal in this project for "${action.replace(/_/g, " ")}". Selected by lookup, never by search. Digest: <span class="mono">${selection.ruleset_digest.slice(0, 23)}...</span></p>
      ${applying.length ? html`<table>${head}<tbody>${applying.map(row)}</tbody></table>` : empty("No rule applies in this context.")}
      <h2>Not applying in this view (${others.length})</h2>
      ${others.length ? html`<table>${head}<tbody>${others.map(row)}</tbody></table>` : empty("Nothing else is visible from this project.")}
      <p class="muted">${hidden} active rule(s) belong only to other projects. They are counted, not shown.</p>
      ${unavailable("search, filters, grouping and the rule health queue (OBS-1)", "The list is complete but unfiltered in this build.")}`;
    return { title: "Rules", body, project: p };
  }

  rule(ruleId: string, projectId: string | null): Page {
    const r = this.app.rules.get(ruleId);
    const owning = r.scope.project_id ?? projectId;
    const p = owning ? this.app.projects.get(owning) : null;
    const back = `/rules/${ruleId}${owning ? `?project=${owning}` : ""}`;
    const history = this.app.ledger.byRef("rule_id", ruleId);
    const origin = r.origin.signal_ids?.length ? this.app.ledger.byRef("signal_id", r.origin.signal_ids[0]!)[0] : undefined;
    const signalText = r.origin.signal_ids?.length ? (this.app.db.prepare("SELECT text, author_id FROM signals WHERE signal_id = ?").get(r.origin.signal_ids[0]!) as any) : null;
    const counts = this.app.checks.ruleOutcomeCounts(ruleId);
    const spec = CATALOGUE[r.check.kind];
    const scopeWords: Record<string, string> = { workspace: "Everyone (all projects)", project_group: `Projects where ${r.scope.project_selector?.fact} = ${r.scope.project_selector?.equals}`, project: "This project only", area: "One folder area", artifact: "Only one document" };
    const body = html`
      <p><strong>${r.statement}</strong></p>
      <table><tbody>
        <tr><th>Status</th><td>${STATUS_WORDS[r.status]} ${this.authority(r)}</td></tr>
        <tr><th>Kind</th><td>${KIND_WORDS[r.method]} - ${spec.sentence} <span class="mono">(${r.check.kind})</span>${spec.availability === "unavailable" ? label("check kind not available in this build: result is Couldn't verify") : ""}</td></tr>
        <tr><th>When not met</th><td>${r.enforcement === "block" ? "Must be fixed before a gated action" : "Shown as a note"}${r.status === "trial" ? " (on trial: note only)" : ""}</td></tr>
        <tr><th>Applies to</th><td>${scopeWords[r.scope.level]} - work types: ${r.scope.work_types.join(", ") || "any"} - actions: ${r.scope.actions.join(", ") || "any"}</td></tr>
        <tr><th>Owner</th><td>${this.who(r.owner)} - review by ${r.review_by}</td></tr>
        <tr><th>In force because</th><td>${r.authority?.kind === "delegated_learning" ? `It turned on automatically under the learning setting saved by ${this.who(r.authority.delegated_by)} (decision ${r.authority.decision_id}). No person approved this rule individually.` : r.approval ? `${this.who(r.approval.approved_by)} approved it on ${this.t(r.approval.approved_at)}${r.approval.self_approval ? " (self-approval)" : ""}.` : "Not in force."}</td></tr>
        <tr><th>Original correction</th><td>${signalText?.text ? html`"${signalText.text}" - ${this.who(signalText.author_id)}${origin ? `, ${this.t(origin.occurred_at)}` : ""}` : r.origin.kind === "human_correction" ? "Original wording not available." : `From ${r.origin.kind.replace("_", " ")}${r.origin.pack ? ` "${r.origin.pack}"` : ""}.`}</td></tr>
      </tbody></table>
      <p>
        ${r.status === "candidate" ? html`${this.post(`/app/rules/${ruleId}/approve`, "Approve and turn on", { back }, true)} ${this.post(`/app/rules/${ruleId}/approve`, "Approve on trial (note only)", { trial: "1", back })} ${this.post(`/app/rules/${ruleId}/reject`, "Reject", { back })}` : ""}
        ${r.status === "active" || r.status === "trial" ? this.post(`/app/rules/${ruleId}/retire`, r.authority?.kind === "delegated_learning" ? "Undo" : "Retire", { back }) : ""}
        ${r.authority?.kind === "delegated_learning" && (r.status === "active" || r.status === "trial") ? this.post(`/app/rules/${ruleId}/keep`, "Keep (make it person-approved)", { back }) : ""}
        ${owning && r.authority ? html`<a href="/projects/${owning}/learning/timeline/${ruleId}">Timeline</a>` : ""}
      </p>
      <h2>Examples</h2>
      ${r.cases.length ? html`<table><thead><tr><th>Example</th><th>Expected</th><th>Last result</th></tr></thead><tbody>${r.cases.map((c) => html`<tr><td>${c.kind === "negative" ? "Should be caught" : "Should pass"}: ${c.description}<div class="mono muted">${c.artifact_hash}</div></td><td>${outcomeWord(c.expect)}</td><td>${c.last_result ? outcomeWord(c.last_result) : "not run"}</td></tr>`)}</tbody></table>` : empty("No stored examples. A must-pass rule needs one it blocks and one it allows before it can be turned on.")}
      <h2>How often it was evaluated</h2>
      <p>${Object.keys(counts).length ? Object.entries(counts).map(([o, n]) => `${outcomeWord(o)}: ${n}`).join(" - ") : "Never evaluated yet."} <span class="muted">Plain counts. They do not show that the rule made any work better.</span></p>
      <h2>History</h2>
      ${this.events(history)}
      ${unavailable("revising, pausing with an end date, exceptions, dry run on existing work (OBS-2, UX-7)", "A rule can be approved, kept, undone or retired in this build.")}`;
    return { title: r.title, body, project: p };
  }

  // ---------------------------------------------------------------- activity (OBS-3)
  activity(projectId: string): Page {
    const p = this.app.projects.get(projectId);
    return { title: "Activity", body: html`<p class="muted">Every act, with who did it and what caused it. Newest first.</p>${this.events(this.app.ledger.recent({ projectId, limit: 200 }))}`, project: p };
  }

  // ---------------------------------------------------------------- artifact review (UX-6) and timeline (OBS-4)
  run(runId: string): Page {
    const run = this.app.checks.getRun(runId);
    const p = this.app.projects.get(run.context.project_id!);
    const previous = this.app.checks.listRuns({ artifact_id: run.artifact.artifact_id, limit: 100 }).filter((r) => r.completed_at <= run.completed_at && r.run_id !== run.run_id)[0];
    const standing = run.receipt_id ? this.app.gateway.receiptStanding(run.receipt_id) : null;
    const out = this.app.rules.outOfScope({ project_id: p.project_id, area_ids: run.context.area_ids, artifact_id: run.artifact.artifact_id, work_type: run.context.work_type, artifact_type: run.artifact.artifact_type, action: run.action.type });
    const flags = this.app.db.prepare("SELECT flag, detail FROM artifact_risk_flags WHERE artifact_id = ?").all(run.artifact.artifact_id) as any[];
    const c = run.counts;
    const body = html`
      <p>${verdictBadge(run.verdict)} - ${run.artifact.name}, version ${run.artifact.version_seq}, checked for <strong>${run.action.type.replace(/_/g, " ")}</strong> on ${this.t(run.completed_at)}. <span class="muted">Advisory check.</span></p>
      <p class="muted">A check finds problems; it does not fix them. A pass is not permission.</p>
      <p>${run.results.length} rule(s) applied: ${c.pass} passed, ${c.fail} need changes, ${c.unknown + c.error + c.conflict} could not be verified, ${c.not_applicable} do not apply, ${c.waived} skipped by exception, ${c.skipped} skipped, ${c.notes} note(s).</p>
      ${run.coverage_gaps.length ? html`<div class="card"><strong>Parts of the file that could not be read:</strong> ${run.coverage_gaps.map((g) => `${g.component} (${g.state}${g.detail ? `: ${g.detail}` : ""})`).join("; ")}. What you can do: save the content as Markdown or plain text and check again.</div>` : ""}
      ${flags.map((f) => html`<div class="card"><strong>Risk flag:</strong> ${f.flag.replace(/_/g, " ")}. ${f.detail}</div>`)}
      <h2>Every rule in scope</h2>
      <table><thead><tr><th>Rule</th><th>Result</th><th>Why</th></tr></thead><tbody>${run.results.map((r) => html`<tr><td><a href="/rules/${r.rule_id}?project=${p.project_id}">${r.title}</a> <span class="muted">rev ${r.revision}</span>${r.effective_enforcement === "warn" ? label("note") : ""}</td><td><strong>${outcomeWord(r.outcome)}</strong></td><td>${r.reason}${r.findings.map((f) => html`<div class="card"><strong>${f.location.label}</strong>: ${f.message}. Found <span class="mono">${f.found.text ?? f.found.amount ?? f.found.number ?? f.found.reason ?? ""}${f.found.currency ? ` ${f.found.currency}` : ""}</span>, expected <span class="mono">${f.expected.text ?? f.expected.amount ?? ""}${f.expected.currency ? ` ${f.expected.currency}` : ""}</span>.${f.fix_hint ? html` <em>Suggested: ${f.fix_hint}</em>` : ""}</div>`)}</td></tr>`)}</tbody></table>
      ${run.results.length ? "" : empty("No rule is in scope for this context.")}
      <p class="muted">${run.inventory.out_of_scope} other active rule(s) were not in scope${out.length ? ` (${Object.entries(out.reduce<Record<string, number>>((m, o) => ({ ...m, [o.excluded_by]: (m[o.excluded_by] ?? 0) + 1 }), {})).map(([k, n]) => `${n} by ${k.replace("_", " ")}`).join(", ")})` : ""}. Rules as of revision ${run.policy.policy_rev}.</p>
      <h2>What happens next</h2>
      ${standing ? html`<div class="card">A receipt exists for this exact version and action (${standing.usable ? "valid" : `no longer usable: ${standing.failed.map((f) => f.detail ?? f.check).join("; ")}`}, expires ${this.t(standing.receipt.expires_at)}). It is evidence, not permission.
        ${standing.usable ? this.post(`/app/receipts/${run.receipt_id}/request`, `Request ${run.action.type.replace(/_/g, " ")} (SIMULATED)`, { type: run.action.type }, true) : ""}</div>` : html`<p>${run.verdict === "ready" ? "No receipt: no gated route exists for this action in this build, so nothing can be released through the product." : run.verdict === "needs_changes" ? "Someone fixes the findings in the tool they already use; then check the new version. The product does not edit your file." : "Resolve what could not be verified, then check again."}</p>`}
      <p>${previous ? html`<a href="/compare?before=${previous.run_id}&after=${run.run_id}">Compare with the previous check</a> - ` : ""}<a href="/traces/${run.trace_id}">Timeline of this piece of work</a></p>
      <details><summary>Details: IDs</summary><p class="mono">run ${run.run_id} - trace ${run.trace_id} - content ${run.artifact.content_hash} - ruleset ${run.policy.ruleset_digest} - inputs ${run.reproducibility.inputs_digest} - parser ${run.artifact.parser.id} ${run.artifact.parser.version} - engine ${run.policy.engine_version}</p></details>
      ${unavailable("highlighting findings inside the document, fix proposals, \"this finding is wrong\", exceptions and re-run as recorded (UX-6, OBS-4)", "Findings are listed with their locations; the document preview is Phase 2.")}`;
    return { title: `Check: ${run.artifact.name}`, body, project: p };
  }

  trace(traceId: string): Page {
    const events = this.app.ledger.byRef("trace_id", traceId);
    const artifactId = events.find((e) => e.refs.artifact_id)?.refs.artifact_id as string | undefined;
    const all = artifactId ? this.app.ledger.byRef("artifact_id", artifactId) : events;
    const merged = [...new Map([...events, ...all].map((e) => [e.seq, e])).values()].sort((a, b) => a.seq - b.seq);
    const projectId = merged.find((e) => e.project_id)?.project_id ?? null;
    const p = projectId ? this.app.projects.get(projectId) : null;
    const words: Record<string, string> = { "artifact.observed": "SEEN", "run.completed": "CHECKED", "change.recorded": "CHANGED", "receipt.issued": "RECEIPT", "action.requested": "REQUESTED", "action.approved": "APPROVED", "action.executed": "EXECUTED", "action.blocked": "BLOCKED", "action.paused": "PAUSED", "receipt.consumed": "USED", "receipt.invalidated": "LAPSED", "action.revalidated": "RE-VERIFIED", "learning.signal_detected": "IDENTIFIED" };
    const body = html`
      <p class="muted">Detection is by the check engine, changes by people or their assistants (or an unknown editor), approvals by people, execution by an adapter. Times: ${this.app.displayTz}.</p>
      ${merged.length ? html`<table class="timeline"><tbody>${merged.map((e) => html`<tr><td>${this.t(e.occurred_at)}</td><td class="word">${words[e.type] ?? e.type}</td><td>${e.summary}${e.refs.run_id ? html` <a href="/runs/${e.refs.run_id}">open check</a>` : ""}${e.refs.action_id ? html` <a href="/actions/${e.refs.action_id}">open request</a>` : ""}<div class="muted mono">${e.event_id} seq ${e.seq}${e.caused_by.length ? ` - because of ${e.caused_by.join(", ")}` : ""}</div></td><td>${e.actor.display_name ?? this.who(e.actor.id)}</td></tr>`)}</tbody></table>` : empty("No events for this trace.")}`;
    return { title: "Timeline of a piece of work", body, project: p };
  }

  // ---------------------------------------------------------------- before / after / recheck (OBS-5)
  compare(beforeId: string, afterId: string): Page {
    const c = this.app.checks.compare(beforeId, afterId);
    const p = this.app.projects.get(c.after.context.project_id!);
    const side = (r: RunRecord): Safe => html`<td>${verdictBadge(r.verdict)}<div>version ${r.artifact.version_seq} - ${this.t(r.completed_at)}</div><div class="mono muted">${r.artifact.content_hash.slice(0, 23)}...</div><a href="/runs/${r.run_id}">open check</a></td>`;
    const list = (title: string, items: typeof c.resolved, none: string): Safe => html`<h2>${title} (${items.length})</h2>${items.length ? html`<ul>${items.map((f) => html`<li><strong>${f.location.label}</strong>: ${f.message}</li>`)}</ul>` : empty(none)}`;
    const body = html`
      ${c.same_artifact ? "" : html`<div class="card">These two checks are of different files.</div>`}
      <table><thead><tr><th>Before</th><th>After (recheck)</th></tr></thead><tbody><tr>${side(c.before)}${side(c.after)}</tr></tbody></table>
      <p class="muted">The check did not change the file. Someone changed it; the recheck no longer reports the findings below as open.</p>
      ${list("Findings resolved after the change", c.resolved, "None.")}
      ${list("Findings introduced", c.introduced, "None.")}
      ${list("Findings still open", c.remaining, "None.")}
      ${unavailable("the before/after view of each changed cell and passage", c.content_diff.reason)}`;
    return { title: `Before and after: ${c.after.artifact.name}`, body, project: p };
  }

  // ---------------------------------------------------------------- learning: settings (UX-11), queue (UX-13), added (OBS-9), timeline (OBS-10)
  learningSettings(projectId: string): Page {
    const p = this.app.projects.get(projectId);
    const policy = this.app.policies.current(projectId);
    const mode = policy?.mode ?? "off";
    const people = this.app.db.prepare("SELECT principal_id, display_name FROM principals WHERE kind = 'human' ORDER BY display_name").all() as any[];
    const radio = (value: string, name: string, text: string): Safe => html`<label><input type="radio" name="mode" value="${value}" ${mode === value ? html`checked` : ""}> <strong>${name}</strong> - ${text}</label>`;
    const body = html`
      <form method="post" action="/app/projects/${projectId}/learning"><input type="hidden" name="_csrf" value="${this.csrf}">
        <fieldset><legend>When someone corrects work in this project, should that be remembered?</legend>
          ${radio("off", "Off", "Nothing is noticed. Add corrections by hand.")}
          ${radio("suggest", "Suggest", "Corrections are noticed and tested. Each one waits for your OK.")}
          ${radio("quiet", "Learn quietly", "Safe ones turn on as notes only. They never block.")}
          ${radio("auto_low_risk", "Learn and enforce", "Safe ones turn on and must be fixed before a gated action, in this project only. You get a notice with Undo.")}
        </fieldset>
        <p>"Safe" means: an exact check, only for this project, that adds a requirement, was said plainly by a person below, catches the thing that was corrected, passes the corrected version, and flags none of your other work. Anything else still asks.</p>
        <fieldset><legend>Whose corrections count</legend>${people.map((x) => html`<label><input type="checkbox" name="learn_from" value="${x.principal_id}" ${!policy || policy.learn_from.includes(x.principal_id) ? html`checked` : ""}> ${x.display_name}</label>`)}</fieldset>
        <fieldset><legend>Where corrections are noticed</legend>
          <table><tbody>
            <tr><td>This app (correction box)</td><td><strong>CAPTURED</strong></td><td class="muted">can turn on by itself</td></tr>
            ${this.app.intake.adapters().filter((a) => a.kind === "runtime_hook").map((a) => html`<tr><td>${a.label}</td><td><strong>${a.revoked ? "NOT CAPTURED" : "CAPTURED"}</strong>${a.simulated ? label("SIMULATED adapter") : ""}</td><td class="muted">event adapter with outbox, acknowledgements and replay</td></tr>`)}
            <tr><td>Edits to files in this folder</td><td><strong>NOT CAPTURED</strong></td><td class="muted">folder watching is not available in this build</td></tr>
            <tr><td>Corrections an assistant passes on by itself</td><td><strong>RELAYED</strong></td><td class="muted">best effort; always asks you</td></tr>
            <tr><td>Any other app or assistant (chat, email, calls)</td><td><strong>NOT CAPTURED</strong></td><td class="muted">no adapter exists; corrections made there are not seen</td></tr>
          </tbody></table>
        </fieldset>
        <p><strong>Never automatic, whatever you choose:</strong> switching a rule off, exceptions, who approves, who can send, trusted lists, anything beyond this project.</p>
        <p class="muted">All limits are proposed, uncalibrated defaults (3 automatic rules per day; 1 real passing example; 0 held-out failures).</p>
        ${policy ? html`<p>Currently: ${MODE_WORDS[policy.mode]}, set by ${this.who(policy.set_by.id)}, ${this.t(policy.set_at)} (revision ${policy.revision}).</p>` : html`<p>Currently: Off (never set).</p>`}
        <button class="primary" type="submit">Save</button>
      </form>`;
    return { title: `Learning for: ${p.name}`, body, project: p };
  }

  learning(projectId: string): Page {
    const p = this.app.projects.get(projectId);
    const q = this.app.learning.queue(projectId);
    const policy = this.app.policies.current(projectId);
    const reasons = (rs: string[]): string => rs.map((r) => REASON_WORDS[r] ?? r).join("; ");
    const body = html`
      <p>${policy && policy.mode !== "off" ? `Learning is set to "${MODE_WORDS[policy.mode]}".` : "Learning is Off for this project: nothing is captured for learning."} <a href="/projects/${projectId}/learning/settings">Settings</a> - <a href="/projects/${projectId}/learning/added">Added automatically (audit)</a> - <a href="/projects/${projectId}/capture">Capture health</a></p>
      <table><thead><tr><th>Captured</th><th>Identified</th><th>Compiled</th><th>Tested</th><th>On</th><th>Asked</th></tr></thead><tbody><tr><td>${q.funnel.captured}</td><td>${q.funnel.identified}</td><td>${q.funnel.compiled}</td><td>${q.funnel.tested}</td><td>${q.funnel.activated}</td><td>${q.funnel.asked}</td></tr></tbody></table>
      <p class="muted">Counts for each stage, not rates. Captured is not identified; identified is not on.</p>
      <h2>Needs you (${q.needs_you.length})</h2>
      ${q.needs_you.length ? q.needs_you.map((i) => html`<div class="card"><div>${i.question}</div>${i.detail.text ? html`<div class="muted">"${String(i.detail.text)}"</div>` : ""}<div class="muted">${i.kind.replace(/_/g, " ")} - ${this.t(i.opened_at)}</div>${i.rule_id ? html`<a href="/rules/${i.rule_id}?project=${projectId}">Review the candidate rule</a> ` : ""}${this.post(`/app/inbox/${i.inbox_id}/resolve`, "Dismiss", { resolution: "dismissed", back: `/projects/${projectId}/learning` })}</div>`) : empty("Nothing is waiting for you.")}
      <h2>Turned on by itself (${q.turned_on.length})</h2>
      ${q.turned_on.length ? html`<table><tbody>${q.turned_on.map((r) => html`<tr><td>${this.t(r.decided_at)}</td><td><a href="/rules/${r.rule_id}?project=${projectId}">${r.title}</a></td><td>${STATUS_WORDS[r.status]}${r.confirmed ? " (kept by a person)" : ""}</td></tr>`)}</tbody></table>` : empty("No rule has turned on by itself.")}
      <h2>Waiting for evidence (${q.waiting.length})</h2>
      ${q.waiting.length ? html`<ul>${q.waiting.map((w) => html`<li>"${w.text ?? ""}" - ${reasons(w.reasons)} (until ${this.t(w.expires_at)})</li>`)}</ul>` : empty("Nothing is waiting for evidence.")}
      <h2>Not learned (${q.not_learned.length})</h2>
      ${q.not_learned.length ? html`<table><tbody>${q.not_learned.map((n) => html`<tr><td>${this.t(n.decided_at)}</td><td>${n.text ? `"${n.text}"` : "(text not kept)"}</td><td>${reasons(n.reasons)}</td></tr>`)}</tbody></table>` : empty("Nothing was set aside.")}
      <h2>Captured, not seen as corrections (${q.captured_not_seen})</h2>
      ${unavailable("reviewing your own captured messages and marking one \"this was a correction\"", "Only the count is shown. The text is held for the review window and is not displayed in this build.")}
      <p class="muted">${q.not_captured_no_consent} event(s) arrived while learning was off for this project or surface. Their content was not kept.</p>`;
    return { title: `Learning: ${p.name}`, body, project: p };
  }

  learningAdded(projectId: string): Page {
    const p = this.app.projects.get(projectId);
    const decisions = this.app.learning.decisions(projectId);
    const auto = decisions.filter((d) => ["auto_activate", "auto_shadow", "shadow_and_inbox"].includes(d.outcome));
    const rest = decisions.filter((d) => !["auto_activate", "auto_shadow", "shadow_and_inbox", "waiting_for_evidence"].includes(d.outcome));
    const body = html`
      <p class="muted">Every rule that turned on with no click stays listed here for good, with whose standing permission it used and why.</p>
      ${auto.length ? auto.map((d) => {
        const rule = this.app.rules.get(d.candidate.rule_id);
        const text = (this.app.db.prepare("SELECT text FROM signals WHERE signal_id = ?").get(d.signals[0].signal_id) as any)?.text;
        return html`<div class="card"><strong>${this.t(d.decided_at)} - ${rule.title}</strong> ${label(STATUS_WORDS[rule.status]!)}
          <table><tbody>
            <tr><th>Permission</th><td>Learning setting saved by ${this.who(d.authority.delegated_by)} (revision ${d.authority.learning_policy_revision})</td></tr>
            <tr><th>From</th><td>${this.who(d.signals[0].author_id)}, ${d.signals[0].surface.replace(/_/g, " ")} (${d.signals[0].trust.replace("_", " ")}): ${text ? `"${text}"` : "(original wording deleted)"}</td></tr>
            <tr><th>Why safe</th><td>Exact check - this project only - adds a requirement</td></tr>
            <tr><th>Tested</th><td>Catches the corrected draft; ${d.evaluation.real_passing_cases.length} corrected version(s) pass; ${d.evaluation.heldout.pass} of ${d.evaluation.heldout.artifacts} other documents pass; no conflicts. Generated variants: ${d.evaluation.generated.run} (never counted as support). Model confidence used: no.</td></tr>
            ${d.candidate.widening_requested ? html`<tr><th>Also</th><td>A wider scope was asked for. Not automatic: sent to a person to decide.</td></tr>` : ""}
          </tbody></table>
          <a href="/rules/${rule.rule_id}?project=${projectId}">Details / Undo / Keep</a> - <a href="/projects/${projectId}/learning/timeline/${rule.rule_id}">Timeline</a></div>`;
      }) : empty("No rule has turned on without a click in this project.")}
      <h2>Considered and not turned on (${rest.length})</h2>
      ${rest.length ? html`<table><thead><tr><th>When</th><th>Outcome</th><th>Why</th></tr></thead><tbody>${rest.map((d) => html`<tr><td>${this.t(d.decided_at)}</td><td>${d.outcome.replace(/_/g, " ")}</td><td>${(d.reasons as string[]).map((r) => REASON_WORDS[r] ?? r).join("; ")}</td></tr>`)}</tbody></table>` : empty("Nothing else was considered.")}`;
    return { title: "Rules that turned on without a click", body, project: p };
  }

  learningTimeline(projectId: string, ruleId: string): Page {
    const p = this.app.projects.get(projectId);
    const rule = this.app.rules.get(ruleId);
    const words: Record<string, string> = { "learning.policy_set": "PERMITTED", "learning.signal_detected": "IDENTIFIED", "learning.correction_extracted": "COMPILED", "rule.candidate_created": "COMPILED", "learning.candidate_evaluated": "TESTED", "learning.decision_made": "DECIDED", "rule.activated": "ON", "rule.approved": "APPROVED", "rule.confirmed": "KEPT", "rule.retired": "RETIRED", "rule.auto_paused": "PAUSED", "run.completed": "TRIGGERED", "learning.inbox_item_opened": "ASKED" };
    const byRule = this.app.ledger.byRef("rule_id", ruleId);
    const signalEvents = (rule.origin.signal_ids ?? []).flatMap((s) => this.app.ledger.byRef("signal_id", s));
    const policyEvents = rule.authority?.learning_policy_id ? this.app.ledger.byRef("learning_policy_id", rule.authority.learning_policy_id).filter((e) => e.type === "learning.policy_set") : [];
    const triggered = (this.app.db.prepare("SELECT run_id FROM check_results WHERE rule_id = ? AND outcome = 'fail'").all(ruleId) as any[]).flatMap((r) => this.app.ledger.byRef("run_id", r.run_id).filter((e) => e.type === "run.completed"));
    const merged = [...new Map([...policyEvents, ...signalEvents, ...byRule, ...triggered].map((e) => [e.seq, e])).values()].sort((a, b) => a.seq - b.seq);
    const body = html`
      <p class="muted">Times: ${this.app.displayTz}. Each line is one ledger event, linked to its cause. "ON" is never followed by a change the product made.</p>
      <table class="timeline"><tbody>${merged.map((e) => html`<tr><td>${this.t(e.occurred_at)}</td><td class="word">${words[e.type] ?? e.type}</td><td>${e.summary}${e.refs.run_id ? html` <a href="/runs/${e.refs.run_id}">open check</a>` : ""}<div class="muted mono">${e.event_id}${e.caused_by.length ? ` - because of ${e.caused_by.join(", ")}` : ""}</div></td></tr>`)}</tbody></table>
      ${unavailable("the CAPTURED line with delivery details per message, and automatic pause", "Capture delivery is shown on the capture health screen.")}`;
    return { title: `Timeline of a rule: ${rule.title}`, body, project: p };
  }

  // ---------------------------------------------------------------- capture health (OBS-11)
  capture(projectId: string): Page {
    const p = this.app.projects.get(projectId);
    const streams = this.app.intake.streamsForProject(projectId);
    const adapters = this.app.intake.adapters();
    const policy = this.app.policies.current(projectId);
    const on = (surface: string): boolean => !!policy && policy.mode !== "off" && policy.surfaces.some((s) => s.surface === surface && s.enabled);
    const body = html`
      <p>${policy && policy.mode !== "off" ? "" : html`<strong>Learning is off for this project, so nothing is captured for learning.</strong> `}Labels are generated from the adapters actually paired and their live state.</p>
      <table><thead><tr><th>Surface</th><th>Status</th><th></th></tr></thead><tbody>
        <tr><td>This app</td><td><strong>${on("app") ? "CAPTURED" : "NOT CAPTURED"}</strong></td><td class="muted">${on("app") ? `can lead to: ${SURFACE_CEILING.app}` : "learning is off"}</td></tr>
        ${adapters.filter((a) => a.kind !== "app_native").map((a) => html`<tr><td>${a.label}${a.simulated ? label("SIMULATED") : ""}</td><td><strong>${a.revoked || !on("attested_user_turn") ? "NOT CAPTURED" : "CAPTURED"}</strong></td><td class="muted">${a.revoked ? "the adapter was revoked" : "durable outbox, acknowledgements, replay"}</td></tr>`)}
        <tr><td>Edits in this folder</td><td><strong>NOT CAPTURED</strong></td><td class="muted">folder watching is not available in this build</td></tr>
        <tr><td>Corrections an assistant passes on</td><td><strong>RELAYED</strong></td><td class="muted">best effort: depends on the assistant; always asks you</td></tr>
        <tr><td>Anything without an adapter (chat, email, calls)</td><td><strong>NOT CAPTURED</strong></td><td class="muted">not connected. Corrections made there are not seen. Add them in the app.</td></tr>
      </tbody></table>
      <h2>Streams (${streams.length})</h2>
      ${streams.length ? html`<table><thead><tr><th>Stream</th><th>Health</th><th>Received</th><th>Counts</th></tr></thead><tbody>${streams.map((s) => html`<tr>
        <td class="mono">${s.stream_id}<div class="muted">${s.status.replace("_", " ")} - opened ${this.t(s.opened_at)}</div></td>
        <td><strong>${s.health}</strong><div class="muted">${s.health_reason}</div></td>
        <td>acknowledged through ${s.acked_through}${s.final_seq !== null ? ` of ${s.final_seq}` : ""}; processed through ${s.processed_through}</td>
        <td>${s.duplicates_dropped} duplicate(s) dropped - ${s.held_out_of_order} held out of order - ${s.dead_letters.length} unreadable - ${s.consent_blocked} not kept (no consent)
          ${s.gaps.map((g) => html`<div class="${g.closed_at ? "muted" : ""}">Gap ${g.from_seq}-${g.to_seq}: ${g.closed_at ? `closed by replay ${this.t(g.closed_at)}; nothing lost` : "OPEN - corrections made then may not have been seen"}</div>`)}
          ${s.dead_letters.map((d) => html`<div>Event ${d.source_seq} could not be ${d.stage === "intake" ? "read" : "processed"}: ${d.reason} ${this.post(`/app/capture/${s.stream_id}/dead-letters/${d.source_seq}/discard`, "Discard", { back: `/projects/${projectId}/capture` })}</div>`)}
        </td></tr>`)}</tbody></table>` : empty("No capture stream has delivered events for this project.")}
      ${unavailable("Retry for unreadable events, and acknowledging a permanent gap", "Unreadable events can be discarded; retry after an update is Phase 2.")}`;
    return { title: `What is captured for learning: ${p.name}`, body, project: p };
  }

  // ---------------------------------------------------------------- coverage map (OBS-8)
  coverage(projectId: string): Page {
    const p = this.app.projects.get(projectId);
    const body = html`
      <p class="muted">Correction Layer only enforces where it actually sits in the path. Each action has exactly one label, generated from what is configured.</p>
      <table><thead><tr><th>Action</th><th>Label</th><th>Needs</th><th></th></tr></thead><tbody>${this.app.gateway.coverage(projectId).map((c) => html`<tr><td>${c.action.replace(/_/g, " ")}</td><td><strong>${c.label.replace("_", " ")}</strong>${c.qualifier ? `, ${c.qualifier.replace("_", " ")}` : ""}${c.simulated ? label("SIMULATED") : ""}</td><td>${c.needs.join(" + ").replace(/_/g, " ")}</td><td class="muted">${c.note}</td></tr>`)}</tbody></table>
      <h2>Requests</h2>
      ${(() => {
        const actions = this.app.gateway.listActions(projectId);
        return actions.length ? html`<table><tbody>${actions.map((a) => html`<tr><td>${this.t(a.requested_at)}</td><td>${a.type}</td><td>${a.status.replace(/_/g, " ")}</td><td><a href="/actions/${a.action_id}">open</a></td></tr>`)}</tbody></table>` : empty("No action has been requested.");
      })()}`;
    return { title: "Coverage map", body, project: p };
  }

  // ---------------------------------------------------------------- pre-action review (UX-8)
  action(actionId: string): Page {
    const a = this.app.gateway.getAction(actionId);
    const p = this.app.projects.get(a.project_id);
    const receipt = a.receipt_id ? this.app.gateway.getReceipt(a.receipt_id) : null;
    const run = receipt ? this.app.checks.getRun(receipt.run_id) : null;
    const adapter = this.app.gateway.adapterList().find((x) => x.capability.adapter_id === a.adapter_id);
    const back = `/actions/${actionId}`;
    const body = html`
      <div class="card"><strong>What the check decided:</strong> ${run ? html`${verdictBadge(run.verdict)} for version ${run.artifact.version_seq} of ${run.artifact.name} (<a href="/runs/${run.run_id}">open check</a>), ${run.results.length} rule(s) applied.` : "no check"}<br>
      <strong>What you are deciding:</strong> whether "${a.type.replace(/_/g, " ")}" should happen for exactly that version. A pass is not permission.</div>
      <table><tbody>
        <tr><th>Status</th><td><strong>${a.status.replace(/_/g, " ")}</strong>${a.status_reason ? ` - ${a.status_reason}` : ""}</td></tr>
        <tr><th>Route</th><td>${adapter?.capability.label ?? a.adapter_id}</td></tr>
        <tr><th>Exact version</th><td class="mono">${a.content_hash}</td></tr>
        <tr><th>Requested by</th><td>${this.who(a.requested_by)}, ${this.t(a.requested_at)}</td></tr>
        <tr><th>Approval</th><td>${a.approval ? `${this.who(a.approval.approved_by)}, ${this.t(a.approval.approved_at)}${a.approval.self_approval ? " (self-approval; one-person workspace)" : ""}, bound to this receipt, version, action and parameters` : a.approval_policy === "none_required" ? "none required, by a standing decision of a person" : "not yet given"}</td></tr>
        <tr><th>Receipt</th><td>${receipt ? `${receipt.status}; expires ${this.t(receipt.expires_at)}; grants permission: no` : "none"}</td></tr>
      </tbody></table>
      <p>
        ${a.status === "awaiting_approval" ? html`${this.post(`/app/actions/${actionId}/approve`, "Approve", { back }, true)} ${this.post(`/app/actions/${actionId}/reject`, "Reject", { back })}` : ""}
        ${a.status === "approved" ? this.post(`/app/actions/${actionId}/execute`, "Release now (SIMULATED)", { back }, true) : ""}
      </p>
      ${a.gate_checks.length ? html`<h2>What the gateway verified</h2><table><tbody>${a.gate_checks.map((g) => html`<tr><td>${g.step}</td><td>${g.check}</td><td><strong>${g.ok ? "holds" : "FAILED"}</strong>${g.detail ? ` - ${g.detail}` : ""}</td></tr>`)}</tbody></table>` : ""}
      ${a.execution ? html`<h2>Execution</h2><p>${a.execution.outcome ?? "in progress"}${a.execution.simulated ? " - SIMULATED: nothing left the workspace store" : ""} - ${this.t(a.execution.completed_at)}</p>` : ""}
      <h2>History</h2>${this.events(this.app.ledger.byRef("action_id", actionId))}`;
    return { title: `Before you ${a.type.replace(/_/g, " ")}`, body, project: p };
  }

  // ---------------------------------------------------------------- effectiveness (OBS-7) and history verification
  effectiveness(projectId: string): Page {
    const p = this.app.projects.get(projectId);
    const rules = this.app.rules.listForProject(projectId).filter((r) => r.status === "active" || r.status === "trial");
    const body = html`
      ${unavailable("the effectiveness view (OBS-7)", "The design places it after the MVP. Below are plain counts only: how often each rule was evaluated and with what result. They are not rates, not trends, and not evidence that any rule improved any work.")}
      ${rules.length ? html`<table><thead><tr><th>Rule</th><th>Evaluations by result</th></tr></thead><tbody>${rules.map((r) => {
        const counts = this.app.checks.ruleOutcomeCounts(r.rule_id);
        return html`<tr><td><a href="/rules/${r.rule_id}?project=${projectId}">${r.title}</a></td><td>${Object.keys(counts).length ? Object.entries(counts).map(([o, n]) => `${outcomeWord(o)}: ${n}`).join(" - ") : "never evaluated"}</td></tr>`;
      })}</tbody></table>` : empty("No rule is on in this project.")}`;
    return { title: "Effectiveness", body, project: p };
  }

  history(): Page {
    const v = this.app.ledger.verify();
    const body = html`
      <div class="card">${v.ok ? html`<strong>[OK] History verifies.</strong> ${v.events} event(s), hash-chained from the start of this workspace.` : html`<strong>[X] History does NOT verify.</strong> First problem at sequence ${v.first_bad_seq}: ${v.problem}.`}</div>
      <p><a href="/api/v1/ledger/export">Export the ledger (JSON, UTC times and sequence numbers)</a></p>
      ${unavailable("signed anchors, backup and restore, trace export per piece of work", "The hash chain is real and verified here; anchoring and backup are Phase 2.")}`;
    return { title: "History check", body };
  }

  /** OBS-6 in its simple list form: one correction followed through stored references. */
  correction(correctionId: string): Page {
    const events = this.app.ledger.byRef("correction_id", correctionId);
    const ruleId = events.find((e) => e.refs.rule_id)?.refs.rule_id as string | undefined;
    const all = [...new Map([...events, ...(ruleId ? this.app.ledger.byRef("rule_id", ruleId) : [])].map((e) => [e.seq, e])).values()].sort((a, b) => a.seq - b.seq);
    const projectId = all.find((e) => e.project_id)?.project_id ?? null;
    return { title: "Journey of a correction", body: html`${this.events(all)}${unavailable("the full journey with the runs it triggered, blocks, fixes and releases joined in one view (OBS-6)", "Follow the rule's timeline and each check's timeline for those hops.")}`, project: projectId ? this.app.projects.get(projectId) : null };
  }
}
