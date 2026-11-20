# 07 · Security, governance and limitations

> Proposed design. Nothing in this document is implemented. This is a design-stage threat model, not the result of a security review or test.

## 1. What is protected, and from whom

**Assets**

| Asset | Why it matters |
|-------|----------------|
| The rule set and its history | Whoever can change rules quietly can make anything "Ready" |
| Trusted source snapshots | A wrong price list makes wrong prices pass |
| Receipts, approvals and the ledger | They are the evidence of what was checked, who approved, and what was done |
| Action credentials and capabilities | They are the ability to send, export or submit |
| Work artifacts, evidence snippets, project facts | Customer and business information |

**Parties and trust**

| Party | Trusted to | Not trusted to |
|-------|-----------|----------------|
| Workspace owner | Configure honestly; they can always undo the product's protections, visibly | Do so invisibly |
| Stewards, approvers, source owners | Exercise their role | Act outside it |
| Makers | Do their work | Change rules or approve their own actions, unless the workspace says they may |
| AI assistants (any) | Nothing in particular. They may be helpful, mistaken or manipulated by content they read | Approve, activate, hold credentials, or be the only thing standing between an error and an action |
| Work artifacts and their contents | Nothing. They are data | Carry instructions or policy |
| The local machine's operating system and its account separation | Work as designed | — |

## 2. Threat model

| # | Threat | Design response | What remains |
|---|--------|-----------------|--------------|
| T1 | A document contains text that manipulates an assistant into skipping checks or sending | Gated actions do not depend on the assistant's cooperation: no receipt and approval, no execution. Approvals happen in the app only | Advisory and uncovered routes. The coverage map says which those are |
| T2 | Planted or accidental text is turned into a rule ("corrections" injected through an assistant) | Assistant-relayed corrections are candidates, attributed to the channel, inactive. The approver sees a sentence rendered from the typed rule, examples, and a dry run. Candidate creation by clients is rate-limited | A careless approver. Trial mode and the false-positive indicators limit the damage of a bad rule; nothing limits the damage of a missing one |
| T3 | The file is edited after it passes (check-then-edit) | Receipts bind the content hash; the gateway sends the snapshot that was checked; a newer version pauses execution | On gated routes, only what T5 and T9 leave open (someone able to alter the store or reach the credential directly) |
| T4 | A project quietly weakens a workspace rule | Rules combine by conjunction, so a local rule cannot loosen anything. Pausing and exceptions are role-controlled, need a reason and an expiry, and are events | An owner who grants exceptions too freely. Exceptions are counted and shown per rule |
| T5 | Someone with file access edits the store to alter rules, receipts or history | Insert-only tables; a hash chain over the ledger; receipts signed with a key in the OS keychain; periodic anchors of the chain head kept outside the store (§7) | On a single-user machine, a determined local administrator, or an assistant with full access to that account, can rewrite the store *and* reach the key. This is tamper-**evident** only if an anchor was kept elsewhere. Team mode moves the store and key to a host that makers and their assistants cannot write to |
| T6 | A trusted source is stale or wrong | Sources have a named owner, immutable snapshots, a freshness window; stale means `unknown`; every finding names the snapshot used | A source owner who vouches for wrong data. The product verifies provenance and age, not truth |
| T7 | A hostile file attacks the parser (archive bombs, external references, malformed structures) | Adapters are inert and bounded ([Formats §11](05-formats.md#11-parser-safety)); parsing is separated from credentials; failure is an `error` outcome | Parser bugs. Adapters should run with the least privilege the platform allows |
| T8 | Information leaks between projects (rule text naming another customer, evidence in a trace, an assistant's brief) | Project isolation applies to rules, evidence, briefs and traces (§6); context-decidable scoping keeps other projects' rules out of runs entirely | Workspace-level rules are visible to all members by design; their wording should not contain project-confidential details, and the proposal flow warns when a workspace-scope rule mentions a project fact |
| T9 | An assistant obtains an action credential | Credentials live in the OS keychain under the service, are never returned by any API, never appear in briefs or responses | Same-account setups ([Enforcement §6.4](06-enforcement-and-integration.md#64-credential-isolation-where-warranted)) |
| T10 | A receipt or approval is replayed for a different file, recipient or time | Bound to content hash, context, action parameters; single use; expiry | None identified |
| T11 | An approval prompt is imitated inside a chat | Approvals are only accepted from the app's authenticated session; assistant-facing operations cannot approve | A user tricked into approving in the real app. The pre-action review shows the exact version and recipient to make that harder |
| T12 | Work is placed under a project with weaker rules to dodge checks (including by dropping a marker file) | Markers are pointers, not authority; cross-project arrival with a different must-pass set prompts once and is recorded; documents naming a different customer than their project are caught by an ordinary rule | A person who deliberately registers work in the wrong place. It is visible in history, not prevented |
| T13 | Hidden content: what was checked is not what the recipient sees | Hidden text, tracked changes, hidden sheets and rows, dynamic fields and unread components are detected, flagged, and block as coverage gaps where they carry content | PDF text-layer/visual mismatch cannot be fully proven ([Formats §7.3](05-formats.md#73-pdf)) |
| T14 | Content is sent to an AI provider without the user realizing | Translator is optional; what it may send is explicit and minimal (§5); the model used is recorded on the candidate | Provider-side handling is outside the product's control |
| T15 | The clock is wrong or changed, defeating freshness and expiry | Backward jumps relative to the last event halt receipt issuance; `seq` is the authoritative order | Forward drift within plausible bounds |
| T16 | A malicious or careless imported policy pack | Signature check, preview of every rule as a rendered sentence, conflict analysis, examples re-run, steward approval (§7) | Trust in the publisher |
| T17 | **Poisoned learning.** Text planted in a document, email or tool result is turned into a rule automatically | Such text is never a signal. Only a user turn attested by a runtime hook, or typed into the app, is `user_direct`. An assistant's relay is never the person's words, and a relay whose text matches artifact or tool content is discarded and the artifact flagged. The decision procedure uses no model confidence | An attacker who can type as the user, or who controls a paired adapter (T19) |
| T18 | **Learning used to loosen controls.** A person, or injected text, says "stop checking X" or "no approval needed", and it is learned | The learning pipeline can only add requirements. Requests to weaken, except, pause, retire, or change approvals, roles, adapters or sources are declined, recorded, and the person is pointed to the proper route. A learned rule that conflicts with an approved or wider rule yields to it | None identified for approved rules. Learned rules can be paused automatically (T20) |
| T19 | **A forged or compromised capture adapter** fabricates user turns | Adapters are paired explicitly, carry an identity in every event, and can be revoked. What they can cause is bounded: add-only, one project, low-risk kinds, tests on real work, a daily limit, a notice for every activation | Within those bounds, a forged adapter could add unwanted (not loosening) rules until noticed. Notices and the audit list are the detection |
| T20 | **Automatic pause abused** to switch off a learned rule (two false "this finding is wrong" clicks, or a contradicting statement) | Only automatically added, unconfirmed rules can be paused; they move to shadow, stay visible, and raise an inbox item. A rule a person has kept, approved, locked or imported cannot be paused this way | A learned rule is weaker than an approved one by design. People who want it to hold click Keep |
| T21 | **Runaway learning**: many rules added quickly, blocking work | A daily limit per project (proposed 3); held-out failures tolerated: 0; every activation announced with Undo; a steward can turn learning off in one click, with learned rules moved to shadow | Rules that are individually reasonable and collectively annoying. The audit list and dispute counts show it |
| T22 | **Capture as surveillance or leakage**: more of people's conversation is stored than they expect, or one project's conversation informs another | Opt-in per project and per surface, by a steward; a notice line in every captured session; only listed people are captured; assistant and tool text is never stored; non-signal text is author-only and short-lived; events are bound to one project and never cross; consent is enforced at the intake | People forget that a surface is captured. The notice and capture health screen are the mitigation |
| T23 | **Silent loss**: corrections are missed and nobody knows | Sequence numbers, acknowledgements, heartbeats, completeness checks at session end, permanent display of unclosed gaps, dead-letter counts | Gaps on surfaces that were never captured at all are invisible by definition; the coverage labels say which those are |

## 3. Roles and permissions

| Capability | Owner | Rule steward | Source owner | Maker | Approver | Auditor | Assistant client |
|------------|:-----:|:------------:|:------------:|:-----:|:--------:|:-------:|:----------------:|
| Register folders, create projects, set project facts | ✔ | ✔ (own remit) | | ✔ (own projects, if allowed) | | | |
| Record a correction / propose a candidate | ✔ | ✔ | ✔ | ✔ | ✔ | | ✔ (candidate only) |
| Approve and activate a rule at workspace scope | ✔ | ✔ (workspace steward) | | | | | |
| Approve and activate a rule at project, area or document scope | ✔ | ✔ | | if allowed by owner | | | |
| Revise, pause, retire a rule | ✔ | ✔ (own remit) | | | | | |
| Grant an exception to a locked rule | ✔ | rule owner or workspace steward | | | | | |
| Grant an exception to an unlocked rule within a project | ✔ | ✔ (project steward) | | | | | |
| Register a source; import or re-confirm a snapshot | ✔ | | ✔ | | | | |
| Run checks; see findings for own projects | ✔ | ✔ | | ✔ | ✔ | ✔ (redacted) | ✔ (own submissions) |
| Confirm an attestation | named role per rule | | | if named | if named | | |
| Request a gated action | ✔ | | | ✔ | | | ✔ (creates request) |
| Approve a gated action | per action policy | | | only if "self" policy | ✔ | | |
| Configure adapters and approval policies | ✔ | | | | | | |
| Set, change or turn off the learning policy for a project | ✔ | ✔ (own remit) | | only in a one-person workspace | | | |
| Have one's direct corrections count for automatic learning | if listed | if listed | if listed | if listed in the policy | if listed | | never |
| Undo a learned rule; mark "not a correction"; suppress | ✔ | ✔ | | own, or any in own project if listed | | | |
| Keep (confirm) a learned rule; answer a learning inbox item | ✔ | ✔ | | if named as resolver in the policy, for low-risk items in scope | | | |
| Answer a request to widen a learned rule beyond the project | ✔ | ✔ (workspace steward) | | | | | |
| Pair or revoke a capture adapter | ✔ | | | for their own assistant, if allowed | | | |
| Export ledger, manage roles, retention | ✔ | | | | | export own view | |

Notes:

- A **steward's remit** is the workspace or named projects. Workspace stewards can see every project (they must, to own workspace rules responsibly); project stewards see their projects.
- **Solo mode.** One person holds every role. The product still records each act under the role it was performed in, and labels self-approval. Separation of duties in solo mode is procedural, not enforced, and the product says so in settings.
- **Two-person rules** (an approver must differ from the requester; a rule approver must differ from its proposer) are per-workspace settings available in team mode.

## 4. Governing the rule set

- **Every rule has one owner** (a person, not a group) and a review date. Ownership transfers are events. Rules whose owner leaves are queued to a steward.
- **Change control.** Any change is a new revision that passes the same gates as a new rule: validation against the schema, duplicate analysis, conflict analysis, example suite, and an authority decision at the right scope. That decision is a person's individual approval, or, for a low-risk rule inside one project, a learning policy that a person entitled to approve such rules saved in advance ([Learning §2](12-learning.md#2-authority-given-once)). The previous revision stays readable.
- **Before anything becomes active** (a new rule, a revision, an imported pack) the store runs: schema validation; structural duplicate detection; static conflict analysis against rules it can meet; the rule's examples. Failures block activation.
- **Exceptions** require: the rule, a scope no wider than the grantor's remit, a reason in words, an expiry within the rule's `exception_policy.max_days`. They show in every affected run and in the rule's effectiveness view. They cannot be granted by the person requesting the action unless that person is also the rule's owner, and then the record says so.
- **Pauses** require a reason and an end date.
- **Lapses go toward enforcement.** Exceptions, pauses, receipts and approvals expire; rules do not. A source going stale makes dependent rules *Couldn't verify*, which blocks. Nothing a person approved stops enforcing through the mere passage of time or through any automatic step. There is exactly one automatic movement the other way, and it is narrow: a rule that was added automatically and never confirmed can be moved to shadow by an automatic pause ([Learning §9](12-learning.md#9-after-a-rule-is-learned)). It stays visible, raises a question to a person, and is reversible.
- **Delegation is recorded authority.** A learning policy names who set it, when, for which project, and what it allows. Every rule it lets in records the policy and the decision. Turning the policy off is one click and an event. No learning policy can delegate exceptions, pauses, retirements, approval policies, roles, adapters, source designation, or anything beyond its own project.
- **Review.** Overdue rules are queued, not disabled. A rule that has been dormant for a long period is suggested for retirement to its owner.
- **Starter and imported rules** are ordinary rules with a different origin; they are not hidden defaults.

## 5. Privacy and data handling

- **Local by default.** The store, blobs and keys are on the user's machine (or the team's host). No account with any external service is required for the core loop.
- **No telemetry by default.** If product analytics are ever offered, they are opt-in and never include rule text, evidence or content.
- **The AI translator is optional and narrow.** When enabled, it receives: the correction text, the work type's field dictionary, the names of registered sources, and the catalogue of check kinds. It receives a passage from the artifact only if the person ticks "include the highlighted passage". It never receives source snapshots or whole artifacts. The provider (including a locally run model) is the workspace owner's choice, and the model identifier is recorded on the candidate.
- **Evidence is minimized.** Findings store the specific found and expected values and a short surrounding label, not paragraphs. Example files for rules are stored whole; the flow prompts owners to use minimal or scrubbed examples.
- **Retention and erasure** are defined per data class ([Observability §9.3](02-observability.md#93-retention-proposed-defaults-configurable-per-workspace)); erasing evidence and content does not break the ledger.
- **Encryption at rest.** The MVP relies on operating-system disk encryption and says so during setup. Encrypting blobs and evidence with the workspace key is intended for team mode ([Open questions Q8](10-open-questions.md)).
- **People in the ledger.** The ledger records who did what. Display names can be changed or removed; stable internal identifiers remain so that history stays coherent.
- **Capture is opt-in, per project and per surface.** Nothing is captured until a steward switches learning on for a project and ticks a surface. Captured sessions show a notice. Only the people listed in the policy are captured for learning. Assistant and tool output is never stored as text. Text of captured messages that were not identified as corrections is kept briefly, for their author only, and deleted; this window can be set to zero. Withdrawing consent stops capture at once ([Learning §12](12-learning.md#12-projects-privacy-consent-deletion)).

## 6. Isolation

**Between workspaces (organizations):** complete. Separate store, separate blob directory, separate keys. The service never runs a query across workspaces. A user who belongs to two workspaces switches between them; nothing is merged, compared or suggested across them.

**Between projects in a workspace:** enforced in the service on every read, by role grants.

| Could leak through | Rule |
|--------------------|------|
| Artifacts, findings, evidence, diffs | Visible only to members of the artifact's project, plus roles in §3 |
| Rule text | Project-, area- and document-scoped rules are visible only within that project. Customer-scoped rules are visible only in projects for that customer. Workspace rules are visible to all |
| The assistant brief | Built only from rules in scope for the resolved project |
| "Not in scope" inventory | Rules the viewer may not see are counted, not named |
| Duplicate and conflict hints when proposing a rule | Computed only against rules the proposer may see. Conflicts with rules they may not see are raised to a steward who can see both |
| Dry runs | Run only over projects the approver may see |
| Lineage ("came from project A") | Shown as "another project" without permission for A |
| Translator context | Only the current project's dictionary and the current correction |
| Trusted sources | A source is workspace-level but must be explicitly made available to a project before its rows can appear in that project's findings |
| Exports | Filtered by the exporter's view |
| Captured events and signals | Bound to exactly one project when they happen; never used as evidence, shown, or acted on in another. An unbound event is not guessed |
| Learned rules | Active only in the policy's project. A request to widen shares the rule sentence, not the words or documents it came from |
| The "captured, not seen as corrections" list | Visible only to the person who typed each message |

Acceptance tests for isolation are in [MVP and acceptance, AT-I1 to AT-I7](08-mvp-and-acceptance.md#5-acceptance-tests).

## 7. Ledger integrity, backup, export and import

**Integrity**

- Each event stores the hash of the previous event's envelope; envelopes include the digest of their payload. Altering, removing or reordering an event breaks the chain from that point.
- **Anchors.** At intervals (default daily and on demand) the service signs the latest `(seq, hash)` pair. The signed anchor can be saved to a location the workspace owner controls outside the store, or, in team mode, is kept by the host. An anchor held elsewhere is what turns "internally consistent" into "unchanged since that date".
- **Verify history** in the app recomputes the chain, checks signatures and anchors, and reports the first inconsistency in plain language.
- This is tamper *evidence*. The design does not claim tamper prevention on a machine its user fully controls.

**Backup and restore**

- A backup is one encrypted bundle (database plus retained blobs) produced while the service is running. Restoring on a new device restores the workspace; folders are reconnected by their markers with one confirmation each.
- Keys are backed up separately through the operating system's keychain mechanisms or an explicit recovery phrase. Losing the signing key does not lose data; old receipts can no longer be verified and the ledger records a key change.

**Export**

| Export | Format | For |
|--------|--------|-----|
| Rules list | Printable document and CSV | Reading, sharing, review meetings |
| Policy bundle | Signed JSON: rule revisions, examples (optional), field mappings | Moving rules to another workspace |
| Trace packet | Printable document plus JSON events | Explaining one piece of work to a customer, manager or auditor |
| Full ledger | JSON lines with the chain | Archival, independent verification |

**Import of a policy bundle**

1. Verify the signature and show who published it.
2. Show every incoming rule as its rendered sentence with examples, and a diff against existing rules.
3. Run duplicate and conflict analysis; re-run the bundle's examples locally.
4. A steward approves; imported rules become candidates-then-active like any others, with origin `imported_pack`.

## 8. Known limitations

Collected in one place so that nobody has to infer them.

1. **This is a specification.** No component exists yet; no claim here has been tested.
2. **Enforcement stops at the gateway's edge.** Outside registered routes, the product advises and observes.
3. **Rules cover described mistakes only.** A new kind of error passes until someone corrects it. "Ready" means "met these rules", not "correct".
4. **A deterministic rule can be deterministically wrong.** It enforces what was approved, which may differ from what was meant. Examples, dry runs and trial mode reduce this; they do not remove it.
5. **Field understanding depends on mappings.** Free-form documents vary. When a mapping does not fit, the honest result is *Couldn't verify*, which is safe but can be tiresome. Whether that friction is acceptable is the main usability risk of the design and must be tested with users early.
6. **Sources are trusted on a person's word.** The product checks which version and how old, not whether the data is right.
7. **Single-machine tamper resistance is limited** (T5), as is credential isolation in same-account setups (T9).
8. **Solo mode has no real separation of duties.**
9. **PDFs and scans are second-class.** Heuristic structure, confidence thresholds and the text-versus-appearance gap all limit what can be asserted.
10. **Conflict detection is partial.** Only comparable rule kinds on the same target are analysed ahead of time.
11. **Effectiveness figures are descriptive.** They cannot show that the product caused work to improve, and they cannot see missed problems nobody reported.
12. **People can still approve without looking.** The design makes the right information unavoidable on the approval screen; it cannot make anyone read it.
13. **Reliable delivery is not reliable understanding.** Capture adapters make it very unlikely that a typed correction is lost on a connected surface. They do nothing about a correction that is ambiguous, phrased as a question, implied, or simply not recognized. Some will be missed and some non-corrections will be picked up; the queue makes both visible and cheap to fix, not impossible.
14. **Only connected surfaces are seen.** A correction made in a tool without an adapter, in a meeting, or by a person not listed in the learning policy is not captured.
15. **Automatically added rules are only as good as their tests.** A rule can catch the corrected draft, pass the corrected version, flag no other existing work, and still be wrong for the next document. The safeguards are narrow scope, a notice with Undo, dispute-triggered pause and a review date, not proof.
16. **All learning thresholds are uncalibrated proposals.** Episode counts, daily limits, dispute counts and time windows are starting values with no data behind them yet.
