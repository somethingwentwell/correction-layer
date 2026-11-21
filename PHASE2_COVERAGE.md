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

Results at the end of Phase 2: type check clean, build clean, **116 tests: 108 pass, 0 fail, 8 todo**, design checker `OK` (unchanged counts: 110 events verified, 8 decisions recomputed). Phase 1 ended at 94 tests: 73 pass, 21 todo.

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
