import { createHash } from "node:crypto";

/**
 * Canonical JSON as proposed in schemas/README.md: object keys sorted, no
 * insignificant whitespace, UTF-8. (A production design would pin RFC 8785.)
 */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return "[" + value.map((v) => canonical(v === undefined ? null : v)).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonical(obj[k])).join(",") + "}";
}

export function sha256(text: string | Uint8Array): string {
  return "sha256:" + createHash("sha256").update(text).digest("hex");
}

export function digestOf(value: unknown): string {
  return sha256(canonical(value));
}

export const HASH_RE = /^sha256:[0-9a-f]{64}$/;
