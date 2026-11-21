/**
 * Action adapters (docs/06 §6): the single component able to perform a kind of
 * action. Validation, permission and action are separate authorities; an adapter
 * runs only when the gateway has verified a receipt, its bindings and an approval.
 *
 * PHASE 1 BOUNDARY - nothing in this build sends, pays, or writes outside the store:
 *   - `release` is served by a SIMULATED adapter that records what it would have
 *     released and touches nothing.
 *   - `send_external` and `pay` adapters are declared UNAVAILABLE. Requests for them
 *     are refused with a typed error and an `action.blocked` event.
 */
import { Unavailable } from "../domain/errors.ts";

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
  execute(input: { action_id: string; type: string; params: Record<string, unknown>; bytes: Uint8Array; content_hash: string }): ExecutionOutcome;
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

export const DEFAULT_ACTION_ADAPTERS: readonly ActionAdapter[] = Object.freeze([SIMULATED_RELEASE, UNAVAILABLE_EMAIL, UNAVAILABLE_PAYMENT]);
