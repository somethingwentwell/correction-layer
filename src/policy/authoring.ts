/**
 * Adding and changing corrections by hand (UX-7a to 7c): a person picks a plain
 * template, a scope from plain options and the consequence; the product renders
 * the rule sentence, shows rules that already ask for the same thing or cannot
 * both be met (BEFORE anything is created, AT-G4), dry-runs the rule on the
 * project's real documents, and lets the person attach a real blocking and a real
 * allowing example. Turning it on is a separate act (`RuleService.approveAndActivate`).
 *
 * Nothing here activates a rule, edits a document or reads a file from disk.
 */
import { Conflict, InvariantViolation, NotFound, ValidationError } from "../domain/errors.ts";
import type { IdGen } from "../domain/ids.ts";
import type { Clock } from "../domain/time.ts";
import { addDays, ts } from "../domain/time.ts";
import type { Actor, Enforcement, Outcome, Rule, RuleRevisionContent } from "../domain/types.ts";
import type { ProjectService } from "../context/projects.ts";
import type { Ledger } from "../ledger/ledger.ts";
import type { Db } from "../store/db.ts";
import { get, json, parse, run, tx } from "../store/db.ts";
import type { CheckService } from "../work/check.ts";
import { ruleProblems, requireHuman } from "./rules.ts";
import type { RuleService } from "./rules.ts";
import type { TemplateInput } from "./templates.ts";
import { buildRequirement, scopeFor, templateInput, templateOf } from "./templates.ts";

export interface DraftInput {
  project_id: string;
  /** Loose form values: `template` plus its fields (see templates.ts). */
  template: Record<string, unknown>;
  /** Scope option: absent = this project; an artifact id = only that document. */
  artifact_id?: string | null;
  enforcement?: Enforcement;
  /** The person's own words, kept as the original correction (optional). */
  words?: string;
}

export interface RuleSummary {
  rule_id: string;
  title: string;
  statement: string;
  status: string;
}

export interface Preview {
  content: RuleRevisionContent;
  problems: string[];
  notes: string[];
  duplicates: RuleSummary[];
  conflicts: RuleSummary[];
  dry_run: ReturnType<CheckService["dryRun"]>;
}

export class RuleAuthoring {
  private db: Db;
  private ledger: Ledger;
  private clock: Clock;
  private ids: IdGen;
  private rules: RuleService;
  private projects: ProjectService;
  private checks: CheckService;
  private workspaceId: string;

  constructor(deps: { db: Db; ledger: Ledger; clock: Clock; ids: IdGen; rules: RuleService; projects: ProjectService; checks: CheckService; workspaceId: string }) {
    this.db = deps.db;
    this.ledger = deps.ledger;
    this.clock = deps.clock;
    this.ids = deps.ids;
    this.rules = deps.rules;
    this.projects = deps.projects;
    this.checks = deps.checks;
    this.workspaceId = deps.workspaceId;
  }

  private draft(input: DraftInput, ruleId: string): { content: RuleRevisionContent; notes: string[] } {
    const project = this.projects.get(input.project_id);
    const t: TemplateInput = templateInput(input.template);
    const notes: string[] = [];
    if (input.artifact_id) {
      const a = get<{ project_id: string }>(this.db, "SELECT project_id FROM artifacts WHERE artifact_id = ?", input.artifact_id);
      if (!a || a.project_id !== project.project_id) throw new ValidationError("rule", ["artifact_id: not a document of this project"]);
    }
    if (t.template === "customer_matches_project" && !project.facts.customer_name) notes.push("This project has no confirmed customer name yet, so the rule will report Couldn't verify until you confirm one in Project settings.");
    if (t.template === "price_matches_source") {
      const src = get<{ record_json: string }>(this.db, "SELECT record_json FROM sources WHERE source_id = ? AND workspace_id = ?", t.source_id, this.workspaceId);
      if (!src) throw new ValidationError("rule", ["source_id: not a registered trusted source"]);
      const rec = parse<{ key_columns: string[]; value_columns: string[] }>(src.record_json);
      if (!rec.key_columns.includes(t.key_column)) throw new ValidationError("rule", [`key_column: one of ${rec.key_columns.join(", ")}`]);
      if (!rec.value_columns.includes(t.value_column)) throw new ValidationError("rule", [`value_column: one of ${rec.value_columns.join(", ")}`]);
    }
    const enforcement: Enforcement = input.enforcement === "warn" ? "warn" : "block";
    const req = buildRequirement(t, project.name);
    const now = ts(this.clock.now());
    const content: RuleRevisionContent = {
      schema_version: "cl.rule/1", rule_id: ruleId, revision: 1, supersedes: null, title: req.title, statement: req.statement,
      origin: { kind: "human_correction" }, owner: "", review_by: addDays(now, 180).slice(0, 10),
      scope: scopeFor({ workspace_id: this.workspaceId, project_id: project.project_id, work_type: project.default_work_type, artifact_id: input.artifact_id ?? null }),
      applies_when: null, method: req.method, enforcement, locked: false, check: req.check, requires: req.requires, source: req.source, message: req.message, cases: [],
      exception_policy: { grantable_by: ["rule_owner", "project_steward", "workspace_steward"], max_days: 30 },
    };
    return { content, notes };
  }

  private summary(r: Rule): RuleSummary {
    return { rule_id: r.rule_id, title: r.title, statement: r.statement, status: r.status };
  }

  /** Everything a person sees before saving. Pure read: nothing is stored. */
  preview(input: DraftInput): Preview {
    const { content, notes } = this.draft(input, "rul_PREVIEW0");
    const problems = ruleProblems({ ...content, owner: "usr_PREVIEW0" });
    const analysis = this.rules.analyse(content);
    const summaries = (ids: string[]): RuleSummary[] => ids.map((id) => this.summary(this.rules.get(id)));
    return {
      content, problems, notes, duplicates: summaries(analysis.duplicates), conflicts: summaries([...analysis.conflicts, ...analysis.contradicts_learned]),
      dry_run: problems.length ? [] : this.checks.dryRun(content, input.project_id),
    };
  }

  /**
   * Save a candidate (inactive). AT-G4: if a rule in force already asks for the same
   * thing, or cannot both be met with this one, it is shown first - the save is
   * refused until the person has seen those rules and says so (`acknowledged`).
   */
  create(input: DraftInput, actor: Actor, acknowledged: string[] = []): Rule {
    requireHuman(actor, "Adding a correction");
    const ruleId = this.ids("rul");
    const { content } = this.draft(input, ruleId);
    const analysis = this.rules.analyse(content);
    const shown = [...analysis.duplicates, ...analysis.conflicts, ...analysis.contradicts_learned];
    const unseen = shown.filter((id) => !acknowledged.includes(id));
    if (unseen.length) {
      throw new Conflict("overlapping_rules", `${unseen.length} rule(s) already ask for the same thing or cannot both be met with this one. Review them before saving.`, {
        duplicates: analysis.duplicates.map((id) => this.summary(this.rules.get(id))), conflicts: [...analysis.conflicts, ...analysis.contradicts_learned].map((id) => this.summary(this.rules.get(id))),
      });
    }
    const words = (input.words ?? "").trim().slice(0, 2000);
    return tx(this.db, () => {
      const correctionId = this.ids("cor");
      const now = ts(this.clock.now());
      run(this.db, "INSERT INTO corrections (correction_id, workspace_id, project_id, author_id, channel, text, signal_id, record_json, recorded_at) VALUES (?,?,?,?, 'app_editor', ?, NULL, ?, ?)",
        correctionId, this.workspaceId, input.project_id, actor.id, words || null, json({ schema_version: "cl.correction/1", correction_id: correctionId, resolution: "rule", rule_ids: [ruleId] }), now);
      const recorded = this.ledger.append({
        type: "correction.recorded", project_id: input.project_id, actor, subject: { kind: "correction", id: correctionId }, refs: { correction_id: correctionId },
        summary: `${actor.display_name ?? actor.id} added a correction by hand.`, payload: { channel: "app_editor", has_words: !!words, acknowledged_overlaps: shown }, classification: "rule_text",
      });
      const full: RuleRevisionContent = { ...content, owner: actor.id, origin: { kind: "human_correction", correction_id: correctionId } };
      return this.rules.createCandidate(full, actor, { caused_by: [recorded.event_id], proposed_by: "person" }).rule;
    });
  }

  /**
   * Attach a REAL example: a stored version of a document in the rule's project.
   * The rule is run on it now; a "blocks" example must actually fail and an
   * "allows" example must actually pass, or nothing is recorded.
   */
  addExample(ruleId: string, ex: { artifact_id: string; content_hash: string; kind: "negative" | "positive" }, actor: Actor): Rule {
    requireHuman(actor, "Adding an example");
    const rule = this.rules.get(ruleId);
    const a = get<{ project_id: string; name: string }>(this.db, "SELECT project_id, name FROM artifacts WHERE artifact_id = ?", ex.artifact_id);
    if (!a) throw new NotFound("artifact", ex.artifact_id);
    if (rule.scope.project_id && a.project_id !== rule.scope.project_id) throw new ValidationError("example", ["the document belongs to another project"]);
    const { status: _s, authority: _a, approval: _p, ...content } = rule;
    const r = this.checks.evaluateRuleOn(content, ex.artifact_id, ex.content_hash);
    const expect: Outcome = ex.kind === "negative" ? "fail" : "pass";
    if (r.outcome !== expect) {
      throw new InvariantViolation("example_does_not_behave", `on version ${r.version_seq ?? "?"} of ${a.name} the rule's result is "${r.outcome}" (${r.reason}), so it cannot be an example the rule ${ex.kind === "negative" ? "blocks" : "allows"}`);
    }
    return tx(this.db, () => {
      const now = ts(this.clock.now());
      this.rules.addCase(ruleId, { kind: ex.kind, description: `Version ${r.version_seq} of ${a.name} (real, chosen by ${actor.display_name ?? actor.id})`, artifact_hash: ex.content_hash, expect, last_result: r.outcome, last_run_at: now });
      this.ledger.append({
        type: "rule.cases_tested", project_id: a.project_id, actor, subject: { kind: "rule", id: ruleId }, refs: { rule_id: ruleId, rule_revision: rule.revision, artifact_id: ex.artifact_id, content_hash: ex.content_hash },
        summary: `${actor.display_name ?? actor.id} added a real example the rule ${ex.kind === "negative" ? "blocks" : "allows"}: version ${r.version_seq} of ${a.name} (${r.outcome}).`, payload: { kind: ex.kind, result: r.outcome },
      });
      return this.rules.get(ruleId);
    });
  }

  /** The template behind a rule, for the "Change" form (null: this rule cannot be changed with the plain options). */
  templateOf(ruleId: string): TemplateInput | null {
    return templateOf(this.rules.get(ruleId));
  }

  /** Change a rule with the same plain options: a new revision, its stored examples re-tested (see RuleService.revise). */
  revise(ruleId: string, input: { template: Record<string, unknown>; enforcement?: Enforcement }, actor: Actor, opts: { trial?: boolean } = {}): Rule {
    requireHuman(actor, "Changing a rule");
    const current = this.rules.get(ruleId);
    if (!current.scope.project_id) throw new ValidationError("rule", ["only project and document rules can be changed here"]);
    if (!templateOf(current)) throw new ValidationError("rule", ["this rule was not made from the plain options, so it cannot be changed here"]);
    const { content } = this.draft({ project_id: current.scope.project_id, template: input.template, artifact_id: current.scope.artifact_id ?? null, enforcement: input.enforcement ?? current.enforcement }, ruleId);
    const next: RuleRevisionContent = { ...content, revision: current.revision + 1, supersedes: current.revision, origin: current.origin, owner: current.owner, review_by: current.review_by, scope: current.scope, exception_policy: current.exception_policy ?? content.exception_policy };
    const analysis = this.rules.analyse(next);
    if (analysis.duplicates.length) throw new Conflict("overlapping_rules", "another rule already asks for exactly this", { duplicates: analysis.duplicates.map((id) => this.summary(this.rules.get(id))), conflicts: [] });
    const project = current.scope.project_id;
    const results = current.cases.map((c) => {
      const v = get<{ artifact_id: string }>(this.db, "SELECT v.artifact_id FROM artifact_versions v JOIN artifacts a ON a.artifact_id = v.artifact_id WHERE v.content_hash = ? AND a.project_id = ? LIMIT 1", c.artifact_hash, project);
      return { case_id: c.case_id, result: v ? this.checks.evaluateRuleOn(next, v.artifact_id, c.artifact_hash).outcome : null };
    });
    return this.rules.revise(next, actor, results, opts);
  }
}
