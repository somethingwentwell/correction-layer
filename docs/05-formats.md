# 05 · Artifact formats

> Proposed design. Nothing in this document is implemented. The support matrix states intent by phase, not current capability.

## 1. Principles

1. **Rules are written against meaning, not file formats.** "Unit prices match the price list" should not care whether the price sits in a Word table, a spreadsheet cell or a PDF. Format adapters turn files into one normalized, typed artifact; rules read that.
2. **Every value keeps its address.** Anything a rule reads can be traced back to a cell, a table row, a paragraph or a page region, so findings can say *where*.
3. **Reading is not understanding.** Extracting text is one step; knowing that a number is "the unit price of line 2" is another. The second step is done by human-confirmed mappings, not by guesswork.
4. **What could not be read is reported, not ignored.** Every artifact carries a coverage report. Unread parts lead to *Couldn't verify*, never to a silent pass.
5. **Narrow first.** The MVP reads word-processor proposals well and uses spreadsheets as trusted sources. Other formats are phased, and the product says "not supported yet" where that is the truth.

## 2. Identifying what a file really is

A file extension is a claim, not a fact. Identification uses, in order:

1. **Content signature** (leading bytes).
2. **Container inspection** for package formats: a `.docx`, `.xlsx` or `.pptx` is a ZIP package whose internal manifest states what it is; a `.docx` whose manifest says spreadsheet is a spreadsheet.
3. **Structural sanity**: the main part parses.

Outcomes:

| Case | Result |
|------|--------|
| Signature, container and extension agree | Detected type recorded with `detection` method |
| Extension disagrees with content (e.g. `.pdf` that is actually HTML, `.csv` that is a spreadsheet package) | Treated as the detected type; a risk flag `extension_mismatch` is raised and shown |
| Macro-enabled or template variants (`.docm`, `.xlsm`) | Detected as such; macros are never executed; presence is a risk flag |
| Encrypted or password-protected | `error`: cannot be read; verdict *Couldn't verify* with instructions |
| Unrecognized | Unsupported type; verdict *Couldn't verify* for any gated action |

The detected type and method are part of the normalized artifact (`identity`) and appear under "Details" on a review.

## 3. The normalized artifact

Proposed shape: [artifact.schema.json](../schemas/artifact.schema.json). Example: [artifact-v1.json](../examples/sales-proposal/artifact-v1.json).

| Part | Contents |
|------|----------|
| **Envelope** | `artifact_id`, version (`seq`, `content_hash`, size, observed time), `identity` (declared extension, detected type, how detected), `artifact_type` class, `parser` id and version, `schema_version` |
| **Coverage** | One entry per component the format can contain, with a state (§8) |
| **Content tree** | Format-neutral blocks: sections, headings, paragraphs, tables, rows, cells, pages, sheets, records. Each block has a locator, a kind and its text or typed value |
| **Fields** | Semantic values for the work type (`quote.total`, `quote.line_items[0].unit_price`), each with a typed value, the extraction method, a confidence, and the locators it came from |
| **Risk flags** | Things worth knowing regardless of rules: hidden text, unresolved comments, tracked changes, macros present, external links, extension mismatch, text inside images |

A field entry, as it appears in a normalized artifact:

```json
{
  "path": "quote.line_items[0].unit_price",
  "value": { "type": "money", "amount": "1180.00", "currency": "USD" },
  "method": "mapping",
  "confidence": 1.0,
  "mapping_id": "map_SALESPRP1",
  "locations": [
    { "locator": "docx:/body/tbl[2]/row[2]/cell[3]", "label": "Pricing table, row 1, Unit price (page 3)" }
  ]
}
```

Typed values: `text`, `number` (decimal string, never binary floating point), `money` (amount plus ISO 4217 currency), `percent`, `date` (ISO 8601), `boolean`, `list`. Typing is where many real mistakes are caught honestly:

- A bare "$" is not a currency. Unless the mapping or project declares what "$" means, the currency is `unknown` and a currency rule returns *Couldn't verify* with the advice "write SGD or S$".
- "1.180,00" and "1,180.00" are different conventions. The mapping declares the document's number format; an ambiguous number is `unknown`.
- "03/04/2026" is two different dates. Unless the format is declared or unambiguous, it is `unknown`.

## 4. Locators and provenance

Every block and every field carries one or more **locations**: a machine locator and a human label.

| Format | Locator examples | Human label |
|--------|------------------|-------------|
| Word-processor document | `docx:/body/tbl[2]/row[2]/cell[3]`, `docx:/body/p[41]`, `docx:/header[1]/p[1]` | "Pricing table, row 1, Unit price (page 3)" |
| Spreadsheet | `xlsx:/sheet[Payments]/cell[D14]`, `xlsx:/sheet[Payments]/range[A2:F40]` | "Payments sheet, cell D14" |
| PDF | `pdf:/page[3]/region[72,340,310,362]` | "Page 3, lower left" plus a highlight |
| Record | `record:/row[12]/field[amount]` | "Row 12, Amount" |
| Slide deck | `pptx:/slide[4]/shape[2]/p[1]` | "Slide 4, text box 2" |

Notes:

- **Labels prefer structure over layout.** "Pricing table, row 1" is stable; a page number in a word-processor file depends on fonts and printer settings. Page numbers are shown when the file carries layout hints and are labelled approximate otherwise.
- **Positions shift between versions.** For comparing runs and versions, a finding is keyed by rule plus field path (e.g. `quote.line_items[0].unit_price`) where a field exists, and by locator plus a text fingerprint otherwise. That is what allows "this finding is no longer present" to be computed after rows are inserted above it.
- **Source rows have locations too.** A finding from a source-backed rule shows the row of the trusted source that supplied the expected value ("Halden price list, row 14").

## 5. Semantic fields and how they are extracted

A **work type** defines a small *field dictionary*: the named, typed values that rules for that kind of work talk about. For `sales_proposal`:

| Field | Type |
|-------|------|
| `customer.name` | text |
| `quote.reference`, `quote.date`, `quote.valid_until` | text, date, date |
| `quote.line_items[].item_code`, `.description`, `.quantity` | text, text, number |
| `quote.line_items[].unit_price`, `.amount`, `.currency` | money, money, text |
| `quote.total` | money |
| `quote.discount_percent` | percent |
| `sections[].heading` | text |

A **field mapping** says how to find those fields in a particular document layout. It is created by the "teach by pointing" step ([UX-4](01-product-ux.md#ux-4--check-the-first-artifact)) and stored per project or workspace:

- "The pricing table is the table whose header row contains *Item*, *Qty*, *Unit price*, *Amount*."
- "Item code is the leading token of the Item column."
- "The total is the last row whose first cell is *Total*."
- "The validity date follows the label *Valid until*."

Mappings are declarative (header patterns, labels, positions relative to anchors), human-confirmed, versioned, and themselves covered by the rule examples. When a mapping's anchors are not found in a document, the fields are `unknown` and the user is offered the pointing step again. The mapping is not stretched to fit.

How a value was obtained determines what it can be used for:

| Method | How | Can it satisfy a must-pass rule? |
|--------|-----|----------------------------------|
| `structural` | Read from the file's own explicit structure: form fields, content controls, defined names, record columns | Yes |
| `mapping` | Located by a human-confirmed mapping | Yes |
| `pattern` | A typed recognizer (money, date, percent) applied inside a mapped region | Yes when unambiguous; otherwise the value is `unknown` |
| `ocr` | Recognized from an image, with a confidence per token | Only at or above the confidence threshold; below it, a person must confirm |
| `model_suggested` | Proposed by an AI model | **No.** It is a suggestion shown to a person |
| `human_confirmed` | A person compared the suggested value with the visible document and confirmed it, for this exact version | Yes; recorded as an attestation |

This is the format-side half of "AI cannot infer semantics unchecked": a model may help a person set up a mapping or read a messy scan faster, but a must-pass rule is never satisfied by a value only a model vouches for. See [ADR-008](09-decisions.md#adr-008--semantic-fields-come-from-human-confirmed-mappings-model-extracted-values-never-satisfy-must-pass-rules).

## 6. Common fields and format-specific checks stay separate

| Layer | Examples | Rules written against it |
|-------|----------|--------------------------|
| **Semantic fields** (format-neutral) | `quote.total`, `payment.rows[].bank_account` | "Total adds up", "Bank account matches the vendor register". These work on any format that can supply the field |
| **Structure** (near-neutral) | Sections, headings, tables, required parts | "Has a Credit terms section" |
| **Format-specific features** | Tracked changes and comments (documents); formulas, hidden rows and sheets (spreadsheets); text layer, form fields, annotations (PDF) | "No unresolved comments", "No hidden rows in the payment sheet", "Totals are formulas, not typed-in numbers" |

A rule declares what it needs (`requires.fields`, `requires.components`). The scope dimension *artifact type* keeps format-specific rules from being evaluated against formats where they are meaningless; if a rule that needs a field is in scope for an artifact whose adapter cannot supply it, the outcome is `unknown`, not a pass.

## 7. Format notes

### 7.1 Word-processor documents (MVP)

- Read: body text, headings, lists, tables (including merged cells), headers and footers, footnotes, text boxes, document properties.
- Detected and reported: comments, tracked insertions and deletions, hidden text, highlighted text, field codes (dates and cross-references that change when opened), embedded objects, linked content, macros.
- **Tracked changes matter for meaning.** A deleted price that is still "in" the file as a tracked deletion is not part of the accepted text. The adapter normalizes the *accepted-all* view and flags that unresolved changes exist; the rule `no_unresolved_markup` can then require a clean document before sending.
- **Field codes** (an auto-updating date, a cross-reference) are read with their cached display text and flagged as dynamic, since the recipient may see a different value.

### 7.2 Spreadsheets (sources in MVP; artifacts next)

Each cell is normalized with four things, because they can all differ:

| Aspect | Meaning |
|--------|---------|
| `formula` | The formula text, if any |
| `value` | The stored result (for a formula, the *cached* result from the last calculation) |
| `display_text` | What a person sees after number formatting ("SGD 1,650.00", "12%", "3 Nov 2026") |
| `value_state` | `literal`, `formula_cached`, `formula_no_cache`, `formula_error`, `external_link_cached` |

Consequences:

- **Formula versus displayed value.** Rules compare typed values; a rule may also require that a total *is a formula* (not typed over) or that the displayed value equals the stored value at the shown precision.
- **Cached results can be stale or missing.** Files written by tools that do not calculate have no cached results; the product does not run a full spreadsheet engine in early phases. A formula cell without a trustworthy cached value is `unknown`. A later phase may recompute a safe subset of functions and report any difference from the cached value as a finding.
- **Currency and units often live only in the number format.** The adapter derives `display_text` so that "SGD" applied by formatting is visible to rules.
- **Hidden content**: hidden and "very hidden" sheets, hidden rows and columns, filtered-out rows, white-on-white text, and data left in pivot caches are detected and listed. A hidden row inside a payment table is still read as data, and flagged.
- **External links** to other workbooks give cached values only; they are flagged, and the cell is `external_link_cached`.
- **Macros** are never run. Their presence is a risk flag.
- **Dates** are converted from serial numbers using the workbook's date system; text that merely looks like a date stays text.

For a *trusted source* spreadsheet the same reading applies, and the import step shows the owner exactly which columns were taken as key and value.

### 7.3 PDF

| Kind | Reading | Honest limits |
|------|---------|---------------|
| **Digital PDF** (has a text layer) | Text with positions per page; tables reconstructed from layout; form field values; annotations listed | Table and reading-order reconstruction is heuristic. Fields located this way carry a confidence below 1 and may need confirmation. Invisible text, text outside the page area and text behind images are detected where possible and flagged; the product cannot prove that the text layer matches what the page *looks* like |
| **Scanned PDF** (images only) | Optical character recognition gives tokens with confidences | Any field containing a token below the threshold is `unknown`. The person is shown the image region beside the recognized value and can confirm it (`human_confirmed`, bound to this version). Thresholds are configuration, to be set from testing, not assumed |
| **Mixed** | Per page | A single scanned page inside a digital PDF is a partially read component |

Embedded files, JavaScript and encryption are detected; attachments are listed as unread components; encrypted files cannot be read.

**Preferred pattern: check the source, release the render (later phase).** A PDF is usually an output of a document. Checks are most reliable on the source format. The intended design is for the gateway itself to render the checked source to PDF and record the PDF's hash as derived from the checked version, so that no one has to trust PDF re-parsing. Rendering fidelity needs its own validation, so this is not in the MVP; until then a PDF is checked as a PDF, with the limits above.

### 7.4 Records and delimited files

Rows with named columns (CSV exports, form submissions, later records fetched by a connector) are the simplest artifacts: each column is a field. Pitfalls handled explicitly: text encoding, delimiter and quoting detection, leading zeros in identifiers (kept as text), decimal and date conventions (declared in the mapping; ambiguous values are `unknown`), duplicate or missing headers (an error, not a guess).

### 7.5 Slide decks, email, images (later)

- **Slides**: text per slide and shape, speaker notes, hidden slides (flagged), charts with their embedded data (which may differ from the picture shown).
- **Email drafts** as artifacts for a send action: headers, body, and each attachment as its own artifact checked in turn. An unreadable attachment is an unread component of the email.
- **Images**: no semantic reading except through the scanned-page path.

## 8. Unread and unsupported components

Each adapter declares every component its format can contain. The normalized artifact reports each one:

| State | Meaning |
|-------|---------|
| `parsed` | Fully read |
| `partial` | Read in part (e.g. 9 of 10 pages have a text layer) |
| `detected_not_parsed` | Present but not read (e.g. an embedded workbook) |
| `unsupported` | The adapter cannot tell whether it is present |
| `absent` | Verified not present |

Two mechanisms ensure unread parts never pass silently:

1. **Per rule.** A rule that needs a component (`requires.components`) returns `unknown` when that component is not `parsed`.
2. **Per run.** Independently of any rule, every run lists **coverage gaps**: content-bearing components that are `partial`, `detected_not_parsed` or `unsupported`. For a gated action, an unacknowledged coverage gap makes the verdict *Couldn't verify*. It is cleared by removing the component, or by a person confirming, for that exact version, that they have reviewed it ("I have reviewed the embedded spreadsheet on page 6"). The confirmation is an attestation event and appears in the timeline.

Content-bearing components (can change what the recipient reads): body text, tables, headers and footers, footnotes, text boxes, embedded objects, text in images, attachments, hidden sheets, speaker notes. Non-content components such as macros and external links are risk flags instead.

The pre-action review always states the reading result in one line: "Everything in the file could be read" or "2 parts could not be read (reviewed by Priya Nair)".

## 9. Support matrix (intent by phase)

Phases refer to [MVP and acceptance §2](08-mvp-and-acceptance.md#2-phases). "—" means not planned in that role.

| Format | As work artifact | As trusted source | Text and structure | Fields via mapping | Hidden/markup detection | Before/after compare | Phase |
|--------|------------------|-------------------|--------------------|--------------------|-------------------------|----------------------|-------|
| DOCX | Yes | — | Yes | Yes | Comments, tracked changes, hidden text, embedded objects (detected) | Text and table cells | 1 (MVP) |
| Markdown, plain text | Yes | — | Yes | Labelled values only | n/a | Text | 1 (MVP) |
| XLSX | Phase 2 | Yes | Values, formulas, formats | Phase 2 | Hidden sheets/rows/columns, external links, macros (detected) | Cells (Phase 2) | 1 as source, 2 as artifact |
| CSV | Phase 2 | Yes | Rows and columns | By column | n/a | Rows (Phase 2) | 1 as source, 2 as artifact |
| PDF, digital | Phase 2 | — | Text by page; heuristic tables | With confidence | Invisible text, attachments, scripts (detected) | Text by page | 2 |
| PDF, scanned | Phase 3 | — | OCR with confidence | With confirmation | n/a | Page images | 3 |
| PPTX | Phase 3 | — | Slides, notes | Limited | Hidden slides, embedded data | Text per slide | 3 |
| Email draft | Phase 3 | — | Headers, body, attachments | Recipients, subject | Attachments recursed | Text | 3 |
| Records via connector | Phase 3 | Phase 3 | Columns | By column | n/a | Fields | 3 |
| Legacy binary (`.doc`, `.xls`), images, other | Not planned | — | — | — | — | — | Reported as unsupported |

"Not supported" is a visible state: the file can be registered and tracked, but any gated action on it is *Couldn't verify* unless a person takes responsibility by attestation where the workspace allows that.

## 10. Adapter contract

A format adapter is a component of the product (not a user plug-in in early phases) with a declared capability record:

```json
{
  "adapter_id": "docx-core",
  "version": "0.1.0",
  "accepts": ["docx", "docm"],
  "artifact_type": "document",
  "locator_scheme": "docx",
  "components": {
    "body.text": "parsed",
    "body.tables": "parsed",
    "headers_footers": "parsed",
    "footnotes": "parsed",
    "text_boxes": "parsed",
    "comments": "parsed",
    "tracked_changes": "parsed",
    "hidden_text": "parsed",
    "field_codes": "partial",
    "embedded.objects": "detected_not_parsed",
    "text_in_images": "detected_not_parsed",
    "macros": "detected_not_parsed",
    "external_links": "detected_not_parsed"
  },
  "extraction_methods": ["structural", "mapping", "pattern"],
  "limits": { "max_bytes": 52428800, "max_expanded_bytes": 524288000, "timeout_ms": 20000 }
}
```

In this declaration each value is the *best* the adapter can do for that component: `parsed` means it can read it; `detected_not_parsed` means it can tell whether it is present but not read it; `unsupported` means it cannot even tell. For a particular file the report then says `absent` where the component is verifiably not there.

Obligations of every adapter:

- **Deterministic**: the same bytes and adapter version give the same normalized artifact (OCR and model-assisted steps are isolated and marked).
- **Total**: every declared component is reported with a state for every artifact; "did not look" must appear as `unsupported`, not as `absent`.
- **Addressed**: every block and field has a locator that the app can turn into a highlight.
- **Inert**: no macro execution, no network access, no following of external references, no writing to the input.
- **Bounded**: size, expansion and time limits; exceeding one is an `error` outcome, never a partial artifact presented as whole.

## 11. Parser safety

Work files arrive from customers and the internet. Adapters treat them as hostile input: archive expansion limits, no external entity resolution, no remote template or image fetching, strict limits on nesting and object counts, and isolation of the parsing step from the store's credentials. A file that trips a limit produces an `error` with a plain explanation. Security aspects are covered in [Security §2](07-security-and-governance.md#2-threat-model).

## 12. Versions and drift

Every normalized artifact, run and receipt records the adapter's id and version. Adapter upgrades are tested against the stored rule examples before taking effect, and receipts issued under the old version are invalidated ([Architecture §11](03-architecture.md#11-versioning-and-drift)). The normalized shape is versioned (`cl.artifact/1`); additions within a major version are backward compatible.
