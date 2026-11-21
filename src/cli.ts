#!/usr/bin/env node
/**
 * Command line for developers and integrators (docs/06 §2.3). Never required for
 * ordinary use. The exit status of `check` reflects the verdict.
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { startServer } from "./api/server.ts";
import { createAppFromConfig } from "./app.ts";
import { loadConfig } from "./config.ts";
import { ClError } from "./domain/errors.ts";
import { seedDemo } from "./seed/demo.ts";

const USAGE = `correction-layer <command>

  serve                      start the local service and app (loopback only)
  migrate                    create or upgrade the workspace store
  seed-demo                  load labelled DEMO data into an empty workspace
  verify                     verify the ledger hash chain
  check <file> --project <project_id> [--for release|check_only|send_external]
                             advisory check; exit 0 Ready, 1 Needs changes, 2 Couldn't verify

Configuration comes from the environment (see .env.example).`;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help") {
    console.log(USAGE);
    return command ? 0 : 64;
  }
  const config = loadConfig();
  const flag = (name: string): string | undefined => {
    const i = rest.indexOf(`--${name}`);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  if (command === "serve") {
    const app = createAppFromConfig(config);
    if (config.seedDemo) {
      const seeded = seedDemo(app);
      console.log(seeded.seeded ? `DEMO data loaded (project ${seeded.project_id}). It is fictional and labelled DEMO.` : `DEMO data not loaded: ${seeded.reason}.`);
    }
    const running = await startServer(app, { host: config.host, port: config.port });
    console.log(`Correction Layer (Phase 1 scaffold) is running at ${running.url}`);
    console.log(`  store:  ${config.dbPath} (schema version ${app.schemaVersion})`);
    console.log(`  health: ${running.url}/healthz`);
    const stop = (): void => {
      void running.close().then(() => {
        app.close();
        process.exit(0);
      });
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    return await new Promise<number>(() => undefined);
  }
  const app = createAppFromConfig(config);
  try {
    switch (command) {
      case "migrate":
        console.log(`Workspace store ready at ${config.dbPath} (schema version ${app.schemaVersion}).`);
        return 0;
      case "seed-demo": {
        const seeded = seedDemo(app);
        console.log(seeded.seeded ? `DEMO data loaded (project ${seeded.project_id}). It is fictional and labelled DEMO.` : `DEMO data not loaded: ${seeded.reason}.`);
        return seeded.seeded ? 0 : 1;
      }
      case "verify": {
        const v = app.ledger.verify();
        console.log(v.ok ? `History verifies: ${v.events} events.` : `History does NOT verify: first problem at sequence ${v.first_bad_seq} (${v.problem}).`);
        return v.ok ? 0 : 1;
      }
      case "check": {
        const file = rest.find((a, i) => !a.startsWith("--") && !(rest[i - 1] ?? "").startsWith("--"));
        const project = flag("project");
        if (!file) {
          console.error(USAGE);
          return 64;
        }
        const out = app.checks.check({ ...(project ? { project_id: project } : { path: file }), name: basename(file), bytes: new Uint8Array(readFileSync(file)), action: { type: flag("for") ?? "check_only" }, actor: { kind: "agent", id: "agt_CLI00001", display_name: "command line" } });
        console.log(out.human_summary);
        if (out.run_id) console.log(`run ${out.run_id}${out.receipt_id ? `, receipt ${out.receipt_id}` : ""}`);
        return out.verdict === "ready" ? 0 : out.verdict === "needs_changes" ? 1 : 2;
      }
      default:
        console.error(`Unknown command: ${command}\n\n${USAGE}`);
        return 64;
    }
  } finally {
    app.close();
  }
}

main(process.argv.slice(2)).then((code) => process.exit(code), (error: unknown) => {
  console.error(error instanceof ClError ? `${error.code}: ${error.message}` : error);
  process.exit(70);
});
