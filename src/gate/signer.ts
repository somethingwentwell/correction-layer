/**
 * Workspace signing key for receipts (docs/06 §3).
 *
 * Deviation from the design, recorded in HANDOFF.md: the design keeps the key in the
 * OS keychain. Phase 1 keeps an ed25519 key in a 0600 file inside the workspace data
 * directory (never inside the repository, never returned by any API).
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { dirname } from "node:path";

export interface Signer {
  keyId: string;
  sign(text: string): string;
  verify(text: string, signature: string): boolean;
}

function fromKey(privateKey: KeyObject, keyId: string): Signer {
  const publicKey = createPublicKey(privateKey);
  return {
    keyId,
    sign: (text) => sign(null, Buffer.from(text, "utf8"), privateKey).toString("base64"),
    verify: (text, signature) => {
      try {
        return verify(null, Buffer.from(text, "utf8"), publicKey, Buffer.from(signature, "base64"));
      } catch {
        return false;
      }
    },
  };
}

/** In-memory key: tests and `:memory:` stores. Receipts do not outlive the process. */
export function ephemeralSigner(workspaceId: string): Signer {
  return fromKey(generateKeyPairSync("ed25519").privateKey, `${workspaceId}/signing/ephemeral`);
}

export function fileSigner(path: string, workspaceId: string): Signer {
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    const pem = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" });
    writeFileSync(path, pem, { mode: 0o600, flag: "wx" });
  }
  chmodSync(path, 0o600);
  return fromKey(createPrivateKey(readFileSync(path, "utf8")), `${workspaceId}/signing/1`);
}
