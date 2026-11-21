/**
 * Format adapters (docs/05). An adapter turns bytes into a normalized, typed
 * artifact with provenance and a coverage report. Obligations: deterministic,
 * total (every declared component is reported), addressed (locators), inert (no
 * macros, no network, no writes), bounded.
 *
 * Phase 1 MVP boundary - what is REAL here:
 *   - `text-labelled`  Markdown / plain text with labelled values and one pipe
 *                      table, for the sales-proposal work type.
 *   - `cl-artifact-json` FIXTURE/IMPORT adapter: accepts an already-normalized
 *                      `cl.artifact/1` document (the design examples, test corpora).
 * What is declared but UNAVAILABLE (typed error, verdict Couldn't verify):
 *   - DOCX, XLSX, PDF, PPTX and anything unrecognized.
 */
import { problems } from "../contracts/schemas.ts";
import { NotImplementedYet, Unavailable, ValidationError } from "../domain/errors.ts";
import type { ArtifactField, ArtifactType, ContentBlock, CoverageState, Location, NormalizedArtifact, TypedValue } from "../domain/types.ts";

export type Identity = NormalizedArtifact["identity"];
export type ParsedArtifact = Pick<NormalizedArtifact, "artifact_type" | "parser" | "coverage" | "content" | "fields" | "risk_flags">;

export interface FormatCapability {
  adapter_id: string;
  version: string;
  accepts: string[];
  artifact_type: ArtifactType;
  locator_scheme: string;
  /** The best the adapter can do per component (docs/05 §10). */
  components: Record<string, CoverageState>;
  extraction_methods: string[];
  limits: { max_bytes: number; timeout_ms: number };
  availability: "implemented" | "unavailable";
  /** True for adapters that exist for fixtures and tests, not for end-user files. */
  fixture_only: boolean;
}

export interface FormatAdapter {
  capability: FormatCapability;
  parse(input: { bytes: Uint8Array; name: string; work_type: string }): ParsedArtifact;
}

const MAX_BYTES = 5 * 1024 * 1024;
const extOf = (name: string): string => (name.includes(".") ? name.slice(name.lastIndexOf(".")).toLowerCase() : "");

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** A file extension is a claim, not a fact (docs/05 §2). */
export function identify(bytes: Uint8Array, name: string): Identity {
  const ext = extOf(name);
  const starts = (sig: number[]): boolean => sig.every((b, i) => bytes[i] === b);
  let detected: string;
  let detection: Identity["detection"] = "signature";
  if (starts([0x50, 0x4b, 0x03, 0x04])) detected = "zip_package"; // docx/xlsx/pptx: telling them apart needs container inspection (Phase 2)
  else if (starts([0x25, 0x50, 0x44, 0x46])) detected = "pdf";
  else {
    const text = decodeUtf8(bytes);
    detection = "structural";
    if (text === null) detected = "unrecognized";
    else if (/^\s*\{[\s\S]*"schema_version"\s*:\s*"cl\.artifact\/1"/.test(text)) detected = "cl_artifact_json";
    else detected = ext === ".md" || ext === ".markdown" ? "markdown" : "text";
  }
  const expected: Record<string, string[]> = {
    zip_package: [".docx", ".docm", ".xlsx", ".xlsm", ".pptx"], pdf: [".pdf"], cl_artifact_json: [".json"], markdown: [".md", ".markdown"], text: [".txt", ".text", ""],
  };
  return { declared_extension: ext, detected_type: detected, detection, extension_matches: (expected[detected] ?? []).includes(ext) };
}

// ---------------------------------------------------------------- text-labelled
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

export function parseMoney(text: string): TypedValue {
  const t = text.trim();
  const iso = /^([A-Z]{3})\s?(-?[\d,]+(?:\.\d+)?)$/.exec(t);
  if (iso) return { type: "money", amount: iso[2]!.replace(/,/g, ""), currency: iso[1]! };
  // A bare "$" is not a currency (docs/05 §3, AT-F6): keep the amount, leave the currency unstated.
  const bare = /^\$\s?(-?[\d,]+(?:\.\d+)?)$/.exec(t);
  if (bare) return { type: "money", amount: bare[1]!.replace(/,/g, "") };
  return { type: "unknown", reason: `"${t}" is not an amount this reader understands (write a currency code and a number, e.g. SGD 1,650.00)` };
}

export function parseDate(text: string): TypedValue {
  const t = text.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return { type: "date", date: t };
  const m = /^(\d{1,2}) ([A-Za-z]+) (\d{4})$/.exec(t);
  const month = m ? MONTHS.indexOf(m[2]!.toLowerCase()) : -1;
  if (m && month >= 0) return { type: "date", date: `${m[3]}-${String(month + 1).padStart(2, "0")}-${m[1]!.padStart(2, "0")}` };
  // "03/04/2026" is two different dates: never guessed.
  return { type: "unknown", reason: `"${t}" is not an unambiguous date (write 12 January 2027 or 2027-01-12)` };
}

const LABELS: Array<{ re: RegExp; path: string; parse: (s: string) => TypedValue }> = [
  { re: /^customer\s*:\s*(.+)$/i, path: "customer.name", parse: (s) => ({ type: "text", text: s.trim() }) },
  { re: /^quote reference\s*:\s*(.+)$/i, path: "quote.reference", parse: (s) => ({ type: "text", text: s.trim() }) },
  { re: /^valid until\s*:\s*(.+)$/i, path: "quote.valid_until", parse: parseDate },
];
const INSTRUCTION_LIKE = /\b(ignore (all |the |any )?(previous|prior|above|pricing)[a-z ]* (rules|instructions)|pre-approved|from now on,? always|do not check)\b/i;

const TEXT_COMPONENTS: Record<string, { best: CoverageState; content_bearing: boolean }> = {
  "body.text": { best: "parsed", content_bearing: true }, "body.tables": { best: "parsed", content_bearing: true },
  headers_footers: { best: "parsed", content_bearing: true }, footnotes: { best: "parsed", content_bearing: true },
  text_boxes: { best: "parsed", content_bearing: true }, comments: { best: "parsed", content_bearing: false },
  tracked_changes: { best: "parsed", content_bearing: false }, hidden_text: { best: "parsed", content_bearing: true },
  "embedded.objects": { best: "parsed", content_bearing: true }, text_in_images: { best: "detected_not_parsed", content_bearing: true },
  macros: { best: "parsed", content_bearing: false }, external_links: { best: "detected_not_parsed", content_bearing: false },
};

function parseTextLabelled(input: { bytes: Uint8Array; name: string; work_type: string }): ParsedArtifact {
  if (input.bytes.length > MAX_BYTES) throw new Unavailable("formats.text-labelled.size", "the file is larger than this reader accepts");
  const text = decodeUtf8(input.bytes);
  if (text === null) throw new Unavailable("formats.text-labelled.encoding", "the file is not UTF-8 text");
  const blocks: ContentBlock[] = [];
  const fields: ArtifactField[] = [];
  const field = (path: string, value: TypedValue, loc: Location, method: ArtifactField["method"]): void => {
    fields.push({ path, value, method, confidence: 1, locations: [loc] });
  };
  let table = 0;
  let row = 0;
  let header: string[] | null = null;
  let lineItem = 0;
  let hasImage = false;
  let hasLink = false;
  let instructionLike: Location | null = null;
  const lines = text.split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = raw.trim();
    const n = i + 1;
    if (!line) {
      header = null;
      return;
    }
    if (/!\[[^\]]*\]\([^)]*\)/.test(line)) hasImage = true;
    if (/\[[^\]]+\]\([^)]+\)|https?:\/\//.test(line)) hasLink = true;
    if (line.startsWith("|")) {
      const cells = line.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      if (cells.every((c) => /^:?-{2,}:?$/.test(c))) return; // separator row
      if (!header) {
        table++;
        row = 0;
      }
      row++;
      const locator = `text:/table[${table}]/row[${row}]`;
      const label = `Table ${table}, row ${row} (line ${n})`;
      blocks.push({ locator, kind: "table_row", text: cells.join(" | "), label });
      if (!header) {
        header = cells.map((c) => c.toLowerCase());
        return;
      }
      if (input.work_type !== "sales_proposal") return;
      const col = (name: string): number => header!.findIndex((h) => h === name);
      const [cItem, cQty, cUnit, cAmount] = [col("item"), col("qty"), col("unit price"), col("amount")];
      if (cItem < 0 || cUnit < 0 || cAmount < 0) return; // not the pricing table this mapping knows
      const cellLoc = (c: number, what: string): Location => ({ locator: `${locator}/cell[${c + 1}]`, label: `${label}, ${what}` });
      if (/^total$/i.test(cells[cItem] ?? "")) {
        field("quote.total", parseMoney(cells[cAmount] ?? ""), cellLoc(cAmount, "Total"), "mapping");
        return;
      }
      const base = `quote.line_items[${lineItem++}]`;
      const unit = parseMoney(cells[cUnit] ?? "");
      const amount = parseMoney(cells[cAmount] ?? "");
      field(`${base}.item_code`, { type: "text", text: (cells[cItem] ?? "").split(/\s+/)[0] ?? "" }, cellLoc(cItem, "Item"), "mapping");
      if (cQty >= 0) field(`${base}.quantity`, /^\d+(\.\d+)?$/.test(cells[cQty] ?? "") ? { type: "number", number: cells[cQty]! } : { type: "unknown", reason: "the quantity is not a number" }, cellLoc(cQty, "Qty"), "mapping");
      field(`${base}.unit_price`, unit, cellLoc(cUnit, "Unit price"), "mapping");
      field(`${base}.amount`, amount, cellLoc(cAmount, "Amount"), "mapping");
      const currencies = [unit, amount].map((m) => (m.type === "money" ? m.currency : undefined));
      const currency: TypedValue = currencies[0] && currencies[0] === currencies[1]
        ? { type: "text", text: currencies[0] }
        : { type: "unknown", reason: "the line's currency is not stated unambiguously (write a currency code such as SGD on both amounts)" };
      field(`${base}.currency`, currency, { locator, label }, "mapping");
      return;
    }
    header = null;
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const locator = `text:/line[${n}]`;
    const label = `Line ${n}`;
    blocks.push({ locator, kind: heading ? "heading" : "paragraph", text: heading ? heading[2]! : line, label });
    if (!instructionLike && INSTRUCTION_LIKE.test(line)) instructionLike = { locator, label };
    for (const l of LABELS) {
      const m = l.re.exec(line);
      if (m && !fields.some((f) => f.path === l.path)) field(l.path, l.parse(m[1]!), { locator, label }, "pattern");
    }
  });
  const coverage = Object.entries(TEXT_COMPONENTS).map(([component, c]) => {
    let state: CoverageState = "absent";
    if (component === "body.text") state = "parsed";
    else if (component === "body.tables") state = table > 0 ? "parsed" : "absent";
    else if (component === "text_in_images" && hasImage) state = "detected_not_parsed";
    else if (component === "external_links" && hasLink) state = "detected_not_parsed";
    return { component, state, content_bearing: c.content_bearing };
  });
  const risk_flags: NonNullable<ParsedArtifact["risk_flags"]> = [];
  if (instructionLike) risk_flags.push({ flag: "instruction_like_text", count: 1, locations: [instructionLike], detail: "The file contains text that reads like an instruction. It is treated as content, never as a rule." });
  if (hasLink) risk_flags.push({ flag: "external_links", detail: "Links are not followed." });
  return { artifact_type: "document", parser: { id: TEXT_LABELLED.adapter_id, version: TEXT_LABELLED.version }, coverage, content: { blocks }, fields, risk_flags };
}

const TEXT_LABELLED: FormatCapability = {
  adapter_id: "text-labelled", version: "0.1.0", accepts: ["markdown", "text"], artifact_type: "document", locator_scheme: "text",
  components: Object.fromEntries(Object.entries(TEXT_COMPONENTS).map(([k, v]) => [k, v.best])), extraction_methods: ["structural", "mapping", "pattern"],
  limits: { max_bytes: MAX_BYTES, timeout_ms: 20000 }, availability: "implemented", fixture_only: false,
};

// ---------------------------------------------------------------- fixture import
const JSON_FIXTURE: FormatCapability = {
  adapter_id: "cl-artifact-json", version: "0.1.0", accepts: ["cl_artifact_json"], artifact_type: "document", locator_scheme: "any",
  components: {}, extraction_methods: [], limits: { max_bytes: MAX_BYTES, timeout_ms: 20000 }, availability: "implemented", fixture_only: true,
};

function parseArtifactJson(input: { bytes: Uint8Array }): ParsedArtifact {
  const doc = JSON.parse(decodeUtf8(input.bytes) ?? "null") as NormalizedArtifact;
  const found = problems("artifact", doc);
  if (found.length) throw new ValidationError("normalized artifact", found);
  // Parser identity is the fixture's own: results name the reader that produced the fields.
  return { artifact_type: doc.artifact_type, parser: doc.parser, coverage: doc.coverage, content: doc.content, fields: doc.fields, ...(doc.risk_flags ? { risk_flags: doc.risk_flags } : {}) };
}

// ---------------------------------------------------------------- declared, unavailable
const unavailable = (adapter_id: string, accepts: string[], artifact_type: ArtifactType, contract: string, what: string): FormatAdapter => ({
  capability: {
    adapter_id, version: "0.0.0", accepts, artifact_type, locator_scheme: adapter_id.split("-")[0]!, components: {}, extraction_methods: [],
    limits: { max_bytes: 52428800, timeout_ms: 20000 }, availability: "unavailable", fixture_only: false,
  },
  parse: () => {
    throw new NotImplementedYet(contract, what);
  },
});

export const FORMAT_ADAPTERS: readonly FormatAdapter[] = Object.freeze([
  { capability: TEXT_LABELLED, parse: parseTextLabelled },
  { capability: JSON_FIXTURE, parse: parseArtifactJson },
  unavailable("docx-core", ["zip_package"], "document", "formats.docx.parse", "reading DOCX / XLSX / PPTX packages (container inspection and parsing)"),
  unavailable("pdf-digital", ["pdf"], "pdf", "formats.pdf.parse", "reading PDF files"),
]);

export interface ReadResult {
  identity: Identity;
  artifact_type: ArtifactType;
  parsed: ParsedArtifact | null;
  /** Set when the file could not be read. The check is then Couldn't verify - never a partial pass. */
  error: { code: string; message: string } | null;
}

/** Identify and normalize. Never throws for unreadable input: the failure is data. */
export function readArtifact(bytes: Uint8Array, name: string, workType: string, adapters: readonly FormatAdapter[] = FORMAT_ADAPTERS): ReadResult {
  const identity = identify(bytes, name);
  const adapter = adapters.find((a) => a.capability.accepts.includes(identity.detected_type));
  if (!adapter) return { identity, artifact_type: "document", parsed: null, error: { code: "unsupported_type", message: `This kind of file (${identity.detected_type}) is not supported, so it could not be checked.` } };
  try {
    const parsed = adapter.parse({ bytes, name, work_type: workType });
    if (!identity.extension_matches) {
      parsed.risk_flags = [...(parsed.risk_flags ?? []), { flag: "extension_mismatch", detail: `The file is named ${identity.declared_extension || "(no extension)"} but its content is ${identity.detected_type}.` }];
    }
    return { identity, artifact_type: parsed.artifact_type, parsed, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { identity, artifact_type: adapter.capability.artifact_type, parsed: null, error: { code: error instanceof Unavailable ? "unavailable" : "unreadable", message } };
  }
}
