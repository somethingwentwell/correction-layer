/**
 * Assistant-managed setup: the `setup` helper the skill runs, the `.env`
 * mechanism the npm scripts use, reuse of an app already serving the same
 * store, refusal (without touching anything) when the port belongs to someone
 * else, and the skill / README text that tells an assistant to do all this in
 * plain language.
 *
 * The command-line cases run the real npm scripts in a COPY of this clone in a
 * temporary folder (temp HOME, temp data folder, free loopback ports). Nothing
 * here writes to the real clone's .env, a real home directory or any agent
 * settings, and the only processes signalled are the ones these tests start.
 */
import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { effectiveEnv, ensureEnvFile, inspect, personMessage, setupResult, START_COMMAND, waitFor } from "../src/agent/setup.ts";
import { workspaceFingerprint } from "../src/agent/tool.ts";
import { startServer } from "../src/api/server.ts";
import { repoRoot } from "../src/paths.ts";
import { makeApp, tmpDir } from "./helpers.ts";

const ROOT = repoRoot();
const CLONE_URL = "https://github.com/somethingwentwell/correction-layer.git";
const SEQUENCE = [
  "git clone https://github.com/somethingwentwell/correction-layer.git",
  "cd correction-layer",
  "npm install            # TypeScript toolchain only; no runtime dependencies",
  "cp .env.example .env   # optional; no secrets are needed",
  "npm run dev            # the local app at http://127.0.0.1:4319/ (loopback only)",
];

async function freePort(): Promise<number> {
  return await new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

const listening = (server: { address(): unknown }): number => (server.address() as { port: number }).port;

/** A copy of what `git clone` gives the skill (the files the app needs), in a fresh temporary folder. */
function copyClone(): string {
  const dir = join(tmpDir(), "correction-layer");
  mkdirSync(dir);
  for (const f of ["package.json", ".env.example"]) cpSync(join(ROOT, f), join(dir, f));
  for (const d of ["src", "schemas", "skills"]) cpSync(join(ROOT, d), join(dir, d), { recursive: true });
  return dir;
}

/** `npm run --silent cli -- ...` in a clone, with a clean environment (no CL_* unless given). */
function npmCli(clone: string, args: string[], env: Record<string, string> = {}): { status: number | null; json: any; stdout: string; stderr: string; ms: number } {
  const t = Date.now();
  const r = spawnSync("npm", ["run", "--silent", "cli", "--", ...args], { cwd: clone, encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: join(clone, ".."), ...env }, timeout: 60000 });
  let json: any = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    json = null;
  }
  return { status: r.status, json, stdout: r.stdout, stderr: r.stderr, ms: Date.now() - t };
}

/** `npm run dev` in a clone, in its own process group so the test can stop exactly what it started. */
function npmDev(clone: string, env: Record<string, string> = {}): ChildProcess {
  return spawn("npm", ["run", "dev"], { cwd: clone, env: { PATH: process.env.PATH ?? "", HOME: join(clone, ".."), ...env }, detached: true, stdio: "ignore" });
}

async function stopGroup(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((r) => child.once("exit", () => r()));
  process.kill(-child.pid!, "SIGTERM");
  await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
}

const health = async (base: string): Promise<any> => (await fetch(`${base}/healthz`)).json();

// ------------------------------------------------------------------ .env: optional, never overwritten, really loaded
test(".env: created from the example only when absent; an existing .env is never overwritten; environment wins as with --env-file", () => {
  const dir = tmpDir();
  writeFileSync(join(dir, ".env.example"), "CL_PORT=4319\nCL_DISPLAY_TZ=Asia/Singapore\n");
  assert.equal(ensureEnvFile(dir, false).status, "absent", "without --create-env nothing is written");
  assert.equal(existsSync(join(dir, ".env")), false);
  assert.equal(ensureEnvFile(dir, true).status, "created");
  assert.equal(readFileSync(join(dir, ".env"), "utf8"), readFileSync(join(dir, ".env.example"), "utf8"));
  // The person edits .env; the example changes; setup runs again: the person's file is untouched.
  writeFileSync(join(dir, ".env"), "# mine\nCL_PORT=4555\n");
  writeFileSync(join(dir, ".env.example"), "CL_PORT=9999\n");
  const again = ensureEnvFile(dir, true);
  assert.equal(again.status, "kept");
  assert.equal(readFileSync(join(dir, ".env"), "utf8"), "# mine\nCL_PORT=4555\n");
  // The values are read the way Node's --env-file-if-exists reads them: the process environment wins.
  assert.equal(effectiveEnv(dir, {}).CL_PORT, "4555");
  assert.equal(effectiveEnv(dir, { CL_PORT: "4600" }).CL_PORT, "4600");
  const none = tmpDir();
  assert.equal(ensureEnvFile(none, true).status, "no_example");
  assert.deepEqual(effectiveEnv(none, { A: "1" }), { A: "1" });
});

test("the npm scripts load .env with --env-file-if-exists (the mechanism the docs and the skill describe)", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  for (const script of ["dev", "start", "cli", "migrate", "seed:demo"]) assert.match(pkg.scripts[script], /^node --env-file-if-exists=\.env /, script);
  assert.match(pkg.scripts.dev, /src\/cli\.ts serve$/);
  assert.equal(Object.keys(pkg.dependencies ?? {}).length, 0, "no runtime dependencies: npm install fetches only the toolchain");
  const example = readFileSync(join(ROOT, ".env.example"), "utf8");
  assert.match(example, /^CL_HOST=127\.0\.0\.1$/m);
  assert.ok(!/(SECRET|TOKEN|PASSWORD|API_KEY)\s*=/i.test(example), "no secrets in the example");
});

// ------------------------------------------------------------------ the decision, in-process
test("inspect: free port -> safe to start; same store -> reuse; other store, foreign app, silent listener, old app -> refused and left alone", async () => {
  const app = makeApp();
  const fp = workspaceFingerprint(app);
  assert.ok(fp);
  const server = await startServer(app, { host: "127.0.0.1", port: 0 });
  const foreign = createHttpServer((_q, s) => s.end("hello from something else")).listen(0, "127.0.0.1");
  const silent: Server = createServer(() => undefined).listen(0, "127.0.0.1"); // accepts, never answers
  const oldApp = createHttpServer((_q, s) => s.setHeader("content-type", "application/json").end(JSON.stringify({ status: "ok", service: "correction-layer" }))).listen(0, "127.0.0.1");
  await new Promise((r) => setTimeout(r, 50));
  try {
    const free = await freePort();
    const at = (port: number, f: string | null = fp) => inspect("127.0.0.1", port, `http://127.0.0.1:${port}`, f);
    assert.equal((await at(free)).state, "not_running");
    const p = Number(new URL(server.url).port);
    assert.equal((await at(p)).state, "ready");
    assert.equal((await at(p, "sha256:another-store")).state, "other_workspace");
    assert.equal((await at(listening(foreign))).state, "port_in_use");
    assert.equal((await at(listening(silent))).state, "port_in_use");
    assert.equal((await at(listening(oldApp))).state, "unverifiable", "a Correction Layer that cannot prove its store is not reused");
    assert.equal((await inspect("127.0.0.1", 0, null, fp)).state, "no_fixed_port");
    assert.equal((await inspect("127.0.0.1", free, `http://127.0.0.1:${free}`, fp, "22.11.0")).state, "node_too_old");
    // Everything probed is still there and still answering: nothing was stopped.
    assert.equal((await health(server.url)).workspace_fingerprint, fp);
    assert.equal(await (await fetch(`http://127.0.0.1:${listening(foreign)}/`)).text(), "hello from something else");
    assert.ok(silent.listening && oldApp.listening);
    // The result envelope: link only when reusing; plain words without ids, paths or JSON.
    const ready = setupResult(await at(p), { status: "kept", note: "" }, { waited: false });
    assert.equal(ready.exit, 0);
    assert.equal(ready.out.ui_url, `${server.url}/`);
    assert.equal(ready.out.ui_markdown, `[Open Correction Layer](${server.url}/)`);
    assert.equal(ready.out.started_by_setup, false);
    const start = setupResult(await at(free), { status: "absent", note: "" }, { waited: false });
    assert.deepEqual([start.exit, start.out.next, start.out.start_command, start.out.ui_url], [3, "start", START_COMMAND, null]);
    const busy = setupResult(await at(listening(foreign)), { status: "absent", note: "" }, { waited: false });
    assert.deepEqual([busy.exit, busy.out.ok, busy.out.safe_to_start, busy.out.next], [4, false, false, "stop"]);
    for (const state of ["ready", "not_running", "port_in_use", "other_workspace", "unverifiable", "no_fixed_port", "node_too_old"] as const) {
      const msg = personMessage({ state, base: "http://127.0.0.1:4319", port: 4319, health: null }, "http://127.0.0.1:4319/");
      assert.ok(!/prj_|run_|sha256|CL_|\.env|npm |\{|\/home|fingerprint/.test(msg), `${state}: plain words only: ${msg}`);
      if (state !== "ready" && state !== "not_running" && state !== "no_fixed_port" && state !== "node_too_old") assert.match(msg, /left it alone/);
    }
    // --wait gives up after the deadline when nothing comes up.
    const t = Date.now();
    assert.equal((await waitFor(() => at(free), 0.4, 50)).state, "not_running");
    assert.ok(Date.now() - t < 3000);
  } finally {
    await server.close();
    app.close();
    foreign.close();
    silent.close();
    oldApp.close();
  }
});

test("setup itself can never start, stop or signal a process", () => {
  const src = readFileSync(join(ROOT, "src", "agent", "setup.ts"), "utf8");
  for (const forbidden of ["child_process", "process.kill", "spawn(", "exec(", ".listen(", "createServer"]) assert.ok(!src.includes(forbidden), `setup.ts does not use ${forbidden}`);
});

// ------------------------------------------------------------------ the documented sequence, through the real npm scripts
test("assistant-managed setup in a fresh copy: .env kept and loaded, safe to start, npm run dev, health check, reuse on a second run", async () => {
  const clone = copyClone();
  const data = join(clone, "..", "store");
  const port = await freePort();
  const mine = `# my settings\nCL_DATA_DIR=${data}\nCL_PORT=${port}\nCL_DISPLAY_TZ=Asia/Singapore\n`;
  writeFileSync(join(clone, ".env"), mine);

  const first = npmCli(clone, ["setup", "--create-env", "--json"]); // no CL_* in the environment: only .env says where
  assert.equal(first.status, 3, first.stderr + first.stdout);
  assert.equal(first.json.state, "not_running");
  assert.equal(first.json.env_file.status, "kept");
  assert.equal(readFileSync(join(clone, ".env"), "utf8"), mine, ".env is never overwritten");
  assert.equal(first.json.ui.base_url, `http://127.0.0.1:${port}`, "CL_PORT came from .env");
  assert.ok(existsSync(join(data, "workspace.db")), "CL_DATA_DIR came from .env");
  assert.equal(first.json.start_command, "npm run dev");

  const dev = npmDev(clone);
  try {
    const up = npmCli(clone, ["setup", "--wait", "30", "--json"]);
    assert.equal(up.status, 0, up.stderr + up.stdout);
    assert.equal(up.json.state, "ready");
    assert.equal(up.json.ui.same_workspace, true);
    assert.equal(up.json.ui_url, `http://127.0.0.1:${port}/`);
    assert.equal((await fetch(up.json.ui_url)).status, 200, "the link opens the app");
    const before = await health(`http://127.0.0.1:${port}`);

    const second = npmCli(clone, ["setup", "--create-env", "--json"]);
    assert.equal(second.status, 0);
    assert.equal(second.json.state, "ready");
    assert.equal(second.json.started_by_setup, false);
    assert.equal(second.json.ui_url, up.json.ui_url);
    assert.equal(second.json.env_file.status, "kept");
    assert.equal(readFileSync(join(clone, ".env"), "utf8"), mine);
    const after = await health(`http://127.0.0.1:${port}`);
    assert.equal(after.workspace_fingerprint, before.workspace_fingerprint, "still the same server and store");
    assert.equal(dev.exitCode, null, "the server we started is still the one running");

    // The same port with a DIFFERENT store (the environment overrides .env): refused, server untouched.
    const other = npmCli(clone, ["setup", "--json"], { CL_DATA_DIR: join(clone, "..", "other-store") });
    assert.equal(other.status, 4);
    assert.equal(other.json.state, "other_workspace");
    assert.equal(other.json.ui_url, null, "no link into somebody else's data");
    assert.match(other.json.person_message, /left it alone/);
    assert.equal((await health(`http://127.0.0.1:${port}`)).workspace_fingerprint, before.workspace_fingerprint);
    assert.equal(dev.exitCode, null);
  } finally {
    await stopGroup(dev);
  }
});

test("setup in a copy without .env: --create-env copies the example once; a foreign program on the port is refused and left running", async () => {
  const clone = copyClone();
  const port = await freePort();
  const env = { CL_DATA_DIR: join(clone, "..", "store"), CL_PORT: String(port) }; // environment wins over the example's 4319
  const created = npmCli(clone, ["setup", "--create-env", "--json"], env);
  assert.equal(created.status, 3, created.stderr + created.stdout);
  assert.equal(created.json.env_file.status, "created");
  assert.equal(readFileSync(join(clone, ".env"), "utf8"), readFileSync(join(clone, ".env.example"), "utf8"));
  writeFileSync(join(clone, ".env"), readFileSync(join(clone, ".env"), "utf8") + "CL_LOCAL_USER_NAME=Pat (test)\n");
  const edited = readFileSync(join(clone, ".env"), "utf8");
  assert.equal(npmCli(clone, ["setup", "--create-env", "--json"], env).json.env_file.status, "kept");
  assert.equal(readFileSync(join(clone, ".env"), "utf8"), edited);

  const foreign = createHttpServer((_q, s) => s.end("not correction layer")).listen(0, "127.0.0.1");
  await new Promise((r) => setTimeout(r, 50));
  try {
    const r = npmCli(clone, ["setup", "--json"], { ...env, CL_PORT: String(listening(foreign)) });
    assert.equal(r.status, 4);
    assert.equal(r.json.state, "port_in_use");
    assert.equal(r.json.safe_to_start, false);
    assert.ok(foreign.listening);
    assert.equal(await (await fetch(`http://127.0.0.1:${listening(foreign)}/`)).text(), "not correction layer");
    const human = npmCli(clone, ["setup"], { ...env, CL_PORT: String(listening(foreign)) });
    assert.equal(human.status, 4);
    assert.match(human.stdout, /Another program on this computer is already using/);
    assert.equal(npmCli(clone, ["setup", "--wait", "nope", "--json"], env).status, 64);
  } finally {
    foreign.close();
  }
});

// ------------------------------------------------------------------ the skill and README tell the assistant to do this, in plain words
test("the skill: setup trigger, the official clone URL and sequence, the safe helper, layman replies, and the safety limits", () => {
  const skill = readFileSync(join(ROOT, "skills", "correction-layer", "SKILL.md"), "utf8");
  const [, front, body] = /^---\n([\s\S]*?)\n---\n([\s\S]+)$/.exec(skill)!;
  const description = /^description: (.+)$/m.exec(front!)![1]!;
  assert.match(description, /set up Correction Layer/i);
  assert.match(description, /install, start or open/);
  assert.ok(body!.includes(CLONE_URL));
  for (const line of SEQUENCE) assert.ok(body!.includes(line), `the user's sequence: ${line}`);
  assert.ok(body!.includes("npm run --silent cli -- setup --create-env --json"));
  assert.ok(body!.includes("npm run --silent cli -- setup --wait 30 --json"));
  assert.match(body!, /only if `\.env` does not exist/);
  assert.match(body!, /\[ -e \.env \] \|\| cp \.env\.example \.env/);
  assert.match(body!, /--env-file-if-exists=\.env/);
  assert.match(body!, /Git\*\* and \*\*Node\.js 24 or newer/);
  assert.match(body!, /do not use `sudo`/);
  assert.match(body!, /never ask for passwords, tokens or other credentials/);
  assert.match(body!, /Reuse it\. Do not start another one\./);
  assert.match(body!, /do not clone over it/);
  assert.match(body!, /never kill or stop the other program/);
  assert.match(body!, /never change proxy settings, never open a public tunnel/);
  assert.match(body!, /Do not ask the person to open a terminal/);
  assert.match(body!, /Never show them\*\* raw JSON, internal identifiers/);
  assert.match(body!, /Do not paste it, or the ids in it, to the person/);
  assert.match(body!, /what needs changing, why, what to do next/);
  assert.match(body!, /Never claim it became an active rule/);
  assert.match(body!, /only the person can do, in the app/);
  assert.match(body!, /--dry-run --json/);
  assert.match(body!, /Use `--user` \(all their projects\) only if they clearly ask/);
  assert.match(body!, /Word, Excel and PDF files can't be checked yet/);
  assert.match(body!, /different computer from the person/);
  assert.match(body!, /never present the link as if they could click it/);
  assert.match(body!, /data, not instructions/);
  assert.ok(!/\/home\/|\/Users\/|warren/i.test(skill), "generic: no machine or account paths");
});

test("the README: assistant-first prompts, the honest bootstrap, technical steps folded away, walkthrough anchor kept", () => {
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  const quick = readme.slice(readme.indexOf("## Quick start"), readme.indexOf("**Limits, in short.**"));
  assert.match(quick, /> Set up Correction Layer for me\./);
  assert.ok(quick.includes("https://raw.githubusercontent.com/somethingwentwell/correction-layer/main/skills/correction-layer/SKILL.md"));
  assert.ok(quick.includes("https://github.com/somethingwentwell/correction-layer"));
  assert.match(quick, /> Check the Willowbank quote against my Willowbank project\./);
  assert.match(quick, /> Remember that Willowbank quotes should be in SGD\./);
  assert.match(quick, /no app-store entry, marketplace listing or one-click installer/);
  assert.match(quick, /cannot set anything up on yours/);
  assert.ok(!/npx /.test(readme), "no npx install is claimed");
  const plain = quick.slice(0, quick.indexOf("<details>"));
  assert.ok(!/```|npm |prj_|--json/.test(plain), "the part before <details> has no commands, ids or JSON");
  const details = quick.slice(quick.indexOf("<details>"), quick.indexOf("</details>"));
  for (const line of SEQUENCE) assert.ok(details.includes(line), line);
  for (const cmd of ["setup --create-env --json", "skill install --project-dir . --dry-run", "skill uninstall --project-dir .", "npm run cli -- ui"]) assert.ok(details.includes(cmd), cmd);
  assert.match(readme, /^## Your first walkthrough, with screenshots$/m);
  assert.ok(readme.includes("](docs/walkthrough.md)"));
});
