# Phase 2 coverage report

Phase 2 turned the Phase 1 framework into a **usable local MVP slice for one person on one machine**: the product functions below work together through the app (server-rendered forms) and the loopback API, and each is covered by tests that exercise the real services. It is still not the full MVP of [docs/08-mvp-and-acceptance.md](docs/08-mvp-and-acceptance.md); what is deferred is listed with the reason, and stays a `test.todo` in [test/seed-and-extension-points.test.ts](test/seed-and-extension-points.test.ts).

Authored by Claude Opus 5.5 (`claude-opus-5-5`) in one Claude Code session on branch `impl/phase1-framework`, on top of the Phase 1 commit `265625e`. No AI model is used by the product.

## 1. Build, test, start

Requirements: Node.js 24+, Python 3.8+ (design checker only). No runtime dependencies.

```sh
npm install
npm run verify          # typecheck + build + tests + design checker
npm run dev             # http://127.0.0.1:4319 (loopback only)
CL_SEED_DEMO=1 npm run dev   # with labelled, fictional DEMO data
npm run cli -- capture say --adapter adp_... --outbox ./outbox.jsonl --binding fld_... "Quotes must always be in SGD."
```

Results at the end of Phase 2: type check clean, build clean, **122 tests: 114 pass, 0 fail, 8 todo** (after the UI follow-up in section 6; 116 / 108 / 8 before it), design checker `OK` (unchanged counts: 110 events verified, 8 decisions recomputed). Phase 1 ended at 94 tests: 73 pass, 21 todo.

The store is upgraded in place by migration 2 (additive tables and nullable columns only); a Phase 1 store opens and migrates. The `/healthz` `schema_version` is now 2.

## 2. What Phase 2 implemented

| Area | What a person can do now | Where | Tests |
|------|--------------------------|-------|-------|
| Check kinds | `fields_agree`, `date_window`, `arithmetic_consistency`, `no_unresolved_markup` are evaluated (exact decimal arithmetic, dates relative to the check time, unread comments/tracked changes are `unknown`) | `src/policy/catalogue.ts`, `src/engine/fields.ts` | `test/check-kinds.test.ts` |
| Duplicates and conflicts | Proven statically for allowed sets, numeric bounds, date windows, must/must-not phrases, presence checks. A note-only rule never forces `conflict` on a must-pass rule (it yields) | `relate()`, `src/engine/evaluate.ts` | `test/check-kinds.test.ts` (AT-G5 static half) |
| Manual corrections (UX-7) | Pick one of 10 plain templates, scope (project or one document), consequence; see the rendered sentence, overlapping rules and a dry run on the project's documents; save a candidate; attach a REAL blocking and allowing example; turn on or trial | `src/policy/templates.ts`, `src/policy/authoring.ts`, `/projects/:id/rules/new` | `test/rule-management.test.ts` (AT-G4) |
| Rule lifecycle | Change a rule (new revision, examples re-tested, receipts lapse); pause with a mandatory end date of at most 90 days, resumed on that date with an event; resume; retire; keep | `RuleService.revise/suspend/resume/endDueSuspensions` | `test/rule-management.test.ts` (AT-O3) |
| Exceptions | Ask (anyone, including an assistant); grant, reject, revoke (owner or steward, a person); `waived` with the underlying result; expiry event; bound to one document of one project | `src/policy/exceptions.ts` | `test/rule-management.test.ts` (AT-E7, AT-I4) |
| Learning controls | Automatic pause (direct contradiction by a listed person, two disputes on distinct documents, conflict with a person-approved rule) for learned, unconfirmed rules only; Resume; "this finding is wrong"; "this was a correction" for your own captured messages; "don't learn this"; delete a signal's wording; inbox approve / trial / reject / resume / retire / not a correction | `src/learning/pipeline.ts`, `RuleService.autoPause` | `test/learning-controls.test.ts` (AT-L15, AT-L17 deletion, AT-L19), `test/learning-invariants.test.ts` |
| Compiler patterns | Currency, validity period, totals add up, placeholders, quoted required/forbidden phrase, quoted section heading, required value from a 4-entry field dictionary | `src/learning/compiler.ts` | `test/learning-controls.test.ts` |
| Capture | Registry naming common apps NOT CAPTURED; a command-line adapter with a durable outbox file delivering over loopback HTTP; transcript backfill (marked, capped at the inbox); acknowledging a lost range; retrying a processing dead letter; pairing and revoking adapters in the app | `src/capture/registry.ts`, `src/capture/local-adapter.ts`, `src/cli.ts`, `CaptureIntake.acknowledgeGap/surfaceLabels` | `test/capture-adapter.test.ts` (AT-L6, AT-L3 backfill) |
| Trusted sources | Register a source; import a version from CSV (upload or paste); formula cells, empty values, duplicate keys and malformed rows are reported and never read as zero | `ProjectService.importCsv`, `/sources/:id` | `test/work-and-gate.test.ts` (AT-F7, CSV half) |
| Findings and history | Content diff of passages and values joined to resolved/introduced findings, naming unread parts; re-run as recorded from stored inputs; journey of a correction from stored references | `src/work/diff.ts`, `CheckService.compare/rerun`, `src/work/journey.ts` | `test/work-and-gate.test.ts` (AT-O5, AT-O7), `test/e2e-phase2.test.ts` |
| Proposed vs applied changes | An assistant proposes the next content (`/api/v1/propose_change`) or the engine proposes additive text a rule fully determines; a person applies it (new version, declared by that person, linked to the proposal) and it is rechecked. `report_change` records versions declared by an assistant | `src/work/fixes.ts`, `/fixes/:id` | `test/work-and-gate.test.ts`, `test/api-ui.test.ts` |
| Release sandbox | A person may route a project's releases to a local folder: only after a valid receipt, re-verified bindings and a person's approval and start; exactly the checked bytes; never overwrites; hash verified. Newer-version pause with the person's choice | `localReleaseFolder()`, `Gateway.setReleaseFolder/chooseVersion` | `test/work-and-gate.test.ts` (AT-C9, AT-E1, AT-C3) |
| App | New screens: project settings, trusted source, correction editor, re-run, proposed change, journey. Real controls on rule, check, action, learning, capture screens. Skip link, current-page navigation, focus styles, error pages that say what to do next, file upload. No client-side script | `src/ui/manage.ts`, `src/ui/pages.ts`, `src/ui/html.ts`, `src/api/server.ts` | `test/api-ui.test.ts`, `test/e2e-phase2.test.ts` |

### End-to-end test

`test/e2e-phase2.test.ts` drives the whole journey over loopback HTTP: a correction typed to an assistant is captured by a paired command-line adapter; the corrected version arrives; the rule turns on under the person's learning policy with no click; an old quote checked for release is blocked; an assistant proposes a change (no version, the check still fails); a client without the form token cannot apply it; the person applies it, it is rechecked Ready, requested, approved and released to a local folder whose copy hashes to the receipt; and the journey is reconstructed from stored references and `caused_by` links only, from the person's learning policy to the execution. A second test shows that each Phase 2 policy change (pause, revise, exception, CSV import, approving another rule) makes an outstanding receipt unusable and the gateway refuses it.

Other required behaviours are covered in: restart / replay / duplicate delivery and adapter crash (`test/capture-adapter.test.ts`, plus Phase 1 `test/capture.test.ts`); conflicts (`test/check-kinds.test.ts`, `test/learning-controls.test.ts`); project-switch isolation (Phase 1 AT-L5 in `test/capture.test.ts`, AT-I4 in `test/rule-management.test.ts`); untrusted capture (`markAsCorrection` refuses assistant output; transcripts are never `user_direct`; Phase 1 AT-L7); undo and "don't learn this" (`test/learning-controls.test.ts`, Phase 1 AT-L16).

## 3. Phase 1 todos: converted and remaining

Converted to real passing tests (13 of 21): AT-G4, AT-G5 (static half), AT-C3, AT-C9 / AT-E1, AT-F7 (CSV), AT-L3 (backfill), AT-L6, AT-L15, AT-L17 (deletion), AT-L19, AT-O5 (content), AT-O7, AT-E7.

Remaining as `test.todo` (8), and why:

| Todo | Why it is not done |
|------|--------------------|
| AT-G8 | No reader or engine upgrade path exists to stage. (This is also the "example regression" trigger of AT-L15, which therefore has no source of events yet.) |
| AT-C4 / AT-C5 / AT-C7 / AT-C8 | Folder markers, moved and copied files and folders need filesystem observation; `ProjectService.resolveByMarker` still throws `NotImplementedYet` |
| AT-C6 (second half) | Remembering "check as which project?" per lineage needs content lineage across projects (same reason) |
| AT-F1 (container) to AT-F5 | No DOCX/XLSX reader: the container, locator, mapping, embedded-object and tracked-change suite could not be finished honestly. Zip packages are still identified and reported Couldn't verify. XLSX sources: export to CSV |
| AT-L11 | Recurrence of hand edits needs edit-diff compilation and folder watch, neither of which exists |
| AT-E10 / AT-E11 / AT-E12 | Offline matrix, clock-jump hold and backup/restore were not built |
| AT-I5 / AT-I6 | One workspace per process; no AI translator exists (so there is nothing for the canary to test) |
| AT-U1 to AT-U6, AT-R3 | Need studies with people; not automatable |

## 4. Routes added or changed

Client API (`/api/v1`, every caller is a client actor): `POST /propose_change` (new), `POST /report_change` (was 501; now records a version declared by an assistant), `GET /capabilities` adds `capture_not_connected` and `ai_model`.

Pages: `/projects/:id/settings`, `/projects/:id/rules/new`, `/sources/:id`, `/runs/:id/rerun`, `/fixes/:id`, `/corrections/:id` (now the joined journey); `/projects/:id/rules` accepts `q` and `status`.

App acts (same-origin, form token, the local person): `/app/projects/:id/{check (multipart), facts, folders, sources, rules, release-folder}`, `/app/rules/:id/{examples, change, pause, resume, resume-auto}`, `/app/exceptions`, `/app/exceptions/:id/{grant, reject, revoke}`, `/app/runs/:id/{dispute, propose-fixes}`, `/app/fixes/:id/{apply, dismiss}`, `/app/actions/:id/choose-version`, `/app/inbox/:id/act`, `/app/captures/:id/mark`, `/app/signals/:id/delete-text`, `/app/decisions/:id/suppress`, `/app/capture/adapters`, `/app/capture/adapters/:id/revoke`, `/app/capture/:stream/gaps/:from/acknowledge`, `/app/capture/:stream/dead-letters/:seq/retry`, `/app/sources/:id/import`.

CLI: `correction-layer capture say|agent|flush|backfill|close`.

## 5. Limitations, stated plainly

- **Pattern and semantic limits.** The compiler is a fixed list of English patterns (section 2). It does not understand paraphrases, synonyms, negation beyond a few words, compound requests or other languages; anything else goes to a person as "not compilable". Phrases and headings must be in double quotes. The field dictionary has four entries (quote reference, customer name, valid-until date, total). There is no AI model and no optional model adapter in this build.
- **Formats.** Markdown and plain-text sales quotes only. DOCX, XLSX, PDF and PPTX are Couldn't verify. Sources: CSV only.
- **Capture.** No assistant runtime, chat app, email or office app is connected. The command-line adapter is real (durable outbox, acknowledgements, replay) but it is fed by a person or a hook script the person writes; it says so where it is named. Folder watching does not exist.
- **Release.** The only gated action is release: simulated by default, or a copy to a local folder a person chose. Copying a file by hand is not seen. Send and pay do not exist.
- **Engine proposals** are limited to appending a required phrase or section heading. The product never re-prices, converts currencies, deletes or rewrites text.
- **Deleting wording.** Phase 2 stopped copying a person's words into immutable decision records. Decision records written by a Phase 1 build may still contain the words in their `rationale`; deleting the wording cannot remove those.
- **Event catalogue.** Phase 2 uses only event types already in `schemas/event.schema.json`; removing a suppression therefore has no event and is not offered.
- **One person, one machine.** No sign-in, no client pairing tokens; the same-account caveat of Phase 1 stands. Exceptions are granted by "owner or steward", which in solo mode is the local person.
- **Not measured.** Nothing here is a performance or effectiveness measurement; DEMO data stays fictional and labelled.

## 6. Follow-up: UI polish and first-run guidance

A user-requested follow-up, on the same branch, after `e1cff89`. It changes how the app looks and how a newcomer gets started; it adds no new product capability beyond import previews, and the 8 todos above are unchanged.

**Design system** (`src/ui/html.ts`, CSS at `/assets/app.css`, still no client-side script):

- A sidebar with workspace navigation (All projects, Start new, Import existing, History check) and, inside a project, the project's sections; the current page is marked with `aria-current` and a visible indicator, not colour alone. Under 900px wide it becomes a single column with wrapping navigation.
- The DEMO banner stays on every page that has demo data, shorter and visually separate; the scope note ("Nothing is sent or paid. No AI model is used.") moved to the sidebar.
- Primary, secondary and destructive buttons: acts that reject, retire, undo, revoke, discard, delete or suppress are styled as destructive and keep their words. Badges keep their text marks (`[OK]`, `[X]`, `[?]`), so status never depends on colour.
- Cards, stat tiles, a step indicator, a "Next step" card, success and error flashes, calmer headings, focus outlines, skip link.

**First-run guidance** (`src/ui/start.ts`, `src/work/onboarding.ts`, routes in `src/api/server.ts`):

| Path | What it does | Never does |
|------|--------------|-----------|
| Home `/` (and `/onboarding`) | On an empty workspace: three choices - Start new, Import existing, Try a fictional demo. Later: your projects, the DEMO projects in a separate "Fictional demo" section, and the choices again | Mix demo and real projects |
| Start new `/start` | 1 create the project (name; optional customer fact and folder) - 2 first document, uploaded or pasted, with what the reader understood - 3 optional first rule from a list or from ONE sentence matched against the compiler's fixed patterns, added as a note by the person's click - 4 first check - 5 the result explained, with next actions | Turn learning on, choose a release folder, or guess a sentence it cannot read |
| Import existing `/import` | Markdown / plain-text documents (several files or a paste) into an existing or new project; CSV trusted sources (new or new version). Each goes through a preview that stores nothing; saving re-sends the exact bytes and is refused if they differ from the preview | Overwrite: a same-name document becomes a new version (history kept) or, if chosen, a distinct name like `Quote (2).md`; identical content changes nothing. Read Word, Excel, PDF, other apps' databases or chat/email: these are listed as not supported with the alternative |
| Try a fictional demo | `POST /app/demo` loads the labelled DEMO data, only into an empty workspace | Load into a workspace that has real work; accept DEMO projects as start or import targets |
| Project overview | Quick actions, stat tiles, and one context-aware next step (add a document, check documents not yet checked, add a first rule, answer questions, fix documents that need changes); "check all not yet checked"; a dedicated "Check a file" page | — |

New routes: `GET /start`, `GET /import`, `GET /projects/:id/check`; `POST /app/start/{project, document, rule, check}`, `POST /app/import/documents/preview` and `POST /app/import/source/preview` (token-checked POSTs that render a preview and change nothing), `POST /app/import/documents`, `POST /app/import/source`, `POST /app/demo`, `POST /app/projects/:id/check-all`. The trusted-source page's import now goes through the same preview.

Tests: `test/onboarding-import.test.ts` (6 HTTP tests): empty-workspace choices and navigation markup; the guided start with missing fields, the form token, an unsupported (zip/Word) file, an unreadable sentence, a sentence and a template added as notes, the first check explained, learning and release folder untouched; document import with preview-stores-nothing, unsupported PDF/Word named, new version vs keep both vs identical, tampered content refused, a new project created only on confirm; CSV preview/confirm with header problems and rows left out; the demo only into an empty workspace, labelled and kept apart.

UI limits that remain: no document preview with highlighted findings; the guided start covers one kind of work (sales proposals); the sentence path understands only the fixed patterns listed on screen; multiple-file import is limited by the 6 MB request size; no dark mode; screens were checked in headless Chrome at desktop and phone widths, not with assistive technology or with people (AT-U1 to AT-U6 stay todo).
