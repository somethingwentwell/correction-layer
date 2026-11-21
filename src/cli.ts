#!/usr/bin/env node
/**
 * Command line for developers and integrators (docs/06 §2.3). Never required for
 * ordinary use. The exit status of `check` reflects the verdict.
 */
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { HttpCaptureTransport, LocalOutboxAdapter } from "./capture/local-adapter.ts";
import { sha256 } from "./domain/canonical.ts";
import { ts } from "./domain/time.ts";
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
  capture <say|agent|flush|backfill|close> --adapter <adp_...> --outbox <file> [options]
                             command-line capture adapter with a durable outbox file. It talks
                             to the RUNNING service over loopback HTTP (start it with serve).
                             Pair the adapter first in the app (Capture health). No assistant
                             is connected by this command; you or your own hook script feed it.
      say "<text>"           a message you typed (attested by this adapter)
      agent "<text>"         an assistant's output (sent as a digest only, never as text)
      flush                  deliver/replay everything still in the outbox
      backfill --transcript <file.jsonl>
                             recover turns from a transcript ({"role","text","occurred_at"}
                             per line); marked as backfill, never treated as live words
      close                  end the stream (anything missing stays a visible gap)
      options: --stream <str_...> --binding <fld_...> --artifact <art_...> --hash <sha256:...>

Configuration comes from the environment (see .env.example).`;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help") {
    console.log(USAGE);
    return command ? 0 : 64;
  }
  const config = loadConfig();
  if (command === "capture") return capture(rest, config);
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

/** The command-line capture adapter. Exit 0 delivered, 3 kept in the outbox (service unreachable or refused), 64 usage. */
async function capture(args: string[], config: ReturnType<typeof loadConfig>): Promise<number> {
  const [sub, ...rest] = args;
  const flag = (name: string): string | undefined => {
    const i = rest.indexOf(`--${name}`);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const positional = rest.filter((a, i) => !a.startsWith("--") && !(rest[i - 1] ?? "").startsWith("--"));
  const adapterId = flag("adapter");
  const outbox = flag("outbox");
  if (!sub || !adapterId || !outbox) {
    console.error(USAGE);
    return 64;
  }
  const outboxPath = resolve(outbox);
  const streamId = flag("stream") ?? `str_${sha256(`${adapterId}|${outboxPath}`).slice(7, 27).toUpperCase()}`;
  const adapter = new LocalOutboxAdapter({ adapter_id: adapterId, stream_id: streamId, outbox_path: outboxPath, binding_id: flag("binding") ?? null });
  const transport = new HttpCaptureTransport(`http://${config.host === "::1" ? "[::1]" : config.host}:${config.port}`);
  const now = ts(new Date());
  const binding = { ...(flag("artifact") ? { artifact_id: flag("artifact")! } : {}), ...(flag("hash") ? { content_hash: flag("hash")! } : {}) };
  switch (sub) {
    case "say":
    case "agent": {
      const text = positional.join(" ").trim();
      if (!text) {
        console.error("Give the text to capture.");
        return 64;
      }
      adapter.emit(sub === "say"
        ? { kind: "user_turn", role: "user", attested_by: "runtime_hook", occurred_at: now, text, binding }
        : { kind: "agent_output", role: "agent", attested_by: "runtime_hook", occurred_at: now, text, binding });
      break;
    }
    case "backfill": {
      const file = flag("transcript");
      if (!file) {
        console.error("Give --transcript <file.jsonl>.");
        return 64;
      }
      let n = 0;
      for (const line of readFileSync(file, "utf8").split("\n").filter((l) => l.trim())) {
        const t = JSON.parse(line) as { role?: string; text?: string; occurred_at?: string };
        const at = typeof t.occurred_at === "string" && /Z$/.test(t.occurred_at) ? t.occurred_at : now;
        if (t.role === "user" && typeof t.text === "string") adapter.backfill({ kind: "user_turn", role: "user", occurred_at: at, text: t.text });
        else if (t.role === "agent" || t.role === "assistant") adapter.backfill({ kind: "agent_output", role: "agent", occurred_at: at, text: String(t.text ?? "") });
        else continue;
        n++;
      }
      console.log(`${n} transcript turn(s) added to the outbox as backfill.`);
      break;
    }
    case "flush":
      break;
    case "close": {
      const flushed = await adapter.flushAsync(transport);
      if (!flushed.delivered) {
        console.error(`Not delivered; kept in the outbox: ${flushed.error}`);
        return 3;
      }
      const closed = await adapter.closeAsync(transport);
      console.log(`Stream ${streamId} closed at ${closed.cursor}.`);
      return 0;
    }
    default:
      console.error(USAGE);
      return 64;
  }
  const out = await adapter.flushAsync(transport);
  if (!out.delivered) {
    console.error(`Not delivered; ${adapter.pending} event(s) kept in the outbox for replay: ${out.error}`);
    return 3;
  }
  console.log(`Stream ${streamId}: acknowledged through ${out.cursor}. ${out.results.map((r) => `#${r.source_seq} ${r.result}`).join(", ") || "nothing pending"}.`);
  return 0;
}

main(process.argv.slice(2)).then((code) => process.exit(code), (error: unknown) => {
  console.error(error instanceof ClError ? `${error.code}: ${error.message}` : error);
  process.exit(70);
});
