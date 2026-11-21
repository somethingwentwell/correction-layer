/**
 * Exceptions (docs/07 §4, AT-E7): a person's recorded decision that one rule is
 * skipped for one document (its lineage in one project) until an end date.
 *
 *  - Anyone, including an assistant, may ASK; only a person may grant, reject or
 *    revoke, and only the rule's owner or a steward (docs/07 roles; in solo mode
 *    the local person holds the steward roles).
 *  - An exception always ends: at most the rule's `exception_policy.max_days`.
 *  - The engine reports the rule as `waived` with its underlying outcome; the
 *    ruleset digest includes applied exception ids, so granting or expiry
 *    invalidates outstanding receipts.
 *  - Exceptions are bound to an artifact of one project. A byte-identical copy in
 *    another project is another artifact: nothing carries over (AT-I4).
 *  - Learning can never grant one (docs/12 §11).
 */
import { Conflict, NotFound, PermissionDenied, ValidationError } from "../domain/errors.ts";
import type { IdGen } from "../domain/ids.ts";
import { SYS } from "../domain/ids.ts";
import type { Clock } from "../domain/time.ts";
import { addDays, ts } from "../domain/time.ts";
import type { Actor } from "../domain/types.ts";
import type { AppliedException } from "../engine/evaluate.ts";
import type { Ledger } from "../ledger/ledger.ts";
import type { Db } from "../store/db.ts";
import { all, get, parse, run, tx } from "../store/db.ts";
import type { RuleService } from "./rules.ts";
import { requireHuman } from "./rules.ts";

export interface ExceptionRecord {
  exception_id: string;
  project_id: string;
  rule_id: string;
  artifact_id: string;
  reason: string;
  days: number;
  requested_by: string;
  requested_at: string;
  status: "requested" | "granted" | "rejected" | "revoked" | "expired";
  decided_by: string | null;
  decided_at: string | null;
  expires_at: string | null;
  closed_at: string | null;
}

export class ExceptionService {
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

  get(exceptionId: string): ExceptionRecord {
    const row = get<ExceptionRecord>(this.db, "SELECT * FROM exceptions WHERE exception_id = ? AND workspace_id = ?", exceptionId, this.workspaceId);
    if (!row) throw new NotFound("exception", exceptionId);
    return row;
  }

  list(filter: { project_id?: string; rule_id?: string; artifact_id?: string }): ExceptionRecord[] {
    const where = ["workspace_id = ?"];
    const params: unknown[] = [this.workspaceId];
    for (const [k, v] of Object.entries(filter)) if (v) {
      where.push(`${k} = ?`);
      params.push(v);
    }
    return all<ExceptionRecord>(this.db, `SELECT * FROM exceptions WHERE ${where.join(" AND ")} ORDER BY requested_at DESC, rowid DESC`, ...params);
  }

  /** Ask for an exception. A request changes nothing about any check. */
  request(input: { project_id: string; rule_id: string; artifact_id: string; reason: string; days: number }, actor: Actor): ExceptionRecord {
    const reason = (input.reason ?? "").trim();
    const days = Number(input.days);
    const rule = this.rules.get(input.rule_id);
    const max = rule.exception_policy?.max_days ?? 30;
    const problems: string[] = [];
    if (!reason || reason.length > 500) problems.push("reason: say why, in 1 to 500 characters");
    if (!Number.isInteger(days) || days < 1 || days > max) problems.push(`days: a whole number from 1 to ${max} (this rule's limit)`);
    const artifact = get<{ project_id: string }>(this.db, "SELECT project_id FROM artifacts WHERE artifact_id = ? AND workspace_id = ?", input.artifact_id, this.workspaceId);
    if (!artifact || artifact.project_id !== input.project_id) problems.push("artifact_id: not a document of this project");
    if (rule.scope.level !== "workspace" && rule.scope.level !== "project_group" && rule.scope.project_id !== input.project_id) problems.push("rule_id: this rule does not apply to this project");
    if (problems.length) throw new ValidationError("exception", problems);
    return tx(this.db, () => {
      const id = this.ids("exc");
      const now = ts(this.clock.now());
      run(this.db, "INSERT INTO exceptions (exception_id, workspace_id, project_id, rule_id, artifact_id, reason, days, requested_by, requested_at, status) VALUES (?,?,?,?,?,?,?,?,?, 'requested')",
        id, this.workspaceId, input.project_id, input.rule_id, input.artifact_id, reason, days, actor.id, now);
      this.ledger.append({
        type: "exception.requested", project_id: input.project_id, actor, subject: { kind: "exception", id }, refs: { rule_id: input.rule_id, artifact_id: input.artifact_id },
        summary: `${actor.display_name ?? actor.id} asked to skip "${rule.title}" for one document for ${days} day(s). Nothing changes until a person grants it.`, payload: { reason, days },
      });
      return this.get(id);
    });
  }

  private mayDecide(actor: Actor, ruleOwner: string): boolean {
    if (actor.id === ruleOwner) return true;
    const roles = parse<string[]>(get<{ roles_json: string }>(this.db, "SELECT roles_json FROM principals WHERE principal_id = ? AND kind = 'human'", actor.id)?.roles_json ?? "[]");
    return roles.includes("rule_steward") || roles.includes("owner");
  }

  grant(exceptionId: string, actor: Actor): ExceptionRecord {
    requireHuman(actor, "Granting an exception");
    return tx(this.db, () => {
      const e = this.get(exceptionId);
      if (e.status !== "requested") throw new Conflict("exception_not_open", `this exception is ${e.status}`);
      const rule = this.rules.get(e.rule_id);
      if (!this.mayDecide(actor, rule.owner)) throw new PermissionDenied("only the rule's owner or a steward can grant an exception", "not_entitled");
      const now = ts(this.clock.now());
      const expires = addDays(now, e.days);
      run(this.db, "UPDATE exceptions SET status = 'granted', decided_by = ?, decided_at = ?, expires_at = ? WHERE exception_id = ?", actor.id, now, expires, exceptionId);
      const rev = this.rules.bumpPolicyRev(`exception ${exceptionId} granted`);
      this.ledger.append({
        type: "exception.granted", project_id: e.project_id, actor, subject: { kind: "exception", id: exceptionId }, refs: { rule_id: e.rule_id, artifact_id: e.artifact_id },
        caused_by: this.ledger.recent({ projectId: e.project_id, types: ["exception.requested"], limit: 500 }).filter((x) => x.subject.id === exceptionId).map((x) => x.event_id).slice(0, 1),
        summary: `${actor.display_name ?? actor.id} granted an exception: "${rule.title}" is skipped for one document until ${expires}. Rules revision is now ${rev}.`,
        payload: { expires_at: expires, days: e.days, self_granted: actor.id === e.requested_by, policy_rev: rev },
      });
      return this.get(exceptionId);
    });
  }

  reject(exceptionId: string, actor: Actor): ExceptionRecord {
    requireHuman(actor, "Rejecting an exception");
    return this.close(exceptionId, actor, "rejected", ["requested"]);
  }

  revoke(exceptionId: string, actor: Actor): ExceptionRecord {
    requireHuman(actor, "Revoking an exception");
    return this.close(exceptionId, actor, "revoked", ["granted"]);
  }

  private close(exceptionId: string, actor: Actor, status: "rejected" | "revoked" | "expired", from: string[]): ExceptionRecord {
    return tx(this.db, () => {
      const e = this.get(exceptionId);
      if (!from.includes(e.status)) throw new Conflict("exception_not_open", `this exception is ${e.status}`);
      const now = ts(this.clock.now());
      run(this.db, `UPDATE exceptions SET status = ?, closed_at = ?${status === "rejected" ? ", decided_by = ?, decided_at = ?" : ""} WHERE exception_id = ?`, status, now, ...(status === "rejected" ? [actor.id, now] : []), exceptionId);
      const rev = e.status === "granted" ? this.rules.bumpPolicyRev(`exception ${exceptionId} ${status}`) : null;
      if (status !== "rejected") {
        this.ledger.append({
          type: status === "expired" ? "exception.expired" : "exception.revoked", project_id: e.project_id, actor, subject: { kind: "exception", id: exceptionId }, refs: { rule_id: e.rule_id, artifact_id: e.artifact_id },
          summary: status === "expired" ? `An exception ended on ${e.expires_at}; the rule applies to that document again.${rev ? ` Rules revision is now ${rev}.` : ""}` : `${actor.display_name ?? actor.id} revoked an exception; the rule applies to that document again.`,
          payload: { previous_status: e.status, policy_rev: rev },
        });
      }
      return this.get(exceptionId);
    });
  }

  /** Granted exceptions whose end has passed expire, with an event each (AT-E7). Called before every check and on the timer. */
  expireDue(): string[] {
    const now = ts(this.clock.now());
    const due = all<{ exception_id: string }>(this.db, "SELECT exception_id FROM exceptions WHERE workspace_id = ? AND status = 'granted' AND expires_at <= ?", this.workspaceId, now);
    for (const d of due) this.close(d.exception_id, { kind: "system", id: SYS.service }, "expired", ["granted"]);
    return due.map((d) => d.exception_id);
  }

  /** Exceptions in force for one document at a moment (read-only; expiry is recorded by `expireDue`). */
  applicable(projectId: string, artifactId: string, asOf: string): AppliedException[] {
    return all<AppliedException>(this.db, "SELECT exception_id, rule_id FROM exceptions WHERE workspace_id = ? AND project_id = ? AND artifact_id = ? AND status = 'granted' AND expires_at > ? ORDER BY exception_id", this.workspaceId, projectId, artifactId, asOf);
  }
}
