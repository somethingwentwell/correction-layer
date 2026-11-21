/**
 * Rule repository, lifecycle and deterministic scope selection.
 *
 * Invariants encoded here (not only in callers):
 *  - Rule revisions are immutable; "editing" inserts a revision.
 *  - A rule comes into force by exactly two paths: a person's individual approval,
 *    or a delegated-learning grant that this module re-verifies end to end
 *    (policy set by a person, scoped to the project, exact check kind, real
 *    failing and passing evidence, no blockers, no model confidence).
 *  - Retiring, rejecting, confirming are acts of a person. There is no operation by
 *    which a system or learning actor can pause, retire or weaken a rule.
 *  - In-scope rules are selected by an exact-or-any index lookup: complete,
 *    unranked, reproducible. No model, no similarity search (ADR-004).
 */
import { assertValid } from "../contracts/schemas.ts";
import { digestOf } from "../domain/canonical.ts";
import { InvariantViolation, NotFound, PermissionDenied, ValidationError } from "../domain/errors.ts";
import type { IdGen } from "../domain/ids.ts";
import { SYS } from "../domain/ids.ts";
import type { Clock } from "../domain/time.ts";
import { ts } from "../domain/time.ts";
import type {
  Actor, DecisionEvaluation, DecisionOutcome, DecisionSignal, LearningPolicy, Rule, RuleApproval, RuleAuthority, RuleCase, RuleRevisionContent, RuleStatus,
} from "../domain/types.ts";
import type { EngineRule } from "../engine/evaluate.ts";
import { rulesetDigest } from "../engine/evaluate.ts";
import { isProtectedTarget } from "../engine/fields.ts";
import type { Ledger, LedgerEvent } from "../ledger/ledger.ts";
import type { Db } from "../store/db.ts";
import { all, get, json, parse, run, tx } from "../store/db.ts";
import { CATALOGUE, isCheckKind, relate } from "./catalogue.ts";
import { predicateFields, predicateProblems } from "./predicate.ts";

export interface ScopeQuery {
  project_id: string;
  area_ids: string[];
  artifact_id: string | null;
  work_type: string;
  artifact_type: string;
  action: string;
}

export interface Selection {
  rules: EngineRule[];
  ruleset_digest: string;
  workspace_active_rules: number;
  in_scope: number;
  out_of_scope: number;
}

/** Everything a delegated activation rests on. Verified again inside `activateDelegated`. */
export interface DelegatedGrant {
  policy: LearningPolicy;
  decision: {
    decision_id: string;
    outcome: DecisionOutcome;
    reasons: string[];
    signals: DecisionSignal[];
    evaluation: DecisionEvaluation;
    /** Literal false: model confidence is never an input to activation. */
    model_confidence_used: false;
  };
  decision_event_id: string;
}

export function requireHuman(actor: Actor, act: string): void {
  if (actor.kind !== "human") throw new PermissionDenied(`${act} is done by a person in the app; ${actor.kind} actors cannot perform it`);
}

/** Semantic validation beyond the JSON Schema. Returns problems; empty means valid. */
export function ruleProblems(content: RuleRevisionContent): string[] {
  const out: string[] = [];
  if (!isCheckKind(content.check.kind)) return [`check.kind: "${String(content.check.kind)}" is not in the closed check catalogue`];
  const spec = CATALOGUE[content.check.kind];
  out.push(...spec.validateParams(content.check.params ?? {}, content.check.targets));
  if (content.method !== spec.method) out.push(`method: check kind ${spec.kind} is ${spec.method}, not ${content.method}`);
  // AT-E9: an AI opinion never blocks.
  if (content.method === "model_review" && content.enforcement !== "warn") out.push("enforcement: model_review rules can only be warn (an AI opinion never blocks)");
  if (content.method === "source_backed" && !content.source) out.push("source: a source-backed rule must name its trusted source");
  if (content.applies_when) out.push(...predicateProblems(content.applies_when));
  const s = content.scope;
  if (s.level === "project_group" && !s.project_selector) out.push("scope.project_selector: required for a project-group rule");
  if ((s.level === "project" || s.level === "area" || s.level === "artifact") && !s.project_id) out.push("scope.project_id: required at project, area and artifact level");
  if (s.level === "area" && !s.area_id) out.push("scope.area_id: required for an area rule");
  if (s.level === "artifact" && !s.artifact_id) out.push("scope.artifact_id: required for a single-document rule");
  if (s.level === "workspace" && (s.project_id || s.project_selector)) out.push("scope: a workspace rule names no project");
  return out;
}

export class RuleService {
  private db: Db;
  private ledger: Ledger;
  private clock: Clock;
  private ids: IdGen;
  private workspaceId: string;

  constructor(deps: { db: Db; ledger: Ledger; clock: Clock; ids: IdGen; workspaceId: string }) {
    this.db = deps.db;
    this.ledger = deps.ledger;
    this.clock = deps.clock;
    this.ids = deps.ids;
    this.workspaceId = deps.workspaceId;
  }

  // ------------------------------------------------------------ policy revision
  policyRev(): number {
    return get<{ v: number }>(this.db, "SELECT COALESCE(MAX(policy_rev), 0) AS v FROM policy_revisions")!.v;
  }

  /** Advance the workspace policy revision: anything that can change which rules apply, or how. */
  bumpPolicyRev(reason: string): number {
    const next = this.policyRev() + 1;
    run(this.db, "INSERT INTO policy_revisions (policy_rev, workspace_id, reason, created_at) VALUES (?, ?, ?, ?)", next, this.workspaceId, reason, ts(this.clock.now()));
    return next;
  }

  // ------------------------------------------------------------ reads
  private hydrate(row: any): Rule {
    const content = parse<RuleRevisionContent>(row.content_json);
    content.cases = this.casesOf(content.rule_id);
    return { ...content, status: row.status as RuleStatus, ...(row.authority_json ? { authority: parse<RuleAuthority>(row.authority_json) } : {}), approval: parse<RuleApproval | null>(row.approval_json) };
  }

  private static readonly SELECT = "SELECT r.content_json, r.content_digest, s.status, s.authority_json, s.approval_json FROM rule_state s JOIN rule_revisions r ON r.rule_id = s.rule_id AND r.revision = s.current_revision";

  /** Examples live beside the immutable revision so real evidence can be attached when it arrives. */
  casesOf(ruleId: string): RuleCase[] {
    return all<any>(this.db, "SELECT case_id, kind, description, artifact_hash, expect, last_result, last_run_at FROM rule_cases WHERE rule_id = ? ORDER BY rowid", ruleId)
      .map((c) => ({ case_id: c.case_id, kind: c.kind, description: c.description, artifact_hash: c.artifact_hash, expect: c.expect, ...(c.last_result ? { last_result: c.last_result, last_run_at: c.last_run_at } : {}) }));
  }

  /**
   * Attach a stored example. Adding evidence never changes what a rule requires, so
   * it is allowed at any point before retirement; it is idempotent per artifact hash.
   */
  addCase(ruleId: string, c: Omit<RuleCase, "case_id">): void {
    const rule = this.get(ruleId);
    if (rule.status === "retired" || rule.status === "rejected") throw new InvariantViolation("rule_lifecycle", `a ${rule.status} rule takes no new examples`);
    run(this.db, "INSERT INTO rule_cases (case_id, rule_id, kind, description, artifact_hash, expect, last_result, last_run_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT (rule_id, kind, artifact_hash) DO UPDATE SET last_result = excluded.last_result, last_run_at = excluded.last_run_at",
      this.ids("case"), ruleId, c.kind, c.description, c.artifact_hash, c.expect, c.last_result ?? null, c.last_run_at ?? null);
  }

  get(ruleId: string): Rule {
    const row = get(this.db, `${RuleService.SELECT} WHERE s.rule_id = ?`, ruleId);
    if (!row) throw new NotFound("rule", ruleId);
    return this.hydrate(row);
  }

  listAll(): Rule[] {
    return all(this.db, `${RuleService.SELECT} ORDER BY s.rule_id`).map((r) => this.hydrate(r));
  }

  /**
   * Rules a project may see: rules scoped to it, plus wider rules that reach it.
   * Rules scoped only to another project are never returned (project isolation).
   */
  listForProject(projectId: string): Rule[] {
    return all(this.db, `${RuleService.SELECT} WHERE s.project_id = ? OR s.rule_id IN (SELECT rule_id FROM rule_scope_index WHERE project_key IN (?, '*')) OR (s.project_id IS NULL AND s.status NOT IN ('active','trial')) ORDER BY s.rule_id`, projectId, projectId)
      .map((r) => this.hydrate(r))
      .filter((r) => r.scope.level === "workspace" || r.scope.project_id === projectId
        || (r.scope.level === "project_group" && !!get(this.db, "SELECT 1 FROM project_facts WHERE project_id = ? AND key = ? AND value = ?", projectId, r.scope.project_selector!.fact, r.scope.project_selector!.equals)));
  }

  // ------------------------------------------------------------ writes
  validateContent(content: RuleRevisionContent): void {
    assertValid("rule", { ...content, status: "candidate" }, "rule");
    if (content.scope.workspace_id !== this.workspaceId) throw new ValidationError("rule", ["scope.workspace_id: belongs to another workspace"]);
    const found = ruleProblems(content);
    if (found.length) throw new ValidationError("rule", found);
  }

  /** Save an inactive candidate. Anyone may propose; nothing is in force until a later, separate act. */
  createCandidate(content: RuleRevisionContent, actor: Actor, opts: { caused_by?: Array<string | null | undefined>; proposed_by?: string } = {}): { rule: Rule; event: LedgerEvent } {
    this.validateContent(content);
    return tx(this.db, () => {
      if (get(this.db, "SELECT 1 FROM rule_revisions WHERE rule_id = ? AND revision = ?", content.rule_id, content.revision)) {
        throw new InvariantViolation("immutable_revision", `rule ${content.rule_id} revision ${content.revision} already exists; revisions are never rewritten`);
      }
      const now = ts(this.clock.now());
      const projectId = content.scope.level === "workspace" || content.scope.level === "project_group" ? null : content.scope.project_id!;
      run(this.db, "INSERT INTO rule_revisions (rule_id, revision, workspace_id, content_json, content_digest, created_at) VALUES (?,?,?,?,?,?)",
        content.rule_id, content.revision, this.workspaceId, json({ ...content, cases: [] }), digestOf({ ...content, cases: [] }), now);
      for (const c of content.cases) {
        run(this.db, "INSERT INTO rule_cases (case_id, rule_id, kind, description, artifact_hash, expect, last_result, last_run_at) VALUES (?,?,?,?,?,?,?,?)",
          c.case_id, content.rule_id, c.kind, c.description, c.artifact_hash, c.expect, c.last_result ?? null, c.last_run_at ?? null);
      }
      run(this.db, "INSERT INTO rule_state (rule_id, workspace_id, project_id, current_revision, status, updated_at) VALUES (?,?,?,?, 'candidate', ?)",
        content.rule_id, this.workspaceId, projectId, content.revision, now);
      const event = this.ledger.append({
        type: "rule.candidate_created", project_id: projectId, actor, subject: { kind: "rule", id: content.rule_id },
        refs: { rule_id: content.rule_id, rule_revision: content.revision, correction_id: content.origin.correction_id }, caused_by: opts.caused_by,
        summary: `Candidate rule saved (inactive): ${content.title}.`,
        payload: { proposed_by: opts.proposed_by ?? actor.kind, check_kind: content.check.kind, scope_level: content.scope.level, status: "candidate" },
        classification: "rule_text",
      });
      return { rule: this.get(content.rule_id), event };
    });
  }

  private setState(ruleId: string, status: RuleStatus, fields: { authority?: RuleAuthority; approval?: RuleApproval; activated_at?: string } = {}): void {
    const now = ts(this.clock.now());
    run(this.db, "UPDATE rule_state SET status = ?, authority_json = COALESCE(?, authority_json), approval_json = COALESCE(?, approval_json), activated_at = COALESCE(?, activated_at), updated_at = ? WHERE rule_id = ?",
      status, fields.authority ? json(fields.authority) : null, fields.approval ? json(fields.approval) : null, fields.activated_at ?? null, now, ruleId);
    this.reindex(ruleId);
  }

  /** Rebuild the scope-index rows of one rule from its current revision and status. */
  reindex(ruleId: string): void {
    run(this.db, "DELETE FROM rule_scope_index WHERE rule_id = ?", ruleId);
    const rule = this.get(ruleId);
    if (rule.status !== "active" && rule.status !== "trial") return;
    const s = rule.scope;
    let projects: string[];
    if (s.level === "workspace") projects = ["*"];
    else if (s.level === "project_group") {
      projects = all<{ project_id: string }>(this.db, "SELECT f.project_id FROM project_facts f JOIN projects p ON p.project_id = f.project_id WHERE p.workspace_id = ? AND f.key = ? AND f.value = ?", this.workspaceId, s.project_selector!.fact, s.project_selector!.equals).map((r) => r.project_id);
    } else projects = [s.project_id!];
    const anyOr = (list: string[]): string[] => (list.length ? list : ["*"]);
    for (const project of projects) for (const workType of anyOr(s.work_types)) for (const artifactType of anyOr(s.artifact_types)) for (const action of anyOr(s.actions)) {
      run(this.db, "INSERT INTO rule_scope_index (rule_id, revision, workspace_id, project_key, area_key, artifact_key, work_type, artifact_type, action, status) VALUES (?,?,?,?,?,?,?,?,?,?)",
        rule.rule_id, rule.revision, this.workspaceId, project, s.level === "area" ? s.area_id! : "*", s.level === "artifact" ? s.artifact_id! : "*", workType, artifactType, action, rule.status);
    }
  }

  /** Re-resolve project-group selectors after a project's facts changed (a policy-revision event). */
  reindexAll(): void {
    for (const r of all<{ rule_id: string }>(this.db, "SELECT rule_id FROM rule_state WHERE status IN ('active','trial')")) this.reindex(r.rule_id);
  }

  /**
   * PATH 1 - individual approval by a person (docs/03 §6 step 8).
   * A must-pass rule needs a blocking and an allowing example (ADR-010); without
   * them it can only be approved on trial, where it is a note.
   */
  approveAndActivate(ruleId: string, actor: Actor, opts: { trial?: boolean } = {}): Rule {
    requireHuman(actor, "Approving a rule");
    return tx(this.db, () => {
      const rule = this.get(ruleId);
      if (rule.status !== "candidate" && rule.status !== "trial") throw new InvariantViolation("rule_lifecycle", `a ${rule.status} rule cannot be approved`);
      const target: RuleStatus = opts.trial ? "trial" : "active";
      const hasExamples = rule.cases.some((c) => c.kind === "negative") && rule.cases.some((c) => c.kind === "positive");
      if (target === "active" && rule.enforcement === "block" && !hasExamples) {
        throw new InvariantViolation("examples_before_approval", "a must-pass rule needs one example it blocks and one it allows before it can be turned on; approve it on trial instead");
      }
      const now = ts(this.clock.now());
      const approved = this.ledger.append({
        type: "rule.approved", project_id: this.projectOf(rule), actor, subject: { kind: "rule", id: ruleId }, refs: { rule_id: ruleId, rule_revision: rule.revision },
        caused_by: this.lastEventId(ruleId), summary: `${actor.display_name ?? actor.id} approved: ${rule.title}.`,
        payload: { status: target, self_approval: rule.owner === actor.id }, classification: "rule_text",
      });
      const rev = this.bumpPolicyRev(`rule ${ruleId} ${target}`);
      this.setState(ruleId, target, {
        authority: { kind: "individual_approval", zero_click: false },
        approval: { proposed_by: rule.owner, approved_by: actor.id, approved_at: now, activated_at: now, self_approval: rule.owner === actor.id, policy_rev: rev },
        activated_at: now,
      });
      this.ledger.append({
        type: "rule.activated", project_id: this.projectOf(rule), actor: { kind: "system", id: SYS.service, on_behalf_of: actor.id }, subject: { kind: "rule", id: ruleId },
        refs: { rule_id: ruleId, rule_revision: rule.revision }, caused_by: [approved.event_id],
        summary: `Rule turned on${target === "trial" ? " on trial (note only)" : ""}: ${rule.title}. Rules revision is now ${rev}.`,
        payload: { status: target, authority: "individual_approval", policy_rev: rev }, classification: "rule_text",
      });
      return this.get(ruleId);
    });
  }

  /**
   * PATH 2 - delegated learning (docs/12 §7). Called only by the learning pipeline,
   * and it does not trust its caller: every condition the authority rests on is
   * checked again here against stored records.
   */
  activateDelegated(ruleId: string, grant: DelegatedGrant): Rule {
    return tx(this.db, () => {
      const rule = this.get(ruleId);
      const refuse = (why: string): never => {
        throw new InvariantViolation("delegated_activation", why);
      };
      const { policy, decision } = grant;
      const stored = get<{ content_json: string }>(this.db, "SELECT content_json FROM learning_policies WHERE learning_policy_id = ? AND revision = ?", policy.learning_policy_id, policy.revision);
      const latest = get<{ revision: number }>(this.db, "SELECT MAX(revision) AS revision FROM learning_policies WHERE project_id = ?", policy.scope.project_id);
      if (!stored || digestOf(parse(stored.content_json)) !== digestOf(policy)) refuse("the learning policy is not the one a person saved");
      if (latest?.revision !== policy.revision) refuse("the learning policy has been replaced by a newer setting");
      if (policy.set_by.kind !== "human") refuse("a learning policy must be set by a person");
      if (policy.revoked) refuse("the learning policy was turned off");
      if (rule.status !== "candidate") refuse(`only a candidate can be activated; this rule is ${rule.status}`);
      const blocking = decision.outcome === "auto_activate";
      if (!blocking && decision.outcome !== "auto_shadow" && decision.outcome !== "shadow_and_inbox") refuse(`outcome ${decision.outcome} does not activate anything`);
      if (blocking && policy.mode !== "auto_low_risk") refuse("blocking activation needs the mode 'learn and enforce'");
      if (!blocking && policy.mode !== "quiet" && policy.mode !== "auto_low_risk") refuse(`mode ${policy.mode} does not turn rules on`);
      if (decision.model_confidence_used !== false) refuse("model confidence can never be an input");
      if (blocking && decision.reasons.length) refuse("an automatic activation cannot have blockers");
      if (decision.outcome === "auto_shadow" && decision.reasons.length) refuse("an automatic shadow activation cannot have blockers");
      // Low-risk conditions L1-L5, re-derived from the stored rule itself.
      const s = rule.scope;
      if (!["project", "area", "artifact"].includes(s.level) || s.project_id !== policy.scope.project_id) refuse("a learned rule is never wider than the policy's project");
      if (rule.locked) refuse("a learned rule cannot be locked");
      if (rule.method === "model_review" || !policy.auto.methods.includes(rule.method) || !policy.auto.check_kinds.includes(rule.check.kind)) refuse("this kind of rule is not delegated by the policy");
      if ([...rule.check.targets, ...rule.requires.fields, ...predicateFields(rule.applies_when)].some(isProtectedTarget)) refuse("a learned rule cannot read action parameters or context");
      if (rule.enforcement === "block" && policy.auto.enforcement_max !== "block" && blocking) refuse("the policy does not delegate blocking rules");
      // Real evidence: the corrected draft must fail, a real corrected version must pass.
      const ev = decision.evaluation;
      if (!ev.trigger_case || ev.trigger_case.result !== "fail") refuse("the rule does not catch the work that was corrected");
      const passes = ev.real_passing_cases.filter((c) => c.result === "pass");
      if (passes.length < policy.limits.min_real_pass) refuse("there is no real passing example");
      if (!rule.cases.some((c) => c.kind === "negative" && c.artifact_hash === ev.trigger_case!.artifact_hash)) refuse("the rule does not record its real blocking example");
      if (!rule.cases.some((c) => c.kind === "positive" && passes.some((p) => p.artifact_hash === c.artifact_hash))) refuse("the rule does not record its real allowing example");
      if (ev.generated.counted_as_support !== false) refuse("generated variants can never count as support");
      if (blocking) {
        if (ev.heldout.fail > policy.limits.max_heldout_failures || ev.heldout.unknown + ev.heldout.error > 0) refuse("the rule flags or cannot decide existing work");
        if (ev.conflicts.length || ev.duplicates.length || ev.contradicts_learned.length) refuse("the rule duplicates, conflicts with or contradicts a rule in scope");
        if (!decision.signals.some((sig) => sig.trust === "user_direct" && sig.author_id !== null && policy.learn_from.includes(sig.author_id))) refuse("no direct statement by a listed person");
      }
      if (decision.signals.some((sig) => (sig.trust as string) === "untrusted_content")) refuse("untrusted content is evidence, not instructions");

      const now = ts(this.clock.now());
      const target: RuleStatus = blocking ? "active" : "trial";
      const rev = this.bumpPolicyRev(`rule ${ruleId} ${target} under learning policy ${policy.learning_policy_id}`);
      this.setState(ruleId, target, {
        authority: {
          kind: "delegated_learning", zero_click: true, learning_policy_id: policy.learning_policy_id, learning_policy_revision: policy.revision,
          decision_id: decision.decision_id, delegated_by: policy.set_by.id, confirmed: null, auto_paused: null,
        },
        activated_at: now,
      });
      this.ledger.append({
        type: "rule.activated", project_id: s.project_id!, actor: { kind: "system", id: SYS.learning, on_behalf_of: policy.set_by.id }, subject: { kind: "rule", id: ruleId },
        refs: { rule_id: ruleId, rule_revision: rule.revision, decision_id: decision.decision_id, learning_policy_id: policy.learning_policy_id },
        caused_by: [grant.decision_event_id],
        summary: `Rule turned on automatically${blocking ? "" : " as a note only"}, this project only: ${rule.title}. Rules revision is now ${rev}. No person clicked.`,
        payload: { status: target, authority: "delegated_learning", zero_click: true, policy_rev: rev }, classification: "rule_text",
      });
      return this.get(ruleId);
    });
  }

  /** Undo / retire. Only a person retires a rule; retirement is never automatic. */
  retire(ruleId: string, actor: Actor, reason: string): Rule {
    requireHuman(actor, "Retiring a rule");
    return tx(this.db, () => {
      const rule = this.get(ruleId);
      if (rule.status === "retired" || rule.status === "rejected") throw new InvariantViolation("rule_lifecycle", `the rule is already ${rule.status}`);
      const rev = this.bumpPolicyRev(`rule ${ruleId} retired`);
      this.ledger.append({
        type: "rule.retired", project_id: this.projectOf(rule), actor, subject: { kind: "rule", id: ruleId }, refs: { rule_id: ruleId, rule_revision: rule.revision },
        caused_by: this.lastEventId(ruleId), summary: `${actor.display_name ?? actor.id} retired: ${rule.title} (${reason}). Rules revision is now ${rev}.`,
        payload: { reason, previous_status: rule.status, policy_rev: rev }, classification: "rule_text",
      });
      this.setState(ruleId, "retired");
      return this.get(ruleId);
    });
  }

  reject(ruleId: string, actor: Actor, reason: string): Rule {
    requireHuman(actor, "Rejecting a candidate");
    return tx(this.db, () => {
      const rule = this.get(ruleId);
      if (rule.status !== "candidate") throw new InvariantViolation("rule_lifecycle", "only a candidate can be rejected");
      this.ledger.append({
        type: "rule.rejected", project_id: this.projectOf(rule), actor, subject: { kind: "rule", id: ruleId }, refs: { rule_id: ruleId, rule_revision: rule.revision },
        caused_by: this.lastEventId(ruleId), summary: `${actor.display_name ?? actor.id} rejected the candidate: ${rule.title}.`, payload: { reason }, classification: "rule_text",
      });
      this.setState(ruleId, "rejected");
      return this.get(ruleId);
    });
  }

  /** Keep: a person makes a learned rule their own. Its learned origin stays in history. */
  confirm(ruleId: string, actor: Actor): Rule {
    requireHuman(actor, "Keeping a learned rule");
    return tx(this.db, () => {
      const rule = this.get(ruleId);
      if (rule.authority?.kind !== "delegated_learning") throw new InvariantViolation("rule_lifecycle", "only a rule that was added automatically can be kept");
      if (rule.status !== "active" && rule.status !== "trial") throw new InvariantViolation("rule_lifecycle", `a ${rule.status} rule cannot be kept`);
      const now = ts(this.clock.now());
      this.ledger.append({
        type: "rule.confirmed", project_id: this.projectOf(rule), actor, subject: { kind: "rule", id: ruleId }, refs: { rule_id: ruleId, rule_revision: rule.revision },
        caused_by: this.lastEventId(ruleId), summary: `${actor.display_name ?? actor.id} kept the learned rule: ${rule.title}. It is now person-approved.`,
        payload: { previous_authority: "delegated_learning" }, classification: "rule_text",
      });
      this.setState(ruleId, rule.status, {
        authority: { kind: "individual_approval", zero_click: false, confirmed: { by: actor.id, at: now } },
        approval: { approved_by: actor.id, approved_at: now, self_approval: rule.owner === actor.id, policy_rev: this.policyRev() },
      });
      return this.get(ruleId);
    });
  }

  private projectOf(rule: Rule): string | null {
    return rule.scope.level === "workspace" || rule.scope.level === "project_group" ? null : (rule.scope.project_id ?? null);
  }

  private lastEventId(ruleId: string): string[] {
    const last = this.ledger.byRef("rule_id", ruleId).at(-1);
    return last ? [last.event_id] : [];
  }

  // ------------------------------------------------------------ deterministic selection
  /**
   * The complete in-scope set for a context: one indexed, exact-or-any query per
   * dimension. No ranking, no top-k, no embedding, no model (docs/03 §10.1).
   */
  selectInScope(q: ScopeQuery): Selection {
    const areas = [...q.area_ids, "*"];
    const rows = all<{ rule_id: string; revision: number; status: RuleStatus; content_json: string; content_digest: string }>(this.db, `
      SELECT DISTINCT i.rule_id, i.revision, i.status, r.content_json, r.content_digest
      FROM rule_scope_index i JOIN rule_revisions r ON r.rule_id = i.rule_id AND r.revision = i.revision
      WHERE i.workspace_id = ?
        AND i.project_key   IN (?, '*')
        AND i.area_key      IN (${areas.map(() => "?").join(",")})
        AND i.artifact_key  IN (?, '*')
        AND i.work_type     IN (?, '*')
        AND i.artifact_type IN (?, '*')
        AND i.action        IN (?, '*')
        AND i.status        IN ('active', 'trial')
      ORDER BY i.rule_id`, this.workspaceId, q.project_id, ...areas, q.artifact_id ?? "", q.work_type, q.artifact_type, q.action);
    const rules: EngineRule[] = rows.map((r) => ({ content: parse<RuleRevisionContent>(r.content_json), status: r.status, content_digest: r.content_digest }));
    const active = get<{ n: number }>(this.db, "SELECT COUNT(*) AS n FROM rule_state WHERE workspace_id = ? AND status IN ('active','trial')", this.workspaceId)!.n;
    return { rules, ruleset_digest: rulesetDigest(rules.map((r) => r.content)), workspace_active_rules: active, in_scope: rules.length, out_of_scope: active - rules.length };
  }

  /**
   * The "not in scope" inventory (docs/02 §6, AT-G3): every other active rule with
   * the dimension that excluded it. For rules of other projects only the dimension
   * is given - never their text (project isolation).
   */
  outOfScope(q: ScopeQuery): Array<{ rule_id: string; excluded_by: string; visible: boolean }> {
    const inScope = new Set(this.selectInScope(q).rules.map((r) => r.content.rule_id));
    const out: Array<{ rule_id: string; excluded_by: string; visible: boolean }> = [];
    for (const rule of this.listAll()) {
      if ((rule.status !== "active" && rule.status !== "trial") || inScope.has(rule.rule_id)) continue;
      const s = rule.scope;
      let excluded = "project";
      const projectMatches = s.level === "workspace" || (s.level !== "project_group" && s.project_id === q.project_id)
        || (s.level === "project_group" && !!get(this.db, "SELECT 1 FROM project_facts WHERE project_id = ? AND key = ? AND value = ?", q.project_id, s.project_selector!.fact, s.project_selector!.equals));
      if (projectMatches) {
        if (s.level === "area" && !q.area_ids.includes(s.area_id!)) excluded = "area";
        else if (s.level === "artifact" && s.artifact_id !== q.artifact_id) excluded = "artifact";
        else if (s.work_types.length && !s.work_types.includes(q.work_type)) excluded = "work_type";
        else if (s.artifact_types.length && !(s.artifact_types as string[]).includes(q.artifact_type)) excluded = "artifact_type";
        else excluded = "action";
      }
      out.push({ rule_id: rule.rule_id, excluded_by: excluded, visible: projectMatches });
    }
    return out;
  }

  /** Static duplicate / conflict analysis of a candidate against rules that reach its project. */
  analyse(candidate: RuleRevisionContent): { duplicates: string[]; conflicts: string[]; contradicts_learned: string[] } {
    const out = { duplicates: [] as string[], conflicts: [] as string[], contradicts_learned: [] as string[] };
    const projectId = candidate.scope.project_id;
    const others = (projectId ? this.listForProject(projectId) : this.listAll()).filter((r) => r.rule_id !== candidate.rule_id && (r.status === "active" || r.status === "trial"));
    for (const other of others) {
      const relation = relate(candidate, other);
      if (relation === "duplicate") out.duplicates.push(other.rule_id);
      else if (relation === "conflict") {
        // Contradicting an unconfirmed learned rule is its own, softer category (docs/12 §9).
        if (other.authority?.kind === "delegated_learning" && !other.authority.confirmed) out.contradicts_learned.push(other.rule_id);
        else out.conflicts.push(other.rule_id);
      }
    }
    return out;
  }
}
