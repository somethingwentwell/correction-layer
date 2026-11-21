/**
 * First-run guidance and import, over loopback HTTP with the real form token:
 * Start new, Import existing (documents and CSV sources), the fictional demo.
 * Error and success paths: missing fields, unsupported formats, previews that store
 * nothing, project binding, no overwrite, learning stays off, DEMO kept apart.
 * Each test has its own in-memory workspace. FICTIONAL test data.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunningServer } from "../src/api/server.ts";
import { startServer } from "../src/api/server.ts";
import { get } from "../src/store/db.ts";
import type { TestApp } from "./helpers.ts";
import { makeApp, quote } from "./helpers.ts";

const text = (b: Uint8Array): string => new TextDecoder().decode(b);

async function withServer(fn: (h: Harness) => Promise<void>): Promise<void> {
  const app = makeApp();
  const server = await startServer(app, { host: "127.0.0.1", port: 0 });
  try {
    await fn(harness(app, server));
  } finally {
    await server.close();
    app.close();
  }
}

interface Harness {
  app: TestApp;
  page(path: string): Promise<{ status: number; text: string }>;
  form(path: string, fields: Record<string, string | string[]>, token?: string | null): Promise<{ status: number; location: string; text: string }>;
  multipart(path: string, fields: Record<string, string>, files?: Array<{ field: string; name: string; bytes: Uint8Array }>, token?: string | null): Promise<{ status: number; location: string; text: string }>;
}

function harness(app: TestApp, server: RunningServer): Harness {
  const done = async (res: Response) => ({ status: res.status, location: res.headers.get("location") ?? "", text: await res.text() });
  return {
    app,
    page: async (path) => {
      const res = await fetch(server.url + path, { redirect: "manual" });
      return { status: res.status, text: await res.text() };
    },
    form: async (path, fields, token = server.csrf) => {
      const params = new URLSearchParams(token ? { _csrf: token } : {});
      for (const [k, v] of Object.entries(fields)) for (const x of ([] as string[]).concat(v)) params.append(k, x);
      return done(await fetch(server.url + path, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: params }));
    },
    multipart: async (path, fields, files = [], token = server.csrf) => {
      const fd = new FormData();
      if (token) fd.append("_csrf", token);
      for (const [k, v] of Object.entries(fields)) fd.append(k, v);
      for (const f of files) fd.append(f.field, new Blob([Buffer.from(f.bytes)]), f.name);
      return done(await fetch(server.url + path, { method: "POST", redirect: "manual", body: fd }));
    },
  };
}

const DOCX_LIKE = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5]);
const PDF_LIKE = new TextEncoder().encode("%PDF-1.7 fictional");
const count = (app: TestApp, sql: string, ...p: unknown[]): number => get<{ n: number }>(app.db, sql, ...p)!.n;

test("an empty workspace offers Start new, Import existing and the fictional demo, without a DEMO banner", async () => {
  await withServer(async (h) => {
    const home = await h.page("/");
    assert.equal(home.status, 200);
    assert.match(home.text, /Welcome to Correction Layer[\s\S]*Start new[\s\S]*Import existing[\s\S]*Try a fictional demo[\s\S]*Load the fictional demo/);
    assert.doesNotMatch(home.text, /DEMO DATA\./, "no demo label where there is no demo");
    assert.match(home.text, /<a href="\/" aria-current="page">All projects<\/a>/, "the current page is marked in the navigation");
    assert.match(home.text, /class="skip" href="#main"/);
    const onboarding = await h.page("/onboarding");
    assert.match(onboarding.text, /Get started[\s\S]*Start new[\s\S]*Import existing/);
  });
});

test("Start new: project -> first document -> optional rule -> first check explained; learning and release folder stay untouched", async () => {
  await withServer(async (h) => {
    const step1 = await h.page("/start");
    assert.match(step1.text, /aria-current="step"><span class="num" aria-hidden="true">1<\/span><span>Create the project[\s\S]*Learning stays off/);
    // Missing name: refused with what to do, nothing created.
    const missing = await h.form("/app/start/project", { name: "  " });
    assert.equal(missing.status, 422);
    assert.match(missing.text, /name: required[\s\S]*What you can do: Correct what is named above/);
    assert.equal(h.app.projects.list().length, 0);
    // Without the form token: refused.
    assert.equal((await h.form("/app/start/project", { name: "No token" }, null)).status, 403);

    const created = await h.form("/app/start/project", { name: "Kestrel 2027 (TEST)", customer_name: "Kestrel Dental Group" });
    assert.equal(created.status, 303);
    const projectId = /project=(prj_[0-9A-Z]+)/.exec(created.location)![1]!;
    assert.equal(h.app.policies.current(projectId), null, "learning is not set: it is off");
    assert.equal(h.app.gateway.releaseFolder(projectId), null, "no release folder is chosen for the person");
    assert.ok(h.app.gateway.coverage(projectId).find((c) => c.action === "release")!.simulated, "release stays simulated");
    assert.deepEqual(h.app.projects.get(projectId).facts, { customer_name: "Kestrel Dental Group" });
    const step2 = await h.page(created.location);
    assert.match(step2.text, /Project created\. Next: add your first document\.[\s\S]*Add your first document/);

    // An unsupported format is refused clearly, with the supported alternative; nothing is stored.
    const docx = await h.multipart("/app/start/document", { project_id: projectId }, [{ field: "file", name: "Quote.docx", bytes: DOCX_LIKE }]);
    assert.equal(docx.status, 422);
    assert.match(docx.text, /Couldn&#39;t verify: not supported\. Word, Excel and PowerPoint files cannot be read[\s\S]*Plain Text/);
    assert.equal(h.app.checks.latestVersions(projectId).length, 0);
    assert.equal((await h.multipart("/app/start/document", { project_id: projectId, name: "", content: "" })).status, 422, "nothing given");

    const added = await h.multipart("/app/start/document", { project_id: projectId, name: "Quote.md", content: text(quote({ currency: "USD" })) });
    assert.equal(added.status, 303);
    const step3 = await h.page(added.location);
    assert.match(step3.text, /Quote\.md added \(version 1\)[\s\S]*What we read in Quote\.md[\s\S]*KQ-2026-014[\s\S]*Pricing table lines<\/th><td>2/);

    // A sentence outside the supported patterns is refused with the reason; a supported one becomes a NOTE.
    const vague = await h.form("/app/start/rule", { project_id: projectId, sentence: "Make the quote more persuasive." });
    assert.equal(vague.status, 422);
    assert.match(vague.text, /cannot turn that sentence into an exact check/);
    const sentence = await h.form("/app/start/rule", { project_id: projectId, sentence: "Kestrel quotes must always be in SGD." });
    assert.equal(sentence.status, 303);
    const rule = h.app.rules.listForProject(projectId)[0]!;
    assert.deepEqual([rule.status, rule.check.kind, rule.check.params.allowed], ["trial", "field_in_set", ["SGD"]]);
    assert.equal(rule.authority?.kind, "individual_approval", "added by the person's own click, not by learning");
    const quick = await h.form("/app/start/rule", { project_id: projectId, template: "required_field", field: "quote.reference" });
    assert.equal(quick.status, 303);
    assert.equal(h.app.rules.listForProject(projectId).length, 2);

    const step4 = await h.page(`/start?project=${projectId}&step=check`);
    assert.match(step4.text, /Run the first check[\s\S]*Quote\.md \(version 1\)/);
    const artifactId = h.app.checks.latestVersions(projectId)[0]!.artifact_id;
    const checked = await h.form("/app/start/check", { project_id: projectId, artifact_id: artifactId });
    assert.equal(checked.status, 303);
    const result = await h.page(checked.location);
    assert.match(result.text, /\[OK\] Ready[\s\S]*Notes \(rules on trial\) never block[\s\S]*Needs changes[\s\S]*Currency is not SGD[\s\S]*Next step[\s\S]*Open the full check/);
    assert.match(result.text, /Learning is <strong>off<\/strong> for this project[\s\S]*never turns on by itself/);
    assert.equal(h.app.policies.current(projectId), null, "the whole guided start never set learning");
    assert.equal(count(h.app, "SELECT COUNT(*) AS n FROM action_requests"), 0, "nothing was requested or released");
    // A DEMO-like or unknown project cannot be driven through the start flow.
    assert.match((await h.page("/start?project=prj_NOSUCH0001")).text, /not one of your own projects/);
  });
});

test("Import documents: the preview stores nothing; unsupported files are named; same names never overwrite; content must match the preview", async () => {
  await withServer(async (h) => {
    const me = h.app.localUser;
    const p = h.app.projects.createProject({ name: "Import target (TEST)", default_work_type: "sales_proposal" }, me);
    h.app.checks.observe({ project_id: p.project_id, name: "Quote.md", bytes: quote({ currency: "USD" }) });
    const hub = await h.page("/import");
    assert.match(hub.text, /Markdown \(\.md\) or plain text \(\.txt\)[\s\S]*Price lists[\s\S]*Not supported, and what to do instead[\s\S]*ChatGPT, Copilot, email/);
    // No project chosen and no name for a new one.
    const noTarget = await h.multipart("/app/import/documents/preview", { project_id: "new", new_project_name: "" }, [{ field: "files", name: "A.md", bytes: quote() }]);
    assert.equal(noTarget.status, 422);
    assert.match(noTarget.text, /give a name for the new project/);
    // Nothing chosen at all.
    assert.equal((await h.multipart("/app/import/documents/preview", { project_id: p.project_id })).status, 422);

    const files = [
      { field: "files", name: "Quote.md", bytes: quote({ currency: "SGD" }) },
      { field: "files", name: "Notes.txt", bytes: new TextEncoder().encode("Customer: Kestrel Dental Group\nJust notes, no pricing table.\n") },
      { field: "files", name: "Contract.pdf", bytes: PDF_LIKE },
      { field: "files", name: "Proposal.docx", bytes: DOCX_LIKE },
    ];
    const versionsBefore = count(h.app, "SELECT COUNT(*) AS n FROM artifact_versions");
    const preview = await h.multipart("/app/import/documents/preview", { project_id: p.project_id, on_existing: "new_version" }, files);
    assert.equal(preview.status, 200);
    assert.match(preview.text, /Nothing has been saved yet/);
    assert.match(preview.text, /Quote\.md[\s\S]*this becomes <strong>version 2<\/strong>\. Earlier versions are kept/);
    assert.match(preview.text, /Notes\.txt[\s\S]*No pricing table was found/);
    assert.match(preview.text, /Contract\.pdf[\s\S]*\[X\] Couldn(&#39;|')t verify: not supported[\s\S]*PDF files cannot be read/);
    assert.match(preview.text, /Proposal\.docx[\s\S]*Word, Excel and PowerPoint files cannot be read/);
    assert.match(preview.text, /Import 2 document\(s\)[\s\S]*2 will be left out/);
    assert.equal(count(h.app, "SELECT COUNT(*) AS n FROM artifact_versions"), versionsBefore, "a preview stores nothing");

    // Confirm with the previewed content: Quote.md becomes version 2 (version 1 kept), Notes.txt is new.
    const field = (name: string): string[] => [...preview.text.matchAll(new RegExp(`name="${name}" value="([^"]*)"`, "g"))].map((m) => m[1]!);
    const confirm = { project_id: p.project_id, new_project_name: "", on_existing: "new_version", doc_name: field("doc_name"), doc_hash: field("doc_hash"), doc_b64: field("doc_b64") };
    assert.deepEqual(confirm.doc_name, ["Quote.md", "Notes.txt"]);
    // Tampered content (not what was previewed) is refused; nothing stored.
    const tampered = await h.form("/app/import/documents", { ...confirm, doc_b64: [Buffer.from("different").toString("base64"), confirm.doc_b64[1]!] });
    assert.equal(tampered.status, 409);
    assert.equal(count(h.app, "SELECT COUNT(*) AS n FROM artifact_versions"), versionsBefore);
    const imported = await h.form("/app/import/documents", confirm);
    assert.equal(imported.status, 303);
    assert.match(decodeURIComponent(imported.location), /Imported: Quote\.md \(version 2\), Notes\.txt/);
    const quoteId = h.app.checks.latestVersions(p.project_id).find((v) => v.name === "Quote.md")!.artifact_id;
    assert.equal(h.app.checks.versions(quoteId).length, 2, "version 1 is kept");
    // The project page shows the next useful action.
    assert.match((await h.page(imported.location)).text, /Next step[\s\S]*Check 1 document not yet checked|Next step[\s\S]*Check 2 documents not yet checked/);

    // Keep both: a distinct name, the existing document untouched. Identical content: nothing changes.
    const again = await h.multipart("/app/import/documents/preview", { project_id: p.project_id, on_existing: "keep_both" }, [{ field: "files", name: "Quote.md", bytes: quote({ currency: "EUR" }) }, { field: "files", name: "Notes.txt", bytes: files[1]!.bytes }]);
    assert.match(again.text, /saved under a new name[\s\S]*Notes\.txt[\s\S]*Identical to version 1: nothing will change/);
    const keep = await h.form("/app/import/documents", { project_id: p.project_id, new_project_name: "", on_existing: "keep_both", doc_name: [...again.text.matchAll(/name="doc_name" value="([^"]*)"/g)].map((m) => m[1]!), doc_hash: [...again.text.matchAll(/name="doc_hash" value="([^"]*)"/g)].map((m) => m[1]!), doc_b64: [...again.text.matchAll(/name="doc_b64" value="([^"]*)"/g)].map((m) => m[1]!) });
    assert.equal(keep.status, 303);
    assert.ok(h.app.checks.latestVersions(p.project_id).some((v) => v.name === "Quote (2).md"));
    assert.equal(h.app.checks.versions(quoteId).length, 2, "the existing Quote.md got no new version");

    // Into a new project, created only on confirm.
    const toNew = await h.multipart("/app/import/documents/preview", { project_id: "new", new_project_name: "Brand new (TEST)" }, [{ field: "files", name: "First.md", bytes: quote() }]);
    assert.equal(h.app.projects.list().length, 1, "previewing does not create the project");
    const made = await h.form("/app/import/documents", { project_id: "new", new_project_name: "Brand new (TEST)", on_existing: "new_version", doc_name: "First.md", doc_hash: /name="doc_hash" value="([^"]*)"/.exec(toNew.text)![1]!, doc_b64: /name="doc_b64" value="([^"]*)"/.exec(toNew.text)![1]! });
    assert.equal(made.status, 303);
    const newProject = h.app.projects.list().find((x) => x.name === "Brand new (TEST)")!;
    assert.equal(h.app.checks.latestVersions(newProject.project_id).length, 1);
    assert.equal(h.app.policies.current(newProject.project_id), null, "importing never turns learning on");
    assert.equal((await h.form("/app/import/documents", confirm, null)).status, 403, "the form token is required");
  });
});

test("Import a CSV trusted source: header problems are refused; the preview lists rows left out and stores nothing; confirming registers and imports", async () => {
  await withServer(async (h) => {
    const bad = await h.multipart("/app/import/source/preview", { source_id: "new", name: "Prices (TEST)", key_columns: "item_code", value_columns: "unit_price", max_age_days: "30", csv: "code,price\nA,1\n" });
    assert.equal(bad.status, 200);
    assert.match(bad.text, /This file cannot be imported[\s\S]*no column named item_code, unit_price/);
    assert.doesNotMatch(bad.text, /name="csv_b64"/, "no way to save what cannot be imported");
    const noName = await h.multipart("/app/import/source/preview", { source_id: "new", name: "", key_columns: "item_code", value_columns: "unit_price", csv: "item_code,unit_price\nA,1\n" });
    assert.equal(noName.status, 422);
    const csv = "item_code,unit_price\nHX-200,\"1,180.00\"\nCAL-1Y,300.00\nFX-9,=B4*1.1\n";
    const preview = await h.multipart("/app/import/source/preview", { source_id: "new", name: "Prices (TEST)", key_columns: "item_code", value_columns: "unit_price", max_age_days: "30" }, [{ field: "file", name: "prices.csv", bytes: new TextEncoder().encode(csv) }]);
    assert.match(preview.text, /Nothing has been saved yet[\s\S]*register a new trusted source[\s\S]*Rows left out[\s\S]*formula with no computed result[\s\S]*Import 2 row\(s\)/);
    assert.equal(h.app.projects.listSources().length, 0, "the preview registers nothing");
    const pick = (n: string): string => new RegExp(`name="${n}" value="([^"]*)"`).exec(preview.text)![1]!;
    const saved = await h.form("/app/import/source", { source_id: "new", file_name: pick("file_name"), csv_b64: pick("csv_b64"), name: pick("name"), key_columns: pick("key_columns"), value_columns: pick("value_columns"), max_age_days: pick("max_age_days") });
    assert.equal(saved.status, 303);
    const src = h.app.projects.listSources()[0]!;
    assert.deepEqual(src.latest!.rows.map((r) => [r.key.item_code, r.values.unit_price]), [["HX-200", "1180.00"], ["CAL-1Y", "300.00"]]);
    assert.match((await h.page(saved.location)).text, /Imported 2 row\(s\); 1 left out[\s\S]*Rows not used[\s\S]*formula with no computed result/);
    // A new version of the existing source goes through the same preview.
    const v2 = await h.multipart("/app/import/source/preview", { source_id: src.source_id, csv: "item_code,unit_price\nHX-200,1200.00\n" });
    assert.match(v2.text, /new version of <strong>Prices \(TEST\)<\/strong>[\s\S]*Import 1 row/);
    assert.equal(h.app.projects.latestSnapshot(src.source_id)!.rows.length, 2, "still the first version until confirmed");
  });
});

test("the fictional demo loads only into an empty workspace, stays labelled DEMO, and is listed apart from real work", async () => {
  await withServer(async (h) => {
    const loaded = await h.form("/app/demo", {});
    assert.equal(loaded.status, 303);
    const demoProject = h.app.projects.list()[0]!;
    assert.equal(demoProject.is_demo, true);
    assert.match((await h.page(loaded.location)).text, /DEMO DATA\.[\s\S]*fictional demo is loaded/);
    // Loading it again (now not empty) is refused, so demo and real work never mix by accident.
    const again = await h.form("/app/demo", {});
    assert.equal(again.status, 422);
    assert.match(again.text, /DEMO data is only loaded into an empty workspace/);
    // Real work created later is listed apart; DEMO projects are not import or start targets.
    h.app.projects.createProject({ name: "My real project (TEST)", default_work_type: "sales_proposal" }, h.app.localUser);
    const home = await h.page("/");
    assert.match(home.text, /Your projects[\s\S]*My real project \(TEST\)[\s\S]*Fictional demo[\s\S]*\[DEMO\]/);
    assert.match(home.text, /Only in an empty workspace/);
    const hub = await h.page("/import");
    assert.doesNotMatch(hub.text, new RegExp(`value="${demoProject.project_id}"`), "DEMO projects are not offered as import targets");
    const forced = await h.multipart("/app/import/documents/preview", { project_id: demoProject.project_id }, [{ field: "files", name: "Mine.md", bytes: quote() }]);
    assert.equal(forced.status, 422);
    assert.match(forced.text, /DEMO projects are fictional/);
    assert.match((await h.page(`/start?project=${demoProject.project_id}`)).text, /not one of your own projects/);
  });
});

test("every screen still renders inside the new layout: sidebar navigation, project navigation, check page", async () => {
  await withServer(async (h) => {
    const p = h.app.projects.createProject({ name: "Layout (TEST)", default_work_type: "sales_proposal" }, h.app.localUser);
    const overview = await h.page(`/projects/${p.project_id}`);
    assert.match(overview.text, /<nav aria-label="Workspace">[\s\S]*<nav aria-label="Project">[\s\S]*aria-current="page">Overview/);
    assert.match(overview.text, /Next step[\s\S]*Add your first document/);
    const check = await h.page(`/projects/${p.project_id}/check`);
    assert.match(check.text, /<h1>Check a file<\/h1>[\s\S]*enctype="multipart\/form-data"/);
    assert.match(overview.text, /href="\/projects\/[^"]+\/check">Check a file/, "the overview's main action leads to a page that works without script");
  });
});
