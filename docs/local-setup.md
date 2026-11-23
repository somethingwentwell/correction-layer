# Running the local app: setup, the agent skill, commands and development

*A guide to the local implementation (one person, one machine). The design documents in this folder describe the full product; this page describes what runs today. What is real and what is simulated is listed in [HANDOFF.md](../HANDOFF.md) and [PHASE2_COVERAGE.md](../PHASE2_COVERAGE.md).*

## Requirements and install

Node.js 24 or newer (built-in SQLite; TypeScript runs directly) and git. There are no runtime dependencies; `npm install` only fetches the TypeScript compiler. The project is run from a local clone. It is not published to the npm registry.

```sh
git clone https://github.com/somethingwentwell/correction-layer.git
cd correction-layer
npm install
cp .env.example .env   # optional; no secrets are needed
npm run dev            # start from source with reload (loopback only, port 4319)
npm start              # or: start the built service (after npm run build)
```

Then open `http://127.0.0.1:4319/` in a browser on the same computer. On an empty workspace the home page offers three ways in: **Start new** (a guided setup: project, first quote, optional first rule, first check explained), **Import existing** (Markdown or plain-text quotes and CSV price lists, previewed before anything is saved, never overwriting), and **Try a fictional demo** (clearly labelled DEMO data, only into an empty workspace; or start with `CL_SEED_DEMO=1`). [Your first walkthrough, with screenshots](walkthrough.md) goes through Start new and Import existing step by step.

## Configuration

Everything comes from the environment or `.env` (see `.env.example`):

| Variable | Default | Meaning |
|----------|---------|---------|
| `CL_DATA_DIR` | `$XDG_DATA_HOME/correction-layer` or `~/.local/share/correction-layer` | Where the workspace store (SQLite) and the generated signing key live. Use a new, empty folder for a fresh start. |
| `CL_HOST` | `127.0.0.1` | Loopback only: `127.0.0.1`, `::1` or `localhost`. Anything else is refused at start. |
| `CL_PORT` | `4319` | The port. `0` picks a free one at start (links then need `--base-url`). |
| `CL_DISPLAY_TZ` | `UTC` | IANA time zone for display; stored times are UTC. |
| `CL_LOCAL_USER_NAME` | `Local user` | The one local person (a name, no credential). |
| `CL_SEED_DEMO` | `0` | `1` loads the labelled fictional DEMO data into an empty store at start. |

The command line reads the same configuration as the app, so `npm run cli -- ...` and `npm run dev` started from the same clone use the same store and the same address.

## The agent skill and its commands

The skill is one file, [skills/correction-layer/SKILL.md](../skills/correction-layer/SKILL.md). It tells an assistant how to run this clone's command line for you: check a quote, import documents, preview a price list, pass on a correction, list rules, and return a link into the app. It adds no new engine: every command calls the same services as the app and `/api/v1`.

### Install for Claude Code

Claude Code reads project skills from `<project>/.claude/skills/<name>/SKILL.md` and personal skills from `~/.claude/skills/<name>/SKILL.md`. Run these in the clone:

```sh
npm run cli -- skill install --project-dir ~/work/my-project --dry-run   # what it would write; writes nothing
npm run cli -- skill install --project-dir ~/work/my-project             # writes .claude/skills/correction-layer/{SKILL.md,install.json}
npm run cli -- skill uninstall --project-dir ~/work/my-project --dry-run
npm run cli -- skill uninstall --project-dir ~/work/my-project           # removes only those two files, if unchanged
```

- `--project-dir .` installs into the clone itself (useful for trying the samples; the folder is git-ignored here).
- `--user` installs into `~/.claude/skills/correction-layer` for all your projects. Use it only if you want that; nothing installs there unless you ask.
- `--to <skills-dir>` installs into any other skills folder.
- Install never overwrites. If a `correction-layer` folder already exists with anything other than this exact install, it stops and says why. Uninstall removes only `SKILL.md` and `install.json`, only if `SKILL.md` is unchanged since install, and keeps any other file you put there.
- `install.json` records the hash of the copied file and `clone_dir`, the path of this clone on your computer, which the skill uses to find the command line. Do not commit it to a shared repository.
- Nothing else is changed: no agent settings file, no global configuration.

### Other agents (generic recipe)

Any assistant that can read an instruction file and run shell commands can use the same skill:

1. Give it the text of `skills/correction-layer/SKILL.md` (copy the file to wherever that assistant reads instructions, or point it at the file).
2. Tell it where the clone is: set `CORRECTION_LAYER_DIR=/path/to/correction-layer` in its environment, or say it in the conversation.
3. It runs `npm --prefix "$CORRECTION_LAYER_DIR" run --silent cli -- <command> ... --json` and reads one JSON object from standard output.

Only Claude Code's skill folders have been tried. There is no native extension for an editor, browser or marketplace.

### Commands

Run them in the clone as `npm run cli -- <command>`, or from anywhere as `npm --prefix <clone> run --silent cli -- <command>` (relative file paths are read from the folder you run it in). Add `--json` for exactly one JSON object on standard output, including on errors.

| Command | What it does |
|---------|--------------|
| `projects` | Lists projects with their ids (`prj_...`) and links. Projects are created by a person in the app. |
| `rules --project <prj_...>` | The rules that apply in the project, each with a link to its page. |
| `check <file> --project <prj_...> [--for release]` | Checks one Markdown or plain-text file. Exit status 0 Ready, 1 Needs changes, 2 Couldn't verify or not checked. Without `--project` the file must sit in a folder a person registered to a project; otherwise it is not checked. |
| `import <file>... --project <prj_...> [--dry-run] [--check]` | Markdown and plain-text documents are recorded as versions *declared by an assistant*; a same-named file becomes a new version, an identical one changes nothing. CSV files are previewed only (rows read, rows usable, rows left out and why); a person imports a trusted source in the app. Refused for DEMO projects. |
| `correct "<text>" --project <prj_...>` | Passes on a correction the person gave, marked RELAYED. It lands in the project's learning inbox and turns nothing on. Text that matches a stored document is discarded as an instruction planted in content. |
| `ui [<kind> [<id>]]` | Prints a link to a page: `home`, `start`, `import`, `history`, `project`, `rules`, `learning`, `activity`, `capture`, `coverage`, `rule`, `run`, `source`, `action`, `fix`. An unknown id is an error, not a guessed link. |
| `status` | Whether the app answers at its address, and whether it serves the same store as the command. |
| `skill install`, `skill uninstall`, `skill path` | See above. |

Options: `--json`; `--base-url http://127.0.0.1:<port>` to override the address used for links (loopback only, origin only).

### Results and links

Every agent command returns (with `--json`) an object with `schema: "cl.agent-result/1"`, `ok`, the command's own fields, and:

- `ui_url`: an absolute link to an existing page, for example `http://127.0.0.1:4319/runs/run_...` for a check. It is built from the configured loopback address (or a `--base-url` you typed), never from the content of a document, and every identifier in it is percent-encoded.
- `ui_markdown`: the same link as Markdown, ready to paste into a reply: `[Open this check in Correction Layer (Quote.md, version 1)](http://127.0.0.1:4319/runs/run_...)`.
- `links`: further links (the project, each rule, the before/after comparison with the previous version's check).
- `ui`: `base_url`; `app_running` (whether something answered `/healthz` there); `same_workspace` (whether that app serves the same store); and a `note`.
- `boundary`: a reminder that the result is advisory and that a Ready result is evidence, not permission.

A loopback link opens only in a browser on the computer running the app, while the app is running. If the assistant runs on another computer, the link is no use there. The app is never published on a network by these commands, and there is no public host.

Over HTTP, `/api/v1/check`, `list_rules`, `propose_correction`, `propose_change`, `request_action` and `hello` return the same `ui_url` / `ui_markdown` fields, built from the address of the connection the service is answering on, not from the request. The relative `review_url` is unchanged. `/api/v1/capabilities` names the skill.

### What an assistant cannot do

The commands run as an assistant (an *agent* actor). The services refuse it every act reserved for a person: creating a project, adding, approving or retiring a rule, setting a learning policy, registering or importing a trusted source, granting an exception, and approving, executing or releasing an action. On `/api/v1` those operations answer `403 human_only`. There is no command that tries. A person does them in the app.

## Invoking the skill is not capture

Invoking the skill means an assistant runs the commands above when you ask it to. It does not watch your chats, email or other apps, and it does not see corrections you give anywhere else.

Reliable capture of what you type is a separate, opt-in mechanism: a capture adapter that you pair in the app (**Capture health**), delivering through a durable outbox with acknowledgements and replay. This build ships one, the command-line adapter below. It is fed by you or by a hook script you write; no assistant runtime is connected to it.

```sh
npm run cli -- capture say --adapter adp_... --outbox ./outbox.jsonl --binding fld_... "Quotes must always be in SGD." [--project prj_... --json]
npm run cli -- capture flush --adapter adp_... --outbox ./outbox.jsonl
npm run cli -- capture backfill --adapter adp_... --outbox ./outbox.jsonl --transcript ./turns.jsonl
npm run cli -- capture close --adapter adp_... --outbox ./outbox.jsonl
```

`capture` talks to the running service over loopback HTTP. If the service is not answering, events stay in the outbox (exit status 3) and are delivered by the next `flush`. With `--json --project prj_...` the result links the project's capture health page. Learning acts on captured words only where a person turned learning on for the project.

## Development

```sh
npm run verify         # type check, build, tests (deferred contracts are "todo", never passing), design checker
npm test               # tests only
npm run build          # compile to dist/ (used by npm start)
npm run cli -- verify  # verify the ledger hash chain of your store
python3 tools/check_repo.py   # the design-document checker on its own
```

Tests use in-memory stores and temporary folders only. The source map for contributors is in [HANDOFF.md](../HANDOFF.md).
