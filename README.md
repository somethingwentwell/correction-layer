# Correction Layer

**Turn the corrections you give once into checks that are applied whenever that kind of work is checked or sent through it: proposals, spreadsheets, PDFs, records. No Git, no terminal, no JSON required.**

> **Status: design only (2026-11-20).** This repository is a specification. There is **no working enforcement implementation yet**: no app, no checker, no gateway. Every schema and example file here is a *proposed* contract, not the output of running software. Nothing here has been measured; performance figures are stated goals.

## The idea in one minute

When you correct someone's work ("that price is out of date", "this customer's quotes must be in SGD"), the correction usually lives in a chat message or in someone's memory. It gets forgotten, or it gets pasted into an ever-growing list of instructions that nobody, human or AI, reliably follows.

Correction Layer takes a different route:

```text
  You correct something once
          |
          v
  It becomes a plain-language rule               "Meridian Clinics quotes are in SGD"
          |                                      Either you review it, or, where you
          |                                      have switched learning on for a
          |                                      project, a low-risk rule that passes
          |                                      its tests turns itself on and tells you
          |                                      (scope: this customer; tested on a
          v                                       bad example and a good example)
  The rule is applied whenever relevant work is checked,
  and always before a send that goes through the product
          |
          v
  Problems are shown at the exact place          "Pricing table, row 1: USD 1,180.00;
  with a suggested fix                            price list says SGD 1,650.00"
          |
          v
  Someone fixes it; the work is checked again
          |
          v
  A person approves the send / export / submit   <- separate from the check passing
          |
          v
  Everything above is visible afterwards as a timeline you can read
```

Five things it is careful about:

- **A check finds problems; it does not fix them.** Detecting, suggesting a fix, changing the document, approving, and sending are five separate steps by identifiable actors, and the product shows them separately.
- **A pass is not permission.** "Ready" means the work met specific rules, at a specific time, against specific trusted sources. Whether the consequential step happens is a separate decision by a person (or, for low-risk actions, a standing decision a person has recorded in advance).
- **It only enforces where it actually sits in the path.** If you send a file through a route the product controls (called a *gateway* in these documents), it can block. If you attach the file to an email yourself, it cannot, and the product says so plainly instead of implying otherwise.

- **Noticing corrections is the product's job, not the assistant's memory.** Where you connect a supported app or assistant, what you type, edit or reject is delivered to the product durably, with acknowledgements, replay after a crash, and a visible warning when something is missing. Delivery being reliable does not make understanding perfect: a correction can still be missed or misread, so there is a queue where you can see what was captured, what was understood, and fix either. Apps that are not connected are not seen.
- **Rules can add themselves, inside limits you set once.** You can switch on learning for a project. Then a low-risk rule (an exact check, for that project only, that adds a requirement and passes tests on real work) turns on without a click, with a notice and Undo. Anything broad, consequential, ambiguous, or that would loosen a rule or change who may do what, still waits for a person. Every rule records whether a person approved it individually or it came in under that standing permission.

It generalizes [encode-the-correction](https://github.com/somethingwentwell/encode-the-correction), a developer tool that turns corrections to coding agents into deterministic checks run automatically whenever code changes ("CI"), to everyday non-developer work. It is agent-neutral, meaning it is not tied to any one AI assistant: any assistant, or none at all, can use it.

## The concerns this design answers

| # | Concern | Where it is designed |
|---|---------|----------------------|
| 1 | The rule list keeps growing, but every relevant check must still run | [Architecture §10](docs/03-architecture.md#10-keeping-a-growing-rule-set-enforceable), [Context and scope §5](docs/04-context-and-scope.md#5-which-rules-apply-deterministic-scope-matching) |
| 2 | Corrections differ per project and folder; every session and artifact needs the right context | [Context and scope](docs/04-context-and-scope.md) |
| 3 | Documents, spreadsheets, PDFs and records each need the correct checks | [Formats](docs/05-formats.md) |
| 4 | Ordinary users must get started easily and understand the interface | [Product and UX](docs/01-product-ux.md) |
| 5 | Users must be able to *see* the rules, what changed, what was blocked, when checks ran, and what was fixed | [Observability](docs/02-observability.md) |
| + | Corrections should be captured reliably and turned into rules automatically where that is safe | [Learning](docs/12-learning.md), [Enforcement §11](docs/06-enforcement-and-integration.md#11-capture-adapters) |

## Document map

Read in this order if you are new. The first three are written for non-developers.

| Document | What it covers |
|----------|----------------|
| [docs/01-product-ux.md](docs/01-product-ux.md) | Who it is for, getting started, the main screens (wireframes), turning a correction into a rule, approving an action |
| [docs/02-observability.md](docs/02-observability.md) | Seeing rules, history, run timelines, before/after comparison, effectiveness; the event model behind them |
| [examples/sales-proposal/README.md](examples/sales-proposal/README.md) | Full worked example: outdated price, wrong currency, authoritative price list, tests, failure, repair, recheck, separate send approval |
| [examples/vendor-payments/README.md](examples/vendor-payments/README.md) | Second domain (a payment spreadsheet) showing the same model generalizes |
| [docs/03-architecture.md](docs/03-architecture.md) | Components, local store, rule model, check catalog, evaluation, rule growth |
| [docs/04-context-and-scope.md](docs/04-context-and-scope.md) | Workspaces, projects, folders, moved and copied files, sessions, which rules apply and why |
| [docs/05-formats.md](docs/05-formats.md) | Typed artifacts, provenance back to cells/sections/pages, format adapters, support matrix |
| [docs/06-enforcement-and-integration.md](docs/06-enforcement-and-integration.md) | Advisory versus gateway enforcement, validation receipts, approvals, action adapters, agent handshake, offline behaviour |
| [docs/07-security-and-governance.md](docs/07-security-and-governance.md) | Threat model, roles, exceptions, privacy, isolation, audit integrity, known limitations |
| [docs/08-mvp-and-acceptance.md](docs/08-mvp-and-acceptance.md) | Phased plan, narrow MVP, acceptance tests per concern, performance goals |
| [docs/09-decisions.md](docs/09-decisions.md) | Decision records (ADRs) with the alternatives that were rejected |
| [docs/10-open-questions.md](docs/10-open-questions.md) | Unresolved questions, each with a recommended default |
| [docs/11-critique-of-concept-draft.md](docs/11-critique-of-concept-draft.md) | What changed from the earlier concept draft and the working hypotheses, and why |
| [docs/12-learning.md](docs/12-learning.md) | Reliable capture of corrections, automatic detection, tests, and rules that turn on by themselves inside limits a person sets once |
| [examples/learning/README.md](examples/learning/README.md) | Worked cases: a rule added with no click, a one-off that is not learned, a malicious document ignored, a lost connection recovered, a contradiction that pauses a learned rule |
| [docs/glossary.md](docs/glossary.md) | Screen words and their technical equivalents |
| [schemas/README.md](schemas/README.md) | Proposed JSON Schemas for rules, artifacts, runs, receipts, actions, context, events |

## Where visual observability lives

Observability is a product capability with its own screens and data model, not a log file. These files cover it:

| Need | File |
|------|------|
| Screens: rules overview, rule detail, activity history, run timeline, before/after compare, correction journey, effectiveness, coverage map | [docs/02-observability.md](docs/02-observability.md) |
| Event envelope, event catalogue, entity relationships, causality links | [docs/02-observability.md §3–4](docs/02-observability.md#3-the-data-model-behind-the-screens), [schemas/event.schema.json](schemas/event.schema.json) |
| Per-run record: every in-scope rule with outcome, evidence, location, and why it ran or did not | [schemas/run.schema.json](schemas/run.schema.json) |
| A concrete journey a non-technical reader can follow, with a 37-event timeline | [examples/sales-proposal/README.md](examples/sales-proposal/README.md), [examples/sales-proposal/events.json](examples/sales-proposal/events.json) |
| What was captured, what was understood, what turned on by itself and why; capture health and gaps | [docs/02-observability.md §11](docs/02-observability.md#11-capture-and-learning-views), [docs/12-learning.md §10](docs/12-learning.md#10-the-learning-queue-and-reconciliation) |
| A learned rule followed from the captured sentence to the block it later caused | [examples/learning/README.md](examples/learning/README.md), [examples/learning/events.json](examples/learning/events.json) |
| Redaction, permissions, retention for traces | [docs/02-observability.md §9](docs/02-observability.md#9-redaction-permissions-and-retention) |
| Acceptance tests for reconstructing a correction end to end, and for project isolation | [docs/08-mvp-and-acceptance.md](docs/08-mvp-and-acceptance.md#5-acceptance-tests) |
| What the MVP includes (rule list, event timeline, diff and recheck) versus later analytics | [docs/08-mvp-and-acceptance.md](docs/08-mvp-and-acceptance.md#2-phases) |

## What this is not

- Not a guarantee that work is correct. Rules catch the mistakes someone has already described; new kinds of mistake pass until someone corrects them.
- Not a way to make an AI assistant obey. Instructions to an assistant are advisory. Only actions routed through a registered gateway can be blocked.
- Not a judge of quality. "Is this persuasive?" stays a human or advisory matter and is never shown as a hard guarantee.
- Not a general automation platform, and not a place to embed scripts. Rules are data, chosen from a fixed list of check types that ships with the product.
- Not able to see apps or assistants that are not connected to it, and never a way around an app's own permissions.
- Not a system that learns anything it likes. It can only add checks; it cannot switch one off, grant an exception, or change who may approve or send.

## Checking this repository

The repository contains one small, dependency-free maintenance script. It is not part of the product; it only keeps the design documents honest.

```sh
python3 tools/check_repo.py
```

It verifies that internal links and anchors resolve, that every JSON file and every `json` code block parses, that example files validate against their proposed schemas, that the example event timelines are causally ordered and hash-chained, and that wireframes are aligned. For the learning examples it also recomputes every automatic decision from its recorded inputs, replays the capture stream through the documented intake procedure, and confirms that no rule in any example was activated without either a person's approval or a learning policy a person had set earlier.

## Repository layout

```text
README.md
docs/        design documents (start with 01 and 02)
examples/    worked examples with proposed fixture files
schemas/     proposed JSON Schemas (draft 2020-12 subset)
tools/       check_repo.py - consistency checks for this repository only
```
