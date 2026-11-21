/**
 * Minimal server-side rendering: an auto-escaping `html` tag, the page layout and
 * a few shared components. No client framework and no build step: the app shell is
 * plain HTML forms, so it works by keyboard and with a screen reader, and verdicts
 * are words and symbols, never colour alone (docs/01 §12).
 */
export class Safe {
  readonly value: string;
  constructor(value: string) {
    this.value = value;
  }
  toString(): string {
    return this.value;
  }
}

export function esc(value: unknown): string {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): Safe {
  let out = strings[0]!;
  values.forEach((v, i) => {
    const flat = Array.isArray(v) ? v : [v];
    out += flat.map((x) => (x instanceof Safe ? x.value : x === null || x === undefined || x === false ? "" : esc(x))).join("") + strings[i + 1]!;
  });
  return new Safe(out);
}

export const raw = (s: string): Safe => new Safe(s);

const VERDICTS: Record<string, [string, string, string]> = {
  ready: ["ok", "[OK]", "Ready"], needs_changes: ["bad", "[X]", "Needs changes"], could_not_verify: ["unk", "[?]", "Couldn't verify"],
};
export function verdictBadge(verdict: string | null | undefined): Safe {
  const [cls, mark, word] = VERDICTS[verdict ?? ""] ?? ["unk", "[~]", "Not checked"];
  return html`<span class="badge ${cls}">${mark} ${word}</span>`;
}

const OUTCOMES: Record<string, string> = {
  pass: "Passed", fail: "Needs changes", unknown: "Couldn't verify", error: "Couldn't verify (error)", not_applicable: "Does not apply", waived: "Skipped by exception",
  conflict: "Conflict", skipped: "Skipped (note only)",
};
export const outcomeWord = (o: string): string => OUTCOMES[o] ?? o;

export function label(text: string, cls = ""): Safe {
  return html`<span class="label ${cls}">${text}</span>`;
}

/** An explicit empty or unavailable state. The shell never shows a blank where a feature is missing. */
export function unavailable(title: string, detail: string): Safe {
  return html`<div class="unavailable" role="note"><strong>Not available in this build:</strong> ${title}. <span>${detail}</span></div>`;
}
/** A one-button form for an act of the local person: same-origin POST with the form token. */
export function postButton(csrf: string, action: string, button: string, fields: Record<string, string> = {}, primary = false): Safe {
  return html`<form class="inline" method="post" action="${action}"><input type="hidden" name="_csrf" value="${csrf}">${Object.entries(fields).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}<button type="submit" class="${primary ? "primary" : ""}">${button}</button></form>`;
}

export function empty(text: string): Safe {
  return html`<p class="empty">${text}</p>`;
}

export function layout(o: { title: string; body: Safe; project?: { project_id: string; name: string; is_demo: boolean } | null; demo: boolean; workspace: string; flash?: string | null; path?: string }): string {
  const p = o.project;
  const link = (href: string, text: string): Safe => {
    const current = o.path === href || (href !== `/projects/${p?.project_id}` && !!o.path?.startsWith(href + "/"));
    return html`<a href="${href}" ${current ? html`aria-current="page"` : ""}>${text}</a>`;
  };
  const nav = p
    ? html`<nav aria-label="Project">${link(`/projects/${p.project_id}`, "Home")}${link(`/projects/${p.project_id}/rules`, "Rules")}${link(`/projects/${p.project_id}/learning`, "Learning")}${link(`/projects/${p.project_id}/capture`, "Capture health")}${link(`/projects/${p.project_id}/activity`, "Activity")}${link(`/projects/${p.project_id}/coverage`, "Coverage")}${link(`/projects/${p.project_id}/settings`, "Settings")}${link(`/projects/${p.project_id}/effectiveness`, "Counts")}</nav>`
    : html``;
  return html`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${o.title} - Correction Layer</title><link rel="stylesheet" href="/assets/app.css"></head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header><a class="brand" href="/">Correction Layer</a><span class="ws">${o.workspace}</span><a href="/">All projects</a><a href="/history">History check</a></header>
${o.demo ? html`<div class="demo" role="note"><strong>DEMO DATA.</strong> Projects, people, documents and rules marked DEMO are fictional and illustrative. Nothing shown is a measurement, and no rule here was shown to make work "better".</div>` : ""}
<div class="phase" role="note">Local MVP (Phase 2): one person, one machine. Checks are advisory; the only gated route is release (simulated, or a local folder you choose). Nothing is sent or paid. No AI model is used.</div>
${p ? html`<div class="crumb"><a href="/">All projects</a> / <strong>${p.name}</strong>${p.is_demo ? label("DEMO", "demo-label") : ""}</div>` : ""}
${nav}
${o.flash ? html`<div class="flash" role="status">${o.flash}</div>` : ""}
<main id="main" tabindex="-1"><h1>${o.title}</h1>${o.body}</main>
<footer>Local-first. Times are shown in the workspace timezone; stored times are UTC.</footer>
</body></html>`.value;
}

export const CSS = `
:root{--fg:#1a1d21;--muted:#5b6470;--line:#d5d9df;--bg:#fff;--soft:#f5f6f8;--ok:#0b6b3a;--bad:#a4161a;--unk:#7a5200;--link:#0b4f9e}
*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--fg);background:var(--bg)}
header{display:flex;gap:1rem;align-items:baseline;padding:.6rem 1.2rem;border-bottom:1px solid var(--line)}
.brand{font-weight:700;text-decoration:none;color:var(--fg)}.ws{color:var(--muted);flex:1}
a{color:var(--link)}nav{display:flex;flex-wrap:wrap;gap:1rem;padding:.5rem 1.2rem;border-bottom:1px solid var(--line);background:var(--soft)}
.crumb{padding:.5rem 1.2rem 0}.demo,.phase,.flash{padding:.45rem 1.2rem;border-bottom:1px solid var(--line)}
.demo{background:#fff4d6}.phase{background:var(--soft);color:var(--muted);font-size:.9em}.flash{background:#e6f1ff}
main{max-width:62rem;margin:0 auto;padding:1rem 1.2rem 3rem}h1{font-size:1.4rem}h2{font-size:1.05rem;margin:1.6rem 0 .4rem;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}
table{border-collapse:collapse;width:100%}th,td{text-align:left;vertical-align:top;padding:.35rem .6rem .35rem 0;border-bottom:1px solid var(--line)}th{color:var(--muted);font-weight:600}
.badge{font-weight:700;white-space:nowrap}.badge.ok{color:var(--ok)}.badge.bad{color:var(--bad)}.badge.unk{color:var(--unk)}
.label{display:inline-block;border:1px solid var(--line);border-radius:3px;padding:0 .35rem;font-size:.8em;margin-left:.35rem;white-space:nowrap}.demo-label{background:#fff4d6}
.unavailable{border:1px dashed var(--unk);padding:.6rem .8rem;margin:.6rem 0;background:#fffaf0}.empty{color:var(--muted);font-style:italic}
.card{border:1px solid var(--line);border-radius:6px;padding:.8rem 1rem;margin:.6rem 0}.muted{color:var(--muted)}.mono{font-family:ui-monospace,monospace;font-size:.85em;word-break:break-all}
form.inline{display:inline}button{font:inherit;padding:.25rem .7rem;border:1px solid var(--fg);border-radius:4px;background:#fff;cursor:pointer}button.primary{background:var(--fg);color:#fff}
input[type=text],textarea,select{font:inherit;padding:.3rem;border:1px solid var(--line);border-radius:4px;width:100%;max-width:40rem}textarea{min-height:9rem;font-family:ui-monospace,monospace}
fieldset{border:1px solid var(--line);border-radius:6px;margin:.8rem 0}label{display:block;margin:.35rem 0}.timeline td:first-child{white-space:nowrap}.word{font-weight:700;letter-spacing:.03em}
footer{border-top:1px solid var(--line);padding:.6rem 1.2rem;color:var(--muted);font-size:.85em}
.skip{position:absolute;left:-999px;top:0;background:#fff;padding:.4rem .8rem;border:2px solid var(--fg)}.skip:focus{left:.5rem;z-index:10}
nav a[aria-current=page]{font-weight:700;text-decoration:none;border-bottom:2px solid var(--fg)}
a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,summary:focus-visible{outline:3px solid var(--link);outline-offset:2px}
.error{border-color:var(--bad);background:#fff5f5}caption{text-align:left;color:var(--muted);padding:.3rem 0}del{background:#fde8e8;text-decoration:line-through}ins{background:#e6f4ea;text-decoration:none}
details{margin:.6rem 0}summary{cursor:pointer}.actions form{margin:0 .3rem .3rem 0}label.inline{display:inline}input[type=number],input[type=date],input[type=file]{font:inherit;padding:.3rem}
`;
