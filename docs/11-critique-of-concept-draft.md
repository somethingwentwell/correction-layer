# 11 · Critique of the concept draft and working hypotheses

This design started from an earlier concept page ("Encode the Correction, Beyond Git and CI") and a list of working hypotheses. Neither was treated as decided. This document records what was kept, what was tightened, what was replaced, and why.

## 1. What the concept draft got right

- **The core loop**: correction → reviewed constraint → deterministic check → fix → recheck → separately authorized action.
- **"A pass is not permission."** Kept verbatim in spirit and made a field in the data (`grants_permission: false`).
- **Advisory is not enforcement**, and only a wired-up gateway can block.
- **No scripts in policy; deterministic selection, not model retrieval.**
- **Unknown is not a pass.**
- **A narrow first slice** around proposal documents.

## 2. Where the draft was thin or mistaken

| Draft position | Problem | This design |
|----------------|---------|-------------|
| "Four pieces are enough": store, structured artifacts, check interface, gateway | Omits the two places where real-world use fails first: knowing *which project a file belongs to*, and turning a real file into something checkable | Context resolver and format adapters are first-class components ([04](04-context-and-scope.md), [05](05-formats.md)) |
| The checker "receives a typed document" | Assumes away the hardest step. Somebody has to decide which number is the unit price | Field dictionaries, human-confirmed mappings, and an extraction-method ladder in which model-extracted values cannot satisfy must-pass rules ([05 §5](05-formats.md#5-semantic-fields-and-how-they-are-extracted)) |
| Decision bound to artifact hash, policy revision and source snapshot | Too coarse and incomplete. A workspace-wide policy revision invalidates every receipt on any unrelated change; context, action parameters and parser version were unbound; re-hashing a path leaves a gap | Receipt binds context, action, in-scope rule-set digest, sources, parser and engine; gateway acts on the checked bytes; newer versions pause ([06 §3](06-enforcement-and-integration.md#3-validation-receipts)) |
| Lifecycle: approval, then regression cases | The approver approves a sentence without seeing what it does | Examples and a dry run precede approval; trial mode exists ([ADR-010](09-decisions.md#adr-010--examples-and-a-dry-run-come-before-approval-trial-mode-exists)) |
| Rule status "candidate, active, or expired" with `review_by` as an expiration | A rule that silently stops enforcing on a date is an enforcement gap nobody chose | Rules never lapse by time. Review dates queue a rule for its owner. Only exceptions, pauses, receipts and approvals expire, and they expire *toward* enforcement |
| Scope = organization, workflow, artifact type, action | No project, folder or customer; no way to express "this customer's quotes" | Scope levels: workspace, project group by fact, project, area, document, plus work type, artifact type, action ([04 §5](04-context-and-scope.md#5-which-rules-apply-deterministic-scope-matching)) |
| Phases: checker first, approval and memory second, registry third | Approval, examples and history are the idea, not later additions. Observability was absent | MVP includes the whole correction lifecycle and the observability minimum ([08](08-mvp-and-acceptance.md)) |
| Audit as a log | Cannot answer "why did this run", "what changed", "who fixed it" for a non-technical reader | Ledger with explicit causality as the source of truth for dedicated screens ([02](02-observability.md)) |
| Users implied to be developers or operators | No onboarding, no plain-language rule review, no screens | [01](01-product-ux.md) |

## 3. The working hypotheses, one by one

| Hypothesis | Verdict | What changed and why |
|------------|---------|----------------------|
| Local-first versioned SQLite store, immutable revisions, audit, no Git | **Keep, tighten** | Store lives outside project folders; folders hold only a pointer; blobs are content-addressed; single writer; chain over digests. Trade-off: sharing needs export/import or a host ([ADR-001](09-decisions.md#adr-001--a-per-workspace-sqlite-store-outside-project-folders-with-no-git-dependency)) |
| Lifecycle: correction → candidate → approval → cases → activate → validate → repair → recheck → authorized action → audit | **Reorder, extend** | Cases and dry run before approval; trial state; explicit outcomes that are *not* rules (guidance, "fix the template"); repair is attributed to whoever made the change, never to the check |
| AI translates natural language to typed checks; cannot activate or infer universal semantics | **Keep, tighten** | Output must validate against schema, dictionary and source registry; the approved sentence is rendered from the typed rule; AI is optional; narrowest scope is preselected and widening needs a named approver |
| Subjective criteria stay advisory, model-evaluated or human | **Keep, formalize** | `method` axis; `model_review` cannot block and its "pass" satisfies nothing; `attested` rules block until a person confirms |
| External-data checks need an authoritative source and freshness; unknown never silently passes | **Keep, extend** | Sources are objects with a human owner and immutable snapshots. "Unknown" also covers undecidable applicability, mapping misses, low reading confidence, unread components and missing lookup keys |
| No arbitrary code in policy | **Keep** | Closed catalogue; restricted patterns with mandatory examples |
| Workspace/project identities, folder registration, nested boundaries, shared/copied/moved artifacts | **Keep, specify** | Identity is never a path; marker is a pointer; lineage rules; receipts and exceptions do not travel; questions only when must-pass rules differ |
| Deterministic org/project/folder/workflow/artifact/action scope | **Tighten** | Split into context-decidable scope (indexed) and content conditions (after parsing). "Folder" as a rule level becomes *area*; "customer" is handled by project facts |
| Mandatory global rules cannot be weakened; conflicts surface; not "most local wins" | **Replace the mechanism** | Conjunction of all in-scope rules makes weakening structurally impossible. No precedence exists to get wrong. Variation by parameterization or recorded exception ([ADR-002](09-decisions.md#adr-002--rules-combine-by-conjunction-nothing-overrides)) |
| Untrusted document instructions are data | **Keep, specify** | The known paths from artifact text to policy are enumerated; each is closed or put behind a person's approval (a careless approver remains a risk) ([04 §10](04-context-and-scope.md#10-untrusted-content-is-data)) |
| Session bootstrap; re-resolve per artifact and action | **Keep, sharpen** | Sessions hold no authority at all; context is resolved from the artifact on every call; the brief is explicitly advisory and may be shortened; checks are complete |
| Skills cannot guarantee obedience; advisory versus gateway | **Keep, make visible** | Three tiers, tier in every response, coverage labels generated from configuration, an OBSERVED label for watched folders |
| Root action adapters with isolated credentials | **Keep, qualify** | Same-account setups are labelled as bypassable; a dedicated sending identity is recommended; real isolation arrives with team mode |
| Minimum handshake, adapter lifecycle, offline | **Specified** | Two-operation minimum (`hello`, `check`); lifecycle tables; offline defined per mode |
| Unknown origin or ambiguous scope prompts or blocks | **Keep** | With a materiality rule so that prompts are rare |
| Extension is not type; unsupported components do not pass | **Keep, specify** | Content-based identification; per-artifact coverage report; run-level coverage gaps cleared only by removal or attestation |
| Typed artifact plus provenance; formulas, OCR, hidden content, schema versions, support matrix | **Keep, extend** | Adds the extraction-method ladder, typed-value honesty (bare "$", ambiguous dates), "check the source, release the render" as a later pattern |
| Receipt bound to hash, action, policy version, project, source snapshot, expiry; revalidate on change | **Keep, tighten** | In-scope digest instead of global version; parser and engine bound; single use; act on stored bytes; at-most-once execution |
| Permission is separate from validation | **Keep** | Different roles, different events, different surfaces; never approvable by an assistant |
| States: hard / warn / unknown / manual | **Replace** | Three axes: method, enforcement, outcome ([ADR-011](09-decisions.md#adr-011--method-enforcement-and-outcome-are-separate-axes)) |
| Privacy, isolation, roles, exceptions, tamper model, audit, backup, dedup/conflict tests | **Specified** | With the explicit admission that single-machine integrity is tamper-evident at best |
| Rule growth: indexed deterministic discovery of all mandatory rules; owners; review/retire; targets as goals | **Keep, extend** | Adds digest-audited completeness, recomputable "not in scope" inventory, families-to-tables consolidation, and the brief/check distinction |
| UX: no JSON/Git/terminal; four-step start; plain correction flow; listed views | **Keep, extend** | Adds teach-by-pointing, dry-run preview, "keep as a note", stale-verdict display, the coverage map |
| Visual observability as first-class | **Designed** | Five verbs kept apart; eight screens; event model with causality; definitions and caveats for effectiveness |

## 4. Things this design deliberately does not claim

- That rules make work correct.
- That checks improve artifacts.
- That any assistant will comply.
- That effectiveness numbers show causation.
- That a single laptop can protect a store from its own administrator.
- That the hard part of reading documents is solved; it is bounded, made honest, and scheduled for early testing.

## 5. A later revision: capture and learning

After the first version of this design was delivered, two of its own positions were revised ([Learning](12-learning.md), ADR-014 to ADR-017):

| Earlier position in this design | Problem | Revision |
|---------------------------------|---------|----------|
| Every must-pass rule is approved individually by a person | The safest option and, in practice, the reason corrections go unrecorded | Authority may be given once, per project, through a learning policy. Low-risk, tested rules then activate without a per-rule click, with a notice, Undo and automatic pause. Everything else still needs an explicit decision |
| A correction said to an assistant reaches the product only if the assistant passes it on | Inherits the predecessor's weakness: capture depends on a model remembering | Capture adapters deliver the person's own turns, edits and rejections durably, with acknowledgements, replay, gap detection and visible health. Relay remains, labelled best effort |
| "AI cannot activate" | Still true, and now more precise | Activation under a learning policy is done by a deterministic procedure that uses no model confidence; a model can only add caution |

What did not change: rules are a closed catalogue of typed checks; they combine by conjunction; unknown never passes; checks do not repair; approval of actions is separate; enforcement exists only on gated routes; and the product claims no more than it can see.
