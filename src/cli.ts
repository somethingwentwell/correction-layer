#!/usr/bin/env node
/**
 * Command line for developers, integrators and assistants (docs/06 §2.3). Never
 * required for ordinary use. The exit status of `check` reflects the verdict.
 *
 * With --json, stdout is exactly one JSON object (schema "cl.agent-result/1",
 * or "cl.skill-install-result/1" for `skill`), including on errors. The agent
 * commands act as an assistant (an "agent" actor): the services refuse every
 * act reserved for a person, and this file adds no command that tries.
 */
import { resolve } from "node:path";
import { HttpCaptureTransport, LocalOutboxAdapter } from "./capture/local-adapter.ts";
import { sha256 } from "./domain/canonical.ts";
import { ts } from "./domain/time.ts";
import { startServer } from "./api/server.ts";
import { createAppFromConfig } from "./app.ts";
import type { Config } from "./config.ts";
import { loadConfig } from "./config.ts";
import { ClError } from "./domain/errors.ts";
import { seedDemo } from "./seed/demo.ts";
import { readFileSync } from "node:fs";
import { UI_NOTE, configBaseUrl, loopbackBaseUrl, uiLink, UI_ROUTES } from "./agent/links.ts";
import type { AgentEnv, AgentResult } from "./agent/tool.ts";
import { AGENT_ACTOR, AGENT_RESULT_SCHEMA, BOUNDARY, checkFile, errorResult, importFiles, listProjects, listRules, relayCorrection, uiFor, workspaceFingerprint } from "./agent/tool.ts";
import { installSkill, skillSourcePath, uninstallSkill } from "./agent/skill-install.ts";
import { effectiveEnv, ensureEnvFile, inspect, setupResult, waitFor } from "./agent/setup.ts";
import { repoRoot } from "./paths.ts";

const USAGE = `correction-layer <command>

  setup [--create-env] [--wait <seconds>] [--json]
                             is it safe to start the app here, or is this workspace already running?
                             exit 0 ready (reuse it; prints the link), 3 not running and the port is
                             free (start it with npm run dev, then setup --wait 30), 4 not safe to start
                             (another program, another store or an older app holds the port; nothing
                             is stopped). --create-env copies .env.example to .env only if .env does
                             not exist (never overwrites). Never starts, stops or signals a process.
  serve                      start the local service and app (loopback only)
  migrate                    create or upgrade the workspace store
  seed-demo                  load labelled DEMO data into an empty workspace
  verify                     verify the ledger hash chain
  check <file> [--project <prj_...>] [--for release|check_only|send_external] [--json]
                             advisory check; exit 0 Ready, 1 Needs changes, 2 Couldn't verify
                             (without --project the file must be in a folder registered to a project)

  Agent tool surface (used by the skill in skills/correction-layer/SKILL.md; add --json for one JSON object):
  projects                   list projects (ids, names, links)
  rules --project <prj_...>  the rules that apply in a project
  import <file>... --project <prj_...> [--dry-run] [--check] [--for <action>]
                             Markdown / plain-text documents: recorded as versions declared by an
                             assistant (never overwriting). CSV price lists: PREVIEW ONLY
                             [--key-columns item_code] [--value-columns unit_price] [--source <src_...>];
                             a person imports a trusted source in the app
  correct "<text>" --project <prj_...>
                             pass on a correction the person gave (RELAYED; lands in their inbox,
                             turns nothing on)
  ui [<kind> [<id>]] [--project <prj_...>]
                             print a link to a page of the local app: home, start, import, history,
                             project, rules, learning, activity, capture, coverage, rule, run,
                             source, action, fix
  status                     is the app answering at its loopback address?
  skill install   (--to <skills-dir> | --project-dir <project> | --user) [--dry-run]
  skill uninstall (--to <skills-dir> | --project-dir <project> | --user) [--dry-run]
  skill path                 where this clone's SKILL.md is
                             --project-dir installs to <project>/.claude/skills/correction-layer (Claude
                             Code project skill); --user to ~/.claude/skills/correction-layer, only
                             when you ask for it. Never overwrites; uninstall removes only what
                             install wrote.
  options for the agent commands: --json, --base-url http://127.0.0.1:<port> (loopback only;
                             default from CL_HOST / CL_PORT)

  capture <say|agent|flush|backfill|close> --adapter <adp_...> --outbox <file> [options]
                             command-line capture adapter with a durable outbox file. It talks
                             to the RUNNING service over loopback HTTP (start it with serve).
                             Pair the adapter first in the app (Capture health). No assistant
                             is connected by this command; you or your own hook script feed it.
      say "<text>"           a message you typed (attested by this adapter)
      agent "<text>"         an assistant's output (sent as a digest only, never as text)
      flush                  deliver/replay everything still in the outbox
      backfill --transcript <file.jsonl>
                             recover turns from a transcript ({"role","text","occurred_at"}
                             per line); marked as backfill, never treated as live words
      close                  end the stream (anything missing stays a visible gap)
      options: --stream <str_...> --binding <fld_...> --artifact <art_...> --hash <sha256:...>
               --project <prj_...> (for the link in --json output) --json

Configuration comes from the environment (see .env.example).`;

const BOOL_FLAGS = new Set(["json", "dry-run", "check", "user", "help", "create-env"]);

export interface ParsedArgs {
  positional: string[];
  flags: Map<string, string | true>;
}

/** Boolean flags never swallow the next word; value flags require one. "--" ends the flags. */
export function parseArgs(args: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") {
      positional.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith("--") && a.length > 2) {
      const [name, inline] = a.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
      if (BOOL_FLAGS.has(name)) flags.set(name, true);
      else if (inline !== undefined) flags.set(name, inline);
      else {
        const v = args[i + 1];
        if (v === undefined) throw new ClError("usage", `--${name} needs a value`, 64);
        flags.set(name, v);
        i++;
      }
    } else positional.push(a);
  }
  return { positional, flags };
}

/** The directory the person ran the command from (npm run moves the process to the clone). */
function callerCwd(): string {
  return process.env.npm_lifecycle_event && process.env.INIT_CWD ? process.env.INIT_CWD : process.cwd();
}

/** The base for links and loopback calls: a typed --base-url (validated), else CL_HOST / CL_PORT. */
function baseFor(config: Config, flags: ParsedArgs["flags"]): string | null {
  const given = flags.get("base-url");
  if (typeof given === "string") return loopbackBaseUrl(given);
  return configBaseUrl(config);
}

async function probe(base: string | null): Promise<{ running: boolean | null; health: any }> {
  if (!base) return { running: null, health: null };
  try {
    const res = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(800) });
    const json: any = res.ok ? await res.json() : null;
    return { running: json?.service === "correction-layer", health: json };
  } catch {
    return { running: false, health: null };
  }
}

const AGENT_COMMANDS = new Set(["projects", "rules", "import", "correct", "ui", "status"]);

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help") {
    console.log(USAGE);
    return command ? 0 : 64;
  }
  let parsed: ParsedArgs;
  const json = rest.includes("--json");
  try {
    parsed = parseArgs(rest);
  } catch (error) {
    if (json) console.log(JSON.stringify(errorResult(null, command, error), null, 2));
    else console.error(`${(error as Error).message}\n\n${USAGE}`);
    return 64;
  }
  if (command === "skill") return skill(parsed);
  if (command === "setup") return setup(parsed);
  const config = loadConfig();
  if (command === "capture") return capture(parsed, config);
  if (command === "serve") {
    const app = createAppFromConfig(config);
    if (config.seedDemo) {
      const seeded = seedDemo(app);
      console.log(seeded.seeded ? `DEMO data loaded (project ${seeded.project_id}). It is fictional and labelled DEMO.` : `DEMO data not loaded: ${seeded.reason}.`);
    }
    const running = await startServer(app, { host: config.host, port: config.port });
    console.log(`Correction Layer (Phase 2 local MVP) is running at ${running.url}`);
    console.log(`  store:  ${config.dbPath} (schema version ${app.schemaVersion})`);
    console.log(`  health: ${running.url}/healthz`);
    console.log(`  open:   ${running.url}/  (in a browser on this computer; loopback only)`);
    const stop = (): void => {
      void running.close().then(() => {
        app.close();
        process.exit(0);
      });
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    return await new Promise<number>(() => undefined);
  }
  if (command === "check" || AGENT_COMMANDS.has(command)) return agentCommand(command, parsed, config);
  const app = createAppFromConfig(config);
  try {
    switch (command) {
      case "migrate":
        console.log(`Workspace store ready at ${config.dbPath} (schema version ${app.schemaVersion}).`);
        return 0;
      case "seed-demo": {
        const seeded = seedDemo(app);
        console.log(seeded.seeded ? `DEMO data loaded (project ${seeded.project_id}). It is fictional and labelled DEMO.` : `DEMO data not loaded: ${seeded.reason}.`);
        return seeded.seeded ? 0 : 1;
      }
      case "verify": {
        const v = app.ledger.verify();
        console.log(v.ok ? `History verifies: ${v.events} events.` : `History does NOT verify: first problem at sequence ${v.first_bad_seq} (${v.problem}).`);
        return v.ok ? 0 : 1;
      }
      default:
        console.error(`Unknown command: ${command}\n\n${USAGE}`);
        return 64;
    }
  } finally {
    app.close();
  }
}

/** check / projects / rules / import / correct / ui / status: in-process, through the existing services, as an agent. */
async function agentCommand(command: string, parsed: ParsedArgs, config: Config): Promise<number> {
  const json = parsed.flags.has("json");
  const flag = (name: string): string | undefined => {
    const v = parsed.flags.get(name);
    return typeof v === "string" ? v : undefined;
  };
  const list = (name: string): string[] | undefined => flag(name)?.split(",").map((x) => x.trim()).filter(Boolean);
  let base: string | null;
  try {
    base = baseFor(config, parsed.flags);
  } catch (error) {
    if (json) console.log(JSON.stringify(errorResult(null, command, error), null, 2));
    else console.error(error instanceof ClError ? `${error.code}: ${error.message}` : String(error));
    return 65;
  }
  const { running, health } = await probe(base);
  const app = createAppFromConfig(config);
  const fingerprint = workspaceFingerprint(app);
  const env: AgentEnv = { app, base, appRunning: running, sameWorkspace: running && health?.workspace_fingerprint !== undefined ? health.workspace_fingerprint === fingerprint : null, cwd: callerCwd(), actor: AGENT_ACTOR };
  if (command === "status") {
    const home = uiLink(base, UI_ROUTES.home(), "Open Correction Layer");
    const out: AgentResult = {
      schema: AGENT_RESULT_SCHEMA, command: "status", ok: true, running, health: health ? { status: health.status, phase: health.phase, schema_version: health.schema_version, ledger_head_seq: health.ledger_head_seq } : null,
      ...home, ui: { base_url: base, app_running: running, same_workspace: env.sameWorkspace ?? null, note: running && env.sameWorkspace === false ? `${UI_NOTE} The app answering there uses a DIFFERENT workspace store (another CL_DATA_DIR) than this command.` : running ? UI_NOTE : `${UI_NOTE} Nothing answers there now: start it with npm run dev (or npm start).` },
      links: [{ kind: "home", label: "Open Correction Layer", ...home }], boundary: BOUNDARY,
    };
    if (json) console.log(JSON.stringify(out, null, 2));
    else console.log(!running ? `Correction Layer is not answering at ${base ?? "(unknown port)"}. Start it with: npm run dev` : env.sameWorkspace === false ? `An app is answering at ${base}, but it serves a different workspace store (another CL_DATA_DIR) than this command.` : `Correction Layer is running. Open ${home.ui_url} in a browser on this computer.`);
    app.close();
    return running ? 0 : 3;
  }
  try {
    let out: AgentResult;
    switch (command) {
      case "projects":
        out = listProjects(env);
        break;
      case "rules":
        out = listRules(env, flag("project"), flag("for") ?? "release");
        break;
      case "check": {
        const file = parsed.positional[0];
        if (!file || parsed.positional.length > 1) throw new ClError("usage", "check takes one file", 64);
        out = checkFile(env, file, { ...(parsed.flags.has("project") ? { project: flag("project") } : {}), ...(flag("for") ? { action: flag("for")! } : {}) });
        break;
      }
      case "import":
        out = importFiles(env, parsed.positional, { project: flag("project"), dryRun: parsed.flags.has("dry-run"), check: parsed.flags.has("check"), ...(flag("for") ? { action: flag("for")! } : {}), ...(list("key-columns") ? { keyColumns: list("key-columns")! } : {}), ...(list("value-columns") ? { valueColumns: list("value-columns")! } : {}), ...(flag("source") ? { sourceId: flag("source")! } : {}) });
        break;
      case "correct": {
        const text = parsed.positional.join(" ").trim();
        if (!text) throw new ClError("usage", "give the correction text", 64);
        out = relayCorrection(env, text, { project: flag("project") });
        break;
      }
      case "ui":
        out = uiFor(env, parsed.positional[0] ?? "home", parsed.positional[1], { ...(flag("project") ? { project: flag("project")! } : {}) });
        break;
      default:
        throw new ClError("usage", `unknown command ${command}`, 64);
    }
    if (json) console.log(JSON.stringify(out, null, 2));
    else printHuman(out);
    if (command === "check") return out.verdict === "ready" ? 0 : out.verdict === "needs_changes" ? 1 : 2;
    return 0;
  } catch (error) {
    const usage = error instanceof ClError && error.code === "usage";
    if (json) console.log(JSON.stringify(errorResult(env, command, error), null, 2));
    else console.error(error instanceof ClError ? `${error.code}: ${error.message}${usage ? `\n\n${USAGE}` : ""}` : error);
    return usage ? 64 : error instanceof ClError ? 65 : 70;
  } finally {
    app.close();
  }
}

function printHuman(out: AgentResult): void {
  switch (out.command) {
    case "check":
      console.log(out.human_summary);
      if (out.run_id) console.log(`run ${out.run_id}${out.receipt_id ? `, receipt ${out.receipt_id}` : ""}`);
      break;
    case "projects":
      for (const p of out.projects as Array<{ project_id: string; name: string; is_demo: boolean }>) console.log(`${p.project_id}  ${p.name}${p.is_demo ? "  (DEMO)" : ""}`);
      console.log(out.note);
      break;
    case "rules":
      for (const r of out.rules as Array<{ rule_id: string; status: string; enforcement: string; statement: string }>) console.log(`${r.rule_id}  ${r.status}/${r.enforcement}  ${r.statement}`);
      if (!(out.rules as unknown[]).length) console.log("No rules apply in this project yet.");
      break;
    case "import":
      for (const i of out.items as Array<Record<string, unknown>>) console.log(`${i.file}: ${i.kind === "trusted_source_csv" ? `preview only, ${i.rows_usable} of ${i.rows_read} row(s) usable` : i.stored ? `stored as version ${i.version_seq}` : i.problem ?? (i.would ? `would be stored (${i.would})` : `not stored (${i.outcome})`)}`);
      console.log(out.note);
      break;
    case "correct":
      console.log(out.note);
      break;
    default:
      break;
  }
  if (out.ui_url) console.log(`open: ${out.ui_url}${out.ui.app_running === false ? "  (the app is not running; start it with npm run dev)" : ""}`);
}

/**
 * setup: .env from the example only if absent, then one deterministic look at the configured
 * loopback address (ready / safe to start / not safe). Starts and stops nothing.
 */
async function setup(parsed: ParsedArgs): Promise<number> {
  const json = parsed.flags.has("json");
  try {
    const root = repoRoot();
    const envFile = ensureEnvFile(root, parsed.flags.has("create-env"));
    // A .env created just now was not there when npm's --env-file-if-exists ran: read it the same way.
    const config = loadConfig(effectiveEnv(root));
    const waitRaw = parsed.flags.get("wait");
    const wait = typeof waitRaw === "string" ? Number(waitRaw) : null;
    if (wait !== null && (!Number.isFinite(wait) || wait < 0 || wait > 300)) throw new ClError("usage", "--wait takes a number of seconds (0-300)", 64);
    const base = configBaseUrl(config);
    const app = createAppFromConfig(config);
    let fingerprint: string | null;
    try {
      fingerprint = workspaceFingerprint(app);
    } finally {
      app.close();
    }
    const look = () => inspect(config.host, config.port, base, fingerprint);
    const found = wait === null ? await look() : await waitFor(look, wait);
    const { out, exit } = setupResult(found, envFile, { waited: wait !== null });
    if (json) console.log(JSON.stringify(out, null, 2));
    else {
      if (envFile.status === "created" || parsed.flags.has("create-env")) console.log(envFile.note);
      console.log(out.person_message);
      if (out.next === "start") console.log(`Safe to start: run ${out.start_command} in this folder, then: npm run cli -- setup --wait 30`);
    }
    return exit;
  } catch (error) {
    const usage = error instanceof ClError && error.code === "usage";
    if (json) console.log(JSON.stringify(errorResult(null, "setup", error), null, 2));
    else console.error(error instanceof ClError ? `${error.code}: ${error.message}` : String(error));
    return usage ? 64 : 65;
  }
}

/** skill install | uninstall | path. Writes only under the destination named; never edits agent settings. */
function skill(parsed: ParsedArgs): number {
  const [sub] = parsed.positional;
  const json = parsed.flags.has("json");
  const v = (name: string): string | undefined => {
    const x = parsed.flags.get(name);
    return typeof x === "string" ? x : undefined;
  };
  try {
    if (sub === "path") {
      const path = skillSourcePath();
      console.log(json ? JSON.stringify({ schema: "cl.skill-install-result/1", command: "skill path", ok: true, skill_file: path }, null, 2) : path);
      return 0;
    }
    if (sub !== "install" && sub !== "uninstall") throw new ClError("usage", "skill install | skill uninstall | skill path", 64);
    const dest = { ...(v("to") !== undefined ? { to: v("to")! } : {}), ...(v("project-dir") !== undefined ? { projectDir: v("project-dir")! } : {}), ...(parsed.flags.has("user") ? { user: true } : {}) };
    const opts = { cwd: callerCwd(), dryRun: parsed.flags.has("dry-run") };
    const out = sub === "install" ? installSkill(dest, opts) : uninstallSkill(dest, opts);
    if (json) console.log(JSON.stringify(out, null, 2));
    else {
      for (const w of out.writes) console.log(`${out.dry_run ? "would write" : "wrote"}  ${w}`);
      for (const r of out.removes) console.log(`${out.dry_run ? "would remove" : "removed"}  ${r}`);
      console.log(out.note);
    }
    return 0;
  } catch (error) {
    const code = error instanceof ClError ? error.code : "internal_error";
    if (json) console.log(JSON.stringify({ schema: "cl.skill-install-result/1", command: `skill ${sub ?? ""}`.trim(), ok: false, error: { code, message: (error as Error).message } }, null, 2));
    else console.error(`${code}: ${(error as Error).message}${code === "usage" ? `\n\n${USAGE}` : ""}`);
    return code === "usage" ? 64 : 65;
  }
}

/** The command-line capture adapter. Exit 0 delivered, 3 kept in the outbox (service unreachable or refused), 64 usage. */
async function capture(parsed: ParsedArgs, config: Config): Promise<number> {
  const [sub, ...positional] = parsed.positional;
  const json = parsed.flags.has("json");
  const flag = (name: string): string | undefined => {
    const v = parsed.flags.get(name);
    return typeof v === "string" ? v : undefined;
  };
  const adapterId = flag("adapter");
  const outbox = flag("outbox");
  if (!sub || !adapterId || !outbox) {
    console.error(USAGE);
    return 64;
  }
  let base: string;
  try {
    // The capture transport goes only to a validated loopback address.
    const b = baseFor(config, parsed.flags);
    if (!b) throw new ClError("base_url_refused", "CL_PORT=0: pass --base-url http://127.0.0.1:<port> of the running service", 400);
    base = b;
  } catch (error) {
    if (json) console.log(JSON.stringify(errorResult(null, `capture ${sub}`, error), null, 2));
    else console.error((error as Error).message);
    return 64;
  }
  const projectId = flag("project");
  const page = projectId && /^prj_[0-9A-Za-z]{6,26}$/.test(projectId) ? UI_ROUTES.capture(projectId) : UI_ROUTES.home();
  const report = (body: Record<string, unknown>, ok: boolean): void => {
    if (!json) return;
    const l = uiLink(base, page, projectId ? "Open capture health in Correction Layer" : "Open Correction Layer");
    const out: AgentResult = { schema: AGENT_RESULT_SCHEMA, command: `capture ${sub}`, ok, adapter_id: adapterId, stream_id: streamId, ...body, ...l, ui: { base_url: base, app_running: null, same_workspace: null, note: UI_NOTE }, links: [{ kind: "capture", label: "Capture health", ...l }], boundary: "Capture delivers what the paired adapter is given, durably, with replay. It does not watch any app by itself." };
    console.log(JSON.stringify(out, null, 2));
  };
  const outboxPath = resolve(callerCwd(), outbox);
  const streamId = flag("stream") ?? `str_${sha256(`${adapterId}|${outboxPath}`).slice(7, 27).toUpperCase()}`;
  const adapter = new LocalOutboxAdapter({ adapter_id: adapterId, stream_id: streamId, outbox_path: outboxPath, binding_id: flag("binding") ?? null });
  const transport = new HttpCaptureTransport(base);
  const now = ts(new Date());
  const binding = { ...(flag("artifact") ? { artifact_id: flag("artifact")! } : {}), ...(flag("hash") ? { content_hash: flag("hash")! } : {}) };
  let backfilled: number | null = null;
  switch (sub) {
    case "say":
    case "agent": {
      const text = positional.join(" ").trim();
      if (!text) {
        console.error("Give the text to capture.");
        return 64;
      }
      adapter.emit(sub === "say"
        ? { kind: "user_turn", role: "user", attested_by: "runtime_hook", occurred_at: now, text, binding }
        : { kind: "agent_output", role: "agent", attested_by: "runtime_hook", occurred_at: now, text, binding });
      break;
    }
    case "backfill": {
      const file = flag("transcript");
      if (!file) {
        console.error("Give --transcript <file.jsonl>.");
        return 64;
      }
      let n = 0;
      for (const line of readFileSync(resolve(callerCwd(), file), "utf8").split("\n").filter((l) => l.trim())) {
        const t = JSON.parse(line) as { role?: string; text?: string; occurred_at?: string };
        const at = typeof t.occurred_at === "string" && /Z$/.test(t.occurred_at) ? t.occurred_at : now;
        if (t.role === "user" && typeof t.text === "string") adapter.backfill({ kind: "user_turn", role: "user", occurred_at: at, text: t.text });
        else if (t.role === "agent" || t.role === "assistant") adapter.backfill({ kind: "agent_output", role: "agent", occurred_at: at, text: String(t.text ?? "") });
        else continue;
        n++;
      }
      backfilled = n;
      if (!json) console.log(`${n} transcript turn(s) added to the outbox as backfill.`);
      break;
    }
    case "flush":
      break;
    case "close": {
      const flushed = await adapter.flushAsync(transport);
      if (!flushed.delivered) {
        report({ delivered: false, kept_in_outbox: adapter.pending, error: flushed.error }, false);
        if (!json) console.error(`Not delivered; kept in the outbox: ${flushed.error}`);
        return 3;
      }
      const closed = await adapter.closeAsync(transport);
      report({ delivered: true, closed: true, cursor: closed.cursor }, true);
      if (!json) console.log(`Stream ${streamId} closed at ${closed.cursor}.`);
      return 0;
    }
    default:
      console.error(USAGE);
      return 64;
  }
  const out = await adapter.flushAsync(transport);
  if (!out.delivered) {
    report({ delivered: false, kept_in_outbox: adapter.pending, error: out.error, ...(backfilled !== null ? { backfilled } : {}) }, false);
    if (!json) console.error(`Not delivered; ${adapter.pending} event(s) kept in the outbox for replay: ${out.error}`);
    return 3;
  }
  report({ delivered: true, cursor: out.cursor, results: out.results, ...(backfilled !== null ? { backfilled } : {}) }, true);
  if (!json) console.log(`Stream ${streamId}: acknowledged through ${out.cursor}. ${out.results.map((r) => `#${r.source_seq} ${r.result}`).join(", ") || "nothing pending"}.`);
  return 0;
}

main(process.argv.slice(2)).then((code) => process.exit(code), (error: unknown) => {
  console.error(error instanceof ClError ? `${error.code}: ${error.message}` : error);
  process.exit(70);
});
