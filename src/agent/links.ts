/**
 * Links into the local app for assistants and scripts.
 *
 * A `ui_url` is always `{validated loopback base}{an existing HTML route}`:
 *   - the base comes from the service's own configuration (CL_HOST / CL_PORT),
 *     from the socket the service is actually answering on, or from a
 *     `--base-url` the caller typed - and is accepted only if it is plain
 *     http on 127.0.0.1, ::1 or localhost, with no credentials, path, query
 *     or fragment (the same loopback rule as CL_HOST);
 *   - never from the content of a document, an email or a tool result;
 *   - every identifier is percent-encoded into its path segment.
 *
 * A loopback link opens only in a browser on the computer running the app,
 * while it is running. An assistant on another computer cannot open it.
 */
import { ClError } from "../domain/errors.ts";

export const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "::1", "localhost"]);

export const UI_NOTE = "This link opens only in a browser on the computer running Correction Layer, while it is running (npm run dev). It is a loopback address: from another computer it does not work.";

export class BaseUrlRefused extends ClError {
  constructor(reason: string) {
    super("base_url_refused", `The base URL was refused: ${reason}. Only http://127.0.0.1:<port>, http://[::1]:<port> or http://localhost:<port> are accepted.`, 400);
  }
}

/** Parse and validate a loopback base URL. Returns the origin without a trailing slash. Throws BaseUrlRefused. */
export function loopbackBaseUrl(input: string): string {
  if (typeof input !== "string" || !input || input.length > 200 || /[\s\x00-\x1f\x7f\\]/.test(input)) throw new BaseUrlRefused("it is empty, too long or contains spaces, control characters or backslashes");
  if (!URL.canParse(input)) throw new BaseUrlRefused("it is not a URL");
  const url = new URL(input);
  if (url.protocol !== "http:") throw new BaseUrlRefused(`the scheme ${url.protocol} is not http:`);
  if (url.username || url.password) throw new BaseUrlRefused("it contains credentials");
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
  if (!LOOPBACK_HOSTS.has(host)) throw new BaseUrlRefused(`${url.hostname} is not a loopback host`);
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) throw new BaseUrlRefused("it has a path, query or fragment; give the origin only");
  return url.origin;
}

/** The would-be base URL of the configured service. `null` when the port is chosen at start (CL_PORT=0). */
export function configBaseUrl(config: { host: string; port: number }): string | null {
  if (!config.port) return null;
  return loopbackBaseUrl(`http://${config.host === "::1" ? "[::1]" : config.host}:${config.port}`);
}

/** The base of a request's own socket (the address the service is really serving on), or null if not loopback. */
export function socketBaseUrl(localAddress: string | undefined, localPort: number | undefined): string | null {
  if (!localAddress || !localPort) return null;
  const addr = localAddress.replace(/^::ffff:(127\.0\.0\.1)$/, "$1");
  try {
    return loopbackBaseUrl(`http://${addr.includes(":") ? `[${addr}]` : addr}:${localPort}`);
  } catch {
    return null;
  }
}

/** One path segment. encodeURIComponent leaves ( ) ! * ' alone; they are encoded too so a Markdown link cannot be broken. */
export function seg(id: string): string {
  if (typeof id !== "string" || !id) throw new ClError("validation_failed", "an identifier is required for a link", 422);
  return encodeURIComponent(id).replace(/[()!*']/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

const q = (params: Record<string, string>): string => {
  const s = new URLSearchParams(params).toString().replace(/[()!*']/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return s ? `?${s}` : "";
};

/** The app's existing HTML routes (src/api/server.ts) that links may point at. */
export const UI_ROUTES = {
  home: () => "/",
  start: (project?: string) => `/start${project ? q({ project }) : ""}`,
  import: (project?: string) => `/import${project ? q({ project }) : ""}`,
  project: (id: string) => `/projects/${seg(id)}`,
  rules: (id: string) => `/projects/${seg(id)}/rules`,
  learning: (id: string) => `/projects/${seg(id)}/learning`,
  activity: (id: string) => `/projects/${seg(id)}/activity`,
  capture: (id: string) => `/projects/${seg(id)}/capture`,
  coverage: (id: string) => `/projects/${seg(id)}/coverage`,
  rule: (id: string, project?: string) => `/rules/${seg(id)}${project ? q({ project }) : ""}`,
  run: (id: string) => `/runs/${seg(id)}`,
  source: (id: string) => `/sources/${seg(id)}`,
  action: (id: string) => `/actions/${seg(id)}`,
  correction: (id: string) => `/corrections/${seg(id)}`,
  fix: (id: string) => `/fixes/${seg(id)}`,
  compare: (before: string, after: string) => `/compare${q({ before, after })}`,
  history: () => "/history",
} as const;
export type UiKind = keyof typeof UI_ROUTES;

/** Escape text for a Markdown link label (brackets cannot close the label; no emphasis, code, HTML or table breaks). */
export function mdLabel(text: string): string {
  return String(text).replace(/[\r\n]+/g, " ").replace(/[\\`*_\[\]<>|]/g, (c) => `\\${c}`).slice(0, 160);
}

export interface UiLink {
  ui_url: string | null;
  ui_markdown: string | null;
}

/** A link from a validated base and a path built by UI_ROUTES. With no base, both are null (never a guess). */
export function uiLink(base: string | null, path: string, label: string): UiLink {
  if (!base) return { ui_url: null, ui_markdown: null };
  if (!path.startsWith("/") || path.startsWith("//")) throw new ClError("validation_failed", "a link path must be a local path", 422);
  const ui_url = `${base}${path}`;
  return { ui_url, ui_markdown: `[${mdLabel(label)}](${ui_url})` };
}
