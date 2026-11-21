/**
 * Learning policies (docs/12 §2, §8): a person's standing, revocable decision about
 * what may be noticed and what may turn on by itself in ONE project. Default: Off.
 *
 * Authority is given once, by a person, in the app. No client operation can set or
 * change a policy. Revisions are insert-only; turning learning off is a new revision.
 *
 * Phase 1 hard caps (stricter than the schema allows, on purpose): automatic rules
 * are `deterministic` only, exact check kinds only, and never wider than a project.
 */
import { assertValid } from "../contracts/schemas.ts";
import { ValidationError } from "../domain/errors.ts";
import type { IdGen } from "../domain/ids.ts";
import type { Clock } from "../domain/time.ts";
import { ts } from "../domain/time.ts";
import type { Actor, CheckKind, LearningMode, LearningPolicy, Surface } from "../domain/types.ts";
import type { ProjectService } from "../context/projects.ts";
import type { Ledger } from "../ledger/ledger.ts";
import { requireHuman } from "../policy/rules.ts";
import type { Db } from "../store/db.ts";
import { get, json, parse, run, tx } from "../store/db.ts";

/** docs/12 §7.1 L3: exact checks only. */
export const DELEGABLE_KINDS: readonly CheckKind[] = Object.freeze([
  "field_present", "field_in_set", "fields_agree", "number_compare", "date_window", "section_present", "no_unresolved_markup", "text_contains",
]);

export const NEVER_LEARNED = Object.freeze([
  "pausing, retiring or narrowing any rule", "exceptions", "approval policies and who may approve", "roles and permissions",
  "action adapters, recipients and coverage", "trusted-source designation and freshness windows", "anything wider than this policy's scope",
  "rules whose only support is an AI model's judgment",
]);

/** Surface ceilings from docs/12 §4. A relay can reach the inbox at most; an observed edit, shadow. */
export const SURFACE_CEILING: Readonly<Record<Surface, "auto" | "shadow" | "inbox">> = Object.freeze({
  app: "auto", attested_user_turn: "auto", review_action: "auto", folder_watch: "shadow", assistant_relay: "inbox",
});
const RANK = { inbox: 0, shadow: 1, auto: 2 } as const;

export interface PolicyInput {
  project_id: string;
  mode: LearningMode;
  learn_from: string[];
  /** Surfaces switched on. Each keeps its ceiling; a ceiling can be lowered, never raised. */
  surfaces?: Array<{ surface: Surface; enabled: boolean; adapter_id?: string; max_outcome?: "auto" | "shadow" | "inbox" }>;
  limits?: Partial<LearningPolicy["limits"]>;
}

export class LearningPolicyService {
  private db: Db;
  private ledger: Ledger;
  private clock: Clock;
  private ids: IdGen;
  private projects: ProjectService;
  private workspaceId: string;
  private displayTz: string;

  constructor(deps: { db: Db; ledger: Ledger; clock: Clock; ids: IdGen; projects: ProjectService; workspaceId: string; displayTz: string }) {
    this.db = deps.db;
    this.ledger = deps.ledger;
    this.clock = deps.clock;
    this.ids = deps.ids;
    this.projects = deps.projects;
    this.workspaceId = deps.workspaceId;
    this.displayTz = deps.displayTz;
  }

  /** The policy in force for a project, or null (which means Off: nothing is captured for learning). */
  current(projectId: string): LearningPolicy | null {
    const row = get<{ content_json: string }>(this.db, "SELECT content_json FROM learning_policies WHERE project_id = ? ORDER BY revision DESC LIMIT 1", projectId);
    return row ? parse<LearningPolicy>(row.content_json) : null;
  }

  /** Consent is per project and per surface, and it is checked by the intake (docs/12 §12). */
  consents(projectId: string | null, surface: Surface): boolean {
    if (!projectId) return false;
    const policy = this.current(projectId);
    if (!policy || policy.mode === "off" || policy.revoked) return false;
    return policy.surfaces.some((s) => s.surface === surface && s.enabled);
  }

  set(input: PolicyInput, actor: Actor): LearningPolicy {
    requireHuman(actor, "Setting a learning policy");
    const project = this.projects.get(input.project_id);
    const problems: string[] = [];
    const before = this.current(project.project_id);
    // Turning learning off needs no list of people; the record keeps who was listed before.
    const learnFrom = input.learn_from.length || input.mode !== "off" ? input.learn_from : (before?.learn_from ?? [actor.id]);
    if (!learnFrom.length) problems.push("learn_from: name at least one person whose corrections count");
    for (const person of learnFrom) {
      if (!get(this.db, "SELECT 1 FROM principals WHERE principal_id = ? AND kind = 'human'", person)) problems.push(`learn_from: ${person} is not a person in this workspace`);
    }
    const requested: NonNullable<PolicyInput["surfaces"]> = input.surfaces ?? (Object.keys(SURFACE_CEILING) as Surface[]).map((surface) => ({ surface, enabled: true }));
    const surfaces = requested.map((s) => {
      const ceiling = SURFACE_CEILING[s.surface];
      if (!ceiling) problems.push(`surfaces: ${String(s.surface)} is not a surface this build knows`);
      const wanted = s.max_outcome ?? ceiling;
      if (ceiling && RANK[wanted] > RANK[ceiling]) problems.push(`surfaces: ${s.surface} can lead to "${ceiling}" at most`);
      return { surface: s.surface, enabled: s.enabled, ...(s.adapter_id ? { adapter_id: s.adapter_id } : {}), max_outcome: wanted };
    });
    if (problems.length) throw new ValidationError("learning policy", problems);
    return tx(this.db, () => {
      const previous = this.current(project.project_id);
      const now = ts(this.clock.now());
      const policy: LearningPolicy = {
        schema_version: "cl.learning_policy/1",
        learning_policy_id: previous?.learning_policy_id ?? this.ids("lrn"),
        revision: (previous?.revision ?? 0) + 1,
        workspace_id: this.workspaceId,
        scope: { level: "project", project_id: project.project_id, area_id: null },
        mode: input.mode,
        set_by: actor,
        set_at: now,
        display_tz: this.displayTz,
        surfaces,
        learn_from: learnFrom,
        inbox_resolvers: learnFrom,
        auto: { max_scope_level: "project", check_kinds: [...DELEGABLE_KINDS], methods: ["deterministic"], enforcement_max: "block" },
        limits: {
          calibration: "proposed_uncalibrated", recurrence_min_episodes: 3, min_real_pass: 1, max_heldout_failures: 0, max_auto_activations_per_day: 3,
          candidate_expiry_days: 30, learned_rule_review_days: 90, ...input.limits,
        },
        auto_pause: { enabled: true, on_direct_contradiction: true, disputes_distinct_artifacts: 2, on_example_regression: true, on_conflict_with_approved_rule: true },
        capture: { calibration: "proposed_uncalibrated", late_after_hours: 24, gap_timeout_seconds: 60, non_signal_review_days: 14, dead_letter_days: 7, backfill_max_outcome: "inbox" },
        never_learned: [...NEVER_LEARNED],
        retention: { signal_text_days: 400, one_off_episode_days: 90 },
        revoked: input.mode === "off" && previous && previous.mode !== "off" ? { by: actor.id, at: now, learned_rules: "keep" } : null,
      };
      assertValid("learning-policy", policy, "learning policy");
      run(this.db, "INSERT INTO learning_policies (learning_policy_id, revision, workspace_id, project_id, mode, set_by, set_at, content_json) VALUES (?,?,?,?,?,?,?,?)",
        policy.learning_policy_id, policy.revision, this.workspaceId, project.project_id, policy.mode, actor.id, now, json(policy));
      const words: Record<LearningMode, string> = { off: "Off", suggest: "Suggest", quiet: "Learn quietly", auto_low_risk: "Learn and enforce" };
      this.ledger.append({
        type: policy.revoked ? "learning.policy_revoked" : "learning.policy_set", project_id: project.project_id, actor, subject: { kind: "learning_policy", id: policy.learning_policy_id },
        refs: { learning_policy_id: policy.learning_policy_id }, summary: `${actor.display_name ?? actor.id} set learning for this project to "${words[policy.mode]}".`,
        payload: { revision: policy.revision, mode: policy.mode, learn_from: policy.learn_from, surfaces: surfaces.filter((s) => s.enabled).map((s) => s.surface), learned_rules: policy.revoked ? "keep" : null },
      });
      return policy;
    });
  }
}
