"""Ingestion gates for the commentary layer.

The gates are §6 of `docs/commentary-layer-decisions.md`, one function each,
pure over the sidecar plus the work's spine and manifest — nothing here reads a
file or knows where the data lives, the way `quality.check_breathing` takes its
tokens and its allowlist as arguments. A stage 7 step will call `check_all` per
commentary and refuse to emit that commentary (not the work) on a FAIL.

Two of the eleven gates are NOT implemented here, and say so in the report
rather than being silently absent:

  6  HTML safety wants `sanitizeHtml(body) === body` with the real sanitizer,
     which is TypeScript (`shared/lib/html.ts`). Re-stating its allowlist in
     Python would drift from it, and a sanitizer gate that has drifted is worse
     than no gate — the check belongs in a Node step that imports the actual
     function (`shared/scripts/audit-forms-block.mjs` shows the esbuild route).
  9b The AI divergence threshold is plan unknown 9 and unset; until John sets
     it the gate WARNS on the rate and his sample review is the pass. The rest
     of gate 9 (fields present, flags resolved, audit trail) is checked.

Reported in `stage2_validate` house style: a dict per check with domain-named
keys and an `ok`, and `report["ok"] = all(...)` over them. A `skipped` check is
not `ok = True` — it carries `ok: None` and a reason, so a caller cannot read a
green report as "everything was checked".
"""

from __future__ import annotations

from .refs import column_key, column_range, line_key

# A note's lemma verdict blocks the build only when it is an outright error, or
# when nobody has looked. `variant-reading` is scholarly content: Hicks and the
# CAG authors read a different text from ours often, and saying so is the
# feature (decisions §6 gate 2).
BLOCKING_VERDICTS = {"error"}
UNCHECKED_VERDICT = "unchecked"
SNAP_LIMIT = 2          # lines; mirrors the reader's nearest-line fallback

AI_METHOD_FIELDS = (
    "model", "date", "methodVersion", "glossaryVersion", "sourceStream",
    "auditTrail", "correctionsUrl", "methodsNoteHtml",
)
AI_REFERENCE_FIELDS = (
    "reference", "passes", "flagsRaised", "flagsResolved", "divergenceRate",
    "checker",
)
# A checker names a person or a model run. These are the words that look like a
# name and are not one; the standard is docs/alignment-status.md's 2026-07-31
# correction, where "confirmed" turned out to mean "a model checked a model".
GENERIC_CHECKERS = {
    "verified", "confirmed", "checked", "ok", "yes", "true", "auto",
    "automatic", "pipeline", "script", "tbd", "todo", "n/a", "na", "-",
}


def _fail(check: dict, message: str) -> None:
    check["problems"].append(message)


def _check(name: str, **fields) -> dict:
    return {"name": name, "problems": [], **fields}


def _seal(check: dict) -> dict:
    check["ok"] = not check["problems"]
    return check


def _skipped(name: str, reason: str) -> dict:
    return {"name": name, "ok": None, "skipped": reason, "problems": []}


def _pos(key: tuple) -> int:
    """A Bekker line key as one sortable integer, so a span can be ordered by
    its start and, within that, widest first."""
    page, side, line = key
    return (page * 2 + (0 if side == "a" else 1)) * 1000 + line


def _span_bounds(span: dict) -> tuple[tuple, tuple]:
    """(lo_key, hi_key) for a span, honouring `toColumn`."""
    lo = line_key(span["column"], span["lo"])
    hi = line_key(span.get("toColumn") or span["column"], span["hi"])
    return lo, hi


# -- Gate 1: range resolves ---------------------------------------------------

def check_ranges(notes, spine_lines, book_for_line) -> dict:
    """Every range names columns this work has, runs forwards, and anchors on a
    line that exists (or within SNAP_LIMIT of one) inside a book.

    `spine_lines` maps a column to the set of line numbers it carries;
    `book_for_line(column, line)` is `Manifest.book_for_line`.
    """
    check = _check("ranges", notes=len(notes), snapped=0)
    for note in notes:
        span = note["range"]
        columns = [span["column"]]
        if span.get("toColumn"):
            try:
                columns = column_range(span["column"], span["toColumn"])
            except ValueError as err:
                _fail(check, f"{note['id']}: {err}")
                continue
        unknown = [c for c in columns if c not in spine_lines]
        if unknown:
            _fail(check, f"{note['id']}: column(s) not in this work's spine: {', '.join(unknown)}")
            continue
        lo, hi = _span_bounds(span)
        if hi < lo:
            _fail(check, f"{note['id']}: range runs backwards ({span})")
            continue

        anchor = note.get("anchor")
        if not anchor:
            _fail(check, f"{note['id']}: no anchor emitted")
            continue
        if anchor["column"] not in spine_lines:
            _fail(check, f"{note['id']}: anchor column {anchor['column']} not in this work's spine")
            continue
        lines = spine_lines[anchor["column"]]
        if anchor["line"] not in lines:
            _fail(check, f"{note['id']}: anchor {anchor['column']}{anchor['line']} is not a line of this work")
            continue
        # The anchor is allowed to differ from the commentator's own lo — his
        # edition's lineation is not ours — but only by a couple of lines, and
        # the note has to admit it moved.
        if (anchor["column"], anchor["line"]) != (span["column"], span["lo"]):
            if not note.get("snapped"):
                _fail(check, f"{note['id']}: anchor moved from {span['column']}{span['lo']} but snapped is not set")
            if anchor["column"] == span["column"]:
                distance = abs(anchor["line"] - span["lo"])
                if distance > SNAP_LIMIT:
                    _fail(check, f"{note['id']}: anchor snapped {distance} lines, limit {SNAP_LIMIT}")
            check["snapped"] += 1
        elif note.get("snapped"):
            _fail(check, f"{note['id']}: snapped is set but the anchor is the range's own start")
        if book_for_line(anchor["column"], anchor["line"]) is None:
            _fail(check, f"{note['id']}: anchor {anchor['column']}{anchor['line']} falls in an inter-book gap")
    return _seal(check)


# -- Gate 2: lemma to Bekker --------------------------------------------------

def check_lemmata(notes, latin_table=None) -> dict:
    """A lemma's verdict is present, non-blocking, and carries what it needs.

    The Greek branch's own matching (do the lemma's tokens stand in our text
    within the range?) is the ingestion step's job and is recorded as the
    verdict; this gate checks that a verdict exists, that nobody shipped an
    `error` or an `unchecked`, that a `variant-reading` says what our text
    reads instead, and that a Latin incipit is in the authored table.
    """
    check = _check("lemmata", with_lemma=0, variant_readings=0)
    table = latin_table or {}
    for note in notes:
        lemma = note.get("lemma")
        if not lemma:
            continue
        check["with_lemma"] += 1
        verdict = lemma.get("verdict")
        if not verdict:
            _fail(check, f"{note['id']}: lemma has no verdict")
            continue
        if verdict in BLOCKING_VERDICTS:
            _fail(check, f"{note['id']}: lemma verdict {verdict!r} — adjudicate it or drop the note")
        if verdict == UNCHECKED_VERDICT:
            _fail(check, f"{note['id']}: lemma is unchecked")
        if verdict == "variant-reading":
            check["variant_readings"] += 1
            if not lemma.get("variant"):
                _fail(check, f"{note['id']}: variant-reading with no variant recorded")
        if verdict == "foreign-lemma":
            if note["id"] not in table:
                _fail(check, f"{note['id']}: foreign lemma with no entry in the Latin→Bekker table")
    return _seal(check)


# -- Gate 3: divisio tiling ---------------------------------------------------

def check_divisio(root, note_ids) -> dict:
    """Children tile their parent: in order, no gap, no overlap except the
    declared one-line `midLine` case, first at the parent's lo, last at its hi.
    """
    check = _check("divisio", nodes=0, mid_line=0)
    if root is None:
        return _seal(check)

    def walk(node, path):
        check["nodes"] += 1
        stated = node.get("statedIn")
        if not stated:
            _fail(check, f"{path}: no statedIn")
        elif stated not in note_ids:
            _fail(check, f"{path}: statedIn {stated!r} names no note in this commentary")
        children = node.get("children") or []
        if not children:
            return
        try:
            parent_lo, parent_hi = _span_bounds(node["range"])
        except (KeyError, ValueError) as err:
            _fail(check, f"{path}: unusable range ({err})")
            return
        previous_hi = None
        for i, child in enumerate(children):
            here = f"{path}/{i}"
            try:
                lo, hi = _span_bounds(child["range"])
            except (KeyError, ValueError) as err:
                _fail(check, f"{here}: unusable range ({err})")
                continue
            if hi < lo:
                _fail(check, f"{here}: range runs backwards")
            if previous_hi is None:
                if lo != parent_lo:
                    _fail(check, f"{here}: first child starts at {child['range']}, parent starts at {node['range']}")
            else:
                expected = (previous_hi[0], previous_hi[1], previous_hi[2] + 1)
                if child.get("midLine"):
                    check["mid_line"] += 1
                    # Aquinas divides mid-line (402a4, 402a7) and a Bekker line
                    # is our finest grain, so the two parts share one line.
                    if lo != previous_hi:
                        _fail(check, f"{here}: midLine child starts at {child['range']}, not on the previous child's last line")
                elif lo < expected:
                    _fail(check, f"{here}: overlaps the previous child and is not marked midLine")
                elif lo > expected:
                    _fail(check, f"{here}: gap before it — the previous child ends two lines back or more")
            previous_hi = hi
            walk(child, here)
        if previous_hi is not None and previous_hi != parent_hi:
            _fail(check, f"{path}: last child ends at {children[-1]['range']}, parent ends at {node['range']}")

    walk(root, "root")
    return _seal(check)


def stitch_fragments(fragments) -> tuple[list, list]:
    """Fold each lectio's authored divisio fragment into one tree (§2.4).

    A fragment belongs under the deepest node of another fragment whose range
    contains it. Returns (roots, orphans); an orphan is a fragment no other
    fragment contains and that is not itself a root — gate 3 fails on one.
    """
    indexed = [(f, _span_bounds(f["range"])) for f in fragments]
    # By start, and within a start the widest first: a parent is then always
    # placed before its children, and children land in document order.
    indexed.sort(key=lambda pair: (_pos(pair[1][0]), -_pos(pair[1][1])))
    roots: list = []
    for fragment, (lo, hi) in indexed:
        parent, parent_lo = None, None
        for other, (o_lo, o_hi) in indexed:
            if other is fragment or (o_lo, o_hi) == (lo, hi):
                continue
            if o_lo <= lo and hi <= o_hi:
                # The DEEPEST container: the one whose own start is latest.
                if parent is None or _pos(o_lo) >= parent_lo:
                    parent, parent_lo = other, _pos(o_lo)
        if parent is None:
            roots.append(fragment)
        else:
            parent.setdefault("children", []).append(fragment)
    # One commentary, one tree (§2.4). A second root is a fragment nothing
    # contains — gate 3 fails on it rather than emitting two trees.
    return roots[:1], roots[1:]


# -- Gates 4, 5, 7, 8, 10, 11 -------------------------------------------------

def check_streams(notes, streams, public: bool) -> dict:
    """Every hosted, non-partial stream has a body on every note; and on a
    public build no note carries a body for a stream this build does not host.
    """
    check = _check("streams", hosted=0, bodies=0)
    hosted = {s["id"] for s in streams if s.get("hosted")}
    full = {s["id"] for s in streams if s.get("hosted") and not s.get("partial")}
    known = {s["id"] for s in streams}
    check["hosted"] = len(hosted)
    for note in notes:
        body = note.get("body") or {}
        check["bodies"] += len(body)
        for stream_id in body:
            if stream_id not in known:
                _fail(check, f"{note['id']}: body for {stream_id!r}, which is not a stream of this commentary")
            elif stream_id not in hosted:
                # Fail-safe direction: the note is lost, never leaked.
                _fail(check, f"{note['id']}: body for {stream_id!r}, a stream this build does not host")
        for stream_id in full:
            if not (body.get(stream_id) or "").strip():
                _fail(check, f"{note['id']}: no body in {stream_id!r}, a full hosted stream")
    if public:
        for stream in streams:
            if stream.get("hosted") and stream["copyright"]["state"] not in ("pd", "cc-by-sa"):
                _fail(check, f"stream {stream['id']!r} is hosted on a public build but its copyright is {stream['copyright']['state']!r}")
            if "leakProbes" in stream:
                _fail(check, f"stream {stream['id']!r} still carries leakProbes; they are build input, not emitted data")
    return _seal(check)


def check_identity(notes, previous_ids=None) -> dict:
    """Ids are unique, never reassigned, and a `cont` copy repeats its head."""
    check = _check("identity", notes=len(notes), continuations=0)
    seen: dict[str, dict] = {}
    for note in notes:
        note_id = note.get("id")
        if not note_id:
            _fail(check, "a note has no id")
            continue
        if note_id in seen:
            if note.get("cont") or seen[note_id].get("cont"):
                check["continuations"] += 1
                if note.get("body") != seen[note_id].get("body"):
                    _fail(check, f"{note_id}: continuation copy's body differs from its head")
            else:
                _fail(check, f"{note_id}: duplicate id")
        else:
            seen[note_id] = note
    if previous_ids is not None:
        # An id is a citation target once it has shipped (§8 item 8), so a
        # rebuild may add and remove ids but may never move one.
        for note_id, note in seen.items():
            was = previous_ids.get(note_id)
            if was is not None and note.get("anchor") and was != note["anchor"]:
                _fail(check, f"{note_id}: id now anchors at {note['anchor']}, previously {was}")
    return _seal(check)


def check_applies_to(notes, translation_ids) -> dict:
    """`translationId` iff `appliesTo == 'translation'`, and it names a
    translation this build carries."""
    check = _check("applies_to", translation_notes=0)
    for note in notes:
        applies = note.get("appliesTo")
        if applies not in ("work", "translation"):
            _fail(check, f"{note['id']}: appliesTo is {applies!r}")
            continue
        translation = note.get("translationId")
        if applies == "translation":
            check["translation_notes"] += 1
            if not translation:
                _fail(check, f"{note['id']}: appliesTo translation with no translationId")
            elif translation not in translation_ids:
                _fail(check, f"{note['id']}: translationId {translation!r} is not a translation this build carries")
        elif translation:
            _fail(check, f"{note['id']}: translationId on a note that applies to the work")
    return _seal(check)


def check_honesty(notes) -> dict:
    """Every verdict names who reached it. "confirmed" with nobody behind it is
    the thing docs/alignment-status.md had to correct across a whole tracker."""
    check = _check("honesty", verdicts=0)
    for note in notes:
        lemma = note.get("lemma")
        if not lemma:
            continue
        check["verdicts"] += 1
        checker = (lemma.get("checker") or "").strip()
        if not checker:
            _fail(check, f"{note['id']}: lemma verdict with no checker")
        elif checker.lower() in GENERIC_CHECKERS:
            _fail(check, f"{note['id']}: checker {checker!r} names nobody — a person, or a model id plus its run id")
    return _seal(check)


def check_coverage(entry, notes, bekker_range) -> dict:
    """The emitted coverage and count describe the notes actually emitted, and
    sit inside the work's own Bekker range."""
    check = _check("coverage", spans=len(entry.get("coverage") or []))
    if entry.get("noteCount") != len({n["id"] for n in notes if not n.get("cont")}):
        _fail(check, f"noteCount {entry.get('noteCount')} != {len({n['id'] for n in notes if not n.get('cont')})} distinct notes emitted")
    if bekker_range:
        first, last = bekker_range
        lo_bound, hi_bound = column_key(first), column_key(last)
        for span in entry.get("coverage") or []:
            columns = [span["column"]]
            if span.get("toColumn"):
                columns.append(span["toColumn"])
            for column in columns:
                if not (lo_bound <= column_key(column) <= hi_bound):
                    _fail(check, f"coverage column {column} is outside the work's range {first}–{last}")
    return _seal(check)


def check_ai(streams, audit_trail_exists=None) -> dict:
    """`ai` iff role is ai-translation, every field filled, flags resolved, the
    run log where it says it is. The divergence THRESHOLD is unset (plan
    unknown 9), so the rate is reported and warned on, never failed."""
    check = _check("ai", streams=0, warnings=[])
    for stream in streams:
        ai = stream.get("ai")
        is_ai = stream.get("role") == "ai-translation"
        if is_ai and not ai:
            _fail(check, f"stream {stream['id']!r} is an ai-translation with no methods")
            continue
        if ai and not is_ai:
            _fail(check, f"stream {stream['id']!r} carries ai methods but its role is {stream.get('role')!r}")
            continue
        if not ai:
            continue
        check["streams"] += 1
        for field in AI_METHOD_FIELDS:
            if not str(ai.get(field) or "").strip():
                _fail(check, f"stream {stream['id']!r}: ai.{field} is empty")
        reference = ai.get("referenceCheck") or {}
        for field in AI_REFERENCE_FIELDS:
            if reference.get(field) in (None, "", []):
                _fail(check, f"stream {stream['id']!r}: ai.referenceCheck.{field} is empty")
        source = ai.get("sourceStream")
        source_stream = next((s for s in streams if s["id"] == source), None)
        if source_stream is None:
            _fail(check, f"stream {stream['id']!r}: sourceStream {source!r} is not a stream of this commentary")
        elif source_stream.get("lang") != "grc":
            # The provenance chain has to be Greek → English (plan §AI
            # translation pilot); generation never sees the reference.
            _fail(check, f"stream {stream['id']!r}: sourceStream {source!r} is {source_stream.get('lang')!r}, not the Greek")
        raised, resolved = reference.get("flagsRaised"), reference.get("flagsResolved")
        if isinstance(raised, int) and isinstance(resolved, int) and resolved != raised:
            _fail(check, f"stream {stream['id']!r}: {raised - resolved} of {raised} divergence flags unresolved")
        if audit_trail_exists is not None and not audit_trail_exists(ai.get("auditTrail")):
            _fail(check, f"stream {stream['id']!r}: auditTrail {ai.get('auditTrail')!r} is not in the repo")
        rate = reference.get("divergenceRate")
        if isinstance(rate, (int, float)):
            check["warnings"].append(
                f"stream {stream['id']!r}: divergence rate {rate} — no threshold is set (plan unknown 9), "
                "so this is John's sample review to pass, not a gate"
            )
    return _seal(check)


# -- The whole set ------------------------------------------------------------

def check_all(
    entry,
    notes,
    *,
    spine_lines,
    book_for_line,
    translation_ids,
    bekker_range=None,
    divisio=None,
    latin_table=None,
    previous_ids=None,
    audit_trail_exists=None,
    public=False,
) -> dict:
    """Every gate of decisions §6 that is checkable from data, plus an honest
    record of the two that are not."""
    note_ids = {n["id"] for n in notes if n.get("id")}
    checks = [
        check_ranges(notes, spine_lines, book_for_line),
        check_lemmata(notes, latin_table),
        check_divisio(divisio, note_ids),
        check_streams(notes, entry.get("streams") or [], public),
        _skipped(
            "html_safety",
            "gate 6 runs where the sanitizer lives: a Node step over shared/lib/html.ts, "
            "not a Python restatement of its allowlist",
        ),
        check_identity(notes, previous_ids),
        check_applies_to(notes, translation_ids),
        check_ai(entry.get("streams") or [], audit_trail_exists),
        check_honesty(notes),
        check_coverage(entry, notes, bekker_range),
    ]
    report = {
        "commentary": entry.get("id"),
        "work": entry.get("work"),
        "public": public,
        "checks": {c["name"]: c for c in checks},
    }
    report["ok"] = all(c["ok"] is not False for c in checks)
    report["checked"] = [c["name"] for c in checks if c["ok"] is not None]
    report["not_checked"] = [c["name"] for c in checks if c["ok"] is None]
    report["problems"] = [p for c in checks for p in c["problems"]]
    return report
