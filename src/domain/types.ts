/**
 * Typed domain contracts. These mirror the proposed JSON Schemas in /schemas
 * (the schemas stay the wire-level source of truth; see src/contracts/schemas.ts).
 * Type-only module: nothing here executes.
 */

// ---------------------------------------------------------------- shared
export type Method = "deterministic" | "source_backed" | "attested" | "model_review";
export type Enforcement = "block" | "warn";
export type Outcome = "pass" | "fail" | "unknown" | "error" | "not_applicable" | "waived" | "conflict" | "skipped";
export type Verdict = "ready" | "needs_changes" | "could_not_verify";
export type RuleStatus = "candidate" | "trial" | "active" | "suspended" | "retired" | "rejected";
export type ArtifactType = "document" | "spreadsheet" | "pdf" | "presentation" | "record" | "email" | "text";
export type ScopeLevel = "workspace" | "project_group" | "project" | "area" | "artifact";

export type ActorKind = "human" | "agent" | "system" | "adapter";
export interface Actor {
  kind: ActorKind;
  id: string;
  display_name?: string;
  on_behalf_of?: string;
  session_id?: string;
}

export interface Location {
  locator: string;
  label: string;
}

export interface TypedValue {
  type: "text" | "number" | "money" | "percent" | "date" | "boolean" | "list" | "unknown";
  text?: string;
  number?: string;
  amount?: string;
  currency?: string;
  date?: string;
  boolean?: boolean;
  items?: unknown[];
  reason?: string;
}

export type Predicate =
  | { all: Predicate[] }
  | { any: Predicate[] }
  | { not: Predicate }
  | { field: string; op: "eq" | "ne" | "in" | "not_in" | "lt" | "le" | "gt" | "ge" | "exists"; value?: unknown };

// ---------------------------------------------------------------- rules
export const CHECK_KINDS = [
  "field_present", "field_in_set", "fields_agree", "number_compare", "date_window", "arithmetic_consistency",
  "section_present", "text_contains", "no_unresolved_markup", "field_matches_source", "attestation",
  "no_hidden_content", "rows_unique", "value_is_formula", "model_review",
] as const;
export type CheckKind = (typeof CHECK_KINDS)[number];

export interface RuleScope {
  level: ScopeLevel;
  workspace_id: string;
  project_selector?: { fact: string; equals: string } | null;
  project_id?: string | null;
  area_id?: string | null;
  artifact_id?: string | null;
  work_types: string[];
  artifact_types: ArtifactType[];
  actions: string[];
}

export interface RuleCheck {
  kind: CheckKind;
  targets: string[];
  params: Record<string, unknown>;
}

export interface RuleCase {
  case_id: string;
  kind: "negative" | "positive";
  description: string;
  artifact_hash: string;
  source_snapshot_id?: string;
  expect: Outcome;
  last_result?: Outcome;
  last_run_at?: string;
}

export interface RuleAuthority {
  kind: "individual_approval" | "delegated_learning";
  zero_click: boolean;
  learning_policy_id?: string;
  learning_policy_revision?: number;
  decision_id?: string;
  delegated_by?: string;
  confirmed?: { by: string; at: string } | null;
  auto_paused?: { at: string; reason: string; paused_from?: RuleStatus } | null;
}

export interface RuleApproval {
  proposed_by?: string;
  approved_by: string;
  approved_at: string;
  activated_at?: string;
  self_approval?: boolean;
  policy_rev?: number;
}

/** The immutable content of one rule revision (cl.rule/1 without the projected lifecycle fields). */
export interface RuleRevisionContent {
  schema_version: "cl.rule/1";
  rule_id: string;
  revision: number;
  supersedes?: number | null;
  title: string;
  statement: string;
  origin: { kind: "human_correction" | "starter_pack" | "imported_pack"; correction_id?: string; pack?: string; signal_ids?: string[] };
  owner: string;
  review_by: string;
  scope: RuleScope;
  applies_when?: Predicate | null;
  method: Method;
  enforcement: Enforcement;
  locked?: boolean;
  check: RuleCheck;
  requires: { fields: string[]; components: string[] };
  source?: { source_id: string; max_age_days: number; require_latest: boolean; missing_key: "unknown" | "fail" } | null;
  message: { problem: string; fix_hint?: string };
  cases: RuleCase[];
  exception_policy?: { grantable_by: Array<"rule_owner" | "workspace_steward" | "project_steward">; max_days: number };
}

/** The client-facing shape: revision content plus lifecycle fields projected from the ledger. */
export interface Rule extends RuleRevisionContent {
  status: RuleStatus;
  authority?: RuleAuthority;
  approval?: RuleApproval | null;
}

// ---------------------------------------------------------------- artifacts
export type CoverageState = "parsed" | "partial" | "detected_not_parsed" | "unsupported" | "absent";

export interface ArtifactField {
  path: string;
  value: TypedValue;
  method: "structural" | "mapping" | "pattern" | "ocr" | "model_suggested" | "human_confirmed";
  confidence: number;
  mapping_id?: string;
  locations: Location[];
}

export interface ContentBlock {
  locator: string;
  kind: string;
  text?: string;
  label?: string;
}

export interface NormalizedArtifact {
  schema_version: "cl.artifact/1";
  artifact_id: string;
  name: string;
  version: { seq: number; content_hash: string; size_bytes?: number; observed_at: string };
  identity: { declared_extension: string; detected_type: string; detection: "signature" | "container_inspection" | "structural"; extension_matches: boolean };
  artifact_type: ArtifactType;
  parser: { id: string; version: string };
  coverage: Array<{ component: string; state: CoverageState; content_bearing: boolean; detail?: string }>;
  content: { blocks: ContentBlock[]; abridged?: boolean };
  fields: ArtifactField[];
  risk_flags?: Array<{ flag: string; count?: number; locations?: Location[]; detail?: string }>;
}

// ---------------------------------------------------------------- context
export interface ResolvedContext {
  workspace_id: string;
  project_id: string | null;
  area_ids: string[];
  work_type: string;
  status: "resolved" | "ambiguous" | "unknown";
  basis: string[];
  /** Project facts confirmed by people; never taken from artifact content. */
  facts: Record<string, string>;
}

export interface ActionEnvelope {
  type: string;
  params?: Record<string, unknown>;
}

// ---------------------------------------------------------------- sources
export interface SourceRow {
  row: number;
  key: Record<string, string>;
  values: Record<string, string>;
}

export interface SourceSnapshot {
  source_id: string;
  snapshot_id: string;
  imported_at: string;
  confirmed_at: string;
  superseded: boolean;
  rows: SourceRow[];
}

export interface SourceUse {
  source_id: string;
  snapshot_id: string;
  imported_at?: string;
  confirmed_at?: string;
  age_days?: number;
  fresh: boolean;
  fresh_until?: string;
}

// ---------------------------------------------------------------- runs
export interface Finding {
  finding_id: string;
  location: Location;
  field_path?: string;
  found: TypedValue;
  expected: TypedValue;
  evidence?: Record<string, unknown>;
  message: string;
  fix_hint?: string;
}

export interface RuleResult {
  rule_id: string;
  revision: number;
  title: string;
  rule_status: RuleStatus;
  method: Method;
  enforcement: Enforcement;
  effective_enforcement: Enforcement;
  outcome: Outcome;
  reason: string;
  source_snapshot_id?: string;
  compared?: number;
  findings: Finding[];
}

export interface RunCounts {
  in_scope: number;
  pass: number;
  fail: number;
  unknown: number;
  not_applicable: number;
  error: number;
  conflict: number;
  waived: number;
  skipped: number;
  notes: number;
  blocking_findings: number;
}

export interface RunRecord {
  schema_version: "cl.run/1";
  run_id: string;
  trace_id: string;
  trigger: { kind: "user_request" | "agent_call" | "auto_recheck" | "pre_action" | "backtest" | "case_suite"; reason: string; action_id?: string };
  started_at: string;
  completed_at: string;
  as_of: string;
  display_tz: string;
  actor: Actor;
  context: { workspace_id: string; project_id: string | null; area_ids: string[]; work_type: string; status: string; basis: string[] };
  artifact: { artifact_id: string; name: string; version_seq: number; content_hash: string; artifact_type: ArtifactType; parser: { id: string; version: string } };
  action: { type: string; params_digest: string | null };
  policy: { policy_rev: number; policy_as_of?: string; ruleset_digest: string; engine_version: string };
  sources: SourceUse[];
  inventory: { workspace_active_rules: number; in_scope: number; out_of_scope: number; out_of_scope_recomputable: boolean };
  coverage_gaps: Array<{ component: string; state: string; detail?: string }>;
  results: RuleResult[];
  verdict: Verdict;
  counts: RunCounts;
  fix_proposal_ids: string[];
  receipt_id: string | null;
  reproducibility: { deterministic: boolean; inputs_digest: string; non_reproducible_rules: string[] };
}

// ---------------------------------------------------------------- gate
export type ReceiptStatus = "valid" | "invalidated" | "expired" | "consumed";

export interface Receipt {
  schema_version: "cl.receipt/1";
  receipt_id: string;
  run_id: string;
  trace_id: string;
  workspace_id: string;
  project_id: string;
  area_ids: string[];
  work_type: string;
  artifact: { artifact_id: string; version_seq: number; content_hash: string };
  action: { type: string; params_digest: string | null };
  policy: { policy_rev: number; ruleset_digest: string };
  sources: SourceUse[];
  parser: { id: string; version: string };
  engine_version: string;
  exceptions_applied: string[];
  attestations: string[];
  verdict: "ready";
  issued_at: string;
  expires_at: string;
  single_use: true;
  status: ReceiptStatus;
  status_reason?: string;
  consumed_by?: string;
  /** Stated in the data itself: a receipt is evidence, not authorization. */
  grants_permission: false;
  signature: { alg: "ed25519"; key_id: string; value: string };
}

export type ActionStatus =
  | "awaiting_approval" | "approved" | "executing" | "executed" | "blocked" | "rejected"
  | "paused_newer_version" | "failed" | "outcome_unknown" | "cancelled";

// ---------------------------------------------------------------- capture
export const CAPTURE_KINDS = [
  "session_start", "user_turn", "agent_output", "tool_output", "edit_observed", "review_action", "heartbeat", "session_end",
] as const;
export type CaptureKind = (typeof CAPTURE_KINDS)[number];

export interface CaptureEvent {
  schema_version: "cl.capture_event/1";
  capture_id: string;
  adapter_id: string;
  stream_id: string;
  source_seq: number;
  kind: CaptureKind;
  occurred_at: string;
  role: "user" | "agent" | "tool" | "system";
  attested_by: "runtime_hook" | "app" | "runtime_transcript" | "none";
  binding: { binding_id: string | null; project_id: string | null; artifact_id?: string; content_hash?: string };
  content: { text: string | null; language?: string } | null;
  content_state: "present" | "not_sent" | "purged" | "held_for_review";
  content_digest: string;
  final_seq?: number;
}

export type IntakeResult = "accepted" | "held_out_of_order" | "duplicate" | "rejected_conflict" | "dead_letter" | "consent_blocked";
export type IntakeValidation = "ok" | "unsupported_event_kind" | "schema_invalid" | "consent_missing";
export type DeliveryMode = "live" | "replay" | "backfill";
export type StreamHealth = "healthy" | "lagging" | "gap" | "stale" | "degraded" | "disconnected";

// ---------------------------------------------------------------- learning
export type LearningMode = "off" | "suggest" | "quiet" | "auto_low_risk";
export type Surface = "app" | "attested_user_turn" | "assistant_relay" | "folder_watch" | "review_action";
export type Trust = "user_direct" | "assistant_relayed" | "observed_edit" | "untrusted_content";

export interface LearningPolicy {
  schema_version: "cl.learning_policy/1";
  learning_policy_id: string;
  revision: number;
  workspace_id: string;
  scope: { level: "project" | "area"; project_id: string; area_id?: string | null };
  mode: LearningMode;
  set_by: Actor;
  set_at: string;
  display_tz?: string;
  surfaces: Array<{ surface: Surface; enabled: boolean; adapter_id?: string; max_outcome: "auto" | "shadow" | "inbox" }>;
  learn_from: string[];
  inbox_resolvers: string[];
  auto: { max_scope_level: "artifact" | "area" | "project"; check_kinds: CheckKind[]; methods: Method[]; enforcement_max: Enforcement };
  limits: {
    calibration: "proposed_uncalibrated";
    recurrence_min_episodes: number;
    min_real_pass: number;
    max_heldout_failures: number;
    max_auto_activations_per_day: number;
    candidate_expiry_days: number;
    learned_rule_review_days: number;
  };
  auto_pause: Record<string, unknown>;
  capture: { calibration: "proposed_uncalibrated"; late_after_hours: number; gap_timeout_seconds: number; non_signal_review_days: number; dead_letter_days: number; backfill_max_outcome: "inbox" | "shadow" };
  never_learned: string[];
  retention: { signal_text_days: number; one_off_episode_days: number };
  revoked: { by: string; at: string; learned_rules: "keep" | "demote_to_shadow" } | null;
}

export type SignalType = "standing_instruction" | "direct_correction" | "human_edit_diff" | "agent_retry" | "rejection_reason" | "finding_dispute";

/** One signal as the decision procedure sees it (cl.learning_decision/1 `signals[]`). */
export interface DecisionSignal {
  signal_id: string;
  type: SignalType;
  surface: Surface;
  trust: Trust;
  author_id: string | null;
  episode_id: string;
  text_matches_artifact_content: boolean;
  delivery: DeliveryMode | "not_captured";
  late: boolean;
  episode_capture_complete: boolean;
}

export interface DecisionCandidate {
  rule_id?: string | null;
  revision?: number | null;
  statement?: string;
  operation: "add_requirement" | "weaken_or_remove" | "permission_change";
  check_kind?: CheckKind | null;
  method?: Method | null;
  scope_level?: ScopeLevel | null;
  scope_project_id?: string | null;
  widening_requested?: "project_group" | "workspace" | null;
  touches_protected_targets: boolean;
  pins_fact_without_source: boolean;
  reusability: "explicit_standing" | "recurring" | "one_off" | "unclear";
  referent_resolved: boolean;
  parameters_grounded: boolean;
  hedged: boolean;
  language_supported: boolean;
  /** Concerns raised by an AI model. They can only make the outcome more cautious. */
  model_flags: string[];
  targets_rule_id?: string | null;
}

export interface EvidenceCase {
  artifact_hash: string;
  description: string;
  kind: "trigger_version" | "corrected_version" | "accepted_existing";
  expect: Outcome;
  result: Outcome;
}

export interface DecisionEvaluation {
  evaluation_id: string;
  trigger_case: EvidenceCase | null;
  real_passing_cases: EvidenceCase[];
  heldout: { artifacts: number; pass: number; fail: number; unknown: number; error: number; not_applicable: number };
  generated: { run: number; unexpected: number; counted_as_support: false };
  conflicts: string[];
  duplicates: string[];
  contradicts_learned: string[];
  auto_activations_today: number;
}

export type DecisionOutcome =
  | "auto_activate" | "auto_shadow" | "shadow_and_inbox" | "inbox" | "waiting_for_evidence" | "record_only" | "declined" | "discarded";

/** The recorded inputs of one decision. Note what is absent: there is no model-confidence field. */
export interface DecisionInput {
  signals: DecisionSignal[];
  independent_episodes: number;
  suppressed: boolean;
  candidate: DecisionCandidate | null;
  evaluation: DecisionEvaluation | null;
}
