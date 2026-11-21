/**
 * Where corrections can be noticed, and where they cannot (AT-L6, docs/12 §4).
 *
 * This build connects to NO external chat app or assistant runtime. The registry
 * names the common places people correct work so that each is labelled
 * NOT CAPTURED by name, instead of being silently absent. Nothing here contacts,
 * detects or probes any of them. An entry becomes CAPTURED only when a person
 * pairs an adapter for it AND learning consents to its surface in the project.
 */
import type { Surface } from "../domain/types.ts";

export interface KnownRuntime {
  runtime_id: string;
  name: string;
  kind: "assistant" | "chat" | "email" | "office" | "folder";
  /** Why nothing is captured from it in this build. */
  note: string;
}

export const KNOWN_RUNTIMES: readonly KnownRuntime[] = Object.freeze([
  { runtime_id: "chatgpt", name: "ChatGPT (web and desktop)", kind: "assistant", note: "No adapter exists. Corrections typed there are not seen." },
  { runtime_id: "claude_apps", name: "Claude (web and desktop apps)", kind: "assistant", note: "No adapter exists. Corrections typed there are not seen." },
  { runtime_id: "claude_code", name: "Claude Code", kind: "assistant", note: "No adapter ships with this build. A hook script you write may call the command-line outbox adapter; nothing is connected by default." },
  { runtime_id: "copilot", name: "Microsoft Copilot", kind: "assistant", note: "No adapter exists. Corrections typed there are not seen." },
  { runtime_id: "gemini", name: "Google Gemini", kind: "assistant", note: "No adapter exists. Corrections typed there are not seen." },
  { runtime_id: "chat_apps", name: "Team chat (Slack, Teams, WhatsApp)", kind: "chat", note: "No connector exists. Messages there are not seen." },
  { runtime_id: "email", name: "Email", kind: "email", note: "No connector exists. Replies and comments in email are not seen." },
  { runtime_id: "office", name: "Word / Excel comments and tracked changes", kind: "office", note: "Edits made in office apps are not observed. Only versions you check here are seen." },
  { runtime_id: "folder_watch", name: "Edits to files in a project folder", kind: "folder", note: "Folder watching is not available in this build." },
]);

export type CaptureLabel = "CAPTURED" | "NOT CAPTURED" | "RELAYED";

export interface SurfaceLabel {
  name: string;
  label: CaptureLabel;
  simulated: boolean;
  detail: string;
  surface: Surface | null;
  adapter_id: string | null;
}
