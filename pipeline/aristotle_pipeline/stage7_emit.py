"""Stage 7: emit the frontend data set under build/dist/ne/.

Per the approved formats:
  - book-{n}.json     spine segments per Bekker column (split per book),
                      Greek lines with token arrays carrying Beta Code
                      analysis keys, paired English chunk with standoff
                      notes/markers.
  - analyses.json     token key -> analyses (lemma, gloss, parse) with the
                      LSJ keys for each lemma merged in.
  - lsj/{letter}.json letter-sharded entries, corpus lemmata only.
  - manifest.json     work metadata and per-book stats.
Reports (validation, unmatched tokens, sigla, missing lemmata) are copied
to build/dist/reports/ for the Milestone 2 review.
"""

from __future__ import annotations

import json
import re
import shutil
import unicodedata
from bisect import bisect_left
from collections import defaultdict
from pathlib import Path

from .config import BUILD_DIR, REPO_ROOT, SOURCES_DIR, Manifest
from .parse_filter import filter_parses


def _load(rel: str):
    return json.loads((BUILD_DIR / rel).read_text(encoding="utf-8"))


_COLSEP = "⎪"  # U+23AA — the TLG column divider inside Aristotle's inline tables


def _normalized_gloss(value: str) -> str:
    normalized = " ".join(value.lower().split())
    while normalized and (
        normalized[-1].isspace()
        or unicodedata.category(normalized[-1]).startswith("P")
    ):
        normalized = normalized[:-1]
    return normalized


def merge_short_def(
    gloss: str, lemma: str, candidate_keys: list[str], short_defs: dict[str, str]
) -> str:
    """Conservatively extend a truncated Morpheus gloss from an LSJ definition.

    A lemma usually maps to numbered homonyms rather than to itself (e)/xw ->
    e)/xw1, e)/xw2), and nothing in a Morpheus reading says which entry it
    belongs to. So extend only where the choice is forced: either the lemma is
    itself one of the LSJ keys, or every key that extends the gloss extends it
    the same way. Where the homonyms disagree — u(podeh/s1 "somewhat deficient,
    inferior" against u(podeh/s2 "somewhat fearful", both extending "somewhat"
    — keep the gloss Morpheus shipped rather than pick one.
    """
    normalized_gloss = _normalized_gloss(gloss)
    if not normalized_gloss:
        return gloss

    keys = [lemma] if lemma in candidate_keys else candidate_keys
    extensions = set()
    for key in keys:
        derived = short_defs.get(key)
        if not derived:
            continue
        normalized_derived = _normalized_gloss(derived)
        if (
            len(normalized_derived) > len(normalized_gloss)
            and re.match(rf"^{re.escape(normalized_gloss)}\b", normalized_derived)
        ):
            extensions.add(derived)
    if len(extensions) == 1:
        return extensions.pop()
    return gloss


def resolve_parses(parses: list[dict], short_defs: dict[str, str]) -> list[dict]:
    """Drop spurious readings, then extend the survivors' truncated glosses.

    The order matters: filter_parses recognizes a spurious reading by its gloss
    exactly duplicating a resolved sibling's, and those are Morpheus glosses.
    Extending them first would make the duplicate stop looking like one, so the
    junk reading would survive — and can then become the token's primary
    analysis, which shifts the lemma bucket a lexicon page is built from.
    """
    kept = filter_parses(parses)
    for parse in kept:
        parse["gloss"] = merge_short_def(
            parse["gloss"], parse["lemma"], parse["lsj"], short_defs
        )
    return kept


def _greek_cells(text: str, tokens: list[dict]):
    """If a Greek line is a table row (contains the ⎪ column divider), split it
    into cells, partitioning the clickable tokens by their char offset and
    rebasing each cell's token offsets to the cell text. Returns a list of
    {text, tokens} cells, or None for an ordinary (non-table) line."""
    if _COLSEP not in text:
        return None
    cells, start = [], 0
    for end in [m for m, ch in enumerate(text) if ch == _COLSEP] + [len(text)]:
        cell_text = text[start:end]
        lead = len(cell_text) - len(cell_text.lstrip())
        cell_toks = [
            {**t, "o": t["o"] - start - lead}
            for t in tokens if start <= t["o"] < end
        ]
        cells.append({"text": cell_text.strip(), "tokens": cell_toks})
        start = end + 1
    return cells


def _interp_off_from_ticks(ticks, line, text_len):
    """English char offset for a Bekker `line`, piecewise-linear between the
    chunk's gutter ticks ({n: bekker line, offset}). Used to place a chapter
    whose own English section marker is missing (it landed in an adjacent Bekker
    column) so it lands near its Greek start rather than at offset 0."""
    pts = sorted((t["n"], t["offset"]) for t in ticks) or [(line, 0)]
    if line <= pts[0][0]:
        return pts[0][1]
    for (l0, o0), (l1, o1) in zip(pts, pts[1:]):
        if l0 <= line <= l1 and l1 > l0:
            return round(o0 + (line - l0) / (l1 - l0) * (o1 - o0))
    return min(pts[-1][1], text_len)


def resolve_chapter_offsets(eng, chapters_in_order) -> list[int]:
    """Per-column English start offsets for `chapters_in_order` (already sorted
    by reading position), guaranteed strictly increasing so no chapter's English
    text slices to empty. A chapter's offset is its own section marker when the
    TEI/overlay placed one; otherwise it is interpolated from the chapter's Greek
    start line via the column's Bekker gutter. Any remaining tie or inversion
    (two chapters landing at the same/earlier offset — e.g. the De Mirabilibus
    marvels that align onto one Greek word) is repaired by evenly distributing
    the colliding run between the last good offset and the next fixed one.

    Without this, a missing/colliding marker fell back to offset 0, which blanked
    the preceding chapter (sliced end-before-start) and merged both — the class
    of corruption stage2's chapter_offsets check guards. Returns one offset per
    input chapter, in the same order."""
    text_len = len(eng["text"]) if eng and eng.get("text") is not None else 0
    section_offset: dict[str, int] = {}
    if eng:
        for m in eng.get("markers", []):
            if m["kind"] == "section":
                section_offset.setdefault(m["n"], m["offset"])
    ticks = (eng or {}).get("bekker") or []
    # Raw offsets: real marker where present, else interpolated from Greek line.
    offs: list[int] = []
    for ch in chapters_in_order:
        raw = section_offset.get(ch["chapter"])
        if raw is None:
            line = int(ch["line"]) if str(ch.get("line", "")).lstrip("-").isdigit() else None
            raw = _interp_off_from_ticks(ticks, line, text_len) if line is not None else 0
        offs.append(max(0, min(raw, text_len)))
    # Repair to strictly increasing: distribute any non-increasing run evenly
    # between the previous offset and the next larger fixed offset (or the text
    # end), so every chapter keeps a non-empty slice.
    n = len(offs)
    i = 1
    while i < n:
        if offs[i] > offs[i - 1]:
            i += 1
            continue
        lo = offs[i - 1]
        j = i
        while j < n and offs[j] <= lo:
            j += 1
        # `hi` is the next fixed offset (or the text end) — synthesized offsets
        # must stay within (lo, hi] and never run past the text, so a repaired
        # start can't fall outside its own English or overtake a real marker.
        hi = min(offs[j] if j < n else text_len, text_len)
        count = j - i
        span = hi - lo
        # Synthesized offsets must stay STRICTLY below `hi`: below a following
        # fixed marker (j < n) it would otherwise clamp onto and blank that
        # validly-marked chapter; at the text end (j == n) landing exactly on
        # text_len makes an empty end-of-book slice that the untranslated
        # classifier would wrongly wave through. Either way the residual ties of
        # a span-starved run then sit on real characters, so stage2 fails them.
        ceil = max(hi - 1, lo)
        for k in range(count):
            if span > count:
                # Room to spread the colliding run out, strictly increasing.
                offs[i + k] = lo + round(span * (k + 1) / (count + 1))
            else:
                # More chapters than character positions available: pack them one
                # apart but clamp at the ceiling, so offsets stay in range and
                # never touch the following fixed marker even though some of the
                # run necessarily tie among themselves. That residual tie is a
                # genuine unrecoverable collapse the stage2 check then fails on.
                offs[i + k] = min(lo + k + 1, ceil)
        i = j
    return offs


def _chapter_starts(seg_column, line_ns, eng, chapters_in_col, range_map) -> list[dict]:
    """For each chapter starting in this Bekker column, where to break the
    reader. The Greek heading goes before the chapter's ACTUAL Bekker line
    (ch['line'] — exact for grc-aligned chapters); the reader matches the first
    Greek line >= beforeLine, so an exact line lands exactly. The English column
    heading uses the section marker's char offset, de-collided so chapters never
    overlap (see resolve_chapter_offsets)."""
    first_line = line_ns[0] if line_ns else 1
    ordered = sorted(
        chapters_in_col,
        key=lambda ch: (
            int(ch["line"]) if str(ch.get("line", "")).lstrip("-").isdigit() else first_line,
            int(ch.get("wordIndex", 0) or 0),
        ),
    )
    offsets = resolve_chapter_offsets(eng, ordered)
    starts = []
    for ch, off in zip(ordered, offsets):
        before = int(ch["line"]) if str(ch.get("line", "")).lstrip("-").isdigit() else first_line
        starts.append(
            {
                "chapter": ch["chapter"],
                "beforeLine": before,
                "wordIndex": int(ch.get("wordIndex", 0) or 0),
                "engOffset": off,
                "bekker": range_map[(ch["book"], ch["chapter"])],
            }
        )
    return starts


def chapter_ranges(spine, chapters) -> dict[tuple, str]:
    """(book, chapter) -> Bekker line span, e.g. '1094a1–17' (same column) or
    '1097a15–1098b8' (crossing pages). End = one Bekker line before the next
    chapter begins; the book's last line for the final chapter of a book."""
    book_cols: dict[int, list[str]] = defaultdict(list)
    col_lines: dict[tuple, list[int]] = {}
    col_max: dict[tuple, int] = {}
    for seg in spine["segments"]:
        b, c = seg["book"], seg["column"]
        if c not in book_cols[b]:
            book_cols[b].append(c)
        ns = sorted({l["n"] for l in seg["lines"]})
        col_lines[(b, c)], col_max[(b, c)] = ns, ns[-1]

    def step_back(book, col, line):
        """The Bekker position one line before (col, line) within this book —
        the last line the column actually carries before it, not line - 1: an
        edition can skip a number (PA 689a prints 13-14 as one line, so there
        is no 14), and a span ending on a line that does not exist is a
        dangling anchor the reader cannot resolve."""
        ns = col_lines[(book, col)]
        i = bisect_left(ns, line)
        if i > 0:
            return col, ns[i - 1]
        cols = book_cols[book]
        i = cols.index(col)
        if i > 0:
            pcol = cols[i - 1]
            return pcol, col_max[(book, pcol)]
        return col, line

    by_book: dict[int, list[dict]] = defaultdict(list)
    for ch in chapters:
        by_book[ch["book"]].append(ch)
    ranges: dict[tuple, str] = {}
    for book, chs in by_book.items():
        for i, ch in enumerate(chs):
            scol, sline = ch["column"], int(ch["line"])
            if i + 1 < len(chs):
                ncol, nline = chs[i + 1]["column"], int(chs[i + 1]["line"])
                if (ncol, nline) == (scol, sline):
                    # Zero-Greek-span chapter: it shares its Bekker start with the
                    # next chapter (De Mirabilibus' one-sentence marvels align onto
                    # a single Greek line — see resolve_chapter_offsets, which then
                    # separates them on the English side). Emit a single-point span
                    # rather than stepping back to one line before its own start,
                    # which would yield a backwards "end < start" range.
                    ranges[(book, ch["chapter"])] = f"{scol}{sline}"
                    continue
                ecol, eline = step_back(book, ncol, nline)
            else:
                ecol = book_cols[book][-1]
                eline = col_max[(book, ecol)]
            ranges[(book, ch["chapter"])] = (
                f"{scol}{sline}–{eline}" if scol == ecol
                else f"{scol}{sline}–{ecol}{eline}"
            )
    return ranges


def _paired_tokens(seg: dict, tok_seg: dict) -> list[list[dict]]:
    """This segment's token lists, one per spine line, in spine order.

    stage3 tokenizes the spine line by line, so the two lists are parallel.
    A repeated line number is legitimate (a secluded block splits a line in
    two), which is exactly why the pairing cannot be a lookup by number — and
    exactly why a drift between the two documents has to raise here rather
    than hand a line another line's words.
    """
    spine_lines, tok_lines = seg["lines"], tok_seg["lines"]
    if len(spine_lines) != len(tok_lines):
        raise ValueError(
            f"stage7: column {seg['column']} has {len(spine_lines)} spine lines "
            f"but {len(tok_lines)} tokenized lines — the two are out of step"
        )
    for spine_line, tok_line in zip(spine_lines, tok_lines):
        spine_ref = (spine_line["n"], spine_line.get("sub"))
        tok_ref = (tok_line["n"], tok_line.get("sub"))
        if spine_ref != tok_ref:
            raise ValueError(
                f"stage7: column {seg['column']} line {spine_ref} is paired with "
                f"tokenized line {tok_ref} — the two documents disagree on order"
            )
    return [l["tokens"] for l in tok_lines]


def emit_books(spine, tokens_doc, english, range_map, out_dir: Path, ross=None,
               third=None, overlays=None) -> list[dict]:
    tokens_by_id = {s["id"]: s for s in tokens_doc["segments"]}
    english_by_id = {c["id"]: c for c in english["chunks"]}
    ross = ross or {}
    third = third or {}
    overlays = overlays or {}
    chapters_by_col: dict[tuple, list[dict]] = defaultdict(list)
    seg_keys = {(seg["book"], seg["column"]) for seg in spine["segments"]}
    for ch in english.get("chapters", []):
        if (ch["book"], ch["column"]) not in seg_keys:
            # No spine segment carries this (book, column), so the reader would
            # never render the ch-{book}-{chapter} heading anchor. stage1 clamps
            # book-start chapters onto the spine's book cut; anything arriving
            # here is a real data bug — say so instead of dropping it silently.
            print(f"  stage7 WARNING: chapter {ch['book']}.{ch['chapter']} at "
                  f"{ch['column']}{ch['line']} matches no spine segment — "
                  f"heading not emitted")
        chapters_by_col[(ch["book"], ch["column"])].append(ch)
    by_book: dict[int, list[dict]] = defaultdict(list)
    for seg in spine["segments"]:
        tok_seg = tokens_by_id[seg["id"]]
        # Paired POSITIONALLY, not by (n, sub): a column can carry the same
        # number twice with no letter suffix, where the OCT sets a secluded or
        # transposed block inside a line and stage1 emits the halves as
        # separate lines (DA 430b.20, APr 68a.16, Phys 205b.1). Keying on
        # (n, sub) collapsed those halves into one entry, so both rendered the
        # LAST half's tokens — one line's words printed over the other's text.
        # stage3 walks the same spine in the same order, so the two line lists
        # are parallel by construction; check it rather than trust it.
        tok_lines = _paired_tokens(seg, tok_seg)
        eng = english_by_id.get(seg["id"])
        line_ns = [line["n"] for line in seg["lines"]]
        chapter_starts = _chapter_starts(
            seg["column"], line_ns, eng,
            chapters_by_col.get((seg["book"], seg["column"]), []),
            range_map,
        )
        by_book[seg["book"]].append(
            {
                "id": seg["id"],
                "column": seg["column"],
                **({"chapterStarts": chapter_starts} if chapter_starts else {}),
                "greek": [
                    {
                        "n": line["n"],
                        "text": line["text"],
                        **({"sub": line["sub"]} if line.get("sub") else {}),
                        **({"joined": True} if line.get("joined") else {}),
                        "tokens": toks,
                        **({"cells": cells} if (cells := _greek_cells(line["text"], toks)) else {}),
                    }
                    for line, toks in zip(seg["lines"], tok_lines)
                ],
                "english": (
                    {
                        "text": eng["text"],
                        "notes": eng["notes"],
                        "markers": eng["markers"],
                        "bekker": eng.get("bekker", []),
                    }
                    if eng
                    else None
                ),
                # Second translation (Ross), chapter-anchored: per chapter-block
                # slices the reader pairs to its blocks (cont = continuation of a
                # chapter begun in an earlier column).
                **({"ross": ross[seg["id"]]} if ross.get(seg["id"]) else {}),
                # Optional third translation (same overlay shape as ross).
                **({"third": third[seg["id"]]} if third.get(seg["id"]) else {}),
                # Any further overlays (4th translation onward), keyed by
                # translation id: { <id>: [pieces] }. Same overlay shape as ross.
                **(
                    {"overlays": ov}
                    if (ov := {
                        tid: chunks[seg["id"]]
                        for tid, chunks in overlays.items()
                        if chunks.get(seg["id"])
                    })
                    else {}
                ),
            }
        )
    stats = []
    for book, segments in sorted(by_book.items()):
        (out_dir / f"book-{book:02d}.json").write_text(
            json.dumps({"book": book, "segments": segments}, ensure_ascii=False),
            encoding="utf-8",
        )
        stats.append(
            {
                "book": book,
                "segments": len(segments),
                "first_column": segments[0]["column"],
                "last_column": segments[-1]["column"],
            }
        )
    return stats


def emit_third_titles(*, build_dir: Path, out_dir: Path, third: dict | None) -> None:
    """Emit third-titles.json, but only the titles this work's third owns.

    A third translation may head every chapter with a title of its own
    (Ostwald: "(e) Theoretical wisdom"), keyed {transId: {book: {chapter: …}}}
    — the reader shows it over that translation's column, not in the shared
    chapter heading, because the title is the translator's, not the work's.

    build/stage1 is scratch SHARED by every work and is NOT cleaned between
    them, so the titles left there by the last work that had any are still on
    disk when the next work is emitted. Gating on "does this manifest declare a
    third translation" is not enough — a work with a third of its own passes
    that gate and copies whatever the scratch holds. That is how the Posterior
    Analytics (third = Owen) shipped Ostwald's Ethics titles.

    The file names its own translator, so that is the gate: keep the entries
    whose key is this manifest's third id, and write nothing if none are.
    """
    titles_path = build_dir / "stage1" / "third_titles.json"
    out_titles = out_dir / "third-titles.json"
    third_id = (third or {}).get("id")
    mine = {}
    if third_id and titles_path.exists():
        scratch = json.loads(titles_path.read_text(encoding="utf-8"))
        mine = {k: v for k, v in scratch.items() if k == third_id}
    if mine:
        out_titles.write_text(
            json.dumps(mine, ensure_ascii=False, indent=1) + "\n", encoding="utf-8"
        )
    elif out_titles.exists():
        # A previous build of this work may have written one; a rebuild must
        # not leave it behind as data no manifest accounts for.
        out_titles.unlink()


def copy_quotations(*, work_id: str, out_dir: Path, data_dir: Path | None = None) -> None:
    """Copy pipeline/data/quotations/<work_id>.json into the work output dir.

    Quotations are curated, committed sidecar data — not a report. Missing
    file is the normal case for every work but the Metaphysics pilot: no
    copy, no warning.
    """
    src = (data_dir or (REPO_ROOT / "pipeline" / "data" / "quotations")) / f"{work_id}.json"
    if src.exists():
        shutil.copy(src, out_dir / "quotations.json")


def emit_analyses(out_dir: Path) -> dict:
    analyses = _load("stage4/analyses.json")
    key_map = _load("stage4/key_map.json")
    lemma_map = _load("stage5/lemma_map.json")
    # Absent when stage7 is re-run alone over a build predating short defs;
    # the glosses then stay as Morpheus shipped them. Say so — a silent
    # fallback ships "make" for poie/w and looks like a successful build.
    short_defs_path = BUILD_DIR / "stage5" / "short_defs.json"
    if short_defs_path.exists():
        short_defs = _load("stage5/short_defs.json")
    else:
        short_defs = {}
        print("  stage7 WARNING: no stage5/short_defs.json — shipping raw "
              "Morpheus glosses; re-run stage5 to repair them")
    merged: dict[str, list[dict]] = {}
    dropped = 0
    for token_key, stored_key in key_map.items():
        parses = [
            {
                "lemma": g["lemma"],
                "gloss": g["gloss"].strip(),
                "parse": g["parse"],
                "lsj": lemma_map.get(g["lemma"], []),
            }
            for g in analyses[stored_key]
        ]
        kept = resolve_parses(parses, short_defs)
        dropped += len(parses) - len(kept)
        merged[token_key] = kept
    (out_dir / "analyses.json").write_text(
        json.dumps(merged, ensure_ascii=False), encoding="utf-8"
    )
    return {"token_keys": len(merged), "parses_dropped": dropped}


def _merge_shared_lsj() -> None:
    """Merge this work's LSJ shards into the corpus-wide shared dictionary at
    build/dist/lsj/<letter>.json (union by key).

    The reader fetches /data/lsj/<letter>.json regardless of which work is open,
    so dictionary entries are stored ONCE instead of duplicated ~30× across
    per-work subsets. Entry bodies are identical across works (same master
    grc.lsj.xml), so a key-keyed dict merge dedups them: the result is the union
    of every work's needed entries. build/dist persists across the works in one
    build run (it is cleared once at the start), so each work accumulates into
    the shared dir; a single-work rebuild just refreshes its own keys.
    """
    shared = BUILD_DIR / "dist" / "lsj"
    shared.mkdir(parents=True, exist_ok=True)
    for shard in sorted((BUILD_DIR / "stage5" / "lsj").glob("*.json")):
        src = json.loads(shard.read_text(encoding="utf-8"))
        dest = shared / shard.name
        if dest.exists():
            merged = json.loads(dest.read_text(encoding="utf-8"))
            merged.update(src)
        else:
            merged = src
        dest.write_text(json.dumps(merged, ensure_ascii=False), encoding="utf-8")


def run(manifest: Manifest) -> Path:
    out_dir = BUILD_DIR / "dist" / manifest.work_id
    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True)

    spine = _load("stage1/greek_spine.json")
    tokens_doc = _load("stage3/tokens.json")
    english = _load("stage1/english_chunks.json")
    ross_path = BUILD_DIR / "stage1" / "ross_chunks.json"
    ross = json.loads(ross_path.read_text(encoding="utf-8")) if ross_path.exists() else {}
    # build/stage1 is scratch SHARED by every work, so a third-translation
    # artifact left there by the last build is still on disk when a work that has
    # no third translation is emitted. Read those files only when this manifest
    # declares one — otherwise the Isagoge inherits the Ethics' apparatus (its
    # chunks miss silently, since segment ids don't collide, but its titles and
    # footnotes would land).
    has_third = bool((manifest.data.get("english") or {}).get("third"))
    third_path = BUILD_DIR / "stage1" / "third_chunks.json"
    third = json.loads(third_path.read_text(encoding="utf-8")) if has_third and third_path.exists() else {}
    overlays_path = BUILD_DIR / "stage1" / "overlays.json"
    overlays = json.loads(overlays_path.read_text(encoding="utf-8")) if overlays_path.exists() else {}
    # A third translation may ship footnotes (NE Ostwald): a {N: html} map the
    # reader loads to fill the footnote popups. Emit it alongside the books.
    footnotes_path = BUILD_DIR / "stage1" / "third_footnotes.json"
    if has_third and footnotes_path.exists():
        shutil.copy(footnotes_path, out_dir / "footnotes.json")
    else:
        # Primary (archive) translation footnotes, vendored beside its HTML as
        # sources/<dir>/footnotes.json ({N: html}); its prose carries [^N]
        # markers (e.g. the Isagoge's Owen). Emitted to the same footnotes.json.
        prim = (manifest.data.get("english") or {}).get("primary") or {}
        if prim.get("dir"):
            src = SOURCES_DIR / prim["dir"] / "footnotes.json"
            if src.exists():
                shutil.copy(src, out_dir / "footnotes.json")
    # A third translation may also head every chapter with a title of its own
    # (Ostwald: "(e) Theoretical wisdom"), keyed {transId: {book: {chapter: …}}}
    # — the reader shows it over that translation's column, not in the shared
    # chapter heading, because the title is the translator's, not the work's.
    emit_third_titles(
        build_dir=BUILD_DIR,
        out_dir=out_dir,
        third=(manifest.data.get("english") or {}).get("third"),
    )
    # Primary translation's analytical sidenotes ({N: text}); the prose carries
    # [[sN]] markers and the reader floats each note into a right-hand rail. The
    # Isagoge (Owen) carries 61. Emitted to sidenotes.json beside the books.
    prim = (manifest.data.get("english") or {}).get("primary") or {}
    if prim.get("dir"):
        sn = SOURCES_DIR / prim["dir"] / "sidenotes.json"
        if sn.exists():
            shutil.copy(sn, out_dir / "sidenotes.json")
        # Diagrams ({N: html figure}); the prose carries [[figN]] markers and the
        # reader renders each figure inline at that point (the Isagoge's Tree of
        # Porphyry).
        fg = SOURCES_DIR / prim["dir"] / "figures.json"
        if fg.exists():
            shutil.copy(fg, out_dir / "figures.json")

    range_map = chapter_ranges(spine, english.get("chapters", []))
    book_stats = emit_books(spine, tokens_doc, english, range_map, out_dir, ross, third, overlays)
    analyses_stats = emit_analyses(out_dir)

    # Per-book ordered chapter list for navigation (Work → Book → Chapter).
    chapters_by_book: dict[str, list[dict]] = defaultdict(list)
    for ch in english.get("chapters", []):
        chapters_by_book[str(ch["book"])].append(
            {
                "chapter": ch["chapter"],
                "column": ch["column"],
                "line": ch["line"],
                "bekker": range_map[(ch["book"], ch["chapter"])],
            }
        )
    (out_dir / "chapters.json").write_text(
        json.dumps(chapters_by_book, ensure_ascii=False, indent=1), encoding="utf-8"
    )

    # Optional per-chapter section titles ({book: {chapter: title}}), emitted
    # when the manifest chapters carry a `title` (e.g. the Isagoge's "Of Genus
    # and Species"). The reader's outline and chapter headings show these in
    # place of a bare "Chapter N"; absent → the file is simply not written.
    titles_by_book: dict[str, dict[str, str]] = defaultdict(dict)
    for ch in english.get("chapters", []):
        if ch.get("title"):
            titles_by_book[str(ch["book"])][str(ch["chapter"])] = ch["title"]
    if titles_by_book:
        (out_dir / "chapter-titles.json").write_text(
            json.dumps(titles_by_book, ensure_ascii=False, indent=1), encoding="utf-8"
        )

    # Bekker column -> owning book(s), with each book's line span in that column.
    # Boundary columns (a book starting mid-column) list more than one book, so a
    # citation like 1103a5 can be resolved to the right book by its line number.
    col_ranges: dict[str, dict[int, list]] = defaultdict(dict)
    for seg in spine["segments"]:
        ns = [line["n"] for line in seg["lines"]]
        if ns:
            col_ranges[seg["column"]][seg["book"]] = [min(ns), max(ns)]
    columns_out = {
        col: [
            {"book": b, "lo": rng[0], "hi": rng[1]}
            for b, rng in sorted(books.items())
        ]
        for col, books in col_ranges.items()
    }
    (out_dir / "columns.json").write_text(
        json.dumps(columns_out, ensure_ascii=False, indent=1), encoding="utf-8"
    )

    _merge_shared_lsj()

    (out_dir / "search").mkdir(exist_ok=True)
    for f in [
        "greek_lemma.json",
        "greek_form.json",
        "english.json",
        "meta.json",
        "offsets.json",
        "grammar-dict.json",
        "grammar-col.bin",
    ]:
        shutil.copy(BUILD_DIR / "stage6" / f, out_dir / "search" / f)

    work = manifest.data["work"]
    (out_dir / "manifest.json").write_text(
        json.dumps(
            {
                "work": work,
                "books": book_stats,
                "analyses": analyses_stats,
                "lsj": _load("stage5/summary.json"),
            },
            ensure_ascii=False,
            indent=1,
        ),
        encoding="utf-8",
    )

    reports = BUILD_DIR / "dist" / "reports"
    reports.mkdir(exist_ok=True)
    for rel, dest_name in [
        ("stage2/validation_report.md", "validation_report.md"),
        ("stage2/validation_report.json", "validation_report.json"),
        ("stage3/sigla_log.json", "sigla_log.json"),
        ("stage4/unmatched.json", "unmatched.json"),
        ("stage4/summary.json", "summary.json"),
        ("stage5/missing_lemmata.json", "missing_lemmata.json"),
        ("stage3/quality_report.json", f"quality_{manifest.work_id}.json"),
        ("stage3/quality_report.md", f"quality_{manifest.work_id}.md"),
    ]:
        shutil.copy(BUILD_DIR / rel, reports / dest_name)

    # Curated quotation citations (Metaphysics pilot today). Separate from
    # reports/: a missing file is silence, not an error.
    copy_quotations(work_id=manifest.work_id, out_dir=out_dir)
    return out_dir
