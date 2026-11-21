/**
 * Phase 2 screens: project settings, a trusted source, the correction editor
 * (UX-7a to 7c), re-run as recorded (OBS-4), a proposed change, and the journey of
 * a correction (OBS-6). Server-rendered forms only; every act posts to /app/* with
 * the form token. No client-side script.
 */
import type { App } from "../app.ts";
import { ClError, ValidationError } from "../domain/errors.ts";
import { displayTime } from "../domain/time.ts";
import type { Rule } from "../domain/types.ts";
import type { DraftInput, Preview } from "../policy/authoring.ts";
import type { TemplateId } from "../policy/templates.ts";
import { CURRENCIES, FIELD_DICTIONARY, TEMPLATES } from "../policy/templates.ts";
import type { ContentDiffResult } from "../work/diff.ts";
import { JOURNEY_WORDS, correctionJourney } from "../work/journey.ts";
import type { Page } from "./pages.ts";
import type { Safe } from "./html.ts";
import { empty, html, label, outcomeWord, postButton, unavailable, verdictBadge } from "./html.ts";

/** The plain fields for one template, pre-filled. Shared by the editor and the rule's "Change" form. */
export function templateFields(app: App, template: TemplateId, values: Record<string, unknown>): Safe {
  const v = (k: string): string => (values[k] === undefined || values[k] === null ? "" : String(values[k]));
  switch (template) {
    case "currency":
      return html`<label>Currency <select name="currency">${CURRENCIES.map((c) => html`<option value="${c}" ${v("currency") === c ? html`selected` : ""}>${c}</option>`)}</select></label>`;
    case "required_field":
      return html`<label>Value that must be stated <select name="field">${Object.entries(FIELD_DICTIONARY).map(([k, d]) => html`<option value="${k}" ${v("field") === k ? html`selected` : ""}>${d.label}</option>`)}</select></label>`;
    case "required_phrase":
    case "forbidden_phrase":
      return html`<label>Exact phrase <input type="text" name="phrase" value="${v("phrase")}" maxlength="200" required></label>`;
    case "required_section":
      return html`<label>Section heading <input type="text" name="heading" value="${v("heading")}" maxlength="120" required></label>`;
    case "validity_window":
      return html`<label>Minimum days between the check and the valid-until date <input type="number" name="min_days" min="1" max="365" value="${v("min_days") || "30"}" required></label>`;
    case "price_matches_source": {
      const sources = app.projects.listSources();
      if (!sources.length) return html`<p class="empty">No trusted source is registered yet. Register a price list in Project settings first.</p>`;
      return html`<label>Trusted price list <select name="source_id">${sources.map((s) => html`<option value="${s.source_id}" ${v("source_id") === s.source_id ? html`selected` : ""}>${s.name}</option>`)}</select></label>
        <label>Column that holds the item code <input type="text" name="key_column" value="${v("key_column") || "item_code"}" required></label>
        <label>Column that holds the unit price <input type="text" name="value_column" value="${v("value_column") || "unit_price"}" required></label>
        <label>The list must have been confirmed within (days) <input type="number" name="max_age_days" min="1" max="365" value="${v("max_age_days") || "30"}"></label>`;
    }
    default:
      return html`<p class="muted">Nothing else to fill in.</p>`;
  }
}

const TEMPLATE_KEYS = ["currency", "field", "phrase", "heading", "min_days", "source_id", "key_column", "value_column", "max_age_days"];
export function templateValues(query: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(TEMPLATE_KEYS.filter((k) => query[k] !== undefined && query[k] !== "").map((k) => [k, query[k]]));
}

export function diffTable(diff: ContentDiffResult, t: (s: string) => string = (s) => s): Safe {
  void t;
  if (!diff.available) return unavailable("the content comparison for these two versions", diff.reason);
  return html`
    ${diff.passages.length ? html`<table><caption>Changed passages (${diff.passages.length}); ${diff.unchanged_passages} unchanged</caption><thead><tr><th scope="col">Where</th><th scope="col">Before</th><th scope="col">After</th><th scope="col">Findings</th></tr></thead><tbody>${diff.passages.map((p) => html`<tr>
      <td>${(p.after ?? p.before)!.label}<div class="muted">${p.kind}</div></td>
      <td>${p.before ? html`<del class="mono">${p.before.text}</del>` : html`<span class="muted">(not there)</span>`}</td>
      <td>${p.after ? html`<ins class="mono">${p.after.text}</ins>` : html`<span class="muted">(removed)</span>`}</td>
      <td>${p.resolved.length ? html`<div>${p.resolved.length} resolved</div>` : ""}${p.introduced.length ? html`<div><strong>${p.introduced.length} introduced</strong></div>` : ""}</td></tr>`)}</tbody></table>` : empty("No passage changed.")}
    ${diff.fields.length ? html`<table><caption>Values read from the document that changed</caption><thead><tr><th scope="col">Value</th><th scope="col">Before</th><th scope="col">After</th></tr></thead><tbody>${diff.fields.map((f) => html`<tr><td>${f.label}<div class="mono muted">${f.path}</div></td><td class="mono">${f.before ?? "(none)"}</td><td class="mono">${f.after ?? "(none)"}</td></tr>`)}</tbody></table>` : ""}
    ${diff.unread.length ? html`<div class="card" role="note"><strong>Parts not read:</strong> ${diff.unread.map((u) => `${u.component.replace(/_/g, " ")} (${u.side === "both" ? "both versions" : `${u.side} version`})`).join("; ")}. Changes there, if any, are present but not shown.</div>` : ""}`;
}

export class ManagePages {
  private app: App;
  private csrf: string;

  constructor(app: App, csrf: string) {
    this.app = app;
    this.csrf = csrf;
  }

  private t(value: string | null | undefined): string {
    return value ? displayTime(value, this.app.displayTz) : "";
  }

  private post(action: string, button: string, fields: Record<string, string> = {}, primary = false): Safe {
    return postButton(this.csrf, action, button, fields, primary);
  }

  private token(): Safe {
    return html`<input type="hidden" name="_csrf" value="${this.csrf}">`;
  }

  // ---------------------------------------------------------------- project settings
  projectSettings(projectId: string): Page {
    const p = this.app.projects.get(projectId);
    const release = this.app.gateway.releaseFolder(projectId);
    const sources = this.app.projects.listSources();
    const body = html`
      <section aria-labelledby="facts"><h2 id="facts">Project facts</h2>
        <p class="muted">Facts are confirmed by you, never read from documents. Changing one advances the rules revision, so outstanding receipts in this project need a fresh check.</p>
        ${Object.keys(p.facts).length ? html`<table><tbody>${Object.entries(p.facts).map(([k, v]) => html`<tr><th scope="row" class="mono">${k}</th><td>${v}</td></tr>`)}</tbody></table>` : empty("No facts confirmed yet.")}
        <form method="post" action="/app/projects/${projectId}/facts">${this.token()}
          <label>Fact <select name="key"><option value="customer_name">customer name</option><option value="customer_id">customer id</option><option value="region">region</option><option value="currency">currency</option></select></label>
          <label>Value <input type="text" name="value" required maxlength="200"></label>
          <button type="submit">Confirm fact</button>
        </form>
      </section>
      <section aria-labelledby="folders"><h2 id="folders">Folders</h2>
        ${p.folders.length ? html`<ul>${p.folders.map((f) => html`<li class="mono">${f.path}</li>`)}</ul>` : empty("No folder is connected.")}
        <form method="post" action="/app/projects/${projectId}/folders">${this.token()}
          <label>Connect another folder (its full path on this computer) <input type="text" name="folder" required></label>
          <button type="submit">Connect folder</button>
        </form>
        <p class="muted">The folder is recorded in the workspace store only. No marker file is written and folders are not watched in this build.</p>
      </section>
      <section aria-labelledby="release"><h2 id="release">Where "release" goes</h2>
        <p>${release ? html`Releases copy exactly the checked bytes to <span class="mono">${release.folder}</span> (chosen by ${this.app.projects.displayName(release.set_by)}, ${this.t(release.set_at)}). A file of the same name is never overwritten.` : html`Releases are <strong>SIMULATED</strong>: recorded, nothing is copied.`}</p>
        <form method="post" action="/app/projects/${projectId}/release-folder">${this.token()}
          <label>Release folder (an existing folder on this computer; leave empty to go back to simulated) <input type="text" name="folder" value="${release?.folder ?? ""}"></label>
          <label>Approval before release <select name="approval"><option value="self">A person approves each release (you, in this one-person workspace)</option><option value="none_required">No approval needed (a person still starts each release)</option></select></label>
          <button type="submit">Save</button>
        </form>
        <p class="muted">Send and pay do not exist in this build. Copying a file by hand is not seen or blocked.</p>
      </section>
      <section aria-labelledby="sources"><h2 id="sources">Trusted sources</h2>
        ${sources.length ? html`<table><thead><tr><th scope="col">Source</th><th scope="col">Latest version</th></tr></thead><tbody>${sources.map((s) => html`<tr><td><a href="/sources/${s.source_id}">${s.name}</a></td><td>${s.latest ? `${s.latest.rows.length} rows, imported ${this.t(s.latest.imported_at)}` : "nothing imported yet"}</td></tr>`)}</tbody></table>` : empty("No trusted source is registered.")}
        <details><summary>Register a trusted source (for example a price list)</summary>
          <form method="post" action="/app/projects/${projectId}/sources">${this.token()}
            <label>Name <input type="text" name="name" required maxlength="120"></label>
            <label>Key column(s), comma-separated <input type="text" name="key_columns" value="item_code" required></label>
            <label>Value column(s), comma-separated <input type="text" name="value_columns" value="unit_price" required></label>
            <label>Must be re-confirmed within (days) <input type="number" name="max_age_days" min="1" max="365" value="30"></label>
            <button type="submit">Register</button>
          </form>
          <p class="muted">You vouch for the list by registering it. Sources are workspace-wide in this build.</p>
        </details>
      </section>
      <p><a href="/projects/${projectId}/learning/settings">Learning settings</a> - <a href="/projects/${projectId}/capture">Capture health</a></p>`;
    return { title: `Settings: ${p.name}`, body, project: p };
  }

  // ---------------------------------------------------------------- trusted source
  source(sourceId: string, back: string | null): Page {
    const s = this.app.projects.sourceRecord(sourceId);
    const latest = this.app.projects.latestSnapshot(sourceId);
    const report = latest ? this.app.projects.importReport(latest.snapshot_id) : null;
    const columns = [...s.key_columns, ...s.value_columns];
    const body = html`
      <p>Vouched for by ${this.app.projects.displayName(s.owner)}. Key: <span class="mono">${s.key_columns.join(", ")}</span>; values: <span class="mono">${s.value_columns.join(", ")}</span>; must be re-confirmed within ${s.max_age_days} days.</p>
      <h2>Import a new version (CSV)</h2>
      <form method="post" action="/app/sources/${sourceId}/import" enctype="multipart/form-data">${this.token()}${back ? html`<input type="hidden" name="back" value="${back}">` : ""}
        <label>CSV file <input type="file" name="file" accept=".csv,text/csv"></label>
        <label>Or paste CSV (first row: column names, including ${columns.join(", ")}) <textarea name="csv"></textarea></label>
        <button class="primary" type="submit">Import</button>
      </form>
      <p class="muted">Rows with a formula and no computed value, an empty value, a key that appears twice or the wrong number of cells are reported and left out; they are never read as zero. Excel (XLSX) files cannot be read in this build: export the sheet as CSV.</p>
      ${report ? html`<h2>Last import: ${report.file_name}</h2><p>${report.rows_imported} of ${report.rows_read} row(s) imported.</p>${report.rejected.length ? html`<table><caption>Rows not used</caption><thead><tr><th scope="col">Row</th><th scope="col">Why</th></tr></thead><tbody>${report.rejected.map((r) => html`<tr><td>${r.row}</td><td>${r.reason}</td></tr>`)}</tbody></table>` : html`<p>Every row was usable.</p>`}` : ""}
      <h2>Current version</h2>
      ${latest ? html`<p class="muted">Imported ${this.t(latest.imported_at)}; ${latest.rows.length} row(s).</p><table><thead><tr><th scope="col">Row</th>${columns.map((c) => html`<th scope="col">${c}</th>`)}</tr></thead><tbody>${latest.rows.slice(0, 100).map((r) => html`<tr><td>${r.row}</td>${columns.map((c) => html`<td class="mono">${r.key[c] ?? r.values[c] ?? ""}</td>`)}</tr>`)}</tbody></table>${latest.rows.length > 100 ? html`<p class="muted">First 100 rows shown.</p>` : ""}` : empty("Nothing imported yet. Rules that read this source report Couldn't verify until a version is imported.")}`;
    return { title: `Trusted source: ${s.name}`, body };
  }

  // ---------------------------------------------------------------- correction editor (UX-7a-7c)
  ruleEditor(projectId: string, q: Record<string, string>): Page {
    const p = this.app.projects.get(projectId);
    const template = TEMPLATES.find((x) => x.id === q.template);
    if (!template) {
      const body = html`
        <p>Step 1 of 3: what should always be true of this project's quotes?</p>
        <form method="get" action="/projects/${projectId}/rules/new">
          <fieldset><legend>Kind of correction</legend>${TEMPLATES.map((x, i) => html`<label><input type="radio" name="template" value="${x.id}" ${i === 0 ? html`checked` : ""}> ${x.label}</label>`)}</fieldset>
          <button class="primary" type="submit">Next</button>
        </form>
        <p class="muted">Each option is an exact check. Corrections that do not fit these options cannot be checked by this build; keep them as a note for people.</p>`;
      return { title: "Add a correction", body, project: p };
    }
    const values = templateValues(q);
    const docs = this.app.checks.latestVersions(projectId);
    const draft: DraftInput = { project_id: projectId, template: { template: template.id, ...values }, artifact_id: q.artifact_id || null, enforcement: q.enforcement === "warn" ? "warn" : "block", words: q.words ?? "" };
    let preview: Preview | null = null;
    let problems: string[] = [];
    if (q.preview === "1") {
      try {
        preview = this.app.authoring.preview(draft);
        problems = preview.problems;
      } catch (e) {
        problems = e instanceof ValidationError ? e.problems : [e instanceof ClError ? e.message : String(e)];
      }
    }
    const overlaps = preview ? [...preview.duplicates.map((d) => ({ ...d, why: "asks for the same thing" })), ...preview.conflicts.map((d) => ({ ...d, why: "cannot both be met with this one" }))] : [];
    const hidden = (extra: Record<string, string> = {}): Safe => html`${Object.entries({ template: template.id, ...Object.fromEntries(Object.entries(values).map(([k, v]) => [k, String(v)])), artifact_id: q.artifact_id ?? "", enforcement: draft.enforcement ?? "block", words: q.words ?? "", ...extra }).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}`;
    const body = html`
      <p>Step 2 of 3: ${template.label}. <a href="/projects/${projectId}/rules/new">Choose another kind</a></p>
      <form method="get" action="/projects/${projectId}/rules/new"><input type="hidden" name="template" value="${template.id}"><input type="hidden" name="preview" value="1">
        <fieldset><legend>What it requires</legend>${templateFields(this.app, template.id, values)}</fieldset>
        <fieldset><legend>Where it applies</legend>
          <label><input type="radio" name="artifact_id" value="" ${!q.artifact_id ? html`checked` : ""}> Every sales proposal in this project</label>
          ${docs.map((d) => html`<label><input type="radio" name="artifact_id" value="${d.artifact_id}" ${q.artifact_id === d.artifact_id ? html`checked` : ""}> Only ${d.name}</label>`)}
          <p class="muted">Wider scopes (several projects, the whole workspace) are not offered here.</p>
        </fieldset>
        <fieldset><legend>When it is not met</legend>
          <label><input type="radio" name="enforcement" value="block" ${draft.enforcement !== "warn" ? html`checked` : ""}> Must be fixed before a gated action</label>
          <label><input type="radio" name="enforcement" value="warn" ${draft.enforcement === "warn" ? html`checked` : ""}> Show as a note only</label>
        </fieldset>
        <label>In your own words (optional, kept as the original correction) <input type="text" name="words" value="${q.words ?? ""}" maxlength="2000"></label>
        <button type="submit">Preview</button>
      </form>
      ${problems.length ? html`<div class="card error" role="alert"><strong>This cannot be saved yet:</strong><ul>${problems.map((x) => html`<li>${x}</li>`)}</ul></div>` : ""}
      ${preview && !problems.length ? html`
        <h2>Step 3 of 3: check and save</h2>
        <div class="card"><strong>${preview.content.statement}</strong><div class="muted">${preview.content.title} - ${preview.content.scope.level === "artifact" ? "one document" : "this project only"} - ${preview.content.enforcement === "block" ? "must be fixed" : "note only"}</div></div>
        ${preview.notes.map((n) => html`<p class="card" role="note">${n}</p>`)}
        <h3>On the documents already in this project (dry run; nothing is changed)</h3>
        ${preview.dry_run.length ? html`<table><thead><tr><th scope="col">Document</th><th scope="col">Result</th><th scope="col">Why</th></tr></thead><tbody>${preview.dry_run.map((d) => html`<tr><td>${d.name} <span class="muted">v${d.version_seq}</span></td><td><strong>${outcomeWord(d.outcome)}</strong></td><td>${d.reason}</td></tr>`)}</tbody></table>` : empty("No documents yet. Check a file first to see how the rule behaves on it.")}
        <form method="post" action="/app/projects/${projectId}/rules">${this.token()}${hidden()}
          ${overlaps.length ? html`<fieldset><legend>Rules already in force that overlap (shown before saving)</legend>${overlaps.map((o) => html`<label><input type="checkbox" name="acknowledged" value="${o.rule_id}" required> I have seen <a href="/rules/${o.rule_id}?project=${projectId}">${o.title}</a>: "${o.statement}" - it ${o.why}.</label>`)}</fieldset>` : ""}
          <button class="primary" type="submit">Save as a candidate (off)</button>
        </form>
        <p class="muted">Saving does not turn the rule on. On the rule's page, add one real document it blocks and one it allows, then turn it on - or approve it on trial (note only).</p>` : ""}`;
    return { title: "Add a correction", body, project: p };
  }

  // ---------------------------------------------------------------- re-run as recorded (OBS-4)
  rerun(runId: string): Page {
    const report = this.app.checks.rerun(runId);
    const original = this.app.checks.getRun(runId);
    const p = this.app.projects.get(original.context.project_id!);
    const words = { identical: "[OK] Identical: the same inputs give the same results.", mismatch: "[X] Mismatch: something differs from what was recorded.", purged: "[?] An input is no longer stored, so the run cannot be repeated in full.", inputs_missing: "[?] This check's inputs were not recorded." } as const;
    const body = html`
      <div class="card" role="status"><strong>${words[report.status]}</strong></div>
      <p>Re-ran the check of ${original.artifact.name} version ${original.artifact.version_seq} as of ${this.t(original.as_of)}, from the stored bytes, rule revisions, trusted-source versions, exceptions and project facts recorded with it. Nothing was saved or changed.</p>
      ${report.problems.length ? html`<h2>What differs</h2><ul>${report.problems.map((x) => html`<li><strong>${x.kind.replace(/_/g, " ")}</strong>: ${x.detail}</li>`)}</ul>` : ""}
      ${report.results.length ? html`<table><thead><tr><th scope="col">Rule</th><th scope="col">Recorded</th><th scope="col">Re-run</th></tr></thead><tbody>${report.results.map((r) => html`<tr><td>${r.title}</td><td>${outcomeWord(r.recorded)}</td><td>${r.now ? outcomeWord(r.now) : "missing"}${r.same ? "" : label("differs")}</td></tr>`)}</tbody></table>` : ""}
      <p>Recorded verdict: ${verdictBadge(original.verdict)}${report.verdict ? html` - re-run verdict: ${verdictBadge(report.verdict)}` : ""}</p>
      <p><a href="/runs/${runId}">Back to the check</a></p>`;
    return { title: `Re-run as recorded: ${original.artifact.name}`, body, project: p };
  }

  // ---------------------------------------------------------------- a proposed change
  fix(fixId: string): Page {
    const { proposal: f, diff, stale } = this.app.fixes.preview(fixId);
    const p = this.app.projects.get(f.project_id);
    const name = this.app.checks.artifact(f.artifact_id).name;
    const body = html`
      <div class="card"><strong>A proposal, not a change.</strong> Proposed by ${f.proposed_by.display_name ?? f.proposed_by.id} (${f.proposed_by.kind === "system" ? "the check engine" : f.proposed_by.kind === "agent" ? "an assistant" : "a person"}) on ${this.t(f.proposed_at)}: ${f.summary}. Nothing in ${name} has changed. If you apply it, you create the next version and it is checked again.</div>
      <p>Status: <strong>${f.status}</strong>${f.applied_version_seq ? ` - applied as version ${f.applied_version_seq} by ${this.app.projects.displayName(f.decided_by)}` : ""}${stale && f.status === "open" ? html` ${label("the document changed since; this proposal cannot be applied")}` : ""}</p>
      <h2>What would change (against version ${f.base_version_seq})</h2>
      ${diffTable(diff)}
      ${f.status === "open" && !stale ? html`<form class="inline" method="post" action="/app/fixes/${fixId}/apply">${this.token()}
          <label class="inline">Then check it for <select name="action"><option value="release">release</option><option value="check_only">just check</option></select></label>
          <button class="primary" type="submit">Apply as the next version and recheck</button></form>
        ${this.post(`/app/fixes/${fixId}/dismiss`, "Dismiss", { back: `/fixes/${fixId}` })}` : ""}
      <h2>History</h2>
      <ul>${this.app.ledger.byRef("fix_id", fixId).map((e) => html`<li>${this.t(e.occurred_at)} - ${e.summary}</li>`)}</ul>`;
    return { title: `Proposed change to ${name}`, body, project: p };
  }

  // ---------------------------------------------------------------- journey of a correction (OBS-6)
  journey(correctionId: string): Page {
    const j = correctionJourney(this.app.db, this.app.ledger, correctionId);
    const p = j.project_id ? this.app.projects.get(j.project_id) : null;
    const rules = j.rule_ids.map((id) => this.app.rules.get(id));
    const words = this.app.db.prepare("SELECT text FROM corrections WHERE correction_id = ?").get(correctionId) as { text: string | null } | undefined;
    const body = html`
      <p>${words?.text ? html`Original words: "${words.text}"` : "Original wording: not kept or deleted."}</p>
      ${rules.map((r: Rule) => html`<p>Became the rule <a href="/rules/${r.rule_id}${p ? `?project=${p.project_id}` : ""}">${r.title}</a> - ${r.status}.</p>`)}
      <p class="muted">Followed through stored references only (correction, signal, rule, check, document, proposal, receipt and request ids), never by time or wording. Times: ${this.app.displayTz}.</p>
      ${j.events.length ? html`<table class="timeline"><tbody>${j.events.map((e) => html`<tr><td>${this.t(e.occurred_at)}</td><td class="word">${JOURNEY_WORDS[e.type] ?? e.type}</td><td>${e.summary}${e.refs.run_id && e.type === "run.completed" ? html` <a href="/runs/${e.refs.run_id}">open check</a>` : ""}${e.refs.fix_id && e.type === "fix.proposed" ? html` <a href="/fixes/${e.refs.fix_id}">open proposal</a>` : ""}${e.refs.action_id ? html` <a href="/actions/${e.refs.action_id}">open request</a>` : ""}<div class="muted mono">${e.event_id}${e.caused_by.length ? ` - because of ${e.caused_by.join(", ")}` : ""}</div></td><td>${e.actor.display_name ?? this.app.projects.displayName(e.actor.id)} <span class="muted">(${e.actor.kind})</span></td></tr>`)}</tbody></table>` : empty("Nothing recorded for this correction.")}`;
    return { title: "Journey of a correction", body, project: p };
  }
}
