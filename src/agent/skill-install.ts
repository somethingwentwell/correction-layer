/**
 * Install or remove the Correction Layer agent skill by copying one file.
 *
 *   install   copies skills/correction-layer/SKILL.md from this clone to
 *             <skills-dir>/correction-layer/SKILL.md and writes install.json
 *             beside it (the file's hash and where this clone is, so the skill
 *             can find the CLI). Never overwrites: if anything other than this
 *             exact install is already there, it stops and says why.
 *   uninstall removes only those two files, and only if SKILL.md is unchanged
 *             since install; then removes the folder if it is empty. It never
 *             deletes anything else, whatever install.json says.
 *
 * Both have a dry run that writes nothing. Destinations are named explicitly:
 * a skills folder (--to), a project (--project-dir: <dir>/.claude/skills, the
 * Claude Code project skills folder) or, only when asked, the user's own
 * Claude Code skills folder (--user: ~/.claude/skills). Nothing else is edited:
 * no agent settings file, no global configuration.
 */
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { ClError } from "../domain/errors.ts";
import { repoRoot } from "../paths.ts";

export const SKILL_NAME = "correction-layer";
export const SKILL_FILE = "SKILL.md";
export const MANIFEST_FILE = "install.json";
export const MANIFEST_SCHEMA = "cl.skill-install/1";
/** The only names uninstall will ever remove. */
const OWNED = new Set([SKILL_FILE, MANIFEST_FILE]);

export class SkillInstallRefused extends ClError {
  constructor(message: string) {
    super("skill_install_refused", message, 409);
  }
}

export function skillSourcePath(root: string = repoRoot()): string {
  return join(root, "skills", SKILL_NAME, SKILL_FILE);
}

const digest = (bytes: Uint8Array | string): string => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

export interface Destination {
  /** --to <skills-dir> */
  to?: string;
  /** --project-dir <dir>  ->  <dir>/.claude/skills */
  projectDir?: string;
  /** --user  ->  ~/.claude/skills (only when explicitly requested) */
  user?: boolean;
}

/** Resolve the skills folder. Exactly one destination; no ".." segments; relative paths from `cwd`. */
export function skillsDir(dest: Destination, cwd: string, home: string = homedir()): string {
  const given = [dest.to !== undefined, dest.projectDir !== undefined, !!dest.user].filter(Boolean).length;
  if (given !== 1) throw new SkillInstallRefused("Name exactly one destination: --to <skills-dir>, --project-dir <project> or --user.");
  const raw = dest.user ? join(home, ".claude", "skills") : (dest.to ?? dest.projectDir)!;
  if (!raw || raw.includes("\0")) throw new SkillInstallRefused("The destination path is empty or invalid.");
  if (raw.split(/[\\/]/).includes("..")) throw new SkillInstallRefused(`The destination ${raw} contains "..". Give the folder without ".." so the destination is exactly what you typed.`);
  const base = isAbsolute(raw) ? resolve(raw) : resolve(cwd, raw);
  return dest.projectDir !== undefined ? join(base, ".claude", "skills") : base;
}

function kind(path: string): "missing" | "file" | "dir" | "symlink" | "other" {
  try {
    const st = lstatSync(path);
    return st.isSymbolicLink() ? "symlink" : st.isFile() ? "file" : st.isDirectory() ? "dir" : "other";
  } catch {
    return "missing";
  }
}

export interface SkillPlan {
  schema: "cl.skill-install-result/1";
  command: "skill install" | "skill uninstall";
  ok: boolean;
  dry_run: boolean;
  skills_dir: string;
  target_dir: string;
  status: "would_install" | "installed" | "already_installed" | "would_remove" | "removed" | "not_installed";
  writes: string[];
  removes: string[];
  note: string;
}

export function installSkill(dest: Destination, opts: { cwd: string; dryRun?: boolean; home?: string; root?: string; now?: () => string }): SkillPlan {
  const root = opts.root ?? repoRoot();
  const source = skillSourcePath(root);
  const content = readFileSync(source);
  const dir = skillsDir(dest, opts.cwd, opts.home);
  const target = join(dir, SKILL_NAME);
  if (resolve(target) === resolve(join(root, "skills", SKILL_NAME))) throw new SkillInstallRefused("That is this clone's own copy of the skill (its source). Install into a project's .claude/skills or another skills folder.");
  const skillPath = join(target, SKILL_FILE);
  const manifestPath = join(target, MANIFEST_FILE);
  const base = { schema: "cl.skill-install-result/1" as const, command: "skill install" as const, dry_run: !!opts.dryRun, skills_dir: dir, target_dir: target };
  const t = kind(target);
  if (t === "dir") {
    const entries = readdirSync(target);
    const ours = entries.every((e) => OWNED.has(e)) && kind(skillPath) === "file" && kind(manifestPath) === "file";
    if (ours && digest(readFileSync(skillPath)) === digest(content)) {
      return { ...base, ok: true, status: "already_installed", writes: [], removes: [], note: `Already installed and identical at ${skillPath}. Nothing changed.` };
    }
    throw new SkillInstallRefused(`${target} already exists${ours ? " with a different SKILL.md (an older install, or edited)" : ` and holds other files (${entries.slice(0, 5).join(", ") || "empty folder"})`}. Nothing was overwritten. Run "skill uninstall" first${ours ? "" : ", or move that folder away yourself"}.`);
  }
  if (t !== "missing") throw new SkillInstallRefused(`${target} exists and is not a plain folder (${t}). Nothing was written.`);
  const writes = [skillPath, manifestPath];
  if (opts.dryRun) return { ...base, ok: true, status: "would_install", writes, removes: [], note: "Dry run: nothing was written. Run the same command without --dry-run to install." };
  mkdirSync(target, { recursive: true });
  // "wx": fail rather than replace if something appeared in between.
  writeFileSync(skillPath, content, { flag: "wx" });
  const manifest = { schema: MANIFEST_SCHEMA, skill: SKILL_NAME, files: { [SKILL_FILE]: digest(content) }, clone_dir: root, installed_at: (opts.now ?? (() => new Date().toISOString()))(), note: "Written by `npm run cli -- skill install`. clone_dir is this computer's Correction Layer folder; the skill runs its CLI from there. Remove with `skill uninstall`." };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
  return { ...base, ok: true, status: "installed", writes, removes: [], note: `Installed. Claude Code finds it at ${skillPath}${dest.projectDir !== undefined ? " when you work in that project" : ""}. install.json records this clone's path (${root}); do not commit it to a shared repository.` };
}

export function uninstallSkill(dest: Destination, opts: { cwd: string; dryRun?: boolean; home?: string }): SkillPlan {
  const dir = skillsDir(dest, opts.cwd, opts.home);
  const target = join(dir, SKILL_NAME);
  const base = { schema: "cl.skill-install-result/1" as const, command: "skill uninstall" as const, dry_run: !!opts.dryRun, skills_dir: dir, target_dir: target };
  const t = kind(target);
  if (t === "missing") return { ...base, ok: true, status: "not_installed", writes: [], removes: [], note: `Nothing installed at ${target}. Nothing changed.` };
  if (t !== "dir") throw new SkillInstallRefused(`${target} is not a plain folder (${t}). Nothing was removed.`);
  const skillPath = join(target, SKILL_FILE);
  const manifestPath = join(target, MANIFEST_FILE);
  if (kind(manifestPath) !== "file") throw new SkillInstallRefused(`${target} has no ${MANIFEST_FILE}: it was not installed by this command. Nothing was removed.`);
  let manifest: any;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    throw new SkillInstallRefused(`${manifestPath} is not readable JSON. Nothing was removed.`);
  }
  if (manifest?.schema !== MANIFEST_SCHEMA || manifest?.skill !== SKILL_NAME || typeof manifest?.files?.[SKILL_FILE] !== "string") throw new SkillInstallRefused(`${manifestPath} is not a Correction Layer install record. Nothing was removed.`);
  // The manifest cannot widen what is removed: only the two owned names, whatever it lists.
  const listed = Object.keys(manifest.files);
  if (listed.some((f) => !OWNED.has(f))) throw new SkillInstallRefused(`${manifestPath} lists files this command never installs (${listed.filter((f) => !OWNED.has(f)).join(", ")}). Nothing was removed.`);
  if (kind(skillPath) === "file" && digest(readFileSync(skillPath)) !== manifest.files[SKILL_FILE]) throw new SkillInstallRefused(`${skillPath} was changed after install. Nothing was removed; delete it yourself if you mean to.`);
  if (kind(skillPath) !== "file" && kind(skillPath) !== "missing") throw new SkillInstallRefused(`${skillPath} is not a regular file. Nothing was removed.`);
  const removes = [skillPath, manifestPath].filter((p) => kind(p) === "file");
  const others = readdirSync(target).filter((e) => !OWNED.has(e));
  if (opts.dryRun) return { ...base, ok: true, status: "would_remove", writes: [], removes, note: `Dry run: nothing was removed.${others.length ? ` ${target} also holds other files (${others.join(", ")}); they would be kept, and so would the folder.` : ""}` };
  for (const p of removes) unlinkSync(p);
  if (!readdirSync(target).length) rmdirSync(target);
  return { ...base, ok: true, status: "removed", writes: [], removes, note: others.length ? `Removed the skill files. Other files in ${target} were kept: ${others.join(", ")}.` : "Removed." };
}
