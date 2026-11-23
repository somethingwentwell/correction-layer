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
  7. Every example learning decision equals what the documented decision
     procedure (docs/12-learning.md, section 7) gives for its recorded inputs.
  8. In every example event log, a rule is only ever activated on a person's
     individual approval or on an automatic decision made inside a learning
     policy that a person set earlier; automatic pauses only touch rules that
     were activated automatically.
  9. Every example capture stream gives, delivery by delivery, the result and
     cursor that the documented intake procedure (docs/06, section 11) gives:
     duplicates dropped, out-of-order events held, gaps closed, dead letters
     counted, nothing lost silently. Signals that claim to come from a stream
     point at captured user turns attested by the runtime.
 10. Local images referenced from Markdown exist, and every agent skill
     (skills/<name>/SKILL.md) starts with YAML frontmatter whose `name` is
     its folder name and whose `description` says when to use it.

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
SKIP_DIRS = {".git", "__pycache__",
             # Implementation toolchain output (Phase 1 scaffold); never design fixtures.
             "node_modules", "dist", "coverage", ".data"}
# Toolchain configuration at the repository root: JSON, but not example files.
SKIP_ROOT_FILES = {"package.json", "package-lock.json", "tsconfig.json", "tsconfig.build.json"}
errors = []


def err(where, msg):
    errors.append("%s: %s" % (os.path.relpath(where, ROOT) if os.path.isabs(where) else where, msg))


def walk(ext):
    for base, dirs, files in os.walk(ROOT):
        dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS)
        for f in sorted(files):
            if f.endswith(ext) and not (base == ROOT and f in SKIP_ROOT_FILES):
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


IMAGE = re.compile(r"!\[[^\]]*\]\(([^)\s]+)\)")


def check_images():
    count = 0
    for md in walk(".md"):
        prose, _ = split_markdown(md)
        for n, line in prose:
            line = re.sub(r"`[^`]*`", "", line)
            for target in IMAGE.findall(line):
                if re.match(r"^[a-z][a-z0-9+.-]*:", target):
                    continue  # external scheme
                count += 1
                dest = os.path.normpath(os.path.join(os.path.dirname(md), target.partition("#")[0]))
                if not os.path.isfile(dest):
                    err(md, "line %d: image does not exist: %s" % (n, target))
    return count


def check_skills():
    count = 0
    base = os.path.join(ROOT, "skills")
    if not os.path.isdir(base):
        return 0
    for name in sorted(os.listdir(base)):
        path = os.path.join(base, name, "SKILL.md")
        if not os.path.isfile(path):
            err(os.path.join(base, name), "a skill folder without SKILL.md")
            continue
        count += 1
        with open(path, encoding="utf-8") as fh:
            text = fh.read()
        m = re.match(r"^---\n(.*?)\n---\n", text, re.S)
        if not m:
            err(path, "no YAML frontmatter between --- lines at the top")
            continue
        fields = dict(l.split(":", 1) for l in m.group(1).split("\n") if ":" in l)
        fields = {k.strip(): v.strip() for k, v in fields.items()}
        if fields.get("name") != name:
            err(path, "frontmatter name must be the folder name %r" % name)
        if not re.search(r"\bUse when\b", fields.get("description", "")):
            err(path, "frontmatter description must say when to use the skill (\"Use when ...\")")
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
    "cl.learning_policy/1": "learning-policy", "cl.learning_signal/1": "learning-signal", "cl.learning_decision/1": "learning-decision",
    "cl.capture_event/1": "capture-event", "cl.capture_stream/1": "capture-stream",
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
    targets = [(reconstruct, os.path.join(ROOT, "examples", "sales-proposal"), "cor_PRICE001"),
               (reconstruct_learning, os.path.join(ROOT, "examples", "learning"), "sig_KSGD0001")]
    for walker, example_dir, start in targets:
        try:
            lines = walker(example_dir, start)
        except (LookupError, KeyError, IndexError, TypeError) as exc:
            err(example_dir, "journey of %s cannot be reconstructed: %s" % (start, exc))
            continue
        if show:
            print("Journey of %s, reconstructed from stored references only:\n" % start)
            print("\n".join(lines) + "\n")
    return len(targets)



# ---------------------------------------------------------------- learning decisions
SCOPE_RANK = {"artifact": 0, "area": 1, "project": 2, "project_group": 3, "workspace": 4}
CAP_RANK = {"inbox": 0, "shadow": 1, "auto": 2}
SOFT_BLOCKERS = {"flags_existing_work", "daily_limit", "no_direct_statement", "surface_limit"}
EVIDENCE_BLOCKERS = {"no_trigger_case", "no_real_pass"}


def decide(d, policy):
    """Reference form of the decision procedure in docs/12-learning.md section 7.

    Pure function of the recorded inputs. Model confidence is not an input. It exists
    so that the example decisions can be checked; it is not a product implementation.
    """
    signals, cand, ev, lim = d["signals"], d["candidate"], d["evaluation"], policy["limits"]
    caps = {s["surface"]: s["max_outcome"] for s in policy["surfaces"] if s["enabled"]}
    if any(s["trust"] == "untrusted_content" or s["surface"] not in caps
           or (s["trust"] == "assistant_relayed" and s.get("text_matches_artifact_content")) for s in signals):
        return "discarded", ["untrusted_origin"]
    if d["suppressed"]:
        return "discarded", ["suppressed_by_user"]
    if cand is None:  # captured and identified, but no check type could express it
        return "inbox", ["not_compilable"]
    if cand["operation"] == "weaken_or_remove":
        return "declined", ["would_weaken_or_remove"]
    if cand["operation"] == "permission_change":
        return "declined", ["permission_change"]
    direct = any(s["trust"] == "user_direct" and s["author_id"] in policy["learn_from"] for s in signals)
    if cand["reusability"] == "one_off":
        return "record_only", ["one_off"]
    if cand["reusability"] in ("unclear", "recurring") and not direct and d["independent_episodes"] < lim["recurrence_min_episodes"]:
        return "record_only", ["not_enough_independent_episodes"]
    if ev["duplicates"]:
        return "record_only", ["already_covered"]
    blockers = []
    if cand["scope_project_id"] != policy["scope"]["project_id"] or \
            SCOPE_RANK[cand["scope_level"]] > SCOPE_RANK[policy["auto"]["max_scope_level"]]:
        blockers.append("scope_outside_delegation")
    if cand["check_kind"] not in policy["auto"]["check_kinds"] or cand["method"] not in policy["auto"]["methods"]:
        blockers.append("kind_not_delegated")
    if cand["touches_protected_targets"]:
        blockers.append("protected_target")
    if cand["pins_fact_without_source"]:
        blockers.append("fact_without_source")
    if not direct:
        blockers.append("no_direct_statement")
    cap = max(CAP_RANK[caps[s["surface"]]] for s in signals)
    if cap < CAP_RANK["auto"]:
        blockers.append("surface_limit")
    if not all(s["episode_capture_complete"] for s in signals):
        blockers.append("capture_incomplete")
    if any(s["late"] or s["delivery"] == "backfill" for s in signals):
        blockers.append("captured_late")
    if not (cand["referent_resolved"] and cand["parameters_grounded"] and cand["language_supported"]) \
            or cand["hedged"] or cand["model_flags"] or cand["reusability"] == "unclear":
        blockers.append("ambiguous")
    if ev["trigger_case"] is None:
        blockers.append("no_trigger_case")
    elif ev["trigger_case"]["result"] != "fail":
        blockers.append("trigger_not_caught")
    if sum(1 for c in ev["real_passing_cases"] if c["result"] == "pass") < lim["min_real_pass"]:
        blockers.append("no_real_pass")
    if ev["heldout"]["fail"] > lim["max_heldout_failures"]:
        blockers.append("flags_existing_work")
    if ev["heldout"]["unknown"] + ev["heldout"]["error"] > 0:
        blockers.append("undecidable_on_existing_work")
    if ev["generated"]["unexpected"] > 0:
        blockers.append("unexpected_on_variants")
    if ev["conflicts"]:
        blockers.append("conflict")
    if ev["contradicts_learned"]:
        blockers.append("contradicts_learned_rule")
    if ev["auto_activations_today"] >= lim["max_auto_activations_per_day"]:
        blockers.append("daily_limit")
    mode = policy["mode"]
    if mode == "suggest":
        return "inbox", ["mode_suggest"] + blockers
    if not blockers:
        return ("auto_activate" if mode == "auto_low_risk" else "auto_shadow"), []
    if set(blockers) <= EVIDENCE_BLOCKERS:
        return "waiting_for_evidence", blockers
    if set(blockers) <= SOFT_BLOCKERS and cap >= CAP_RANK["shadow"]:
        return "shadow_and_inbox", blockers
    return "inbox", blockers


def check_learning_decisions():
    count = 0
    by_dir = {}
    for path in walk(".json"):
        try:
            data = load_json(path)
        except ValueError:
            continue
        if isinstance(data, dict):
            by_dir.setdefault(os.path.dirname(path), []).append((path, data))
    for folder, docs in by_dir.items():
        policies = {(d["learning_policy_id"], d["revision"]): d for _, d in docs if d.get("schema_version") == "cl.learning_policy/1"}
        rules = {d["rule_id"]: d for _, d in docs if d.get("schema_version") == "cl.rule/1"}
        for path, d in docs:
            if d.get("schema_version") == "cl.learning_policy/1" and d["set_by"]["kind"] != "human":
                err(path, "a learning policy must be set by a person")
            if d.get("schema_version") == "cl.rule/1":
                auth = d.get("authority") or {}
                if auth.get("kind") == "delegated_learning":
                    if d.get("locked") or d["scope"]["level"] in ("workspace", "project_group"):
                        err(path, "a rule activated by delegated learning cannot be locked or wider than a project")
                    if d.get("method") == "model_review" or not any(c["kind"] == "negative" for c in d["cases"]) \
                            or not any(c["kind"] == "positive" for c in d["cases"]):
                        err(path, "a learned rule needs a real blocking and a real allowing example and cannot rest on a model's opinion")
                elif d.get("status") in ("active", "trial") and not d.get("approval"):
                    err(path, "an active rule without delegated authority must record who approved it")
            if d.get("schema_version") != "cl.learning_decision/1":
                continue
            count += 1
            ref = d["learning_policy"]
            policy = policies.get((ref["learning_policy_id"], ref["revision"]))
            if policy is None:
                err(path, "decision names a learning policy that is not in this folder")
                continue
            try:
                outcome, reasons = decide(d, policy)
            except (KeyError, TypeError) as exc:
                err(path, "decision inputs are incomplete: %r" % exc)
                continue
            if (outcome, reasons) != (d["outcome"], d["reasons"]):
                err(path, "recorded outcome %s %s differs from the decision procedure: %s %s" % (d["outcome"], d["reasons"], outcome, reasons))
            automatic = d["outcome"] in ("auto_activate", "auto_shadow", "shadow_and_inbox")
            if automatic != (d["authority"] is not None):
                err(path, "authority must be recorded for automatic outcomes and only for them")
            if automatic and d["authority"] and d["authority"]["delegated_by"] != policy["set_by"]["id"]:
                err(path, "delegated authority must name the person who set the learning policy")
            expected_status = {"auto_activate": "active", "auto_shadow": "trial", "shadow_and_inbox": "trial",
                               "inbox": "candidate", "waiting_for_evidence": "candidate"}.get(d["outcome"])
            if not (d["candidate"] and d["candidate"].get("rule_id")):
                expected_status = None
            if d["resulting_rule_status"] != expected_status:
                err(path, "resulting_rule_status should be %r for outcome %s" % (expected_status, d["outcome"]))
            effects = d["side_effects"]
            if d["candidate"] and d["candidate"].get("widening_requested") and not any(e["effect"] == "open_inbox_item" for e in effects):
                err(path, "a request for a wider scope must open an inbox item")
            if d["outcome"] in ("inbox", "shadow_and_inbox") and not any(e["effect"] == "open_inbox_item" for e in effects):
                err(path, "an inbox outcome must open an inbox item")
            for e in effects:
                if e["effect"] == "auto_pause_learned_rule":
                    target = rules.get(e.get("rule_id"))
                    if e.get("rule_id") not in (d["evaluation"] or {}).get("contradicts_learned", []):
                        err(path, "automatic pause must name a rule the candidate contradicts")
                    if target is not None and ((target.get("authority") or {}).get("kind") != "delegated_learning"
                                               or (target.get("authority") or {}).get("confirmed") or target.get("locked")):
                        err(path, "automatic pause may only touch an unconfirmed, unlocked rule that was activated by delegated learning")
    return count


def check_activation_authority():
    """Invariant 8 over every example event log."""
    count = 0
    for path, log in event_logs():
        by_id = {e["event_id"]: e for e in log["events"]}
        policies_set, auto_rules, approved_rules = {}, set(), set()
        for e in log["events"]:
            tag = "event %s" % e["event_id"]
            causes = [by_id[c] for c in e["caused_by"] if c in by_id]
            rule = e["refs"].get("rule_id")
            if e["type"] == "learning.policy_set":
                if e["actor"]["kind"] != "human":
                    err(path, "%s: a learning policy must be set by a person" % tag)
                policies_set[e["refs"]["learning_policy_id"]] = e
            elif e["type"] == "learning.decision_made" and e["payload"] and e["payload"]["outcome"].startswith("auto"):
                if e["refs"].get("learning_policy_id") not in policies_set:
                    err(path, "%s: automatic decision without an earlier learning.policy_set by a person" % tag)
                if not any(c["type"] == "learning.candidate_evaluated" for c in causes):
                    err(path, "%s: automatic decision is not caused by an evaluation" % tag)
            elif e["type"] == "rule.activated":
                count += 1
                by_person = any(c["type"] == "rule.approved" and c["actor"]["kind"] == "human" and c["refs"].get("rule_id") == rule for c in causes)
                by_delegation = any(c["type"] == "learning.decision_made" and c["payload"]["outcome"].startswith("auto")
                                    and c["refs"].get("rule_id") == rule for c in causes)
                if not (by_person or by_delegation):
                    err(path, "%s: rule activated without an individual approval or a delegated automatic decision" % tag)
                (approved_rules if by_person else auto_rules).add(rule)
            elif e["type"] == "rule.confirmed":
                auto_rules.discard(rule)
                approved_rules.add(rule)
            elif e["type"] == "rule.auto_paused":
                if rule not in auto_rules:
                    err(path, "%s: automatic pause of a rule that was not activated automatically in this log" % tag)
            elif e["type"] in ("rule.retired", "rule.suspended", "rule.approved", "learning.inbox_item_resolved", "action.approved",
                               "exception.granted", "attestation.recorded") and e["actor"]["kind"] != "human":
                err(path, "%s: %s must be performed by a person" % (tag, e["type"]))
            if e["type"].startswith("learning.signal") and e["payload"] and e["payload"].get("trust") == "untrusted_content":
                err(path, "%s: untrusted content must never be recorded as a learning signal" % tag)
    return count


def reconstruct_learning(example_dir, signal_id):
    """Follow one learning signal to its automatic activation and to the first block, repair and recheck it caused."""
    log = load_json(os.path.join(example_dir, "events.json"))
    events, tz = log["events"], log["display_tz"]
    lines = []

    def one(kind, pred, what):
        found = [e for e in events if e["type"] == kind and pred(e)]
        if not found:
            raise LookupError("broken hop: no %s event where %s" % (kind, what))
        return found[0]

    def caused(e, cause):
        return cause["event_id"] in e["caused_by"]

    def say(e, verb):
        lines.append("%-11s %s  [%s]  %s  (by %s)" % (verb, local_time(e["occurred_at"], tz), e["event_id"], e["summary"],
                                                    e["actor"].get("display_name", e["actor"]["id"])))

    signal = one("learning.signal_detected", lambda e: e["refs"].get("signal_id") == signal_id, "refs.signal_id matches")
    policy = one("learning.policy_set", lambda e: e["refs"]["learning_policy_id"] == signal["refs"].get("learning_policy_id")
                 and e["seq"] < signal["seq"] and e["actor"]["kind"] == "human", "a person set the learning policy before the signal")
    say(policy, "DELEGATED")
    say(signal, "DETECTED")
    step = one("learning.correction_extracted", lambda e: caused(e, signal), "caused by the signal")
    say(step, "EXTRACTED")
    candidate = one("rule.candidate_created", lambda e: caused(e, step), "caused by the extraction")
    say(candidate, "SAVED")
    rule = candidate["refs"]["rule_id"]
    tested = one("learning.candidate_evaluated", lambda e: caused(e, candidate), "caused by the candidate")
    say(tested, "TESTED")
    decided = one("learning.decision_made", lambda e: caused(e, tested), "caused by the evaluation")
    say(decided, "DECIDED")
    if decided["payload"]["model_confidence_used"] is not False:
        raise LookupError("a learning decision must not use model confidence")
    active = one("rule.activated", lambda e: caused(e, decided) and e["refs"].get("rule_id") == rule, "caused by the decision")
    say(active, "TURNED ON")
    fired = one("run.completed", lambda e: e["seq"] > active["seq"] and rule in e["payload"].get("failed_rules", []), "the learned rule failed")
    say(fired, "TRIGGERED")
    say(one("action.blocked", lambda e: caused(e, fired), "caused by the failing run"), "BLOCKED")
    change = one("change.recorded", lambda e: caused(e, fired), "caused by the failing run")
    say(change, "CHANGED")
    recheck = one("run.completed", lambda e: caused(e, change), "caused by the change")
    if not set(fired["payload"]["findings"]) <= set(recheck["payload"].get("resolved_findings", [])):
        raise LookupError("broken hop: the recheck does not record the finding as resolved")
    say(recheck, "RE-CHECKED")
    for e in events:  # what later happened to the learned rule itself
        if e["seq"] > recheck["seq"] and e["refs"].get("rule_id") == rule and e["type"] in ("rule.auto_paused", "rule.confirmed", "rule.retired"):
            say(e, {"rule.auto_paused": "AUTO-PAUSED", "rule.confirmed": "CONFIRMED", "rule.retired": "RETIRED"}[e["type"]])
    return lines


# ---------------------------------------------------------------- capture streams
def intake(deliveries):
    """Reference form of the capture intake procedure in docs/06 section 11.

    At-least-once delivery in, effectively-once processing out. Returns the result and
    cursor for each delivery. It exists to check the example; it is not a product implementation.
    """
    received, cursor, out = {}, 0, []
    for d in deliveries:
        seq = d["source_seq"]
        if seq in received:
            result = "duplicate" if received[seq] == d["content_digest"] else "rejected_conflict"
        else:
            received[seq] = d["content_digest"]
            if d["intake_validation"] == "consent_missing":
                result = "consent_blocked"
            elif d["intake_validation"] != "ok":
                result = "dead_letter"
            else:
                result = "accepted" if seq == cursor + 1 else "held_out_of_order"
        while cursor + 1 in received:
            cursor += 1
        out.append((result, cursor))
    return out


def check_capture_streams():
    count = 0
    streams, signals = {}, []
    for path in walk(".json"):
        try:
            data = load_json(path)
        except ValueError:
            continue
        if isinstance(data, dict) and data.get("schema_version") == "cl.capture_stream/1":
            streams[data["stream_id"]] = (path, data)
        if isinstance(data, dict) and data.get("schema_version") == "cl.learning_signal/1":
            signals.append((path, data))
    for path, st in streams.values():
        count += 1
        state, deliveries = st["state"], st["deliveries"]
        if [d["arrival"] for d in deliveries] != list(range(1, len(deliveries) + 1)):
            err(path, "deliveries must be numbered in arrival order")
        for d, (result, cursor) in zip(deliveries, intake(deliveries)):
            if (d["result"], d["ack_through"]) != (result, cursor):
                err(path, "delivery %d: recorded %s/ack %d, intake procedure gives %s/ack %d" % (d["arrival"], d["result"], d["ack_through"], result, cursor))
        cursor = intake(deliveries)[-1][1] if deliveries else 0
        results = [d["result"] for d in deliveries]
        if state["acked_through"] != cursor:
            err(path, "state.acked_through should be %d" % cursor)
        complete = state["final_seq"] is not None and cursor == state["final_seq"]
        if (state["status"] == "closed_complete") != complete:
            err(path, "state.status does not agree with cursor and final_seq")
        if state["duplicates_dropped"] != results.count("duplicate") or state["held_out_of_order"] != results.count("held_out_of_order"):
            err(path, "duplicate or out-of-order counts do not match the deliveries")
        if sorted(x["source_seq"] for x in state["dead_letters"]) != sorted(d["source_seq"] for d in deliveries if d["result"] == "dead_letter"):
            err(path, "dead_letters do not match the deliveries")
        if state["dead_letters"] and state["health"] == "healthy":
            err(path, "a stream with dead letters cannot be shown as healthy")
        if any(g["closed_at"] is None for g in state["gaps"]) and state["status"] == "closed_complete":
            err(path, "a stream with an open gap cannot be closed_complete")
        events = {e["source_seq"]: e for e in st["events"]}
        accepted = {d["source_seq"] for d in deliveries if d["result"] in ("accepted", "held_out_of_order")}
        if set(events) != accepted:
            err(path, "events listed must be exactly the validly received ones")
        for e in st["events"]:
            if e["stream_id"] != st["stream_id"] or e["binding"]["project_id"] != st["project_id"]:
                err(path, "event %d is bound to another stream or project" % e["source_seq"])
            if e["kind"] in ("agent_output", "tool_output") and (e["role"] == "user" or e["content"] is not None):
                err(path, "event %d: agent and tool output is never a user turn and its text is not sent" % e["source_seq"])
        human = [e["source_seq"] for e in st["events"] if e["kind"] in ("user_turn", "edit_observed", "review_action")]
        staged = [p["source_seq"] for p in st["pipeline"]]
        if sorted(human) != sorted(staged):
            err(path, "pipeline must account for every captured user turn, edit and review action, and nothing else")
        order = ["captured", "identified", "compiled", "tested", "activated"]
        for i, stage in enumerate(order):
            if state["counts"][stage] != sum(1 for p in st["pipeline"] if order.index(p["reached"]) >= i):
                err(path, "state.counts.%s does not match the pipeline list" % stage)
        for p in st["pipeline"]:
            if (p["reached"] == "captured") != (p["disposition"] == "not_a_signal") or (p["reached"] != "captured") != ("signal_id" in p):
                err(path, "pipeline entry %d: stage, disposition and signal do not agree" % p["source_seq"])
            if p["disposition"] in ("active", "shadow") and p["reached"] != "activated":
                err(path, "pipeline entry %d: a rule can only be on if the item reached 'activated'" % p["source_seq"])
    for path, sig in signals:
        cap = sig.get("capture")
        if sig["trust"] == "user_direct" and sig["surface"] == "attested_user_turn" and not cap:
            err(path, "a signal from an attested user turn must say which captured events it came from")
        if not cap or cap["stream_id"] not in streams:
            continue
        spath, st = streams[cap["stream_id"]]
        events = {e["source_seq"]: e for e in st["events"]}
        for seq, cid in zip(cap["source_seqs"], cap["capture_ids"]):
            e = events.get(seq)
            if e is None or e["capture_id"] != cid:
                err(path, "signal points at capture event %s which is not in %s" % (cid, os.path.relpath(spath, ROOT)))
            elif sig["trust"] == "user_direct" and not (e["kind"] == "user_turn" and e["role"] == "user" and e["attested_by"] in ("runtime_hook", "app")):
                err(path, "a user_direct signal must come from a user turn attested by the runtime or the app")
        deliveries = {d["source_seq"]: d for d in st["deliveries"] if d["result"] in ("accepted", "held_out_of_order")}
        if any(deliveries[seq]["delivery"] != cap["delivery"] for seq in cap["source_seqs"] if seq in deliveries):
            err(path, "signal's delivery mode differs from the stream's record")
        if sig["project_id"] != st["project_id"]:
            err(path, "signal and its capture stream are bound to different projects")
    return count

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
    images = check_images()
    skills = check_skills()
    files, blocks, validated = check_json()
    events = check_event_logs()
    journeys = check_journeys(show)
    decisions = check_learning_decisions()
    activations = check_activation_authority()
    streams = check_capture_streams()
    frames = check_wireframes()
    print("links checked: %d | JSON files: %d (validated against schemas: %d) | JSON blocks in docs: %d" % (links, files, validated, blocks))
    print("events verified: %d | journeys reconstructed: %d | wireframes: %d" % (events, journeys, frames))
    print("learning decisions recomputed: %d | rule activations with recorded authority: %d | capture streams replayed: %d" % (decisions, activations, streams))
    print("images checked: %d | agent skills checked: %d" % (images, skills))
    if errors:
        print("\n%d problem(s):" % len(errors))
        for e in errors:
            print("  - " + e)
        return 1
    print("OK")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
