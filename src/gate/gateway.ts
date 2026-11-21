/**
 * Receipts and the gateway (docs/06 §3-§6, ADR-006).
 *
 * Three separate authorities, never collapsed:
 *   validation  - a receipt: signed evidence that one exact version met the rules in
 *                 scope for one action at one time. `grants_permission` is false.
 *   permission  - an approval by a person, bound to the receipt, the bytes, the
 *                 action and its parameters. Client (assistant) actors cannot approve.
 *   action      - an adapter, run by the gateway only after re-verifying every
 *                 binding. Nothing executes as a side effect of a check or of a
 *                 learned rule: `execute` begins only from a person's explicit act.
 *
 * Fail closed: any binding that cannot be verified, any dependency that throws,
 * blocks the action and is recorded as `action.blocked`.
 */
import { canonical, digestOf, sha256 } from "../domain/canonical.ts";
import { Conflict, InvariantViolation, NotFound, Unavailable } from "../domain/errors.ts";
import type { IdGen } from "../domain/ids.ts";
import { SYS } from "../domain/ids.ts";
import type { Clock } from "../domain/time.ts";
import { addSeconds, ts } from "../domain/time.ts";
import type { ActionStatus, Actor, Receipt, ReceiptStatus, RunRecord } from "../domain/types.ts";
import type { ProjectService } from "../context/projects.ts";
import { ENGINE_VERSION } from "../engine/evaluate.ts";
import { readArtifact } from "../formats/adapters.ts";
import type { Ledger } from "../ledger/ledger.ts";
import type { RuleService } from "../policy/rules.ts";
import { requireHuman } from "../policy/rules.ts";
import type { Db } from "../store/db.ts";
import { all, get, json, parse, run, tx } from "../store/db.ts";
import type { ActionAdapter } from "./adapters.ts";
import type { Signer } from "./signer.ts";

export const RECEIPT_LIFETIME_SECONDS = 24 * 3600;

export interface GateCheck {
  step: number;
  check: string;
  ok: boolean;
  detail?: string;
}

export interface ActionRequestView {
  action_id: string;
  trace_id: string;
  project_id: string;
  type: string;
  adapter_id: string;
  artifact_id: string;
  content_hash: string;
  params: Record<string, unknown>;
  params_digest: string;
  idempotency_key: string;
  receipt_id: string | null;
  status: ActionStatus;
  status_reason: string | null;
  requested_by: string;
  requested_at: string;
  approval_policy: string;
  approval: { approval_id: string; approved_by: string; approved_at: string; expires_at: string; self_approval: boolean } | null;
  gate_checks: GateCheck[];
  execution: { adapter_id: string; started_at: string; completed_at: string | null; outcome: string | null; executed_content_hash: string | null; simulated: boolean } | null;
}

export interface CoverageEntry {
  action: string;
  label: "GATED" | "ADVISORY" | "OBSERVED" | "NOT_COVERED";
  qualifier: string | null;
  adapter_id: string | null;
  simulated: boolean;
  needs: string[];
  note: string;
}

const statementOf = (r: Receipt): string => {
  const { status: _s, status_reason: _r, consumed_by: _c, signature: _g, ...statement } = r;
  return canonical(statement);
};

export class Gateway {
  private db: Db;
  private ledger: Ledger;
  private clock: Clock;
  private ids: IdGen;
  private rules: RuleService;
  private projects: ProjectService;
  private signer: Signer;
  private adapters: Map<string, ActionAdapter>;

  constructor(deps: { db: Db; ledger: Ledger; clock: Clock; ids: IdGen; rules: RuleService; projects: ProjectService; signer: Signer; adapters: readonly ActionAdapter[] }) {
    this.db = deps.db;
    this.ledger = deps.ledger;
    this.clock = deps.clock;
    this.ids = deps.ids;
    this.rules = deps.rules;
    this.projects = deps.projects;
    this.signer = deps.signer;
    this.adapters = new Map(deps.adapters.map((a) => [a.capability.adapter_id, a]));
  }

  adapterList(): ActionAdapter[] {
    return [...this.adapters.values()];
  }

  private adapterFor(type: string): ActionAdapter | undefined {
    return this.adapterList().find((a) => a.capability.action_types.includes(type));
  }

  /** True when a gateway route exists that could act on a receipt for this action type. */
  gateable(type: string): boolean {
    return this.adapterFor(type)?.capability.availability === "available";
  }

  // ------------------------------------------------------------ receipts
  /**
   * Issue a receipt for a Ready run. Throws (and so issues nothing) if the verdict is
   * not Ready, the context is unresolved, or the signing key is unusable.
   */
  issueReceipt(runRecord: RunRecord, causedBy: string): Receipt {
    if (runRecord.verdict !== "ready") throw new InvariantViolation("receipt_requires_ready", "a receipt is issued only for a Ready verdict");
    if (!runRecord.context.project_id || runRecord.context.status !== "resolved") throw new InvariantViolation("receipt_requires_context", "no receipt without a resolved project");
    const issuedAt = runRecord.completed_at;
    const freshness = runRecord.sources.map((s) => s.fresh_until).filter((f): f is string => !!f).sort();
    const lifetimeEnd = addSeconds(issuedAt, RECEIPT_LIFETIME_SECONDS);
    const receipt: Receipt = {
      schema_version: "cl.receipt/1", receipt_id: this.ids("rcp"), run_id: runRecord.run_id, trace_id: runRecord.trace_id,
      workspace_id: runRecord.context.workspace_id, project_id: runRecord.context.project_id, area_ids: runRecord.context.area_ids, work_type: runRecord.context.work_type,
      artifact: { artifact_id: runRecord.artifact.artifact_id, version_seq: runRecord.artifact.version_seq, content_hash: runRecord.artifact.content_hash },
      action: runRecord.action, policy: { policy_rev: runRecord.policy.policy_rev, ruleset_digest: runRecord.policy.ruleset_digest },
      sources: runRecord.sources, parser: runRecord.artifact.parser, engine_version: runRecord.policy.engine_version,
      exceptions_applied: [], attestations: [], verdict: "ready", issued_at: issuedAt,
      // Default 24 hours, shortened to the earliest freshness limit of any source used.
      expires_at: freshness[0] && freshness[0] < lifetimeEnd ? freshness[0] : lifetimeEnd,
      single_use: true, status: "valid", grants_permission: false,
      signature: { alg: "ed25519", key_id: this.signer.keyId, value: "" },
    };
    receipt.signature.value = this.signer.sign(statementOf(receipt));
    run(this.db, "INSERT INTO receipts (receipt_id, run_id, workspace_id, project_id, artifact_id, content_hash, action_type, record_json, status, issued_at, expires_at) VALUES (?,?,?,?,?,?,?,?, 'valid', ?, ?)",
      receipt.receipt_id, receipt.run_id, receipt.workspace_id, receipt.project_id, receipt.artifact.artifact_id, receipt.artifact.content_hash, receipt.action.type, json(receipt), receipt.issued_at, receipt.expires_at);
    this.ledger.append({
      type: "receipt.issued", project_id: receipt.project_id, actor: { kind: "system", id: SYS.service }, subject: { kind: "receipt", id: receipt.receipt_id },
      refs: { receipt_id: receipt.receipt_id, run_id: receipt.run_id, trace_id: receipt.trace_id, artifact_id: receipt.artifact.artifact_id, content_hash: receipt.artifact.content_hash },
      caused_by: [causedBy], summary: `Receipt issued for ${receipt.action.type}: this exact version met the rules in scope. A receipt is evidence, not permission.`,
      payload: { expires_at: receipt.expires_at, grants_permission: false },
    });
    return receipt;
  }

  getReceipt(receiptId: string): Receipt {
    const row = get<any>(this.db, "SELECT record_json, status, status_reason, consumed_by FROM receipts WHERE receipt_id = ?", receiptId);
    if (!row) throw new NotFound("receipt", receiptId);
    return { ...parse<Receipt>(row.record_json), status: row.status as ReceiptStatus, ...(row.status_reason ? { status_reason: row.status_reason } : {}), ...(row.consumed_by ? { consumed_by: row.consumed_by } : {}) };
  }

  private setReceiptStatus(receipt: Receipt, status: ReceiptStatus, reason: string, causedBy: string[] = [], consumedBy?: string): void {
    if (receipt.status !== "valid") return;
    run(this.db, "UPDATE receipts SET status = ?, status_reason = ?, consumed_by = ? WHERE receipt_id = ? AND status = 'valid'", status, reason, consumedBy ?? null, receipt.receipt_id);
    this.ledger.append({
      type: status === "consumed" ? "receipt.consumed" : status === "expired" ? "receipt.expired" : "receipt.invalidated", project_id: receipt.project_id,
      actor: { kind: "system", id: SYS.gateway }, subject: { kind: "receipt", id: receipt.receipt_id },
      refs: { receipt_id: receipt.receipt_id, run_id: receipt.run_id, ...(consumedBy ? { action_id: consumedBy } : {}) }, caused_by: causedBy,
      summary: status === "consumed" ? "Receipt used; it cannot be used again." : `Receipt is no longer valid: ${reason}.`, payload: { reason },
    });
  }

  /**
   * Re-verify everything a receipt depends on (gateway steps 2 to 8). Pure read:
   * returns the checks; callers decide what to record.
   */
  verifyBindings(receipt: Receipt): GateCheck[] {
    const now = ts(this.clock.now());
    const checks: GateCheck[] = [];
    const add = (step: number, check: string, ok: boolean, detail?: string): void => {
      checks.push({ step, check, ok, ...(detail ? { detail } : {}) });
    };
    const artifact = get<any>(this.db, "SELECT project_id, name FROM artifacts WHERE artifact_id = ?", receipt.artifact.artifact_id);
    add(2, "Context resolves to the receipt's project", !!artifact && artifact.project_id === receipt.project_id && this.projects.resolve({ project_id: receipt.project_id }).status === "resolved",
      artifact && artifact.project_id !== receipt.project_id ? "the artifact now belongs to another project" : undefined);
    const signatureOk = this.signer.verify(statementOf(receipt), receipt.signature.value);
    add(3, "Receipt exists, signature verifies, valid, not expired", signatureOk && receipt.status === "valid" && now <= receipt.expires_at && receipt.grants_permission === false,
      !signatureOk ? "the signature does not verify" : receipt.status !== "valid" ? `the receipt is ${receipt.status}` : now > receipt.expires_at ? "the receipt has expired" : undefined);
    const blob = get<{ bytes: Uint8Array }>(this.db, "SELECT bytes FROM blobs WHERE content_hash = ?", receipt.artifact.content_hash);
    add(4, "Checked bytes hash to the receipt's content hash", !!blob && sha256(blob.bytes) === receipt.artifact.content_hash, blob ? undefined : "the checked bytes are no longer stored");
    const latest = get<{ v: number }>(this.db, "SELECT MAX(version_seq) AS v FROM artifact_versions WHERE artifact_id = ?", receipt.artifact.artifact_id)?.v ?? 0;
    add(5, "No newer version of the artifact exists", latest === receipt.artifact.version_seq, latest > receipt.artifact.version_seq ? `version ${latest} exists and has not been approved` : undefined);
    const runRow = get<{ record_json: string }>(this.db, "SELECT record_json FROM runs WHERE run_id = ?", receipt.run_id);
    const runRecord = runRow ? parse<RunRecord>(runRow.record_json) : null;
    const selection = runRecord ? this.rules.selectInScope({
      project_id: receipt.project_id, area_ids: receipt.area_ids, artifact_id: receipt.artifact.artifact_id, work_type: receipt.work_type,
      artifact_type: runRecord.artifact.artifact_type, action: receipt.action.type,
    }) : null;
    add(6, "In-scope rule set digest unchanged", selection?.ruleset_digest === receipt.policy.ruleset_digest, "a rule in scope was added, changed, paused or retired since the check");
    const stale = receipt.sources.find((s) => {
      const current = this.projects.latestSnapshot(s.source_id);
      return !current || current.snapshot_id !== s.snapshot_id || (s.fresh_until !== undefined && now > s.fresh_until);
    });
    add(7, "Sources still latest and fresh", !stale, stale ? `trusted source ${stale.source_id} has a newer version or is out of date` : undefined);
    let parserOk = receipt.engine_version === ENGINE_VERSION;
    if (parserOk && blob && artifact) {
      const reread = readArtifact(blob.bytes, artifact.name, receipt.work_type);
      parserOk = !!reread.parsed && reread.parsed.parser.id === receipt.parser.id && reread.parsed.parser.version === receipt.parser.version;
    }
    add(8, "Parser and engine versions unchanged", parserOk, "the reader or the check engine was upgraded since the check");
    return checks.map((c) => (c.ok ? { step: c.step, check: c.check, ok: true } : c));
  }

  /** The status a receipt has right now, derived from its bindings (never from a cached flag alone). */
  receiptStanding(receiptId: string): { receipt: Receipt; usable: boolean; failed: GateCheck[] } {
    const receipt = this.getReceipt(receiptId);
    const failed = this.verifyBindings(receipt).filter((c) => !c.ok);
    return { receipt, usable: failed.length === 0, failed };
  }

  // ------------------------------------------------------------ configuration
  /** Who must approve an action in a project is a recorded decision by a person. */
  setActionPolicy(projectId: string, actionType: string, approvalPolicy: "named_role" | "self" | "none_required", actor: Actor): void {
    requireHuman(actor, "Configuring an approval policy");
    const adapter = this.adapterFor(actionType);
    if (!adapter || adapter.capability.availability !== "available") throw new Unavailable(`gate.adapter.${actionType}`, `No adapter is available for "${actionType}" in this build.`);
    this.projects.get(projectId);
    run(this.db, "INSERT INTO action_policies (project_id, action_type, adapter_id, approval_policy, set_by, set_at) VALUES (?,?,?,?,?,?) ON CONFLICT (project_id, action_type) DO UPDATE SET adapter_id = excluded.adapter_id, approval_policy = excluded.approval_policy, set_by = excluded.set_by, set_at = excluded.set_at",
      projectId, actionType, adapter.capability.adapter_id, approvalPolicy, actor.id, ts(this.clock.now()));
  }

  /** Coverage labels generated from what is actually configured (ADR-005) - never aspirational. */
  coverage(projectId: string): CoverageEntry[] {
    const policies = new Map(all<any>(this.db, "SELECT action_type, adapter_id, approval_policy FROM action_policies WHERE project_id = ?", projectId).map((p) => [p.action_type as string, p]));
    const entries: CoverageEntry[] = [];
    for (const type of ["release", "send_external", "pay"]) {
      const adapter = this.adapterFor(type);
      const policy = policies.get(type);
      if (adapter && adapter.capability.availability === "available" && policy) {
        entries.push({
          action: type, label: "GATED", qualifier: adapter.capability.coverage_qualifier, adapter_id: adapter.capability.adapter_id, simulated: adapter.capability.simulated,
          needs: policy.approval_policy === "none_required" ? ["ready_check"] : ["ready_check", "approval"],
          note: adapter.capability.simulated ? "SIMULATED adapter in this build: the gate logic is real, the release itself is only recorded." : "",
        });
      } else {
        entries.push({
          action: type, label: "NOT_COVERED", qualifier: null, adapter_id: null, simulated: false, needs: [],
          note: adapter?.capability.availability === "available" ? "A route exists but is not switched on for this project." : "No adapter is available in this build. Correction Layer cannot block or perform this.",
        });
      }
    }
    entries.push({ action: "assistant_editing", label: "ADVISORY", qualifier: null, adapter_id: null, simulated: false, needs: [], note: "Checks are offered to connected assistants; nothing is blocked." });
    entries.push({ action: "save_in_folder", label: "NOT_COVERED", qualifier: null, adapter_id: null, simulated: false, needs: [], note: "Folder watching is not available in this build." });
    entries.push({ action: "anything_outside_the_app", label: "NOT_COVERED", qualifier: null, adapter_id: null, simulated: false, needs: [], note: "Attaching a file by hand, copying text, printing: not seen, not blocked." });
    return entries;
  }

  // ------------------------------------------------------------ requests
  getAction(actionId: string): ActionRequestView {
    const row = get<any>(this.db, "SELECT * FROM action_requests WHERE action_id = ?", actionId);
    if (!row) throw new NotFound("action request", actionId);
    const approval = get<any>(this.db, "SELECT * FROM approvals WHERE action_id = ? ORDER BY approved_at DESC LIMIT 1", actionId);
    const execution = get<any>(this.db, "SELECT * FROM executions WHERE action_id = ?", actionId);
    const policy = get<any>(this.db, "SELECT approval_policy FROM action_policies WHERE project_id = ? AND action_type = ?", row.project_id, row.type);
    return {
      action_id: row.action_id, trace_id: row.trace_id, project_id: row.project_id, type: row.type, adapter_id: row.adapter_id, artifact_id: row.artifact_id,
      content_hash: row.content_hash, params: parse(row.params_json), params_digest: row.params_digest, idempotency_key: row.idempotency_key, receipt_id: row.receipt_id,
      status: row.status, status_reason: row.status_reason, requested_by: row.requested_by, requested_at: row.requested_at, approval_policy: policy?.approval_policy ?? "named_role",
      approval: approval ? { approval_id: approval.approval_id, approved_by: approval.approved_by, approved_at: approval.approved_at, expires_at: approval.expires_at, self_approval: approval.approved_by === row.requested_by } : null,
      gate_checks: parse<GateCheck[]>(row.gate_checks_json),
      execution: execution ? { adapter_id: execution.adapter_id, started_at: execution.started_at, completed_at: execution.completed_at, outcome: execution.outcome, executed_content_hash: execution.executed_content_hash, simulated: !!execution.simulated } : null,
    };
  }

  listActions(projectId: string): ActionRequestView[] {
    return all<{ action_id: string }>(this.db, "SELECT action_id FROM action_requests WHERE project_id = ? ORDER BY requested_at DESC, rowid DESC", projectId).map((r) => this.getAction(r.action_id));
  }

  /**
   * Ask the gateway to perform a registered action on a checked version. This only
   * records a request awaiting a person; it performs nothing. Idempotent on
   * (artifact version, action type, parameters).
   */
  requestAction(input: { receipt_id: string; type: string; params?: Record<string, unknown> }, actor: Actor): { request: ActionRequestView; deduplicated: boolean } {
    const receipt = this.getReceipt(input.receipt_id);
    const params = input.params ?? {};
    const adapter = this.adapterFor(input.type);
    const policy = get<any>(this.db, "SELECT adapter_id, approval_policy FROM action_policies WHERE project_id = ? AND action_type = ?", receipt.project_id, input.type);
    const refuse = (capability: string, reason: string): never => {
      this.ledger.append({
        type: "action.blocked", project_id: receipt.project_id, actor: { kind: "system", id: SYS.gateway }, subject: { kind: "receipt", id: receipt.receipt_id },
        refs: { receipt_id: receipt.receipt_id, artifact_id: receipt.artifact.artifact_id }, summary: `A request to ${input.type} was refused: ${reason}. Nothing was sent, paid or released.`,
        payload: { step: 1, reason, requested_by: actor.id },
      });
      throw new Unavailable(capability, `${reason}. Nothing was sent, paid or released.`, { action_type: input.type });
    };
    if (!adapter || adapter.capability.availability !== "available") refuse(`gate.adapter.${input.type}`, `no adapter is available for "${input.type}" in this build`);
    if (!policy || policy.adapter_id !== adapter!.capability.adapter_id) refuse("gate.route_not_configured", `"${input.type}" is not switched on for this project`);
    if (receipt.action.type !== input.type) throw new Conflict("receipt_action_mismatch", `the receipt is for ${receipt.action.type}, not ${input.type}: ready for one action is not ready for another`);
    const paramsDigest = digestOf(params);
    const key = digestOf([receipt.artifact.artifact_id, receipt.artifact.content_hash, input.type, paramsDigest]);
    return tx(this.db, () => {
      const existing = get<{ action_id: string }>(this.db, "SELECT action_id FROM action_requests WHERE idempotency_key = ?", key);
      if (existing) return { request: this.getAction(existing.action_id), deduplicated: true };
      const actionId = this.ids("act");
      const status: ActionStatus = policy.approval_policy === "none_required" ? "approved" : "awaiting_approval";
      run(this.db, "INSERT INTO action_requests (action_id, trace_id, workspace_id, project_id, type, adapter_id, artifact_id, content_hash, params_json, params_digest, idempotency_key, receipt_id, status, requested_by, requested_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        actionId, receipt.trace_id, receipt.workspace_id, receipt.project_id, input.type, adapter!.capability.adapter_id, receipt.artifact.artifact_id, receipt.artifact.content_hash,
        json(params), paramsDigest, key, receipt.receipt_id, status, actor.id, ts(this.clock.now()));
      this.ledger.append({
        type: "action.requested", project_id: receipt.project_id, actor, subject: { kind: "action", id: actionId },
        refs: { action_id: actionId, receipt_id: receipt.receipt_id, trace_id: receipt.trace_id, artifact_id: receipt.artifact.artifact_id, content_hash: receipt.artifact.content_hash, adapter_id: adapter!.capability.adapter_id },
        caused_by: this.ledger.byRef("receipt_id", receipt.receipt_id).slice(0, 1).map((e) => e.event_id),
        summary: `${actor.display_name ?? actor.id} asked to ${input.type} version ${receipt.artifact.version_seq}. ${status === "approved" ? "No approval is required here, by a standing decision of a person." : "Waiting for a person's approval."}`,
        payload: { approval_policy: policy.approval_policy, params_digest: paramsDigest },
      });
      return { request: this.getAction(actionId), deduplicated: false };
    });
  }

  /** Approval: a person's decision, bound to the receipt, the bytes, the action and its parameters. */
  approve(actionId: string, actor: Actor): ActionRequestView {
    requireHuman(actor, "Approving an action");
    return tx(this.db, () => {
      const request = this.getAction(actionId);
      if (request.status !== "awaiting_approval") throw new Conflict("not_awaiting_approval", `this request is ${request.status}`);
      const receipt = this.getReceipt(request.receipt_id!);
      const approvalId = this.ids("apr");
      const now = ts(this.clock.now());
      const bound = { receipt_id: receipt.receipt_id, content_hash: request.content_hash, action_type: request.type, params_digest: request.params_digest };
      run(this.db, "INSERT INTO approvals (approval_id, action_id, approved_by, bound_json, approved_at, expires_at) VALUES (?,?,?,?,?,?)", approvalId, actionId, actor.id, json(bound), now, receipt.expires_at);
      run(this.db, "UPDATE action_requests SET status = 'approved' WHERE action_id = ?", actionId);
      this.ledger.append({
        type: "action.approved", project_id: request.project_id, actor, subject: { kind: "action", id: actionId },
        refs: { action_id: actionId, approval_id: approvalId, receipt_id: receipt.receipt_id }, caused_by: this.ledger.byRef("action_id", actionId).slice(-1).map((e) => e.event_id),
        summary: `${actor.display_name ?? actor.id} approved ${request.type}${actor.id === request.requested_by ? " (self-approval)" : ""}. Approval is separate from the check passing.`,
        payload: { bound_to: bound, self_approval: actor.id === request.requested_by, expires_at: receipt.expires_at },
      });
      return this.getAction(actionId);
    });
  }

  reject(actionId: string, actor: Actor, reason: string): ActionRequestView {
    requireHuman(actor, "Rejecting an action");
    return tx(this.db, () => {
      const request = this.getAction(actionId);
      if (request.status !== "awaiting_approval" && request.status !== "approved") throw new Conflict("not_open", `this request is ${request.status}`);
      run(this.db, "UPDATE action_requests SET status = 'rejected', status_reason = ? WHERE action_id = ?", reason, actionId);
      this.ledger.append({ type: "action.rejected", project_id: request.project_id, actor, subject: { kind: "action", id: actionId }, refs: { action_id: actionId }, summary: `${actor.display_name ?? actor.id} rejected ${request.type}.`, payload: { reason } });
      return this.getAction(actionId);
    });
  }

  /**
   * Execute an approved request. Begins only from a person's explicit act; the
   * gateway re-verifies every binding first and never substitutes its own judgment
   * for a missing one. At most once: the request is marked `executing` durably
   * before the adapter is called.
   */
  execute(actionId: string, actor: Actor): ActionRequestView {
    requireHuman(actor, "Starting a gated action");
    const adapterRef: { adapter?: ActionAdapter; bytes?: Uint8Array } = {};
    const proceed = tx(this.db, () => {
      const request = this.getAction(actionId);
      if (request.status !== "approved") throw new Conflict("not_approved", `nothing executes without approval; this request is ${request.status}`);
      const receipt = this.getReceipt(request.receipt_id!);
      const checks: GateCheck[] = [];
      const adapter = this.adapters.get(request.adapter_id);
      const policy = get<any>(this.db, "SELECT adapter_id, approval_policy FROM action_policies WHERE project_id = ? AND action_type = ?", request.project_id, request.type);
      checks.push({ step: 1, check: "Request well formed; adapter enabled for this project", ok: !!adapter && adapter.capability.availability === "available" && policy?.adapter_id === request.adapter_id });
      try {
        checks.push(...this.verifyBindings(receipt));
      } catch (error) {
        // Fail closed: a dependency that cannot answer is a failed binding, not a pass.
        checks.push({ step: 2, check: "Bindings could be verified", ok: false, detail: `a dependency failed: ${error instanceof Error ? error.message : String(error)}` });
      }
      const approval = get<any>(this.db, "SELECT * FROM approvals WHERE action_id = ? ORDER BY approved_at DESC LIMIT 1", actionId);
      const bound = approval ? parse<any>(approval.bound_json) : null;
      const now = ts(this.clock.now());
      const approvalOk = policy?.approval_policy === "none_required"
        || (!!approval && !!get(this.db, "SELECT 1 FROM principals WHERE principal_id = ? AND kind = 'human'", approval.approved_by)
          && bound.receipt_id === receipt.receipt_id && bound.content_hash === receipt.artifact.content_hash && bound.action_type === request.type
          && bound.params_digest === request.params_digest && now <= approval.expires_at);
      checks.push({ step: 9, check: "Approval present, permitted, bound to this receipt and parameters, unexpired", ok: approvalOk });
      run(this.db, "UPDATE action_requests SET gate_checks_json = ? WHERE action_id = ?", json(checks), actionId);
      const failed = checks.find((c) => !c.ok);
      const cause = this.ledger.byRef("action_id", actionId).slice(-1).map((e) => e.event_id);
      if (failed) {
        const paused = failed.step === 5;
        const reason = `${failed.check}${failed.detail ? `: ${failed.detail}` : ""}`;
        run(this.db, "UPDATE action_requests SET status = ?, status_reason = ? WHERE action_id = ?", paused ? "paused_newer_version" : "blocked", reason, actionId);
        const blocked = this.ledger.append({
          type: paused ? "action.paused" : "action.blocked", project_id: request.project_id, actor: { kind: "system", id: SYS.gateway }, subject: { kind: "action", id: actionId },
          refs: { action_id: actionId, receipt_id: receipt.receipt_id }, caused_by: cause,
          summary: paused ? "The gateway paused: a newer version of the file exists. Nothing was released." : `The gateway blocked ${request.type} at step ${failed.step}: ${failed.check}. Nothing was released.`,
          payload: { step: failed.step, check: failed.check, detail: failed.detail ?? null },
        });
        if (failed.step === 3 && receipt.status === "valid" && now > receipt.expires_at) this.setReceiptStatus(receipt, "expired", "time ran out", [blocked.event_id]);
        if (failed.step >= 6 && failed.step <= 8) this.setReceiptStatus(receipt, "invalidated", failed.detail ?? failed.check, [blocked.event_id]);
        return false;
      }
      const revalidated = this.ledger.append({
        type: "action.revalidated", project_id: request.project_id, actor: { kind: "system", id: SYS.gateway }, subject: { kind: "action", id: actionId },
        refs: { action_id: actionId, receipt_id: receipt.receipt_id }, caused_by: cause, summary: "The gateway re-verified the receipt, its bindings and the approval. All hold.", payload: { checks: checks.length },
      });
      run(this.db, "UPDATE action_requests SET status = 'executing' WHERE action_id = ?", actionId);
      run(this.db, "INSERT INTO executions (execution_id, action_id, adapter_id, started_at, simulated) VALUES (?,?,?,?,?)", this.ids("exe"), actionId, request.adapter_id, now, adapter!.capability.simulated ? 1 : 0);
      adapterRef.adapter = adapter!;
      adapterRef.bytes = get<{ bytes: Uint8Array }>(this.db, "SELECT bytes FROM blobs WHERE content_hash = ?", receipt.artifact.content_hash)!.bytes;
      return revalidated.event_id;
    });
    if (proceed === false) return this.getAction(actionId);

    // The request is durably `executing`. The adapter acts on the checked bytes, not on a file path.
    const request = this.getAction(actionId);
    let outcome: { outcome: string; executed_content_hash: string; detail: string } | null = null;
    let failure: string | null = null;
    try {
      outcome = adapterRef.adapter!.execute({ action_id: actionId, type: request.type, params: request.params, bytes: adapterRef.bytes!, content_hash: request.content_hash });
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    return tx(this.db, () => {
      const now = ts(this.clock.now());
      const receipt = this.getReceipt(request.receipt_id!);
      if (outcome) {
        run(this.db, "UPDATE executions SET completed_at = ?, outcome = ?, executed_content_hash = ? WHERE action_id = ?", now, outcome.outcome, outcome.executed_content_hash, actionId);
        run(this.db, "UPDATE action_requests SET status = 'executed', status_reason = ? WHERE action_id = ?", outcome.detail, actionId);
        const executed = this.ledger.append({
          type: "action.executed", project_id: request.project_id, actor: { kind: "adapter", id: request.adapter_id, on_behalf_of: actor.id }, subject: { kind: "action", id: actionId },
          refs: { action_id: actionId, receipt_id: receipt.receipt_id, adapter_id: request.adapter_id, content_hash: outcome.executed_content_hash }, caused_by: [proceed],
          summary: adapterRef.adapter!.capability.simulated ? `SIMULATED ${request.type} recorded by ${adapterRef.adapter!.capability.label}. Nothing left the workspace store.` : `${request.type} performed by ${adapterRef.adapter!.capability.label}.`,
          payload: { outcome: outcome.outcome, simulated: adapterRef.adapter!.capability.simulated, executed_content_hash: outcome.executed_content_hash },
        });
        // Single use: consumed in the same transaction that records the outcome.
        this.setReceiptStatus(receipt, "consumed", `used by ${actionId}`, [executed.event_id], actionId);
      } else {
        run(this.db, "UPDATE executions SET completed_at = ?, outcome = 'failed' WHERE action_id = ?", now, actionId);
        run(this.db, "UPDATE action_requests SET status = 'failed', status_reason = ? WHERE action_id = ?", failure, actionId);
        this.ledger.append({
          type: "action.failed", project_id: request.project_id, actor: { kind: "adapter", id: request.adapter_id }, subject: { kind: "action", id: actionId },
          refs: { action_id: actionId, adapter_id: request.adapter_id }, caused_by: [proceed], summary: `${request.type} failed visibly. Nothing is retried automatically.`, payload: { reason: failure },
        });
      }
      return this.getAction(actionId);
    });
  }

  /**
   * After a restart: a request left `executing` has an unknown outcome. It is shown
   * to a person and never retried automatically (docs/06 §5 "At most once").
   */
  recoverInFlight(): string[] {
    const stuck = all<{ action_id: string; project_id: string }>(this.db, "SELECT action_id, project_id FROM action_requests WHERE status = 'executing'");
    for (const s of stuck) {
      tx(this.db, () => {
        run(this.db, "UPDATE action_requests SET status = 'outcome_unknown', status_reason = 'the service stopped before the outcome was recorded' WHERE action_id = ?", s.action_id);
        this.ledger.append({
          type: "action.outcome_unknown", project_id: s.project_id, actor: { kind: "system", id: SYS.gateway }, subject: { kind: "action", id: s.action_id }, refs: { action_id: s.action_id },
          summary: "The service stopped while an action was running. Its outcome is unknown; it will not be retried automatically.",
        });
      });
    }
    return stuck.map((s) => s.action_id);
  }
}
