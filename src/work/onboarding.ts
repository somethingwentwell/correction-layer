/**
 * Getting started and importing existing work (first-run guidance).
 *
 * Two operations on documents, both built on the existing services:
 *   preview  - read uploaded files with the real format adapters and say, per
 *              file, what this build understood, whether it can be checked, and
 *              what saving it would do (new document, new version of an existing
 *              one, or nothing because it is identical). Stores NOTHING.
 *   import   - store the previewed files as artifact versions through
 *              `CheckService.observe`. Never overwrites: an existing name gets a
 *              new version (history kept) or, if the person asks, a distinct
 *              name. Content must match the previewed hash exactly.
 *
 * Supported: UTF-8 Markdown and plain text (.md, .markdown, .txt). Everything else
 * is refused here with the reason and the supported alternative; it is never
 * presented as readable work. This build cannot import other apps' databases or
 * connect to chat or email apps.
 */
import { sha256 } from "../domain/canonical.ts";
import { Conflict, ValidationError } from "../domain/errors.ts";
import type { Actor } from "../domain/types.ts";
import { readArtifact } from "../formats/adapters.ts";
import type { App } from "../app.ts";
import { valueText } from "./diff.ts";

export const MAX_IMPORT_FILES = 20;
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
export const SUPPORTED_IMPORT = "Markdown (.md) or plain text (.txt), UTF-8";
export const UNSUPPORTED_ADVICE: Readonly<Record<string, string>> = Object.freeze({
  zip_package: "Word, Excel and PowerPoint files cannot be read in this build. Save the document as Markdown or plain text (in Word: File > Save As > Plain Text) and import that. For price lists, export the sheet as CSV and import it as a trusted source.",
  pdf: "PDF files cannot be read in this build. Copy the text into a .txt or .md file and import that.",
  unrecognized: "This file is not text this build can read. Import Markdown or plain text (UTF-8).",
  cl_artifact_json: "This is a test-fixture format, not a document. Import the document itself as Markdown or plain text.",
});

export interface DocumentPreview {
  name: string;
  size: number;
  hash: string;
  importable: boolean;
  detected_type: string;
  problem: string | null;
  understood: Array<{ what: string; value: string }>;
  line_items: number;
  warnings: string[];
  existing: { artifact_id: string; latest_seq: number; identical_to: number | null } | null;
  /** What saving would do. */
  outcome: "new_document" | "new_version" | "unchanged" | "refused";
}

const NAME_RE = /^[^\\/\x00-\x1f]{1,200}$/;

export function cleanName(name: string): string {
  const base = (name ?? "").split(/[\\/]/).pop()!.trim();
  if (!NAME_RE.test(base) || base === "." || base === "..") throw new ValidationError("document", ["name: a file name of 1 to 200 characters, without folders"]);
  return base;
}

export function previewDocuments(app: App, projectId: string | null, files: Array<{ name: string; bytes: Uint8Array }>): DocumentPreview[] {
  if (!files.length) throw new ValidationError("import", ["choose at least one file, or paste a document"]);
  if (files.length > MAX_IMPORT_FILES) throw new ValidationError("import", [`at most ${MAX_IMPORT_FILES} files at a time`]);
  const workType = projectId ? app.projects.get(projectId).default_work_type : "sales_proposal";
  return files.map((f) => {
    const name = cleanName(f.name);
    const hash = sha256(f.bytes);
    const base: Omit<DocumentPreview, "importable" | "problem" | "outcome"> = { name, size: f.bytes.length, hash, detected_type: "unrecognized", understood: [], line_items: 0, warnings: [], existing: null };
    if (f.bytes.length === 0) return { ...base, importable: false, problem: "The file is empty.", outcome: "refused" };
    if (f.bytes.length > MAX_IMPORT_BYTES) return { ...base, importable: false, problem: "The file is larger than 5 MB.", outcome: "refused" };
    const read = readArtifact(f.bytes, name, workType);
    base.detected_type = read.identity.detected_type;
    if (!read.parsed || !["markdown", "text"].includes(read.identity.detected_type)) {
      return { ...base, importable: false, problem: `Couldn't verify: not supported. ${UNSUPPORTED_ADVICE[read.identity.detected_type] ?? UNSUPPORTED_ADVICE.unrecognized}`, outcome: "refused" };
    }
    const field = (path: string) => read.parsed!.fields.find((x) => x.path === path);
    for (const [path, what] of [["customer.name", "Customer"], ["quote.reference", "Quote reference"], ["quote.valid_until", "Valid until"], ["quote.total", "Total"]] as const) {
      const v = field(path);
      if (v) base.understood.push({ what, value: valueText(v.value) });
    }
    base.line_items = new Set(read.parsed.fields.filter((x) => x.path.startsWith("quote.line_items[")).map((x) => x.path.split("]")[0])).size;
    if (!base.line_items) base.warnings.push("No pricing table was found (a table with Item, Unit price and Amount columns). Price and currency rules will report Couldn't verify for this document.");
    for (const x of read.parsed.fields.filter((y) => y.value.type === "unknown")) base.warnings.push(`${x.locations[0]?.label ?? x.path}: ${x.value.reason}`);
    for (const r of read.parsed.risk_flags ?? []) if (r.flag !== "external_links") base.warnings.push(r.detail ?? r.flag);
    const gaps = read.parsed.coverage.filter((c) => c.content_bearing && c.state === "detected_not_parsed").map((c) => c.component.replace(/_/g, " "));
    if (gaps.length) base.warnings.push(`Not read: ${gaps.join(", ")}. A release check cannot be Ready while content is unread.`);
    if (projectId) {
      const a = app.db.prepare("SELECT artifact_id FROM artifacts WHERE project_id = ? AND name = ?").get(projectId, name) as { artifact_id: string } | undefined;
      if (a) {
        const versions = app.checks.versions(a.artifact_id);
        const same = versions.find((v) => v.content_hash === hash);
        base.existing = { artifact_id: a.artifact_id, latest_seq: versions.at(-1)?.version_seq ?? 0, identical_to: same?.version_seq ?? null };
      }
    }
    const outcome = !base.existing ? "new_document" : base.existing.identical_to !== null ? "unchanged" : "new_version";
    return { ...base, importable: true, problem: null, outcome };
  });
}

/** A name not yet used in the project: "Quote.md" -> "Quote (2).md". */
export function distinctName(app: App, projectId: string, name: string): string {
  const taken = (n: string): boolean => !!app.db.prepare("SELECT 1 FROM artifacts WHERE project_id = ? AND name = ?").get(projectId, n);
  if (!taken(name)) return name;
  const dot = name.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let i = 2; i < 1000; i++) if (!taken(`${stem} (${i})${ext}`)) return `${stem} (${i})${ext}`;
  throw new Conflict("name_taken", "no free name could be found for this document");
}

export interface ImportResult {
  name: string;
  stored_as: string;
  artifact_id: string;
  version_seq: number;
  outcome: "new_document" | "new_version" | "kept_both" | "unchanged";
}

/**
 * Store previewed documents in a project. A person's act. Each file must still hash
 * to what the preview showed. Nothing existing is ever replaced.
 */
export function importDocuments(app: App, projectId: string, files: Array<{ name: string; bytes: Uint8Array; expected_hash: string }>, onExisting: "new_version" | "keep_both", actor: Actor): ImportResult[] {
  if (actor.kind !== "human") throw new ValidationError("import", ["importing is done by a person in the app"]);
  const project = app.projects.get(projectId);
  if (project.is_demo) throw new ValidationError("import", ["DEMO projects are fictional. Import your real work into a project of your own."]);
  const previews = previewDocuments(app, projectId, files);
  const refused = previews.filter((p) => !p.importable);
  if (refused.length) throw new ValidationError("import", refused.map((p) => `${p.name}: ${p.problem}`));
  files.forEach((f, i) => {
    if (previews[i]!.hash !== f.expected_hash) throw new Conflict("content_changed", `${previews[i]!.name} is not the content that was previewed; preview it again`);
  });
  return previews.map((p, i) => {
    if (p.outcome === "unchanged") return { name: p.name, stored_as: p.name, artifact_id: p.existing!.artifact_id, version_seq: p.existing!.identical_to!, outcome: "unchanged" as const };
    const keepBoth = p.outcome === "new_version" && onExisting === "keep_both";
    const storedAs = keepBoth ? distinctName(app, projectId, p.name) : p.name;
    const v = app.checks.observe({ project_id: projectId, name: storedAs, bytes: files[i]!.bytes, declared_by: actor });
    return { name: p.name, stored_as: storedAs, artifact_id: v.artifact_id, version_seq: v.version_seq, outcome: keepBoth ? "kept_both" as const : p.outcome === "new_version" ? "new_version" as const : "new_document" as const };
  });
}

/** A fictional example in the layout this build reads, offered on the start screen. Labelled as an example. */
export const EXAMPLE_QUOTE = `# Quote for Example Customer (EXAMPLE - replace with your own)

Customer: Example Customer
Quote reference: EX-0001
Valid until: 31 March 2027

| Item | Qty | Unit price | Amount |
|------|-----|------------|--------|
| AB-100 Example item | 2 | USD 100.00 | USD 200.00 |
| Total | | | USD 200.00 |
`;
