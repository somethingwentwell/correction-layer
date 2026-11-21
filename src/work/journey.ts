/**
 * The journey of one correction (OBS-6, AT-R1): followed through STORED
 * references only - correction id, signal id, rule id, run id, artifact id,
 * fix id, receipt id, action id - never by timestamps or text similarity.
 *
 *   correction -> (signal, learning policy, decision) -> rule and its lifecycle
 *   -> runs where the rule failed -> blocks -> proposed and applied changes
 *   -> rechecks -> receipts -> requests, approvals, executions
 */
import type { LedgerEvent } from "../ledger/ledger.ts";
import type { Ledger } from "../ledger/ledger.ts";
import type { Db } from "../store/db.ts";
import { all, get, parse } from "../store/db.ts";

export const JOURNEY_WORDS: Readonly<Record<string, string>> = Object.freeze({
  "learning.policy_set": "PERMITTED", "correction.recorded": "SAID", "learning.signal_detected": "IDENTIFIED", "learning.correction_extracted": "COMPILED", "rule.candidate_created": "COMPILED",
  "rule.cases_tested": "EXAMPLE", "learning.candidate_evaluated": "TESTED", "learning.decision_made": "DECIDED", "rule.approved": "APPROVED", "rule.activated": "ON", "rule.confirmed": "KEPT",
  "rule.revised": "CHANGED RULE", "rule.suspended": "PAUSED", "rule.auto_paused": "PAUSED (AUTO)", "rule.resumed": "RESUMED", "rule.retired": "RETIRED", "redaction.applied": "WORDING DELETED",
  "run.completed": "CHECKED", "action.blocked": "BLOCKED", "fix.proposed": "PROPOSED", "fix.dismissed": "DISMISSED", "artifact.observed": "SEEN", "change.recorded": "CHANGED",
  "receipt.issued": "RECEIPT", "action.requested": "REQUESTED", "action.approved": "APPROVED ACTION", "action.paused": "PAUSED ACTION", "action.revalidated": "RE-VERIFIED",
  "action.executed": "EXECUTED", "receipt.consumed": "USED", "receipt.invalidated": "LAPSED", "exception.granted": "EXCEPTION", "feedback.recorded": "DISPUTED",
});

export function correctionJourney(db: Db, ledger: Ledger, correctionId: string): { events: LedgerEvent[]; rule_ids: string[]; project_id: string | null } {
  const seen = new Map<number, LedgerEvent>();
  const add = (events: LedgerEvent[]): void => {
    for (const e of events) seen.set(e.seq, e);
  };
  const correction = get<{ signal_id: string | null; record_json: string; project_id: string | null }>(db, "SELECT signal_id, record_json, project_id FROM corrections WHERE correction_id = ?", correctionId);
  add(ledger.byRef("correction_id", correctionId));
  if (correction?.signal_id) {
    const bySignal = ledger.byRef("signal_id", correction.signal_id);
    add(bySignal);
    for (const policyId of new Set(bySignal.map((e) => e.refs.learning_policy_id).filter((x): x is string => typeof x === "string"))) {
      add(ledger.byRef("learning_policy_id", policyId).filter((e) => e.type === "learning.policy_set" || e.type === "learning.policy_revoked"));
    }
  }
  const ruleIds = new Set<string>([...(correction ? parse<{ rule_ids?: string[] }>(correction.record_json).rule_ids ?? [] : []), ...[...seen.values()].map((e) => e.refs.rule_id).filter((x): x is string => typeof x === "string")]);
  for (const ruleId of ruleIds) add(ledger.byRef("rule_id", ruleId));
  // Runs in which the rule reported a problem, and what happened to that work afterwards.
  for (const ruleId of ruleIds) {
    for (const r of all<{ run_id: string; artifact_id: string }>(db, "SELECT c.run_id, u.artifact_id FROM check_results c JOIN runs u ON u.run_id = c.run_id WHERE c.rule_id = ? AND c.outcome = 'fail'", ruleId)) {
      const runEvents = ledger.byRef("run_id", r.run_id);
      add(runEvents);
      const from = Math.min(...runEvents.map((e) => e.seq));
      const later = ledger.byRef("artifact_id", r.artifact_id).filter((e) => e.seq >= from && ["change.recorded", "run.completed", "action.blocked", "fix.proposed", "fix.dismissed", "receipt.issued", "action.requested", "exception.granted"].includes(e.type));
      add(later);
      for (const fixId of new Set(later.map((e) => e.refs.fix_id).filter((x): x is string => typeof x === "string"))) add(ledger.byRef("fix_id", fixId));
      for (const receiptId of new Set(later.map((e) => e.refs.receipt_id).filter((x): x is string => typeof x === "string"))) {
        const byReceipt = ledger.byRef("receipt_id", receiptId);
        add(byReceipt);
        for (const actionId of new Set(byReceipt.map((e) => e.refs.action_id).filter((x): x is string => typeof x === "string"))) add(ledger.byRef("action_id", actionId));
      }
    }
  }
  const events = [...seen.values()].sort((a, b) => a.seq - b.seq);
  return { events, rule_ids: [...ruleIds], project_id: correction?.project_id ?? events.find((e) => e.project_id)?.project_id ?? null };
}
