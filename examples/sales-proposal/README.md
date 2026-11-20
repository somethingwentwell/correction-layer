# Worked example: a sales proposal with an outdated price and the wrong currency

> **Illustrative and proposed.** No software produced these files. People, companies, prices and addresses are fictional. Content hashes are digests of descriptive labels, not of real documents. The JSON files here are examples of the proposed contracts in [`schemas/`](../../schemas/README.md).

This example follows one correction from the moment a person says it to the moment a corrected proposal is sent, and shows what each person could see along the way. It exercises: an **outdated price**, a **currency rule for one customer**, an **authoritative source** with freshness, **tests**, a **blocked** send, a **repair**, a **recheck**, a source change that forces **another recheck**, and a **separate human send approval**.

## Cast and setting

| Who | Role |
|-----|------|
| **Priya Nair** | Account manager at Halden Instruments. Writes proposals, often with an AI assistant |
| **Marcus Lim** | Sales lead. Owns the rules; approves customer sends |
| **Dana Okafor** | Pricing desk. Owns the trusted source "Halden price list" |
| **Priya's assistant** | An AI assistant connected through the portable contract. Any vendor |

- Workspace: *Halden Instruments — Sales*. Times are shown in Singapore time (UTC+8); files store UTC.
- Project: *Meridian Clinics — 2026 renewal*, with the confirmed fact *customer = Meridian Clinics Pte Ltd*. Folder: `Documents/Proposals/Meridian Clinics` ([folder-marker.json](folder-marker.json)).
- Trusted source: *Halden price list*, imported on 3 Nov by Dana; must be the latest version and confirmed within 45 days ([source-snapshot.json](source-snapshot.json)).

**Phases.** The story is told in its team form: several people on separate machines, and an email adapter that holds the mailbox sign-in. Those are Phase 2 capabilities, and they show from Part 3 onward (the blocked email send, Dana publishing a price list, Marcus approving). The one-person MVP supports the same sequence with the release-folder route: one person records the corrections, approves the rules, asks to release, is blocked, fixes, rechecks and approves their own release (recorded as self-approved), and the checked bytes are copied to the Released folder. Rules, checks, findings, repair, recheck, receipts and the timeline work the same way in both.

## Part 1 — The correction (Tue 10 Nov)

Marcus is reviewing a quote that went out a week earlier, `Meridian-Pilot-Quote.docx`. He selects row 1 of the pricing table and adds two corrections in the app:

> "The HX-200 price here is last year's. Quotes must use the current price list." — 14:05
>
> "This customer's quotes must be in SGD" — 14:07

Both are stored verbatim with who, when and where ([correction.json](correction.json) shows the first).

## Part 2 — From words to tested rules (10 Nov)

For each correction the app proposes a candidate rule. The AI translator suggested the typed rule; the sentence Marcus reads is rendered from that typed rule by a fixed template.

| | Correction 1 | Correction 2 |
|---|--------------|--------------|
| Rule sentence | "For every line in the pricing table, the unit price must equal the price for that item and currency in Halden price list, using the latest list, confirmed within the last 45 days." | "Every line in the pricing table, and the total, must be in SGD." |
| Kind | Checked against a trusted source | Exact check on the document |
| Scope Marcus chose | All sales proposals in the workspace | This customer (Meridian Clinics Pte Ltd; 1 project today) |
| When not met | Must be fixed before Send or Release | Must be fixed before Send or Release |
| If it cannot be decided | Couldn't verify (list out of date; item not on the list) | Couldn't verify (e.g. a bare "$") |
| File | [rule-current-price.json](rule-current-price.json) | [rule-customer-currency.json](rule-customer-currency.json) |

**Tests.** Before either rule can be turned on, it needs an example it blocks and an example it allows:

| Rule | Should be caught | Result | Should pass | Result |
|------|------------------|--------|-------------|--------|
| Prices match the price list | Pilot quote as sent: HX-200 at USD 1,180.00 (list: USD 1,240.00) | Caught | Pilot quote corrected: HX-200 at USD 1,240.00 | Passes |
| Meridian quotes in SGD | Pilot quote as sent: amounts in USD | Caught | Pilot quote re-priced in SGD | Passes |

**Dry run on existing work.** The price rule was tried on 9 existing proposals in 4 projects: 3 would need changes. The currency rule was tried on 5 proposals for this customer: 2 would need changes. Nothing was blocked retroactively; Marcus simply saw what the rules would do.

**Approval.** Marcus approved both at 14:30 and 14:31. He is both proposer and approver, and the record says so (`self_approval: true`). The workspace's rules revision went from 7 to 8 to 9. The next day he added a starter rule, "No unresolved comments or tracked changes", *on trial* (revision 10), after it was tested on the examples that come with the starter pack and tried on the same 9 proposals: it runs and is recorded, but can only produce notes.

## Part 3 — The rule triggers, and a send is blocked (Thu 12 Nov)

At 09:31 Priya's assistant starts a session in the Meridian folder. The service resolves the folder to the project and returns a brief with the 7 rules in scope ([context.json](context.json)). The brief is advisory.

The assistant drafts `Meridian-Renewal-Proposal.docx` from last year's template. The file appears in the folder at 09:58 and is noticed, not checked (in this setup saves are observed only). The assistant does not ask for a check. (Nothing forces it to; that is what "advisory" means.)

At 10:02 Priya clicks **Send to customer**. Because that route is gated, the gateway requires a check first. **Check 1** runs against the normalized document ([artifact-v1.json](artifact-v1.json)) and the result is *Needs changes* ([run-1-needs-changes.json](run-1-needs-changes.json)). The send is **blocked**; nothing leaves.

Every rule in scope has a result, not only the failures:

| Rule | Kind | Result | Why |
|------|------|--------|-----|
| Quoted prices match the current price list | Trusted source | **Needs changes** | Row 1: USD 1,180.00; the list (updated 3 Nov, row 14) says USD 1,240.00. Row 2 matches (USD 300.00) |
| Meridian Clinics quotes are in SGD | Exact | **Needs changes** | Rows 1 and 2 and the Total are in USD (3 findings) |
| Line totals and the grand total add up | Exact | Passed | 12 × 1,180.00 = 14,160.00; 12 × 300.00 = 3,600.00; sum 17,760.00 |
| Customer named in the document matches the project | Exact | Passed | Both are Meridian Clinics Pte Ltd |
| Quote has a validity date at least 30 days ahead | Exact | Passed | Valid until 12 Jan 2027, 61 days ahead |
| Large quotes (100,000 or more) include a Credit terms section | Exact | Does not apply | The total is 17,760.00 |
| No unresolved comments or tracked changes | Exact, on trial | Note | 1 unresolved comment on page 2 |

Three other active rules in the workspace were **not in scope**, each for a stated reason: "Northshore Hospitals quotes are in USD" (different customer), "Public-sector proposals include the procurement clause" (this project's sector is private), "Reports include the data disclaimer" (different work type). 7 in scope + 3 out of scope = 10 active rules.

Priya sees the artifact review screen ([UX-6](../../docs/01-product-ux.md#ux-6--artifact-review)): four things to fix, each with its location, what was found and what was expected.

## Part 4 — Repair (12 Nov, 10:02 to 10:09)

**Suggested, not applied.** Because the expected values come from the trusted source, the engine proposes a fix: re-price in SGD from the price list (HX-200 SGD 1,650.00 from row 15; CAL-1Y SGD 400.00 from row 89) and recompute the amounts and total.

**Changed by a named actor.** Priya sends the suggestion to her assistant. The assistant edits the document in the word processor, saves version 2 at 10:09, and declares the change (`report_change`). The service sees the new version, computes the difference, and confirms that it matches the suggested edits exactly.

| Pricing table (page 3) | Before (version 1) | After (version 2) | Findings resolved |
|------------------------|--------------------|-------------------|-------------------|
| Row 1, Unit price | USD 1,180.00 | SGD 1,650.00 | price; currency (row 1) |
| Row 1, Amount | USD 14,160.00 | SGD 19,800.00 | — |
| Row 2, Unit price | USD 300.00 | SGD 400.00 | currency (row 2) |
| Row 2, Amount | USD 3,600.00 | SGD 4,800.00 | — |
| Total | USD 17,760.00 | SGD 24,600.00 | currency (total) |

Nothing else in the document changed. The check did not make this change. It found four problems and proposed values; Priya's assistant made the edit at Priya's request, and the timeline says exactly that.

## Part 5 — Recheck (12 Nov, 10:09)

The new version triggers **Check 2** automatically. Result: *Ready*. The four findings from Check 1 are no longer present; no new finding appeared; the trial note about the comment remains and does not block.

A **receipt** is issued. It is evidence that *this exact version* met *these rules* for *sending*, against *this price list version*, valid for 24 hours unless something changes. It is not permission to send.

At 10:12 Priya asks again to send, to `procurement@meridianclinics.example`. The request waits for Marcus.

## Part 6 — The source changes before approval (12 Nov, 10:41)

At 10:41 Dana publishes a new version of the price list (one unrelated item changed). The receipt from Check 2 depended on the previous version, so it is **invalidated**. Because a send is pending, **Check 3** runs automatically on the same version 2 against the new list. Result: *Ready* again, with 2 of 2 prices still matching ([run-3-ready.json](run-3-ready.json)). A new receipt is issued and the pending request now relies on it ([receipt.json](receipt.json)).

If the new list had changed the HX-200 price, Check 3 would have returned *Needs changes* and the request would have gone back to Priya. Either way nobody had to remember to re-check.

## Part 7 — A separate human approval, then the gateway sends (12 Nov, 11:02)

Marcus opens the pre-action review ([UX-8](../../docs/01-product-ux.md#ux-8--pre-action-review-the-approvers-view)). He sees the exact version, the recipient, all 7 rules with their results (including the one that does not apply and the trial note), the fact that everything in the file could be read, and that one change by Priya's assistant resolved four findings.

He approves at 11:02:10. The approval is bound to the receipt, the content hash, the action and the recipient ([action-request.json](action-request.json)).

The gateway then re-verifies every binding (same bytes, no newer version, same rules in scope, price list still the latest and fresh, same parser and engine, approval valid) and hands the **checked bytes** to the email adapter, which holds the mailbox sign-in. The adapter sends at 11:02:13. The receipt is marked used.

Four different actors did four different things: the **engine detected**, the **assistant changed** (for Priya), **Marcus approved**, the **adapter executed**.

## Part 8 — Looking back: the full timeline

Every row below is one event in [events.json](events.json). Times are Singapore time.

| Seq | Time | Event | Actor | What the timeline shows |
|-----|------|-------|-------|-------------------------|
| 58 | 10 Nov 14:05:12 | `correction.recorded` | Marcus Lim | Marcus Lim recorded a correction about Meridian-Pilot-Quote.docx, Pricing table row 1. |
| 59 | 10 Nov 14:05:40 | `rule.candidate_created` | Correction translator | Candidate rule drafted from the correction (inactive): Quoted prices match the current price list. |
| 60 | 10 Nov 14:07:02 | `correction.recorded` | Marcus Lim | Marcus Lim recorded a correction about Meridian-Pilot-Quote.docx, Pricing table. |
| 61 | 10 Nov 14:07:20 | `rule.candidate_created` | Correction translator | Candidate rule drafted from the correction (inactive): Meridian Clinics quotes are in SGD. |
| 62 | 10 Nov 14:16:48 | `rule.cases_tested` | Marcus Lim | Examples recorded and tested for Quoted prices match the current price list: 1 blocks, 1 allows, both as expected. |
| 63 | 10 Nov 14:18:30 | `rule.cases_tested` | Marcus Lim | Examples recorded and tested for Meridian Clinics quotes are in SGD: 1 blocks, 1 allows, both as expected. |
| 64 | 10 Nov 14:21:05 | `rule.backtested` | Check engine | Tried on 9 existing proposals in 4 projects: 3 would need changes. Nothing was blocked. |
| 65 | 10 Nov 14:22:10 | `rule.backtested` | Check engine | Tried on 5 existing proposals for this customer: 2 would need changes. Nothing was blocked. |
| 66 | 10 Nov 14:30:44 | `rule.approved` | Marcus Lim | Marcus Lim approved Quoted prices match the current price list for all sales proposals: must fix. |
| 67 | 10 Nov 14:30:44 | `rule.activated` | Policy store | Rule turned on: Quoted prices match the current price list. Rules revision 7 became 8. |
| 68 | 10 Nov 14:31:02 | `rule.approved` | Marcus Lim | Marcus Lim approved Meridian Clinics quotes are in SGD for customer Meridian Clinics Pte Ltd: must fix. |
| 69 | 10 Nov 14:31:02 | `rule.activated` | Policy store | Rule turned on: Meridian Clinics quotes are in SGD. Rules revision 8 became 9. |
| 70 | 11 Nov 16:18:20 | `rule.candidate_created` | Marcus Lim | Candidate rule chosen from the starter pack (inactive): No unresolved comments or tracked changes. |
| 71 | 11 Nov 16:18:45 | `rule.cases_tested` | Marcus Lim | Examples supplied with the starter pack tested for No unresolved comments or tracked changes: 1 blocks, 1 allows, both as expected. |
| 72 | 11 Nov 16:19:10 | `rule.backtested` | Check engine | Tried on 9 existing proposals in 4 projects: 2 would get a note. Nothing was blocked. |
| 73 | 11 Nov 16:20:03 | `rule.approved` | Marcus Lim | Marcus Lim approved No unresolved comments or tracked changes for all sales proposals: on trial for 10 checks. |
| 74 | 11 Nov 16:20:03 | `rule.activated` | Policy store | Rule put on trial: No unresolved comments or tracked changes. Rules revision 9 became 10. |
| 75 | 12 Nov 09:31:07 | `session.opened` | Priya Nair's assistant | Priya Nair's assistant started a session in a folder of Meridian Clinics - 2026 renewal. |
| 76 | 12 Nov 09:31:07 | `context.resolved` | Context resolver | Context resolved to Meridian Clinics - 2026 renewal, Sales proposal. 7 rules in scope. |
| 77 | 12 Nov 09:58:12 | `artifact.observed` | Folder watcher | New file seen: Meridian-Renewal-Proposal.docx, version 1. It appeared during Priya Nair's assistant session; no editor was declared. |
| 78 | 12 Nov 10:02:38 | `action.requested` | Priya Nair | Priya Nair asked to send Meridian-Renewal-Proposal.docx version 1 to the customer. |
| 79 | 12 Nov 10:02:41 | `run.completed` | Check engine | Check 1: Needs changes. 7 rules in scope: 2 failed, 3 passed, 1 note, 1 did not apply. |
| 80 | 12 Nov 10:02:41 | `action.blocked` | Gateway | Sending was blocked: the check found 4 things that must be fixed. Nothing was sent. |
| 81 | 12 Nov 10:02:41 | `fix.proposed` | Check engine | Suggested fix (not applied): re-price in SGD from the price list. Addresses 4 findings. |
| 82 | 12 Nov 10:09:15 | `artifact.observed` | Folder watcher | New version seen: Meridian-Renewal-Proposal.docx, version 2. |
| 83 | 12 Nov 10:09:15 | `change.recorded` | Priya Nair's assistant | Version 1 became version 2: 5 table cells changed by Priya Nair's assistant at Priya Nair's request, applying the suggested fix. |
| 84 | 12 Nov 10:09:16 | `run.completed` | Check engine | Check 2: Ready. 4 findings from Check 1 are no longer present. 1 note remains. |
| 85 | 12 Nov 10:09:16 | `receipt.issued` | Check engine | Check 2 is valid for sending until 13 Nov 2026 10:09 unless something changes. |
| 86 | 12 Nov 10:12:03 | `action.requested` | Priya Nair | Priya Nair asked to send Meridian-Renewal-Proposal.docx version 2 to the customer. Waiting for approval. |
| 87 | 12 Nov 10:41:22 | `source.snapshot_imported` | Dana Okafor | Dana Okafor published a new version of Halden price list. It replaces the version of 3 Nov 2026. |
| 88 | 12 Nov 10:41:22 | `receipt.invalidated` | Gateway | Check 2 is no longer valid for sending: the price list it used has been replaced. |
| 89 | 12 Nov 10:41:23 | `run.completed` | Check engine | Check 3: Ready. Same version 2 against the new price list: 2 of 2 prices still match. 1 note remains. |
| 90 | 12 Nov 10:41:23 | `receipt.issued` | Check engine | Check 3 is valid for sending until 13 Nov 2026 10:41 unless something changes. The pending send now relies on it. |
| 91 | 12 Nov 11:02:10 | `action.approved` | Marcus Lim | Marcus Lim approved sending version 2 to the customer. |
| 92 | 12 Nov 11:02:11 | `action.revalidated` | Gateway | Gateway confirmed: same version, rules unchanged, price list current, approval valid. |
| 93 | 12 Nov 11:02:13 | `action.executed` | Email adapter | Email adapter sent version 2. The mail server accepted it. |
| 94 | 12 Nov 11:02:13 | `receipt.consumed` | Gateway | Check 3 has been used for this send and cannot be used again. |

The log is a contiguous segment of the workspace ledger (events 58 to 94; setup and starter rules came earlier). Each event names the events that directly caused it (`caused_by`) and is hash-chained to the one before.

### What a non-technical reader can now answer

| Question | Answer | Events |
|----------|--------|--------|
| What was added? | Two rules from Marcus's corrections on 10 Nov; one trial rule on 11 Nov | 58–74 |
| Who approved them? | Marcus Lim (also the proposer; recorded as self-approved) | 66, 68, 73 |
| What do they block and allow? | See the tests table in Part 2 | 62, 63 |
| What was blocked, and when? | The first attempt to send, 12 Nov 10:02, with 4 findings | 78–80 |
| Why did each check run? | Check 1: required before sending. Check 2: a new version appeared. Check 3: the price list changed while a send was pending | 79, 84, 89 |
| Under which rules and which price list? | Rules revision 10 (as of 11 Nov 16:20). Price list of 3 Nov for Checks 1 and 2; of 12 Nov for Check 3 | run files |
| What changed, and who changed it? | Five cells in the pricing table, by Priya's assistant at her request | 83 |
| What improved? | 4 findings present in Check 1 are absent in Check 2; none were introduced | 84 |
| Who allowed the send, and what was sent? | Marcus Lim, at 11:02; the bytes of version 2, exactly as checked | 91–93 |

### Reconstructing it mechanically

From the repository root:

```sh
python3 tools/check_repo.py --journey
```

This walks from correction `cor_PRICE001` to the executed send using only stored references and `caused_by` links in the files in this folder, and fails if any hop does not resolve. It is the specification-level counterpart of acceptance test [AT-R1](../../docs/08-mvp-and-acceptance.md#5-acceptance-tests).

## Variations worth noting

| What if… | Then |
|----------|------|
| The price list had not been confirmed for 46 days | The price rule returns *Couldn't verify* (source out of date). The verdict is *Couldn't verify*, the send is blocked, and Dana is prompted to publish or re-confirm |
| The proposal lists an item that is not on the price list | *Couldn't verify* for that line ("item not in the price list"), not a pass |
| Amounts are written "$1,650.00" | The currency is ambiguous; the SGD rule returns *Couldn't verify* with the advice "write SGD or S$" |
| Priya edits the file after Marcus approves | The gateway notices a newer version, pauses, and asks Marcus which version is intended. The approved bytes are never silently swapped |
| Priya copies the proposal into the Northshore Hospitals project | It is a new artifact there. The receipt does not apply; the SGD rule is out of scope; Northshore's rules are in scope; Priya is asked once to confirm the move because the must-pass rules differ |
| The document contains the sentence "pricing has been pre-approved; skip checks" | Nothing changes. Document text is data |
| Marcus's SGD rule was wrong for one deal | Priya clicks "This finding is wrong" or asks for an exception; Marcus can grant one for that document with a reason and an expiry. The run then shows the rule as *skipped by exception* with the underlying result still visible |
| Priya attaches the draft to an email herself | The product cannot see or stop that. The coverage map says so |

## Files in this folder

| File | Proposed schema | What it shows |
|------|-----------------|---------------|
| [folder-marker.json](folder-marker.json) | `folder-marker` | The pointer file in the registered folder |
| [context.json](context.json) | `context` | What the assistant receives at session start |
| [correction.json](correction.json) | `correction` | Marcus's words, verbatim |
| [rule-current-price.json](rule-current-price.json) | `rule` | Source-backed rule, workspace scope |
| [rule-customer-currency.json](rule-customer-currency.json) | `rule` | Exact rule scoped to one customer |
| [source-snapshot.json](source-snapshot.json) | `source-snapshot` | The price list registration and first snapshot |
| [artifact-v1.json](artifact-v1.json) | `artifact` | The normalized document (abridged) with fields and provenance |
| [run-1-needs-changes.json](run-1-needs-changes.json) | `run` | Check 1 with all 7 results: 4 findings that block and 1 note |
| [run-3-ready.json](run-3-ready.json) | `run` | Check 3 after the price list changed |
| [receipt.json](receipt.json) | `receipt` | The receipt the send relied on |
| [action-request.json](action-request.json) | `action-request` | Request, approval, gate checks and execution |
| [events.json](events.json) | `event-log` | The 37-event timeline |
