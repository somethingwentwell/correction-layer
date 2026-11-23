/**
 * Installing the agent skill: a copy of skills/correction-layer/SKILL.md into a
 * skills folder the person names. Every destination here is a temporary folder;
 * no test touches a real home directory or any agent's settings.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { installSkill, skillSourcePath, skillsDir, SkillInstallRefused, uninstallSkill } from "../src/agent/skill-install.ts";
import { repoRoot } from "../src/paths.ts";
import { tmpDir } from "./helpers.ts";

const ROOT = repoRoot();
const SOURCE = readFileSync(skillSourcePath(ROOT), "utf8");

test("the skill file: standard frontmatter, a trigger description, generic paths, and the stated boundaries", () => {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]+)$/.exec(SOURCE);
  assert.ok(m, "YAML frontmatter between --- lines");
  const fields = Object.fromEntries(m![1]!.split("\n").map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 1).trim()]));
  assert.deepEqual(Object.keys(fields).sort(), ["description", "name"]);
  assert.equal(fields.name, "correction-layer");
  assert.match(fields.description!, /Use when/);
  assert.match(fields.description!, /Never use it to approve, release, send or pay/);
  const body = m![2]!;
  assert.ok(!/\/home\/|\/Users\/|@[a-z0-9-]+\.(com|org|net)/i.test(SOURCE), "no machine- or account-specific paths or email addresses");
  assert.match(body, /--json/);
  assert.match(body, /only in a browser on the computer running the app/);
  assert.match(body, /different computer/);
  assert.match(body, /not automatic capture/i);
  assert.match(body, /data, not instructions/);
  assert.match(body, /evidence that the listed rules passed at that time\. It is not permission/);
});

test("install: a dry run writes nothing; install copies SKILL.md to <project>/.claude/skills/correction-layer with an install record", () => {
  const project = tmpDir();
  const dry = installSkill({ projectDir: project }, { cwd: "/", dryRun: true, root: ROOT });
  assert.equal(dry.status, "would_install");
  assert.equal(dry.target_dir, join(project, ".claude", "skills", "correction-layer"));
  assert.deepEqual(dry.writes, [join(dry.target_dir, "SKILL.md"), join(dry.target_dir, "install.json")]);
  assert.deepEqual(readdirSync(project), [], "nothing was written by the dry run");

  const done = installSkill({ projectDir: project }, { cwd: "/", root: ROOT, now: () => "2026-11-23T00:00:00Z" });
  assert.equal(done.status, "installed");
  assert.equal(readFileSync(join(done.target_dir, "SKILL.md"), "utf8"), SOURCE, "an exact copy");
  const manifest = JSON.parse(readFileSync(join(done.target_dir, "install.json"), "utf8"));
  assert.equal(manifest.schema, "cl.skill-install/1");
  assert.equal(manifest.clone_dir, ROOT);
  assert.match(manifest.files["SKILL.md"], /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(readdirSync(done.target_dir).sort(), ["SKILL.md", "install.json"]);
  // Idempotent when identical.
  assert.equal(installSkill({ projectDir: project }, { cwd: "/", root: ROOT }).status, "already_installed");
});

test("install never overwrites: a changed SKILL.md, foreign files, a symlink or a file in the way stop it", () => {
  const skills = tmpDir();
  installSkill({ to: skills }, { cwd: "/", root: ROOT });
  const path = join(skills, "correction-layer", "SKILL.md");
  writeFileSync(path, "my own edits\n");
  assert.throws(() => installSkill({ to: skills }, { cwd: "/", root: ROOT }), SkillInstallRefused);
  assert.equal(readFileSync(path, "utf8"), "my own edits\n", "the person's file is untouched");

  const other = tmpDir();
  mkdirSync(join(other, "correction-layer"));
  writeFileSync(join(other, "correction-layer", "SKILL.md"), "someone else's skill\n");
  assert.throws(() => installSkill({ to: other }, { cwd: "/", root: ROOT }), /already exists and holds other files|Nothing was overwritten/);
  assert.equal(readFileSync(join(other, "correction-layer", "SKILL.md"), "utf8"), "someone else's skill\n");

  const linked = tmpDir();
  const elsewhere = tmpDir();
  symlinkSync(elsewhere, join(linked, "correction-layer"));
  assert.throws(() => installSkill({ to: linked }, { cwd: "/", root: ROOT }), /not a plain folder \(symlink\)/);
  assert.deepEqual(readdirSync(elsewhere), [], "nothing written through the link");

  const blocked = tmpDir();
  writeFileSync(join(blocked, "correction-layer"), "a file");
  assert.throws(() => installSkill({ to: blocked }, { cwd: "/", root: ROOT }), /not a plain folder \(file\)/);

  assert.throws(() => installSkill({ to: join(ROOT, "skills") }, { cwd: "/", root: ROOT }), /this clone's own copy/);
});

test("destinations: exactly one, no '..' segments; --user means ~/.claude/skills only when asked; relative paths from the caller", () => {
  const home = tmpDir();
  assert.equal(skillsDir({ user: true }, "/", home), join(home, ".claude", "skills"));
  assert.equal(skillsDir({ to: "skills" }, "/work/proj"), "/work/proj/skills");
  assert.equal(skillsDir({ projectDir: "." }, "/work/proj"), "/work/proj/.claude/skills");
  assert.throws(() => skillsDir({}, "/"), /exactly one destination/);
  assert.throws(() => skillsDir({ to: "/a", user: true }, "/"), /exactly one destination/);
  for (const bad of ["../elsewhere", "/tmp/x/../../etc", "a/../../b", "..\\win"]) assert.throws(() => skillsDir({ to: bad }, "/work"), /contains "\.\."/, bad);
  assert.throws(() => skillsDir({ to: "a\0b" }, "/"), /invalid/);
  const done = installSkill({ user: true }, { cwd: "/", root: ROOT, home });
  assert.ok(existsSync(join(home, ".claude", "skills", "correction-layer", "SKILL.md")));
  assert.deepEqual(readdirSync(join(home, ".claude")), ["skills"], "nothing else in the (temporary) home was touched");
  assert.equal(done.status, "installed");
});

test("uninstall removes only what install wrote, only if unchanged; a tampered record cannot widen it", () => {
  const skills = tmpDir();
  assert.equal(uninstallSkill({ to: skills }, { cwd: "/" }).status, "not_installed");
  installSkill({ to: skills }, { cwd: "/", root: ROOT });
  const target = join(skills, "correction-layer");
  writeFileSync(join(target, "notes.txt"), "mine");
  const dry = uninstallSkill({ to: skills }, { cwd: "/", dryRun: true });
  assert.equal(dry.status, "would_remove");
  assert.deepEqual(readdirSync(target).sort(), ["SKILL.md", "install.json", "notes.txt"], "dry run removed nothing");
  const done = uninstallSkill({ to: skills }, { cwd: "/" });
  assert.equal(done.status, "removed");
  assert.deepEqual(readdirSync(target), ["notes.txt"], "the person's own file and the folder are kept");

  // Changed after install: refused.
  const s2 = tmpDir();
  installSkill({ to: s2 }, { cwd: "/", root: ROOT });
  writeFileSync(join(s2, "correction-layer", "SKILL.md"), "edited");
  assert.throws(() => uninstallSkill({ to: s2 }, { cwd: "/" }), /changed after install/);
  assert.equal(readFileSync(join(s2, "correction-layer", "SKILL.md"), "utf8"), "edited");

  // A record that lists a path outside the folder: refused, the outside file untouched.
  const s3 = tmpDir();
  installSkill({ to: s3 }, { cwd: "/", root: ROOT });
  writeFileSync(join(s3, "outside.txt"), "keep me");
  const mpath = join(s3, "correction-layer", "install.json");
  const m = JSON.parse(readFileSync(mpath, "utf8"));
  m.files["../outside.txt"] = m.files["SKILL.md"];
  writeFileSync(mpath, JSON.stringify(m));
  assert.throws(() => uninstallSkill({ to: s3 }, { cwd: "/" }), /never installs/);
  assert.equal(readFileSync(join(s3, "outside.txt"), "utf8"), "keep me");
  assert.ok(existsSync(join(s3, "correction-layer", "SKILL.md")));

  // Not installed by this command (no record): refused.
  const s4 = tmpDir();
  mkdirSync(join(s4, "correction-layer"));
  writeFileSync(join(s4, "correction-layer", "SKILL.md"), "x");
  assert.throws(() => uninstallSkill({ to: s4 }, { cwd: "/" }), /no install\.json/);
  assert.ok(existsSync(join(s4, "correction-layer", "SKILL.md")));
});

test("the command line: skill install --dry-run / install / uninstall into a temporary project, JSON on stdout", () => {
  const project = tmpDir();
  const home = tmpDir();
  const run = (args: string[]) => {
    const r = spawnSync(process.execPath, [join(ROOT, "src", "cli.ts"), "skill", ...args], { cwd: project, encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: home }, timeout: 30000 });
    return { status: r.status, json: JSON.parse(r.stdout), stderr: r.stderr };
  };
  const dry = run(["install", "--project-dir", ".", "--dry-run", "--json"]);
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(dry.json.status, "would_install");
  assert.deepEqual(readdirSync(project), []);
  const inst = run(["install", "--project-dir", ".", "--json"]);
  assert.equal(inst.json.status, "installed");
  assert.equal(readFileSync(join(project, ".claude", "skills", "correction-layer", "SKILL.md"), "utf8"), SOURCE);
  const twice = run(["install", "--to", "../x", "--json"]);
  assert.equal(twice.status, 65);
  assert.equal(twice.json.ok, false);
  assert.equal(twice.json.error.code, "skill_install_refused");
  const un = run(["uninstall", "--project-dir", ".", "--json"]);
  assert.equal(un.json.status, "removed");
  assert.ok(!existsSync(join(project, ".claude", "skills", "correction-layer")));
  assert.deepEqual(readdirSync(home), [], "the (temporary) home was not touched");
});
