# 01 · Product and UX

> Proposed design. Nothing in this document is implemented. Wireframes are illustrations of intent, not screenshots.

This document describes what an ordinary user sees and does. The screens that let a user *look back* at rules, history and runs are in [02 · Observability](02-observability.md); the two documents are meant to be read together.

## 1. Who it is for

| Person | What they do | What they need from the product |
|--------|--------------|---------------------------------|
| **The maker** (e.g. Priya, account manager) | Produces proposals, reports, spreadsheets, often with an AI assistant | To know before sending whether the work is ready, exactly what to change, and why |
| **The standard-setter** (e.g. Marcus, sales lead) | Gives corrections, owns rules, approves consequential actions | To say a correction once in plain words, confirm what it will and will not catch, and see that it is being applied |
| **The source owner** (e.g. Dana, pricing desk) | Maintains a trusted list such as a price list or vendor register | To publish a new version and see what it affects |
| **The reviewer / auditor** | Looks back at what happened | To reconstruct one piece of work end to end without reading logs |
| **An AI assistant** (any vendor) | Drafts and edits on a person's behalf | The right context for the folder it is in, a way to ask "is this ready?", and a way to pass a person's correction on for review |

In a one-person setup the same human plays the first three roles. The product still keeps the *steps* separate (approving a rule is not approving a send), and records which hat was worn.

## 2. Design principles

1. **Plain words first.** The primary representation of a rule is a sentence, an example it blocks, and an example it allows. Identifiers, hashes and JSON exist but sit behind a "Details" disclosure.
2. **Three verdicts, never a score.** Work is *Ready*, *Needs changes*, or *Couldn't verify*. There is no percentage and no traffic-light average, because one failed mandatory rule is not offset by nine passes.
3. **"Couldn't verify" is a first-class answer.** When a trusted source is stale, a scanned page is unreadable, or a document part is unsupported, the product says so and treats it as not-ready for consequential actions. It never rounds unknown up to a pass.
4. **Show the place.** Every finding points to a location a person can find: "Pricing table, row 1, Unit price (page 3)".
5. **Say who did what.** The product checks. A person or their assistant changes the document. A person approves. A gateway sends. The interface never says "Correction Layer fixed your document".
6. **Honest about reach.** Each project shows which actions are actually gated and which are only checked on request (the [coverage map](02-observability.md#58-obs-8--coverage-map)).
7. **Ask only when it matters.** Setup is not repeated for a new session or a moved file. A question appears only when the answer would change which mandatory rules apply or whether a consequential action may proceed.
8. **The user confirms meaning; the machine never guesses silently.** Project identity, work type, what a table column means, and what a correction covers are suggested, then confirmed by a person. The one exception is chosen by the user in advance: with learning switched on for a project, a low-risk rule that passes its tests turns on by itself, always with a notice that says what was learned, why, and how to undo it ([Learning](12-learning.md)).

## 3. The words on the screen

The interface uses a small vocabulary. The [glossary](glossary.md) maps each word to its technical term.

| Word | Meaning for the user |
|------|----------------------|
| **Project** | A piece of ongoing work with its own folders, trusted sources and rules (e.g. "Meridian Clinics — 2026 renewal") |
| **Work type** | The kind of thing being produced (e.g. "Sales proposal") |
| **Correction** | What a person said was wrong, in their own words |
| **Rule** | The tested, plain-language requirement that came from a correction. Either a person approved it, or it was let in under a learning setting a person chose for the project; the screen always says which |
| **Trusted source** | A list a named person vouches for (price list, vendor register), with a date |
| **Check** | One run of the relevant rules against one version of a piece of work |
| **Ready / Needs changes / Couldn't verify** | The three verdicts |
| **Note** | A rule result that is shown but does not hold anything up |
| **Exception** | A recorded, time-limited permission to skip one rule, with a reason |
| **Approve** | A person's decision that a consequential action may happen |

## 4. Where the product shows up

| Surface | For | Notes |
|---------|-----|-------|
| **The app** (runs locally, opens like any desktop application) | Everyone | Home, project pages, rules, activity, reviews. All screens in this document |
| **Check from anywhere** | Makers | Drop a file on the app; later, a right-click "Check with Correction Layer" and optional auto-check on save for registered folders |
| **Inside an AI assistant** | Makers using agents | The assistant shows the verdict and findings inline and links to the app. A correction said in chat is captured (reliably where an event adapter is connected, best-effort where the assistant merely passes it on) and becomes a *candidate*. It is reviewed in the app, or, where learning is on for the project and the candidate is low-risk and tested, turned on automatically with a notice. The assistant itself can never activate anything |
| **Command line and API** | Developers and integrators only | Same local service; never required for ordinary use |

Individual rule approval, the learning setting for a project, and action approval always happen in the app (or a later trusted approval surface), not inside the assistant's conversation. An assistant can be confused or manipulated by the text it reads; these surfaces are kept outside its reach. Where a rule turns on automatically, it does so by the service's own decision procedure under a learning setting a person saved in the app; nothing the assistant says or calls can activate a rule. See [Enforcement §4](06-enforcement-and-integration.md#4-approval-is-separate-from-validation) and [Learning §7](12-learning.md#7-the-decision).

## 5. Getting started

Goal: from first launch to a first meaningful verdict in four steps, without the user creating anything by hand. The time this takes is a design goal to be tested with users, not a measured figure.

### UX-1 · Add a folder

```text
+----------------------------------------------------------------------------+
| Correction Layer                                                    [Help] |
|                                                                            |
|   Welcome. Let's check your first piece of work.                           |
|                                                                            |
|   Step 1 of 4 - Where is the work?                                         |
|                                                                            |
|   +----------------------------------+  +-------------------------------+  |
|   | [ Add a folder from this         |  |  Connect a shared workspace   |  |
|   |   computer ]                     |  |  (cloud drives - later phase) |  |
|   +----------------------------------+  +-------------------------------+  |
|                                                                            |
|   We read file names and contents on this computer to suggest a setup.     |
|   Nothing is uploaded. You confirm everything before it is used.           |
|                                                                            |
|   [ Try it with a sample proposal instead ]                                |
+----------------------------------------------------------------------------+
```

### UX-2 · Confirm the suggested project and work type

The app inspects the folder locally (file types by content, not just extension; folder and file names; headings) and proposes a project and work type. The suggestion is a starting point; nothing is registered until the user confirms.

```text
+----------------------------------------------------------------------------+
| Step 2 of 4 - Is this right?                                               |
|                                                                            |
|   Folder    Documents/Proposals/Meridian Clinics                           |
|             8 Word documents, 3 spreadsheets, 2 PDFs                       |
|                                                                            |
|   Project   [ Meridian Clinics - 2026 renewal            ]  (you can edit) |
|   Customer  [ Meridian Clinics Pte Ltd                   ]  (optional)     |
|                                                                            |
|   What kind of work is mostly in here?                                     |
|     (o) Sales proposals         why: 5 files contain a pricing table       |
|     ( ) Reports                                                            |
|     ( ) Something else ...                                                 |
|                                                                            |
|   [i] Sub-folders "Archive 2025" and "Contracts" look different.           |
|       [ Treat as part of this project ]  [ Set up separately later ]       |
|                                                                            |
|                                             [ Back ]  [ Looks right -> ]   |
+----------------------------------------------------------------------------+
```

Design notes:

- The "why" line makes the suggestion inspectable. If the user picks "Something else", they still get generic document checks; work types add field understanding, they are not a prerequisite.
- "Customer" is a *project fact*. Facts confirmed here can be used later to scope rules ("this customer") and to catch misfiled work ("the customer named in this document is not this project's customer").
- Nested folders are surfaced only when they look materially different; otherwise they are simply part of the project. Details in [Context and scope §3](04-context-and-scope.md#3-registering-folders).

### UX-3 · Optional starter rules and trusted sources

```text
+----------------------------------------------------------------------------+
| Step 3 of 4 - Start with a few common rules? (optional)                    |
|                                                                            |
|   For sales proposals, people often want:                                  |
|                                                                            |
|   [x] Line totals and the grand total add up                               |
|   [x] The customer named in the document matches this project              |
|   [x] The quote has a validity date at least [30] days ahead               |
|   [ ] No unresolved comments or tracked changes                            |
|   [ ] Required sections are present: [ choose sections ... ]               |
|                                                                            |
|   Each can be changed or turned off later. They start as real rules        |
|   with you as owner; nothing is hidden.                                    |
|                                                                            |
|   Do you have a list that work should match? (optional)                    |
|     [ Add a price list ... ]   Excel or CSV. You name who vouches for it   |
|                                and how long it stays valid.                |
|                                                                            |
|                                   [ Skip for now ]  [ Continue -> ]        |
+----------------------------------------------------------------------------+
```

Starter rules are ordinary rules from the same catalogue as any other (see [Architecture §5](03-architecture.md#5-the-check-catalogue)); they carry an origin of "starter pack" instead of a human correction, and they appear in the rules list like everything else.

### UX-4 · Check the first artifact

For a work type that reads values out of a document, the first check includes one "teach by pointing" confirmation so that later checks know where the fields are.

```text
+----------------------------------------------------------------------------+
| Step 4 of 4 - Check your first document                                    |
|                                                                            |
|   Meridian-Pilot-Quote.docx                                                |
|                                                                            |
|   We found a table on page 3 that looks like pricing. Is this right?       |
|                                                                            |
|   +------------------+-----+--------------+----------------+               |
|   | Item             | Qty | Unit price   | Amount         |               |
|   +------------------+-----+--------------+----------------+               |
|   | HX-200 Flow ...  | 12  | USD 1,180.00 | USD 14,160.00  |               |
|   | CAL-1Y Calib...  | 12  | USD   300.00 | USD  3,600.00  |               |
|   +------------------+-----+--------------+----------------+               |
|      ^ item             ^ quantity   ^ unit price    ^ line total          |
|                                                                            |
|   [ Yes, that's the pricing table ]  [ Pick a different table ]            |
|   [ This document has no pricing ]                                         |
|                                                                            |
|   You'll be asked again only if a document doesn't fit this pattern.       |
+----------------------------------------------------------------------------+
```

The app proposes; the user confirms, or points at the right table and relabels its columns. After confirmation the app shows the first artifact review (UX-6). The confirmed pattern is saved as a *field mapping* for the project's work type (see [Formats §5](05-formats.md#5-semantic-fields-and-how-they-are-extracted)). If a later document does not match the mapping, the affected rules report *Couldn't verify* and offer this same confirmation; they do not guess.

## 6. Project home

### UX-5 · Project home

```text
+-----------------------------------------------------------------------------+
| < All projects        Meridian Clinics - 2026 renewal            [Settings] |
| Sales proposals - Customer: Meridian Clinics Pte Ltd                        |
+-----------------------------------------------------------------------------+
| RECENT WORK                                                 [ Check a file ]|
|  [X] Meridian-Renewal-Proposal.docx   Needs changes - 4 to fix   10:02      |
|  [~] Meridian-Pilot-Quote.docx        Checked 3 Nov - rules changed since   |
|  [?] Site-Survey-Scan.pdf             Couldn't verify - scanned   2 Nov     |
|                                                                             |
| RULES THAT APPLY HERE                                    [ See all rules ]  |
|  7 rules apply to sales proposals in this project                           |
|   6 for all sales proposals (Halden Instruments - Sales)                    |
|   1 for this customer (Meridian Clinics Pte Ltd)                            |
|   6 must pass before sending - 1 on trial (note only)                       |
|  [ + Add a correction ]                                                     |
|                                                                             |
| TRUSTED SOURCES                                                             |
|  Halden price list   vouched by Dana Okafor   updated 3 Nov  [OK] current   |
|                                                                             |
| FOLDERS                                                                     |
|  Documents/Proposals/Meridian Clinics            [OK] connected             |
|    Archive 2025/                                 part of this project       |
|                                                                             |
| WHAT IS ENFORCED HERE                               [ See coverage map ]    |
|  Send to customer (email)   Gated - cannot send without Ready + approval    |
|  Anything you do outside this app   Not covered - checks on request only    |
|                                                                             |
| LEARNING                                           [ Learning settings ]    |
|  Off for this project. Corrections are added by hand.                       |
|                                                                             |
| RECENT ACTIVITY                                        [ See full history ] |
|  12 Nov 10:02  Check blocked sending: 4 problems in Renewal Proposal        |
|  11 Nov 16:20  Marcus added rule on trial: No unresolved comments           |
|  10 Nov 14:31  Marcus turned on: Meridian Clinics quotes are in SGD         |
+-----------------------------------------------------------------------------+
```

The home page answers, without a click: what state is my work in, which rules apply here and where they come from, are my trusted sources current, what does this product actually control, and what changed recently.

The wireframe shows a team setup with the email adapter, which is a later phase. In the MVP the gated route listed under "What is enforced here" is *Release to the Released folder* ([phases](08-mvp-and-acceptance.md#2-phases)).

## 7. Checking a piece of work

### UX-6 · Artifact review

```text
+----------------------------------------------------------------------------+
| Meridian-Renewal-Proposal.docx                         checked 12 Nov 10:02|
| Project: Meridian Clinics - 2026 renewal - Sales proposal                  |
| For: Send to customer                                                      |
+----------------------------------------------------------------------------+
|  [X] NEEDS CHANGES   2 rules need changes (4 places to fix)                |
|      Also: 3 rules passed - 1 note - 1 rule does not apply [ Show all 7 ]  |
+----------------------------------------------------------------------------+
| TO FIX                                                                     |
|                                                                            |
| 1. Price is not the current list price                                     |
|    Where     Pricing table, row 1, Unit price (page 3)        [ Show me ]  |
|    Found     USD 1,180.00 for HX-200                                       |
|    Expected  USD 1,240.00  (Halden price list, updated 3 Nov, row 14)      |
|    Rule      Quoted prices match the current price list     [ Why? ]       |
|                                                                            |
| 2-4. Currency is not SGD (3 places)                                        |
|    Where     Pricing table rows 1-2 and Total (page 3)        [ Show me ]  |
|    Found     USD                                                           |
|    Expected  SGD                                                           |
|    Rule      Meridian Clinics quotes are in SGD             [ Why? ]       |
|                                                                            |
| SUGGESTED FIX (not applied)                                                |
|    Re-price in SGD from the price list: HX-200 SGD 1,650.00,               |
|    CAL-1Y SGD 400.00, total SGD 24,600.00.                                 |
|    [ Copy fix instructions ]  [ Send to my assistant ]                     |
|    You or your assistant make the change in the document. We then check    |
|    the new version.                                                        |
|                                                                            |
| NOTES (do not block)                                                       |
|    1 unresolved comment on page 2. Rule on trial: No unresolved comments   |
|                                                                            |
| [ Check again ]   [ This finding is wrong ]   [ Ask for an exception ]     |
+----------------------------------------------------------------------------+
```

How the verdict is chosen (precedence top to bottom):

| Verdict | Shown when | Effect on a gated action |
|---------|-----------|--------------------------|
| **Needs changes** | At least one must-pass rule failed | Blocked |
| **Couldn't verify** | No must-pass rule failed, but at least one could not be decided: stale or missing source, unreadable or unsupported content, a rule conflict, an error, or a confirmation a person has not yet given | Blocked until resolved, confirmed by a person where the rule allows it, or covered by an approved exception |
| **Ready** | Every must-pass rule passed (notes may remain) | May proceed to approval |

Design notes:

- **"Show all 7"** opens the full list of rules that were in scope, including the ones that passed and the one that did not apply, each with a reason. A user can always see the complete inventory, not just the failures ([Observability §6](02-observability.md#6-why-did-this-check-run-or-not-run)).
- **"Why?"** opens the rule detail: the original correction, who approved it, and its examples.
- **"This finding is wrong"** records feedback against the rule and notifies its owner. It does not unblock anything by itself; it feeds the false-positive indicators in the [effectiveness view](02-observability.md#57-obs-7--effectiveness).
- **Suggested fixes are suggestions.** When the expected value comes from a trusted source, the suggestion is derived deterministically from that source. Where a fix needs judgment, the product says what is wrong and leaves the remedy to the person. The MVP never edits the user's file; see [Architecture §9](03-architecture.md#9-findings-fix-proposals-and-changes).
- **"Couldn't verify" items** are phrased as what the person can do: "Update the price list (last confirmed 52 days ago)", "Confirm you have reviewed the embedded spreadsheet on page 6", "Tell us which table is the pricing table".

## 8. Turning a correction into a rule

The same three-step flow is used whether the correction is typed in the app, said to an assistant, or started from a finding ("this should have been caught").

### UX-7a · Say it

```text
+----------------------------------------------------------------------------+
| Add a correction                                               Step 1 of 3 |
|                                                                            |
|  What was wrong, in your own words?                                        |
|  +----------------------------------------------------------------------+  |
|  | This customer's quotes must be in SGD                                |  |
|  +----------------------------------------------------------------------+  |
|                                                                            |
|  About:  Meridian-Pilot-Quote.docx - Pricing table (page 3)   [ change ]   |
|                                                                            |
|  [ Continue -> ]            or  [ Pick from common rule types instead ]    |
+----------------------------------------------------------------------------+
```

### UX-7b · Confirm what it means and where it applies

```text
+----------------------------------------------------------------------------+
| Add a correction                                               Step 2 of 3 |
|                                                                            |
|  You said:  "This customer's quotes must be in SGD"                        |
|                                                                            |
|  THE RULE WOULD BE                                                         |
|    Every line in the pricing table, and the total, must be in              |
|    [ SGD v ].                                                              |
|    Kind: exact check on the document (no judgment involved)                |
|                                                                            |
|  WHERE SHOULD IT APPLY?                                                    |
|    ( ) Only this document                                                  |
|    (o) This customer - Meridian Clinics Pte Ltd  (1 project today, and     |
|        any future project for this customer)                               |
|    ( ) This project only                                                   |
|    ( ) All sales proposals in Halden Instruments - Sales                   |
|        needs approval from: a workspace steward                            |
|                                                                            |
|  WHEN IT IS NOT MET                                                        |
|    (o) Must be fixed before sending     ( ) Show as a note only            |
|                                                                            |
|  Similar rules already in place: none found.                               |
|                                                                            |
|  Not what you meant?  [ Edit the rule ]  [ Rephrase ]  [ Keep as a note    |
|                                            for people, not a check ]       |
|                                                       [ Back ] [ Next -> ] |
+----------------------------------------------------------------------------+
```

Design notes:

- **The rule sentence is generated from the typed rule, not written by an AI.** The *typed rule* is the structured form the product actually evaluates: a check type from a fixed list plus its settings (here: "value must be one of: SGD", applied to the line currencies and the total). An AI model may propose the typed rule from the user's words, but the sentence under "THE RULE WOULD BE" is rendered by a fixed template from the rule's actual fields. What the person reads is what will run ([ADR-009](09-decisions.md#adr-009--the-sentence-a-person-approves-is-rendered-from-the-typed-rule)).
- **"Kind"** states the assurance honestly. The possible labels are: *exact check on the document*; *checked against a trusted source*; *a person confirms each time*; *AI opinion, shown as a note only*. A subjective correction ("make it more persuasive") is offered only the last two.
- **Scope is a choice the user sees**, with its consequence ("1 project today") and who must approve the wider options. The narrowest sensible scope is preselected.
- **Duplicates and conflicts are checked here**, before the rule exists: "Similar rule exists: *Quotes use the contract currency* (workspace). [Add to it] [Create separately]", or "This conflicts with *All quotes are in USD* (workspace, locked). You can ask its owner for an exception." See [Context and scope §6](04-context-and-scope.md#6-how-rules-combine).
- **Not every correction should become a check.** "Keep as a note for people" stores it as guidance attached to the project. It is shown to people and assistants but never presented as enforced.

### UX-7c · Test it and turn it on

```text
+----------------------------------------------------------------------------+
| Add a correction                                               Step 3 of 3 |
|                                                                            |
|  Rule: Meridian Clinics quotes are in SGD                                  |
|                                                                            |
|  EXAMPLES THIS RULE IS TESTED ON                                           |
|   Should be caught   Meridian-Pilot-Quote.docx (as it is now)   [X] caught |
|                      "USD 1,180.00" - Pricing table, row 1                 |
|   Should pass        [ Add a corrected example ... ]                       |
|                      Pilot-Quote-corrected.docx              [OK] passes   |
|                                                                            |
|  WHAT IT WOULD DO TO EXISTING WORK                                         |
|   Checked 5 proposals for this customer:  2 would need changes             |
|   [ See which ]      Nothing is changed or blocked retroactively.          |
|                                                                            |
|  TURN IT ON                                                                |
|   (o) On now - must be fixed before sending                                |
|   ( ) Try quietly for [10] checks - shows as a note, then asks me          |
|                                                                            |
|  Owner: Marcus Lim        Review again by: [ 10 May 2027 ]                 |
|                                                                            |
|                                         [ Back ]  [ Approve and turn on ]  |
+----------------------------------------------------------------------------+
```

Design notes:

- A rule that blocks cannot be turned on without at least one example it catches and one it passes. The examples are kept and re-run whenever the rule, the parser or the engine changes.
- "What it would do to existing work" is a dry run over existing artifacts in scope. It is the most direct way for a non-technical owner to see whether the rule means what they intended.
- "Try quietly" is the trial state: the rule runs and is recorded on every relevant check but can only produce notes. It is the recommended choice for wide-scope rules.
- If the person adding the correction is not permitted to approve at the chosen scope, the final button reads **Send for approval** and the candidate appears in the approver's queue.

## 9. Before a consequential action

### UX-8 · Pre-action review (the approver's view)

```text
+----------------------------------------------------------------------------+
| Approve sending?                                                           |
+----------------------------------------------------------------------------+
| WHAT     Meridian-Renewal-Proposal.docx  (version saved 12 Nov 10:09)      |
| ACTION   Send to customer by email                                         |
| TO       procurement@meridianclinics.example                               |
| ASKED BY Priya Nair, 12 Nov 10:12                                          |
+----------------------------------------------------------------------------+
| [OK] READY   checked 12 Nov 10:41 against rules as of 11 Nov 16:20         |
|              and Halden price list updated 12 Nov 10:41                    |
|                                                                            |
|  Must-pass rules (6)                                                       |
|   [OK] Quoted prices match the current price list      2 of 2 lines match  |
|   [OK] Meridian Clinics quotes are in SGD              3 of 3 amounts      |
|   [OK] Line totals and the grand total add up                              |
|   [OK] Customer named in the document matches this project                 |
|   [OK] Quote has a validity date at least 30 days ahead   12 Jan 2027      |
|   [--] Large quotes (100,000 or more) include a Credit terms section       |
|        does not apply: the total is 24,600.00                              |
|  Notes (1)                                                                 |
|   [!]  1 unresolved comment on page 2 (rule on trial)                      |
|                                                                            |
|  Everything in the file could be read.                                     |
|  Since the first check: 1 change by Priya's assistant; 4 findings resolved.|
|  [ See what changed ]   [ See full timeline ]                              |
|                                                                            |
|  The check says the document meets these rules. It does not decide         |
|  whether to send. That is your call.                                       |
|                                                                            |
|  [ Open the exact version that will be sent ]                              |
|                                       [ Reject ... ]  [ Approve and send ] |
+----------------------------------------------------------------------------+
```

Design notes:

- The approver sees the **exact checks applied**, including the one that did not apply and why, and the exact **version** that will be sent. The gateway sends the bytes that were checked, not whatever is at the file path at that moment ([Enforcement §5](06-enforcement-and-integration.md#5-what-the-gateway-does-at-execution-time)).
- If anything the verdict depended on has changed since the check (the document, the rules in scope, a trusted source, or time beyond the validity window), this screen shows **"Needs a fresh check"** and re-runs it before approval is possible.
- Approval is recorded as its own event by a named person, and is bound to this version, this action and this recipient. Changing any of them voids it.
- Where only one person exists, they approve their own send; the screen then says "You are approving your own request" and the record shows it.

## 10. When the app asks questions

A new session or a moved file should not trigger setup again. The app asks only when the answer is *material*: when it would change the set of must-pass rules, or when a consequential action is requested.

| Situation | What happens |
|-----------|--------------|
| New assistant session in a registered folder | Nothing is asked. Context is resolved from the folder |
| File moved or renamed inside the same project | Nothing is asked. History follows the file |
| File moved to another project with the *same* must-pass rules | Nothing is asked. A line is added to the file's history |
| File moved or copied to a project with *different* must-pass rules | Asked once (UX-9) the first time it is checked or acted on |
| File outside any registered folder, check only | Asked which project to check it as; the result is labelled "checked as …" |
| File outside any registered folder, consequential action | Blocked until a project is confirmed |
| Document's stated customer differs from the project's customer | Reported as a finding (if the starter rule is on), not as a question |
| Two rules cannot both be satisfied | Shown as *Couldn't verify* with both rules named and their owners notified (UX-10) |

### UX-9 · A file arrived from another project

```text
+----------------------------------------------------------------------------+
| One question before checking                                               |
|                                                                            |
|  "Clinic-Network-Quote.docx" was copied here from the project              |
|  Meridian Clinics - 2026 renewal.                                          |
|                                                                            |
|  It is now in:  Northshore Hospitals - tender                              |
|                                                                            |
|   (o) It is Northshore work now. Check it with Northshore's rules.         |
|       Differences: 1 rule no longer applies (Meridian quotes in SGD),      |
|       2 new rules apply (e.g. Public-sector procurement clause).           |
|   ( ) It is still Meridian work. I'll move it back.                        |
|                                                                            |
|  We ask because the rules that must pass are different.     [ Continue ]   |
+----------------------------------------------------------------------------+
```

### UX-10 · Two rules disagree

```text
+----------------------------------------------------------------------------+
| [?] COULDN'T VERIFY   Two rules cannot both be met                         |
|                                                                            |
|   A. All quotes are in USD              everyone - owner: Marcus Lim       |
|   B. Meridian Clinics quotes are in SGD this customer - owner: Marcus Lim  |
|                                                                            |
|  We don't pick a winner. Until this is resolved, sending is on hold.       |
|                                                                            |
|   [ Ask Marcus for an exception to A for this customer ]                   |
|   [ Change rule B ]                                                        |
|   [ See both rules side by side ]                                          |
+----------------------------------------------------------------------------+
```

The wireframe is hypothetical: no "All quotes are in USD" rule exists in the worked example. Most conflicts are caught earlier, at the moment a rule is proposed (UX-7b). This screen exists for conflicts that arise later, for example when an imported rule pack meets a local rule.

## 11. Working with an AI assistant

What the user experiences when their assistant is connected (details in [Enforcement §2](06-enforcement-and-integration.md#2-the-portable-contract)):

- **At the start of a session** the assistant receives a short brief for the folder it is in: the project, the work type, the must-pass rules in plain language, and how current the trusted sources are. The user does not paste rules into prompts.
- **When the assistant finishes a draft** it can ask for a check and show the result inline, using the wording the service supplies, for example: *"Advisory check: Needs changes. 4 things to fix before this can be sent. 1 note."* with a link to the review. "Advisory" is always part of the line, so nobody mistakes a check in chat for a gate
- **When the user corrects the assistant in chat**, what happens depends on the project's learning setting. With learning off, the assistant can pass the correction on and the user sees: *"I've put that forward as a possible rule. Review it in Correction Layer."* With learning on and an event adapter connected, the user's own message is captured directly, and a clear, low-risk correction produces a notice instead: *"Learned for this project: every line and the total must be in SGD. Undo."* Anything unclear or consequential lands in the learning queue for a person.
- **When the assistant is asked to send or export** through a gated route, the request appears in the app for approval. The assistant cannot approve it.
- **If the assistant ignores all of this**, nothing breaks silently in the product's records: the work simply shows as *not checked*, and gated actions still cannot happen without a check and whatever approval the project requires. Ungated routes remain ungated, and the coverage map says so.

The brief is advisory help for the assistant. It may be shortened when there are many rules; enforcement never depends on it, because checks evaluate every rule in scope regardless of what the assistant was told ([Context and scope §9](04-context-and-scope.md#9-the-brief-is-advisory-the-check-is-complete)).

## 12. States, errors and accessibility

- **Empty states teach.** A project with no rules shows the "Add a correction" flow and the starter pack, not an empty table.
- **Errors are specific and recoverable.** "This file is password-protected, so it could not be read. Remove the password or ask its owner for an unlocked copy." Errors on must-pass rules count as *Couldn't verify*, never as passes.
- **Never colour alone.** Each verdict has a word, a symbol and a colour. Wireframes here use `[OK]` (ready or passed), `[X]` (needs changes or failed), `[?]` (couldn't verify), `[!]` (note), `[--]` (does not apply) and `[~]` (checked earlier; something has changed since) to stand for those symbols.
- **Old verdicts are never shown as current.** A verdict is displayed with the time of the check. If the rules in scope, a trusted source or the file have changed since, the list shows "rules changed since" (or source, or file) and offers a fresh check instead of the old verdict.
- **Keyboard and screen-reader operable.** Findings are a list with headings; "Show me" moves focus to a text description of the location as well as a visual highlight.
- **Local conventions.** Dates, numbers and currency are displayed in the user's locale; times in the workspace's display timezone with the zone shown on detail views. Stored values are unambiguous ([Observability §4](02-observability.md#4-the-event-model)).
- **Plain reading level.** Rule sentences come from templates written for general readers and are localizable.

## 13. What ordinary users never need to touch

| Never required | Where it lives instead |
|----------------|------------------------|
| JSON, schemas | Rendered sentences, examples and forms; raw data behind "Details" for support and audit |
| Git, version control | Built-in revision history for every rule and a timeline for every artifact |
| Terminal, scripts | The app; the command line is for integrators |
| Prompt engineering | The session brief is generated from approved rules |
| Knowing file internals | "Show me" locations and "Couldn't verify" explanations in plain language |

## 14. Learning without a click per rule

Adding a correction through UX-7 always works. For people who would rather not do that each time, a project can have learning switched on, once, by someone entitled to approve its rules. The screens are specified in [Learning](12-learning.md):

| Screen | What the user does | Where |
|--------|--------------------|-------|
| UX-11 Learning for this project | Chooses one of four modes (Off, Suggest, Learn quietly, Learn and enforce), whose corrections count, and which connected surfaces are noticed. Sees in plain words what "safe" means and what is never automatic | [Learning §8](12-learning.md#8-learning-modes-what-a-person-sets-once) |
| UX-12 Learning notice | Nothing, unless they disagree: "Learned for *project*: *rule*. Because you said: *their words*. Undo" | [Learning §9](12-learning.md#9-after-a-rule-is-learned) |
| UX-13 Learning queue | Answers only what could not be settled automatically; can see what was captured, what was understood, what turned on by itself, and what was not learned and why | [Learning §10](12-learning.md#10-the-learning-queue-and-reconciliation) |

What stays the same: the rule sentence is rendered from the typed rule; scope defaults to the narrowest; checking, repairing, approving an action and executing it remain separate acts by separate actors. Learning adds rules. It never fixes, sends or approves anything.
