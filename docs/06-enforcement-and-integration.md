# 06 · Enforcement and integration

> Proposed design. Nothing in this document is implemented. JSON shown here is a proposed contract.

## 1. Three tiers and an honest label

No instruction file, skill or reminder can make an arbitrary AI runtime obey. Enforcement exists only where the product physically sits between the work and the consequence. The design therefore names three integration tiers and never lets a weaker one borrow the vocabulary of a stronger one.

| Tier | Mechanism | What it achieves | What it cannot do |
|------|-----------|------------------|-------------------|
| **Guidance** | A skill or instruction file plus the session brief: "ask Correction Layer before you call work done" | The assistant usually knows the rules and usually checks | Guarantee anything. Instructions can be ignored, truncated or overridden by other text |
| **Checkpoint** | Runtime hooks, where a runtime offers them (session start, before certain tool calls), that call `check` automatically | Checks happen without relying on the assistant's memory | Cover runtimes without hooks; survive a user removing the hook; block what the runtime does not route through hooks |
| **Gateway** | The action can only be performed by an adapter that the gateway controls, because the gateway holds the credential or capability | The action does not happen without a valid receipt and any required approval | Affect any other route to the same outcome |

On screen, each action in a project carries exactly one **coverage label**, generated from what is actually configured ([coverage map](02-observability.md#58-obs-8--coverage-map)):

| Label | Meaning |
|-------|---------|
| **GATED** | A gateway adapter is the registered route. Without Ready and the required approval it will not run. Always shown with a qualifier: *exclusive route* (the adapter holds the only means of doing this), *by convention* (other routes exist; the team has agreed to use this one), or *same-account* (see §6.4) |
| **ADVISORY** | Guidance or checkpoint integration is connected. Checks are offered or triggered; nothing is blocked |
| **OBSERVED** | Registered folders are watched; new versions are noticed and can be auto-checked; nothing is blocked |
| **NOT COVERED** | The product has no view of this route |

Every API response states whether it is advisory or from the gateway (`"enforcement_tier": "advisory"`; guidance and checkpoint integrations are both advisory), and every verdict shown in an assistant's chat is prefixed accordingly ("Advisory check: Needs changes"). See [ADR-005](09-decisions.md#adr-005--three-integration-tiers-with-coverage-labels-generated-from-configuration).

## 2. The portable contract

The contract is small on purpose, so that any assistant, script or application can implement it.

### 2.1 Operations

| Operation | Purpose | Writes |
|-----------|---------|--------|
| `hello` | Introduce a client and its working location; receive context, brief and gated actions | A session |
| `resolve` | Context for one artifact and intended action | Nothing |
| `list_rules` | Every rule sentence in scope for a context (the unshortened brief) | Nothing |
| `check` | Check one artifact version for an intended action; receive verdict, findings, fix proposals and, if Ready and gateable, a receipt id | A run |
| `report_change` | Declare "I produced this new version, applying this fix proposal, for this person" | Attribution on a change |
| `propose_correction` | Pass on a person's correction with its context. This is *relay*: best effort, dependent on the assistant, never treated as the person's own words (§11) | A candidate (inactive) |
| `request_action` | Ask the gateway to perform a registered action on a checked version | A request awaiting approval |
| `get_status` | Status of a run, an action request or a pending question | Nothing |

**Minimum handshake:** a client that implements `hello` and `check` is a conforming advisory client. Everything else is optional.

**Deliberately absent:** approving a rule, activating a rule, setting or changing a learning policy, granting an exception, confirming an attestation and approving an action. These are human acts performed in the app. No assistant-facing operation can perform them, and the service rejects them from client tokens ([§4](#4-approval-is-separate-from-validation)). Where a rule turns on automatically under a learning policy, the service's own decision procedure does it; delivering events is the only way a client can contribute, and what it delivers is evidence, not an instruction.

### 2.2 Shapes

Session start. Response shape: [context.schema.json](../schemas/context.schema.json); full example: [context.json](../examples/sales-proposal/context.json).

```json
{
  "op": "hello",
  "client": { "name": "example-assistant", "version": "3.2", "runtime": "desktop" },
  "location": { "kind": "path", "value": "/Users/priya/Documents/Proposals/Meridian Clinics" },
  "on_behalf_of": "usr_PRIYA001"
}
```

Check request and abridged response, here for an assistant checking an older quote under today's rules. The full run record behind a response has the shape [run.schema.json](../schemas/run.schema.json); a complete example is [run-1-needs-changes.json](../examples/sales-proposal/run-1-needs-changes.json).

```json
{
  "op": "check",
  "session_id": "ses_PRIYA1112",
  "artifact": { "kind": "path", "value": "/Users/priya/Documents/Proposals/Meridian Clinics/Meridian-Pilot-Quote.docx" },
  "action": { "type": "send_external" }
}
```

```json
{
  "enforcement_tier": "advisory",
  "run_id": "run_PILOT002",
  "context": { "status": "resolved", "project_id": "prj_MERID26R", "work_type": "sales_proposal", "context_changed": false },
  "policy_rev": 10,
  "verdict": "needs_changes",
  "human_summary": "Advisory check: Needs changes. 4 things to fix before this can be sent. 1 note.",
  "counts": { "in_scope": 7, "pass": 3, "fail": 2, "unknown": 0, "not_applicable": 1, "notes": 1 },
  "review_url": "correction-layer://review/run_PILOT002",
  "receipt_id": null
}
```

`human_summary` is rendered by the service and meant to be shown verbatim, so that different assistants describe results the same way.

### 2.3 Bindings

| Binding | For | Notes |
|---------|-----|-------|
| MCP server (stdio) | Assistants that support the Model Context Protocol | One tool per operation |
| Local HTTP on loopback | Applications and browser-based tools | Per-client token issued by a pairing step the user confirms in the app |
| CLI | Hooks, scripts, developers | `correction-layer check <file> --for send_external`; exit status reflects the verdict |
| Skill / instruction file | Guidance tier | Tells an assistant when to call `check`, to show `human_summary` verbatim, to pass on corrections, and to say plainly "Correction Layer is not running; this was not checked" when it gets no answer |

**Pairing.** The first time a client connects, the app asks the user to allow it and for which folders. The client receives a token that identifies it in every session. Client tokens can check and propose; they cannot approve.

### 2.4 Lifecycle of a connected client

1. **Pair** (once): user approves in the app.
2. **Hello** (per session): context and brief for the working location.
3. **Work**: `check` as often as wanted; each call re-resolves context from the artifact ([Context §8](04-context-and-scope.md#8-sessions)).
4. **Pass on corrections**: `propose_correction`; the person reviews in the app.
5. **Request actions**: `request_action`; a person approves in the app; the gateway executes.
6. **Disconnect or crash**: nothing to clean up. State lives in the store.
7. **Revoke**: the user removes the client in the app; its token stops working.

## 3. Validation receipts

A **receipt** is the service's signed statement that one exact artifact version met the rules in scope for one action, at one time, using specific sources. Proposed shape: [receipt.schema.json](../schemas/receipt.schema.json); example: [receipt.json](../examples/sales-proposal/receipt.json).

| Bound to | Field | Why |
|----------|-------|-----|
| The exact bytes | `artifact.artifact_id`, `artifact.content_hash` | A different file, or an edited one, has no receipt |
| The context | `workspace_id`, `project_id`, `area_ids`, `work_type` | A copy in another project has no receipt |
| The action | `action.type`, and `action.params_digest` when any rule read action parameters | Ready-to-release is not ready-to-send-externally |
| The rules | `policy.policy_rev`, `policy.ruleset_digest` (hash over the in-scope rule ids, revisions and applied exceptions) | A rule change in scope invalidates it; unrelated rule changes elsewhere do not |
| The sources | `sources[].snapshot_id`, `fresh_until` | A newer or stale source invalidates it |
| The readers | `parser`, `engine_version` | An upgrade invalidates it |
| Time | `issued_at`, `expires_at` | Default lifetime 24 hours, shortened to the earliest `fresh_until` of any source used |
| Use | `single_use`, `status` (`valid`, `invalidated`, `expired`, `consumed`) | One execution per receipt |
| Meaning | `grants_permission: false` | Stated in the data itself: a receipt is evidence, not authorization |

The receipt is signed with the workspace key. The gateway acts on the **snapshot of the bytes that were checked** (kept in the blob store under the content hash), not on whatever is at the file path at execution time. This closes the check-then-edit gap more firmly than re-hashing a path: what was checked is, literally, what is sent. See [ADR-006](09-decisions.md#adr-006--receipts-bind-everything-the-verdict-depended-on-the-gateway-acts-on-the-checked-bytes).

What invalidates a receipt:

| Change | How it is noticed | What happens |
|--------|-------------------|--------------|
| The file was edited | New version observed; hash differs | Old receipt applies only to the old version. Auto-recheck of the new version if findings were open or an action is pending |
| A newer version exists at execution time | Lineage lookup | Gateway pauses and asks the approver which version is intended |
| A rule in scope was added, revised, paused, resumed or retired; an exception started or ended | `ruleset_digest` for the same context no longer matches | Invalidated; auto-recheck if an action is pending |
| The artifact moved to another project, or project facts changed | Context re-resolved | Invalidated |
| A source used has a newer snapshot or is past its freshness window | Source registry | Invalidated; auto-recheck if an action is pending |
| Parser or engine upgraded | Versions differ | Invalidated |
| Time ran out | `expires_at` | Expired |
| Already used | `status = consumed` | A second execution is refused |

## 4. Approval is separate from validation

Validation answers "does this meet the rules?". Approval answers "should this happen?". They are different questions, asked of different parties, recorded as different events.

- **Who approves** is configured per action and project: a named role, the requester themselves (small setups), or "no approval required" for low-risk actions such as an internal release. The last is a standing pre-authorization: a decision by the workspace owner, recorded with their name and date, shown on every execution it covers, and revocable. A passing check never *becomes* an approval; where none is required, that is because a person decided so in advance.
- **What the approver sees** is the pre-action review ([UX-8](01-product-ux.md#ux-8--pre-action-review-the-approvers-view)): the exact version, action, recipient, every rule applied with its result, exceptions in force, unread parts, and what changed since the first check.
- **What an approval is bound to**: the receipt id, the content hash, the action type and the digest of the action parameters. It expires with the receipt. If the receipt is replaced (for example after a source update), the approval does not carry over by default; the approver is asked again with "what is different" highlighted ([Open questions Q4](10-open-questions.md)).
- **Where approval happens**: in the app, by an authenticated person. Assistant-facing operations cannot approve, and approval prompts are never rendered inside an assistant's conversation where injected text could imitate them.
- **Rule approval is a different permission** from action approval. Being allowed to send does not allow changing what is checked, and vice versa.

Proposed shape for requests and approvals: [action-request.schema.json](../schemas/action-request.schema.json); example: [action-request.json](../examples/sales-proposal/action-request.json).

## 5. What the gateway does at execution time

```mermaid
sequenceDiagram
    participant P as Maker
    participant A as Assistant
    participant S as Service
    participant G as Gateway
    participant M as Approver
    participant X as Action adapter
    A->>S: check(version 2, send_external)
    S-->>A: Ready, receipt R
    P->>G: request_action(send, recipient, R)
    G-->>M: approval needed (pre-action review)
    M->>G: approve (bound to R, version, recipient)
    G->>S: revalidate everything R depends on
    S-->>G: all bindings hold
    G->>X: execute with the checked bytes
    X-->>G: outcome
    G-->>P: done, recorded
```

The gateway's checks, in order. Each failure produces an `action.blocked` event naming the item:

1. The request is well formed and the adapter is enabled for this project.
2. Context resolves, and to the same project as the receipt.
3. The receipt exists, its signature verifies, its status is `valid`, it has not expired.
4. The snapshot bytes hash to the receipt's `content_hash`.
5. No newer version of the artifact exists. Otherwise the request moves to `paused_newer_version`, an `action.paused` event is recorded, and the approver is asked which version is intended.
6. The in-scope rule set for this context still has the receipt's `ruleset_digest`.
7. Every source snapshot used is still the latest and still fresh.
8. Parser and engine versions are unchanged.
9. The required approval exists, from a permitted person, bound to this receipt and these parameters, unexpired; or the recorded policy says none is required.
10. Mark the request `executing`, hand the snapshot bytes and parameters to the adapter, record its outcome, mark the receipt `consumed`.

Where a failure at steps 6 to 8 can be cured by a fresh check, the gateway triggers one automatically; a new receipt then needs a new approval. The gateway never substitutes its own judgment for a missing binding.

**At most once.** For actions that cannot be undone, the request is marked `executing` before the adapter is called. If the service stops before an outcome is recorded, the request becomes `outcome_unknown` and is shown to a person; it is never retried automatically.

## 6. Action adapters

An action adapter is the root of a gated route: the single component able to perform a kind of action.

### 6.1 Lifecycle

| Stage | Who | What |
|-------|-----|------|
| Install | Product release | The adapter ships with a capability declaration |
| Configure | Workspace owner, in the app | Provide what the adapter needs (a folder; a mailbox sign-in). Credentials go to the operating system keychain under the service's identity |
| Enable per project | Workspace owner | Choose which projects may use it and the approval policy for each |
| Health check | Service | A dry run confirms the adapter can reach its target without performing the action |
| Execute | Gateway only | After the checks in §5 |
| Disable or revoke | Workspace owner | Immediate; pending requests are blocked with a reason |

### 6.2 Capability declaration (proposed)

```json
{
  "adapter_id": "adp_EMAIL001",
  "kind": "email_send",
  "action_types": ["send_external"],
  "params": {
    "to": "list of email addresses (required)",
    "cc": "list of email addresses",
    "subject": "text (required)",
    "body_text": "text",
    "attach_as": "original"
  },
  "reversible": false,
  "supports_dry_run": true,
  "credential": { "kind": "mailbox_sign_in", "held_by": "gateway", "visible_to_clients": false },
  "outcome_fields": ["provider_message_id", "accepted_at"]
}
```

### 6.3 First adapters

| Adapter | Phase | How it gates | Honest limits |
|---------|-------|--------------|---------------|
| **Release folder** | 1 (MVP) | Copies the checked bytes into a designated "Released" folder with a release record (content hash, receipt, approval, time). The app can verify any file against its record | No credential is involved; anyone can still copy a draft elsewhere by hand. The gate is real only for teams that adopt "we send only what is in Released", and the release record makes departures detectable, not impossible. Labelled *GATED, by convention* |
| **Email send** | 2 | The gateway holds the sign-in for a sending mailbox and sends the checked bytes as the attachment | Exclusive only if that mailbox cannot be used any other way. Recommended: a dedicated sending identity (e.g. a shared quotes address) whose sign-in exists only in the gateway |
| **Others** (document portals, CRM updates, payment file export) | 3 | Same pattern | Each needs a credible exclusive route to be labelled *GATED, exclusive route* |

### 6.4 Credential isolation, where warranted

- The release folder needs no secret; isolation is not relevant.
- Network adapters keep credentials in the OS keychain, readable by the service process only, never returned by any API and never present in an assistant's context.
- **Single-user caveat.** On one laptop where an assistant runs with the same operating-system account as the service and has shell or file access, the operating system does not separate them strongly. The design does not pretend otherwise: in that setup the coverage label for network adapters reads "GATED, same-account (an assistant with full computer access could bypass)". Real isolation needs the service under a separate account or on a separate machine, which is what team mode provides ([MVP §2](08-mvp-and-acceptance.md#2-phases)).

## 7. Exceptions and confirmations at the gate

- **Exception.** Requested from a review screen, decided by the rule's owner (or a project steward for unlocked rules), with a reason, a scope (this document, this project, this customer) and an expiry. Granting one advances the policy revision, triggers a recheck, and the rule then reports `waived` with its underlying result still shown. The receipt lists the exception ids used; the approver sees them.
- **Confirmation (attestation).** For person-confirms rules, low-confidence readings and unread parts. Bound to the exact content hash; a new version needs a new confirmation. Recorded with who confirmed and the statement they confirmed.
- Neither is available to assistant clients.

## 8. Offline and degraded behaviour

"Local-first" means the core loop needs no network. Precisely:

| Condition | Checks | Sources | Translator | Gated actions |
|-----------|--------|---------|------------|---------------|
| **No network, solo mode** | Work normally | Imported snapshots work until they pass their freshness window, then `unknown` | AI suggestions unavailable; templates work | Release folder works. Network adapters fail visibly (`action.failed`); nothing is queued silently; retry is a deliberate act while the receipt is valid |
| **Team mode, device cannot reach the workspace host** | Advisory checks against the last synced, signed copy of the rules, labelled "offline copy, rules as of *time*". No receipts are issued | Last synced snapshots; freshness still applies | As above | None |
| **Local service not running** | None. Clients get no answer; the skill instructs assistants to say so. The app later shows the work as "not checked" | — | — | None can execute, because the capability lives in the service |
| **Model provider unreachable** | Unaffected. `model_review` rules are `skipped` (they are notes only) | — | Templates only | Unaffected |
| **Clock problem** (large jump backwards relative to the last event) | Run, but no receipts until a person confirms the time | Freshness cannot be judged; `unknown` | — | Held |

## 9. Concurrency and idempotency

- **One writer.** All mutations go through the service, giving the ledger a single order.
- **Receipts are single use**, consumed in the same transaction that records the execution outcome.
- **Idempotency keys** on `request_action` (derived from artifact version, action type and parameters) collapse duplicates from retries or from two assistants asking for the same thing.
- **A request for something already done** ("this version was sent to this recipient 3 minutes ago") is shown as such and needs explicit confirmation to repeat.
- **Simultaneous edits** produce successive versions; each run and receipt names its version; the newer-version check in §5 prevents acting on a superseded one unnoticed.

## 10. What cannot be enforced

Stated here once, and reflected in the product through coverage labels:

- Anything done outside a registered gateway route: attaching a file by hand, copying text into another system, printing.
- An assistant that never calls `check` on an advisory route.
- Work in folders that were never registered.
- Content the adapters cannot read, beyond refusing to call it Ready.
- Mistakes nobody has yet described as a correction.
- A workspace owner who deliberately misconfigures or removes the gate. That is visible in the ledger, not preventable.

## 11. Capture adapters

Checks and gates are one half of integration. The other half is hearing corrections in the first place. The predecessor tool, and the `propose_correction` relay above, depend on an assistant noticing a correction and choosing to pass it on. That is useful and unreliable. A **capture adapter** removes the dependence: it is a small component attached to a supported runtime or app that delivers events (what the person typed, what changed, what was rejected) to the local service **durably**, whether or not any AI model was paying attention.

Proposed shapes: [capture-event.schema.json](../schemas/capture-event.schema.json), [capture-stream.schema.json](../schemas/capture-stream.schema.json); example: [capture-stream.json](../examples/learning/capture-stream.json).

### 11.1 What an adapter emits

| Field | Purpose |
|-------|---------|
| `capture_id` | Idempotency key: the same source event always has the same id, however many times it is delivered |
| `stream_id`, `source_seq` | One stream per session or surface; a gap-free sequence number assigned by the adapter |
| `kind` | `session_start`, `user_turn`, `agent_output`, `tool_output`, `edit_observed`, `review_action`, `heartbeat`, `session_end` |
| `role`, `attested_by` | Who produced it (`user`, `agent`, `tool`, `system`) and who vouches for that: the runtime's own hook, the app, a transcript, or nobody. Only a user turn attested by a runtime hook or the app counts as typed by the person |
| `binding` | Where it happened, as known at the source at that moment: the folder binding, the project if resolvable, the artifact and version it concerns |
| `content`, `content_digest` | The person's text for user turns and review actions. For agent and tool output, a digest only; their text is not sent |
| `final_seq` | On heartbeats and session end: the adapter's highest sequence number, so the receiver can tell whether it has everything |

### 11.2 Operations

| Operation | Purpose |
|-----------|---------|
| `capture_hello` | The adapter names itself and its stream and reports its last sequence number. The service answers with its cursor (the highest sequence it has safely received with nothing missing below it) and whether this project has consented to capture on this surface |
| `capture_deliver` | One or more events. The service stores them in one transaction and answers with a result per event and the new cursor |
| `capture_heartbeat` | "I am alive and my last sequence number is N" |
| `capture_close` | The stream has ended at sequence N |

### 11.3 Delivery guarantees

| Property | Mechanism |
|----------|-----------|
| **Nothing is dropped because the service was busy, restarting or absent** | The adapter writes each event to a local, append-only outbox *before* trying to deliver it, and removes it only when the cursor has passed it |
| **Acknowledgement** | Every delivery returns the cursor. An event is "captured" only when it is at or below the cursor |
| **At-least-once in, effectively-once out** | Adapters retry until acknowledged. The intake is idempotent on (`stream_id`, `source_seq`): a repeat with the same digest is acknowledged and dropped; a repeat with a *different* digest is refused and raised as an integrity problem |
| **Order** | Events may arrive out of order. The intake holds an early arrival and processes the stream strictly in sequence, so "this time" is never read after the instruction it qualifies |
| **Replay after a restart** | On reconnecting, `capture_hello` returns the cursor and the adapter re-sends everything above it from its outbox |
| **Backfill** | Where a runtime keeps its own transcript, an adapter that itself was down can rebuild missed events from it. Backfilled events are marked as such, attested by transcript rather than by a live hook, and can lead to the inbox at most by default |
| **Lateness** | An event processed more than a set time after it happened (proposed 24 hours) can lead to the inbox at most: the moment has passed and the preference may have changed |
| **Completeness check** | Heartbeats and `capture_close` carry the adapter's last sequence number. If it is above the cursor, there is a gap, and the stream says so |

The intake procedure, which the repository checker runs against the example stream:

```text
intake(delivery):                      # per stream; state: received, cursor
  if delivery.seq already received:
      same digest      -> result DUPLICATE          (acknowledge, drop)
      different digest -> result REJECTED_CONFLICT  (integrity alert)
  else:
      record seq as received
      no consent for this project/surface -> result CONSENT_BLOCKED (content dropped, counted)
      event not valid or kind unknown     -> result DEAD_LETTER     (kept briefly, never processed)
      seq == cursor + 1                   -> result ACCEPTED
      seq  > cursor + 1                   -> result HELD_OUT_OF_ORDER
  advance cursor while the next seq has been received
  return result, cursor                 # the acknowledgement
```

### 11.4 Binding events to projects

- The adapter sends the binding it knows; the **intake resolves the project itself**, with the same resolver as everything else ([Context §4](04-context-and-scope.md#4-resolving-context)), as of the event's time.
- Each event is bound individually. A session that moves from one project's folder to another's produces events for two projects, each under its own learning policy and consent.
- A user turn with no artifact of its own takes the project of the stream at that sequence number. If that is not exactly one project, the event is marked unbound and can only reach the inbox.
- Consent is checked at the intake, per project and per surface. Without it the content is discarded on arrival and only a count is kept.

### 11.5 Health and coverage

Every stream and adapter has a visible state, shown per surface in the learning settings and the capture health screen ([Observability §11.3](02-observability.md#113-obs-11--capture-health)).

| Health | Meaning |
|--------|---------|
| `healthy` | Connected; cursor equals the adapter's last sequence number |
| `lagging` | Connected; the adapter has more than it has been able to deliver |
| `gap` | A sequence number is missing below a received one, and the gap timeout (proposed 60 seconds) has passed |
| `stale` | A session is known to be open and no heartbeat has arrived |
| `degraded` | Dead-lettered events exist |
| `disconnected` | The adapter is paired and not reachable |

| Coverage label | Meaning |
|----------------|---------|
| **CAPTURED** | An adapter with a durable outbox, acknowledgements and replay is connected and consented for this project |
| **RELAYED** | Only the assistant's own `propose_correction` is available. Best effort; always asks a person |
| **NOT CAPTURED** | No adapter exists for this app or assistant, or it is not switched on. Corrections made there are not seen |

While a gap is open inside an episode, signals from that episode cannot activate anything automatically (`capture_incomplete`): the missing event might be the one that said "just this once".

### 11.6 Failure, retry, dead-letter, recovery

| What goes wrong | What happens | What the user sees |
|-----------------|--------------|--------------------|
| Connection to the local service is lost | Events accumulate in the adapter's outbox; retries back off; on reconnect, replay from the cursor | "Lagging", then a line such as "2 events arrived late; all recovered" |
| The local service crashes or restarts | Nothing acknowledged is lost (it was stored in a transaction). Unacknowledged events are re-sent. Processing stages are keyed by `capture_id`, so re-processing creates no second signal, candidate or rule | A closed gap in capture health |
| The adapter or the assistant crashes | On restart the adapter resumes its stream from its outbox, or opens a new stream and backfills from the runtime's transcript where one exists | A gap that is closed by replay or backfill, or stays open and visible |
| The same event arrives twice | Dropped as a duplicate; counted | Nothing, beyond the count |
| Events arrive out of order | Held, then processed in order | Nothing, beyond the count |
| The outbox is full or was deleted | The adapter emits a marker naming the range it lost. The gap is permanent and is shown as such | "Events 40 to 52 were lost on *date*. Corrections made then were not seen." |
| An event cannot be parsed, or its kind is unknown | Dead-lettered with a reason; kept briefly (proposed 7 days); never processed into a signal; can be retried after an update | "1 event could not be read" with Retry and Discard |
| A digest conflict | Refused; the stream is flagged; nothing from the conflicting event is used | An integrity warning naming the adapter |
| Consent was withdrawn mid-stream | Later events have their content dropped on arrival | "Learning was turned off at *time*; later messages were not kept" |
| The clock is wrong | Sequence numbers, not timestamps, decide order. Lateness uses the receiver's clock | — |

### 11.7 Kinds of adapter, and their limits

| Adapter | How it captures | Honest limits |
|---------|-----------------|---------------|
| **App-native** | The app's own correction box, rejection reasons and "finding is wrong" are written in the same transaction as the act | None beyond the app itself |
| **Runtime hook** | For assistant runtimes that offer documented hook events (on user message submitted, on file written, on session start and end), a small hook process writes to the outbox and delivers | Exists only for runtimes with such hooks. A user can remove the hook; the surface then shows NOT CAPTURED |
| **Folder watch** | New versions of files in registered folders, found by change notifications and confirmed by periodic rescans | Versions saved over between two observations are never seen. Who edited is unknown unless a session declares it |
| **App connector** (later phase) | An app's own event interface, used with the user's authorization, with the app's event ids as idempotency keys and its cursor for replay | Sees only what that app's permissions give the authorized account. Never a way around them |
| **Assistant relay** | `propose_correction` | Not capture. Depends on the assistant |
| *None available* | — | The product says so, by name, and offers the correction box instead |

### 11.8 What reliable capture does not give

- **Understanding.** A perfectly delivered sentence can still be ambiguous, missed by the detector, or wrongly taken for a correction. That is what the learning queue, the "this was a correction" review and Undo are for ([Learning §10](12-learning.md#10-the-learning-queue-and-reconciliation)).
- **Coverage of unconnected apps.** Conversations in tools without an adapter, phone calls, and comments made in person are not seen.
- **Authority.** A captured event is evidence about what someone said. Whether it can change anything is decided by trust class, tests and the learning policy.
- **Protection against a malicious adapter.** An adapter attests roles; a forged adapter could forge them. Adapters are paired explicitly by the user, identified in every event, and limited by the same add-only rules as everything else ([Security §2](07-security-and-governance.md#2-threat-model), T19).
