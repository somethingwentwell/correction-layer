/**
 * Content diff between two normalized versions (OBS-5, AT-O5). Pure.
 *
 * Passages (text blocks: lines, headings, table rows) are aligned by a longest
 * common subsequence of their text; a removed block followed by an added block is
 * shown as one changed passage. Typed field values (cells mapped to fields) are
 * compared by path. Findings are joined to passages by locator: a finding located
 * in a passage of the "before" run that the "after" run no longer reports is
 * resolved; one in the "after" run that the "before" run did not report is
 * introduced. Parts of either file that were not read are named: changes there, if
 * any, are present but not shown.
 */
import type { ContentBlock, Finding, NormalizedArtifact, TypedValue } from "../domain/types.ts";

export interface PassageChange {
  kind: "changed" | "added" | "removed";
  before: { locator: string; label: string; text: string } | null;
  after: { locator: string; label: string; text: string } | null;
  resolved: string[];
  introduced: string[];
}

export interface FieldChange {
  path: string;
  before: string | null;
  after: string | null;
  label: string;
}

export interface ContentDiff {
  available: true;
  passages: PassageChange[];
  fields: FieldChange[];
  unchanged_passages: number;
  unread: Array<{ component: string; state: string; side: "before" | "after" | "both" }>;
}

export type ContentDiffResult = ContentDiff | { available: false; reason: string };

const MAX_BLOCKS = 3000;

export function valueText(v: TypedValue): string {
  switch (v.type) {
    case "money": return `${v.currency ?? "?"} ${v.amount ?? "?"}`;
    case "number": case "percent": return v.number ?? "";
    case "date": return v.date ?? "";
    case "boolean": return String(v.boolean);
    case "text": return v.text ?? "";
    case "list": return JSON.stringify(v.items ?? []);
    default: return `(unreadable: ${v.reason ?? "unknown"})`;
  }
}

const blockOf = (b: ContentBlock) => ({ locator: b.locator, label: b.label ?? b.locator, text: b.text ?? "" });
const within = (f: Finding, b: { locator: string }): boolean => f.location.locator === b.locator || f.location.locator.startsWith(`${b.locator}/`);

export function diffArtifacts(before: NormalizedArtifact | null, after: NormalizedArtifact | null, findings: { resolved: Finding[]; introduced: Finding[] } = { resolved: [], introduced: [] }): ContentDiffResult {
  if (!before || !after) return { available: false, reason: `The ${!before ? "earlier" : "later"} version could not be read, so its content cannot be compared. Findings are compared from the checks.` };
  const a = before.content.blocks.filter((b) => b.text !== undefined).map(blockOf);
  const b = after.content.blocks.filter((x) => x.text !== undefined).map(blockOf);
  if (a.length > MAX_BLOCKS || b.length > MAX_BLOCKS) return { available: false, reason: `The documents have more than ${MAX_BLOCKS} passages; the passage diff is limited in this build.` };
  // Longest common subsequence on passage text.
  const n = a.length;
  const m = b.length;
  const lcs: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i]![j] = a[i]!.text === b[j]!.text ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const ops: Array<{ op: "same" | "del" | "add"; x?: (typeof a)[number]; y?: (typeof b)[number] }> = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i]!.text === b[j]!.text) ops.push({ op: "same", x: a[i++]!, y: b[j++]! });
    else if (j < m && (i === n || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) ops.push({ op: "add", y: b[j++]! });
    else ops.push({ op: "del", x: a[i++]! });
  }
  const passages: PassageChange[] = [];
  let unchanged = 0;
  for (let k = 0; k < ops.length; k++) {
    const o = ops[k]!;
    if (o.op === "same") { unchanged++; continue; }
    // A run of removals and additions: pair them as changed passages - same locator first (the same table row or
    // line position), then in order. Whatever is left over was added or removed.
    const dels: Array<(typeof a)[number]> = [];
    const adds: Array<(typeof b)[number]> = [];
    while (k < ops.length && ops[k]!.op !== "same") {
      if (ops[k]!.op === "del") dels.push(ops[k]!.x!);
      else adds.push(ops[k]!.y!);
      k++;
    }
    k--;
    const pairs: Array<[(typeof a)[number] | null, (typeof b)[number] | null]> = [];
    const freeAdds = [...adds];
    const unpaired: Array<(typeof a)[number]> = [];
    for (const x of dels) {
      const idx = freeAdds.findIndex((y) => y.locator === x.locator);
      if (idx >= 0) pairs.push([x, freeAdds.splice(idx, 1)[0]!]);
      else unpaired.push(x);
    }
    for (let p = 0; p < Math.max(unpaired.length, freeAdds.length); p++) pairs.push([unpaired[p] ?? null, freeAdds[p] ?? null]);
    for (const [x, y] of pairs) {
      passages.push({
        kind: x && y ? "changed" : x ? "removed" : "added", before: x, after: y,
        resolved: x ? findings.resolved.filter((f) => within(f, x)).map((f) => f.finding_id) : [],
        introduced: y ? findings.introduced.filter((f) => within(f, y)).map((f) => f.finding_id) : [],
      });
    }
  }
  const fieldMap = (art: NormalizedArtifact) => new Map(art.fields.map((f) => [f.path, { text: valueText(f.value), label: f.locations[0]?.label ?? f.path }]));
  const [fa, fb] = [fieldMap(before), fieldMap(after)];
  const fields: FieldChange[] = [...new Set([...fa.keys(), ...fb.keys()])].sort()
    .filter((p) => fa.get(p)?.text !== fb.get(p)?.text)
    .map((p) => ({ path: p, before: fa.get(p)?.text ?? null, after: fb.get(p)?.text ?? null, label: (fb.get(p) ?? fa.get(p))!.label }));
  const gaps = (art: NormalizedArtifact) => new Map(art.coverage.filter((c) => c.content_bearing && ["partial", "detected_not_parsed", "unsupported"].includes(c.state)).map((c) => [c.component, c.state]));
  const [ga, gb] = [gaps(before), gaps(after)];
  const unread = [...new Set([...ga.keys(), ...gb.keys()])].sort().map((component) => ({ component, state: (gb.get(component) ?? ga.get(component))!, side: (ga.has(component) && gb.has(component) ? "both" : ga.has(component) ? "before" : "after") as "before" | "after" | "both" }));
  return { available: true, passages, fields, unchanged_passages: unchanged, unread };
}
