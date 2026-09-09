"""Preflight validation for emitted Aristotle Reader corpus data."""

from __future__ import annotations

import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

from .refs import column_key, line_key, ref_key


Problem = tuple[str, str, str]


@dataclass
class WorkManifest:
    work_id: str
    path: Path
    data: dict[str, Any]
    public_path: Path | None = None
    private_data: dict[str, Any] | None = None


def validate(data_dir: Path, manifests_dir: Path) -> list[Problem]:
    problems: list[Problem] = []
    manifests = _load_manifests(manifests_dir, problems)
    for manifest in manifests:
        _validate_manifest_schema(manifest, problems)
        _validate_work_data(data_dir, manifest, problems)
    return problems


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if len(argv) != 2:
        print("usage: python3 -m aristotle_pipeline.preflight <data-dir> <manifests-dir>", file=sys.stderr)
        return 2

    data_dir = Path(argv[0])
    manifests_dir = Path(argv[1])
    problems = validate(data_dir, manifests_dir)
    if problems:
        for work, file_name, problem in problems:
            print(f"{work}: {file_name}: {problem}")
        return 1

    print(f"preflight ok: validated {data_dir} against {manifests_dir}")
    return 0


def _load_manifests(manifests_dir: Path, problems: list[Problem]) -> list[WorkManifest]:
    if not manifests_dir.exists():
        problems.append(("-", str(manifests_dir), "manifests directory does not exist"))
        return []

    parsed: list[tuple[Path, dict[str, Any]]] = []
    for path in sorted(manifests_dir.glob("*.yaml")):
        try:
            raw = yaml.safe_load(path.read_text(encoding="utf-8"))
        except Exception as exc:  # pragma: no cover - exact parser text is not stable
            problems.append(("-", path.name, f"invalid YAML: {exc}"))
            continue
        if not isinstance(raw, dict):
            problems.append(("-", path.name, "manifest root must be an object"))
            continue
        parsed.append((path, raw))

    by_work: dict[str, list[tuple[Path, dict[str, Any]]]] = {}
    for path, data in parsed:
        work_id = ((data.get("work") or {}).get("id") if isinstance(data.get("work"), dict) else None)
        if not isinstance(work_id, str) or not work_id:
            problems.append(("-", path.name, "work.id must be a non-empty string"))
            continue
        by_work.setdefault(work_id, []).append((path, data))

    selected: list[WorkManifest] = []
    for work_id, variants in sorted(by_work.items()):
        public = next(((p, d) for p, d in variants if p.name.endswith("-public.yaml")), None)
        private = next(((p, d) for p, d in variants if not p.name.endswith("-public.yaml")), None)
        path, data = public or private or variants[0]
        selected.append(
            WorkManifest(
                work_id=work_id,
                path=path,
                data=data,
                public_path=public[0] if public else None,
                private_data=private[1] if private and public else None,
            )
        )
    return selected


def _validate_manifest_schema(manifest: WorkManifest, problems: list[Problem]) -> None:
    data = manifest.data
    file_name = manifest.path.name
    _require_object(manifest, data, "work", problems)
    _require_object(manifest, data, "bekker_range", problems)
    _require_object(manifest, data, "chapters", problems)
    _require_object(manifest, data, "english", problems)
    _require_object(manifest, data, "sources", problems)
    _require_list(manifest, data, "books", problems)

    work = data.get("work") if isinstance(data.get("work"), dict) else {}
    for key in ["id", "title", "author", "tlg_author", "tlg_work", "greek_edition", "english_translation"]:
        if not isinstance(work.get(key), str) or not work.get(key):
            problems.append((manifest.work_id, file_name, f"work.{key} must be a non-empty string"))

    bekker = data.get("bekker_range") if isinstance(data.get("bekker_range"), dict) else {}
    for key in ["first_column", "last_column"]:
        if not _is_column(bekker.get(key)):
            problems.append((manifest.work_id, file_name, f"bekker_range.{key} must be a Bekker column string"))

    books = data.get("books") if isinstance(data.get("books"), list) else []
    previous_end: tuple[int, str, int] | None = None
    seen_books: set[int] = set()
    for i, book in enumerate(books):
        if not isinstance(book, dict):
            problems.append((manifest.work_id, file_name, f"books[{i}] must be an object"))
            continue
        n = book.get("n")
        if not isinstance(n, int):
            problems.append((manifest.work_id, file_name, f"books[{i}].n must be an integer"))
        elif n in seen_books:
            problems.append((manifest.work_id, file_name, f"duplicate book number {n}"))
        else:
            seen_books.add(n)
        start = book.get("start")
        end = book.get("end")
        if not _is_ref(start):
            problems.append((manifest.work_id, file_name, f"books[{i}].start must be a Bekker ref string"))
            continue
        if not _is_ref(end):
            problems.append((manifest.work_id, file_name, f"books[{i}].end must be a Bekker ref string"))
            continue
        start_key = ref_key(start)
        end_key = ref_key(end)
        if start_key > end_key:
            problems.append((manifest.work_id, file_name, f"books[{i}] start must not be after end"))
        if previous_end is not None and start_key < previous_end:
            problems.append((manifest.work_id, file_name, f"books[{i}] start is before previous book end"))
        previous_end = end_key

    chapters = data.get("chapters") if isinstance(data.get("chapters"), dict) else {}
    if chapters.get("source") == "explicit":
        chapter_list = chapters.get("list")
        if not isinstance(chapter_list, list):
            problems.append((manifest.work_id, file_name, "chapters.list must be a list when chapters.source is explicit"))
        else:
            previous: tuple[int, str, int] | None = None
            for i, chapter in enumerate(chapter_list):
                if not isinstance(chapter, dict):
                    problems.append((manifest.work_id, file_name, f"chapters.list[{i}] must be an object"))
                    continue
                if not isinstance(chapter.get("n"), int):
                    problems.append((manifest.work_id, file_name, f"chapters.list[{i}].n must be an integer"))
                bekker = chapter.get("bekker")
                if not _is_ref(bekker):
                    problems.append((manifest.work_id, file_name, f"chapters.list[{i}].bekker must be a Bekker ref string"))
                    continue
                current = ref_key(bekker)
                if previous is not None and current < previous:
                    problems.append((manifest.work_id, file_name, f"chapters.list[{i}].bekker is out of order"))
                previous = current


def _validate_work_data(data_dir: Path, manifest: WorkManifest, problems: list[Problem]) -> None:
    work_dir = data_dir / manifest.work_id
    if not work_dir.exists():
        problems.append((manifest.work_id, str(work_dir), "emitted work directory does not exist"))
        return
    if not work_dir.is_dir():
        problems.append((manifest.work_id, str(work_dir), "emitted work path is not a directory"))
        return

    loaded: dict[str, Any] = {}
    required = ["manifest.json", "chapters.json", "columns.json", "analyses.json"]
    for book in manifest.data.get("books", []):
        if isinstance(book, dict) and isinstance(book.get("n"), int):
            required.append(f"book-{book['n']:02d}.json")
    for name in required:
        path = work_dir / name
        if not path.exists():
            problems.append((manifest.work_id, name, "emitted JSON file is missing"))
            continue
        try:
            loaded[name] = json.loads(path.read_text(encoding="utf-8"))
        except Exception as exc:
            problems.append((manifest.work_id, name, f"invalid JSON: {exc}"))

    # Non-Bekker works (e.g. Porphyry's Isagoge, citation.scheme: busse) carry
    # synthetic column/line numbers that do not obey Bekker ordering/anchoring
    # semantics, so the Bekker-specific structural checks are skipped for them
    # (schema, file existence, JSON validity, columns, analyses, and public
    # gating still run).
    scheme = (manifest.data.get("citation") or {}).get("scheme")
    bekker_native = scheme in (None, "", "bekker")

    # Manifests declare known, verified irregularities in the TLG line numbering
    # (`expected_line_gaps`: within `column`, after line `after` the sequence
    # legitimately continues at `next` — including backwards jumps and repeats,
    # where the Greek text itself is continuous). These are intentional, so the
    # Greek-line-order and duplicate-anchor checks must not flag the declared
    # transitions.
    expected_gaps = {
        (g["column"], g["after"], g["next"])
        for g in (manifest.data.get("expected_line_gaps") or [])
        if isinstance(g, dict) and {"column", "after", "next"} <= g.keys()
    }

    _validate_emitted_manifest(manifest, loaded.get("manifest.json"), problems)
    segments, anchors, token_keys = _validate_books(manifest, loaded, problems, bekker_native, expected_gaps)
    _validate_chapters(manifest, loaded.get("chapters.json"), segments, anchors, problems, bekker_native)
    _validate_columns(manifest, loaded.get("columns.json"), segments, problems)
    _validate_analyses(manifest, data_dir, loaded.get("analyses.json"), token_keys, problems)
    _validate_footnotes(manifest, work_dir, loaded, problems)
    _validate_public_gating(manifest, loaded, problems)


_FN_REF = re.compile(r"\[\^([\w.*†]+)\]")


def _validate_footnotes(manifest: WorkManifest, work_dir: Path, loaded: dict[str, Any],
                        problems: list[Problem]) -> None:
    """Every note must be reachable from the page, and every marker must resolve.

    A note whose marker never made it into the prose is invisible — nothing on
    the page can open it — and the failure is silent, which is how thirteen of
    them (six of Ostwald's, seven of Owen's) sat unread. An empty definition is
    the same defect one layer down: the marker opens a popup with nothing in it.
    """
    path = work_dir / "footnotes.json"
    if not path.exists():
        return
    try:
        notes = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        problems.append((manifest.work_id, "footnotes.json", f"invalid JSON: {exc}"))
        return
    if not isinstance(notes, dict):
        problems.append((manifest.work_id, "footnotes.json", "root must be an object"))
        return

    cited: set[str] = set()
    # A chapter title can carry a marker too (Ostwald hangs six notes off his
    # chapter headings), and the reader renders it there, so a title counts as a
    # citation — otherwise this check reports a reachable note as lost.
    titles_path = work_dir / "third-titles.json"
    if titles_path.exists():
        try:
            for by_book in json.loads(titles_path.read_text(encoding="utf-8")).values():
                for chapters in (by_book or {}).values():
                    for title in (chapters or {}).values():
                        cited |= set(_FN_REF.findall(str(title)))
        except Exception as exc:
            problems.append((manifest.work_id, "third-titles.json", f"invalid JSON: {exc}"))
    for name, book in loaded.items():
        if not name.startswith("book-") or not isinstance(book, dict):
            continue
        for seg in book.get("segments") or []:
            if not isinstance(seg, dict):
                continue
            slots = [seg.get("english")]
            for key in ("ross", "third"):
                slots.extend(seg.get(key) or [])
            for pieces in (seg.get("overlays") or {}).values():
                slots.extend(pieces or [])
            for piece in slots:
                if isinstance(piece, dict):
                    cited |= set(_FN_REF.findall(piece.get("text") or ""))

    for label in sorted(set(notes) - cited):
        problems.append((manifest.work_id, "footnotes.json",
                         f"note {label} is never cited, so nothing on the page can open it"))
    for label in sorted(cited - set(notes)):
        problems.append((manifest.work_id, "footnotes.json",
                         f"note {label} is cited in the prose but has no definition"))
    for label in sorted(n for n, html in notes.items() if not str(html).strip()):
        problems.append((manifest.work_id, "footnotes.json",
                         f"note {label} is empty, so its marker opens an empty popup"))


def _validate_emitted_manifest(manifest: WorkManifest, emitted: Any, problems: list[Problem]) -> None:
    if emitted is None:
        return
    if not isinstance(emitted, dict):
        problems.append((manifest.work_id, "manifest.json", "root must be an object"))
        return
    work = emitted.get("work")
    if not isinstance(work, dict):
        problems.append((manifest.work_id, "manifest.json", "work must be an object"))
        return
    if work.get("id") != manifest.work_id:
        problems.append((manifest.work_id, "manifest.json", f"work.id {work.get('id')!r} does not match manifest"))
    # stage7 copies the manifest's `work` block into manifest.json, so the
    # translation named there is the one the books and search index were
    # built from. A public manifest can swap the PRIMARY translation (Meta,
    # Pol: Loeb -> Ross/Jowett), which the slot-based gating check below never
    # sees — so a data dir emitted from the private manifest passed against
    # the public one with the gated prose in every book.
    expected = manifest.data.get("work") if isinstance(manifest.data.get("work"), dict) else {}
    emitted_name = work.get("english_translation")
    wanted_name = expected.get("english_translation")
    if wanted_name and emitted_name != wanted_name:
        problems.append((manifest.work_id, "manifest.json",
                         f"work.english_translation {emitted_name!r} does not match the selected "
                         f"manifest's {wanted_name!r} — the data was emitted from a different manifest"))


def _validate_books(
    manifest: WorkManifest,
    loaded: dict[str, Any],
    problems: list[Problem],
    bekker_native: bool = True,
    expected_gaps: set[tuple[str, int, int]] | None = None,
) -> tuple[dict[tuple[int, str], dict[str, Any]], set[tuple[int, str, int]], set[str]]:
    expected_gaps = expected_gaps or set()
    segments_by_book_col: dict[tuple[int, str], dict[str, Any]] = {}
    anchors: set[tuple[int, str, int]] = set()
    # Every (anchor, lettered suffix) actually emitted — what the duplicate
    # check counts, since `anchors` deliberately forgets the suffix.
    placed: set[tuple[tuple[int, str, int], str | None]] = set()
    token_keys: set[str] = set()
    seen_segment_ids: set[str] = set()
    previous_segment_key: tuple[int, str, int] | None = None

    for book in manifest.data.get("books", []):
        if not isinstance(book, dict) or not isinstance(book.get("n"), int):
            continue
        name = f"book-{book['n']:02d}.json"
        doc = loaded.get(name)
        if doc is None:
            continue
        if not isinstance(doc, dict):
            problems.append((manifest.work_id, name, "root must be an object"))
            continue
        if doc.get("book") != book["n"]:
            problems.append((manifest.work_id, name, f"book field must be {book['n']}"))
        segments = doc.get("segments")
        if not isinstance(segments, list):
            problems.append((manifest.work_id, name, "segments must be a list"))
            continue
        previous_in_book: tuple[int, str, int] | None = None
        for i, segment in enumerate(segments):
            if not isinstance(segment, dict):
                problems.append((manifest.work_id, name, f"segments[{i}] must be an object"))
                continue
            seg_id = segment.get("id")
            column = segment.get("column")
            if not isinstance(seg_id, str) or not seg_id:
                problems.append((manifest.work_id, name, f"segments[{i}].id must be a non-empty string"))
            elif seg_id in seen_segment_ids:
                problems.append((manifest.work_id, name, f"duplicate segment id {seg_id}"))
            else:
                seen_segment_ids.add(seg_id)
            if not _is_column(column):
                problems.append((manifest.work_id, name, f"segments[{i}].column must be a Bekker column string"))
                continue
            greek = segment.get("greek")
            if not isinstance(greek, list) or not greek:
                problems.append((manifest.work_id, name, f"segments[{i}].greek must be a non-empty list"))
                continue
            line_numbers: set[int] = set()
            previous_line: int | None = None
            for j, line in enumerate(greek):
                if not isinstance(line, dict):
                    problems.append((manifest.work_id, name, f"{seg_id}: greek[{j}] must be an object"))
                    continue
                n = line.get("n")
                if not isinstance(n, int):
                    problems.append((manifest.work_id, name, f"{seg_id}: greek[{j}].n must be an integer"))
                    continue
                prior_line = previous_line
                declared_gap = (column, prior_line, n) in expected_gaps
                if bekker_native and prior_line is not None and n < prior_line and not declared_gap:
                    problems.append((manifest.work_id, name, f"{seg_id}: Greek Bekker lines are out of order at {column}{n}"))
                previous_line = n
                # A lettered line keeps the number of the line it follows
                # (Physics 244b runs 1-5, 5a-5d, 6-15), so the suffix tells the
                # two apart — as it already does in stage3's refs and stage7's
                # token keys. Without it each of Bekker's 48 lettered lines
                # reads as a duplicate of the line above it. It stays out of
                # `anchors`, which a citation resolves against by line number
                # alone: 244b5 must still land whether or not 5a follows it.
                sub = line.get("sub")
                anchor = (book["n"], column, n)
                if bekker_native and (anchor, sub) in placed and not declared_gap:
                    problems.append((manifest.work_id, name,
                                     f"duplicate Bekker anchor {column}{n}{sub or ''}"))
                placed.add((anchor, sub))
                anchors.add(anchor)
                line_numbers.add(n)
                _collect_token_keys(manifest, name, seg_id or f"segments[{i}]", line, token_keys, problems)

            first_line = min(line_numbers)
            current_key = line_key(column, first_line)
            if bekker_native and previous_in_book is not None and current_key < previous_in_book:
                problems.append((manifest.work_id, name, f"{seg_id}: segment Bekker order moved backwards at {column}{first_line}"))
            if bekker_native and previous_segment_key is not None and current_key < previous_segment_key:
                problems.append((manifest.work_id, name, f"{seg_id}: work Bekker order moved backwards at {column}{first_line}"))
            previous_in_book = current_key
            previous_segment_key = current_key
            segments_by_book_col[(book["n"], column)] = {"segment": segment, "lines": line_numbers, "file": name}
            _validate_english_bekker(manifest, name, seg_id or f"segments[{i}]", segment, line_numbers, problems)
            _validate_chapter_starts(manifest, name, seg_id or f"segments[{i}]", segment, line_numbers, anchors, book["n"], column, problems, bekker_native)
    return segments_by_book_col, anchors, token_keys


def _collect_token_keys(
    manifest: WorkManifest,
    file_name: str,
    seg_id: str,
    line: dict[str, Any],
    token_keys: set[str],
    problems: list[Problem],
) -> None:
    tokens = line.get("tokens")
    if not isinstance(tokens, list):
        problems.append((manifest.work_id, file_name, f"{seg_id}: greek line tokens must be a list"))
        return
    for token in tokens:
        if not isinstance(token, dict):
            problems.append((manifest.work_id, file_name, f"{seg_id}: token must be an object"))
            continue
        key = token.get("k")
        if not isinstance(key, str) or not key:
            problems.append((manifest.work_id, file_name, f"{seg_id}: token.k must be a non-empty string"))
        else:
            token_keys.add(key)
    for cell in line.get("cells", []) or []:
        if not isinstance(cell, dict):
            problems.append((manifest.work_id, file_name, f"{seg_id}: cell must be an object"))
            continue
        if not isinstance(cell.get("tokens"), list):
            problems.append((manifest.work_id, file_name, f"{seg_id}: cell tokens must be a list"))


def _validate_english_bekker(
    manifest: WorkManifest,
    file_name: str,
    seg_id: str,
    segment: dict[str, Any],
    line_numbers: set[int],
    problems: list[Problem],
) -> None:
    english = segment.get("english")
    if english is None:
        return
    if not isinstance(english, dict):
        problems.append((manifest.work_id, file_name, f"{seg_id}: english must be an object or null"))
        return
    for marker in english.get("bekker", []) or []:
        if not isinstance(marker, dict):
            problems.append((manifest.work_id, file_name, f"{seg_id}: english.bekker marker must be an object"))
            continue
        n = marker.get("n")
        if not isinstance(n, int):
            problems.append((manifest.work_id, file_name, f"{seg_id}: english.bekker.n must be an integer"))
            continue
        # NOTE: english.bekker markers carry only a line number `n`, not the
        # column. A segment's English prose routinely runs past its own column
        # into the next one, so the marker list legitimately contains e.g.
        # ...,30,35,1 (column X line 35 then column X+1 line 1). Without a column
        # tag we cannot tell that valid reset apart from real disorder, nor
        # verify a marker's Greek anchor (line 1 belongs to the next column's
        # Greek, absent from this segment's line set). Both checks produced only
        # false positives on the live corpus, so marker *shape* is validated but
        # ordering/anchoring is not.


def _validate_chapter_starts(
    manifest: WorkManifest,
    file_name: str,
    seg_id: str,
    segment: dict[str, Any],
    line_numbers: set[int],
    anchors: set[tuple[int, str, int]],
    book: int,
    column: str,
    problems: list[Problem],
    bekker_native: bool = True,
) -> None:
    starts = segment.get("chapterStarts", []) or []
    if not isinstance(starts, list):
        problems.append((manifest.work_id, file_name, f"{seg_id}: chapterStarts must be a list"))
        return
    previous_line: int | None = None
    for start in starts:
        if not isinstance(start, dict):
            problems.append((manifest.work_id, file_name, f"{seg_id}: chapterStart must be an object"))
            continue
        before_line = start.get("beforeLine")
        if not isinstance(before_line, int):
            problems.append((manifest.work_id, file_name, f"{seg_id}: chapterStarts.beforeLine must be an integer"))
            continue
        if bekker_native and previous_line is not None and before_line < previous_line:
            problems.append((manifest.work_id, file_name, f"{seg_id}: chapterStarts are out of order at line {before_line}"))
        if bekker_native and before_line not in line_numbers:
            problems.append((manifest.work_id, file_name, f"{seg_id}: chapterStart beforeLine {before_line} has no Greek line"))
        if bekker_native and (book, column, before_line) not in anchors:
            problems.append((manifest.work_id, file_name, f"{seg_id}: chapterStart beforeLine {before_line} has no Bekker anchor"))
        previous_line = before_line


def _validate_chapters(
    manifest: WorkManifest,
    chapters: Any,
    segments: dict[tuple[int, str], dict[str, Any]],
    anchors: set[tuple[int, str, int]],
    problems: list[Problem],
    bekker_native: bool = True,
) -> None:
    if chapters is None:
        return
    if not isinstance(chapters, dict):
        problems.append((manifest.work_id, "chapters.json", "root must be an object"))
        return
    for book_key, refs in chapters.items():
        try:
            book = int(book_key)
        except (TypeError, ValueError):
            problems.append((manifest.work_id, "chapters.json", f"book key {book_key!r} is not an integer string"))
            continue
        if not isinstance(refs, list):
            problems.append((manifest.work_id, "chapters.json", f"book {book_key} value must be a list"))
            continue
        previous: tuple[int, str, int] | None = None
        for i, ref in enumerate(refs):
            if not isinstance(ref, dict):
                problems.append((manifest.work_id, "chapters.json", f"{book_key}[{i}] must be an object"))
                continue
            column = ref.get("column")
            line_raw = ref.get("line")
            if not _is_column(column):
                problems.append((manifest.work_id, "chapters.json", f"{book_key}[{i}].column must be a Bekker column string"))
                continue
            try:
                line = int(line_raw)
            except (TypeError, ValueError):
                problems.append((manifest.work_id, "chapters.json", f"{book_key}[{i}].line must be an integer string"))
                continue
            current = line_key(column, line)
            if bekker_native and previous is not None and current < previous:
                problems.append((manifest.work_id, "chapters.json", f"chapter refs are out of order at {column}{line}"))
            previous = current
            # Book divisions do not always align with Bekker column boundaries:
            # a book's opening chapter can begin mid-column in a column that is
            # emitted under the PREVIOUS book (e.g. Rhetoric, where Freese marks
            # the I/II and II/III divisions one column before the Greek). When
            # the same column exists under book-1, treat the anchor as a
            # legitimate book-boundary offset rather than a dangling reference.
            missing_segment = (book, column) not in segments
            boundary_offset = missing_segment and (book - 1, column) in segments
            if missing_segment and not boundary_offset:
                problems.append((manifest.work_id, "chapters.json", f"chapter {ref.get('chapter')!r} points to missing segment {book}:{column}"))
            elif not missing_segment and bekker_native and line not in segments[(book, column)]["lines"]:
                problems.append((manifest.work_id, "chapters.json", f"chapter {ref.get('chapter')!r} points to missing Bekker anchor {column}{line}"))
            if bekker_native and not boundary_offset and (book, column, line) not in anchors:
                problems.append((manifest.work_id, "chapters.json", f"chapter {ref.get('chapter')!r} has dangling Bekker anchor {column}{line}"))
            if bekker_native and not boundary_offset:
                _validate_bekker_span(manifest, "chapters.json", ref.get("bekker"), anchors, book, problems)


def _validate_columns(
    manifest: WorkManifest,
    columns: Any,
    segments: dict[tuple[int, str], dict[str, Any]],
    problems: list[Problem],
) -> None:
    if columns is None:
        return
    if not isinstance(columns, dict):
        problems.append((manifest.work_id, "columns.json", "root must be an object"))
        return
    for column, entries in columns.items():
        if not _is_column(column):
            problems.append((manifest.work_id, "columns.json", f"column key {column!r} is not a Bekker column"))
            continue
        if not isinstance(entries, list):
            problems.append((manifest.work_id, "columns.json", f"{column} entries must be a list"))
            continue
        previous_book: int | None = None
        for entry in entries:
            if not isinstance(entry, dict):
                problems.append((manifest.work_id, "columns.json", f"{column} entry must be an object"))
                continue
            book = entry.get("book")
            lo = entry.get("lo")
            hi = entry.get("hi")
            if not isinstance(book, int) or not isinstance(lo, int) or not isinstance(hi, int):
                problems.append((manifest.work_id, "columns.json", f"{column} entry book/lo/hi must be integers"))
                continue
            if lo > hi:
                problems.append((manifest.work_id, "columns.json", f"{column} book {book} lo must not exceed hi"))
            if previous_book is not None and book < previous_book:
                problems.append((manifest.work_id, "columns.json", f"{column} book entries are out of order"))
            previous_book = book
            segment = segments.get((book, column))
            if segment is None:
                problems.append((manifest.work_id, "columns.json", f"{column} book {book} has no emitted segment"))
            else:
                lines = segment["lines"]
                if lines and (min(lines) != lo or max(lines) != hi):
                    problems.append((manifest.work_id, "columns.json", f"{column} book {book} range {lo}-{hi} does not match Greek lines"))
    for book, column in segments:
        if column not in columns:
            problems.append((manifest.work_id, "columns.json", f"missing column entry for {book}:{column}"))


def _validate_analyses(
    manifest: WorkManifest,
    data_dir: Path,
    analyses: Any,
    token_keys: set[str],
    problems: list[Problem],
) -> None:
    if analyses is None:
        return
    if not isinstance(analyses, dict):
        problems.append((manifest.work_id, "analyses.json", "root must be an object"))
        return
    # A referenced Greek token having no entry in analyses is EXPECTED, not a
    # defect: Morpheus fails to parse some rare/inflected forms and the
    # spurious-parse filter deliberately drops others, so the reader simply
    # shows no word popup for them. Flagging every such token produced ~1300
    # false positives against the live corpus, so token-key *presence* is not
    # validated. (token_keys is still passed in for possible future coverage
    # reporting.) The structural validation of the entries that DO exist, and
    # LSJ-key resolution, remain below.
    lsj_keys: set[str] = set()
    for key, entries in analyses.items():
        if not isinstance(entries, list):
            problems.append((manifest.work_id, "analyses.json", f"{key}: analyses value must be a list"))
            continue
        for entry in entries:
            if not isinstance(entry, dict):
                problems.append((manifest.work_id, "analyses.json", f"{key}: analysis entry must be an object"))
                continue
            for required in ["lemma", "gloss", "parse"]:
                if not isinstance(entry.get(required), str):
                    problems.append((manifest.work_id, "analyses.json", f"{key}: {required} must be a string"))
            lsj = entry.get("lsj")
            if not isinstance(lsj, list):
                problems.append((manifest.work_id, "analyses.json", f"{key}: lsj must be a list"))
                continue
            for lsj_key in lsj:
                if not isinstance(lsj_key, str) or not lsj_key:
                    problems.append((manifest.work_id, "analyses.json", f"{key}: lsj key must be a non-empty string"))
                else:
                    lsj_keys.add(lsj_key)
    _validate_lsj_keys(manifest, data_dir, lsj_keys, problems)


def _validate_lsj_keys(
    manifest: WorkManifest,
    data_dir: Path,
    lsj_keys: set[str],
    problems: list[Problem],
) -> None:
    shards: dict[str, dict[str, Any]] = {}
    for key in sorted(lsj_keys):
        shard_name = _lsj_shard(key)
        shard_path = data_dir / "lsj" / f"{shard_name}.json"
        if not shard_path.exists():
            problems.append((manifest.work_id, f"lsj/{shard_name}.json", f"LSJ key {key!r} references missing shard"))
            continue
        if shard_name not in shards:
            try:
                shard = json.loads(shard_path.read_text(encoding="utf-8"))
            except Exception as exc:
                problems.append((manifest.work_id, f"lsj/{shard_name}.json", f"invalid JSON: {exc}"))
                continue
            if not isinstance(shard, dict):
                problems.append((manifest.work_id, f"lsj/{shard_name}.json", "shard root must be an object"))
                continue
            shards[shard_name] = shard
        if key not in shards.get(shard_name, {}):
            problems.append((manifest.work_id, f"lsj/{shard_name}.json", f"LSJ key {key!r} is not present in shard"))


def _validate_public_gating(
    manifest: WorkManifest,
    loaded: dict[str, Any],
    problems: list[Problem],
) -> None:
    if manifest.public_path is None or manifest.private_data is None:
        return
    omitted = _omitted_translation_slots(manifest.private_data, manifest.data)
    if not omitted:
        return
    for file_name, doc in loaded.items():
        if not file_name.startswith("book-") or not isinstance(doc, dict):
            continue
        for segment in doc.get("segments", []) or []:
            if not isinstance(segment, dict):
                continue
            for slot in omitted:
                if slot == "secondary" and "ross" in segment:
                    problems.append((manifest.work_id, file_name, "private secondary translation appears in public data"))
                elif slot == "third" and "third" in segment:
                    problems.append((manifest.work_id, file_name, "private third translation appears in public data"))
                elif slot.startswith("overlay:"):
                    overlay_id = slot.split(":", 1)[1]
                    overlays = segment.get("overlays")
                    if isinstance(overlays, dict) and overlay_id in overlays:
                        problems.append((manifest.work_id, file_name, f"private overlay {overlay_id!r} appears in public data"))


def _omitted_translation_slots(private: dict[str, Any], public: dict[str, Any]) -> set[str]:
    private_english = private.get("english") if isinstance(private.get("english"), dict) else {}
    public_english = public.get("english") if isinstance(public.get("english"), dict) else {}
    omitted: set[str] = set()
    for slot in ["secondary", "third"]:
        if slot in private_english and slot not in public_english:
            omitted.add(slot)
    private_overlays = {
        item.get("id")
        for item in private_english.get("overlays", []) or []
        if isinstance(item, dict) and isinstance(item.get("id"), str)
    }
    public_overlays = {
        item.get("id")
        for item in public_english.get("overlays", []) or []
        if isinstance(item, dict) and isinstance(item.get("id"), str)
    }
    for overlay_id in private_overlays - public_overlays:
        omitted.add(f"overlay:{overlay_id}")
    return omitted


def _validate_bekker_span(
    manifest: WorkManifest,
    file_name: str,
    span: Any,
    anchors: set[tuple[int, str, int]],
    book: int,
    problems: list[Problem],
) -> None:
    if not isinstance(span, str) or not span:
        problems.append((manifest.work_id, file_name, "chapter bekker span must be a non-empty string"))
        return
    parts = span.split("–")
    if len(parts) == 1:
        refs = [_span_ref(parts[0], None)]
    elif len(parts) == 2:
        refs = [_span_ref(parts[0], None), _span_ref(parts[1], parts[0])]
    else:
        problems.append((manifest.work_id, file_name, f"invalid Bekker span {span!r}"))
        return
    parsed: list[tuple[str, int]] = []
    for ref in refs:
        if ref is None:
            problems.append((manifest.work_id, file_name, f"invalid Bekker span {span!r}"))
            return
        column, line = ref
        parsed.append(ref)
        if (book, column, line) not in anchors:
            problems.append((manifest.work_id, file_name, f"chapter span {span!r} references missing Bekker anchor {column}{line}"))
    if len(parsed) == 2 and line_key(*parsed[0]) > line_key(*parsed[1]):
        problems.append((manifest.work_id, file_name, f"chapter span {span!r} is out of order"))


def _span_ref(raw: str, first_part: str | None) -> tuple[str, int] | None:
    raw = raw.strip()
    if _is_ref(raw):
        page, side, line = ref_key(raw)
        return f"{page}{side}", line
    if first_part and raw.isdigit() and _is_ref(first_part.strip()):
        page, side, _line = ref_key(first_part.strip())
        return f"{page}{side}", int(raw)
    return None


def _require_object(manifest: WorkManifest, data: dict[str, Any], key: str, problems: list[Problem]) -> None:
    if not isinstance(data.get(key), dict):
        problems.append((manifest.work_id, manifest.path.name, f"{key} must be an object"))


def _require_list(manifest: WorkManifest, data: dict[str, Any], key: str, problems: list[Problem]) -> None:
    if not isinstance(data.get(key), list):
        problems.append((manifest.work_id, manifest.path.name, f"{key} must be a list"))


def _is_column(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    try:
        column_key(value)
    except ValueError:
        return False
    return True


def _is_ref(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    try:
        ref_key(value)
    except ValueError:
        return False
    return True


def _lsj_shard(key: str) -> str:
    for ch in key:
        if ch == "*":
            continue
        if "a" <= ch <= "z":
            return ch
    return "_"


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
