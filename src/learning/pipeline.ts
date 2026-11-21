/**
 * The learning pipeline: captured -> identified -> compiled -> tested -> activated
 * (docs/12 §3). Five stages, kept apart; an item can stop at any of them and the
 * queue shows where and why.
 *
 * Invariants this module is shaped around:
 *  - ADD ONLY. Its single automatic write on policy is "add a requirement" (a
 *    candidate rule, then `RuleService.activateDelegated`). The one automatic move
 *    away from enforcement is `RuleService.autoPause`, which refuses every rule
 *    except one that was learned and never confirmed (ADR-016). Everything else in
 *    this module that retires, rejects, approves or suppresses is a person's act
 *    (`requireHuman`). It never changes a permission, edits an artifact or a
 *    source, or requests an action.
 *  - Effectively-once. Processing is keyed by `capture_id`: redelivery or
 *    re-processing creates no second signal, candidate or rule.
 *  - Evidence, not instructions. Agent output, tool output and unattested text are
 *    never signals. An assistant's relay is never the person's own words, and a
 *    relay whose text matches artifact content is discarded.
 *  - Real evidence only. The trigger case and the passing case are stored artifact
 *    versions. Generated variants are not produced here and could only count against.
 *  - Deterministic. `decide()` is pure; nothing here consults a model.
 */
import { assertValid } from "../contracts/schemas.ts";
import { digestOf } from "../domain/canonical.ts";
import { Conflict, NotFound, PermissionDenied, ValidationError } from "../domain/errors.ts";
import type { IdGen } from "../domain/ids.ts";
import { SYS } from "../domain/ids.ts";
import type { Clock } from "../domain/time.ts";
import { addDays, parseTs, ts } from "../domain/time.ts";
import type {
  Actor, DecisionCandidate, DecisionEvaluation, DecisionInput, DecisionOutcome, DecisionSignal, EvidenceCase, LearningPolicy, NormalizedArtifact, Outcome,
  RuleRevisionContent, Surface, Trust,
} from "../domain/types.ts";
import type { CaptureIntake } from "../capture/intake.ts";
import { GAP_TIMEOUT_SECONDS, contentDigest } from "../capture/intake.ts";
import type { ProjectService } from "../context/projects.ts";
import { evaluate } from "../engine/evaluate.ts";
import type { Ledger, LedgerEvent } from "../ledger/ledger.ts";
import type { RuleService } from "../policy/rules.ts";
import { requireHuman } from "../policy/rules.ts";
import type { Db } from "../store/db.ts";
import { all, get, json, parse, run, tx } from "../store/db.ts";
import type { CheckService, ObservedVersion } from "../work/check.ts";
import type { Classified, Detection } from "./compiler.ts";
import { classify, compileCorrection, detect, findMarkers } from "./compiler.ts";
import { REASON_WORDS, decide } from "./decision.ts";
import type { LearningPolicyService } from "./policy.ts";

export const MAX_PROCESSING_ATTEMPTS = 3;
export const APP_ADAPTER_ID = "adp_APPNATIVE";

const DISPOSITION: Record<DecisionOutcome, string> = {
  auto_activate: "active", auto_shadow: "shadow", shadow_and_inbox: "shadow", inbox: "waiting_for_person", waiting_for_evidence: "waiting_for_evidence",
  record_only: "record_only", declined: "declined", discarded: "discarded",
};
const RESULTING_STATUS: Partial<Record<DecisionOutcome, string>> = { auto_activate: "active", auto_shadow: "trial", shadow_and_inbox: "trial", inbox: "candidate", waiting_for_evidence: "candidate" };

export interface QueueView {
  funnel: { captured: number; identified: number; compiled: number; tested: number; activated: number; asked: number };
  needs_you: InboxItem[];
  turned_on: Array<{ rule_id: string; title: string; status: string; decided_at: string; confirmed: boolean; decision_id: string }>;
  waiting: Array<{ signal_id: string; text: string | null; reasons: string[]; expires_at: string }>;
  not_learned: Array<{ signal_id: string; decision_id: string; text: string | null; outcome: string; reasons: string[]; decided_at: string }>;
  captured_not_seen: number;
  not_captured_no_consent: number;
}

export interface InboxItem {
  inbox_id: string;
  project_id: string | null;
  kind: string;
  question: string;
  detail: Record<string, unknown>;
  rule_id: string | null;
  signal_id: string | null;
  status: "open" | "resolved";
  opened_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution: string | null;
}

export class LearningPipeline {
  private db: Db;
  private ledger: Ledger;
  private clock: Clock;
  private ids: IdGen;
  private rules: RuleService;
  private projects: ProjectService;
  private policies: LearningPolicyService;
  private checks: CheckService;
  private intake: CaptureIntake;
  private workspaceId: string;
  private displayTz: string;
  /** Test hook: runs at the start of processing one captured event (used to inject faults). */
  beforeProcess: ((captureId: string) => void) | null = null;

  constructor(deps: { db: Db; ledger: Ledger; clock: Clock; ids: IdGen; rules: RuleService; projects: ProjectService; policies: LearningPolicyService; checks: CheckService; intake: CaptureIntake; workspaceId: string; displayTz: string }) {
    this.db = deps.db;
    this.ledger = deps.ledger;
    this.clock = deps.clock;
    this.ids = deps.ids;
    this.rules = deps.rules;
    this.projects = deps.projects;
    this.policies = deps.policies;
    this.checks = deps.checks;
    this.intake = deps.intake;
    this.workspaceId = deps.workspaceId;
    this.displayTz = deps.displayTz;
    this.intake.onAdvance((streamId) => {
      this.processStream(streamId);
    });
    this.checks.onNewVersion((version) => this.onArtifactVersion(version));
    // Every automatic pause becomes a question for a person, with Resume.
    this.rules.onAutoPause((ruleId, trigger, detail, eventId) => {
      const rule = this.rules.get(ruleId);
      this.openInbox({
        project_id: rule.scope.project_id ?? null, kind: "paused_learned_rule", dedup_key: `paused:${ruleId}:${eventId}`, signal_id: null, decision_id: rule.authority?.decision_id ?? null, rule_id: ruleId,
        question: `"${rule.statement}" paused itself and is now a note only (${trigger.replace(/_/g, " ")}). ${detail} Resume it, or retire it.`, detail: { trigger, detail }, caused_by: [eventId],
      });
    });
  }

  // ------------------------------------------------------------ the processing stage
  /**
   * Hand received events to the detector strictly in sequence order. Holds while
   * the stream is known to be behind (so a correction recovered by replay is
   * processed exactly as if delivered live), until the gap timeout passes; after
   * that it proceeds with `capture_incomplete`, which blocks automation.
   * A failing event is retried, then dead-lettered; it never blocks the stream for good.
   */
  processStream(streamId: string): { processed: number; held: boolean; failed: boolean } {
    let processed = 0;
    for (;;) {
      const s = get<any>(this.db, "SELECT cursor, processed_through, adapter_last_seq, status FROM capture_streams WHERE stream_id = ?", streamId);
      if (!s) throw new NotFound("capture stream", streamId);
      if (s.processed_through >= s.cursor) return { processed, held: false, failed: false };
      const openGap = get<any>(this.db, "SELECT detected_at FROM capture_gaps WHERE stream_id = ? AND closed_at IS NULL ORDER BY detected_at LIMIT 1", streamId);
      const behind = !!openGap || s.cursor < s.adapter_last_seq;
      const timedOut = s.status !== "open" || (!!openGap && this.clock.now().getTime() - parseTs(openGap.detected_at).getTime() > GAP_TIMEOUT_SECONDS * 1000);
      if (behind && !timedOut) return { processed, held: true, failed: false };
      const seq = s.processed_through + 1;
      const event = get<any>(this.db, "SELECT * FROM capture_events WHERE stream_id = ? AND source_seq = ?", streamId, seq);
      try {
        tx(this.db, () => {
          if (event) {
            this.beforeProcess?.(event.capture_id);
            this.processEvent(event, !behind);
          }
          run(this.db, "UPDATE capture_streams SET processed_through = ? WHERE stream_id = ?", seq, streamId);
        });
        processed++;
      } catch (error) {
        // Failure / retry / dead-letter hook: nothing from the failed attempt is kept (the transaction rolled back).
        if (!event) throw error;
        const message = error instanceof Error ? error.message : String(error);
        const attempts = tx(this.db, () => {
          run(this.db, "INSERT INTO capture_processing_attempts (capture_id, attempts, last_error, last_at) VALUES (?, 1, ?, ?) ON CONFLICT (capture_id) DO UPDATE SET attempts = attempts + 1, last_error = excluded.last_error, last_at = excluded.last_at",
            event.capture_id, message, ts(this.clock.now()));
          const n = get<{ attempts: number }>(this.db, "SELECT attempts FROM capture_processing_attempts WHERE capture_id = ?", event.capture_id)!.attempts;
          if (n >= MAX_PROCESSING_ATTEMPTS) {
            this.intake.deadLetterProcessing(streamId, seq, event.capture_id, message);
            run(this.db, "UPDATE capture_streams SET processed_through = ? WHERE stream_id = ?", seq, streamId);
          }
          return n;
        });
        if (attempts < MAX_PROCESSING_ATTEMPTS) return { processed, held: false, failed: true };
      }
    }
  }

  /** Retry everything that is waiting: held streams, failed events. Called on a timer and on demand. */
  tick(): void {
    for (const s of all<{ stream_id: string }>(this.db, "SELECT stream_id FROM capture_streams WHERE workspace_id = ? AND processed_through < cursor", this.workspaceId)) this.processStream(s.stream_id);
    this.purgeReviewText();
  }

  private setStage(captureId: string, stage: string, disposition: string): void {
    run(this.db, "UPDATE capture_events SET stage = ?, disposition = ? WHERE capture_id = ?", stage, disposition, captureId);
  }

  private processEvent(e: any, captureComplete: boolean): void {
    if (!["user_turn", "review_action", "edit_observed"].includes(e.kind)) return; // envelopes: order and completeness only
    if (e.disposition === "consent_blocked") return;
    if (get(this.db, "SELECT 1 FROM signals WHERE capture_id = ?", e.capture_id)) return; // effectively-once
    if (e.disposition === "unbound" || !e.project_id) {
      this.openInbox({
        project_id: null, kind: "which_project", dedup_key: `unbound:${e.capture_id}`, signal_id: null, decision_id: null, rule_id: null,
        question: "A message could not be tied to exactly one project, so it was not kept and nothing was learned from it. If it was a correction, add it in the project it belongs to.",
        detail: { stream_id: e.stream_id, source_seq: e.source_seq, occurred_at: e.occurred_at }, caused_by: [],
      });
      this.setStage(e.capture_id, "captured", "unbound");
      return;
    }
    const classified = classify(e);
    const policy = this.policies.current(e.project_id);
    if (!classified || !policy || policy.mode === "off" || !this.policies.consents(e.project_id, classified.surface)) {
      this.setStage(e.capture_id, "captured", "not_a_signal");
      return;
    }
    const followsAgentOutput = !!get(this.db, "SELECT 1 FROM capture_events WHERE stream_id = ? AND kind = 'agent_output' AND source_seq < ?", e.stream_id, e.source_seq);
    const detection = detect({ kind: e.kind, text: e.content_text, surface: classified.surface, followsAgentOutput });
    if (!detection) {
      // Captured, not seen as a correction. Its text is kept only for the short review window.
      run(this.db, "UPDATE capture_events SET stage = 'captured', disposition = 'not_a_signal', content_state = 'held_for_review' WHERE capture_id = ?", e.capture_id);
      return;
    }
    const stream = get<any>(this.db, "SELECT author_id FROM capture_streams WHERE stream_id = ?", e.stream_id)!;
    this.signalAndCompile(e, classified, detection, captureComplete, classified.trust === "user_direct" ? stream.author_id : null, policy, { late: null, caused_by: [] });
  }

  /** Stages 2 to 5 for one identified event: record the signal, compile, test, decide, apply. */
  private signalAndCompile(e: any, classified: Classified, detection: Detection, captureComplete: boolean, authorId: string | null, policy: LearningPolicy, opts: { late: boolean | null; caused_by: string[] }): string {
    const stream = get<any>(this.db, "SELECT author_id, session_id, adapter_id FROM capture_streams WHERE stream_id = ?", e.stream_id)!;
    // What the statement was about: its own artifact, else the assistant output it replies to.
    const anchorEvent = e.artifact_id && e.content_hash ? e
      : get<any>(this.db, "SELECT artifact_id, content_hash FROM capture_events WHERE stream_id = ? AND source_seq < ? AND kind IN ('agent_output','edit_observed') AND artifact_id IS NOT NULL AND content_hash IS NOT NULL ORDER BY source_seq DESC LIMIT 1", e.stream_id, e.source_seq);
    const anchorOk = anchorEvent && get<any>(this.db, "SELECT project_id FROM artifacts WHERE artifact_id = ?", anchorEvent.artifact_id)?.project_id === e.project_id;
    const anchor = anchorOk ? { artifact_id: anchorEvent.artifact_id as string, content_hash: anchorEvent.content_hash as string, basis: e.artifact_id ? (e.kind === "edit_observed" ? "diff_target" : "app_selection") : "last_agent_output" } : null;
    const late = opts.late ?? this.clock.now().getTime() - parseTs(e.occurred_at).getTime() > policy.capture.late_after_hours * 3600 * 1000;
    const signalId = this.ids("sig");
    const episodeId = `epi_${digestOf([e.stream_id, anchor?.artifact_id ?? "none"]).slice(7, 23).toUpperCase()}`;
    const record = {
      schema_version: "cl.learning_signal/1", signal_id: signalId, workspace_id: this.workspaceId, project_id: e.project_id, type: detection.type, surface: classified.surface,
      adapter_id: stream.adapter_id, trust: classified.trust, author: authorId ? this.projects.person(authorId) : null, occurred_at: e.occurred_at, display_tz: this.displayTz,
      ...(stream.session_id ? { session_id: stream.session_id } : {}), episode_id: episodeId, anchor,
      content: { text: e.content_text, ...(e.language ? { language: e.language } : {}), markers: detection.markers, diff: null },
      capture: { stream_id: e.stream_id, capture_ids: [e.capture_id], source_seqs: [e.source_seq], delivery: e.delivery, late, episode_capture_complete: captureComplete },
      checks: { attested_by_runtime: e.attested_by === "runtime_hook", text_matches_artifact_content: false, author_in_learn_from: !!authorId && policy.learn_from.includes(authorId) },
      consent: { learning_policy_id: policy.learning_policy_id, learning_policy_revision: policy.revision, surface_opted_in: true },
      retention: { class: "evidence", delete_after_days: policy.retention.signal_text_days },
    };
    assertValid("learning-signal", record, "learning signal");
    const detected = this.ledger.append({
      type: "learning.signal_detected", project_id: e.project_id, actor: { kind: "system", id: SYS.detector }, subject: { kind: "signal", id: signalId },
      refs: { signal_id: signalId, learning_policy_id: policy.learning_policy_id, stream_id: e.stream_id, capture_id: e.capture_id, ...(anchor ? { artifact_id: anchor.artifact_id, content_hash: anchor.content_hash } : {}) }, caused_by: opts.caused_by,
      summary: `A ${detection.type.replace(/_/g, " ")} was identified in a captured ${e.kind.replace(/_/g, " ")} (${classified.trust.replace(/_/g, " ")}).`,
      payload: { type: detection.type, trust: classified.trust, surface: classified.surface, markers: detection.markers, delivery: e.delivery, late }, classification: "evidence",
    });
    run(this.db, "INSERT INTO signals (signal_id, capture_id, workspace_id, project_id, type, surface, trust, author_id, episode_id, text, record_json, event_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
      signalId, e.capture_id, this.workspaceId, e.project_id, detection.type, classified.surface, classified.trust, authorId, episodeId, e.content_text, json(record), detected.event_id, ts(this.clock.now()));
    this.setStage(e.capture_id, "identified", "waiting_for_person");

    // Compile: a typed candidate, saved INACTIVE.
    const project = this.projects.get(e.project_id);
    const ruleId = this.ids("rul");
    const correctionId = this.ids("cor");
    const compiled = compileCorrection({
      text: e.content_text, language: e.language, signal_type: detection.type, surface: classified.surface, markers: detection.markers,
      project: { project_id: project.project_id, name: project.name, default_work_type: project.default_work_type }, workspace_id: this.workspaceId,
      owner_id: authorId ?? policy.set_by.id, rule_id: ruleId, correction_id: correctionId, signal_id: signalId,
      review_by: addDays(ts(this.clock.now()), policy.limits.learned_rule_review_days).slice(0, 10),
    });
    let lastEvent: LedgerEvent = detected;
    let savedRuleId: string | null = null;
    let duplicateOf: string | null = null;
    if (compiled.rule && compiled.descriptor) {
      // The same requirement already waiting in this project counts once: no second candidate, no second rule.
      const pending = get<any>(this.db, "SELECT c.rule_id FROM learning_candidates c JOIN rule_state s ON s.rule_id = c.rule_id WHERE c.project_id = ? AND c.fingerprint = ? AND s.status = 'candidate' LIMIT 1", e.project_id, compiled.fingerprint);
      if (pending) duplicateOf = pending.rule_id;
      else {
        run(this.db, "INSERT INTO corrections (correction_id, workspace_id, project_id, author_id, channel, text, signal_id, record_json, recorded_at) VALUES (?,?,?,?,?,?,?,?,?)",
          correctionId, this.workspaceId, e.project_id, authorId ?? "unknown", classified.surface, e.content_text, signalId, json({ schema_version: "cl.correction/1", correction_id: correctionId, resolution: "rule", rule_ids: [ruleId] }), ts(this.clock.now()));
        const extracted = this.ledger.append({
          type: "learning.correction_extracted", project_id: e.project_id, actor: { kind: "system", id: SYS.translator, ...(authorId ? { on_behalf_of: authorId } : {}) }, subject: { kind: "correction", id: correctionId },
          refs: { correction_id: correctionId, signal_id: signalId }, caused_by: [detected.event_id], summary: `A correction was extracted from the signal. ${compiled.note}`,
          payload: { ai_model_used: false, compiler: "phase1-deterministic", grounded: compiled.descriptor.parameters_grounded }, classification: "rule_text",
        });
        const created = this.rules.createCandidate(compiled.rule, { kind: "system", id: SYS.translator, ...(authorId ? { on_behalf_of: authorId } : {}) }, { caused_by: [extracted.event_id], proposed_by: "translator" });
        lastEvent = created.event;
        savedRuleId = ruleId;
        this.setStage(e.capture_id, "compiled", "waiting_for_person");
      }
    }
    const descriptor: DecisionCandidate | null = compiled.descriptor && duplicateOf ? { ...compiled.descriptor, rule_id: duplicateOf } : compiled.descriptor;
    run(this.db, "INSERT INTO learning_candidates (candidate_id, signal_id, project_id, rule_id, correction_id, descriptor_json, fingerprint, state, trigger_artifact_id, trigger_hash, last_event_id, expires_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
      this.ids("evl"), signalId, e.project_id, savedRuleId, savedRuleId ? correctionId : null, json({ descriptor, note: compiled.note, duplicate_of: duplicateOf }), compiled.fingerprint, "identified",
      anchor?.artifact_id ?? null, anchor?.content_hash ?? null, lastEvent.event_id, addDays(ts(this.clock.now()), policy.limits.candidate_expiry_days), ts(this.clock.now()));
    this.decideAndApply(signalId);
    return signalId;
  }

  // ------------------------------------------------------------ evidence
  private outcomeOn(rule: RuleRevisionContent, artifact: NormalizedArtifact | null, projectId: string, evaluationId: string): Outcome {
    if (!artifact) return "unknown"; // an unreadable version decides nothing
    const out = evaluate({
      run_id: evaluationId, artifact, action: { type: rule.scope.actions[0] ?? "release" }, context: this.projects.resolve({ project_id: projectId }),
      rules: [{ content: rule, status: "active", content_digest: digestOf(rule) }], sources: [], exceptions: [], as_of: ts(this.clock.now()),
    });
    return out.results[0]!.outcome;
  }

  /** Test a candidate against REAL stored versions only (docs/12 §6). */
  private evaluateCandidate(rule: RuleRevisionContent | null, candidate: any, duplicateOf: string | null): DecisionEvaluation {
    const evaluationId = this.ids("evl");
    const empty: DecisionEvaluation = {
      evaluation_id: evaluationId, trigger_case: null, real_passing_cases: [], heldout: { artifacts: 0, pass: 0, fail: 0, unknown: 0, error: 0, not_applicable: 0 },
      generated: { run: 0, unexpected: 0, counted_as_support: false }, conflicts: [], duplicates: duplicateOf ? [duplicateOf] : [], contradicts_learned: [],
      auto_activations_today: 0,
    };
    if (!rule) return empty;
    const projectId: string = candidate.project_id;
    const today = ts(this.clock.now()).slice(0, 10);
    empty.auto_activations_today = get<{ n: number }>(this.db, "SELECT COUNT(*) AS n FROM learning_decisions WHERE project_id = ? AND outcome = 'auto_activate' AND substr(decided_at, 1, 10) = ?", projectId, today)!.n;
    const analysis = this.rules.analyse(rule);
    empty.conflicts = analysis.conflicts;
    empty.contradicts_learned = analysis.contradicts_learned;
    empty.duplicates = [...empty.duplicates, ...analysis.duplicates];
    let triggerArtifact: string | null = null;
    if (candidate.trigger_artifact_id && candidate.trigger_hash) {
      const versions = this.checks.versions(candidate.trigger_artifact_id);
      const trigger = versions.find((v) => v.content_hash === candidate.trigger_hash);
      if (trigger) {
        triggerArtifact = candidate.trigger_artifact_id;
        empty.trigger_case = { artifact_hash: trigger.content_hash, description: "The version the correction was about", kind: "trigger_version", expect: "fail", result: this.outcomeOn(rule, trigger.normalized, projectId, evaluationId) };
        // A later version of the same work in the same episode: the corrected version.
        const later: EvidenceCase[] = versions.filter((v) => v.version_seq > trigger.version_seq).map((v) => ({
          artifact_hash: v.content_hash, description: `Version ${v.version_seq} of the same work, saved after the correction`, kind: "corrected_version", expect: "pass", result: this.outcomeOn(rule, v.normalized, projectId, evaluationId),
        }));
        empty.real_passing_cases = later.slice(-1);
      }
    }
    // Held-out work: the latest versions of the OTHER artifacts in scope, which the candidate was not derived from.
    for (const v of this.checks.latestVersions(projectId)) {
      if (v.artifact_id === triggerArtifact) continue;
      const result = this.outcomeOn(rule, v.normalized, projectId, evaluationId);
      empty.heldout.artifacts++;
      if (result === "pass" || result === "fail" || result === "error" || result === "not_applicable") empty.heldout[result]++;
      else empty.heldout.unknown++;
    }
    return empty;
  }

  // ------------------------------------------------------------ decide and apply
  /** Evaluate, decide (pure), record, and apply the outcome's effects. Safe to call again when evidence arrives. */
  private decideAndApply(signalId: string): DecisionOutcome {
    const signal = get<any>(this.db, "SELECT * FROM signals WHERE signal_id = ?", signalId)!;
    const candidate = get<any>(this.db, "SELECT * FROM learning_candidates WHERE signal_id = ?", signalId)!;
    const policy = this.policies.current(signal.project_id)!;
    const stored = parse<{ descriptor: DecisionCandidate | null; note: string; duplicate_of: string | null }>(candidate.descriptor_json);
    const sigRecord = parse<any>(signal.record_json);
    const rule = candidate.rule_id ? this.rules.get(candidate.rule_id) : null;
    const { status: _status, authority: _authority, approval: _approval, ...ruleContent } = rule ?? ({} as any);
    const evaluation = stored.descriptor ? this.evaluateCandidate(rule ? (ruleContent as RuleRevisionContent) : null, candidate, stored.duplicate_of) : null;
    const decisionSignal: DecisionSignal = {
      signal_id: signalId, type: signal.type, surface: signal.surface as Surface, trust: signal.trust as Trust, author_id: signal.author_id, episode_id: signal.episode_id,
      text_matches_artifact_content: !!sigRecord.checks?.text_matches_artifact_content, delivery: sigRecord.capture?.delivery ?? "not_captured", late: !!sigRecord.capture?.late,
      episode_capture_complete: sigRecord.capture ? !!sigRecord.capture.episode_capture_complete : true,
    };
    const episodes = candidate.fingerprint
      ? get<{ n: number }>(this.db, "SELECT COUNT(DISTINCT s.episode_id) AS n FROM signals s JOIN learning_candidates c ON c.signal_id = s.signal_id WHERE c.project_id = ? AND c.fingerprint = ?", signal.project_id, candidate.fingerprint)!.n
      : 1;
    const suppressed = !!candidate.fingerprint && !!get(this.db, "SELECT 1 FROM suppressions WHERE project_id = ? AND fingerprint = ? AND removed_at IS NULL", signal.project_id, candidate.fingerprint);
    const input: DecisionInput = { signals: [decisionSignal], independent_episodes: Math.max(1, episodes), suppressed, candidate: stored.descriptor, evaluation };
    const { outcome, reasons } = decide(input, policy);
    return this.recordDecision({ signal, candidate, policy, input, outcome, reasons, rule: rule ? { rule_id: rule.rule_id, title: rule.title, statement: rule.statement, status: rule.status } : null, note: stored.note });
  }

  private recordDecision(a: { signal: any; candidate: any | null; policy: LearningPolicy; input: DecisionInput; outcome: DecisionOutcome; reasons: string[]; rule: { rule_id: string; title: string; statement: string; status: string } | null; note: string; artifact_flag?: string }): DecisionOutcome {
    const { signal, candidate, policy, input, outcome, reasons, rule } = a;
    const now = ts(this.clock.now());
    const decisionId = this.ids("dec");
    const automatic = outcome === "auto_activate" || outcome === "auto_shadow" || outcome === "shadow_and_inbox";
    const activates = automatic && !!rule && rule.status === "candidate";
    const sideEffects: Array<{ effect: string; rule_id?: string; inbox_id?: string; detail?: string }> = [];
    const plan = (kind: string, key: string, question: string, detail: Record<string, unknown>): void => {
      const inboxId = get<{ inbox_id: string }>(this.db, "SELECT inbox_id FROM inbox_items WHERE dedup_key = ?", key)?.inbox_id ?? this.ids("inb");
      sideEffects.push({ effect: "open_inbox_item", inbox_id: inboxId, detail: question });
      pendingInbox.push({ inboxId, kind, key, question, detail });
    };
    const pendingInbox: Array<{ inboxId: string; kind: string; key: string; question: string; detail: Record<string, unknown> }> = [];
    const words = reasons.map((r) => REASON_WORDS[r] ?? r);
    if (outcome === "inbox" || outcome === "shadow_and_inbox") {
      plan(reasons.includes("not_compilable") ? "possible_note" : reasons.includes("contradicts_learned_rule") ? "contradiction" : "needs_decision", `decision:${signal.signal_id}`,
        rule ? `"${rule.statement}" was not turned on by itself: ${words.join("; ")}.` : `This was noticed as a correction and not turned into a rule: ${words.join("; ")}.`, { reasons, text: signal.text, rule_id: rule?.rule_id ?? null });
    }
    if (input.candidate?.widening_requested) {
      plan("widening_request", `widen:${signal.signal_id}`, "This was asked for more than this project. A wider rule is a separate question for whoever holds authority over the wider scope; nothing wider was turned on.",
        { requested_level: input.candidate.widening_requested, rule_id: rule?.rule_id ?? null });
    }
    if (outcome === "declined") sideEffects.push({ effect: "offer_exception_request", detail: a.note });
    const directFromListed = input.signals.some((x) => x.trust === "user_direct" && x.author_id !== null && policy.learn_from.includes(x.author_id));
    const toPause = directFromListed && rule ? (input.evaluation?.contradicts_learned ?? []).filter((id) => this.rules.get(id).status === "active") : [];
    for (const id of toPause) sideEffects.push({ effect: "auto_pause_learned_rule", rule_id: id, detail: "contradicted by a direct statement of a listed person" });
    if (a.artifact_flag) sideEffects.push({ effect: "risk_flag_on_artifact", detail: `Instruction-like text was found in ${a.artifact_flag} and ignored.` });
    const resultingStatus = input.candidate?.rule_id ? (RESULTING_STATUS[outcome] ?? null) : null;
    const rationale = this.rationale(outcome, words, rule, signal, policy, input.evaluation);
    const record = {
      schema_version: "cl.learning_decision/1", decision_id: decisionId, workspace_id: this.workspaceId, project_id: signal.project_id, decided_at: now, display_tz: this.displayTz,
      learning_policy: { learning_policy_id: policy.learning_policy_id, revision: policy.revision, mode: policy.mode },
      signals: input.signals, independent_episodes: input.independent_episodes, suppressed: input.suppressed, candidate: input.candidate, evaluation: input.evaluation,
      outcome, reasons, resulting_rule_status: resultingStatus,
      authority: automatic ? { kind: "delegated_learning", learning_policy_id: policy.learning_policy_id, learning_policy_revision: policy.revision, delegated_by: policy.set_by.id } : null,
      side_effects: sideEffects, model_confidence_used: false, rationale,
    };
    assertValid("learning-decision", record, "learning decision");
    run(this.db, "INSERT INTO learning_decisions (decision_id, signal_id, project_id, outcome, reasons_json, record_json, decided_at) VALUES (?,?,?,?,?,?,?)", decisionId, signal.signal_id, signal.project_id, outcome, json(reasons), json(record), now);

    let cause: string = candidate?.last_event_id ?? signal.event_id;
    if (rule && input.evaluation) {
      const evaluated = this.ledger.append({
        type: "learning.candidate_evaluated", project_id: signal.project_id, actor: { kind: "system", id: SYS.engine }, subject: { kind: "rule", id: rule.rule_id },
        refs: { rule_id: rule.rule_id, signal_id: signal.signal_id, evaluation_id: input.evaluation.evaluation_id }, caused_by: [cause],
        summary: `The candidate was tested on real work: ${input.evaluation.trigger_case ? `the corrected draft ${input.evaluation.trigger_case.result === "fail" ? "is caught" : "is NOT caught"}` : "no draft to test against yet"}; ${input.evaluation.real_passing_cases.filter((c) => c.result === "pass").length} corrected version(s) pass; ${input.evaluation.heldout.artifacts} other document(s) checked. Generated variants are not counted as support.`,
        payload: { trigger: input.evaluation.trigger_case?.result ?? null, real_pass: input.evaluation.real_passing_cases.filter((c) => c.result === "pass").length, heldout: input.evaluation.heldout, generated: input.evaluation.generated }, classification: "evidence",
      });
      cause = evaluated.event_id;
    }
    const decided = this.ledger.append({
      type: "learning.decision_made", project_id: signal.project_id, actor: { kind: "system", id: SYS.learning }, subject: { kind: "decision", id: decisionId },
      refs: { decision_id: decisionId, signal_id: signal.signal_id, learning_policy_id: policy.learning_policy_id, ...(rule ? { rule_id: rule.rule_id } : {}), ...(input.evaluation ? { evaluation_id: input.evaluation.evaluation_id } : {}) },
      caused_by: [cause], summary: `Learning decision: ${outcome.replace(/_/g, " ")}${words.length ? ` (${words.join("; ")})` : ""}. No model confidence used.`,
      payload: { outcome, reasons, model_confidence_used: false, resulting_rule_status: resultingStatus }, classification: "meta",
    });
    for (const p of pendingInbox) {
      this.openInbox({ inbox_id: p.inboxId, project_id: signal.project_id, kind: p.kind, dedup_key: p.key, question: p.question, detail: p.detail, signal_id: signal.signal_id, decision_id: decisionId, rule_id: rule?.rule_id ?? null, caused_by: [decided.event_id] });
    }
    // Automatic pause on a direct contradiction (docs/12 §9): a listed person said something that cannot be met together
    // with a rule that was learned and never confirmed. That rule moves to note only; the new one is NOT turned on.
    for (const learned of toPause) {
      this.rules.autoPause(learned, "direct_contradiction", `${this.projects.displayName(signal.author_id)} asked for something that cannot be met together with it: "${rule!.statement}"`, [decided.event_id]);
    }
    if (activates && input.evaluation) {
      // Attach the real examples, then ask the rule service - which re-verifies the whole grant.
      const ev = input.evaluation;
      this.rules.addCase(rule!.rule_id, { kind: "negative", description: "The version the correction was about (real, from the signal)", artifact_hash: ev.trigger_case!.artifact_hash, expect: "fail", last_result: ev.trigger_case!.result, last_run_at: now });
      for (const c of ev.real_passing_cases.filter((x) => x.result === "pass")) {
        this.rules.addCase(rule!.rule_id, { kind: "positive", description: "The corrected version (real, from the same episode)", artifact_hash: c.artifact_hash, expect: "pass", last_result: "pass", last_run_at: now });
      }
      this.rules.activateDelegated(rule!.rule_id, { policy, decision: { decision_id: decisionId, outcome, reasons, signals: input.signals, evaluation: ev, model_confidence_used: false }, decision_event_id: decided.event_id });
      run(this.db, "INSERT INTO learning_notices (notice_id, project_id, rule_id, decision_id, text, created_at) VALUES (?,?,?,?,?,?)", this.ids("ntc"), signal.project_id, rule!.rule_id, decisionId, rationale, now);
    }
    if (candidate) run(this.db, "UPDATE learning_candidates SET state = ?, last_event_id = ?, updated_at = ? WHERE candidate_id = ?", outcome, decided.event_id, now, candidate.candidate_id);
    if (signal.capture_id) {
      const stage = activates ? "activated" : rule && input.evaluation?.trigger_case ? "tested" : rule ? "compiled" : "identified";
      this.setStage(signal.capture_id, stage, DISPOSITION[outcome]);
    }
    return outcome;
  }

  private rationale(outcome: DecisionOutcome, words: string[], rule: { statement: string } | null, signal: any, policy: LearningPolicy, ev: DecisionEvaluation | null): string {
    const project = this.projects.get(signal.project_id).name;
    // The person's words are NOT copied into the immutable decision record, so they can be deleted later (docs/12 §12).
    // Screens show them from the signal while they exist.
    const said = signal.author_id ? ` Because ${this.projects.displayName(signal.author_id)} said so directly.` : "";
    if (outcome === "auto_activate" || outcome === "auto_shadow") {
      return `Learned for ${project}: ${rule!.statement}${said} It catches the version that was corrected, passes the corrected version, and flags none of the ${ev!.heldout.artifacts} other document(s) in this project. Low-risk kind (exact check, this project only, adds a requirement). ${outcome === "auto_activate" ? "On now" : "On as a note only"} under the learning setting ${this.projects.displayName(policy.set_by.id)} chose. No person clicked; Undo is available.`;
    }
    return `${outcome.replace(/_/g, " ")}${words.length ? `: ${words.join("; ")}` : ""}.${rule ? ` Candidate: ${rule.statement}` : ""}`;
  }

  /** New evidence: re-test candidates that were waiting for the corrected version of this artifact. */
  private onArtifactVersion(version: ObservedVersion): void {
    const now = ts(this.clock.now());
    // Any candidate still inactive whose last decision lacked evidence is re-tested - whether it was merely
    // waiting or already put to a person for other reasons too.
    const waiting = all<{ signal_id: string }>(this.db, `SELECT c.signal_id FROM learning_candidates c JOIN rule_state s ON s.rule_id = c.rule_id
      WHERE c.project_id = ? AND c.trigger_artifact_id = ? AND s.status = 'candidate' AND c.state IN ('waiting_for_evidence', 'inbox') AND c.expires_at > ? ORDER BY c.updated_at, c.rowid`, version.project_id, version.artifact_id, now);
    for (const w of waiting) {
      const last = get<{ reasons_json: string }>(this.db, "SELECT reasons_json FROM learning_decisions WHERE signal_id = ? ORDER BY rowid DESC LIMIT 1", w.signal_id);
      const reasons = last ? parse<string[]>(last.reasons_json) : [];
      if (reasons.includes("no_real_pass") || reasons.includes("no_trigger_case")) tx(this.db, () => this.decideAndApply(w.signal_id));
    }
  }

  // ------------------------------------------------------------ assistant relay (propose_correction)
  /**
   * RELAYED, not captured: an assistant says the user said something. It is never
   * treated as the person's own words, can reach the inbox at most, and is
   * discarded outright when its text matches the content of an artifact (the
   * classic route for instructions hidden in a document).
   */
  relay(input: { project_id: string; text: string; agent: Actor; session_id?: string }): { status: "inbox" | "discarded"; reason: string; inbox_id: string | null; signal_id: string } {
    if (input.agent.kind === "human") throw new ValidationError("propose_correction", ["a person adds a correction in the app, not through the relay"]);
    const text = (input.text ?? "").trim();
    if (!text || text.length > 2000) throw new ValidationError("propose_correction", ["text: between 1 and 2000 characters"]);
    const project = this.projects.get(input.project_id);
    const relayKey = digestOf([project.project_id, text, input.session_id ?? input.agent.id]);
    return tx(this.db, () => {
      const existing = get<any>(this.db, "SELECT s.signal_id, s.text, i.inbox_id FROM signals s LEFT JOIN inbox_items i ON i.signal_id = s.signal_id WHERE s.relay_key = ?", relayKey);
      if (existing) return { status: existing.text === null ? "discarded" as const : "inbox" as const, reason: "already_received", inbox_id: existing.inbox_id ?? null, signal_id: existing.signal_id };
      const fold = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim();
      const needle = fold(text);
      const match = this.checks.latestVersions(project.project_id).find((v) => (v.normalized?.content.blocks ?? []).some((b) => {
        const hay = fold(b.text ?? "");
        return hay.length >= 12 && needle.length >= 12 && (hay.includes(needle) || needle.includes(hay));
      }));
      const signalId = this.ids("sig");
      const now = ts(this.clock.now());
      const episodeId = `epi_${digestOf(["relay", relayKey]).slice(7, 23).toUpperCase()}`;
      const policy = this.policies.current(project.project_id);
      // Untrusted text is not kept: only the fact that it arrived, and why it was ignored.
      run(this.db, "INSERT INTO signals (signal_id, relay_key, workspace_id, project_id, type, surface, trust, author_id, episode_id, text, record_json, created_at) VALUES (?,?,?,?, 'standing_instruction', 'assistant_relay', 'assistant_relayed', NULL, ?, ?, ?, ?)",
        signalId, relayKey, this.workspaceId, project.project_id, episodeId, match ? null : text, json({ checks: { text_matches_artifact_content: !!match }, relayed_by: input.agent.id, capture: null }), now);
      if (match) {
        const discarded = this.ledger.append({
          type: "learning.signal_discarded", project_id: project.project_id, actor: { kind: "system", id: SYS.detector }, subject: { kind: "signal", id: signalId },
          refs: { signal_id: signalId, artifact_id: match.artifact_id, content_hash: match.content_hash, ...(policy ? { learning_policy_id: policy.learning_policy_id } : {}) },
          summary: `A correction passed on by an assistant matched text inside ${match.name}. It was ignored: text in a document is evidence, not an instruction.`,
          payload: { reason: "untrusted_origin", relayed_by: input.agent.id, text_matches_artifact_content: true }, classification: "meta",
        });
        run(this.db, "INSERT INTO artifact_risk_flags (artifact_id, flag, detail, raised_at, event_id) VALUES (?, 'instruction_like_text_relayed', ?, ?, ?)", match.artifact_id, "An assistant relayed text from this file as if it were a correction. It was discarded.", now, discarded.event_id);
        if (policy && policy.mode !== "off" && this.policies.consents(project.project_id, "assistant_relay")) {
          const signal = get<any>(this.db, "SELECT * FROM signals WHERE signal_id = ?", signalId)!;
          const decisionInput: DecisionInput = {
            signals: [{ signal_id: signalId, type: "standing_instruction", surface: "assistant_relay", trust: "assistant_relayed", author_id: null, episode_id: episodeId, text_matches_artifact_content: true, delivery: "not_captured", late: false, episode_capture_complete: true }],
            independent_episodes: 1, suppressed: false, candidate: null, evaluation: null,
          };
          const d = decide(decisionInput, policy);
          this.recordDecision({ signal: { ...signal, event_id: discarded.event_id }, candidate: null, policy, input: decisionInput, outcome: d.outcome, reasons: d.reasons, rule: null, note: "", artifact_flag: match.name });
        }
        return { status: "discarded" as const, reason: "untrusted_origin", inbox_id: null, signal_id: signalId };
      }
      const inboxId = this.openInbox({
        project_id: project.project_id, kind: "relayed_correction", dedup_key: `relay:${relayKey}`, signal_id: signalId, decision_id: null, rule_id: null,
        question: "An assistant passed on a correction (RELAYED: best effort, not the person's own words). Nothing was turned on. Add it as a correction yourself if it is right.",
        detail: { text, relayed_by: input.agent.id }, caused_by: [],
      });
      return { status: "inbox" as const, reason: "relayed_always_asks", inbox_id: inboxId, signal_id: signalId };
    });
  }

  // ------------------------------------------------------------ the app's own correction box (app-native capture)
  /**
   * A person types a correction in the app. It is written through the same durable
   * intake as every other captured event (adapter: app-native, attested by the app).
   * With learning Off for the project the intake drops the content: that is the
   * documented boundary - the manual "correction -> candidate" editor is Phase 2.
   */
  appCorrection(input: { project_id: string; text: string; artifact_id?: string; content_hash?: string }, actor: Actor): { result: string; stream_id: string; source_seq: number } {
    requireHuman(actor, "Adding a correction in the app");
    const text = (input.text ?? "").trim();
    if (!text || text.length > 2000) throw new ValidationError("correction", ["text: between 1 and 2000 characters"]);
    const project = this.projects.get(input.project_id);
    if (!this.intake.adapters().some((a) => a.adapter_id === APP_ADAPTER_ID)) {
      this.intake.pairAdapter({ adapter_id: APP_ADAPTER_ID, kind: "app_native", label: "This app (correction box)", simulated: false, attests_user_turns: true, durable_outbox: true, supports_replay: false, supports_backfill: false }, actor);
    }
    const streamId = `str_APP${digestOf([project.project_id, actor.id]).slice(7, 21).toUpperCase()}`;
    const hello = this.intake.hello({ adapter_id: APP_ADAPTER_ID, stream_id: streamId, last_seq: 0 }, { author_id: actor.id, project_id: project.project_id });
    const seq = hello.cursor + 1;
    const ack = this.intake.deliver({
      adapter_id: APP_ADAPTER_ID, stream_id: streamId,
      events: [{
        event: {
          schema_version: "cl.capture_event/1", capture_id: this.ids("cap"), adapter_id: APP_ADAPTER_ID, stream_id: streamId, source_seq: seq, kind: "user_turn", occurred_at: ts(this.clock.now()),
          role: "user", attested_by: "app", binding: { binding_id: null, project_id: null, ...(input.artifact_id && input.content_hash ? { artifact_id: input.artifact_id, content_hash: input.content_hash } : {}) },
          content: { text, language: "en" }, content_state: "present", content_digest: contentDigest(text),
        },
      }],
    });
    return { result: ack.results[0]!.result, stream_id: streamId, source_seq: seq };
  }

  // ------------------------------------------------------------ inbox
  private openInbox(a: { inbox_id?: string; project_id: string | null; kind: string; dedup_key: string; question: string; detail: Record<string, unknown>; signal_id: string | null; decision_id: string | null; rule_id: string | null; caused_by: string[] }): string {
    const existing = get<{ inbox_id: string }>(this.db, "SELECT inbox_id FROM inbox_items WHERE dedup_key = ?", a.dedup_key);
    if (existing) {
      // One question per subject. A later decision on the same signal refreshes the open question instead of adding another.
      run(this.db, "UPDATE inbox_items SET question = ?, detail_json = ?, kind = ?, decision_id = COALESCE(?, decision_id) WHERE inbox_id = ? AND status = 'open'", a.question, json(a.detail), a.kind, a.decision_id, existing.inbox_id);
      return existing.inbox_id;
    }
    const inboxId = a.inbox_id ?? this.ids("inb");
    run(this.db, "INSERT INTO inbox_items (inbox_id, workspace_id, project_id, kind, question, detail_json, signal_id, decision_id, rule_id, dedup_key, opened_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      inboxId, this.workspaceId, a.project_id, a.kind, a.question, json(a.detail), a.signal_id, a.decision_id, a.rule_id, a.dedup_key, ts(this.clock.now()));
    this.ledger.append({
      type: "learning.inbox_item_opened", project_id: a.project_id, actor: { kind: "system", id: SYS.learning }, subject: { kind: "inbox_item", id: inboxId },
      refs: { inbox_id: inboxId, ...(a.signal_id ? { signal_id: a.signal_id } : {}), ...(a.decision_id ? { decision_id: a.decision_id } : {}), ...(a.rule_id ? { rule_id: a.rule_id } : {}) },
      caused_by: a.caused_by, summary: "A question was opened for a person in the learning inbox.", payload: { kind: a.kind },
    });
    return inboxId;
  }

  private toInbox(row: any): InboxItem {
    return { inbox_id: row.inbox_id, project_id: row.project_id, kind: row.kind, question: row.question, detail: parse(row.detail_json), rule_id: row.rule_id, signal_id: row.signal_id, status: row.status, opened_at: row.opened_at, resolved_at: row.resolved_at, resolved_by: row.resolved_by, resolution: row.resolution };
  }

  inbox(projectId: string | null, includeResolved = false): InboxItem[] {
    return all<any>(this.db, `SELECT * FROM inbox_items WHERE workspace_id = ? AND ${projectId === null ? "project_id IS NULL" : "project_id = ?"} ${includeResolved ? "" : "AND status = 'open'"} ORDER BY opened_at DESC`, ...(projectId === null ? [this.workspaceId] : [this.workspaceId, projectId]))
      .map((r) => this.toInbox(r));
  }

  /** A person closes an inbox question. Closing never activates anything; approving a candidate is a separate act on the rule. */
  resolveInbox(inboxId: string, actor: Actor, resolution: string): InboxItem {
    requireHuman(actor, "Answering a learning inbox item");
    return tx(this.db, () => {
      const row = get<any>(this.db, "SELECT * FROM inbox_items WHERE inbox_id = ? AND workspace_id = ?", inboxId, this.workspaceId);
      if (!row) throw new NotFound("inbox item", inboxId);
      if (row.status === "open") {
        run(this.db, "UPDATE inbox_items SET status = 'resolved', resolved_at = ?, resolved_by = ?, resolution = ? WHERE inbox_id = ?", ts(this.clock.now()), actor.id, resolution, inboxId);
        this.ledger.append({
          type: "learning.inbox_item_resolved", project_id: row.project_id, actor, subject: { kind: "inbox_item", id: inboxId }, refs: { inbox_id: inboxId, ...(row.rule_id ? { rule_id: row.rule_id } : {}) },
          caused_by: this.ledger.byRef("inbox_id", inboxId).slice(-1).map((e) => e.event_id), summary: `${actor.display_name ?? actor.id} answered a learning inbox question: ${resolution}.`, payload: { resolution },
        });
      }
      return this.toInbox(get<any>(this.db, "SELECT * FROM inbox_items WHERE inbox_id = ?", inboxId));
    });
  }

  // ------------------------------------------------------------ read models
  decisions(projectId: string): Array<Record<string, any>> {
    return all<{ record_json: string }>(this.db, "SELECT record_json FROM learning_decisions WHERE project_id = ? ORDER BY decided_at DESC, rowid DESC", projectId).map((r) => parse(r.record_json));
  }

  notices(projectId: string): Array<{ notice_id: string; rule_id: string; decision_id: string; text: string; created_at: string }> {
    return all<any>(this.db, "SELECT notice_id, rule_id, decision_id, text, created_at FROM learning_notices WHERE project_id = ? ORDER BY created_at DESC", projectId);
  }

  /**
   * The learning queue (UX-13): counts for each stage - counts, not rates - and
   * every item with the furthest stage it reached and why it stopped.
   */
  queue(projectId: string): QueueView {
    const order = ["captured", "identified", "compiled", "tested", "activated"];
    const stages = all<{ stage: string; n: number }>(this.db, "SELECT stage, COUNT(*) AS n FROM capture_events WHERE project_id = ? AND kind IN ('user_turn','review_action','edit_observed') AND COALESCE(disposition, '') NOT IN ('consent_blocked','unbound') GROUP BY stage", projectId);
    const atOrBeyond = (i: number): number => stages.filter((s) => order.indexOf(s.stage) >= i).reduce((sum, s) => sum + s.n, 0);
    const latest = all<any>(this.db, "SELECT d.* FROM learning_decisions d WHERE d.project_id = ? AND d.rowid = (SELECT MAX(rowid) FROM learning_decisions WHERE signal_id = d.signal_id) ORDER BY d.decided_at DESC", projectId);
    const text = (signalId: string): string | null => get<any>(this.db, "SELECT text FROM signals WHERE signal_id = ?", signalId)?.text ?? null;
    const needsYou = this.inbox(projectId);
    return {
      funnel: { captured: atOrBeyond(0), identified: atOrBeyond(1), compiled: atOrBeyond(2), tested: atOrBeyond(3), activated: atOrBeyond(4), asked: needsYou.length },
      needs_you: needsYou,
      turned_on: all<any>(this.db, "SELECT d.decision_id, d.decided_at, d.record_json FROM learning_decisions d WHERE d.project_id = ? AND d.outcome IN ('auto_activate','auto_shadow','shadow_and_inbox') ORDER BY d.decided_at DESC", projectId).map((d) => {
        const rule = this.rules.get(parse<any>(d.record_json).candidate.rule_id);
        return { rule_id: rule.rule_id, title: rule.title, status: rule.status, decided_at: d.decided_at, confirmed: rule.authority?.kind === "individual_approval", decision_id: d.decision_id };
      }),
      waiting: latest.filter((d) => d.outcome === "waiting_for_evidence").map((d) => ({ signal_id: d.signal_id, text: text(d.signal_id), reasons: parse<string[]>(d.reasons_json), expires_at: get<any>(this.db, "SELECT expires_at FROM learning_candidates WHERE signal_id = ?", d.signal_id)?.expires_at ?? "" })),
      not_learned: latest.filter((d) => ["record_only", "declined", "discarded"].includes(d.outcome)).map((d) => ({ signal_id: d.signal_id, decision_id: d.decision_id, text: text(d.signal_id), outcome: d.outcome, reasons: parse<string[]>(d.reasons_json), decided_at: d.decided_at })),
      captured_not_seen: get<{ n: number }>(this.db, "SELECT COUNT(*) AS n FROM capture_events WHERE project_id = ? AND disposition = 'not_a_signal'", projectId)!.n,
      not_captured_no_consent: this.intake.consentBlockedCount(projectId),
    };
  }

  // ------------------------------------------------------------ automatic pause, disputes (docs/12 §9, AT-L15)
  /**
   * The learning-side entry to the automatic pause. It is narrow by construction:
   * `RuleService.autoPause` refuses any rule that a person approved or kept, any
   * locked, workspace-level or imported rule, and any rule that is not on.
   */
  autoPause(ruleId: string, trigger: "direct_contradiction" | "disputes" | "example_regression" | "conflict_with_approved_rule", detail = "Paused automatically."): { paused: boolean; reason: string } {
    return this.rules.autoPause(ruleId, trigger, detail);
  }

  /** "This finding is wrong", by a person. Two on distinct documents pause an unconfirmed learned rule. */
  disputeFinding(input: { run_id: string; rule_id: string; reason: string }, actor: Actor): { disputes: number; paused: boolean; note: string } {
    requireHuman(actor, "Disputing a finding");
    const runRecord = this.checks.getRun(input.run_id);
    const result = runRecord.results.find((r) => r.rule_id === input.rule_id);
    if (!result || result.outcome !== "fail") throw new ValidationError("dispute", ["only a rule that reported a problem in this check can be disputed"]);
    const reason = (input.reason ?? "").trim().slice(0, 500) || "this finding is wrong";
    const projectId = runRecord.context.project_id!;
    return tx(this.db, () => {
      const now = ts(this.clock.now());
      run(this.db, "INSERT INTO finding_disputes (dispute_id, project_id, rule_id, run_id, artifact_id, finding_id, disputed_by, reason, at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT (rule_id, artifact_id, disputed_by) DO NOTHING",
        this.ids("dsp"), projectId, input.rule_id, input.run_id, runRecord.artifact.artifact_id, result.findings[0]?.finding_id ?? null, actor.id, reason, now);
      const recorded = this.ledger.append({
        type: "feedback.recorded", project_id: projectId, actor, subject: { kind: "rule", id: input.rule_id }, refs: { rule_id: input.rule_id, run_id: input.run_id, artifact_id: runRecord.artifact.artifact_id },
        caused_by: this.ledger.byRef("run_id", input.run_id).filter((e) => e.type === "run.completed").map((e) => e.event_id), summary: `${actor.display_name ?? actor.id} said a finding of "${result.title}" is wrong.`, payload: { kind: "finding_dispute", reason },
      });
      const disputes = get<{ n: number }>(this.db, "SELECT COUNT(DISTINCT artifact_id) AS n FROM finding_disputes WHERE rule_id = ? AND project_id = ?", input.rule_id, projectId)!.n;
      const threshold = Number((this.policies.current(projectId)?.auto_pause as { disputes_distinct_artifacts?: number } | undefined)?.disputes_distinct_artifacts ?? 2);
      if (disputes < threshold) return { disputes, paused: false, note: `Recorded. ${disputes} of ${threshold} documents disputed.` };
      const out = this.rules.autoPause(input.rule_id, "disputes", `"This finding is wrong" was said about ${disputes} different documents.`, [recorded.event_id]);
      return { disputes, paused: out.paused, note: out.paused ? "The rule is now a note only; a person can resume it." : `Recorded; the rule is unchanged: ${out.reason}.` };
    });
  }

  // ------------------------------------------------------------ "this was a correction" (docs/12 §10, AT-L19)
  /** A person's own captured messages that were not seen as corrections, while their text is kept for review. Only the author sees them. */
  reviewMine(projectId: string, actor: Actor): Array<{ capture_id: string; text: string; occurred_at: string; delete_after: string }> {
    const policy = this.policies.current(projectId);
    const days = policy?.capture.non_signal_review_days ?? 14;
    return all<any>(this.db, `SELECT e.capture_id, e.content_text, e.occurred_at, e.received_at FROM capture_events e JOIN capture_streams s ON s.stream_id = e.stream_id
      WHERE e.project_id = ? AND s.author_id = ? AND e.kind = 'user_turn' AND e.disposition = 'not_a_signal' AND e.content_text IS NOT NULL ORDER BY e.received_at DESC`, projectId, actor.id)
      .map((r) => ({ capture_id: r.capture_id, text: r.content_text, occurred_at: r.occurred_at, delete_after: addDays(r.received_at, days) }))
      .filter((r) => r.delete_after > ts(this.clock.now()));
  }

  /**
   * The author marks one of their own captured messages as a correction. It becomes
   * a `user_direct` signal from the app and goes through the same stages - tests,
   * decision, policy limits - as any other.
   */
  markAsCorrection(captureId: string, actor: Actor): { signal_id: string; outcome: string } {
    requireHuman(actor, "Marking a message as a correction");
    const e = get<any>(this.db, "SELECT * FROM capture_events WHERE capture_id = ? AND workspace_id = ?", captureId, this.workspaceId);
    if (!e) throw new NotFound("captured message", captureId);
    const stream = get<any>(this.db, "SELECT author_id FROM capture_streams WHERE stream_id = ?", e.stream_id)!;
    if (stream.author_id !== actor.id) throw new PermissionDenied("only the person who wrote a message can mark it as a correction", "not_the_author");
    if (e.kind !== "user_turn" || e.role !== "user") throw new ValidationError("correction", ["only a message a person typed can be marked; assistant and tool output never can"]);
    if (get(this.db, "SELECT 1 FROM signals WHERE capture_id = ?", captureId) || e.disposition !== "not_a_signal") throw new Conflict("already_handled", "this message was already handled as a correction or set aside for another reason");
    if (e.content_text === null) throw new Conflict("text_not_kept", "the text of this message is no longer kept, so it cannot be used");
    const policy = this.policies.current(e.project_id);
    if (!policy || policy.mode === "off" || !this.policies.consents(e.project_id, "app")) throw new ValidationError("correction", ["learning from the app is off for this project"]);
    if (addDays(e.received_at, policy.capture.non_signal_review_days) <= ts(this.clock.now())) throw new Conflict("review_window_over", "the review window for this message has ended");
    return tx(this.db, () => {
      const marked = this.ledger.append({
        type: "correction.recorded", project_id: e.project_id, actor, subject: { kind: "capture", id: captureId }, refs: { capture_id: captureId, stream_id: e.stream_id },
        summary: `${actor.display_name ?? actor.id} marked one of their own captured messages: "this was a correction".`, payload: { channel: "review_mine" }, classification: "meta",
      });
      const markers = findMarkers(e.content_text);
      const gaps = get<{ n: number }>(this.db, "SELECT COUNT(*) AS n FROM capture_gaps WHERE stream_id = ? AND closed_at IS NULL AND acknowledged_at IS NULL", e.stream_id)!.n;
      run(this.db, "UPDATE capture_events SET content_state = 'present' WHERE capture_id = ?", captureId);
      const signalId = this.signalAndCompile(e, { trust: "user_direct", surface: "app" }, { type: markers.standing.length ? "standing_instruction" : "direct_correction", markers }, gaps === 0, actor.id, policy, { late: false, caused_by: [marked.event_id] });
      const outcome = get<{ outcome: string }>(this.db, "SELECT outcome FROM learning_decisions WHERE signal_id = ? ORDER BY rowid DESC LIMIT 1", signalId)?.outcome ?? "identified";
      return { signal_id: signalId, outcome };
    });
  }

  /** Captured text that was not a correction is kept only for the review window, then removed (docs/12 §12). */
  purgeReviewText(): number {
    let purged = 0;
    for (const p of all<{ project_id: string }>(this.db, "SELECT DISTINCT project_id FROM capture_events WHERE workspace_id = ? AND disposition = 'not_a_signal' AND content_text IS NOT NULL AND project_id IS NOT NULL", this.workspaceId)) {
      const days = this.policies.current(p.project_id)?.capture.non_signal_review_days ?? 14;
      const cutoff = addDays(ts(this.clock.now()), -days);
      purged += run(this.db, "UPDATE capture_events SET content_text = NULL, content_state = 'purged' WHERE project_id = ? AND disposition = 'not_a_signal' AND content_text IS NOT NULL AND received_at <= ?", p.project_id, cutoff).changes;
    }
    return purged;
  }

  // ------------------------------------------------------------ suppression, deletion (docs/12 §9, §12; AT-L17)
  /** "Don't learn this": the rule (if any) is retired or rejected and the same candidate is never raised again in this project. */
  suppress(decisionId: string, actor: Actor): { suppression_id: string; rule_id: string | null } {
    requireHuman(actor, "Suppressing a learned correction");
    const d = get<any>(this.db, "SELECT * FROM learning_decisions WHERE decision_id = ? AND project_id IS NOT NULL", decisionId);
    if (!d) throw new NotFound("learning decision", decisionId);
    const candidate = get<any>(this.db, "SELECT * FROM learning_candidates WHERE signal_id = ?", d.signal_id);
    if (!candidate?.fingerprint) throw new ValidationError("suppress", ["this was not turned into a rule, so there is nothing to suppress; dismiss it instead"]);
    return tx(this.db, () => {
      const now = ts(this.clock.now());
      const suppressionId = get<{ suppression_id: string }>(this.db, "SELECT suppression_id FROM suppressions WHERE project_id = ? AND fingerprint = ?", d.project_id, candidate.fingerprint)?.suppression_id ?? this.ids("sup");
      run(this.db, "INSERT INTO suppressions (suppression_id, project_id, fingerprint, created_by, created_at) VALUES (?,?,?,?,?) ON CONFLICT (project_id, fingerprint) DO UPDATE SET removed_at = NULL, created_by = excluded.created_by, created_at = excluded.created_at",
        suppressionId, d.project_id, candidate.fingerprint, actor.id, now);
      this.ledger.append({
        type: "learning.suppression_added", project_id: d.project_id, actor, subject: { kind: "suppression", id: suppressionId }, refs: { decision_id: decisionId, signal_id: d.signal_id, ...(candidate.rule_id ? { rule_id: candidate.rule_id } : {}) },
        caused_by: this.ledger.byRef("decision_id", decisionId).slice(0, 1).map((e) => e.event_id), summary: `${actor.display_name ?? actor.id} said: don't learn this. The same correction will not be raised again in this project.`, payload: { fingerprint: candidate.fingerprint },
      });
      const ruleId: string | null = candidate.rule_id ?? null;
      if (ruleId) {
        const rule = this.rules.get(ruleId);
        if (rule.status === "candidate") this.rules.reject(ruleId, actor, "don't learn this");
        else if (rule.status === "active" || rule.status === "trial") this.rules.retire(ruleId, actor, "don't learn this");
      }
      for (const i of all<{ inbox_id: string }>(this.db, "SELECT inbox_id FROM inbox_items WHERE signal_id = ? AND status = 'open'", d.signal_id)) this.resolveInbox(i.inbox_id, actor, "don't learn this");
      return { suppression_id: suppressionId, rule_id: ruleId };
    });
  }

  /**
   * A person deletes a signal's wording. The words are removed from every mutable
   * record that held them; immutable records (decisions, ledger) never contained
   * them, so history still verifies. Rules derived from it stay and show "original
   * wording deleted".
   */
  deleteSignalText(signalId: string, actor: Actor): void {
    requireHuman(actor, "Deleting the wording of a correction");
    const sig = get<any>(this.db, "SELECT * FROM signals WHERE signal_id = ? AND workspace_id = ?", signalId, this.workspaceId);
    if (!sig) throw new NotFound("signal", signalId);
    const roles = parse<string[]>(get<{ roles_json: string }>(this.db, "SELECT roles_json FROM principals WHERE principal_id = ?", actor.id)?.roles_json ?? "[]");
    if (sig.author_id && sig.author_id !== actor.id && !roles.includes("owner")) throw new PermissionDenied("only the author or the workspace owner can delete this wording", "not_entitled");
    tx(this.db, () => {
      const now = ts(this.clock.now());
      const record = parse<any>(sig.record_json);
      if (record.content) record.content.text = null;
      run(this.db, "UPDATE signals SET text = NULL, record_json = ?, text_deleted_at = ?, text_deleted_by = ? WHERE signal_id = ?", json(record), now, actor.id, signalId);
      run(this.db, "UPDATE corrections SET text = NULL WHERE signal_id = ?", signalId);
      if (sig.capture_id) run(this.db, "UPDATE capture_events SET content_text = NULL, content_state = 'purged' WHERE capture_id = ?", sig.capture_id);
      for (const i of all<any>(this.db, "SELECT inbox_id, detail_json FROM inbox_items WHERE signal_id = ?", signalId)) {
        const detail = parse<Record<string, unknown>>(i.detail_json);
        if ("text" in detail) detail.text = null;
        run(this.db, "UPDATE inbox_items SET detail_json = ? WHERE inbox_id = ?", json(detail), i.inbox_id);
      }
      this.ledger.append({
        type: "redaction.applied", project_id: sig.project_id, actor, subject: { kind: "signal", id: signalId }, refs: { signal_id: signalId, ...(sig.capture_id ? { capture_id: sig.capture_id } : {}) },
        summary: `${actor.display_name ?? actor.id} deleted the original wording of a correction. Rules made from it stay and say "original wording deleted".`, payload: { removed: ["signal text", "correction text", "captured text", "inbox detail"] },
      });
    });
  }

  // ------------------------------------------------------------ acting on an inbox question (UX-13)
  /**
   * The controls on a "Needs you" item. Each is a person's act on the rule or the
   * question; approving here is the same individual approval as on the rule page,
   * with the real examples the learning evaluation found attached first.
   */
  actOnInbox(inboxId: string, actor: Actor, action: "approve" | "trial" | "reject" | "resume" | "retire" | "not_a_correction" | "suppress" | "dismiss"): InboxItem {
    requireHuman(actor, "Answering a learning inbox item");
    const item = this.toInbox(get<any>(this.db, "SELECT * FROM inbox_items WHERE inbox_id = ? AND workspace_id = ?", inboxId, this.workspaceId) ?? (() => { throw new NotFound("inbox item", inboxId); })());
    if (item.status !== "open") throw new Conflict("already_answered", "this question was already answered");
    const decisionId = get<{ decision_id: string | null }>(this.db, "SELECT decision_id FROM inbox_items WHERE inbox_id = ?", inboxId)!.decision_id;
    return tx(this.db, () => {
      const rule = item.rule_id ? this.rules.get(item.rule_id) : null;
      const needRule = (statuses: string[]): NonNullable<typeof rule> => {
        if (!rule || !statuses.includes(rule.status)) throw new ValidationError("inbox", [`this question has no rule that can be ${action === "trial" ? "tried" : action}d now`]);
        return rule;
      };
      switch (action) {
        case "approve":
        case "trial": {
          const r = needRule(["candidate"]);
          this.attachRealExamples(r.rule_id);
          this.rules.approveAndActivate(r.rule_id, actor, { trial: action === "trial" });
          break;
        }
        case "reject":
          this.rules.reject(needRule(["candidate"]).rule_id, actor, "rejected from the learning inbox");
          break;
        case "resume":
          this.rules.resumeAutoPaused(needRule(["trial"]).rule_id, actor);
          break;
        case "retire":
          this.rules.retire(needRule(["active", "trial"]).rule_id, actor, "retired from the learning inbox");
          break;
        case "not_a_correction":
          if (rule?.status === "candidate") this.rules.reject(rule.rule_id, actor, "not a correction");
          break;
        case "suppress":
          if (!decisionId) throw new ValidationError("inbox", ["there is no learning decision to suppress"]);
          this.suppress(decisionId, actor);
          return this.toInbox(get<any>(this.db, "SELECT * FROM inbox_items WHERE inbox_id = ?", inboxId));
        case "dismiss":
          break;
      }
      const words: Record<string, string> = { approve: "approved and turned on", trial: "approved on trial (note only)", reject: "rejected", resume: "resumed", retire: "retired", not_a_correction: "not a correction", dismiss: "dismissed" };
      return this.resolveInbox(inboxId, actor, words[action]!);
    });
  }

  /** Attach the real blocking and allowing examples the latest learning evaluation found (stored versions only). */
  private attachRealExamples(ruleId: string): void {
    const d = get<{ record_json: string }>(this.db, "SELECT d.record_json FROM learning_decisions d JOIN learning_candidates c ON c.signal_id = d.signal_id WHERE c.rule_id = ? ORDER BY d.rowid DESC LIMIT 1", ruleId);
    const ev = d ? (parse<any>(d.record_json).evaluation as DecisionEvaluation | null) : null;
    if (!ev) return;
    const now = ts(this.clock.now());
    if (ev.trigger_case?.result === "fail") this.rules.addCase(ruleId, { kind: "negative", description: "The version the correction was about (real, from the signal)", artifact_hash: ev.trigger_case.artifact_hash, expect: "fail", last_result: "fail", last_run_at: now });
    for (const c of ev.real_passing_cases.filter((x) => x.result === "pass")) this.rules.addCase(ruleId, { kind: "positive", description: "The corrected version (real, from the same episode)", artifact_hash: c.artifact_hash, expect: "pass", last_result: "pass", last_run_at: now });
  }
}
