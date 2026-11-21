# Correction Layer — Phase 1 handoff

This is the handoff from Phase 1 (framework scaffold) to Phase 2 (remaining business functions). Phase 1 delivered a **real, executable, local-first framework** that builds, starts and passes baseline tests. It is not the finished MVP described in [docs/08-mvp-and-acceptance.md](docs/08-mvp-and-acceptance.md), and this file says exactly where the line is.

Read this file first, then the module header comment of whatever you are about to change. The design documents in `docs/` remain the specification; where the code deviates, section 8 below records it.

## 1. Build, test, start

Requirements: Node.js 24 or newer; Python 3.8 or newer only for the design checker. There are **no runtime dependencies**. `npm install` fetches TypeScript and Node's type definitions, nothing else.

```sh
npm install
npm run typecheck      # tsc --noEmit over src/ and test/ (strict, erasable syntax only)
npm run build          # tsc -> dist/
npm test               # node --test over test/**/*.test.ts
npm run check:design   # python3 tools/check_repo.py (design fixtures)
npm run verify         # all four of the above

npm run dev            # node --watch src/cli.ts serve   (http://127.0.0.1:4319)
npm start              # node dist/src/cli.js serve      (needs npm run build first)
npm run seed:demo      # load labelled DEMO data into an empty store
npm run cli -- verify  # verify the ledger hash chain
npm run cli -- check path/to/quote.md --project prj_... --for release
```

Results at handoff: type check clean; build clean; **94 tests: 73 pass, 0 fail, 21 todo** (the todo entries are the Phase 2 contracts of section 6, reported as todo, never as passing); design checker `OK` with the same counts as before the implementation existed.

Configuration is by environment (see `.env.example`; `.env` is gitignored): `CL_DATA_DIR`, `CL_HOST` (loopback only, anything else is refused), `CL_PORT`, `CL_DISPLAY_TZ`, `CL_LOCAL_USER_NAME`, `CL_SEED_DEMO`. The store defaults to the per-user data directory (`$XDG_DATA_HOME/correction-layer`), outside any project folder, as ADR-001 requires. The only key material is an ed25519 receipt-signing key generated into the data directory on first start. No secret is in the repository.

In a sandbox with an HTTP proxy configured, call the service with the proxy bypassed (`curl --noproxy '*' http://127.0.0.1:4319/healthz`).

## 2. Stack

| Choice | Why |
|--------|-----|
| TypeScript, run directly by Node 24 (type stripping), compiled by `tsc` for `npm start` | One language for service, app shell and tests; no bundler; `erasableSyntaxOnly` keeps source runnable as-is |
| `node:sqlite` (built in), WAL mode, one file per workspace | The design's single-writer SQLite store with no native add-on to compile |
| `node:http` with a small router; server-rendered HTML forms | A local app that needs no client build, works by keyboard, and has almost no attack surface. No client-side script is served (`script-src 'none'`) |
| `node:test` | No test framework dependency |
| JSON Schema subset validator in `src/contracts/schemas.ts` | The design restricts its schemas to a small subset precisely so a dependency-free validator can check them; `/schemas` stays the single wire contract |

## 3. Module boundaries

All state changes go through these services, composed in `src/app.ts` (`createApp`). The HTTP layer, the CLI, the seed and the tests are thin callers.

| Module | Responsibility | Deliberately does not |
|--------|----------------|-----------------------|
| `src/domain/` | Types mirroring `/schemas`, typed errors, ids, canonical JSON and hashing, explicit clocks | Execute anything |
| `src/contracts/schemas.ts` | `problems(name, value)` / `assertValid(...)` against `/schemas/*.schema.json` | Accept anything outside the subset |
| `src/store/` | `openDb`, nested `tx`, versioned migrations with checksums, DDL with insert-only triggers | Hold business rules |
| `src/ledger/ledger.ts` | Append-only, hash-chained events; `caused_by` must name earlier events; human-only event types; `verify`, `exportLog`, `erasePayload` | Update or delete envelopes |
| `src/policy/catalogue.ts` | The closed, frozen catalogue of 15 check kinds, typed parameters, evaluators, `relate()` for static duplicates and conflicts | Offer any user-level extension point or script |
| `src/policy/predicate.ts` | The closed `applies_when` grammar | Evaluate anything else |
| `src/policy/rules.ts` | Rule revisions, lifecycle, the two activation paths, scope index, deterministic selection, out-of-scope inventory | Let a non-human actor approve, retire, reject or confirm |
| `src/engine/` | The pure check engine `evaluate(input)`; target resolution in three namespaces | Perform I/O, read the wall clock, edit artifacts |
| `src/formats/adapters.ts` | File identification and the format adapter contract; two real adapters | Guess: unreadable input is data (`error`), never an empty artifact |
| `src/context/projects.ts` | Workspace, people, projects, facts, folder bindings, trusted sources, context resolution | Infer facts or authority from file content |
| `src/work/check.ts` | Artifact versions and blobs, the check transaction, runs, finding diffs between runs | Request, approve or perform actions |
| `src/gate/` | Receipts, signer, gateway, action adapter contract | Treat a pass as permission; execute without a person's explicit act |
| `src/capture/intake.ts` | The four capture operations, the intake procedure, cursors, gaps, dead letters, consent, health | Decide what an event means |
| `src/capture/local-adapter.ts` | Simulated capture adapter with a real durable outbox and replay | Observe any real runtime |
| `src/learning/policy.ts` | Learning policies: set by a person, insert-only revisions, per-surface consent | Accept a non-human author or a ceiling above the surface's own |
| `src/learning/compiler.ts` | Markers, trust classification, signal detection, the narrow deterministic compiler | Call a model |
| `src/learning/decision.ts` | The pure decision procedure `decide(input, policy)` | Take model confidence as an input |
| `src/learning/pipeline.ts` | In-order processing, evidence tests, recording decisions, applying effects, relay, inbox, queue | Pause, retire, weaken, approve, act, or edit anything |
| `src/api/server.ts` | Loopback HTTP: client contract under `/api/v1`, app surface under `/app` and the pages | Expose any human-only act to clients |
| `src/ui/` | Auto-escaping HTML helpers, layout, every designed screen as a page | Hide a missing feature behind a blank |
| `src/seed/demo.ts` | Labelled DEMO data, produced by driving the real services | Write records directly or invent metrics |

## 4. Exact contracts

### 4.1 Services (TypeScript)

| Contract | Signature | Notes |
|----------|-----------|-------|
| Check | `CheckService.check({project_id? \| path?, name, bytes, action:{type, params?}, actor, session_id?}) -> CheckResponse` | One transaction: run, `check_results`, events, and a receipt only if Ready and a gateway handles the action. Unresolved context returns no run |
| Observe a version | `CheckService.observe({project_id, name, bytes, declared_by?}) -> ObservedVersion` | Lineage is (project, file name); attribution is declared or "unknown editor" |
| Engine | `evaluate({run_id, artifact, action, context, rules, sources, exceptions, as_of, catalogue?}) -> {results, verdict, counts, sources, coverage_gaps, ruleset_digest, inputs_digest}` | Pure. `catalogue` is injectable for tests only |
| Selection | `RuleService.selectInScope({project_id, area_ids, artifact_id, work_type, artifact_type, action}) -> Selection`; `outOfScope(q)` | One exact-or-any query on `rule_scope_index` |
| Rule lifecycle | `createCandidate(content, actor)`, `approveAndActivate(id, human, {trial?})`, `activateDelegated(id, grant)`, `retire(id, human, reason)`, `reject`, `confirm`, `addCase`, `analyse(content)` | Exactly two ways into force; see section 5 |
| Receipts and gate | `Gateway.issueReceipt(run, causeEventId)`, `verifyBindings(receipt) -> GateCheck[]`, `receiptStanding(id)`, `setActionPolicy(project, type, policy, human)`, `requestAction({receipt_id, type, params?}, actor)`, `approve(id, human)`, `reject`, `execute(id, human)`, `recoverInFlight()`, `coverage(project)` | Gate steps 1 to 10 of docs/06 §5 |
| Action adapter | `ActionAdapter { capability; execute({action_id, type, params, bytes, content_hash}) -> ExecutionOutcome }` | Receives the checked bytes, never a path |
| Format adapter | `FormatAdapter { capability; parse({bytes, name, work_type}) -> ParsedArtifact }`; `readArtifact(bytes, name, workType) -> {identity, parsed \| null, error \| null}` | Deterministic, total, inert |
| Capture | `CaptureIntake.pairAdapter(record, human)`, `hello({adapter_id, stream_id, last_seq, binding_id?, session_id?})`, `deliver({adapter_id, stream_id, events:[{event, delivery?}]})`, `heartbeat`, `close`, `stream(id)`, `deliveries(id)` | `deliver` stores the batch in one transaction and returns a result and cursor per event |
| Capture transport | `CaptureTransport { hello; deliver; heartbeat; close }` | Implemented in-process by `CaptureIntake`; a remote adapter implements it over the HTTP routes |
| Learning policy | `LearningPolicyService.set({project_id, mode, learn_from, surfaces?, limits?}, human)`, `current(project)`, `consents(project, surface)` | New revision per change; Off records `revoked` |
| Learning pipeline | `processStream(streamId)`, `tick()`, `relay({project_id, text, agent, session_id?})`, `appCorrection({project_id, text, ...}, human)`, `resolveInbox(id, human, resolution)`, `queue(project)`, `decisions(project)` | Processing is keyed by `capture_id` |
| Decision | `decide(DecisionInput, DecisionPolicy) -> {outcome, reasons}` | Same answers as `decide()` in `tools/check_repo.py` on all eight fixtures |

Typed errors (`src/domain/errors.ts`): `ValidationError` 422, `PermissionDenied` 403 (`human_only`, `adapter_not_paired`, ...), `NotFound` 404, `Conflict` / `InvariantViolation` 409, `Unavailable` 501, and `NotImplementedYet` 501 with a `contract` name. **Unsupported capabilities always surface as `Unavailable`; nothing returns success by doing nothing.**

### 4.2 HTTP

Client contract (callers are always client actors, `enforcement_tier` is stated on every response):

| Route | Operation |
|-------|-----------|
| `GET /healthz` | Liveness, schema version, ledger head, policy revision |
| `GET /api/v1/capabilities` | Check kinds, format adapters, action adapters and capture adapters with availability and simulation flags |
| `POST /api/v1/hello`, `/resolve`, `/list_rules` | Context, brief (exact count, `truncated`), coverage |
| `POST /api/v1/check` | `{artifact:{kind:"path", value, content_text \| content_base64} \| {name, content_text}, project_id?, action:{type}, session_id?}`. The service does not read files from disk for clients |
| `POST /api/v1/propose_correction` | Relay: inbox at most, discarded when the text matches artifact content |
| `POST /api/v1/request_action` | Records a request awaiting a person |
| `GET /api/v1/status/run/:id`, `/status/action/:id`, `/runs/:id` | Status |
| `GET /api/v1/ledger/verify`, `/ledger/export` | History |
| `POST /api/v1/capture/hello`, `/deliver`, `/heartbeat`, `/close`; `GET /capture/streams/:id` | Capture operations |
| `POST /api/v1/report_change` | 501 `unavailable`, contract `api.report_change` |
| `POST /api/v1/{approve_rule, activate_rule, reject_rule, retire_rule, set_learning_policy, grant_exception, confirm_attestation, approve_action, execute_action, resolve_inbox_item}` | Always 403 `human_only` |

App surface: the pages listed in section 4.4, and `POST /app/...` form actions that act as the local person and require the per-process form token plus a same-origin request.

### 4.3 Store

One migration (`src/store/schema.ts`, version 1). Add migration 2 for any change; an edited applied migration is refused by checksum. Insert-only tables (triggers reject UPDATE and DELETE): `policy_revisions`, `rule_revisions`, `source_snapshots`, `artifact_versions`, `runs`, `check_results`, `approvals`, `events`, `learning_policies`, `capture_deliveries`, `learning_decisions`. `event_payloads` can only be erased; a receipt's signed statement is frozen while its status may move. Everything else is a read model or operational state (`rule_state`, `rule_scope_index`, `capture_streams`, `learning_candidates`, `inbox_items`, ...).

### 4.4 Screens

| Screen (design id) | Route | Real | Explicitly unavailable on the page |
|--------------------|-------|------|-------------------------------------|
| All projects / onboarding (UX-1, UX-2) | `/`, `/onboarding` | Create project, bind folder, confirm a fact | Suggested facts, starter packs, source import, marker file |
| Project home (UX-5) | `/projects/:id` | Recent work, rules in scope, sources, folders, coverage, learning, activity, check a file, add a correction | — |
| Rules overview (OBS-1) | `/projects/:id/rules` | "View as project" equals the engine's in-scope set | Search, filters, grouping, health queue |
| Rule detail (OBS-2) | `/rules/:id` | Sentence, kind, scope, authority, original words, examples, counts, history; approve, trial, reject, undo, keep | Revise, pause, exceptions, dry run |
| Activity (OBS-3) | `/projects/:id/activity` | Ledger events with actor and cause | Filters |
| Artifact review (UX-6) | `/runs/:id` | Every in-scope rule with reason and findings, inventory count, receipt standing | Document preview, fix proposals, disputes |
| Run timeline (OBS-4) | `/traces/:id` | Events of one piece of work with fixed verbs | Re-run as recorded |
| Before / after / recheck (OBS-5) | `/compare?before=&after=` | Findings resolved, introduced, remaining | Cell and passage diff |
| Pre-action review (UX-8) | `/actions/:id` | What was checked versus what is being decided; approve, reject, release (simulated); gate checks | — |
| Learning settings (UX-11) | `/projects/:id/learning/settings` | Four modes, people, surfaces with generated labels | Per-surface toggles |
| Learning queue and inbox (UX-13) | `/projects/:id/learning` | Stage counts, needs you, turned on, waiting, not learned | Reviewing one's own non-signal messages |
| Added automatically (OBS-9) | `/projects/:id/learning/added` | Every automatic decision with permission, words, evidence | — |
| Learning timeline (OBS-10) | `/projects/:id/learning/timeline/:rule` | Events linked by cause | Per-message capture line, automatic pause |
| Capture health (OBS-11) | `/projects/:id/capture` | Labels from paired adapters, stream health, gaps, dead letters, discard | Retry, acknowledging a permanent gap |
| Coverage map (OBS-8) | `/projects/:id/coverage` | Labels generated from configuration | — |
| Correction journey (OBS-6) | `/corrections/:id` | Events by stored reference | The joined journey view |
| Effectiveness (OBS-7) | `/projects/:id/effectiveness` | Plain evaluation counts only | Everything else, by design |
| History check | `/history` | Chain verification, export | Anchors, backup |

## 5. Critical invariants: where they live, where they are tested

| Invariant | Encoded in | Tested in |
|-----------|-----------|-----------|
| Mandatory rules are selected deterministically, never by retrieval | `RuleService.selectInScope` (indexed exact-or-any query), `rulesetDigest` | `test/scope.test.ts` (AT-G1 scaled, AT-G3, AT-G7, AT-C1, AT-C11) |
| Auto-activation only under a person's scoped learning policy, with real positive and negative evidence; model confidence is never an input | `decide()` (no such input exists), `RuleService.activateDelegated` (re-verifies policy, scope, kind, lock, protected targets, trigger failure, real pass, stored examples) | `test/learning-e2e.test.ts` (AT-L8), `test/learning-decision.test.ts` (AT-L9, AT-L13, AT-L14, fixtures), `test/learning-invariants.test.ts` (forged grants) |
| Untrusted documents, emails and tool output are evidence, not instructions | `classify()` (agent, tool and unattested text are never signals), intake (agent and tool output is digest-only), `relay()` (discard on artifact-text match), engine reads typed fields only | `test/learning-invariants.test.ts` (AT-L7, AT-C10), `test/capture.test.ts` (role forgery) |
| Capture is durable: ack, idempotency, dedup, replay, project isolation | `CaptureIntake.receive/advance`, `LocalOutboxAdapter`, `signals.capture_id UNIQUE`, `processed_through` cursor | `test/capture.test.ts` (AT-L1, AT-L2, AT-L3, AT-L4 against the design fixture, AT-L5, AT-L17) |
| Receipts bind artifact, policy revision and rule set, action, sources; they expire; fail closed | `Gateway.issueReceipt`, `verifyBindings`, `execute` | `test/gate.test.ts` (AT-E2, AT-E4, AT-E5, dependency failure) |
| Validation, permission and action are separate; no automatic send or pay | `requireHuman` in every human-only service method, `HUMAN_ONLY_EVENTS` in the ledger, 403 routes, unavailable send and pay adapters, simulated release | `test/gate.test.ts`, `test/api-ui.test.ts` (AT-E3, AT-E6, AT-O6) |
| Clear failed, unknown and unsupported outcomes; nothing skipped silently | Engine verdict table and counts, unavailable check kinds are `unknown`, unreadable files are `could_not_verify`, `Unavailable` errors | `test/engine.test.ts` (AT-E8, AT-F6, AT-F8, AT-F9, AT-G2) |
| Global hard gates cannot be removed or weakened by learned corrections | Conjunction in the engine; the pipeline has only "add a requirement"; no automatic pause exists; retire needs a person | `test/learning-invariants.test.ts` (AT-L10, hard gates) |
| The check catalogue is closed; rules are data | Frozen `CATALOGUE`, `ruleProblems`, predicate grammar | `test/contracts.test.ts` (ADR-003, AT-E9) |

## 6. Acceptance tests

**Covered by passing tests** (in the narrow Phase 1 form; scaled or partial where noted): AT-G1 (240 rules, not 10,000), AT-G2 (thrown error; no time budget), AT-G3, AT-G5 (run-time half, allowed sets only), AT-G7, AT-C1, AT-C2, AT-C6 (first half), AT-C10, AT-C11, AT-C12 (request half), AT-F1 (extension mismatch for text), AT-F6, AT-F8, AT-F9, AT-O1 (by construction: the page calls the engine's selection), AT-O6, AT-R4, AT-R6 (hop walk in `test/learning-e2e.test.ts`), AT-I3 (rule listing), AT-I4, AT-L1, AT-L2, AT-L3 (gap half), AT-L4, AT-L5, AT-L7, AT-L8, AT-L9, AT-L10, AT-L12, AT-L13, AT-L14, AT-L16, AT-L17 (consent halves), AT-L18, AT-L20, AT-L21 (TypeScript counterpart), AT-E2, AT-E3, AT-E4, AT-E5, AT-E6, AT-E8, AT-E9.

**Remaining** (each is a `test.todo` in `test/seed-and-extension-points.test.ts` naming its contract): AT-G4, AT-G5 static half, AT-G6, AT-G8, AT-G9, AT-C3 to AT-C9, AT-F1 container inspection, AT-F2 to AT-F5, AT-F7, AT-F10, AT-F11, AT-U1 to AT-U6, AT-O2 to AT-O5 in full, AT-O7 to AT-O10, AT-R1 to AT-R3, AT-I1, AT-I2, AT-I5 to AT-I7, AT-L3 backfill, AT-L6, AT-L11, AT-L15, AT-L17 deletion, AT-L19, AT-E1, AT-E7, AT-E10 to AT-E12.

## 7. Next functions for Phase 2

Each item names the extension point that exists today. Points marked *throws* raise `NotImplementedYet` with that contract name; replacing the throw is the task.

| # | Function | Where | Today | Acceptance |
|---|----------|-------|-------|------------|
| 1 | DOCX reading: container inspection, blocks, tables, comments, tracked changes, mapping to sales-proposal fields | `formats.docx.parse` in `src/formats/adapters.ts` (*throws*) | Zip packages are identified and reported unreadable | AT-F1 to AT-F5 |
| 2 | Remaining MVP check kinds: `fields_agree`, `date_window`, `arithmetic_consistency`, `no_unresolved_markup`, `attestation` | `src/policy/catalogue.ts`: replace `unavailable(...)` with a spec that has `validateParams` and `evaluate` | Declared, typed, evaluate to `unknown` | AT-O2, the starter pack |
| 3 | Correction compilation from free-form language; templates; optional model translator behind the same checks | `compileCorrection` in `src/learning/compiler.ts` | One pattern (currency) plus the never-learned and one-off classes | AT-U2, AT-L9 in full |
| 4 | Manual correction flow: candidate editor, scope choice, examples, dry run (UX-7a to 7c) | `RuleService.createCandidate`, `analyse`, `addCase`; a new page | Candidates arrive only from the compiler, tests or the seed | AT-G4, AT-U2 |
| 5 | Automatic pause, Resume, suppression, "this was a correction", signal text deletion | `LearningPipeline.autoPause`, `suppress`, `markAsCorrection`, `deleteSignalText` (*throw*) | A contradiction opens an inbox question; the learned rule keeps enforcing | AT-L15, AT-L17, AT-L19 |
| 6 | Real capture adapters: one assistant runtime hook, folder watch, backfill from transcripts | Implement `CaptureTransport` over `/api/v1/capture/*`; reuse `LocalOutboxAdapter` | Simulated adapter only | AT-L3, AT-L6, AT-L11 |
| 7 | Repair requests: recognise a turn that refers to an open finding of an existing rule | `detect()` in `src/learning/compiler.ts` | Such a turn is identified and put to a person | Fixture sequence 6 in `test/capture.test.ts` |
| 8 | Context: markers, moved and copied folders and files, areas, lineage across projects, ambiguity questions | `ProjectService.resolveByMarker` (*throws*), `resolve` | Store binding or explicit project only | AT-C4 to AT-C9 |
| 9 | Exceptions and attestations | New tables in migration 2; pass `exceptions` to `evaluate` (already reports `waived`) | Engine side only | AT-E7, AT-F4 |
| 10 | Real release-folder adapter; newer-version choice; automatic recheck after invalidation | `src/gate/adapters.ts`; `Gateway.execute` step 5 and the note in §5 of docs/06 | Simulated release; blocked or paused with no auto-recheck | AT-E1, AT-C9 |
| 11 | Source import from CSV and XLSX; staleness events; "source changed since last check" | `ProjectService.importSnapshot` takes rows today | Rows only | AT-F7 |
| 12 | Re-run as recorded; content diff; fix proposals; `report_change` | `CheckService.compare` (`content_diff.available: false`), `api.report_change` (*throws*) | Finding-level diff only | AT-O5, AT-O7, AT-R1 |
| 13 | Client pairing tokens and app sign-in; MCP stdio binding | `src/api/server.ts` (`client()`), new binding | Loopback only, same-account caveat stated | AT-E3 in team form, AT-I5 |
| 14 | Retention and expiry jobs: non-signal text, dead letters, candidate expiry, receipt expiry events | A scheduled job beside `LearningPipeline.tick` | Nothing is purged; expiry is checked lazily | AT-L17, docs/02 §9 |
| 15 | Effectiveness and measures of docs/12 §15; benchmark suite | New read models | Plain counts per rule | docs/08 §4 |

## 8. Design decisions and deviations

Decisions made in Phase 1:

1. **Rule examples live beside the immutable revision** (`rule_cases`), not inside its content, because real evidence arrives after a candidate is saved. The revision's content digest excludes cases.
2. **Receipts are validated lazily and authoritatively** by recomputing their bindings (`verifyBindings`); the stored status only records what a verification found. No background invalidation sweep exists.
3. **Processing is deferred while a stream is known to be behind**, until the gap timeout (60 seconds), so a correction recovered by replay is handled exactly as if delivered live. After the timeout it proceeds as `capture_incomplete`.
4. **A candidate that lacked evidence is re-tested when a new version of its artifact appears**, whether it was merely waiting or already in the inbox for other reasons.
5. **The author of a captured user turn is the person who paired that adapter.** The capture event schema carries no author.
6. **`content_digest` is SHA-256 of the UTF-8 text** for content-bearing events, and the intake rejects a mismatch. The design leaves the algorithm open; its example digests are illustrative labels.
7. **Execution always begins from a person's explicit act**, even under a "no approval required" policy.

Deviations from the specification, all on the cautious side:

| Design says | Phase 1 does | Why |
|-------------|--------------|-----|
| Signing key and credentials in the OS keychain | An ed25519 key in a 0600 file in the data directory | No portable keychain binding without dependencies |
| Blobs in a `blobs/` directory | Blobs in the SQLite store | One file to back up; small MVP documents |
| DOCX is the MVP document format | Markdown and plain text only; DOCX is declared and unreadable | Parser is Phase 2 work |
| MCP server and pairing tokens | Loopback HTTP without pairing | Solo, single machine; the same-account caveat is stated in code and UI |
| Automatic pause of a contradicted learned rule | Inbox question; the rule keeps enforcing | Moving away from enforcement without a person is the riskier default to ship half-built |
| An unbound event goes to the inbox with "which project?" | The inbox item is opened, but the event's text is **not kept** | Without exactly one project there is no consent to keep it under |
| A turn referring to an open finding is not a signal | It is identified and asked about | Linking turns to findings is not built |
| Learning policy may delegate source-backed kinds if listed | Hard-capped to `deterministic` exact kinds | Stricter than the schema allows, on purpose |
| The real passing case is a corrected version "produced by a person or at a person's request" | Any later stored version of the same artifact counts | Authorship of a version is only known when declared (`report_change` is Phase 2). The evidence is still a real stored version, never a generated one |
| A relay is discarded when its text "matches artifact or tool content" | Match is a case- and whitespace-insensitive containment test against the text blocks of the project's latest readable versions (12 characters or more) | Simple and conservative: a false match discards a relay, which is visible in the audit; tool output is never stored, so it cannot be matched |
| Unattested user text is accepted as an envelope | Its content is dropped (`consent_blocked`) | Nobody vouches for who typed it |
| `tools/check_repo.py` walks the whole repository | It now skips `node_modules/`, `dist/`, `coverage/`, `.data/` and the root `package*.json` and `tsconfig*.json` | Otherwise toolchain files are judged as design examples. No check was weakened |

Specification issues found while implementing (worth fixing in the documents):

- **Erasure breaks the proposed hash chain.** The chain hashes the envelope including `payload_state`, so changing it to `erased` invalidates the event, contrary to docs/02 §4.1. The scaffold hashes the envelope as written (`payload_state: "present"`), which keeps every non-erased log bit-compatible with the checker. `schemas/README.md` and `tools/check_repo.py` should adopt the same rule.
- **The intake pseudo-code cannot decide consent on arrival for an out-of-order event that has no binding of its own**, because its project is the stream's project at that sequence number. The scaffold decides when the event is admitted in order.
- **The capture event has no author field** (decision 5 above).
- **`docs/12` §5 does not say which trigger identifies an explicit one-off** such as the fixture's "Use the supply quote's layout for this one." The scaffold treats a one-off marker in a reply to assistant output as a direct correction that is recorded only.

## 9. MVP boundaries and simulated adapters

Stated in code comments, in the UI banner, in `GET /api/v1/capabilities` and here:

- **One person, one machine.** The local person holds every role; self-approval is labelled. Separation of duties is procedural.
- **Advisory checks.** The only gated route is `release`, served by `adp_RELEASESIM`, a **simulated** adapter: the gate logic is real, the release is only recorded, nothing is copied.
- **Send and pay do not exist.** `adp_EMAILNONE` and `adp_PAYNONE01` are declared `unavailable`; requests are refused with a typed error and an `action.blocked` event. No receipt is issued for an action no gateway handles.
- **Capture adapters.** `LocalOutboxAdapter` is a **simulated** runtime-hook adapter with a real durable outbox, acknowledgements and replay. The app's own correction box is a real app-native capture path. Folder watch, app connectors and backfill do not exist; the UI labels them NOT CAPTURED.
- **Formats.** `text-labelled` is real for Markdown and plain-text sales quotes. `cl-artifact-json` is a fixture adapter for already-normalized artifacts. Everything else is unreadable and therefore *Couldn't verify*.
- **No AI model is called anywhere.** `model_flags` is always empty; `model_review` rules are skipped as notes.
- **DEMO data** is fictional, flagged `is_demo`, named "[DEMO]", produced by the real pipeline, and shown under a banner. It contains no metrics and makes no claim that any rule improved any work.

## 10. Roadmap

Phase 2 completes the MVP of docs/08 §3 in roughly this order, each step unlocking acceptance tests: check kinds (item 2) and DOCX (item 1); the manual correction flow (item 4) and richer compilation (item 3); a real runtime-hook adapter and folder watch (item 6); automatic pause and the review actions (item 5); context moves and markers (item 8); exceptions and the real release folder (items 9 and 10); re-run, diff and the journey view (item 12); pairing and MCP (item 13); retention (item 14). Team mode, network adapters, spreadsheets and PDF as work artifacts, and the effectiveness view remain the design's later phases.
