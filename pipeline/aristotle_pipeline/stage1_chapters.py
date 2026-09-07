"""Chapter divisions for works with no Bekker-milestoned English TEI.

Where EN reads chapter starts from the Perseus English TEI's inline Bekker
milestones (stage1_english), works like De Anima get them from the Greek side:
the First1KGreek TEI divides the text into book/chapter <div>s, and the TLG
spine is already Bekker-lineated. We text-align each chapter div's opening words
onto the spine to recover its exact (column, line).

The match is monotonic — each chapter must begin at or after the previous one —
which both fixes opening phrases that recur earlier and pins chapters that share
a column into the right order. Verified on De Anima against canonical anchors
(II.1=412a, III.1=424b22, III.4=429a10, III.5=430a10).
"""

from __future__ import annotations

import re
import unicodedata
from bisect import bisect_left
from pathlib import Path

from lxml import etree

from .config import SOURCES_DIR


def _norm(s: str) -> str:
    """Accent/diacritic-stripped, lowercased base-letter form for matching
    across editions (TLG vs First1KGreek differ only orthographically)."""
    s = unicodedata.normalize("NFD", s)
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = s.lower().replace("’", "'").replace("ʼ", "'")
    s = re.sub(r"[^α-ωa-z ]", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def _spine_words(spine: dict):
    """Flatten the spine into a normalized word stream with each word's owning
    (column, line) and its char offset in the joined string. Also returns each
    book's first word index in the stream, so a chapter whose TEI division
    opens before the spine's book cut can be clamped onto its own book."""
    words, owner = [], []
    book_start: dict[int, int] = {}
    for seg in spine["segments"]:
        book_start.setdefault(seg["book"], len(words))
        for line in seg["lines"]:
            # drop trailing hyphens so a word split across lines still matches.
            # Track each word's index WITHIN its line so a chapter that begins
            # mid-line can be split there (most chapters start mid-line).
            for wi, w in enumerate(_norm(line["text"].replace("-", "")).split()):
                words.append(w)
                owner.append((seg["column"], line["n"], wi))
    joined = " ".join(words)
    wstart, pos = [], 0
    for w in words:
        wstart.append(pos)
        pos += len(w) + 1
    return joined, owner, wstart, book_start


def _local(el) -> str:
    return etree.QName(el).localname if isinstance(el.tag, str) else ""


def _first_word_at(owner, column: str, line, start: int = 0) -> int | None:
    """Index in the spine word stream of the first word at (column, >= line) —
    used to pin a chapter at an authoritative Bekker milestone when text
    alignment misses. `line` may be coarse (the last cadence line milestone).

    `start` is the monotonic cursor: the search begins there, so a milestone
    pointing back up the column cannot file a chapter ABOVE the previous one
    (which _chapter_segments would then resolve by handing the two chapters
    each other's prose). No hit at or after the cursor is reported as
    unresolved — the caller surfaces that as a gap — rather than silently
    regressing. The page-only fallback below has always worked this way.
    """
    if column is None or line is None:
        return None
    try:
        ln = int(line)
    except (TypeError, ValueError):
        return None
    for i in range(max(0, start), len(owner)):
        col, lno, _wi = owner[i]
        if col == column and lno >= ln:
            return i
    return None


def _find_word_run(joined: str, needle: str, after: int) -> int:
    """First occurrence of `needle` in `joined` at or after `after` that starts
    on a WORD boundary, or -1.

    `joined` is the spine flattened to a single space-joined word stream, so a
    bare str.find can land INSIDE a word: a chapter opening `alpha beta gamma
    delta` matches the tail of an earlier `xalpha beta gamma delta`, and the
    chapter is then filed on that line — and marked wordAnchor — without ever
    having matched a word. Only the left edge is checked: the right edge must
    stay loose, because the TEI's last window word is often a prefix of the
    spine's (orthographic divergence is exactly what these windows absorb).
    """
    p = joined.find(needle, after)
    while p > 0 and joined[p - 1] != " ":
        p = joined.find(needle, p + 1)
    return p


def _div_opening(div, k_chars=400) -> str:
    """First ~k chars of text under a chapter div, dropping note/head subtrees
    and a leading single-letter book label."""
    out: list[str] = []

    def walk(node, root=False):
        if _local(node) in ("note", "head") and not root:
            if node.tail:
                out.append(node.tail)
            return
        if node.text:
            out.append(node.text)
        for ch in node:
            walk(ch)
        if not root and node.tail:
            out.append(node.tail)
        if len("".join(out)) > k_chars * 2:
            return

    walk(div, root=True)
    seg = re.sub(r"\s+", " ", "".join(out)).strip()
    return re.sub(r"^\s*[Α-Ω][.·]?\s", " ", seg)[:k_chars]


def _first_bekker_in(div, run_page, run_line):
    """The Bekker (page, line) at the start of a chapter div: the first line
    milestone inside it (with any preceding inner page milestone), falling back
    to the position running when the div opened."""
    page, line = run_page, run_line
    for el in div.iter():
        if _local(el) != "milestone":
            continue
        if el.get("unit") == "page":
            page = el.get("n")
        elif el.get("unit") == "line":
            return page, el.get("n")
    return page, line


def _chapter_openings(grc_path: Path, chapter_subtype: str = "chapter",
                      book_subtype: str = "book", top_book: str | None = None):
    """(book, chapter, opening_text, column, line) for every chapter div, in
    document order. Works with no book divisions default to book 1. The (column,
    line) is the chapter div's first Bekker milestone — an authoritative fallback
    when the opening text's orthography diverges from the spine. Document-order
    walk so the running Bekker position is tracked across milestones.

    `top_book` restricts emission to chapters under the `<div subtype="book"
    n="top_book">` div. Used when one TEI file holds several works (the Analytics
    TEI nests book(priora|posteriora) > part(1|2) > chapter): pass the work's
    top-level book name and book_subtype="part" so only that work's chapters are
    returned, numbered by their part."""
    tree = etree.parse(str(grc_path))
    body = tree.find(".//{*}body")
    if body is None:
        body = tree.getroot()
    out = []
    state = {"book": 1, "page": None, "line": None, "top": None}

    def walk(node):
        ln = _local(node)
        if ln == "milestone":
            if node.get("unit") == "page":
                state["page"] = node.get("n")
            elif node.get("unit") == "line":
                state["line"] = node.get("n")
        elif ln == "div":
            sub, n = node.get("subtype"), node.get("n")
            if sub == "book":
                state["top"] = n
            if sub == book_subtype and (n or "").isdigit():
                state["book"] = int(n)
            elif sub == chapter_subtype and n and n.lstrip("-").isdigit():
                if top_book is None or state["top"] == top_book:
                    col, line = _first_bekker_in(node, state["page"], state["line"])
                    out.append((state["book"], n, _div_opening(node), col, line))
        for ch in node:
            walk(ch)

    walk(body)
    return out
    return out


def _chapter_openings_milestone(grc_path: Path, unit: str = "section",
                                book_subtype: str = "book"):
    """(book, chapter, opening_text, column, line) per <milestone unit=`unit`>,
    in document order. Some Perseus TEIs (e.g. Politics) carry no chapter <div>s
    — chapters are inline section milestones. The chapter number is each book's
    running section index; the opening text is what follows the milestone (for
    text-aligning onto the spine), and (column, line) is the running Bekker
    position at the milestone — an authoritative fallback when the opening's
    orthography diverges from the spine and text alignment misses."""
    tree = etree.parse(str(grc_path))
    body = tree.find(".//{*}body")
    if body is None:
        body = tree.getroot()
    buf: list[str] = []
    marks: list[tuple[int, str, int, str, str]] = []
    state = {"book": 1, "counts": {}, "page": None, "line": None}

    def walk(node):
        ln = _local(node)
        if ln == "div" and node.get("subtype") == book_subtype and (node.get("n") or "").isdigit():
            state["book"] = int(node.get("n"))
        if ln == "milestone":
            unit_attr = node.get("unit")
            if unit_attr == "page":
                state["page"] = node.get("n")
            elif unit_attr == "line":
                state["line"] = node.get("n")
            elif unit_attr == unit:
                b = state["book"]
                c = state["counts"].get(b, 0) + 1
                state["counts"][b] = c
                marks.append((b, str(c), sum(len(x) for x in buf),
                              state["page"], state["line"]))
        if ln in ("note", "head"):
            if node.tail:
                buf.append(node.tail)
            return
        if node.text:
            buf.append(node.text)
        for ch in node:
            walk(ch)
        if node.tail:
            buf.append(node.tail)

    walk(body)
    full = "".join(buf)
    out = []
    for b, chap, pos, col, line in marks:
        seg = re.sub(r"\s+", " ", full[pos:pos + 800]).strip()
        out.append((b, chap, re.sub(r"^\s*[Α-Ω][.·]?\s", " ", seg)[:400], col, line))
    return out


def extract_chapters_explicit(spine: dict, chapter_list: list[dict]) -> list[dict]:
    """Chapters declared directly as Bekker starts in the manifest, e.g.
    `[{n: 1, bekker: "1a1"}, {n: 2, bekker: "1a16"}, ...]`. Used for works whose
    chapter divisions are known exactly (e.g. keyed from a Bekker-stamped
    translation) so no grc TEI text-alignment is needed. Returns the same
    {book, chapter, column, line, wordIndex, bookstart} shape as the grc path.
    The Greek spine is Bekker-lineated, so each (column, line) is authoritative;
    a single book (book 1) is assumed for these single-treatise works."""
    cols = {s["column"] for s in spine["segments"]}
    chapters: list[dict] = []
    for entry in chapter_list:
        ref = str(entry["bekker"]).strip()
        m = re.match(r"^(\d{1,4}[ab])(\d{1,3})$", ref)
        if not m:
            print(f"  chapters: bad explicit bekker {ref!r}")
            continue
        column, line = m.group(1), m.group(2)
        if column not in cols:
            print(f"  chapters: explicit column {column} absent from spine")
        chapter = {
            "book": 1, "chapter": str(entry["n"]), "column": column,
            "line": line, "wordIndex": 0, "bookstart": not chapters,
        }
        # Optional human section title (e.g. "Of Genus and Species" for the
        # Isagoge), surfaced by stage7 as chapter-titles.json and shown by the
        # reader in place of a bare "Chapter N".
        if entry.get("title"):
            chapter["title"] = entry["title"]
        chapters.append(chapter)
    return chapters


def extract_chapters_grc(spine: dict, grc_rel: str,
                         chapter_subtype: str = "chapter",
                         book_subtype: str = "book",
                         chapter_marker: str = "div",
                         top_book: str | None = None,
                         extra: list[dict] | None = None,
                         skip: list | None = None) -> list[dict]:
    """List of {book, chapter, column, line, bookstart} aligned onto the spine.
    `chapter_marker` selects how chapters are read from the grc TEI: "div"
    (<div subtype=chapter_subtype>, default) or "milestone"
    (<milestone unit=chapter_subtype>, for TEIs with no chapter divs).
    `top_book` restricts the div path to one top-level `<div subtype="book">`
    when several works share a TEI file (the Analytics). `extra` adds chapter
    divisions the TEI omits — a list of {n, bekker[, book]} — re-sorted into
    document order (e.g. SophRef 34, which First1KGreek folds into its ch33).
    `skip` drops grc divisions by their source `n`, for TEIs that carry a div
    the translation doesn't treat as its own chapter — e.g. Mechanica, where
    First1KGreek splits problem 8's answer into a spurious second div (n=8) and
    numbers problem 27's div (n=27) with an opening that won't text-align, so it
    is skipped and re-pinned via `extra` at its authoritative Bekker start."""
    grc_path = SOURCES_DIR / grc_rel
    joined, owner, wstart, book_start = _spine_words(spine)
    spine_words = joined.split()
    if chapter_marker == "milestone":
        openings = _chapter_openings_milestone(grc_path, chapter_subtype, book_subtype)
    else:
        openings = _chapter_openings(grc_path, chapter_subtype, book_subtype, top_book)
    if skip:
        drop = {str(n) for n in skip}
        openings = [o for o in openings if str(o[1]) not in drop]
    chapters: list[dict] = []
    after = 0
    for book, chap, opening, mcol, mline in openings:
        word_anchor = False
        if not chapters:
            # The work-start boundary is authoritative, but it was not found by
            # matching the chapter's opening words against the spine.
            widx = 0
        else:
            widx = None
            ow = _norm(opening).split()
            for kk in (8, 6, 5, 4):
                if len(ow) < kk:
                    continue
                p = _find_word_run(joined, " ".join(ow[:kk]), after)
                if p >= 0:
                    widx = joined[:p].count(" ")
                    after = wstart[widx]
                    # This position genuinely matched the chapter opening.
                    word_anchor = True
                    break
            if widx is None and mcol is not None:
                # Orthographic divergence missed the text match; fall back to the
                # milestone's own Bekker position (heading pinned at line start).
                # This is authoritative but not a word-matched anchor.
                widx = _first_word_at(owner, mcol, mline,
                                      bisect_left(wstart, after))
                # Some First1KGreek chapter divs begin immediately after a page
                # milestone, before their first line milestone.  The page is
                # still authoritative; retain the division at the first word in
                # that page following the previous chapter rather than dropping
                # it solely because the line is implicit. This page-only
                # position likewise was not matched to the opening words.
                if widx is None and mline is None:
                    widx = next(
                        (i for i, (col, _, _) in enumerate(owner)
                         if col == mcol and wstart[i] >= after),
                        None,
                    )
                if widx is not None:
                    after = wstart[widx]
            if widx is None and mcol is None:
                # Last resort for grc TEIs with no Bekker milestones (no fallback
                # above). A single orthographic divergence in the opening words
                # otherwise drops the chapter, and it bites at different offsets:
                # APr I.4 diverges at word 4 (spine λέγωμεν vs TEI λέγομεν), so a
                # 3-word prefix saves it; Top VIII.13 diverges at word 2 (spine
                # δὲ vs TEI δ᾿), so we must skip leading particles and match a
                # later window, then step back to the inferred opening. Longer
                # windows are tried first (more specific), and the monotonic
                # `after` pointer keeps a short window from matching before the
                # previous chapter.
                for kk in (4, 3):
                    for start in (0, 1, 2, 3):
                        if len(ow) < start + kk:
                            continue
                        p = _find_word_run(
                            joined, " ".join(ow[start:start + kk]), after)
                        if p >= 0:
                            w = joined[:p].count(" ")
                            widx = max(0, w - start)
                            after = wstart[w]
                            # The suffix match proves the stepped-back position
                            # only when the skipped normalized words are really
                            # present there. Keep the historical position either
                            # way, but never label an inference as word-exact.
                            word_anchor = (
                                w >= start
                                and spine_words[w - start:w] == ow[:start]
                            )
                            break
                    if widx is not None:
                        break
            if widx is None:
                continue  # unmatched chapter (surfaced by the caller as a gap)
        # A grc TEI may divide a book earlier than the spine does (Rhetoric's
        # book II opens at 1377b16 in the TEI, but the TLG spine cuts book 2 at
        # 1378a16). The matched words then belong to the PREVIOUS book's spine
        # segments, so stage7 finds no (book, column) segment to hang the
        # chapter heading on and silently drops it (Rhet II.1/III.1 had no
        # heading anchor). Clamp such a chapter forward to its book's first
        # spine word — the spine's book cut is authoritative for the reader.
        bstart = book_start.get(book)
        if bstart is not None and widx < bstart:
            widx = bstart
            after = max(after, wstart[widx])
            # The clamp replaces any earlier text match with the spine's book
            # boundary, so the resulting position is no longer word-exact.
            word_anchor = False
        col, line, word = owner[widx]
        bookstart = not any(c["book"] == book for c in chapters)
        chapter = {
            "book": book, "chapter": chap, "column": col,
            "line": str(line), "wordIndex": word,
        }
        # Stage 6 claims token precision only for a wordIndex genuinely matched
        # against the Greek text; authoritative fallback positions stay coarser.
        if word_anchor:
            chapter["wordAnchor"] = True
        chapter["bookstart"] = bookstart
        chapters.append(chapter)

    if extra:
        from .refs import line_key
        cols = {s["column"] for s in spine["segments"]}
        for e in extra:
            ref = str(e["bekker"]).strip()
            m = re.match(r"^(\d{1,4}[ab])(\d{1,3})$", ref)
            if not m:
                print(f"  chapters: bad extra bekker {ref!r}")
                continue
            column, line = m.group(1), m.group(2)
            if column not in cols:
                print(f"  chapters: extra column {column} absent from spine")
            chapters.append({
                "book": int(e.get("book", 1)), "chapter": str(e["n"]),
                "column": column, "line": line, "wordIndex": 0, "bookstart": False,
            })
        chapters.sort(key=lambda c: (c["book"], line_key(c["column"], int(c["line"])),
                                     c["wordIndex"]))
        for c in chapters:
            c["bookstart"] = False
        seen: set[int] = set()
        for c in chapters:
            if c["book"] not in seen:
                c["bookstart"] = True
                seen.add(c["book"])
    return chapters
