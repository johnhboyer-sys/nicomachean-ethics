"""Stage 2: validation of the Stage 1 spine, chunks, and alignment.

Checks:
  1. Column completeness and monotonic order across 1094a-1181b.
  2. Line-number gaps inside columns (book-boundary gaps are expected and
     verified against the manifest; anything else is flagged).
  3. Alignment coverage in both directions.
  4. Greek/English length-ratio outliers (> 1.5 SD from the mean ratio).
  5. Proper-name spot check: names that should co-occur in the same column
     in both languages.
  6. Chapter English-offset coverage: every chapter must have a matching
     English section marker, or the reader silently misplaces its text.
  7. Sigla/character inventory of the Greek text: every non-Greek,
     non-expected character with counts and sample locations.

Emits build/stage2/validation_report.json and .md (human-readable).
"""

from __future__ import annotations

import json
import statistics
import unicodedata
from bisect import bisect_right
from collections import defaultdict
from pathlib import Path

from .config import BUILD_DIR, Manifest
from .refs import column_key, column_range, ref_key

def _base(text: str) -> str:
    decomposed = unicodedata.normalize("NFD", text)
    return "".join(c for c in decomposed if not unicodedata.combining(c)).lower()

# Characters we expect in Bywater's text besides Greek letters.
EXPECTED_NON_GREEK = set(" .,·;'’ʼ—-()[]")
GRAMMAR_EVEN_SAMPLES = 257
GRAMMAR_EDGE_SEGMENTS = 32


def _is_greek_letter(ch: str) -> bool:
    if not ch.isalpha():
        return False
    try:
        return "GREEK" in unicodedata.name(ch)
    except ValueError:
        return False


def check_offsets(offsets: dict, segments: list[dict]) -> dict:
    """Validate the stage6 word-offset primitive against the stage3 segments.

    Lives here with the other checks, but runs from stage6 — offsets.json does
    not exist yet when stage 2 runs.

    Structural failures (a base that walks backwards, a base delta that misses
    its segment's token count, an out-of-range chapter anchor) are hard: every
    offset-indexed feature downstream would silently read the wrong word. A
    line-snapped chapter bound is not a failure — it is a known limit of the
    source, counted here so it can be surfaced rather than hidden.
    """
    base = offsets["seg_base_offset"]
    coords = offsets["segments"]
    problems: list[str] = []

    if len(base) != len(segments) or len(coords) != len(segments):
        problems.append(
            f"length mismatch: {len(base)} bases / {len(coords)} coords / "
            f"{len(segments)} segments"
        )
    else:
        for i, seg in enumerate(segments):
            count = sum(len(l["tokens"]) for l in seg["lines"])
            if i and base[i] < base[i - 1]:
                problems.append(f"base decreases at seg {i} ({seg['id']})")
            expected = base[i] + count
            actual = base[i + 1] if i + 1 < len(base) else offsets["token_count"]
            if actual != expected:
                problems.append(
                    f"seg {i} ({seg['id']}): base delta {actual - base[i]} != "
                    f"token count {count}"
                )
            expected_runs = [
                [line["n"], len(line["tokens"]), line["sub"]]
                if line.get("sub")
                else [line["n"], len(line["tokens"])]
                for line in seg["lines"]
            ]
            if coords[i]["line_runs"] != expected_runs:
                problems.append(
                    f"seg {i} ({seg['id']}): line_runs do not match stage3 lines "
                    f"(expected {expected_runs!r}, got {coords[i]['line_runs']!r})"
                )

    # Round-trip a sample: global -> (seg, pos) must return the original.
    def to_local(g: int) -> tuple[int, int]:
        lo, hi = 0, len(base) - 1
        while lo < hi:
            mid = (lo + hi + 1) // 2
            if base[mid] <= g:
                lo = mid
            else:
                hi = mid - 1
        return lo, g - base[lo]

    sampled = 0
    if not problems:
        for i, seg in enumerate(segments):
            count = sum(len(l["tokens"]) for l in seg["lines"])
            for pos in {0, count // 2, count - 1}:
                if not 0 <= pos < count:
                    continue
                sampled += 1
                if to_local(base[i] + pos) != (i, pos):
                    problems.append(f"round-trip failed at seg {i} pos {pos}")

    bounds = offsets["chapter_bounds"]
    for c in bounds:
        if not 0 <= c["start"] < max(offsets["token_count"], 1):
            problems.append(
                f"chapter {c['book']}.{c['chapter']}: start {c['start']} out of range"
            )

    snapped = [c for c in bounds if c["accuracy"] != "exact"]
    return {
        "token_count": offsets["token_count"],
        "segments": len(segments),
        "round_trips_sampled": sampled,
        "chapter_bounds": len(bounds),
        "chapter_bounds_exact": len(bounds) - len(snapped),
        "chapter_bounds_line_snapped": [
            f"{c['book']}.{c['chapter']}" for c in snapped[:30]
        ],
        "problems": problems,
        "ok": not problems,
    }


def check_ngram_streams(
    form_stream: list,
    lemma_stream: list,
    greek_form: dict,
    greek_lemma: dict,
    base: list[int],
    token_count: int,
) -> dict:
    """The n-gram streams must say exactly what the search indexes say.

    They are gathered in a different walk from the posting lists, so nothing but
    a comparison stops the two drifting. If they drift, the phrase browser would
    offer phrases the search cannot find — or miss ones it can.
    """
    problems: list[str] = []
    if len(form_stream) != token_count or len(lemma_stream) != token_count:
        problems.append(
            f"stream lengths {len(form_stream)}/{len(lemma_stream)} != "
            f"token_count {token_count}"
        )
        return {"problems": problems, "ok": False}

    expected_form: list = [None] * token_count
    for key, posts in greek_form.items():
        for si, pos in posts:
            expected_form[base[si] + pos] = key
    expected_lemma: list = [set() for _ in range(token_count)]
    for key, posts in greek_lemma.items():
        for si, pos in posts:
            expected_lemma[base[si] + pos].add(key)

    form_bad = [i for i in range(token_count) if expected_form[i] != form_stream[i]]
    lemma_bad = [
        i for i in range(token_count)
        if (sorted(expected_lemma[i]) or None) != lemma_stream[i]
    ]
    if form_bad:
        i = form_bad[0]
        problems.append(
            f"{len(form_bad)} form-stream mismatches (first at offset {i}: "
            f"index says {expected_form[i]!r}, stream says {form_stream[i]!r})"
        )
    if lemma_bad:
        i = lemma_bad[0]
        problems.append(
            f"{len(lemma_bad)} lemma-stream mismatches (first at offset {i}: "
            f"index says {sorted(expected_lemma[i]) or None!r}, "
            f"stream says {lemma_stream[i]!r})"
        )
    return {
        "form_tokens": sum(1 for t in form_stream if t),
        "lemma_tokens": sum(1 for t in lemma_stream if t),
        "multi_lemma_tokens": sum(1 for t in lemma_stream if t and len(t) > 1),
        "problems": problems,
        "ok": not problems,
    }


def check_grammar(
    grammar: dict,
    column: list[int],
    offsets: dict,
    segments: list[dict],
    key_map: dict,
    analyses: dict,
    signature_fn,
) -> dict:
    """Validate the stage6 grammatical index. Runs from stage6, like the above.

    The column is indexed by global offset, so a length that disagrees with the
    offset primitive means every grammatical hit would name the wrong word —
    hard fail. Ambiguity rates are reported, not judged.
    """
    sigs = grammar["sigs"]
    problems: list[str] = []

    if len(column) != offsets["token_count"]:
        problems.append(
            f"column length {len(column)} != token_count {offsets['token_count']}"
        )
    if grammar["token_count"] != offsets["token_count"]:
        problems.append("grammar/offsets token_count disagree — mismatched build")
    bad = [i for i, s in enumerate(column) if not 0 <= s < len(sigs)]
    if bad:
        problems.append(f"{len(bad)} out-of-range signature ids (first at {bad[0]})")
    for slot, name in ((grammar["reserved"]["unkeyed"], "unkeyed"),
                       (grammar["reserved"]["unanalysed"], "unanalysed")):
        if sigs[slot]:
            problems.append(f"reserved slot {slot} ({name}) is not empty")

    # Range checks cannot detect a well-formed column joined to the wrong token.
    # Re-derive morphology from stage3/stage4 at deterministic offsets spread
    # across the work, with extra coverage at early segment boundaries.
    nonempty_starts: list[int] = []
    nonempty_indexes: list[int] = []
    expected_count = 0
    edge_segments = 0
    samples: set[int] = set()
    for si, seg in enumerate(segments):
        count = sum(len(line["tokens"]) for line in seg["lines"])
        if count:
            nonempty_starts.append(expected_count)
            nonempty_indexes.append(si)
            if edge_segments < GRAMMAR_EDGE_SEGMENTS:
                samples.update((expected_count, expected_count + count - 1))
                edge_segments += 1
        expected_count += count

    if expected_count:
        evenly_spaced = min(GRAMMAR_EVEN_SAMPLES, expected_count)
        if evenly_spaced == 1:
            samples.add(0)
        else:
            samples.update(
                i * (expected_count - 1) // (evenly_spaced - 1)
                for i in range(evenly_spaced)
            )

    semantic_sampled = 0
    for g in sorted(samples):
        if g >= len(column):
            continue  # the length failure above already names this corruption
        sid = column[g]
        if not 0 <= sid < len(sigs):
            continue  # likewise for the signature-id range failure
        nonempty_i = bisect_right(nonempty_starts, g) - 1
        si = nonempty_indexes[nonempty_i]
        local = g - nonempty_starts[nonempty_i]
        token = None
        token_pos = local
        for line in segments[si]["lines"]:
            if token_pos < len(line["tokens"]):
                token = line["tokens"][token_pos]
                break
            token_pos -= len(line["tokens"])
        if token is None:
            problems.append(f"semantic sample {g} did not resolve to a stage3 token")
            continue

        semantic_sampled += 1
        key = token.get("k")
        if not key:
            expected_sid = grammar["reserved"]["unkeyed"]
            if sid != expected_sid:
                problems.append(
                    f"grammar semantic mismatch at global offset {g} "
                    f"(seg {si} {segments[si]['id']}, token {local}): "
                    f"unkeyed token expected reserved id {expected_sid}, got {sid}"
                )
            continue

        stored = key_map.get(key)
        entries = analyses.get(stored, []) if stored else []
        expected_sig = signature_fn(entries)
        if not expected_sig:
            expected_sid = grammar["reserved"]["unanalysed"]
            if sid != expected_sid:
                problems.append(
                    f"grammar semantic mismatch at global offset {g} "
                    f"(seg {si} {segments[si]['id']}, token {local}, key {key!r}): "
                    f"unanalysed token expected reserved id {expected_sid}, got {sid}"
                )
            continue

        expected_content = [
            {category: list(values) for category, values in reading}
            for reading in expected_sig
        ]
        if sigs[sid] != expected_content:
            problems.append(
                f"grammar semantic mismatch at global offset {g} "
                f"(seg {si} {segments[si]['id']}, token {local}, key {key!r}): "
                f"expected {expected_content!r}, got id {sid} -> {sigs[sid]!r}"
            )

    # Ambiguity, per category: of the tokens that license a value for it, how
    # many license more than one? This is the honesty signal — it counts values
    # a reader could be shown, not analysis records.
    valid_ids = [s for s in column if 0 <= s < len(sigs)]
    analysed = sum(1 for s in valid_ids if sigs[s])
    ambiguity: dict[str, dict] = {}
    for category in grammar["categories"]:
        present = ambiguous = 0
        for sid, count in _counts(valid_ids).items():
            readings = sigs[sid]
            if not readings:
                continue
            values = {v for r in readings for v in r.get(category, [])}
            if not values:
                continue
            present += count
            if len(values) > 1:
                ambiguous += count
        if present:
            ambiguity[category] = {
                "tokens": present,
                "ambiguous": ambiguous,
                "rate": round(ambiguous / present, 4),
            }

    return {
        "signatures": len(sigs),
        "width_bytes": grammar["width"],
        "tokens": len(column),
        "semantic_offsets_sampled": semantic_sampled,
        "tokens_analysed": analysed,
        "tokens_unkeyed": sum(1 for s in column if s == grammar["reserved"]["unkeyed"]),
        "tokens_unanalysed": sum(
            1 for s in column if s == grammar["reserved"]["unanalysed"]
        ),
        "ambiguity": ambiguity,
        "problems": problems,
        "ok": not problems,
    }


def _counts(column: list[int]) -> dict[int, int]:
    out: dict[int, int] = defaultdict(int)
    for s in column:
        out[s] += 1
    return out


def validate(manifest: Manifest, spine: dict, english: dict, alignment: dict) -> dict:
    report: dict = {"checks": {}}
    segments = spine["segments"]
    # A non-Bekker work (citation.scheme: busse) uses a synthetic a-side-only
    # column set ("1a".."22a") and drops the editorial section-heading lines, so
    # the standard Bekker completeness (which expects both a/b sides) and the
    # line-gap check (which sees the dropped heading lines as gaps) don't apply.
    busse = ((manifest.data.get("citation") or {}).get("scheme", "bekker") == "busse")

    # --- 1. column completeness + monotonicity --------------------------
    seen_cols: list[str] = []
    for seg in segments:
        if seg["column"] not in seen_cols:
            seen_cols.append(seg["column"])
    # busse: no a/b pairing, so the expected set is the a-side pages from the
    # manifest's first_column to its last. Taking the spine's own columns as the
    # expectation (as this did) made `missing`/`extra` empty by construction —
    # the check passed however many Busse pages the export had dropped.
    if busse:
        first_page, _ = column_key(manifest.first_column)
        last_page, _ = column_key(manifest.last_column)
        expected = [f"{p}a" for p in range(first_page, last_page + 1)]
    else:
        expected = column_range(manifest.first_column, manifest.last_column)
    missing = sorted(set(expected) - set(seen_cols), key=column_key)
    extra = sorted(set(seen_cols) - set(expected), key=column_key)
    keys = [column_key(c) for c in seen_cols]
    monotonic = all(a <= b for a, b in zip(keys, keys[1:]))
    report["checks"]["columns"] = {
        "expected": len(expected),
        "found": len(seen_cols),
        "missing": missing,
        "extra": extra,
        "monotonic": monotonic,
        "ok": not missing and not extra and monotonic,
    }

    # --- 2. line-number gaps ---------------------------------------------
    # Expected gaps: between one book's end and the next book's start when
    # they share a column (Bekker numbering skips the heading lines).
    expected_gaps = set()
    books = manifest.books
    for prev, nxt in zip(books, books[1:]):
        e_page, e_side, e_line = ref_key(prev["end"])
        s_page, s_side, s_line = ref_key(nxt["start"])
        if (e_page, e_side) == (s_page, s_side):
            expected_gaps.add((f"{e_page}{e_side}", e_line, s_line))
    # Edition quirks declared in the manifest (e.g. a repeated line number).
    for g in manifest.data.get("expected_line_gaps", []):
        expected_gaps.add((g["column"], g["after"], g["next"]))
    gaps = []
    lines_by_col: dict[str, list[int]] = defaultdict(list)
    for seg in segments:
        nums = lines_by_col[seg["column"]]
        for line in seg["lines"]:
            # A lettered line (Bekker's 244b 5a-5d) hangs off the line it
            # follows and keeps its number, so it never advances the count —
            # reading it as one would make 5 -> 5a look like a gap.
            if line.get("sub") and nums and nums[-1] == line["n"]:
                continue
            nums.append(line["n"])
    for col, nums in lines_by_col.items():
        for a, b in zip(nums, nums[1:]):
            if b != a + 1:
                entry = {
                    "column": col,
                    "after_line": a,
                    "next_line": b,
                    "expected": (col, a, b) in expected_gaps,
                }
                gaps.append(entry)
    # busse: per-page line numbering with the editorial section headings dropped
    # from the spine leaves benign intra-page gaps; they're expected by design.
    if busse:
        for g in gaps:
            g["expected"] = True
    unexpected_gaps = [g for g in gaps if not g["expected"]]
    report["checks"]["line_gaps"] = {
        "gaps": gaps,
        "unexpected": unexpected_gaps,
        "ok": not unexpected_gaps,
    }

    # --- 3. alignment coverage -------------------------------------------
    unmatched = [p["segment"] for p in alignment["pairs"] if p["english"] is None]
    # Columns the English TEI demonstrably cannot cover (Perseus omitted a Bekker
    # page milestone, or assigns a book-straddling column to a single book) are
    # declared in the manifest so they're surfaced but don't fail the build.
    allowed = set(manifest.data.get("alignment_allow_unmatched", []))
    unexpected_unmatched = [s for s in unmatched if s not in allowed]
    # A book-boundary edition mismatch is symmetric: the English TEI places a
    # book division a column off from the Greek, leaving both an unpaired Greek
    # segment and an unpaired English chunk. The allowance covers either side.
    unexpected_english_only = [s for s in alignment["english_only"] if s not in allowed]
    report["checks"]["alignment"] = {
        "pairs": len(alignment["pairs"]),
        "unmatched_segments": unmatched,
        "allowed_unmatched": sorted(allowed & (set(unmatched) | set(alignment["english_only"]))),
        "unexpected_unmatched": unexpected_unmatched,
        "english_only": alignment["english_only"],
        "unexpected_english_only": unexpected_english_only,
        "ok": not unexpected_unmatched and not unexpected_english_only,
    }

    # --- 4. length-ratio outliers ------------------------------------------
    eng_by_id = {c["id"]: c for c in english["chunks"]}
    ratios = []
    for seg in segments:
        eng = eng_by_id.get(seg["id"])
        if eng is None:
            continue
        glen = sum(len(l["text"]) for l in seg["lines"])
        elen = len(eng["text"])
        if glen and elen:
            ratios.append((seg["id"], elen / glen, glen, elen))
    vals = [r[1] for r in ratios]
    # statistics.stdev needs two points and mean needs one: a work (or a partial
    # build) whose English aligns to fewer than two columns must not crash the
    # gate before it can report the alignment failure that caused it.
    mean = statistics.mean(vals) if vals else 0.0
    sd = statistics.stdev(vals) if len(vals) > 1 else 0.0
    outliers = [
        {"id": rid, "ratio": round(r, 3), "greek_chars": g, "english_chars": e}
        for rid, r, g, e in ratios
        if sd and abs(r - mean) > 1.5 * sd
    ]
    report["checks"]["length_ratio"] = {
        "mean": round(mean, 3),
        "sd": round(sd, 3),
        "outliers": sorted(outliers, key=lambda o: -abs(o["ratio"] - mean)),
        "ok": True,  # informational; outliers need eyes, not a hard fail
    }

    # --- 5. proper-name spot check ------------------------------------------
    greek_text_by_col: dict[str, str] = defaultdict(str)
    eng_text_by_col: dict[str, str] = defaultdict(str)
    for seg in segments:
        greek_text_by_col[seg["column"]] += " ".join(l["text"] for l in seg["lines"])
    for c in english["chunks"]:
        eng_text_by_col[c["column"]] += c["text"]
    greek_base_by_col = {c: _base(t) for c, t in greek_text_by_col.items()}
    proper_names = [tuple(p) for p in manifest.data.get("proper_names", [])]
    col_pos = {c: i for i, c in enumerate(expected)}
    name_results = []
    for grc, eng_name in proper_names:
        grc_cols = {c for c, t in greek_base_by_col.items() if grc in t}
        eng_cols = {c for c, t in eng_text_by_col.items() if eng_name in t}
        # English chunk boundaries sit exactly at milestones, but a sentence
        # begun late in one column is often translated as overflowing the
        # boundary; allow +/- one column of slack.
        def near(col, others):
            # A column outside the manifest's declared range has no neighbours
            # to be near, so the name is reported as one-sided (and the check
            # fails) — `expected.index` raised ValueError out of validate()
            # instead, crashing stage 2 before it could write its report.
            i = col_pos.get(col)
            if i is None:
                return False
            window = set(expected[max(0, i - 1) : i + 2])
            return bool(window & others)

        only_greek = sorted(c for c in grc_cols if not near(c, eng_cols))
        only_english = sorted(c for c in eng_cols if not near(c, grc_cols))
        name_results.append(
            {
                "greek": grc,
                "english": eng_name,
                "greek_columns": len(grc_cols),
                "english_columns": len(eng_cols),
                "greek_without_english": only_greek,
                "english_without_greek": only_english,
            }
        )
    report["checks"]["proper_names"] = {
        "names": name_results,
        "ok": all(
            not n["greek_without_english"] and not n["english_without_greek"]
            for n in name_results
        ),
    }

    # --- 6. chapter English-offset coverage --------------------------------
    # Each chapter's English begins at a char offset within its Bekker column,
    # and its text runs (across columns) until the next chapter begins. The
    # reader/print goes BLANK for a chapter only if that book-global span is
    # empty — two chapters resolving to the same position. stage7_emit.
    # resolve_chapter_offsets is the single source of truth for those offsets
    # (a missing/colliding section marker is interpolated from the Greek line
    # and de-collided); we replay it here over the book-concatenated English and
    # fail only on a genuine collapse. Chapters whose offset had to be
    # synthesized (no real section marker of their own) are reported as
    # `approximate` — visible for data-quality follow-up, but not a build error,
    # since the de-collision keeps them rendering in order.
    from .stage7_emit import resolve_chapter_offsets

    eng_by_cid = {c["id"]: c for c in english["chunks"]}
    real_marker = {
        cid: {m["n"] for m in c.get("markers", []) if m["kind"] == "section"}
        for cid, c in eng_by_cid.items()
    }
    chapters_by_col: dict[tuple, list] = {}
    for ch in english.get("chapters", []):
        chapters_by_col.setdefault((ch["book"], ch["column"]), []).append(ch)
    # Book -> its Bekker columns in spine order, with each column's English length.
    book_cols: dict[int, list[str]] = {}
    for seg in spine["segments"]:
        cols = book_cols.setdefault(seg["book"], [])
        if seg["column"] not in cols:
            cols.append(seg["column"])

    collapsed, approximate, untranslated = [], [], []
    # A chapter whose (book, column) carries no spine segment can never be placed
    # in the per-column loop below — stage7_emit likewise finds no segment and
    # drops its heading, leaving a broken reader anchor. Fail the build on it
    # rather than silently skipping it (the pre-refactor check caught this).
    seg_keys = {(seg["book"], seg["column"]) for seg in spine["segments"]}
    for ch in english.get("chapters", []):
        if (ch["book"], ch["column"]) not in seg_keys:
            collapsed.append(
                {"book": ch["book"], "chapter": ch["chapter"], "column": ch["column"]}
            )
    for book, cols in book_cols.items():
        base, total = {}, 0
        for col in cols:
            base[col] = total
            total += len(eng_by_cid.get(f"{book}:{col}", {}).get("text", "") or "")
        placed = []  # (global_offset, book, chapter, column)
        for col in cols:
            cid = f"{book}:{col}"
            chunk = eng_by_cid.get(cid)
            chs = chapters_by_col.get((book, col), [])
            if not chs:
                continue
            ordered = sorted(
                chs,
                key=lambda c: (
                    int(c["line"]) if str(c.get("line", "")).lstrip("-").isdigit() else 0,
                    int(c.get("wordIndex", 0) or 0),
                ),
            )
            offs = resolve_chapter_offsets(chunk, ordered)
            col_len = len(chunk.get("text", "") or "") if chunk else 0
            for ch, off in zip(ordered, offs):
                # Defence in depth: a resolved offset outside its own column is a
                # resolver bug, not a coverage gap — force it to fail rather than
                # letting the untranslated/empty-suffix classifier below hide it.
                if not (0 <= off <= col_len):
                    collapsed.append({"book": book, "chapter": ch["chapter"], "column": col})
                placed.append((base[col] + min(max(off, 0), col_len), book, ch["chapter"], col))
                if ch["chapter"] not in real_marker.get(cid, set()):
                    approximate.append(
                        {"book": book, "chapter": ch["chapter"], "column": col}
                    )
        placed.sort()
        # A chapter is blank iff its book-global span (to the next chapter, or the
        # book's end for the last one) holds no characters. Split two causes by
        # WHERE the blank sits, not by inspecting the suffix (trailing whitespace
        # would fool a .strip() test):
        #  - untranslated: the chapter is pinned at the very end of the book's
        #    English (goff == total) — the translation genuinely stops short of
        #    the Greek's chapter count (e.g. Forster's 35-part Mechanics vs the
        #    grc TEI's 37). A coverage gap to report, not a slicing bug.
        #  - collapsed: the blank sits BEFORE the end, so real English still
        #    follows and a chapter got mis-sliced — the corruption this check
        #    exists to fail on.
        for i, (goff, b, chap, col) in enumerate(placed):
            nxt = placed[i + 1][0] if i + 1 < len(placed) else total
            if nxt > goff:
                continue
            (untranslated if goff >= total else collapsed).append(
                {"book": b, "chapter": chap, "column": col}
            )
    report["checks"]["chapter_offsets"] = {
        "collapsed": collapsed,
        "untranslated": untranslated,
        "approximate": approximate,
        "ok": not collapsed,
    }

    # --- 7. sigla / character inventory ------------------------------------
    inventory: dict[str, dict] = {}
    for seg in segments:
        for line in seg["lines"]:
            for ch in line["text"]:
                if _is_greek_letter(ch) or ch in EXPECTED_NON_GREEK:
                    continue
                entry = inventory.setdefault(
                    ch,
                    {
                        "char": ch,
                        "name": unicodedata.name(ch, "UNKNOWN"),
                        "count": 0,
                        "samples": [],
                    },
                )
                entry["count"] += 1
                if len(entry["samples"]) < 5:
                    entry["samples"].append(
                        {"ref": f"{seg['column']}{line['n']}", "text": line["text"][:80]}
                    )
    report["checks"]["sigla"] = {
        "characters": sorted(inventory.values(), key=lambda e: -e["count"]),
        "ok": True,  # informational
    }

    report["ok"] = all(c.get("ok") for c in report["checks"].values())
    return report


def _to_markdown(report: dict) -> str:
    c = report["checks"]
    lines = ["# Stage 2 validation report", ""]
    lines.append(f"Overall: {'PASS' if report['ok'] else 'FAIL'}")
    cols = c["columns"]
    lines += [
        "",
        "## Columns",
        f"- {cols['found']}/{cols['expected']} columns, monotonic: {cols['monotonic']}",
        f"- missing: {cols['missing'] or 'none'}; extra: {cols['extra'] or 'none'}",
        "",
        "## Line gaps",
        f"- {len(c['line_gaps']['gaps'])} gaps, "
        f"{len(c['line_gaps']['unexpected'])} unexpected",
    ]
    for g in c["line_gaps"]["gaps"]:
        marker = "expected (book boundary)" if g["expected"] else "**UNEXPECTED**"
        lines.append(
            f"  - {g['column']}: {g['after_line']} -> {g['next_line']} ({marker})"
        )
    a = c["alignment"]
    lines += [
        "",
        "## Alignment",
        f"- {a['pairs']} pairs; unmatched segments: {a['unmatched_segments'] or 'none'}; "
        f"english-only: {a['english_only'] or 'none'}",
        "",
        "## Length ratios (english chars / greek chars)",
        f"- mean {c['length_ratio']['mean']}, sd {c['length_ratio']['sd']}, "
        f"{len(c['length_ratio']['outliers'])} outliers > 1.5 SD",
    ]
    for o in c["length_ratio"]["outliers"][:15]:
        lines.append(
            f"  - {o['id']}: ratio {o['ratio']} "
            f"(grc {o['greek_chars']}, eng {o['english_chars']})"
        )
    lines += ["", "## Proper names"]
    for n in c["proper_names"]["names"]:
        status = (
            "ok"
            if not n["greek_without_english"] and not n["english_without_greek"]
            else f"grc-only {n['greek_without_english']} eng-only {n['english_without_greek']}"
        )
        lines.append(
            f"- {n['greek']} / {n['english']}: grc in {n['greek_columns']} cols, "
            f"eng in {n['english_columns']} cols — {status}"
        )
    co = c["chapter_offsets"]
    lines += [
        "",
        "## Chapter English-offset coverage",
        f"- {len(co['collapsed'])} chapter(s) rendering BLANK with English text still "
        f"following (reader/print corruption)",
        f"- {len(co.get('untranslated', []))} chapter(s) past the translation's last "
        f"covered chapter (coverage gap — Greek only, no English to place)",
        f"- {len(co['approximate'])} chapter(s) with no own section marker; offset "
        f"interpolated from the Greek line and de-collided (renders in order, boundary "
        f"approximate)",
    ]
    for m in co["collapsed"]:
        lines.append(f"  - **UNEXPECTED (blank)**: book {m['book']} chapter {m['chapter']} ({m['column']})")
    for m in co.get("untranslated", []):
        lines.append(f"  - untranslated: book {m['book']} chapter {m['chapter']} ({m['column']})")
    for m in co["approximate"][:30]:
        lines.append(f"  - approximate: book {m['book']} chapter {m['chapter']} ({m['column']})")
    lines += ["", "## Non-Greek character inventory"]
    for e in c["sigla"]["characters"]:
        sample = e["samples"][0]["ref"] if e["samples"] else ""
        lines.append(
            f"- U+{ord(e['char']):04X} {e['char']!r} {e['name']} x{e['count']} "
            f"(e.g. {sample})"
        )
    return "\n".join(lines) + "\n"


def run(manifest: Manifest) -> Path:
    stage1 = BUILD_DIR / "stage1"
    spine = json.loads((stage1 / "greek_spine.json").read_text(encoding="utf-8"))
    english = json.loads((stage1 / "english_chunks.json").read_text(encoding="utf-8"))
    alignment = json.loads((stage1 / "alignment.json").read_text(encoding="utf-8"))
    report = validate(manifest, spine, english, alignment)
    out_dir = BUILD_DIR / "stage2"
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "validation_report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8"
    )
    md_path = out_dir / "validation_report.md"
    md_path.write_text(_to_markdown(report), encoding="utf-8")
    return md_path
