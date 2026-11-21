/**
 * First-run guidance: the home screen's three paths (Start new, Import existing,
 * Try a fictional demo), the guided start (`/start`) and import (`/import`).
 *
 * Every step reuses the existing services (projects, checks, authoring, CSV
 * import). Nothing here turns on learning, changes who may approve, or chooses a
 * release folder: those stay explicit acts on their own screens. Previews store
 * nothing; saving is a separate, token-checked form post.
 */
import type { App } from "../app.ts";
import type { Project } from "../context/projects.ts";
import { previewCsv } from "../context/projects.ts";
import { displayTime } from "../domain/time.ts";
import type { RunRecord } from "../domain/types.ts";
import { CURRENCIES } from "../policy/templates.ts";
import type { DocumentPreview } from "../work/onboarding.ts";
import { EXAMPLE_QUOTE, SUPPORTED_IMPORT, previewDocuments } from "../work/onboarding.ts";
import type { Page } from "./pages.ts";
import type { Safe } from "./html.ts";
import { empty, html, label, linkButton, nextStep, outcomeWord, postButton, stat, steps, verdictBadge } from "./html.ts";

export const NOT_SUPPORTED: ReadonlyArray<[string, string]> = Object.freeze([
  ["Word, Excel, PowerPoint (.docx, .xlsx, .pptx)", "Save documents as Markdown or plain text; export price lists as CSV."],
  ["PDF and scanned documents", "Copy the text into a .txt or .md file."],
  ["Another app's database or export", "Not importable. Bring in the documents themselves."],
  ["ChatGPT, Copilot, email, chat apps", "Not connected. Add corrections here in your own words, or with the command-line adapter."],
]);

const VERDICT_MEANING: Record<string, string> = {
  ready: "Every rule that must pass passed. Notes (rules on trial) never block. A pass is evidence, not permission: releasing is still a separate, approved act.",
  needs_changes: "At least one must-pass rule found a problem. Fix it in the tool you use, then check the new version. Correction Layer never edits your file.",
  could_not_verify: "Something could not be read or decided (for example no pricing table, a bare \"$\", or a missing trusted source). It is never treated as a pass.",
};

export class StartPages {
  private app: App;
  private csrf: string;

  constructor(app: App, csrf: string) {
    this.app = app;
    this.csrf = csrf;
  }

  private t(v: string | null | undefined): string {
    return v ? displayTime(v, this.app.displayTz) : "";
  }

  private token(): Safe {
    return html`<input type="hidden" name="_csrf" value="${this.csrf}">`;
  }

  private realProjects(): Project[] {
    return this.app.projects.list().filter((p) => !p.is_demo);
  }

  /** The three ways in. Shown on an empty workspace, on /onboarding, and (compact) under the project list. */
  private choices(compact = false): Safe {
    const empty = this.app.projects.list().length === 0;
    const H = compact ? "h3" : "h2";
    const heading = (t: string): Safe => (H === "h2" ? html`<h2>${t}</h2>` : html`<h3>${t}</h3>`);
    return html`<div class="choices">
      <div class="choice featured">${heading("Start new")}<p>Create a project, add one quote, optionally add a first rule, and see your first check explained. About five minutes.</p><div class="actions">${linkButton("/start", "Start new", "primary")}</div></div>
      <div class="choice">${heading("Import existing")}<p>Bring in quotes you already have (${SUPPORTED_IMPORT}) and price lists (CSV). You see a preview before anything is saved.</p><div class="actions">${linkButton("/import", "Import existing")}</div></div>
      <div class="choice demo-choice">${heading("Try a fictional demo")}<p>Look around with made-up projects, people and quotes, all labelled DEMO.</p><div class="actions">${empty
        ? postButton(this.csrf, "/app/demo", "Load the fictional demo")
        : html`<span class="muted">Only in an empty workspace, so demo and real work never mix. To try it, start a separate copy: <span class="mono">CL_DATA_DIR=./demo-data CL_SEED_DEMO=1 npm run dev</span></span>`}</div></div>
    </div>`;
  }

  // ---------------------------------------------------------------- home
  home(): Page {
    const all = this.app.projects.list();
    const real = all.filter((p) => !p.is_demo);
    const demo = all.filter((p) => p.is_demo);
    const card = (p: Project): Safe => {
      const docs = this.app.checks.latestVersions(p.project_id).length;
      const rules = this.app.rules.selectInScope({ project_id: p.project_id, area_ids: [], artifact_id: null, work_type: p.default_work_type, artifact_type: "document", action: "release" }).rules.length;
      const asks = this.app.learning.inbox(p.project_id).length;
      return html`<div class="choice ${p.is_demo ? "demo-choice" : ""}"><h3><a href="/projects/${p.project_id}">${p.name}</a>${p.is_demo ? label("DEMO", "demo-label") : ""}</h3>
        <p>Sales proposals${p.facts.customer_name ? ` - customer ${p.facts.customer_name}` : ""}</p>
        <p>${docs} document(s) - ${rules} rule(s) apply${asks ? html` - <a href="/projects/${p.project_id}/learning"><strong>${asks} need${asks === 1 ? "s" : ""} you</strong></a>` : ""}</p>
        ${!p.is_demo && docs === 0 ? html`<div class="actions">${linkButton(`/start?project=${p.project_id}`, "Continue setting up", "primary")}</div>` : ""}</div>`;
    };
    const unbound = this.app.learning.inbox(null);
    if (!all.length) {
      const body = html`
        <p class="lead">Turn the corrections you give once into checks that run every time a quote is checked. Choose how to begin.</p>
        ${this.choices()}
        <p class="muted">Everything stays on this computer. Nothing is sent or paid, and no AI model is used.</p>`;
      return { title: "Welcome to Correction Layer", body };
    }
    const body = html`
      ${real.length ? html`<h2>Your projects</h2><div class="choices">${real.map(card)}</div>` : html`<div class="empty">You have no projects of your own yet. Start new or import existing work below.</div>`}
      ${demo.length ? html`<h2>Fictional demo <span class="muted">(not your work)</span></h2><div class="choices">${demo.map(card)}</div>` : ""}
      ${unbound.length ? html`<h2>Needs you (not tied to a project)</h2>${unbound.map((i) => html`<div class="card">${i.question} <div class="muted">${this.t(i.opened_at)}</div>${postButton(this.csrf, `/app/inbox/${i.inbox_id}/resolve`, "Dismiss", { resolution: "dismissed", back: "/" })}</div>`)}` : ""}
      <h2>Start something else</h2>
      ${this.choices(true)}`;
    return { title: "All projects", body };
  }

  onboarding(): Page {
    const body = html`<p class="lead">Three ways in. You can come back here any time from "Start new" or "Import existing" in the menu.</p>${this.choices()}`;
    return { title: "Get started", body };
  }

  // ---------------------------------------------------------------- guided start
  start(q: Record<string, string>): Page {
    const project = q.project ? this.realProjects().find((p) => p.project_id === q.project) ?? null : null;
    const docs = project ? this.app.checks.latestVersions(project.project_id) : [];
    const rules = project ? this.app.rules.listForProject(project.project_id).filter((r) => r.scope.project_id === project.project_id && r.status !== "rejected" && r.status !== "retired") : [];
    const run = q.run && project ? this.app.checks.listRuns({ project_id: project.project_id, limit: 500 }).find((r) => r.run_id === q.run) ?? null : null;
    const policy = project ? this.app.policies.current(project.project_id) : null;
    const step = !project ? 1 : !docs.length ? 2 : run ? 5 : q.step === "check" ? 4 : 3;
    const state = (n: number): "done" | "current" | "todo" => (n < step ? "done" : n === step ? "current" : "todo");
    const progress = steps([
      { label: "Create the project", state: state(1) },
      { label: "Add your first document", state: state(2) },
      { label: "Add a first rule", state: rules.length && step > 3 ? "done" : state(3), optional: true },
      { label: "Run the first check", state: run ? "done" : state(4) },
      { label: "Learning", state: policy && policy.mode !== "off" ? "done" : "todo", optional: true },
    ]);
    const title = "Start new";
    if (q.project && !project) {
      return { title, body: html`${progress}<div class="card error" role="alert">That project is not one of your own projects (DEMO projects cannot be set up here). <a href="/start">Start a new project</a>.</div>` };
    }
    if (!project) {
      const unfinished = this.realProjects().filter((p) => !this.app.checks.latestVersions(p.project_id).length);
      const body = html`${progress}
        <p class="lead">Step 1: a project holds one customer's or one deal's quotes, and the rules that apply to them.</p>
        <form method="post" action="/app/start/project" class="card">${this.token()}
          <label>Project name <input type="text" name="name" required maxlength="120" placeholder="Kestrel Dental - 2027 supply"></label>
          <label>Customer name <span class="muted">(optional; you confirm it, nothing is read from files)</span> <input type="text" name="customer_name" maxlength="120"></label>
          <label>Folder on this computer where the quotes live <span class="muted">(optional; only remembered, never watched or written to)</span> <input type="text" name="folder" maxlength="500"></label>
          <p class="muted">Kind of work: sales proposals (the only kind this build reads). Learning stays off and releases stay simulated until you change them yourself.</p>
          <div class="actions"><button class="primary" type="submit">Create project and continue</button> <a href="/import">Import existing work instead</a></div>
        </form>
        ${unfinished.length ? html`<h2>Or continue setting up</h2><ul class="list-plain">${unfinished.map((p) => html`<li><a href="/start?project=${p.project_id}">${p.name}</a> <span class="muted">- no documents yet</span></li>`)}</ul>` : ""}`;
      return { title, body };
    }
    if (step === 2) {
      const body = html`${progress}
        <p class="lead">Step 2: add one quote to <strong>${project.name}</strong>. Supported: ${SUPPORTED_IMPORT}.</p>
        <form method="post" action="/app/start/document" enctype="multipart/form-data" class="card">${this.token()}<input type="hidden" name="project_id" value="${project.project_id}">
          <label>Upload a file <input type="file" name="file" accept=".md,.markdown,.txt,text/plain,text/markdown"></label>
          <p class="muted">Or paste it:</p>
          <label>File name <input type="text" name="name" value="Quote.md" maxlength="200"></label>
          <label>Content <textarea name="content" placeholder="# Quote ..."></textarea></label>
          <div class="actions"><button class="primary" type="submit">Add document</button></div>
        </form>
        <details><summary>What layout does this build read?</summary>
          <p>Labelled lines (Customer, Quote reference, Valid until) and one pricing table with Item, Qty, Unit price and Amount columns, amounts written with a currency code (SGD 1,650.00). A fictional example you can paste and edit:</p>
          <pre class="mono">${EXAMPLE_QUOTE}</pre>
        </details>
        <p class="muted">Word, Excel and PDF files are refused with an explanation, not read. Nothing is overwritten: the same name again becomes version 2.</p>`;
      return { title, body, project };
    }
    const latest = docs[0]!;
    if (step === 3) {
      const preview = this.understood(project, latest.artifact_id, latest.name, latest.content_hash);
      const quick = (template: string, text: string, fields: Safe = html``): Safe => html`<form method="post" action="/app/start/rule" class="card">${this.token()}<input type="hidden" name="project_id" value="${project.project_id}"><input type="hidden" name="template" value="${template}"><strong>${text}</strong>${fields}<div class="actions"><button type="submit">Add this rule</button></div></form>`;
      const body = html`${progress}
        <h2>What we read in ${latest.name}</h2>${preview}
        <p class="lead">Step 3 (optional): add a rule this project's quotes must meet. It starts as a <strong>note</strong> (shown, never blocking); you can make it must-pass later on its page, once you have one quote it catches and one it allows.</p>
        ${rules.length ? html`<div class="card"><strong>Rules in this project:</strong><ul class="list-plain">${rules.map((r) => html`<li><a href="/rules/${r.rule_id}?project=${project.project_id}">${r.statement}</a> ${label(r.status === "trial" ? "note" : r.status === "active" ? "on" : r.status)}</li>`)}</ul></div>` : ""}
        <h3>Say it in one sentence</h3>
        <form method="post" action="/app/start/rule" class="card">${this.token()}<input type="hidden" name="project_id" value="${project.project_id}">
          <label>Your rule <input type="text" name="sentence" maxlength="300" placeholder="Quotes for this customer must always be in SGD."></label>
          <p class="muted">Understood patterns only: a currency ("... in SGD"), a required value ("always include the quote reference"), a validity period ("valid for at least 30 days"), "totals must add up", "no TBD placeholders", or a quoted phrase or section heading ('always include "Prices exclude GST"'). Anything else is refused with the reason; nothing is guessed.</p>
          <div class="actions"><button type="submit">Add this rule</button></div>
        </form>
        <h3>Or pick one</h3>
        <div class="choices">
          ${quick("currency", "All amounts in one currency", html`<label>Currency <select name="currency">${CURRENCIES.map((c) => html`<option value="${c}">${c}</option>`)}</select></label>`)}
          ${quick("required_field", "The quote reference must be stated", html`<input type="hidden" name="field" value="quote.reference">`)}
          ${quick("totals_add_up", "Line amounts and the total add up")}
          ${quick("no_placeholders", "No TBD / TODO placeholders left")}
        </div>
        <p><a href="/projects/${project.project_id}/rules/new">More options in the full rule editor</a></p>
        ${nextStep(rules.length ? "Run the first check" : "Skip for now and run the first check", "The check applies every rule in scope to your document and explains the result.", linkButton(`/start?project=${project.project_id}&step=check`, "Continue to the check", "primary"))}`;
      return { title, body, project };
    }
    if (step === 4) {
      const body = html`${progress}
        <p class="lead">Step 4: check a document. ${rules.length} rule(s) of this project will be applied, plus any workspace rules.</p>
        <form method="post" action="/app/start/check" class="card">${this.token()}<input type="hidden" name="project_id" value="${project.project_id}">
          <label>Document <select name="artifact_id">${docs.map((d) => html`<option value="${d.artifact_id}">${d.name} (version ${d.version_seq})</option>`)}</select></label>
          <div class="actions"><button class="primary" type="submit">Run the check</button></div>
        </form>
        <p class="muted">A check finds problems; it never changes your file, approves or sends anything.</p>`;
      return { title, body, project };
    }
    // step 5: the result, explained
    const r = run as RunRecord;
    const counts = r.counts;
    const body = html`${progress}
      <div class="card"><p>${verdictBadge(r.verdict)} <strong>${r.artifact.name}</strong>, version ${r.artifact.version_seq}</p><p>${VERDICT_MEANING[r.verdict]}</p>
        <div class="stats">${stat(counts.in_scope, "rules applied")}${stat(counts.pass, "passed")}${stat(counts.fail, "need changes")}${stat(counts.unknown + counts.error + counts.conflict, "couldn't verify")}${stat(counts.notes, "notes")}</div></div>
      ${r.results.length ? html`<table><thead><tr><th scope="col">Rule</th><th scope="col">Result</th><th scope="col">Why</th></tr></thead><tbody>${r.results.map((x) => html`<tr><td>${x.title}${x.effective_enforcement === "warn" ? label("note") : ""}</td><td><strong>${outcomeWord(x.outcome)}</strong></td><td>${x.reason}${x.findings.slice(0, 3).map((f) => html`<div class="muted">${f.location.label}: ${f.message}</div>`)}</td></tr>`)}</tbody></table>`
        : html`<div class="empty">No rule applies yet, so there was nothing to check against. Add a rule, then check again.</div>`}
      ${r.coverage_gaps.length ? html`<div class="card" role="note">Parts that could not be read: ${r.coverage_gaps.map((g) => g.component.replace(/_/g, " ")).join(", ")}.</div>` : ""}
      ${nextStep("You have run your first check", html`What to do next depends on the result. ${r.verdict === "needs_changes" ? "Fix the quote in your own tool, then add the new version: it is checked again and you can compare the two." : ""}`, html`
        ${linkButton(`/runs/${r.run_id}`, "Open the full check", "primary")}
        ${linkButton(`/projects/${project.project_id}`, "Go to the project")}
        ${linkButton(`/start?project=${project.project_id}`, "Add another rule")}
        ${linkButton("/import", "Import more quotes or a price list")}`)}
      <section class="card" aria-labelledby="learn"><h2 id="learn">Optional, later: learning</h2>
        <p>Learning is <strong>${policy && policy.mode !== "off" ? `on (${policy.mode.replace(/_/g, " ")})` : "off"}</strong> for this project. If you switch it on, corrections you type in this app can become rules for this project only, within limits you choose. It never turns on by itself.</p>
        <p><a href="/projects/${project.project_id}/learning/settings">Review learning settings</a></p></section>`;
    return { title, body, project };
  }

  /** What the reader understood in one stored version (re-read from the stored bytes; stores nothing). */
  private understood(project: Project, artifactId: string, name: string, hash: string): Safe {
    const bytes = (this.app.db.prepare("SELECT bytes FROM blobs WHERE content_hash = ?").get(hash) as { bytes: Uint8Array } | undefined)?.bytes;
    if (!bytes) return empty("The stored bytes are no longer available.");
    const [p] = previewDocuments(this.app, project.project_id, [{ name, bytes: new Uint8Array(bytes) }]);
    void artifactId;
    return this.previewCard(p!);
  }

  private previewCard(p: DocumentPreview, onExisting: string = "new_version"): Safe {
    const outcome = !p.importable ? html`<span class="status-bad"><strong>Not imported</strong></span>`
      : p.outcome === "unchanged" ? html`Identical to version ${p.existing!.identical_to}: nothing will change.`
      : p.outcome === "new_version" ? (onExisting === "keep_both" ? html`A document with this name exists. It will be saved under a new name; the existing one is untouched.` : html`A document with this name exists: this becomes <strong>version ${p.existing!.latest_seq + 1}</strong>. Earlier versions are kept.`)
      : html`New document.`;
    return html`<div class="card"><p><strong>${p.name}</strong> <span class="muted">${p.size} bytes, ${p.detected_type}</span> - ${p.importable ? html`<span class="status-ok">[OK] readable</span>` : html`<span class="status-bad">[X] Couldn't verify: not supported</span>`}</p>
      ${p.problem ? html`<p>${p.problem}</p>` : ""}
      ${p.understood.length || p.line_items ? html`<table><tbody>${p.understood.map((u) => html`<tr><th scope="row">${u.what}</th><td class="mono">${u.value}</td></tr>`)}<tr><th scope="row">Pricing table lines</th><td>${p.line_items}</td></tr></tbody></table>` : p.importable ? html`<p class="muted">No labelled values were found.</p>` : ""}
      ${p.warnings.length ? html`<ul>${p.warnings.map((w) => html`<li>${w}</li>`)}</ul>` : ""}
      <p class="muted">${outcome}</p></div>`;
  }

  // ---------------------------------------------------------------- import
  importHub(q: Record<string, string>): Page {
    const real = this.realProjects();
    const sources = this.app.projects.listSources();
    const projectSelect = html`<fieldset><legend>Into which project?</legend>
      ${real.map((p, i) => html`<label><input type="radio" name="project_id" value="${p.project_id}" ${(q.project ? q.project === p.project_id : i === 0) ? html`checked` : ""}> ${p.name}</label>`)}
      <label><input type="radio" name="project_id" value="new" ${real.length ? "" : html`checked`}> A new project named <input type="text" name="new_project_name" maxlength="120" placeholder="Project name"></label>
      <p class="muted">DEMO projects are not offered: demo and real work never mix.</p></fieldset>`;
    const body = html`
      <p class="lead">Bring in work you already have. You see what this build understood before anything is saved, and nothing existing is ever replaced.</p>
      <section class="card" aria-labelledby="docs"><h2 id="docs">Quotes and proposals</h2>
        <p>Supported: <strong>${SUPPORTED_IMPORT}</strong>, up to 20 files of 5 MB at a time.</p>
        <form method="post" action="/app/import/documents/preview" enctype="multipart/form-data">${this.token()}
          ${projectSelect}
          <label>Files <input type="file" name="files" multiple accept=".md,.markdown,.txt,text/plain,text/markdown"></label>
          <details><summary>Or paste one document</summary><label>File name <input type="text" name="paste_name" value="Pasted-Quote.md" maxlength="200"></label><label>Content <textarea name="paste_content"></textarea></label></details>
          <fieldset><legend>If a document with the same name already exists</legend>
            <label><input type="radio" name="on_existing" value="new_version" checked> Add it as a new version (earlier versions are kept)</label>
            <label><input type="radio" name="on_existing" value="keep_both"> Keep both: save it under a new name such as "Quote (2).md"</label></fieldset>
          <div class="actions"><button class="primary" type="submit">Preview</button></div>
        </form></section>
      <section class="card" aria-labelledby="sources"><h2 id="sources">Price lists and other trusted sources (CSV)</h2>
        <p>A trusted source is a list you vouch for, such as a price list. Rules can compare quotes against it. Export spreadsheets as CSV first.</p>
        <form method="post" action="/app/import/source/preview" enctype="multipart/form-data">${this.token()}
          <fieldset><legend>Which source?</legend>
            ${sources.map((s, i) => html`<label><input type="radio" name="source_id" value="${s.source_id}" ${i === 0 ? html`checked` : ""}> A new version of ${s.name}</label>`)}
            <label><input type="radio" name="source_id" value="new" ${sources.length ? "" : html`checked`}> A new source</label>
            <div class="muted">For a new source:</div>
            <label>Name <input type="text" name="name" maxlength="120" placeholder="Price list 2027"></label>
            <label>Key column(s), comma-separated <input type="text" name="key_columns" value="item_code"></label>
            <label>Value column(s), comma-separated <input type="text" name="value_columns" value="unit_price"></label>
            <label>Must be re-confirmed within (days) <input type="number" name="max_age_days" min="1" max="365" value="30"></label></fieldset>
          <label>CSV file <input type="file" name="file" accept=".csv,text/csv"></label>
          <details><summary>Or paste CSV</summary><label>CSV <textarea name="csv"></textarea></label></details>
          <div class="actions"><button class="primary" type="submit">Preview</button></div>
        </form></section>
      <section aria-labelledby="unsupported"><h2 id="unsupported">Not supported, and what to do instead</h2>
        <table><tbody>${NOT_SUPPORTED.map(([what, instead]) => html`<tr><th scope="row">${what}</th><td>${instead}</td></tr>`)}</tbody></table></section>`;
    return { title: "Import existing", body };
  }

  documentsPreview(o: { target: { project_id: string | null; new_name: string | null }; onExisting: "new_version" | "keep_both"; files: Array<{ name: string; bytes: Uint8Array }> }): Page {
    const previews = previewDocuments(this.app, o.target.project_id, o.files);
    const ok = previews.filter((p) => p.importable && p.outcome !== "unchanged");
    const into = o.target.project_id ? this.app.projects.get(o.target.project_id).name : `a new project "${o.target.new_name}"`;
    const body = html`
      <p class="lead">Nothing has been saved yet. This is what this build understood, file by file, and what importing into ${into} would do.</p>
      ${previews.map((p) => this.previewCard(p, o.onExisting))}
      ${ok.length ? html`<form method="post" action="/app/import/documents" class="card">${this.token()}
          <input type="hidden" name="project_id" value="${o.target.project_id ?? "new"}"><input type="hidden" name="new_project_name" value="${o.target.new_name ?? ""}"><input type="hidden" name="on_existing" value="${o.onExisting}">
          ${ok.map((p) => html`<input type="hidden" name="doc_name" value="${p.name}"><input type="hidden" name="doc_hash" value="${p.hash}"><input type="hidden" name="doc_b64" value="${Buffer.from(o.files[previews.indexOf(p)]!.bytes).toString("base64")}">`)}
          <p><strong>Import ${ok.length} document(s)</strong>${previews.length > ok.length ? html` <span class="muted">(${previews.length - ok.length} will be left out, as shown above)</span>` : ""}. They are stored as versions; they are not checked until you ask.</p>
          <div class="actions"><button class="primary" type="submit">Import ${ok.length} document(s)</button> <a href="/import">Cancel</a></div></form>`
        : html`<div class="card error" role="alert">There is nothing to import: ${previews.every((p) => p.outcome === "unchanged") ? "every file is identical to a version already stored." : "no file can be read by this build."} <a href="/import">Back to import</a></div>`}`;
    return { title: "Preview: import documents", body };
  }

  sourcePreview(o: { source_id: string | null; draft: { name: string; key_columns: string[]; value_columns: string[]; max_age_days: number } | null; file_name: string; text: string }): Page {
    const record = o.source_id ? this.app.projects.sourceRecord(o.source_id) : o.draft!;
    const p = previewCsv(record, o.text);
    const columns = [...record.key_columns, ...record.value_columns];
    const body = html`
      <p class="lead">Nothing has been saved yet. ${o.source_id ? html`This would become the new version of <strong>${record.name}</strong>; the current version is kept in history.` : html`This would register a new trusted source <strong>${record.name}</strong>, vouched for by you.`}</p>
      ${p.problems.length ? html`<div class="card error" role="alert"><strong>This file cannot be imported:</strong><ul>${p.problems.map((x) => html`<li>${x}</li>`)}</ul><a href="/import#sources">Back to import</a></div>` : html`
        <div class="stats">${stat(p.rows_read, "rows read")}${stat(p.rows.length, "will be imported")}${stat(p.rejected.length, "left out")}</div>
        ${p.rejected.length ? html`<table><caption>Rows left out (never read as zero or blank)</caption><thead><tr><th scope="col">Row</th><th scope="col">Why</th></tr></thead><tbody>${p.rejected.map((r) => html`<tr><td>${r.row}</td><td>${r.reason}</td></tr>`)}</tbody></table>` : ""}
        ${p.rows.length ? html`<table><caption>First rows that will be imported</caption><thead><tr><th scope="col">Row</th>${columns.map((c) => html`<th scope="col">${c}</th>`)}</tr></thead><tbody>${p.rows.slice(0, 20).map((r) => html`<tr><td>${r.row}</td>${columns.map((c) => html`<td class="mono">${r.key[c] ?? r.values[c] ?? ""}</td>`)}</tr>`)}</tbody></table>` : ""}
        ${p.rows.length ? html`<form method="post" action="/app/import/source" class="card">${this.token()}
            <input type="hidden" name="source_id" value="${o.source_id ?? "new"}"><input type="hidden" name="file_name" value="${o.file_name}"><input type="hidden" name="csv_b64" value="${Buffer.from(o.text, "utf8").toString("base64")}">
            ${o.draft ? html`<input type="hidden" name="name" value="${o.draft.name}"><input type="hidden" name="key_columns" value="${o.draft.key_columns.join(",")}"><input type="hidden" name="value_columns" value="${o.draft.value_columns.join(",")}"><input type="hidden" name="max_age_days" value="${String(o.draft.max_age_days)}">` : ""}
            <div class="actions"><button class="primary" type="submit">Import ${p.rows.length} row(s)</button> <a href="/import#sources">Cancel</a></div></form>`
          : html`<div class="card error" role="alert">No row can be used, so nothing would be imported. <a href="/import#sources">Back to import</a></div>`}`}`;
    return { title: "Preview: import a trusted source", body };
  }
}
