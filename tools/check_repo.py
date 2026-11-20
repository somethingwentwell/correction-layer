#!/usr/bin/env python3
"""Consistency checks for the Correction Layer design repository.

This script is NOT part of the product and enforces nothing about anyone's
work. It only keeps this specification honest:

  1. Markdown links and heading anchors resolve.
  2. Every .json file and every ```json block in the docs parses.
  3. Example files validate against the proposed schemas they name.
  4. Example event logs are contiguous, causally ordered and hash-chained.
  5. A correction in an example can be reconstructed end to end by following
     stored references only (no timestamp or text inference).
  6. ASCII wireframes are rectangular.

Usage:
  python3 tools/check_repo.py                  run all checks
  python3 tools/check_repo.py --journey        also print the reconstructed
                                               sales-proposal journey
  python3 tools/check_repo.py --fix            pad wireframes and recompute
                                               event hashes in place, then check

Standard library only. Python 3.8+.
"""
import hashlib
import json
import os
import re
import sys
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SKIP_DIRS = {".git", "__pycache__"}
errors = []


def err(where, msg):
    errors.append("%s: %s" % (os.path.relpath(where, ROOT) if os.path.isabs(where) else where, msg))


def walk(ext):
    for base, dirs, files in os.walk(ROOT):
        dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS)
        for f in sorted(files):
            if f.endswith(ext):
                yield os.path.join(base, f)


# ---------------------------------------------------------------- markdown
FENCE = re.compile(r"^(```+|~~~+)(.*)$")


def split_markdown(path):
    """Return (prose_lines, blocks) where blocks = [(info, first_line_no, lines)]."""
    prose, blocks, cur, fence = [], [], None, None
    with open(path, encoding="utf-8") as fh:
        for n, line in enumerate(fh.read().split("\n"), 1):
            m = FENCE.match(line.strip())
            if cur is None and m:
                fence, cur = m.group(1), (m.group(2).strip(), n, [])
            elif cur is not None and line.strip() == fence:
                blocks.append(cur)
                cur = None
            elif cur is not None:
                cur[2].append(line)
            else:
                prose.append((n, line))
    return prose, blocks


def slugify(heading):
    text = re.sub(r"`([^`]*)`", r"\1", heading)
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", text)
    text = text.strip().lower()
    text = re.sub(r"[^\w\- ]", "", text, flags=re.UNICODE)
    return text.replace(" ", "-")


_anchor_cache = {}


def anchors(path):
    if path not in _anchor_cache:
        seen, out = {}, set()
        prose, _ = split_markdown(path)
        for _, line in prose:
            m = re.match(r"^(#{1,6})\s+(.*?)\s*#*\s*$", line)
            if m:
                slug = slugify(m.group(2))
                k = seen.get(slug, 0)
                seen[slug] = k + 1
                out.add(slug if k == 0 else "%s-%d" % (slug, k))
        _anchor_cache[path] = out
    return _anchor_cache[path]


LINK = re.compile(r"(?<!\!)\[[^\]]*\]\(([^)\s]+)\)")


def check_links():
    count = 0
    for md in walk(".md"):
        prose, _ = split_markdown(md)
        for n, line in prose:
            line = re.sub(r"`[^`]*`", "", line)
            for target in LINK.findall(line):
                if re.match(r"^[a-z][a-z0-9+.-]*:", target):
                    continue  # external scheme
                count += 1
                path, _, frag = target.partition("#")
                dest = md if not path else os.path.normpath(os.path.join(os.path.dirname(md), path))
                if not os.path.exists(dest):
                    err(md, "line %d: link target does not exist: %s" % (n, target))
                elif frag and dest.endswith(".md") and frag not in anchors(dest):
                    err(md, "line %d: no heading for anchor #%s in %s" % (n, frag, os.path.relpath(dest, ROOT)))
    return count


# ---------------------------------------------------------------- schema subset
_schema_cache = {}


def load_json(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def load_schema(path):
    if path not in _schema_cache:
        _schema_cache[path] = load_json(path)
    return _schema_cache[path]


def resolve_ref(ref, base):
    file_part, _, pointer = ref.partition("#")
    path = os.path.normpath(os.path.join(os.path.dirname(base), file_part)) if file_part else base
    node = load_schema(path)
    for part in [p for p in pointer.split("/") if p]:
        node = node[part.replace("~1", "/").replace("~0", "~")]
    return node, path


TYPES = {
    "string": lambda v: isinstance(v, str),
    "integer": lambda v: isinstance(v, int) and not isinstance(v, bool),
    "number": lambda v: isinstance(v, (int, float)) and not isinstance(v, bool),
    "boolean": lambda v: isinstance(v, bool),
    "object": lambda v: isinstance(v, dict),
    "array": lambda v: isinstance(v, list),
    "null": lambda v: v is None,
}


def validate(value, schema, base, at="$"):
    """Validate against the JSON Schema subset used in schemas/. Returns a list of problems."""
    out = []
    if "$ref" in schema:
        target, tbase = resolve_ref(schema["$ref"], base)
        out += validate(value, target, tbase, at)
    if "type" in schema and not TYPES[schema["type"]](value):
        return out + ["%s: expected %s" % (at, schema["type"])]
    if "const" in schema and value != schema["const"]:
        out.append("%s: expected constant %r" % (at, schema["const"]))
    if "enum" in schema and value not in schema["enum"]:
        out.append("%s: %r is not one of the allowed values" % (at, value))
    if "pattern" in schema and isinstance(value, str) and not re.search(schema["pattern"], value):
        out.append("%s: %r does not match %s" % (at, value, schema["pattern"]))
    if "minimum" in schema and isinstance(value, (int, float)) and value < schema["minimum"]:
        out.append("%s: below minimum %s" % (at, schema["minimum"]))
    if "maximum" in schema and isinstance(value, (int, float)) and value > schema["maximum"]:
        out.append("%s: above maximum %s" % (at, schema["maximum"]))
    for sub in schema.get("allOf", []):
        out += validate(value, sub, base, at)
    if "anyOf" in schema:
        attempts = [validate(value, sub, base, at) for sub in schema["anyOf"]]
        if not any(not a for a in attempts):
            out.append("%s: matches none of the alternatives (%s)" % (at, "; ".join(a[0] for a in attempts if a)))
    if isinstance(value, dict):
        props = schema.get("properties", {})
        for key in schema.get("required", []):
            if key not in value:
                out.append("%s: missing required property %r" % (at, key))
        for key, sub in value.items():
            if key in props:
                out += validate(sub, props[key], base, "%s.%s" % (at, key))
            elif schema.get("additionalProperties") is False:
                out.append("%s: unexpected property %r" % (at, key))
    if isinstance(value, list):
        if len(value) < schema.get("minItems", 0):
            out.append("%s: fewer than %d items" % (at, schema["minItems"]))
        if "items" in schema:
            for i, item in enumerate(value):
                out += validate(item, schema["items"], base, "%s[%d]" % (at, i))
    return out


VERSION_TO_SCHEMA = {
    "cl.rule/1": "rule", "cl.correction/1": "correction", "cl.source_snapshot/1": "source-snapshot",
    "cl.artifact/1": "artifact", "cl.context/1": "context", "cl.run/1": "run", "cl.receipt/1": "receipt",
    "cl.action/1": "action-request", "cl.event/1": "event", "cl.event_log/1": "event-log", "cl.marker/1": "folder-marker",
}


def check_json():
    files = blocks = validated = 0
    for path in walk(".json"):
        files += 1
        try:
            data = load_json(path)
        except ValueError as exc:
            err(path, "invalid JSON: %s" % exc)
            continue
        if os.sep + "schemas" + os.sep in path:
            if "PROPOSED" not in data.get("description", ""):
                err(path, "schema description must say it is PROPOSED")
            continue
        if not isinstance(data, dict) or "$schema" not in data:
            err(path, "example file must name its schema in \"$schema\"")
            continue
        if "PROPOSED" not in data.get("_note", ""):
            err(path, "example file must carry a \"_note\" saying it is PROPOSED")
        schema_path = os.path.normpath(os.path.join(os.path.dirname(path), data["$schema"]))
        if not os.path.exists(schema_path):
            err(path, "schema not found: %s" % data["$schema"])
            continue
        validated += 1
        for problem in validate(data, load_schema(schema_path), schema_path):
            err(path, "schema: " + problem)
    for md in walk(".md"):
        _, fenced = split_markdown(md)
        for info, line_no, lines in fenced:
            if info != "json":
                continue
            blocks += 1
            try:
                data = json.loads("\n".join(lines))
            except ValueError as exc:
                err(md, "line %d: invalid JSON block: %s" % (line_no, exc))
                continue
            name = VERSION_TO_SCHEMA.get(data.get("schema_version")) if isinstance(data, dict) else None
            if name:
                schema_path = os.path.join(ROOT, "schemas", name + ".schema.json")
                for problem in validate(data, load_schema(schema_path), schema_path):
                    err(md, "line %d: schema: %s" % (line_no, problem))
    return files, blocks, validated


# ---------------------------------------------------------------- event logs
def canonical(obj):
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sha(text):
    return "sha256:" + hashlib.sha256(text.encode("utf-8")).hexdigest()


def event_hash(event, prev_hash):
    envelope = {k: v for k, v in event.items() if k not in ("hash", "payload")}
    envelope["prev_hash"] = prev_hash
    return sha(prev_hash + "\n" + canonical(envelope))


def event_logs():
    for path in walk(".json"):
        try:
            data = load_json(path)
        except ValueError:
            continue
        if isinstance(data, dict) and data.get("schema_version") == "cl.event_log/1":
            yield path, data


def check_event_logs(fix=False):
    count = 0
    for path, log in event_logs():
        events, chain = log["events"], log["chain"]
        prev, seen, last_time = chain["first_prev_hash"], set(), ""
        for i, e in enumerate(events):
            count += 1
            tag = "event %s" % e.get("event_id")
            if e["seq"] != chain["first_seq"] + i:
                err(path, "%s: seq %s is not contiguous" % (tag, e["seq"]))
            if e["occurred_at"] < last_time:
                err(path, "%s: occurred_at goes backwards" % tag)
            last_time = e["occurred_at"]
            for cause in e["caused_by"]:
                if cause not in seen:
                    err(path, "%s: caused_by %s is not an earlier event in this log" % (tag, cause))
            if e["workspace_id"] != log["workspace_id"]:
                err(path, "%s: belongs to another workspace" % tag)
            present = e.get("payload_state") == "present"
            if fix:
                if present:
                    e["payload_digest"] = sha(canonical(e["payload"]))
                e["prev_hash"] = prev
                e["hash"] = event_hash(e, prev)
            if present != (e["payload"] is not None):
                err(path, "%s: payload_state does not agree with payload" % tag)
            if present and e["payload_digest"] != sha(canonical(e["payload"])):
                err(path, "%s: payload_digest does not match payload" % tag)
            if e["prev_hash"] != prev:
                err(path, "%s: prev_hash does not match the previous event" % tag)
            if e["hash"] != event_hash(e, prev):
                err(path, "%s: hash does not verify" % tag)
            prev = e["hash"]
            seen.add(e["event_id"])
        if fix:
            chain["head_hash"], chain["last_seq"] = prev, events[-1]["seq"]
            with open(path, "w", encoding="utf-8") as fh:
                json.dump(log, fh, indent=2, ensure_ascii=False)
                fh.write("\n")
        if chain["head_hash"] != prev or chain["last_seq"] != events[-1]["seq"]:
            err(path, "chain head does not match the last event")
    return count


# ---------------------------------------------------------------- journey reconstruction
def local_time(stamp, tz_name):
    moment = datetime.strptime(stamp, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    try:
        from zoneinfo import ZoneInfo
        return moment.astimezone(ZoneInfo(tz_name)).strftime("%d %b %Y %H:%M:%S") + " (" + tz_name + ")"
    except Exception:  # no timezone database available
        return stamp + " (UTC)"


def show_value(v):
    if v.get("type") == "money":
        return "%s %s" % (v["currency"], "{:,.2f}".format(float(v["amount"])))
    return str(v.get("text", v.get("number", v.get("date", v.get("type")))))


def reconstruct(example_dir, correction_id):
    """Follow stored references from a correction to an executed action. Returns narrative lines; raises LookupError on a broken hop."""
    docs = [load_json(os.path.join(example_dir, f)) for f in sorted(os.listdir(example_dir)) if f.endswith(".json")]
    by_version = {}
    for d in docs:
        by_version.setdefault(d.get("schema_version"), []).append(d)
    log = by_version["cl.event_log/1"][0]
    events, tz = log["events"], log["display_tz"]

    def one(kind, pred, what):
        found = [e for e in events if e["type"] == kind and pred(e)]
        if not found:
            raise LookupError("broken hop: no %s event where %s" % (kind, what))
        return found[0]

    def caused(e, cause):
        return cause["event_id"] in e["caused_by"]

    def say(e, verb):
        who = e["actor"].get("display_name", e["actor"]["id"])
        lines.append("%-11s %s  [%s, seq %d]  %s  (by %s)" % (verb, local_time(e["occurred_at"], tz), e["event_id"], e["seq"], e["summary"], who))

    lines = []
    correction = next((d for d in by_version.get("cl.correction/1", []) if d["correction_id"] == correction_id), None)
    if correction is None:
        raise LookupError("broken hop: correction %s not found" % correction_id)
    said = one("correction.recorded", lambda e: e["refs"].get("correction_id") == correction_id, "refs.correction_id matches")
    say(said, "SAID")
    rule = next((d for d in by_version.get("cl.rule/1", []) if d["origin"].get("correction_id") == correction_id), None)
    if rule is None:
        raise LookupError("broken hop: no rule whose origin is %s" % correction_id)
    rid = rule["rule_id"]
    step = one("rule.candidate_created", lambda e: caused(e, said) and e["refs"].get("rule_id") == rid, "caused by the correction")
    say(step, "PROPOSED")
    for kind, verb in (("rule.cases_tested", "TESTED"), ("rule.backtested", "TRIED"), ("rule.approved", "APPROVED"), ("rule.activated", "TURNED ON")):
        step = one(kind, lambda e, s=step: caused(e, s) and e["refs"].get("rule_id") == rid, "caused by the previous rule event")
        say(step, verb)
    failing = None
    for run in by_version.get("cl.run/1", []):
        for result in run["results"]:
            if result["rule_id"] == rid and result["outcome"] == "fail" and result["effective_enforcement"] == "block":
                failing = (run, result)
    if failing is None:
        raise LookupError("broken hop: no run record in which %s failed" % rid)
    run, result = failing
    findings = {f["finding_id"] for f in result["findings"]}
    triggered = one("run.completed", lambda e: e["refs"].get("run_id") == run["run_id"], "refs.run_id matches the run record")
    say(triggered, "TRIGGERED")
    for f in result["findings"]:
        src = run["sources"][0]
        lines.append("            finding %s at %s: found %s, expected %s; rules revision %d; source %s (%d days old)" % (
            f["finding_id"], f["location"]["label"], show_value(f["found"]), show_value(f["expected"]),
            run["policy"]["policy_rev"], src["snapshot_id"], src["age_days"]))
    say(one("action.blocked", lambda e: caused(e, triggered), "caused by the failing run"), "BLOCKED")
    fix = one("fix.proposed", lambda e: caused(e, triggered) and findings & set(e["payload"]["addresses"]), "addresses the findings")
    say(fix, "SUGGESTED")
    change = one("change.recorded", lambda e: caused(e, fix) and e["refs"].get("fix_id") == fix["refs"]["fix_id"], "applies the fix")
    say(change, "CHANGED")
    lines.append("            before %s" % change["payload"]["from_hash"])
    lines.append("            after  %s" % change["payload"]["to_hash"])
    recheck = one("run.completed", lambda e: caused(e, change), "caused by the change")
    if not findings <= set(recheck["payload"].get("resolved_findings", [])):
        raise LookupError("broken hop: the recheck does not record the findings as resolved")
    say(recheck, "RE-CHECKED")
    receipt = one("receipt.issued", lambda e: caused(e, recheck), "caused by the recheck")
    request = one("action.requested", lambda e: e["refs"].get("receipt_id") == receipt["refs"]["receipt_id"], "relies on that receipt")
    say(request, "REQUESTED")
    current = receipt
    while True:  # a receipt may be invalidated and replaced before approval
        gone = [e for e in events if e["type"] == "receipt.invalidated" and e["refs"].get("receipt_id") == current["refs"]["receipt_id"]]
        if not gone:
            break
        say(gone[0], "INVALIDATED")
        rerun = one("run.completed", lambda e: caused(e, gone[0]), "caused by the invalidation")
        say(rerun, "RE-CHECKED")
        current = one("receipt.issued", lambda e: caused(e, rerun), "caused by the new run")
    action_id = request["refs"]["action_id"]
    approved = one("action.approved", lambda e: e["refs"].get("action_id") == action_id and e["refs"].get("receipt_id") == current["refs"]["receipt_id"]
                   and caused(e, request), "bound to the current receipt and the request")
    say(approved, "APPROVED")
    verified = one("action.revalidated", lambda e: caused(e, approved), "caused by the approval")
    say(verified, "VERIFIED")
    done = one("action.executed", lambda e: caused(e, verified), "caused by the revalidation")
    say(done, "EXECUTED")
    if done["payload"]["executed_content_hash"] != change["payload"]["to_hash"]:
        raise LookupError("broken hop: the executed bytes are not the version produced by the change")
    if approved["actor"]["kind"] != "human" or done["actor"]["kind"] != "adapter" or triggered["actor"]["kind"] != "system":
        raise LookupError("detection, approval and execution must be by system, human and adapter respectively")
    lines.append("            executed bytes = version after the change; detection by system, approval by human, execution by adapter")
    return lines


def check_journeys(show=False):
    targets = [(os.path.join(ROOT, "examples", "sales-proposal"), "cor_PRICE001")]
    for example_dir, correction_id in targets:
        try:
            lines = reconstruct(example_dir, correction_id)
        except (LookupError, KeyError, IndexError) as exc:
            err(example_dir, "journey of %s cannot be reconstructed: %s" % (correction_id, exc))
            continue
        if show:
            print("Journey of %s, reconstructed from stored references only:\n" % correction_id)
            print("\n".join(lines) + "\n")
    return len(targets)


# ---------------------------------------------------------------- wireframes
def check_wireframes(fix=False):
    count = 0
    for md in walk(".md"):
        with open(md, encoding="utf-8") as fh:
            lines = fh.read().split("\n")
        changed, i = False, 0
        while i < len(lines):
            if lines[i].strip() == "```text" and i + 1 < len(lines) and lines[i + 1].startswith("+-"):
                j = i + 1
                while j < len(lines) and lines[j].strip() != "```":
                    j += 1
                block = lines[i + 1:j]
                width = max(len(row.rstrip()) for row in block)
                count += 1
                for k, row in enumerate(block):
                    row = row.rstrip()
                    framed = bool(row) and row[0] in "|+" and row[-1] in "|+"
                    if fix and framed and len(row) < width:
                        pad = "-" if row.startswith("+") and set(row) <= set("+-") else " "
                        row = row[:-1] + pad * (width - len(row)) + row[-1]
                        if row != block[k]:
                            lines[i + 1 + k], changed = row, True
                    if not framed:
                        err(md, "line %d: wireframe row must start and end with | or +" % (i + 2 + k))
                    elif len(row) != width:
                        err(md, "line %d: wireframe row is %d wide, expected %d" % (i + 2 + k, len(row), width))
                    if any(ord(ch) > 126 for ch in row):
                        err(md, "line %d: wireframe uses a non-ASCII character" % (i + 2 + k))
                i = j
            i += 1
        if changed:
            with open(md, "w", encoding="utf-8") as fh:
                fh.write("\n".join(lines))
    return count


def main(argv):
    fix, show = "--fix" in argv, "--journey" in argv
    if fix:
        errors_before = len(errors)
        check_wireframes(fix=True)
        check_event_logs(fix=True)
        del errors[errors_before:]
    links = check_links()
    files, blocks, validated = check_json()
    events = check_event_logs()
    journeys = check_journeys(show)
    frames = check_wireframes()
    print("links checked: %d | JSON files: %d (validated against schemas: %d) | JSON blocks in docs: %d" % (links, files, validated, blocks))
    print("events verified: %d | journeys reconstructed: %d | wireframes: %d" % (events, journeys, frames))
    if errors:
        print("\n%d problem(s):" % len(errors))
        for e in errors:
            print("  - " + e)
        return 1
    print("OK")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
