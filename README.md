# Correction Layer

**Turn the corrections you give once into checks that are applied whenever that kind of work is checked or sent through it: proposals, spreadsheets, PDFs, records. No Git, no terminal, no JSON required.**

> **Status: design, plus a local MVP implementation (Phase 1 framework + Phase 2 functions, 2026-11-21).** The documents, schemas and examples in this repository are a specification: every schema and example file is a *proposed* contract, and the example files are not the output of running software. Alongside them there is a **local-first implementation** (`src/`, `test/`) that builds, starts and passes its tests. It is **not the finished product**: one person, one machine, Markdown/plain-text quotes only, a command-line capture adapter but no connected assistant, an agent skill that runs the command line when asked, and release either simulated or copied to a local folder you choose. Nothing is sent or paid, and no AI model is used. See [Implementation status](#implementation-status-phase-1-and-phase-2), [HANDOFF.md](HANDOFF.md) and [PHASE2_COVERAGE.md](PHASE2_COVERAGE.md). Nothing here has been measured; performance figures are stated goals.

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

## Quick start

You need Node.js 24 or newer and git. Everything runs on your computer. Nothing is sent anywhere, and no AI model is used.

```sh
git clone https://github.com/somethingwentwell/correction-layer.git
cd correction-layer
npm install            # TypeScript toolchain only; no runtime dependencies
cp .env.example .env   # optional; no secrets are needed
npm run dev            # the local app at http://127.0.0.1:4319/ (loopback only)
```

**1. Make a project.** Open `http://127.0.0.1:4319/`, choose **Start new**, and name a project, for example `Willowbank Veterinary Group - 2027 supply`. Projects and rules are made by you in the app. An assistant cannot make them.

**2. Add the agent skill** (for Claude Code). In a second terminal, in the clone, look first with `--dry-run`, then install:

```sh
npm run cli -- skill install --project-dir . --dry-run   # shows the two files it would write; writes nothing
npm run cli -- skill install --project-dir .             # writes ./.claude/skills/correction-layer/
npm run cli -- skill uninstall --project-dir .           # later: removes only what install wrote
```

`--project-dir .` installs into this clone, where the sample files are. For another project use `--project-dir ~/work/my-project`. `--user` installs into `~/.claude/skills`, for all your projects; use it only if you want that. Install never overwrites anything. Other assistants can use the same `SKILL.md` with the [generic recipe](docs/local-setup.md#other-agents-generic-recipe).

**3. Ask your assistant.** Start Claude Code in the clone and type, for example:

> Check examples/readme-walkthrough/01-usd/Willowbank-Quote-2027-01.md in my Correction Layer project "Willowbank Veterinary Group - 2027 supply" and give me the link.

It runs `projects --json` to find the project id, then `check ... --project prj_... --json`, and replies with the result and a link such as `[Open this check in Correction Layer (Willowbank-Quote-2027-01.md, version 1)](http://127.0.0.1:4319/runs/run_...)`. You can also ask it to "import the Willowbank files in examples/readme-walkthrough into that project and check them", or to "remember that Willowbank quotes must be in SGD". That correction goes to the project's learning inbox, and you decide what happens to it.

**4. Open the app** whenever you like: `npm run cli -- ui` prints the address. `npm run cli -- ui project prj_...` prints the address of one page.

**Limits, in short.**

- Links are loopback addresses (`http://127.0.0.1:4319/...`). They open only in a browser on the computer running the app, while it runs. An assistant on another computer cannot use them. Nothing is hosted publicly.
- An assistant can check, import documents, preview price lists and pass on corrections. It cannot create projects, add or approve rules, turn learning on, import a trusted price list, or approve, release, send or pay. A Ready result is evidence, not permission.
- The skill runs when you ask. It is not capture: it does not watch your chats or apps. Reliable capture needs a capture adapter you pair in the app, with a durable outbox ([how](docs/local-setup.md#invoking-the-skill-is-not-capture)).
- Only Markdown or plain-text quotes and CSV price lists are read. Word, Excel and PDF files get *Couldn't verify*. A CSV is previewed by the assistant and imported by you.
- Learning is off until you turn it on for a project.

More: [Your first walkthrough, with screenshots](docs/walkthrough.md) (the app by hand, step by step), [Running the local app](docs/local-setup.md) (configuration, every command, the JSON results, development), [Implementation status](#implementation-status-phase-1-and-phase-2), [HANDOFF.md](HANDOFF.md), [PHASE2_COVERAGE.md](PHASE2_COVERAGE.md).

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
| [docs/walkthrough.md](docs/walkthrough.md) | Guide to the local implementation: a first session in the app, with real screenshots |
| [docs/local-setup.md](docs/local-setup.md) | Guide to the local implementation: setup, configuration, the agent skill and its commands, capture, development |

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

## Implementation status (Phase 1 and Phase 2)

The design documents above stay the source of truth, and their "nothing is implemented" banners describe the design as written. What exists in code today is deliberately narrower: [HANDOFF.md](HANDOFF.md) lists exactly what is real and simulated, and [PHASE2_COVERAGE.md](PHASE2_COVERAGE.md) lists what Phase 2 added, which acceptance tests now pass, and what is still deferred.

To run it, see the [Quick start](#quick-start). [Running the local app](docs/local-setup.md) covers configuration, every command (including `npm run verify`, `npm start` and the command-line capture adapter), the JSON results with their links, and development.

| Real | Simulated, partial or unavailable (and labelled so in the product) |
|------|---------------------------------------------------------------------|
| Projects, folders, facts, trusted sources with CSV import (bad rows reported, never read as zero) | Word, Excel and PDF documents: *Couldn't verify*. XLSX sources: export to CSV |
| A correction editor with plain options, a dry run on your documents, overlapping rules shown before saving, real examples, change, pause with an end date, exceptions | Folder markers, moved/copied folders, folder watching |
| Ten check kinds evaluated deterministically; rules selected by scope index, never by search | Attestation and spreadsheet check kinds; AI opinions |
| Learning under a policy you set: 7 English correction patterns, tests on real versions, automatic activation only when low-risk, automatic pause of learned unconfirmed rules, inbox actions, "this was a correction", deleting wording | Free-form understanding, other languages, any AI model |
| Durable capture: acknowledgements, replay, duplicates, gaps (acknowledge as lost), dead letters (retry), a command-line adapter over loopback HTTP, transcript backfill capped at the inbox | No assistant, chat app, email or office app is connected: each is named NOT CAPTURED |
| Content diff of passages and values, re-run as recorded, a correction's journey by stored references, proposed changes kept apart from applied changes | Document preview with highlighted findings |
| Receipts, approval by a person, a gateway that re-verifies every binding; release to a local folder you choose (exactly the checked bytes, never overwriting), with a newer-version choice | Send and pay do not exist. Release is simulated unless you choose a folder |
| An agent skill ([skills/correction-layer/SKILL.md](skills/correction-layer/SKILL.md)) with JSON commands that reuse the same services: check, import documents as versions declared by an assistant, preview CSV, relay a correction, list rules, links (`ui_url`) to the local app; an installer with dry run that never overwrites | No editor, browser or marketplace extension. Links work only on the same computer. An assistant cannot import a trusted source, add or approve a rule, or approve a release |

## Your first walkthrough, with screenshots

The walkthrough has moved to **[docs/walkthrough.md](docs/walkthrough.md)**. It is one real session in the browser: nine steps with 19 screenshots, from an empty workspace to a before/after comparison. It uses the fictional Willowbank sample files in [examples/readme-walkthrough/](examples/readme-walkthrough/README.md).

## Checking this repository

The repository contains one small, dependency-free maintenance script. It is not part of the product; it only keeps the design documents honest. (It skips the implementation's toolchain files and output: `node_modules/`, `dist/`, and the root `package*.json` / `tsconfig*.json`.)

```sh
python3 tools/check_repo.py
```

It verifies that internal links and anchors resolve, that every JSON file and every `json` code block parses, that example files validate against their proposed schemas, that the example event timelines are causally ordered and hash-chained, and that wireframes are aligned. For the learning examples it also recomputes every automatic decision from its recorded inputs, replays the capture stream through the documented intake procedure, and confirms that no rule in any example was activated without either a person's approval or a learning policy a person had set earlier.

## Repository layout

```text
README.md
HANDOFF.md   what the Phase 1 scaffold implements, and what Phase 2 must complete
PHASE2_COVERAGE.md           what Phase 2 added, and what is still deferred
docs/        design documents (start with 01 and 02)
docs/walkthrough.md          guide: your first session in the app, with screenshots
docs/local-setup.md          guide: setup, the agent skill, every command, development
docs/screenshots/            real browser screenshots used by the walkthrough
examples/    worked examples with proposed fixture files
examples/readme-walkthrough/ fictional sample files for the walkthrough (not design fixtures)
schemas/     proposed JSON Schemas (draft 2020-12 subset); also the scaffold's wire contracts
skills/correction-layer/     the agent skill (SKILL.md), installed by `npm run cli -- skill install`
src/         the local implementation (TypeScript, runs on Node 24); src/agent/ is the skill's tool surface
test/        tests for the implementation
tools/       check_repo.py - consistency checks for the design documents only
```
