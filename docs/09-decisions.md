# 09 · Decision records

> All decisions below have status **Proposed**. They record what this design chose, what it rejected, and what it costs. None has been validated by implementation.

Format: context, decision, alternatives considered, consequences.

---

## ADR-001 · A per-workspace SQLite store outside project folders, with no Git dependency

**Context.** The predecessor tool keeps checks in a JSON file inside a Git repository and relies on Git for history and on CI for enforcement. Ordinary work folders are not repositories; they are synced, zipped, emailed and copied.

**Decision.** One SQLite database plus a content-addressed blob directory per workspace, kept in the operating system's application-data location (or on a team host). Revisions and history are modelled in the store. Project folders contain only a marker file that points at a project.

**Alternatives.**
- *Store inside each project folder* (travels with the work). Rejected: live database files in sync folders corrupt; policy copied with a folder forks silently; anyone with the folder can replace the policy.
- *Plain JSON/YAML files.* Rejected for the primary store: no transactions, no indexes for scope lookup at scale, no safe concurrent writers. JSON remains the export and interchange format.
- *A hosted service from day one.* Rejected for the MVP: adds accounts, network dependence and privacy questions before the core loop is proven.
- *Git under the hood.* Rejected: brings merge semantics and tooling expectations that the audience does not need.

**Consequences.** Sharing rules between machines needs explicit export/import (and later a team host). Backup is the user's or host's responsibility and is designed in. A single local writer makes ordering simple but means the service must be running for anything to be recorded.

---

## ADR-002 · Rules combine by conjunction; nothing overrides

**Context.** Rules exist at workspace, customer, project, area and document scope. Some scheme must say what happens when several apply. The working hypothesis asked that global rules not be weakened and that conflicts not default to "most local wins".

**Decision.** All in-scope rules are required together. There is no precedence and no override construct in the rule language. Local variation is expressed by adding a narrower rule, by parameterizing the wider rule on a project fact or trusted table, or by a recorded exception. Unsatisfiable combinations are reported as conflicts.

**Alternatives.**
- *Most local wins.* Rejected: a project can silently loosen an organizational rule; results depend on ordering.
- *Most global wins.* Rejected: makes legitimate local differences impossible without editing global rules.
- *Explicit priorities.* Rejected: priority numbers are a programming construct that non-technical owners cannot reason about, and they hide conflicts instead of surfacing them.

**Consequences.** "Cannot be weakened locally" is structural, not a validation rule. Explanations are simple. The cost is that genuine conflicts stop work until an owner acts; static conflict detection at proposal time is therefore part of the MVP.

---

## ADR-003 · A closed catalogue of typed checks; no scripts

**Context.** A rule language can be anything from a fixed menu to arbitrary code. The predecessor uses regular expressions and path globs.

**Decision.** Rules pick one check kind from a product-defined catalogue and supply typed parameters. A minimal predicate grammar exists for content conditions. Patterns are allowed only in a restricted, linear-time syntax and must carry examples. No user-supplied code runs anywhere in the policy path.

**Alternatives.**
- *Embedded expressions or scripts.* Rejected: unreviewable by the intended owners, a security liability, non-deterministic in practice, and impossible to render as an honest sentence.
- *Unrestricted regular expressions as the main tool.* Rejected: opaque to non-developers, prone to catastrophic matching, and a poor fit for typed values such as money and dates.

**Consequences.** Some corrections will not fit the catalogue. They become person-confirms rules or guidance until a check kind is added by a product release. That is slower than scripting and is the intended trade: every active rule is explainable, analysable for conflicts, and safe to evaluate.

---

## ADR-004 · Mandatory rules are selected by a deterministic index, and every in-scope rule is accounted for

**Context.** As rule counts grow, systems that feed rules to an AI model typically retrieve "the most relevant" few. For enforcement that means rules are dropped silently.

**Decision.** Selection is an exact-or-any match on context dimensions through a materialized index. Every selected rule gets a recorded outcome in every run. Out-of-scope rules are not stored per run but can be recomputed with reasons from the recorded policy revision and context.

**Alternatives.**
- *Semantic retrieval / top-k.* Rejected for selection: incomplete by design and unexplainable. It remains acceptable for search in the interface.
- *Evaluate every rule in the workspace on every artifact.* Rejected: wasteful, noisy (hundreds of "does not apply"), and leaks other projects' rule text into runs.
- *Store an explicit row for every out-of-scope rule per run.* Rejected: storage grows with workspace size times run count, for information that is a pure function of data already recorded.

**Consequences.** Scope must be expressible in context-decidable dimensions; conditions on document content are a separate, later step. The recompute-on-demand inventory depends on policy revisions being reconstructable, which the insert-only model provides.

---

## ADR-005 · Three integration tiers, with coverage labels generated from configuration

**Context.** A skill or instruction can ask an assistant to run checks; it cannot make it. Presenting advisory integration as enforcement would be the product's most damaging possible dishonesty.

**Decision.** Name the tiers (guidance, checkpoint, gateway), state the tier in every API response, and show per-action coverage labels (GATED, ADVISORY, OBSERVED, NOT COVERED) derived from the adapters actually configured. GATED always carries a qualifier saying whether the gated route is exclusive, a team convention, or bypassable from the same account.

**Alternatives.**
- *Gateway only.* Rejected: most day-to-day value comes from early, advisory checks while drafting.
- *Advisory only.* Rejected: then nothing is ever actually prevented, and the product is a linter with a nicer face.
- *A single "protected" badge.* Rejected: hides the distinction users most need.

**Consequences.** The interface repeatedly admits what it does not control. That is uncomfortable marketing and correct engineering.

---

## ADR-006 · Receipts bind everything the verdict depended on; the gateway acts on the checked bytes

**Context.** Between a passing check and an action, the file, the rules, a source, the project or the software can change.

**Decision.** A signed receipt records the content hash, context, action, in-scope rule-set digest, source snapshots with freshness, parser and engine versions, and an expiry. The gateway re-verifies each binding and executes using the stored snapshot of the checked bytes, not the live path. Receipts are single use and explicitly carry no permission.

**Alternatives.**
- *Re-run the full check at the gate only.* Rejected as the sole mechanism: the approver would have reviewed a different run than the one that gates. Revalidation of bindings gives the same safety and keeps what was approved identical to what is executed.
- *Bind to the workspace policy revision rather than the in-scope digest.* Rejected: any unrelated rule change anywhere would invalidate every pending receipt, which gets worse as the rule set grows.
- *Act on the file path after re-hashing.* Rejected: still leaves a window between hash and send.

**Consequences.** The blob store must keep checked versions until their receipts lapse. A newer version of the file creates a deliberate pause, which some users will find fussy.

---

## ADR-007 · The event ledger is the source of truth for every screen; the hash chain covers digests so evidence can be erased

**Context.** Observability bolted on as logging tends to disagree with the system's real state and cannot answer "why". Audit trails that embed content cannot honour deletion without breaking integrity.

**Decision.** Every state change appends a typed event with explicit `caused_by` links. All views are projections of events and the records they reference. Each envelope carries a digest of its payload; the chain hashes envelopes. Evidence and content can be purged while envelopes and the chain remain verifiable.

**Alternatives.**
- *Mutable tables plus a log.* Rejected: two sources of truth.
- *Chain over full payloads.* Rejected: makes erasure and retention incompatible with integrity.
- *Infer causality from timestamps.* Rejected: wrong under concurrency and impossible to audit.

**Consequences.** Event design is a first-order schema commitment and needs versioning discipline. Writing `caused_by` correctly is work at every call site. Storage grows monotonically for envelopes (they are small).

---

## ADR-008 · Semantic fields come from human-confirmed mappings; model-extracted values never satisfy must-pass rules

**Context.** "The unit price in row 2" is not a property of a file format; something has to decide which number is which. AI models are good at this and are sometimes wrong in ways that look right.

**Decision.** Work types define a field dictionary. Declarative field mappings, confirmed by a person through "teach by pointing", locate fields deterministically. A model may suggest a mapping or a value; a suggested value is `model_suggested` and cannot satisfy a must-pass rule until a person confirms it for that version.

**Alternatives.**
- *Model extraction as ground truth.* Rejected: converts a deterministic check into a probabilistic one while still presenting a hard verdict.
- *Only structured templates (form fields) are supported.* Rejected: too restrictive for how proposals are actually written, though structured templates remain the most reliable option and are encouraged.

**Consequences.** Documents that do not fit a mapping yield *Couldn't verify* and a short confirmation step. This is the design's main usability risk and the first thing Phase 0 tests.

---

## ADR-009 · The sentence a person approves is rendered from the typed rule

**Context.** If an AI model writes both the typed rule and its plain-language summary, the summary can be persuasive and the rule can be different. The approver reads only the summary.

**Decision.** Each check kind has fixed sentence templates. The rule's `title` and `statement` are rendered from its typed fields by those templates. The model's own wording is never what is approved. Examples the rule blocks and allows are computed by the engine and shown beside the sentence.

**Alternatives.**
- *Model-written summary with a "verified" back-translation by a second model.* Rejected: two probabilistic steps do not make a guarantee.
- *Show the typed rule itself.* Kept, but behind "Details"; not usable as the primary view for the audience.

**Consequences.** Sentences can read stiffly, and each new check kind needs templates in every supported language. In exchange, "what you read is what runs" depends only on the templates being correct, which is a small, fixed thing to test, and not on a model's wording.

---

## ADR-010 · Examples and a dry run come before approval; trial mode exists

**Context.** The working hypothesis ordered the lifecycle as review and approval, then regression cases, then activation. An approver who has not seen what a rule does to real documents is approving a sentence.

**Decision.** Blocking and allowing examples and a dry run over existing work in scope are produced before approval and are what the approver reviews. A rule may be activated in `trial`, where it is evaluated and recorded but can only produce notes.

**Alternatives.**
- *Approve first, test later.* Rejected: tests then merely confirm a decision already made.
- *Mandatory trial for every rule.* Rejected: a correction about a known, costly mistake should be able to block immediately.

**Consequences.** Adding a rule takes one more step. Dry runs must respect project isolation, which limits them to what the approver may see.

**Later refinement.** ADR-014 allows the authority decision to be delegated in advance for low-risk rules. The ordering decided here is unchanged and becomes more important: the tests are then the only thing standing between a captured sentence and an active rule.

---

## ADR-011 · Method, enforcement and outcome are separate axes

**Context.** The working hypothesis listed states "hard / warn / unknown / manual". These mix how a result is known, what a failure does, and what happened.

**Decision.** Three independent fields: `method` (deterministic, source_backed, attested, model_review), `enforcement` (block, warn), and per-run `outcome` (pass, fail, unknown, error, not_applicable, waived, conflict, skipped), with explicit constraints (model_review cannot block; skipped only for warn rules).

**Alternatives.** *A single status enum.* Rejected: cannot express "a person must confirm, and it blocks" or "exact check, note only", and makes "unknown" look like a kind of rule instead of a kind of result.

**Consequences.** Slightly more to explain; the interface reduces it to "Kind" and "When not met" on rules and three verdicts on work.

---

## ADR-012 · The MVP is one work type, one machine, one soft gate

**Context.** The design covers many formats, teams and adapters. Building it all first would delay learning whether the core loop works for non-developers.

**Decision.** MVP: sales-proposal documents in DOCX (plus plain text and Markdown, which need almost no parsing), spreadsheet sources, solo use, release-folder gateway, the observability minimum (rule list, timeline, compare and recheck, journey, coverage map), and opt-in learning for one project at a time with one runtime capture adapter (ADR-014 to ADR-017).

**Alternatives.**
- *Start with the email gateway.* Rejected: needs credential handling and team mode to be honest about isolation.
- *Start with spreadsheets.* Rejected: formula semantics add risk before the loop is proven; proposals also exercise sources, currency and approvals.
- *Start as a library for developers.* Rejected: that is the predecessor.

**Consequences.** The first gate is weak (a folder convention) and the documentation and product say so. Two-person approval and credential isolation arrive in Phase 2.

---

## ADR-013 · The product does not edit work files in the MVP

**Context.** A natural feature is "fix it for me". It also blurs detection and repair, risks damaging complex documents, and invites the claim that the checker improved the work.

**Decision.** In the MVP the product proposes fixes and observes new versions; people and their assistants make the edits in their own tools. A later "apply for me" is limited to simple value replacements on a copy, shown as a diff, written only on explicit confirmation and attributed to the confirming person.

**Alternatives.** *Auto-apply deterministic fixes.* Rejected: a silent change to a customer document by a checking tool is exactly the kind of unreviewed action the product exists to prevent.

**Consequences.** One more step for the user on every fix. Attribution in the timeline stays truthful.

---

## ADR-014 · Authority for a rule can be given in advance: bounded learning delegation

**Context.** The first version of this design required a person to approve each must-pass rule. That keeps a human in every decision and makes recording a correction cost a review every time, which in practice means corrections stop being recorded. The request was explicit: detect and add automatically.

**Decision.** A person entitled to approve rules for a project may save a *learning policy* for it: a standing, revocable permission with a mode, a list of people whose corrections count, the surfaces observed, the kinds of rule allowed, and limits. Inside it, a candidate that is low-risk and has passed tests on real evidence is activated without a per-rule click, and announced with Undo. Each rule records whether it is in force by individual approval or by delegated learning. Everything broad, consequential, ambiguous, permission-related or loosening still requires an explicit decision by a person.

**Alternatives.**
- *Keep per-rule approval for every must-pass rule.* Rejected as the only option: it is the friction that was asked to be removed, and it remains available as the Off and Suggest modes.
- *Automatic activation by default.* Rejected: the default is Off. Authority has to be given by someone who holds it.
- *Let confidence decide: activate when a model is sure enough.* Rejected (ADR-015).
- *Automatic activation at any scope the person mentions.* Rejected: one sentence from one person should not bind other projects.

**Consequences.** Some rules will be in force that no person looked at individually; the design accepts this for one project at a time and for exact, add-only checks, and makes each one loud (notice), reversible (Undo), weak against disagreement (automatic pause) and permanently listed (audit). The claim "every hard rule is human-approved" is replaced by "every hard rule is in force on recorded human authority, given individually or in advance".

---

## ADR-015 · The learning decision is deterministic; a model may veto, never vouch

**Context.** Deciding whether a sentence is a reusable correction involves language, and models are good at language. They are also the component most exposed to manipulation by the text they read, and their confidence is not evidence.

**Decision.** The decision to activate is a pure function of recorded inputs: trust class of the signal, lexical markers from fixed lists, grounding of every parameter in the person's own words, results of tests on real artifacts, static conflict analysis, and the learning policy. A model may propose the typed candidate and may raise concerns. A concern always blocks automation. No model output can remove a blocker, and model confidence is not an input. Generated tests can count against a candidate and never for it.

**Alternatives.**
- *A model classifies "safe to auto-add".* Rejected: unexplainable, not reproducible, and attackable through content.
- *No model at all.* Rejected: compiling a correction into a typed rule from free text is where a model earns its place, and the grounding check bounds what it can invent.

**Consequences.** The procedure is conservative: statements without an explicit standing marker, in unsupported languages, or with pronouns that do not resolve, go to a person even when a human reader would find them obvious. That is the intended trade. Every decision can be recomputed from the ledger, and this repository's checker does so for the examples.

---

## ADR-016 · Learning is add-only; automatic pause touches only automatically added rules

**Context.** A system that can add rules from conversation could, if built carelessly, also remove them from conversation. "Stop checking prices" is exactly what an injected instruction, or a person in a hurry, would say.

**Decision.** The learning pipeline has one write operation on policy: add a requirement, at project scope or narrower. It cannot pause, retire, narrow or except any rule, change approval policies, roles, adapters or sources, or act on artifacts. One automatic step moves away from enforcement: a rule that was itself added automatically, and that no person has since kept, is moved to shadow when a listed person directly contradicts it, when it is disputed on distinct artifacts, when its examples regress, or when it conflicts with an approved or wider rule. It stays visible and a person is asked.

**Alternatives.**
- *Never pause automatically.* Rejected: a wrong learned rule would keep blocking until someone found the Undo, and a changed preference would be fought by the product.
- *Let a direct statement replace the old learned rule outright.* Rejected: a contradiction is precisely where a person should choose.
- *Allow automatic pause of any rule after enough disputes.* Rejected: that would let disagreement, or an attacker, remove organizational gates.

**Consequences.** Learned rules are deliberately weaker than approved ones until someone clicks Keep. The earlier principle "lapses go toward enforcement" now has one stated exception, limited to rules no person ever reviewed.

---

## ADR-017 · Capture is durable delivery by adapters, not an assistant's memory; captured is not understood

**Context.** The predecessor relies on a skill: the assistant is asked to notice corrections and record them. Whether that happens depends on the model, the prompt, the context window and luck. The request was for capture that is reliable in its own right.

**Decision.** Corrections are captured by opt-in adapters attached to supported runtimes and apps. An adapter writes each event to a local outbox, delivers it with a per-stream sequence number and an idempotency key, and keeps it until the service's cursor has passed it. The service acknowledges, de-duplicates, orders, detects gaps through heartbeats and close markers, replays after restarts, dead-letters what it cannot read, and binds each event to a project under that project's consent. Health and gaps are shown to the user. Pipeline stages are named and kept apart: captured, identified, compiled, tested, activated. An assistant passing a correction on by itself remains possible and is labelled RELAYED.

**Alternatives.**
- *Improve the skill.* Rejected as the foundation: no prompt makes an arbitrary model reliable, and a relayed sentence cannot be distinguished from one the model was tricked into producing.
- *Exactly-once delivery.* Not attempted: at-least-once with idempotent intake gives the same effect with ordinary means.
- *Capture everything, everywhere.* Not possible and not wanted: only surfaces with a real adapter, switched on for a project, by someone entitled to.
- *Put every captured message in the ledger.* Rejected: volume and privacy. The ledger records streams, gaps, signals and decisions; message text lives briefly in the capture store.

**Consequences.** Adapters are real integration work per runtime, and many runtimes will have none at first; the product must say NOT CAPTURED by name. Reliable delivery raises expectations that understanding is equally reliable, which it is not; the learning queue, the "this was a correction" review and Undo exist to keep that gap visible and cheap to close.
