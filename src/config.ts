/**
 * Configuration from the environment (see .env.example). No secrets live in source
 * or in the repository; the only key material is generated into the data directory.
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { ClError } from "./domain/errors.ts";

export interface Config {
  dataDir: string;
  dbPath: string;
  signingKeyPath: string;
  host: string;
  port: number;
  displayTz: string;
  localUserName: string;
  seedDemo: boolean;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = resolve(env.CL_DATA_DIR?.trim() || join(env.XDG_DATA_HOME?.trim() || join(homedir(), ".local", "share"), "correction-layer"));
  const host = env.CL_HOST?.trim() || "127.0.0.1";
  // The local API is a loopback service (docs/06 §2.3). Exposing it on a network interface is refused.
  if (!LOOPBACK.has(host)) throw new ClError("config_invalid", `CL_HOST must be a loopback address; got ${host}`, 500);
  const port = Number(env.CL_PORT ?? 4319);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new ClError("config_invalid", `CL_PORT must be a port number; got ${env.CL_PORT}`, 500);
  const displayTz = env.CL_DISPLAY_TZ?.trim() || "UTC";
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: displayTz });
  } catch {
    throw new ClError("config_invalid", `CL_DISPLAY_TZ must be an IANA timezone; got ${displayTz}`, 500);
  }
  return {
    dataDir, dbPath: join(dataDir, "workspace.db"), signingKeyPath: join(dataDir, "signing-key.pem"), host, port, displayTz,
    localUserName: env.CL_LOCAL_USER_NAME?.trim() || "Local user", seedDemo: env.CL_SEED_DEMO === "1",
  };
}
