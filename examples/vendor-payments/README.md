# Second example: a vendor payment spreadsheet

> **Illustrative and proposed.** No software produced these files. People, companies, amounts and accounts are fictional. This example exists to show that the model generalizes beyond proposals. Spreadsheets as work artifacts are **Phase 2**, not part of the MVP.

A different team, a different format, a different action, the same loop.

| | Sales proposal example | This example |
|---|------------------------|--------------|
| Work | A proposal document | A monthly payment batch |
| Format | Word-processor document | Spreadsheet |
| Trusted source | Price list (45-day window) | Vendor register (7-day window) |
| Consequential action | Send to customer | Export the bank upload file |
| Format-specific risks | Comments, tracked changes | Hidden rows, totals typed over formulas |
| "Couldn't verify" arises from | (variations only) | A stale source; a confirmation not yet given |

## Setting

- Workspace: *Castlebrook Foods — Finance operations*. Display timezone: Europe/London.
- Project: *Accounts payable — payment runs 2026*. Area: `Payment batches/`, whose default work type is *Vendor payment batch*.
- People: **Aisha Rahman** prepares batches. **Tomás Reyes**, finance controller, owns the rules and approves exports. **Lin Wei**, procurement, owns the trusted source *Vendor register*. **Ben Carter** is a second accounts-payable colleague.
- Gated action: *Export bank file*. The gateway's export adapter is the only route that produces the file the bank portal accepts, generated from the checked bytes.

## The correction

After the October run, Aisha records:

> "We paid Brightwell to an old bank account last month. Bank details must match the vendor register, and the register has to have been confirmed recently."

The candidate rule, rendered from its typed form:

> "For every row in the payment table, the bank account must equal the bank account for that vendor in Vendor register, using the latest register, confirmed within the last 7 days."

It is tested on the October batch as paid (caught) and on a corrected copy (passes). Tomás approves it for the `Payment batches/` area as must-fix, locked, with exceptions only by him and for at most 3 days ([rule-bank-details.json](rule-bank-details.json)). Here the proposer and the approver are different people.

Four other rules already apply in this area:

| Rule | Kind |
|------|------|
| The payment sheet has no hidden rows or columns | Exact (spreadsheet-specific) |
| The batch total is a formula over all payment rows | Exact (spreadsheet-specific) |
| Payments of 10,000.00 or more are confirmed by a second person | A person confirms each time |
| No payee appears twice in a batch | Exact |

## The November batch (17 Nov)

| Time | What happened | Verdict | Why |
|------|---------------|---------|-----|
| 10:30 | **Check 1**, asked by Aisha on `Payments-2026-11.xlsx` | **Needs changes** | Row 27 is hidden and contains a payment (Brightwell Supplies, 4,950.00). Cell F41, the total, is a typed number 182,340.00, but the rows sum to 187,290.00. Two more rules could not be decided (see next row) |
| 10:42 | Aisha unhides the row and restores the SUM formula; version 2 is saved. **Check 2** runs automatically ([run-2-could-not-verify.json](run-2-could-not-verify.json)) | **Couldn't verify** | Nothing fails any more, but two rules cannot be decided: the vendor register was last confirmed 12 days ago and the rule needs 7; and two payments of 10,000.00 or more await a second person |
| 11:05 | Lin Wei publishes a new vendor register. **Check 3** runs automatically | **Needs changes** | Now that the register is current, the bank-details rule can be decided, and it fails for one row: Orchard Packaging's account in the batch is not the one in the register (changed on 6 Nov) |
| 11:20 | Aisha corrects the account from the register; version 3. **Check 4** | **Couldn't verify** | Only the second-person confirmation is outstanding |
| 11:34 | Ben Carter reviews the two large payments and confirms, for this exact version | — | The confirmation is recorded as an attestation bound to version 3 |
| 11:34 | **Check 5** | **Ready** | All five rules decided; a receipt is issued |
| 11:50 | Tomás reviews the pre-action screen and approves the export | — | Approval bound to version 3 and the export action |
| 11:50 | The gateway re-verifies the bindings and the export adapter writes the bank file from the checked bytes | Exported | — |

## What this example demonstrates

1. **Unknown is not a pass, and it is not a failure either.** At 10:42 nothing was wrong that the product could see, yet the batch was not Ready. The stale register blocked the export until its owner acted. When she did, a real mismatch surfaced that a stale register would have hidden.
2. **Formula versus displayed value.** The typed-over total looked like any other number on screen. The spreadsheet adapter reports for each cell whether it is a literal or a formula, and the stored result; the rule required a formula whose stored result equals the sum of the rows.
3. **Hidden content is read and flagged.** The hidden row was part of the data the check read; it was also a finding in its own right.
4. **A person-confirms rule blocks until a person confirms**, and the confirmation is tied to one version. Had Aisha edited the file again after 11:34, Ben's confirmation would no longer apply.
5. **Area scope.** These rules apply in `Payment batches/` only. A budgeting spreadsheet elsewhere in the same project is not subject to them, and the "not in scope" inventory would say why.
6. **The same separation of acts.** The engine detected; Aisha changed the file; Ben confirmed; Tomás approved; the adapter exported.

## What stays the same as the proposal example

The rule shape, the run record with a result for every in-scope rule, the receipt bindings, the approval, the event types and the screens are identical. Only the format adapter, the field dictionary for the work type (`payment.rows[].vendor_id`, `.bank_account`, `.amount`, `payment.total`) and the action adapter differ.

## Files in this folder

| File | Proposed schema | What it shows |
|------|-----------------|---------------|
| [rule-bank-details.json](rule-bank-details.json) | `rule` | A source-backed rule scoped to an area, with a 7-day freshness window and "missing vendor is a failure" |
| [run-2-could-not-verify.json](run-2-could-not-verify.json) | `run` | Check 2: three rules pass, two are unknown for different reasons, verdict Couldn't verify, no receipt |
