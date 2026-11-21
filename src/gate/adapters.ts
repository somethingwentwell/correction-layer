/**
 * Action adapters (docs/06 §6): the single component able to perform a kind of
 * action. Validation, permission and action are separate authorities; an adapter
 * runs only when the gateway has verified a receipt, its bindings and an approval.
 *
 * BOUNDARY - nothing in this build sends or pays:
 *   - `release` is served by a SIMULATED adapter by default (records, copies nothing).
 *   - A person may switch a project's release route to the LOCAL RELEASE FOLDER
 *     adapter: it copies exactly the checked bytes it is handed (never a path it
 *     is given) into the folder that person chose, never overwrites a file, and
 *     verifies the written copy hashes to the receipt's content hash. It contacts
 *     nothing outside this machine.
 *   - `send_external` and `pay` adapters are declared UNAVAILABLE. Requests for them
 *     are refused with a typed error and an `action.blocked` event.
 */
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { sha256 } from "../domain/canonical.ts";
import { Unavailable, ValidationError } from "../domain/errors.ts";

export interface AdapterCapability {
  adapter_id: string;
  kind: string;
  label: string;
  action_types: string[];
  reversible: boolean;
  /** True when the adapter performs no real-world effect. Shown wherever the adapter is named. */
  simulated: boolean;
  availability: "available" | "unavailable";
  credential: { kind: string; held_by: "gateway" | "none"; visible_to_clients: false };
  coverage_qualifier: "exclusive" | "by_convention" | "same_account" | null;
}

export interface ExecutionOutcome {
  outcome: string;
  executed_content_hash: string;
  detail: string;
}

export interface ActionAdapter {
  capability: AdapterCapability;
  /** Receives the checked bytes (never a file path) and the approved parameters. */
  execute(input: { action_id: string; type: string; params: Record<string, unknown>; bytes: Uint8Array; content_hash: string; project_id?: string; artifact_name?: string; version_seq?: number }): ExecutionOutcome;
}

export const SIMULATED_RELEASE: ActionAdapter = {
  capability: {
    adapter_id: "adp_RELEASESIM", kind: "release_folder_simulated", label: "Release folder (SIMULATED: records the release, copies nothing)", action_types: ["release"],
    reversible: true, simulated: true, availability: "available", credential: { kind: "none", held_by: "none", visible_to_clients: false }, coverage_qualifier: "by_convention",
  },
  execute: (input) => ({
    outcome: "simulated_release_recorded", executed_content_hash: input.content_hash,
    detail: `SIMULATED: ${input.bytes.length} checked bytes would be copied to the Released folder. Nothing was written outside the workspace store.`,
  }),
};

const unavailable = (adapter_id: string, kind: string, label: string, action_types: string[]): ActionAdapter => ({
  capability: {
    adapter_id, kind, label, action_types, reversible: false, simulated: false, availability: "unavailable",
    credential: { kind: "none", held_by: "none", visible_to_clients: false }, coverage_qualifier: null,
  },
  execute: () => {
    throw new Unavailable(`gate.adapter.${kind}`, `${label} is not available in this build. Nothing was sent or paid.`);
  },
});

export const UNAVAILABLE_EMAIL = unavailable("adp_EMAILNONE", "email_send", "Send by email", ["send_external"]);
export const UNAVAILABLE_PAYMENT = unavailable("adp_PAYNONE01", "payment_export", "Payment export", ["pay", "export_payment_file"]);

export const RELEASE_FOLDER_ADAPTER_ID = "adp_RELEASEDIR";

/** A folder a person may choose as a release target: absolute, existing, a directory. */
export function releaseFolderProblems(folder: string): string[] {
  if (!folder || !isAbsolute(folder)) return ["folder: an absolute path to an existing folder on this computer"];
  try {
    if (!statSync(folder).isDirectory()) return ["folder: this path is not a folder"];
  } catch {
    return ["folder: this folder does not exist"];
  }
  return [];
}

/** The released file's name: the document's own name, made safe, with its version number. Never a path. */
export function releaseFileName(artifactName: string, versionSeq: number): string {
  const base = basename(artifactName).replace(/[^A-Za-z0-9._ -]/g, "_").replace(/^[.\s]+/, "").slice(0, 120) || "document";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? `${base.slice(0, dot)}.v${versionSeq}${base.slice(dot)}` : `${base}.v${versionSeq}`;
}

/**
 * The local release folder adapter (validation-bound export sandbox). It receives
 * the checked bytes from the gateway after every binding and the approval were
 * re-verified, and writes them to the folder a person configured for the project.
 */
export function localReleaseFolder(folderFor: (projectId: string) => string | null): ActionAdapter {
  return {
    capability: {
      adapter_id: RELEASE_FOLDER_ADAPTER_ID, kind: "release_folder", label: "Release to a local folder (copies exactly the checked bytes)", action_types: ["release"],
      reversible: true, simulated: false, availability: "available", credential: { kind: "none", held_by: "none", visible_to_clients: false }, coverage_qualifier: "by_convention",
    },
    execute: (input) => {
      const folder = input.project_id ? folderFor(input.project_id) : null;
      if (!folder) throw new Unavailable("gate.adapter.release_folder", "No release folder is configured for this project. Nothing was released.");
      const problems = releaseFolderProblems(folder);
      if (problems.length) throw new ValidationError("release folder", problems);
      if (sha256(input.bytes) !== input.content_hash) throw new Error("the bytes handed to the adapter do not match the receipt; nothing was written");
      const target = join(resolve(folder), releaseFileName(input.artifact_name ?? "document", input.version_seq ?? 0));
      if (existsSync(target)) throw new Error(`${basename(target)} already exists in the release folder; nothing was overwritten`);
      const fd = openSync(target, "wx", 0o644);
      try {
        writeSync(fd, input.bytes);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      const written = sha256(readFileSync(target));
      if (written !== input.content_hash) {
        unlinkSync(target);
        throw new Error("the written copy did not match the checked bytes and was removed");
      }
      return { outcome: "released_to_folder", executed_content_hash: written, detail: `Copied the checked bytes (${input.bytes.length} bytes) to ${target}. The copy's hash matches the receipt.` };
    },
  };
}

export const DEFAULT_ACTION_ADAPTERS: readonly ActionAdapter[] = Object.freeze([SIMULATED_RELEASE, UNAVAILABLE_EMAIL, UNAVAILABLE_PAYMENT]);
