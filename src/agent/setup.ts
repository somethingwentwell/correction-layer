/**
 * `setup`: the deterministic part of "set up Correction Layer for me".
 *
 * An assistant (or a person) runs it from the clone after `npm install`. It
 *   - optionally creates `.env` from `.env.example`, ONLY when `.env` does not
 *     exist (an exclusive copy: an existing `.env` is never overwritten, even
 *     in a race); `.env` holds no secrets;
 *   - reads the same configuration the npm scripts read (`node
 *     --env-file-if-exists=.env`: values already in the environment win over
 *     the file, exactly as Node applies it);
 *   - looks at the configured loopback address and says, deterministically,
 *     one of: ready (this workspace is already being served: reuse it),
 *     not_running (the port is free: safe to start `npm run dev`), or a reason
 *     it is NOT safe to start (another program holds the port; another
 *     Correction Layer store is served there; an older app that cannot prove
 *     which store it serves; no fixed port).
 *
 * It never starts, stops or signals a process, never binds a port, never
 * changes the host, and never writes anywhere except `.env` in the clone (and
 * the workspace store, which opening the configuration creates exactly as
 * `npm run migrate` would). Starting the long-running server stays `npm run dev`.
 */
import { constants, copyFileSync, existsSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { UI_NOTE, UI_ROUTES, uiLink } from "./links.ts";
import type { AgentResult } from "./tool.ts";
import { AGENT_RESULT_SCHEMA, BOUNDARY } from "./tool.ts";

export const MIN_NODE_MAJOR = 24;
export const START_COMMAND = "npm run dev";

export type SetupState = "ready" | "not_running" | "port_in_use" | "other_workspace" | "unverifiable" | "no_fixed_port" | "node_too_old";

export interface EnvFileResult {
  status: "created" | "kept" | "absent" | "no_example";
  note: string;
}

/** `.env` from `.env.example`, only if `.env` is absent. COPYFILE_EXCL makes "never overwrite" atomic. */
export function ensureEnvFile(root: string, create: boolean): EnvFileResult {
  const target = join(root, ".env");
  if (existsSync(target)) return { status: "kept", note: "An .env file already exists; it was left exactly as it is." };
  if (!create) return { status: "absent", note: "No .env file; the defaults are used (no secrets are needed)." };
  if (!existsSync(join(root, ".env.example"))) return { status: "no_example", note: "There is no .env.example to copy; the defaults are used." };
  try {
    copyFileSync(join(root, ".env.example"), target, constants.COPYFILE_EXCL);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return { status: "kept", note: "An .env file appeared meanwhile; it was left exactly as it is." };
    throw error;
  }
  return { status: "created", note: "Created .env from .env.example (no secrets in it)." };
}

/**
 * The environment the npm scripts see: `<root>/.env` (if present) under the
 * process environment. Same precedence as `node --env-file-if-exists=.env`,
 * so a `.env` created by this run is honoured before the next command starts.
 */
export function effectiveEnv(root: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const file = join(root, ".env");
  if (!existsSync(file)) return env;
  return { ...parseEnv(readFileSync(file, "utf8")), ...env };
}

/** Whether something accepts TCP connections on host:port. Connects only; never binds. */
export function portAnswers(host: string, port: number, timeoutMs = 800): Promise<boolean> {
  return new Promise((resolveP) => {
    const socket = connect({ host, port });
    const done = (v: boolean): void => {
      socket.destroy();
      resolveP(v);
    };
    socket.setTimeout(timeoutMs, () => done(true)); // something holds the port but does not respond quickly: not free
    socket.once("connect", () => done(true));
    socket.once("error", (e: NodeJS.ErrnoException) => done(e.code !== "ECONNREFUSED"));
  });
}

export interface Health {
  status?: string;
  service?: string;
  workspace_fingerprint?: string;
  [k: string]: unknown;
}

export async function fetchHealth(base: string, timeoutMs = 1500): Promise<Health | null> {
  try {
    const res = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(timeoutMs), redirect: "manual" });
    if (!res.ok) return null;
    const json = (await res.json()) as Health;
    return json && typeof json === "object" ? json : null;
  } catch {
    return null;
  }
}

export interface Inspection {
  state: SetupState;
  base: string | null;
  port: number;
  health: Health | null;
}

/** One deterministic look at the configured address. `fingerprint` identifies this command's store. */
export async function inspect(host: string, port: number, base: string | null, fingerprint: string | null, nodeVersion = process.versions.node): Promise<Inspection> {
  if (Number(nodeVersion.split(".")[0]) < MIN_NODE_MAJOR) return { state: "node_too_old", base, port, health: null };
  if (!base || !port) return { state: "no_fixed_port", base, port, health: null };
  if (!(await portAnswers(host, port))) return { state: "not_running", base, port, health: null };
  const health = await fetchHealth(base);
  if (health?.service !== "correction-layer" || health.status !== "ok") return { state: "port_in_use", base, port, health };
  if (typeof health.workspace_fingerprint !== "string" || !fingerprint) return { state: "unverifiable", base, port, health };
  return { state: health.workspace_fingerprint === fingerprint ? "ready" : "other_workspace", base, port, health };
}

/** --wait: poll until the app answers (or something definitive and unsafe appears), up to `seconds`. */
export async function waitFor(look: () => Promise<Inspection>, seconds: number, intervalMs = 250): Promise<Inspection> {
  const deadline = Date.now() + Math.max(0, seconds) * 1000;
  let last = await look();
  while ((last.state === "not_running" || last.state === "port_in_use") && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    last = await look();
  }
  return last;
}

/** Plain words an assistant can pass on as they are: no ids, paths, JSON or commands. */
export function personMessage(i: Inspection, homeUrl: string | null): string {
  switch (i.state) {
    case "ready":
      return `Correction Layer is ready. Open it here: ${homeUrl}. The link works in a browser on this computer while the app is running.`;
    case "not_running":
      return "Correction Layer is installed but not running yet.";
    case "port_in_use":
      return `Another program on this computer is already using the address Correction Layer needs (port ${i.port}). I left it alone and did not start Correction Layer. You can close that program, or I can set Correction Layer up on a different port if you'd like.`;
    case "other_workspace":
      return `A different Correction Layer, with its own separate data, is already running on this computer (port ${i.port}). I left it alone and did not start a second one. Tell me whether you want to use that one, or have this one set up on a different port.`;
    case "unverifiable":
      return `A Correction Layer app is already running on this computer (port ${i.port}), but it is an older version that cannot confirm which data it uses. I left it alone and did not start a second one. You can close it and let me start this one, or I can use a different port.`;
    case "no_fixed_port":
      return "Correction Layer is set to pick its port at random, so I cannot give you a reliable link. It needs a fixed port to be set up this way.";
    case "node_too_old":
      return `Correction Layer needs Node.js ${MIN_NODE_MAJOR} or newer on this computer, and the version here is older. Please install a current Node.js, then ask me again.`;
  }
}

export function setupResult(i: Inspection, envFile: EnvFileResult, opts: { waited: boolean }): { out: AgentResult; exit: number } {
  const home = i.state === "ready" ? uiLink(i.base, UI_ROUTES.home(), "Open Correction Layer") : { ui_url: null, ui_markdown: null };
  const next = i.state === "ready" ? "open" : i.state === "not_running" ? "start" : "stop";
  const out: AgentResult = {
    schema: AGENT_RESULT_SCHEMA,
    command: "setup",
    ok: i.state === "ready" || i.state === "not_running",
    state: i.state,
    next,
    safe_to_start: i.state === "not_running",
    started_by_setup: false,
    ...(next === "start" ? { start_command: START_COMMAND } : {}),
    waited: opts.waited,
    env_file: envFile,
    node_version: process.versions.node,
    health: i.health ? { status: i.health.status ?? null, service: i.health.service ?? null, phase: i.health.phase ?? null, has_fingerprint: typeof i.health.workspace_fingerprint === "string" } : null,
    person_message: personMessage(i, home.ui_url),
    ...home,
    ui: {
      base_url: i.base,
      app_running: i.state === "not_running" ? false : i.state === "ready" || i.state === "other_workspace" || i.state === "unverifiable" ? true : null,
      same_workspace: i.state === "ready" ? true : i.state === "other_workspace" ? false : null,
      note: UI_NOTE,
    },
    links: i.state === "ready" ? [{ kind: "home", label: "Open Correction Layer", ...home }] : [],
    boundary: `${BOUNDARY} Setup never starts, stops or signals a process, and never overwrites .env.`,
  };
  return { out, exit: i.state === "ready" ? 0 : i.state === "not_running" ? 3 : 4 };
}
