import { randomBytes } from "node:crypto";

/** Identifier prefixes from docs/glossary.md. */
export const ID_PREFIXES = [
  "ws", "prj", "fld", "area", "usr", "agt", "ses", "cor", "rul", "case", "src", "snap", "map", "art", "run",
  "trc", "fnd", "fix", "chg", "att", "exc", "rcp", "act", "apr", "adp", "evt", "lrn", "str", "cap", "sig",
  "epi", "evl", "dec", "inb", "sys", "ntc", "exe", "sup",
] as const;
export type IdPrefix = (typeof ID_PREFIXES)[number];

export const ID_RE = /^[a-z]{2,4}_[0-9A-Za-z]{6,26}$/;
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export type IdGen = (prefix: IdPrefix) => string;

export const randomId: IdGen = (prefix) => {
  const bytes = randomBytes(16);
  let out = "";
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return `${prefix}_${out}`;
};

export function isId(value: unknown, prefix?: IdPrefix): value is string {
  return typeof value === "string" && ID_RE.test(value) && (prefix === undefined || value.startsWith(prefix + "_"));
}

/** Well-known component actors. They are system actors: never a person, never an approver. */
export const SYS = {
  engine: "sys_ENGINE01",
  intake: "sys_INTAKE01",
  detector: "sys_DETECTOR",
  translator: "sys_TRANSLTR",
  learning: "sys_LEARNING",
  gateway: "sys_GATEWAY1",
  service: "sys_SERVICE1",
} as const;
