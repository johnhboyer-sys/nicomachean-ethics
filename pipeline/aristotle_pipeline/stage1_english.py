"""Stage 1b: Perseus English (Rackham) chunked at Bekker page milestones.

Walks the TEI body in document order tracking the enclosing book div and the
last-seen Bekker page milestone; every run of text belongs to the chunk
keyed (book, column). This uniformly handles the duplicate milestones at
mid-column book restarts (III/IV/VI/IX/X) and Book II's restart at 1103a14,
which has no duplicate milestone — entering the book div changes the key.

Translator notes are lifted out of the text flow into a per-chunk standoff
`notes` array anchored by character offset; section/subsection boundaries
are recorded the same way as `markers`.
"""

from __future__ import annotations

import json
import re
from collections import defaultdict
from pathlib import Path

from lxml import etree

from .config import BUILD_DIR, Manifest
from .stage1_common import StandoffChunkMixin, local_name, write_json

_WS = re.compile(r"\s+")


def _local(el) -> str | None:
    return local_name(el)


class _Walker(StandoffChunkMixin):
    def __init__(self, manifest: Manifest):
        self.manifest = manifest
        self.book: int | None = None
        self.column: str = manifest.first_column
        self.line: str | None = None
        self.chunks: list[dict] = []
        self._by_key: dict[tuple, dict] = {}
        # Chapter starts as (book, chapter) -> {column, line}. A chapter's start
        # Bekker reference is the running (page, line) when its chapter div
        # opens — EXCEPT a book's first chapter, whose exact start line only
        # appears at the next line milestone inside it (e.g. 1103a14). The div
        # subtype that marks a chapter boundary is usually "section", but a
        # manifest can override it (e.g. Rhetoric's chapter_subtype: chapter,
        # whose "section" divs are a finer, non-chapter-aligned subdivision
        # that doesn't cover every chapter — matching on it would silently
        # leave some chapters without a marker, see stage7_emit._chapter_starts).
        self._chapter_subtype = (manifest.data.get("chapters") or {}).get("chapter_subtype", "section")
        self.chapters: list[dict] = []
        self._book_first_section = False
        self._pending_first: tuple | None = None
        # chunk id -> [(bekker_line, char_offset), ...] for placing chapter
        # headings on the exact Greek line (see refine_chapter_lines).
        self.line_ms: dict[str, list] = defaultdict(list)

    def walk(self, el):
        tag = _local(el)
        if tag is None:
            self.add_text(el.tail)
            return
        if tag == "note":
            self.add_note(el)
            self.add_text(el.tail)
            return
        if tag == "head":
            # Book headings ("Book 5") are derivable from the div structure;
            # at column-boundary book starts they would otherwise leak into
            # the previous column's chunk.
            self.add_text(el.tail)
            return
        if tag == "p":
            self.add_paragraph()
            self.add_text(el.text)
            for child in el:
                self.walk(child)
            self.add_text(el.tail)
            return
        if tag == "milestone":
            if el.get("resp") == "Bekker":
                if el.get("unit") == "page":
                    self.column = el.get("n")
                elif el.get("unit") == "line":
                    self.line = el.get("n")
                    chunk = self._chunk()
                    self.line_ms[chunk["id"]].append(
                        (int(el.get("n")), len(chunk["text"].rstrip()))
                    )
                    if self._pending_first is not None:
                        book, chap = self._pending_first
                        self.chapters.append(
                            {"book": book, "chapter": chap, "column": self.column,
                             "line": self.line, "bookstart": True}
                        )
                        self._pending_first = None
            self.add_text(el.tail)
            return
        if tag == "div":
            subtype = el.get("subtype")
            if subtype == "book":
                self.book = int(el.get("n"))
                self._book_first_section = True
            elif subtype == self._chapter_subtype:
                chap = el.get("n")
                if self._book_first_section:
                    # Defer to the next line milestone for the exact start line.
                    self._pending_first = (self.book, chap)
                    self._book_first_section = False
                else:
                    self.chapters.append(
                        {"book": self.book, "chapter": chap, "column": self.column,
                         "line": self.line, "bookstart": False}
                    )
                # Stored kind is always "section" regardless of the source div's
                # own subtype name — it's the schema's generic "chapter-boundary
                # marker" kind, consumed by stage7_emit._chapter_starts and
                # align/reference.py.
                self.add_marker("section", chap)
            elif subtype == "subsection":
                self.add_marker(subtype, el.get("n"))
        self.add_text(el.text)
        for child in el:
            self.walk(child)
        self.add_text(el.tail)


# Sentence boundary: an ender (period / ano teleia / Greek question mark)
# followed by space and the next word's first character.
_SENT_END = re.compile(r"[.;···;] +(\S)")


def _interp_line(line_ms, off, last_line, text_len):
    """Bekker line at English char offset `off`, piecewise-linear between the
    chunk's Bekker line milestones (+ chunk end mapped to the column's last
    Greek line). Our Greek IS Bekker-lineated, so this yields a Greek line."""
    pts = sorted(line_ms) + [(last_line, text_len)]
    for (l0, o0), (l1, o1) in zip(pts, pts[1:]):
        if o0 <= off <= o1 and o1 > o0:
            return l0 + (off - o0) / (o1 - o0) * (l1 - l0)
    return pts[0][0] if pts and off < pts[0][1] else last_line


def _interp_offset(pts, target):
    """Char offset for a Bekker line `target`, piecewise-linear between known
    (line, offset) points. Inverse of _interp_line; used to place gutter ticks."""
    for (l0, o0), (l1, o1) in zip(pts, pts[1:]):
        if l0 <= target <= l1 and l1 > l0:
            return o0 + (target - l0) / (l1 - l0) * (o1 - o0)
    return pts[0][1] if target < pts[0][0] else pts[-1][1]


def _snap_word(text: str, off: int) -> int:
    """Snap a char offset to the nearest word start, so an estimated tick never
    splits a word (and the highlighter never sees a half word)."""
    off = max(0, min(off, len(text)))
    if off == 0 or off >= len(text) or text[off] == " ":
        return off + 1 if 0 < off < len(text) and text[off] == " " else off
    left = text.rfind(" ", 0, off)
    right = text.find(" ", off)
    cands = [c + 1 for c in (left, right) if c != -1]
    return min(cands, key=lambda c: abs(c - off)) if cands else off


def add_bekker_gutter(english: dict, spine: dict, dense: bool = False) -> None:
    """Attach to each English chunk a `bekker` list of {n, offset, real}: Bekker
    line ticks at the Greek's cadence (line 1, then every 5th line) down the
    English prose. Real anchors are the TEI line milestones (column start + the
    ~line-20 mark); intervening ticks are proportional estimates (real=False),
    word-snapped. The reader renders them as a left gutter beside the prose."""
    line_ms = english.get("_line_ms", {})
    greek_by_id = {s["id"]: s["lines"] for s in spine["segments"]}
    for c in english["chunks"]:
        greek = greek_by_id.get(c["id"])
        if not greek:
            continue
        text, tlen = c["text"], len(c["text"])
        first_line, last = greek[0]["n"], greek[-1]["n"]
        reals = {int(n): off for n, off in line_ms.get(c["id"], [])}
        reals.setdefault(first_line, 0)  # the column starts at its first Bekker line
        pts = sorted(set(list(reals.items()) + [(last, tlen)]))
        # Cadence mirrors the Greek line numbers: multiples of 5 in the column,
        # plus line 1 at the very top when the column begins at line 1.
        start5 = ((first_line + 4) // 5) * 5
        targets = list(range(start5, last + 1, 5))
        if first_line <= 1 and 1 not in targets:
            targets.insert(0, 1)
        # For densely hand-anchored translations (e.g. Categories' per-segment
        # Bekker anchors) also tick at every real anchor line, not just the
        # 5-line cadence, so the gutter shows its true Bekker points. Gated so
        # the milestone-anchored Rackham/TEI works keep their canonical cadence.
        if dense:
            targets = sorted(set(targets) | {n for n in reals if first_line <= n <= last})
        # One tick per char offset. Targets are walked in ascending line order,
        # so an ESTIMATE for an earlier line reaches a given offset before the
        # real anchor that holds it — first-wins therefore dropped hand-keyed and
        # milestone anchors, and printed the estimate's line number in their
        # place. A real anchor displaces an estimate; every other collision keeps
        # the earlier line, as before.
        by_off: dict[int, dict] = {}
        for t in targets:
            if t in reals:
                off, real = reals[t], True
            else:
                off, real = _snap_word(text, round(_interp_offset(pts, t))), False
            off = max(0, min(off, tlen))
            prev = by_off.get(off)
            if prev is not None and not (real and not prev["real"]):
                continue
            by_off[off] = {"n": t, "offset": off, "real": real}
        ticks = sorted(by_off.values(), key=lambda x: x["offset"])
        c["bekker"] = ticks


def _snap_to_sentence(greek_lines, target_line):
    """The Greek line whose sentence-start sits nearest `target_line`. Chapters
    always begin a new sentence, so this pins the heading to the true incipit."""
    spans, parts, line_start, pos = [], [], {}, 0
    for l in greek_lines:
        line_start[l["n"]] = pos
        spans.append((pos, pos + len(l["text"]), l["n"]))
        parts.append(l["text"])
        pos += len(l["text"]) + 1
    joined = " ".join(parts)

    def line_of(cp):
        for s, e, n in spans:
            if s <= cp <= e:
                return n
        return greek_lines[-1]["n"]

    starts = [0] + [m.start(1) for m in _SENT_END.finditer(joined)]
    ns = [l["n"] for l in greek_lines]
    tgt_n = min(ns, key=lambda n: abs(n - target_line))
    target_pos = line_start[tgt_n]
    # The chapter begins at the first full sentence whose start is at or after
    # the interpolated point; a small back-tolerance absorbs interpolation that
    # lands a hair inside the incipit sentence. Avoids snapping back onto the
    # previous chapter's closing sentence.
    tol = 12
    after = [sp for sp in starts if sp >= target_pos - tol]
    best = min(after) if after else max(starts)
    return line_of(best)


def refine_chapter_lines(english: dict, spine: dict) -> None:
    """Replace each chapter's approximate start line with the exact Greek line,
    by interpolating from the TEI's Bekker line markers then snapping to the
    Greek sentence boundary. Book-start chapters already have exact lines."""
    line_ms = english.pop("_line_ms", {})
    greek_by_id = {s["id"]: s["lines"] for s in spine["segments"]}
    section_off = {}
    for c in english["chunks"]:
        offs = {m["n"]: m["offset"] for m in c["markers"] if m["kind"] == "section"}
        offs["_len"] = len(c["text"])
        section_off[c["id"]] = offs
    for ch in english["chapters"]:
        if ch.get("bookstart"):
            continue
        cid = f"{ch['book']}:{ch['column']}"
        greek = greek_by_id.get(cid)
        offs = section_off.get(cid)
        if not greek or not offs or ch["chapter"] not in offs:
            continue
        est = _interp_line(line_ms.get(cid, []), offs[ch["chapter"]],
                           greek[-1]["n"], offs["_len"])
        ch["line"] = str(_snap_to_sentence(greek, est))


def parse_english(xml_path: Path, manifest: Manifest) -> dict:
    tree = etree.parse(str(xml_path))
    body = tree.find(".//{*}body")
    if body is None:
        raise ValueError("no TEI body found")
    walker = _Walker(manifest)
    walker.walk(body)
    chunks = [c for c in walker.chunks if c["text"].strip() or c["notes"]]
    for c in chunks:
        c["text"] = c["text"].strip()
    return {
        "work": manifest.work_id,
        "source": xml_path.name,
        "translation": manifest.data["work"]["english_translation"],
        "chunks": chunks,
        "chapters": walker.chapters,
        "_line_ms": dict(walker.line_ms),
    }


def build_alignment(spine: dict, english: dict) -> dict:
    """Standoff alignment between spine segments and English chunks,
    matched on the shared (book, column) id."""
    eng_ids = {c["id"] for c in english["chunks"]}
    seg_ids = {s["id"] for s in spine["segments"]}
    pairs = [
        {"segment": s["id"], "english": s["id"] if s["id"] in eng_ids else None}
        for s in spine["segments"]
    ]
    return {
        "work": spine["work"],
        "pairs": pairs,
        "english_only": sorted(eng_ids - seg_ids),
    }


def run(manifest: Manifest, spine: dict, chapters_override=None) -> tuple[Path, Path]:
    english = parse_english(manifest.perseus_eng(), manifest)
    add_bekker_gutter(english, spine)        # uses _line_ms before refine pops it
    if chapters_override is not None:
        # Exact chapter lines from grc text-alignment (stage1_chapters) replace
        # the milestone-interpolated estimate. The English section markers (for
        # the English-column heading offset) still come from the TEI walker.
        english.pop("_line_ms", None)
        english["chapters"] = chapters_override
    else:
        refine_chapter_lines(english, spine)
    out_dir = BUILD_DIR / "stage1"
    out_dir.mkdir(parents=True, exist_ok=True)
    eng_path = out_dir / "english_chunks.json"
    write_json(eng_path, english)
    alignment = build_alignment(spine, english)
    align_path = out_dir / "alignment.json"
    write_json(align_path, alignment)
    return eng_path, align_path
