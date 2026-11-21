/**
 * Workspace, people, projects, facts, folder bindings, trusted sources, and context
 * resolution (docs/04).
 *
 * Context is resolved for every check from the artifact's own location or an
 * explicitly confirmed project - never from session memory, and never from the
 * content of a work artifact. Project facts and trusted sources are designated by
 * people.
 *
 * Phase 1 boundary: resolution by store binding (nearest registered ancestor) or by
 * an explicit project id. Markers, moved/copied folders, areas, lineage across
 * projects and ambiguity questions are Phase 2 extension points.
 */
import { resolve as resolvePath, sep } from "node:path";
import { sha256, digestOf } from "../domain/canonical.ts";
import { NotFound, NotImplementedYet, ValidationError } from "../domain/errors.ts";
import type { IdGen } from "../domain/ids.ts";
import type { Clock } from "../domain/time.ts";
import { ts } from "../domain/time.ts";
import type { Actor, ResolvedContext, SourceRow, SourceSnapshot } from "../domain/types.ts";
import type { Ledger } from "../ledger/ledger.ts";
import { requireHuman } from "../policy/rules.ts";
import type { RuleService } from "../policy/rules.ts";
import type { Db } from "../store/db.ts";
import { all, get, json, parse, run, tx } from "../store/db.ts";

export interface Workspace {
  workspace_id: string;
  name: string;
  display_tz: string;
  is_demo: boolean;
}

export interface Project {
  project_id: string;
  workspace_id: string;
  name: string;
  default_work_type: string;
  is_demo: boolean;
  created_at: string;
  facts: Record<string, string>;
  folders: Array<{ binding_id: string; path: string }>;
}

export const WORK_TYPES = Object.freeze(["sales_proposal"]);

export class ProjectService {
  private db: Db;
  private ledger: Ledger;
  private clock: Clock;
  private ids: IdGen;
  private rules: RuleService;
  private workspaceId: string;

  constructor(deps: { db: Db; ledger: Ledger; clock: Clock; ids: IdGen; rules: RuleService; workspaceId: string }) {
    this.db = deps.db;
    this.ledger = deps.ledger;
    this.clock = deps.clock;
    this.ids = deps.ids;
    this.rules = deps.rules;
    this.workspaceId = deps.workspaceId;
  }

  workspace(): Workspace {
    const row = get<any>(this.db, "SELECT * FROM workspace WHERE workspace_id = ?", this.workspaceId);
    if (!row) throw new NotFound("workspace", this.workspaceId);
    return { workspace_id: row.workspace_id, name: row.name, display_tz: row.display_tz, is_demo: !!row.is_demo };
  }

  // ------------------------------------------------------------ people (solo mode)
  ensurePerson(principalId: string, displayName: string): Actor {
    run(this.db, "INSERT INTO principals (principal_id, workspace_id, kind, display_name, roles_json, created_at) VALUES (?, ?, 'human', ?, ?, ?) ON CONFLICT (principal_id) DO NOTHING",
      principalId, this.workspaceId, displayName, json(["owner", "rule_steward", "maker", "approver"]), ts(this.clock.now()));
    return this.person(principalId);
  }

  person(principalId: string): Actor {
    const row = get<any>(this.db, "SELECT principal_id, display_name FROM principals WHERE principal_id = ? AND kind = 'human'", principalId);
    if (!row) throw new NotFound("person", principalId);
    return { kind: "human", id: row.principal_id, display_name: row.display_name };
  }

  displayName(principalId: string | null | undefined): string {
    if (!principalId) return "unknown";
    return get<any>(this.db, "SELECT display_name FROM principals WHERE principal_id = ?", principalId)?.display_name ?? principalId;
  }

  // ------------------------------------------------------------ projects
  createProject(input: { project_id?: string; name: string; default_work_type: string; facts?: Record<string, string>; folder?: string; is_demo?: boolean }, actor: Actor): Project {
    requireHuman(actor, "Creating a project");
    if (!input.name.trim()) throw new ValidationError("project", ["name: required"]);
    if (!WORK_TYPES.includes(input.default_work_type)) throw new ValidationError("project", [`default_work_type: this build knows only ${WORK_TYPES.join(", ")}`]);
    return tx(this.db, () => {
      const projectId = input.project_id ?? this.ids("prj");
      const now = ts(this.clock.now());
      run(this.db, "INSERT INTO projects (project_id, workspace_id, name, default_work_type, is_demo, created_at) VALUES (?,?,?,?,?,?)",
        projectId, this.workspaceId, input.name.trim(), input.default_work_type, input.is_demo ? 1 : 0, now);
      const created = this.ledger.append({
        type: "project.created", project_id: projectId, actor, subject: { kind: "project", id: projectId },
        summary: `${actor.display_name ?? actor.id} created the project ${input.name.trim()}.`, payload: { default_work_type: input.default_work_type, demo: !!input.is_demo },
      });
      for (const [key, value] of Object.entries(input.facts ?? {})) this.setFact(projectId, key, value, actor, created.event_id);
      if (input.folder) this.registerFolder(projectId, input.folder, actor);
      return this.get(projectId);
    });
  }

  /** A fact takes effect only when a person confirms it; it advances the policy revision (docs/03 §3). */
  setFact(projectId: string, key: string, value: string, actor: Actor, causedBy?: string): void {
    requireHuman(actor, "Confirming a project fact");
    if (!/^[a-z][a-z0-9_]{0,40}$/.test(key) || !value.trim()) throw new ValidationError("project fact", ["key must be a lowercase identifier and value non-empty"]);
    tx(this.db, () => {
      const now = ts(this.clock.now());
      run(this.db, "INSERT INTO project_facts (project_id, key, value, confirmed_by, confirmed_at) VALUES (?,?,?,?,?) ON CONFLICT (project_id, key) DO UPDATE SET value = excluded.value, confirmed_by = excluded.confirmed_by, confirmed_at = excluded.confirmed_at",
        projectId, key, value.trim(), actor.id, now);
      const rev = this.rules.bumpPolicyRev(`project ${projectId} fact ${key} changed`);
      this.rules.reindexAll();
      this.ledger.append({
        type: "project.facts_changed", project_id: projectId, actor, subject: { kind: "project", id: projectId }, caused_by: [causedBy],
        summary: `${actor.display_name ?? actor.id} confirmed the project fact ${key}. Rules revision is now ${rev}.`, payload: { key, value: value.trim(), policy_rev: rev },
      });
    });
  }

  registerFolder(projectId: string, path: string, actor: Actor, bindingIdOverride?: string): string {
    requireHuman(actor, "Registering a folder");
    const canonical = resolvePath(path);
    return tx(this.db, () => {
      this.get(projectId);
      const clash = all<{ path: string; project_id: string }>(this.db, "SELECT path, project_id FROM folder_bindings").find((b) => b.path === canonical);
      if (clash) throw new ValidationError("folder", [`${canonical} is already registered`]);
      const bindingId = bindingIdOverride ?? this.ids("fld");
      run(this.db, "INSERT INTO folder_bindings (binding_id, workspace_id, project_id, path, created_at) VALUES (?,?,?,?,?)", bindingId, this.workspaceId, projectId, canonical, ts(this.clock.now()));
      this.ledger.append({
        type: "folder.registered", project_id: projectId, actor, subject: { kind: "folder", id: bindingId },
        summary: `${actor.display_name ?? actor.id} connected a folder to the project.`, payload: { path_digest: sha256(canonical), marker_written: false },
      });
      // Phase 2: write the `.correction-layer/<workspace_id>.json` marker (identifier only).
      return bindingId;
    });
  }

  get(projectId: string): Project {
    const row = get<any>(this.db, "SELECT * FROM projects WHERE project_id = ? AND workspace_id = ?", projectId, this.workspaceId);
    if (!row) throw new NotFound("project", projectId);
    const facts = Object.fromEntries(all<any>(this.db, "SELECT key, value FROM project_facts WHERE project_id = ? ORDER BY key", projectId).map((f) => [f.key, f.value]));
    const folders = all<any>(this.db, "SELECT binding_id, path FROM folder_bindings WHERE project_id = ? ORDER BY path", projectId);
    return { project_id: row.project_id, workspace_id: row.workspace_id, name: row.name, default_work_type: row.default_work_type, is_demo: !!row.is_demo, created_at: row.created_at, facts, folders };
  }

  list(): Project[] {
    return all<{ project_id: string }>(this.db, "SELECT project_id FROM projects WHERE workspace_id = ? ORDER BY created_at, project_id", this.workspaceId).map((r) => this.get(r.project_id));
  }

  projectOfBinding(bindingId: string): string | null {
    return get<any>(this.db, "SELECT project_id FROM folder_bindings WHERE binding_id = ? AND workspace_id = ?", bindingId, this.workspaceId)?.project_id ?? null;
  }

  // ------------------------------------------------------------ context resolution
  /**
   * Resolve "this file" to a context. `project_id` is a person's (or the app's)
   * explicit confirmation; `path` is resolved to its nearest registered ancestor.
   * Anything else is `unknown` - the caller must ask, and a gated action is blocked.
   */
  resolve(where: { project_id?: string | null; path?: string | null }): ResolvedContext {
    const unknown: ResolvedContext = { workspace_id: this.workspaceId, project_id: null, area_ids: [], work_type: "unclassified", status: "unknown", basis: [], facts: {} };
    let projectId: string | null = null;
    let basis: string[] = [];
    if (where.project_id) {
      if (!get(this.db, "SELECT 1 FROM projects WHERE project_id = ? AND workspace_id = ?", where.project_id, this.workspaceId)) return unknown;
      projectId = where.project_id;
      basis = ["confirmed_by_user"];
    } else if (where.path) {
      const canonical = resolvePath(where.path);
      const nearest = all<{ path: string; project_id: string }>(this.db, "SELECT path, project_id FROM folder_bindings WHERE workspace_id = ?", this.workspaceId)
        .filter((b) => canonical === b.path || canonical.startsWith(b.path + sep))
        .sort((a, b) => b.path.length - a.path.length)[0];
      if (!nearest) return unknown;
      projectId = nearest.project_id;
      basis = ["binding"];
    } else return unknown;
    const project = this.get(projectId);
    return { workspace_id: this.workspaceId, project_id: projectId, area_ids: [], work_type: project.default_work_type, status: "resolved", basis: [...basis, "default_work_type"], facts: project.facts };
  }

  /** Extension point: markers, moved and copied folders (docs/04 §3, §7; AT-C4 to AT-C8). */
  resolveByMarker(_folder: string): never {
    throw new NotImplementedYet("context.resolveByMarker", "folder markers, rebinding of moved folders and the copied-folder question");
  }

  // ------------------------------------------------------------ trusted sources
  /** Authority is a human designation (docs/03 §8): a named person vouches for the list. */
  registerSource(input: { source_id?: string; name: string; key_columns: string[]; value_columns: string[]; max_age_days: number }, actor: Actor): string {
    requireHuman(actor, "Registering a trusted source");
    return tx(this.db, () => {
      const sourceId = input.source_id ?? this.ids("src");
      run(this.db, "INSERT INTO sources (source_id, workspace_id, name, owner, record_json, created_at) VALUES (?,?,?,?,?,?)", sourceId, this.workspaceId, input.name, actor.id, json(input), ts(this.clock.now()));
      this.ledger.append({ type: "source.registered", project_id: null, actor, subject: { kind: "source", id: sourceId }, refs: { source_id: sourceId }, summary: `${actor.display_name ?? actor.id} registered the trusted source ${input.name}.`, payload: { key_columns: input.key_columns, value_columns: input.value_columns } });
      return sourceId;
    });
  }

  /** Import one immutable snapshot. Rows arrive already tabular; file parsing (CSV/XLSX) is a Phase 2 extension. */
  importSnapshot(sourceId: string, rows: SourceRow[], actor: Actor, snapshotId?: string): SourceSnapshot {
    requireHuman(actor, "Importing a trusted-source version");
    return tx(this.db, () => {
      if (!get(this.db, "SELECT 1 FROM sources WHERE source_id = ? AND workspace_id = ?", sourceId, this.workspaceId)) throw new NotFound("source", sourceId);
      const id = snapshotId ?? this.ids("snap");
      const now = ts(this.clock.now());
      const previous = this.latestSnapshot(sourceId);
      run(this.db, "INSERT INTO source_snapshots (snapshot_id, source_id, content_hash, imported_by, imported_at, confirmed_at, rows_json) VALUES (?,?,?,?,?,?,?)", id, sourceId, digestOf(rows), actor.id, now, now, json(rows));
      // A new snapshot can change what a source-backed rule decides: receipts that used the old one no longer validate.
      const rev = this.rules.bumpPolicyRev(`source ${sourceId} snapshot ${id} imported`);
      const imported = this.ledger.append({ type: "source.snapshot_imported", project_id: null, actor, subject: { kind: "snapshot", id }, refs: { source_id: sourceId, snapshot_id: id }, summary: `${actor.display_name ?? actor.id} imported a new version of a trusted source (${rows.length} rows).`, payload: { row_count: rows.length, policy_rev: rev } });
      if (previous) this.ledger.append({ type: "source.snapshot_superseded", project_id: null, actor: { kind: "system", id: "sys_SERVICE1" }, subject: { kind: "snapshot", id: previous.snapshot_id }, refs: { source_id: sourceId, snapshot_id: previous.snapshot_id }, caused_by: [imported.event_id], summary: "An earlier version of a trusted source was superseded." });
      return this.latestSnapshot(sourceId)!;
    });
  }

  latestSnapshot(sourceId: string): SourceSnapshot | null {
    const row = get<any>(this.db, "SELECT * FROM source_snapshots WHERE source_id = ? ORDER BY imported_at DESC, rowid DESC LIMIT 1", sourceId);
    return row ? { source_id: row.source_id, snapshot_id: row.snapshot_id, imported_at: row.imported_at, confirmed_at: row.confirmed_at, superseded: false, rows: parse<SourceRow[]>(row.rows_json) } : null;
  }

  listSources(): Array<{ source_id: string; name: string; owner: string; latest: SourceSnapshot | null }> {
    return all<any>(this.db, "SELECT source_id, name, owner FROM sources WHERE workspace_id = ? ORDER BY name", this.workspaceId).map((s) => ({ ...s, latest: this.latestSnapshot(s.source_id) }));
  }
}
