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
export type ButtonKind = boolean | "primary" | "secondary" | "danger";
/** A one-button form for an act of the local person: same-origin POST with the form token. `danger` marks acts that remove or refuse something. */
export function postButton(csrf: string, action: string, button: string, fields: Record<string, string> = {}, kind: ButtonKind = false): Safe {
  const cls = kind === true || kind === "primary" ? "primary" : kind === "danger" ? "danger" : "";
  return html`<form class="inline" method="post" action="${action}"><input type="hidden" name="_csrf" value="${csrf}">${Object.entries(fields).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}<button type="submit" class="${cls}">${button}</button></form>`;
}

export function empty(text: string): Safe {
  return html`<p class="empty">${text}</p>`;
}

export function layout(o: { title: string; body: Safe; project?: { project_id: string; name: string; is_demo: boolean } | null; demo: boolean; workspace: string; flash?: string | null; flashKind?: "success" | "error"; path?: string }): string {
  const p = o.project;
  const link = (href: string, text: string, exact = false): Safe => {
    const current = o.path === href || (!exact && href !== "/" && href !== `/projects/${p?.project_id}` && !!o.path?.startsWith(href + "/"));
    return html`<a href="${href}" ${current ? html`aria-current="page"` : ""}>${text}</a>`;
  };
  const projectNav = p
    ? html`<div class="navgroup"><div class="navlabel">Project</div><div class="projname">${p.name}${p.is_demo ? label("DEMO", "demo-label") : ""}</div>
      <nav aria-label="Project">${link(`/projects/${p.project_id}`, "Overview", true)}${link(`/projects/${p.project_id}/rules`, "Rules")}${link(`/projects/${p.project_id}/learning`, "Learning")}${link(`/projects/${p.project_id}/capture`, "Capture health")}${link(`/projects/${p.project_id}/activity`, "Activity")}${link(`/projects/${p.project_id}/coverage`, "Coverage")}${link(`/projects/${p.project_id}/settings`, "Settings")}${link(`/projects/${p.project_id}/effectiveness`, "Counts")}</nav></div>`
    : html``;
  return html`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${o.title} - Correction Layer</title><link rel="stylesheet" href="/assets/app.css"></head>
<body>
<a class="skip" href="#main">Skip to content</a>
<div class="shell">
<aside class="sidebar">
  <a class="brand" href="/"><span class="mark" aria-hidden="true"></span>Correction Layer</a>
  <div class="ws">${o.workspace}</div>
  <div class="navgroup"><nav aria-label="Workspace">${link("/", "All projects", true)}${link("/start", "Start new")}${link("/import", "Import existing")}${link("/history", "History check")}</nav></div>
  ${projectNav}
  <p class="scope-note" role="note">Local MVP (Phase 2): one person, one machine. Checks are advisory; the only gated route is release (simulated, or a local folder you choose). Nothing is sent or paid. No AI model is used.</p>
</aside>
<div class="content">
${o.demo ? html`<div class="demo" role="note"><span class="demo-tag">DEMO</span><div><strong>DEMO DATA.</strong> Projects, people, documents and rules marked DEMO are fictional and illustrative. Nothing shown is a measurement, and no rule here was shown to make work "better".</div></div>` : ""}
${p ? html`<div class="crumb"><a href="/">All projects</a> <span aria-hidden="true">/</span> <span>${p.name}</span>${p.is_demo ? label("DEMO", "demo-label") : ""}</div>` : ""}
${o.flash ? html`<div class="flash ${o.flashKind ?? "success"}" role="status"><span class="flash-mark" aria-hidden="true">${o.flashKind === "error" ? "!" : "✓"}</span><span>${o.flash}</span></div>` : ""}
<main id="main" tabindex="-1"><h1>${o.title}</h1>${o.body}</main>
<footer>Local-first: your data stays on this computer. Times are shown in the workspace timezone; stored times are UTC.</footer>
</div>
</div>
</body></html>`.value;
}

/** A small set of components shared by the screens (no client script). */
export function nextStep(title: string, text: string | Safe, actions: Safe): Safe {
  return html`<section class="next" aria-label="Next step"><div class="next-label">Next step</div><h2 class="next-title">${title}</h2><p>${text}</p><div class="actions">${actions}</div></section>`;
}
export function linkButton(href: string, text: string, kind: "primary" | "secondary" = "secondary"): Safe {
  return html`<a class="btn ${kind}" href="${href}">${text}</a>`;
}
export function steps(items: Array<{ label: string; state: "done" | "current" | "todo"; optional?: boolean }>): Safe {
  return html`<ol class="steps">${items.map((x, i) => html`<li class="${x.state}" ${x.state === "current" ? html`aria-current="step"` : ""}><span class="num" aria-hidden="true">${x.state === "done" ? "✓" : String(i + 1)}</span><span>${x.label}${x.optional ? html` <span class="muted">(optional)</span>` : ""}<span class="sr-only"> - ${x.state === "done" ? "done" : x.state === "current" ? "current step" : "not yet"}</span></span></li>`)}</ol>`;
}
export function stat(value: string | number, text: string, href?: string): Safe {
  return href ? html`<a class="stat" href="${href}"><span class="stat-value">${String(value)}</span><span class="stat-label">${text}</span></a>` : html`<div class="stat"><span class="stat-value">${String(value)}</span><span class="stat-label">${text}</span></div>`;
}

export const CSS = `
:root{--bg:#f5f6f8;--surface:#fff;--fg:#17202b;--muted:#5a6573;--line:#e1e5ea;--line-strong:#c9d0d8;--soft:#f0f2f5;--accent:#2b56c6;--accent-ink:#1d3f99;--accent-soft:#eaf0fd;
--ok:#18794e;--ok-soft:#e7f5ee;--bad:#b42318;--bad-soft:#fdecea;--unk:#8a5a00;--unk-soft:#fdf4e3;--demo:#fbf1d2;--demo-ink:#6b5310;--radius:10px;--shadow:0 1px 2px rgba(16,24,40,.06)}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--fg);background:var(--bg)}
a{color:var(--accent);text-underline-offset:2px;text-decoration-thickness:1px}a:hover{color:var(--accent-ink)}
.shell{display:grid;grid-template-columns:15.5rem minmax(0,1fr);min-height:100vh}
.sidebar{background:var(--surface);border-right:1px solid var(--line);padding:1rem .8rem;position:sticky;top:0;height:100vh;overflow-y:auto;display:flex;flex-direction:column;gap:.9rem}
.brand{display:flex;align-items:center;gap:.5rem;font-weight:700;font-size:1.02rem;color:var(--fg);text-decoration:none;padding:0 .5rem}
.mark{width:.9rem;height:.9rem;border-radius:3px;background:var(--accent);display:inline-block;box-shadow:3px 3px 0 var(--accent-soft)}
.ws{color:var(--muted);font-size:.85rem;padding:0 .5rem;margin-top:-.6rem}
.navgroup nav{display:flex;flex-direction:column;gap:1px}
.navgroup nav a{color:var(--fg);text-decoration:none;padding:.38rem .6rem;border-radius:7px}
.navgroup nav a:hover{background:var(--soft)}
.navgroup nav a[aria-current=page]{background:var(--accent-soft);color:var(--accent-ink);font-weight:600;box-shadow:inset 3px 0 0 var(--accent)}
.navlabel{font-size:.75rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);padding:0 .6rem .2rem}
.projname{font-weight:600;padding:0 .6rem .35rem;font-size:.92rem;line-height:1.3}
.scope-note{margin-top:auto;font-size:.78rem;color:var(--muted);padding:.6rem;border-top:1px solid var(--line)}
.content{min-width:0;display:flex;flex-direction:column}
main{width:100%;max-width:64rem;margin:0 auto;padding:1.2rem 1.6rem 3rem;flex:1}
main:focus{outline:none}
h1{font-size:1.55rem;line-height:1.25;margin:.4rem 0 1rem;letter-spacing:-.01em}
h2{font-size:1.1rem;margin:1.8rem 0 .5rem;color:var(--fg)}h3{font-size:1rem;margin:1.1rem 0 .4rem}
.demo{display:flex;gap:.7rem;align-items:flex-start;background:var(--demo);color:var(--demo-ink);border-bottom:1px solid #ecd9a0;padding:.5rem 1.6rem;font-size:.88rem}
.demo-tag{font-weight:800;font-size:.72rem;letter-spacing:.08em;border:1.5px solid var(--demo-ink);border-radius:4px;padding:0 .35rem;margin-top:.15rem}
.crumb{padding:.9rem 1.6rem 0;font-size:.88rem;color:var(--muted);max-width:64rem;width:100%;margin:0 auto}
.flash{display:flex;gap:.6rem;align-items:flex-start;max-width:60.8rem;margin:.9rem auto 0;width:calc(100% - 3.2rem);padding:.65rem .9rem;border-radius:var(--radius);border:1px solid #b7d9c6;background:var(--ok-soft)}
.flash.error{border-color:#f0b8b2;background:var(--bad-soft)}
.flash-mark{font-weight:800;width:1.3rem;height:1.3rem;border-radius:50%;display:inline-grid;place-items:center;background:var(--ok);color:#fff;font-size:.8rem;flex:none}.flash.error .flash-mark{background:var(--bad)}
table{border-collapse:collapse;width:100%;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);overflow:hidden;margin:.4rem 0 .8rem}
th,td{text-align:left;vertical-align:top;padding:.55rem .75rem;border-bottom:1px solid var(--line)}tr:last-child td{border-bottom:0}
thead th,th[scope=col]{background:var(--soft);color:var(--muted);font-weight:600;font-size:.84rem}tbody th{color:var(--muted);font-weight:600;width:12rem}
caption{text-align:left;color:var(--muted);padding:.3rem 0;font-size:.88rem}
.card{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:.9rem 1.1rem;margin:.7rem 0;box-shadow:var(--shadow)}
.card>:first-child{margin-top:0}.card>:last-child{margin-bottom:0}
.card.error{border-color:#f0b8b2;background:var(--bad-soft)}
.muted{color:var(--muted)}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.84em;word-break:break-all}
.badge{display:inline-flex;align-items:center;gap:.3rem;font-weight:700;white-space:nowrap;border-radius:999px;padding:.08rem .6rem;font-size:.86rem;border:1px solid}
.badge.ok{color:var(--ok);background:var(--ok-soft);border-color:#b7d9c6}.badge.bad{color:var(--bad);background:var(--bad-soft);border-color:#f0b8b2}.badge.unk{color:var(--unk);background:var(--unk-soft);border-color:#ecd39b}
.label{display:inline-block;border:1px solid var(--line-strong);border-radius:999px;padding:0 .5rem;font-size:.76rem;margin-left:.35rem;white-space:nowrap;color:var(--muted);background:var(--surface);vertical-align:1px}
.label.auto{border-color:#b9c8f0;color:var(--accent-ink);background:var(--accent-soft)}
.demo-label{background:var(--demo);border-color:#e3cd86;color:var(--demo-ink);font-weight:700}
.unavailable{border:1px dashed #d9b86a;padding:.6rem .85rem;margin:.8rem 0;background:#fffaf0;border-radius:var(--radius);font-size:.92rem}
.empty{color:var(--muted);border:1px dashed var(--line-strong);border-radius:var(--radius);padding:.7rem .9rem;background:var(--surface)}
button,.btn{font:inherit;font-weight:600;font-size:.92rem;padding:.42rem .9rem;border-radius:8px;border:1px solid var(--line-strong);background:var(--surface);color:var(--fg);cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;gap:.35rem;line-height:1.3}
button:hover,.btn:hover{background:var(--soft);color:var(--fg)}
button.primary,.btn.primary{background:var(--accent);border-color:var(--accent);color:#fff}button.primary:hover,.btn.primary:hover{background:var(--accent-ink);color:#fff}
button.danger{color:var(--bad);border-color:#efb4ad}button.danger:hover{background:var(--bad-soft)}
form.inline{display:inline}.actions{display:flex;flex-wrap:wrap;gap:.45rem;align-items:center;margin:.5rem 0}.actions form{margin:0}
form:not(.inline){margin:.5rem 0}
label{display:block;margin:.55rem 0;font-size:.94rem}
input[type=text],input[type=number],input[type=date],textarea,select{display:block;font:inherit;padding:.45rem .6rem;border:1px solid var(--line-strong);border-radius:8px;width:100%;max-width:38rem;background:#fff;margin-top:.2rem;color:var(--fg)}
input[type=radio],input[type=checkbox]{margin-right:.4rem;accent-color:var(--accent)}
input[type=file]{display:block;margin-top:.3rem;font:inherit}
textarea{min-height:10rem;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.88rem}
fieldset{border:1px solid var(--line);border-radius:var(--radius);margin:.9rem 0;padding:.6rem 1rem .8rem;background:var(--surface)}legend{font-weight:600;padding:0 .3rem}
details{margin:.7rem 0;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:.55rem .9rem}
details>summary{cursor:pointer;font-weight:600}details[open]>summary{margin-bottom:.4rem}
pre{background:var(--soft);padding:.7rem;border-radius:8px;overflow-x:auto;white-space:pre-wrap}
del{background:var(--bad-soft);text-decoration:line-through}ins{background:var(--ok-soft);text-decoration:none}
.timeline td:first-child{white-space:nowrap;color:var(--muted);font-size:.88rem}.word{font-weight:700;letter-spacing:.03em;font-size:.82rem}
footer{border-top:1px solid var(--line);padding:.7rem 1.6rem;color:var(--muted);font-size:.82rem}
.skip{position:absolute;left:-999px;top:0;background:#fff;padding:.4rem .8rem;border:2px solid var(--fg);z-index:20}.skip:focus{left:.5rem}
a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,summary:focus-visible,.btn:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.lead{font-size:1.04rem;color:var(--muted);margin-top:-.5rem}
.next{background:var(--surface);border:1px solid #c8d5f5;border-left:4px solid var(--accent);border-radius:var(--radius);padding:.85rem 1.1rem;margin:1rem 0;box-shadow:var(--shadow)}
.next-label{font-size:.75rem;text-transform:uppercase;letter-spacing:.07em;color:var(--accent-ink);font-weight:700}.next-title{margin:.15rem 0 .3rem;font-size:1.08rem}.next p{margin:.2rem 0 .4rem}
.choices{display:grid;grid-template-columns:repeat(auto-fit,minmax(15rem,1fr));gap:.9rem;margin:1rem 0}
.choice{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:1rem 1.1rem;display:flex;flex-direction:column;gap:.4rem;box-shadow:var(--shadow)}
.choice h2,.choice h3{margin:0;font-size:1.08rem}.choice p{margin:0;color:var(--muted)}.choice .actions{margin-top:auto;padding-top:.4rem}
.choice.featured{border-color:#c8d5f5;box-shadow:0 0 0 3px var(--accent-soft)}.choice.demo-choice{background:#fffdf5;border-style:dashed;border-color:#e3cd86}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(9rem,1fr));gap:.7rem;margin:.8rem 0 1rem}
.stat{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:.65rem .9rem;display:flex;flex-direction:column;text-decoration:none;color:var(--fg)}
a.stat:hover{border-color:var(--accent)}.stat-value{font-size:1.45rem;font-weight:700;line-height:1.2}.stat-label{color:var(--muted);font-size:.86rem}
.steps{list-style:none;padding:0;margin:.4rem 0 1.2rem;display:flex;flex-wrap:wrap;gap:.4rem 1.2rem}
.steps li{display:flex;align-items:center;gap:.45rem;color:var(--muted);font-size:.92rem}
.steps .num{width:1.6rem;height:1.6rem;border-radius:50%;display:inline-grid;place-items:center;border:1.5px solid var(--line-strong);font-weight:700;font-size:.82rem;background:var(--surface)}
.steps li.done .num{background:var(--ok);border-color:var(--ok);color:#fff}.steps li.current{color:var(--fg);font-weight:600}.steps li.current .num{border-color:var(--accent);color:var(--accent-ink);box-shadow:0 0 0 3px var(--accent-soft)}
.project-head{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:flex-start;gap:.6rem}
.status-ok{color:var(--ok)}.status-bad{color:var(--bad)}.status-unk{color:var(--unk)}
.list-plain{list-style:none;padding:0;margin:.3rem 0}.list-plain li{padding:.3rem 0;border-bottom:1px solid var(--line)}.list-plain li:last-child{border-bottom:0}
@media (max-width:900px){.shell{display:block}.sidebar{position:static;height:auto;border-right:0;border-bottom:1px solid var(--line);padding:.7rem .8rem;gap:.5rem}
.navgroup nav{flex-direction:row;flex-wrap:wrap;gap:.2rem}.navgroup nav a[aria-current=page]{box-shadow:inset 0 -3px 0 var(--accent)}.scope-note{margin-top:0;border-top:0;padding:.2rem .5rem}
main{padding:1rem 1rem 2.5rem}.demo,.crumb,footer{padding-left:1rem;padding-right:1rem}.flash{width:calc(100% - 2rem)}tbody th{width:auto}}
@media (max-width:560px){th,td{padding:.45rem .5rem}h1{font-size:1.3rem}.choices{grid-template-columns:1fr}}
@media print{.sidebar,.skip{display:none}.shell{display:block}}
`;
