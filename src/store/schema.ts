/**
 * Migration 001: the Phase 1 workspace store.
 *
 * Table groups follow docs/03 §3. Insert-only tables carry triggers that reject
 * UPDATE and DELETE as defence in depth (real tamper evidence is the ledger hash
 * chain). Mutable tables are read models or operational state, and say so.
 *
 * Do not edit this text after it has shipped: add migration 002 instead
 * (src/store/migrations.ts checks the checksum of applied migrations).
 */
const immutable = (table: string, what: string): string => `
CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table}
BEGIN SELECT RAISE(ABORT, 'immutable: ${what} are insert-only'); END;
CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table}
BEGIN SELECT RAISE(ABORT, 'immutable: ${what} are insert-only'); END;`;

export const IMMUTABLE_TABLES = [
  "policy_revisions", "rule_revisions", "source_snapshots", "artifact_versions", "runs", "check_results",
  "approvals", "events", "learning_policies", "capture_deliveries", "learning_decisions",
] as const;

export const M001_INIT = `
-- ------------------------------------------------------------------ identity
CREATE TABLE workspace (
  workspace_id TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  display_tz   TEXT NOT NULL,
  is_demo      INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL
);
CREATE TABLE principals (
  principal_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(workspace_id),
  kind         TEXT NOT NULL CHECK (kind IN ('human','agent')),
  display_name TEXT NOT NULL,
  roles_json   TEXT NOT NULL DEFAULT '[]',
  created_at   TEXT NOT NULL
);
CREATE TABLE projects (
  project_id        TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL REFERENCES workspace(workspace_id),
  name              TEXT NOT NULL,
  default_work_type TEXT NOT NULL,
  is_demo           INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL
);
CREATE TABLE project_facts (
  project_id   TEXT NOT NULL REFERENCES projects(project_id),
  key          TEXT NOT NULL,
  value        TEXT NOT NULL,
  confirmed_by TEXT NOT NULL,
  confirmed_at TEXT NOT NULL,
  PRIMARY KEY (project_id, key)
);
CREATE TABLE folder_bindings (
  binding_id   TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(workspace_id),
  project_id   TEXT NOT NULL REFERENCES projects(project_id),
  path         TEXT NOT NULL UNIQUE,
  kind         TEXT NOT NULL DEFAULT 'project_root',
  created_at   TEXT NOT NULL
);

-- ------------------------------------------------------------------ policy
CREATE TABLE policy_revisions (
  policy_rev   INTEGER PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  reason       TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE TABLE corrections (
  correction_id TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL,
  project_id    TEXT,
  author_id     TEXT NOT NULL,
  channel       TEXT NOT NULL,
  text          TEXT,                 -- nullable: a person may delete the wording later
  signal_id     TEXT,
  record_json   TEXT NOT NULL,
  recorded_at   TEXT NOT NULL
);
CREATE TABLE rule_revisions (
  rule_id        TEXT NOT NULL,
  revision       INTEGER NOT NULL,
  workspace_id   TEXT NOT NULL,
  content_json   TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  PRIMARY KEY (rule_id, revision)
);
-- Stored examples of a rule (docs/03 §3 lists cases apart from revisions): real artifact
-- versions with an expected outcome. Evidence can arrive after the candidate is saved.
CREATE TABLE rule_cases (
  case_id       TEXT PRIMARY KEY,
  rule_id       TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('negative','positive')),
  description   TEXT NOT NULL,
  artifact_hash TEXT NOT NULL,
  expect        TEXT NOT NULL,
  last_result   TEXT,
  last_run_at   TEXT,
  UNIQUE (rule_id, kind, artifact_hash)
);
-- Read model: lifecycle state projected from ledger events (mutable by design).
CREATE TABLE rule_state (
  rule_id          TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL,
  project_id       TEXT,              -- null for workspace / project_group rules
  current_revision INTEGER NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('candidate','trial','active','suspended','retired','rejected')),
  authority_json   TEXT,
  approval_json    TEXT,
  activated_at     TEXT,
  updated_at       TEXT NOT NULL
);
-- Materialized, deterministic scope index (docs/04 §5). Selection is one exact-or-any lookup.
CREATE TABLE rule_scope_index (
  rule_id       TEXT NOT NULL,
  revision      INTEGER NOT NULL,
  workspace_id  TEXT NOT NULL,
  project_key   TEXT NOT NULL,
  area_key      TEXT NOT NULL,
  artifact_key  TEXT NOT NULL,
  work_type     TEXT NOT NULL,
  artifact_type TEXT NOT NULL,
  action        TEXT NOT NULL,
  status        TEXT NOT NULL
);
CREATE INDEX rule_scope_lookup ON rule_scope_index (workspace_id, project_key, work_type, artifact_type, action, status);
CREATE INDEX rule_scope_rule ON rule_scope_index (rule_id);

-- ------------------------------------------------------------------ sources
CREATE TABLE sources (
  source_id    TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name         TEXT NOT NULL,
  owner        TEXT NOT NULL,
  record_json  TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE TABLE source_snapshots (
  snapshot_id  TEXT PRIMARY KEY,
  source_id    TEXT NOT NULL REFERENCES sources(source_id),
  content_hash TEXT NOT NULL,
  imported_by  TEXT NOT NULL,
  imported_at  TEXT NOT NULL,
  confirmed_at TEXT NOT NULL,
  rows_json    TEXT NOT NULL
);
CREATE INDEX source_snapshots_latest ON source_snapshots (source_id, imported_at);

-- ------------------------------------------------------------------ work
CREATE TABLE artifacts (
  artifact_id  TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id   TEXT NOT NULL REFERENCES projects(project_id),
  name         TEXT NOT NULL,
  is_demo      INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  UNIQUE (project_id, name)
);
CREATE TABLE artifact_versions (
  artifact_id     TEXT NOT NULL REFERENCES artifacts(artifact_id),
  version_seq     INTEGER NOT NULL,
  content_hash    TEXT NOT NULL,
  size_bytes      INTEGER NOT NULL,
  normalized_json TEXT,               -- null when the bytes could not be read
  parse_error     TEXT,
  observed_at     TEXT NOT NULL,
  PRIMARY KEY (artifact_id, version_seq),
  UNIQUE (artifact_id, content_hash)
);
-- Checked bytes, addressed by hash (design: blobs/ directory; Phase 1 keeps them in the store).
CREATE TABLE blobs (
  content_hash TEXT PRIMARY KEY,
  bytes        BLOB NOT NULL,
  size_bytes   INTEGER NOT NULL
);
CREATE TABLE artifact_risk_flags (
  artifact_id TEXT NOT NULL,
  flag        TEXT NOT NULL,
  detail      TEXT NOT NULL,
  raised_at   TEXT NOT NULL,
  event_id    TEXT
);
CREATE TABLE runs (
  run_id         TEXT PRIMARY KEY,
  trace_id       TEXT NOT NULL,
  workspace_id   TEXT NOT NULL,
  project_id     TEXT,
  artifact_id    TEXT NOT NULL,
  version_seq    INTEGER NOT NULL,
  content_hash   TEXT NOT NULL,
  action_type    TEXT NOT NULL,
  verdict        TEXT NOT NULL CHECK (verdict IN ('ready','needs_changes','could_not_verify')),
  policy_rev     INTEGER NOT NULL,
  ruleset_digest TEXT NOT NULL,
  record_json    TEXT NOT NULL,
  completed_at   TEXT NOT NULL
);
CREATE INDEX runs_by_artifact ON runs (artifact_id, completed_at);
CREATE INDEX runs_by_project ON runs (project_id, completed_at);
-- "Show me every time rule X was evaluated" is an indexed query (docs/02 §4.2).
CREATE TABLE check_results (
  run_id                TEXT NOT NULL REFERENCES runs(run_id),
  rule_id               TEXT NOT NULL,
  revision              INTEGER NOT NULL,
  outcome               TEXT NOT NULL,
  effective_enforcement TEXT NOT NULL,
  PRIMARY KEY (run_id, rule_id)
);
CREATE INDEX check_results_by_rule ON check_results (rule_id);

-- ------------------------------------------------------------------ gate
CREATE TABLE receipts (
  receipt_id    TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL REFERENCES runs(run_id) DEFERRABLE INITIALLY DEFERRED,
  workspace_id  TEXT NOT NULL,
  project_id    TEXT NOT NULL,
  artifact_id   TEXT NOT NULL,
  content_hash  TEXT NOT NULL,
  action_type   TEXT NOT NULL,
  record_json   TEXT NOT NULL,        -- the signed statement; never rewritten
  status        TEXT NOT NULL CHECK (status IN ('valid','invalidated','expired','consumed')),
  status_reason TEXT,
  consumed_by   TEXT,
  issued_at     TEXT NOT NULL,
  expires_at    TEXT NOT NULL
);
CREATE TRIGGER receipts_statement_frozen BEFORE UPDATE OF record_json, run_id, content_hash, action_type, expires_at ON receipts
BEGIN SELECT RAISE(ABORT, 'immutable: a receipt statement is never rewritten'); END;
CREATE TABLE action_adapters (
  adapter_id   TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  kind         TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1,
  record_json  TEXT NOT NULL
);
CREATE TABLE action_policies (
  project_id      TEXT NOT NULL,
  action_type     TEXT NOT NULL,
  adapter_id      TEXT NOT NULL,
  approval_policy TEXT NOT NULL CHECK (approval_policy IN ('named_role','self','none_required')),
  set_by          TEXT NOT NULL,
  set_at          TEXT NOT NULL,
  PRIMARY KEY (project_id, action_type)
);
CREATE TABLE action_requests (
  action_id       TEXT PRIMARY KEY,
  trace_id        TEXT NOT NULL,
  workspace_id    TEXT NOT NULL,
  project_id      TEXT NOT NULL,
  type            TEXT NOT NULL,
  adapter_id      TEXT NOT NULL,
  artifact_id     TEXT NOT NULL,
  content_hash    TEXT NOT NULL,
  params_json     TEXT NOT NULL,
  params_digest   TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  receipt_id      TEXT,
  status          TEXT NOT NULL,
  status_reason   TEXT,
  requested_by    TEXT NOT NULL,
  requested_at    TEXT NOT NULL,
  gate_checks_json TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE approvals (
  approval_id  TEXT PRIMARY KEY,
  action_id    TEXT NOT NULL REFERENCES action_requests(action_id),
  approved_by  TEXT NOT NULL,
  bound_json   TEXT NOT NULL,
  approved_at  TEXT NOT NULL,
  expires_at   TEXT NOT NULL
);
CREATE TABLE executions (
  execution_id          TEXT PRIMARY KEY,
  action_id             TEXT NOT NULL UNIQUE REFERENCES action_requests(action_id),
  adapter_id            TEXT NOT NULL,
  started_at            TEXT NOT NULL,
  completed_at          TEXT,
  outcome               TEXT,
  executed_content_hash TEXT,
  simulated             INTEGER NOT NULL
);

-- ------------------------------------------------------------------ ledger
CREATE TABLE events (
  seq            INTEGER PRIMARY KEY,
  event_id       TEXT NOT NULL UNIQUE,
  type           TEXT NOT NULL,
  occurred_at    TEXT NOT NULL,
  workspace_id   TEXT NOT NULL,
  project_id     TEXT,
  envelope_json  TEXT NOT NULL,       -- the event without payload
  payload_digest TEXT NOT NULL,
  prev_hash      TEXT NOT NULL,
  hash           TEXT NOT NULL
);
CREATE INDEX events_by_project ON events (project_id, seq);
CREATE INDEX events_by_type ON events (type, seq);
-- Payloads live apart so evidence can be erased under retention without touching the chain.
CREATE TABLE event_payloads (
  event_id      TEXT PRIMARY KEY REFERENCES events(event_id),
  payload_json  TEXT,
  payload_state TEXT NOT NULL CHECK (payload_state IN ('present','erased'))
);
CREATE TRIGGER event_payloads_erase_only BEFORE UPDATE ON event_payloads
WHEN NEW.payload_json IS NOT NULL OR NEW.payload_state <> 'erased' OR NEW.event_id <> OLD.event_id
BEGIN SELECT RAISE(ABORT, 'immutable: an event payload can only be erased'); END;
CREATE TRIGGER event_payloads_no_delete BEFORE DELETE ON event_payloads
BEGIN SELECT RAISE(ABORT, 'immutable: an event payload can only be erased'); END;
CREATE TABLE event_refs (
  seq   INTEGER NOT NULL,
  key   TEXT NOT NULL,
  value TEXT NOT NULL
);
CREATE INDEX event_refs_lookup ON event_refs (key, value, seq);
CREATE TABLE event_causes (
  seq       INTEGER NOT NULL,
  caused_by TEXT NOT NULL
);
CREATE INDEX event_causes_lookup ON event_causes (caused_by);

-- ------------------------------------------------------------------ capture
CREATE TABLE learning_policies (
  learning_policy_id TEXT NOT NULL,
  revision           INTEGER NOT NULL,
  workspace_id       TEXT NOT NULL,
  project_id         TEXT NOT NULL,
  mode               TEXT NOT NULL CHECK (mode IN ('off','suggest','quiet','auto_low_risk')),
  set_by             TEXT NOT NULL,
  set_at             TEXT NOT NULL,
  content_json       TEXT NOT NULL,
  PRIMARY KEY (learning_policy_id, revision)
);
CREATE INDEX learning_policies_by_project ON learning_policies (project_id, revision);
CREATE TABLE capture_adapters (
  adapter_id   TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('runtime_hook','app_native','folder_watch','app_connector')),
  label        TEXT NOT NULL,
  simulated    INTEGER NOT NULL DEFAULT 0,
  record_json  TEXT NOT NULL,
  paired_by    TEXT NOT NULL,
  paired_at    TEXT NOT NULL,
  revoked_at   TEXT
);
-- Operational state of one stream (mutable): cursors, counters, health.
CREATE TABLE capture_streams (
  stream_id          TEXT PRIMARY KEY,
  workspace_id       TEXT NOT NULL,
  adapter_id         TEXT NOT NULL REFERENCES capture_adapters(adapter_id),
  session_id         TEXT,
  author_id          TEXT,            -- the person whose turns this stream attests (who paired the adapter, or the app user)
  project_id         TEXT,            -- project of the stream at its current position
  opened_at          TEXT NOT NULL,
  closed_at          TEXT,
  cursor             INTEGER NOT NULL DEFAULT 0,   -- highest seq received with nothing missing below
  processed_through  INTEGER NOT NULL DEFAULT 0,   -- highest seq handed to the signal detector
  adapter_last_seq   INTEGER NOT NULL DEFAULT 0,   -- what the adapter says it has
  final_seq          INTEGER,
  status             TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed_complete','closed_incomplete')),
  integrity_flag     TEXT,
  duplicates_dropped INTEGER NOT NULL DEFAULT 0,
  held_out_of_order  INTEGER NOT NULL DEFAULT 0,
  consent_blocked    INTEGER NOT NULL DEFAULT 0,
  last_heard_at      TEXT NOT NULL
);
-- One row per sequence number ever received: the idempotency record.
CREATE TABLE capture_received (
  stream_id      TEXT NOT NULL REFERENCES capture_streams(stream_id),
  source_seq     INTEGER NOT NULL,
  capture_id     TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  result         TEXT NOT NULL,
  received_at    TEXT NOT NULL,
  PRIMARY KEY (stream_id, source_seq)
);
-- Every delivery attempt, in arrival order, including repeats.
CREATE TABLE capture_deliveries (
  arrival        INTEGER PRIMARY KEY AUTOINCREMENT,
  stream_id      TEXT NOT NULL,
  source_seq     INTEGER NOT NULL,
  capture_id     TEXT NOT NULL,
  delivery       TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  validation     TEXT NOT NULL,
  result         TEXT NOT NULL,
  ack_through    INTEGER NOT NULL,
  received_at    TEXT NOT NULL
);
CREATE INDEX capture_deliveries_by_stream ON capture_deliveries (stream_id, arrival);
-- Valid events. Content is nulled when consent is missing or retention removes it.
CREATE TABLE capture_events (
  capture_id    TEXT PRIMARY KEY,
  stream_id     TEXT NOT NULL,
  source_seq    INTEGER NOT NULL,
  workspace_id  TEXT NOT NULL,
  project_id    TEXT,                 -- resolved by the intake, not trusted from the adapter
  bound         INTEGER NOT NULL,     -- 1 when bound to exactly one project
  kind          TEXT NOT NULL,
  role          TEXT NOT NULL,
  attested_by   TEXT NOT NULL,
  delivery      TEXT NOT NULL,
  occurred_at   TEXT NOT NULL,
  received_at   TEXT NOT NULL,
  content_state TEXT NOT NULL,
  content_text  TEXT,
  language      TEXT,
  artifact_id   TEXT,
  content_hash  TEXT,
  content_digest TEXT NOT NULL,
  stage         TEXT NOT NULL DEFAULT 'captured',
  disposition   TEXT,
  UNIQUE (stream_id, source_seq)
);
CREATE INDEX capture_events_by_project ON capture_events (project_id, received_at);
CREATE TABLE capture_dead_letters (
  stream_id   TEXT NOT NULL,
  source_seq  INTEGER NOT NULL,
  capture_id  TEXT,
  stage       TEXT NOT NULL CHECK (stage IN ('intake','processing')),
  reason      TEXT NOT NULL,
  raw_json    TEXT,
  attempts    INTEGER NOT NULL DEFAULT 1,
  at          TEXT NOT NULL,
  resolved_at TEXT,
  PRIMARY KEY (stream_id, source_seq, stage)
);
CREATE TABLE capture_gaps (
  stream_id   TEXT NOT NULL,
  from_seq    INTEGER NOT NULL,
  to_seq      INTEGER NOT NULL,
  detected_at TEXT NOT NULL,
  closed_at   TEXT,
  cause       TEXT NOT NULL,
  PRIMARY KEY (stream_id, from_seq, to_seq)
);
CREATE TABLE capture_processing_attempts (
  capture_id TEXT PRIMARY KEY,
  attempts   INTEGER NOT NULL,
  last_error TEXT NOT NULL,
  last_at    TEXT NOT NULL
);
CREATE TABLE capture_consent_blocked (
  project_key TEXT NOT NULL,          -- project id, or '(unbound)'
  surface     TEXT NOT NULL,
  count       INTEGER NOT NULL,
  last_at     TEXT NOT NULL,
  PRIMARY KEY (project_key, surface)
);

-- ------------------------------------------------------------------ learning
CREATE TABLE signals (
  signal_id    TEXT PRIMARY KEY,
  capture_id   TEXT UNIQUE,           -- effectively-once: one signal per captured event
  relay_key    TEXT UNIQUE,           -- idempotency for assistant relays
  workspace_id TEXT NOT NULL,
  project_id   TEXT,
  type         TEXT NOT NULL,
  surface      TEXT NOT NULL,
  trust        TEXT NOT NULL CHECK (trust IN ('user_direct','assistant_relayed','observed_edit')),
  author_id    TEXT,
  episode_id   TEXT NOT NULL,
  text         TEXT,
  record_json  TEXT NOT NULL,
  event_id     TEXT,
  created_at   TEXT NOT NULL
);
CREATE TABLE learning_candidates (
  candidate_id     TEXT PRIMARY KEY,
  signal_id        TEXT NOT NULL UNIQUE REFERENCES signals(signal_id),
  project_id       TEXT,
  rule_id          TEXT,              -- at most one rule per signal
  correction_id    TEXT,
  descriptor_json  TEXT NOT NULL,
  fingerprint      TEXT,
  state            TEXT NOT NULL,     -- mirrors the last decision outcome
  trigger_artifact_id TEXT,
  trigger_hash     TEXT,
  last_event_id    TEXT,
  expires_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE TABLE learning_decisions (
  decision_id  TEXT PRIMARY KEY,
  signal_id    TEXT NOT NULL,
  project_id   TEXT,
  outcome      TEXT NOT NULL,
  reasons_json TEXT NOT NULL,
  record_json  TEXT NOT NULL,
  decided_at   TEXT NOT NULL
);
CREATE INDEX learning_decisions_by_project ON learning_decisions (project_id, decided_at);
CREATE TABLE inbox_items (
  inbox_id    TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id  TEXT,
  kind        TEXT NOT NULL,
  question    TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  signal_id   TEXT,
  decision_id TEXT,
  rule_id     TEXT,
  dedup_key   TEXT NOT NULL UNIQUE,
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  opened_at   TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by TEXT,
  resolution  TEXT
);
CREATE TABLE learning_notices (
  notice_id   TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL,
  rule_id     TEXT NOT NULL,
  decision_id TEXT NOT NULL UNIQUE,
  text        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE TABLE suppressions (
  suppression_id TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL,
  fingerprint    TEXT NOT NULL,
  created_by     TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  removed_at     TEXT,
  UNIQUE (project_id, fingerprint)
);
${IMMUTABLE_TABLES.map((t) => immutable(t, t.replace(/_/g, " "))).join("\n")}
`;
