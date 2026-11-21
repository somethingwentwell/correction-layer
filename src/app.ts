/**
 * Composition root: one local service owns one workspace store (docs/03 §1).
 * Everything else - the HTTP API, the UI, the CLI, tests - talks to these services.
 */
import { join } from "node:path";
import { CaptureIntake } from "./capture/intake.ts";
import type { Config } from "./config.ts";
import { ProjectService } from "./context/projects.ts";
import type { IdGen } from "./domain/ids.ts";
import { randomId } from "./domain/ids.ts";
import type { Clock } from "./domain/time.ts";
import { systemClock, ts } from "./domain/time.ts";
import type { Actor } from "./domain/types.ts";
import type { ActionAdapter } from "./gate/adapters.ts";
import { DEFAULT_ACTION_ADAPTERS, localReleaseFolder } from "./gate/adapters.ts";
import { FixService } from "./work/fixes.ts";
import { Gateway } from "./gate/gateway.ts";
import type { Signer } from "./gate/signer.ts";
import { ephemeralSigner, fileSigner } from "./gate/signer.ts";
import { Ledger } from "./ledger/ledger.ts";
import { LearningPipeline } from "./learning/pipeline.ts";
import { LearningPolicyService } from "./learning/policy.ts";
import { RuleService } from "./policy/rules.ts";
import { ExceptionService } from "./policy/exceptions.ts";
import { RuleAuthoring } from "./policy/authoring.ts";
import type { Db } from "./store/db.ts";
import { get, openDb, run } from "./store/db.ts";
import { migrate } from "./store/migrations.ts";
import { CheckService } from "./work/check.ts";

export interface AppOptions {
  /** ":memory:" or a file path. */
  dbPath: string;
  signingKeyPath?: string | null;
  displayTz?: string;
  clock?: Clock;
  ids?: IdGen;
  workspaceId?: string;
  workspaceName?: string;
  localUserId?: string;
  localUserName?: string;
  signer?: Signer;
  actionAdapters?: readonly ActionAdapter[];
}

export interface App {
  db: Db;
  clock: Clock;
  workspaceId: string;
  displayTz: string;
  /** Solo mode: the one person who uses the app surface. Holds every role; self-approval is labelled. */
  localUser: Actor;
  ledger: Ledger;
  rules: RuleService;
  exceptions: ExceptionService;
  authoring: RuleAuthoring;
  projects: ProjectService;
  gateway: Gateway;
  checks: CheckService;
  fixes: FixService;
  policies: LearningPolicyService;
  intake: CaptureIntake;
  learning: LearningPipeline;
  schemaVersion: number;
  close(): void;
}

export const DEFAULT_WORKSPACE_ID = "ws_LOCAL0001";
export const DEFAULT_LOCAL_USER_ID = "usr_LOCAL0001";

export function createApp(opts: AppOptions): App {
  const db = openDb(opts.dbPath);
  const clock = opts.clock ?? systemClock;
  const ids = opts.ids ?? randomId;
  const { version } = migrate(db, undefined, () => ts(clock.now()));

  // One workspace per store. An existing store keeps its identity whatever the options say.
  const existing = get<any>(db, "SELECT workspace_id, display_tz FROM workspace LIMIT 1");
  const workspaceId: string = existing?.workspace_id ?? opts.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const displayTz: string = opts.displayTz ?? existing?.display_tz ?? "UTC";
  const rulesRef: { rules?: RuleService } = {};
  const ledger = new Ledger(db, { workspaceId, displayTz, clock, policyRev: () => rulesRef.rules?.policyRev() ?? 0 });
  const rules = new RuleService({ db, ledger, clock, ids, workspaceId });
  rulesRef.rules = rules;
  const projects = new ProjectService({ db, ledger, clock, ids, rules, workspaceId });
  const signer = opts.signer ?? (opts.signingKeyPath ? fileSigner(opts.signingKeyPath, workspaceId) : ephemeralSigner(workspaceId));
  const exceptions = new ExceptionService({ db, ledger, clock, ids, rules, workspaceId });
  const gateway = new Gateway({ db, ledger, clock, ids, rules, projects, signer, adapters: opts.actionAdapters ?? [...DEFAULT_ACTION_ADAPTERS, localReleaseFolder((projectId) => get<{ folder: string }>(db, "SELECT folder FROM release_targets WHERE project_id = ?", projectId)?.folder ?? null)], exceptions });
  const checks = new CheckService({ db, ledger, clock, ids, rules, projects, gateway, exceptions, displayTz });
  const fixes = new FixService({ db, ledger, clock, ids, checks, workspaceId });
  const authoring = new RuleAuthoring({ db, ledger, clock, ids, rules, projects, checks, workspaceId });
  const policies = new LearningPolicyService({ db, ledger, clock, ids, projects, workspaceId, displayTz });
  const intake = new CaptureIntake({ db, ledger, clock, ids, projects, policies, workspaceId });
  const learning = new LearningPipeline({ db, ledger, clock, ids, rules, projects, policies, checks, intake, workspaceId, displayTz });

  const localUserId = opts.localUserId ?? DEFAULT_LOCAL_USER_ID;
  if (!existing) {
    run(db, "INSERT INTO workspace (workspace_id, name, display_tz, is_demo, created_at) VALUES (?,?,?,0,?)", workspaceId, opts.workspaceName ?? "My workspace", displayTz, ts(clock.now()));
    const person = projects.ensurePerson(localUserId, opts.localUserName ?? "Local user");
    ledger.append({ type: "workspace.created", project_id: null, actor: person, subject: { kind: "workspace", id: workspaceId }, summary: "The workspace was created (one person, one machine).", payload: { schema_version: version, mode: "solo" } });
  }
  const localUser = projects.ensurePerson(localUserId, opts.localUserName ?? "Local user");
  // A request left "executing" by a crash has an unknown outcome; it is never retried automatically.
  gateway.recoverInFlight();
  // Anything received but not yet processed before a restart is picked up again (effectively-once).
  learning.tick();

  return { db, clock, workspaceId, displayTz, localUser, ledger, rules, exceptions, authoring, projects, gateway, checks, fixes, policies, intake, learning, schemaVersion: version, close: () => db.close() };
}

export function createAppFromConfig(config: Config, overrides: Partial<AppOptions> = {}): App {
  return createApp({ dbPath: config.dbPath, signingKeyPath: join(config.dataDir, "signing-key.pem"), displayTz: config.displayTz, localUserName: config.localUserName, ...overrides });
}
