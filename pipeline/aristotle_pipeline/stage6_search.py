"""Stage 6: build the search index for the Astro frontend.

Emits these files under build/stage6/:

  greek_lemma.json — {fold_lemma: [[seg_idx, token_pos], ...]}
                 keyed by the token's dictionary HEADWORD (lemma), so a query
                 finds every inflected form of a word. fold_lemma strips all
                 accents, breathings, iotasubscript, macrons from the Beta Code
                 key (only base letters remain), so wildcard prefix matching
                 works uniformly.

  greek_form.json — {fold(surface): [[seg_idx, token_pos], ...]}
                 keyed by the SURFACE form as written (the inflected token), so
                 a query can match the exact form rather than the whole lemma.

  english.json — {word: [[seg_idx, word_pos], ...]}
                 Lowercased English words as english_words() splits them,
                 with the word's position in its segment, so a phrase is an
                 adjacency test over postings exactly as it is for Greek.
                 (Until 2026-09-07 the postings were bare seg_idxs and the
                 reader verified a phrase against english_head, which holds
                 only the first 500 characters; the reader still reads that
                 shape from an older build.)

  meta.json    — [{id, book, column, greek_head, english_head}]
                 Ordered list of segment metadata, indexed by seg_idx.
                 greek_head: first two lines of text (for result preview).
                 english_head: first 500 chars of English chunk.

  offsets.json — the word-offset primitive: one running token number per work,
                 in document order, plus the structural coordinates beside it.
                 {token_count, seg_base_offset[], segments[{book, column,
                 line_runs}], book_bounds[], chapter_bounds[]}.
                 Global offset of a posting = seg_base_offset[seg_idx] +
                 token_pos. Proximity and n-grams measure nearness on this
                 offset; the coordinates let a query narrow to a line, chapter
                 or book. Chapter bounds carry an accuracy flag — see
                 remap_word_index below.

All of these are copied to build/dist/{work}/search/ by stage7.
"""

from __future__ import annotations

import json
import re
import struct
from collections import defaultdict
from pathlib import Path

from .config import BUILD_DIR, Manifest
from .stage2_validate import check_grammar, check_ngram_streams, check_offsets

_FOLD = re.compile(r"[^a-z']")  # keep only base letters and apostrophe
_EN_WORD = re.compile(r"[a-z']+")
# The archive translations print possessives and contractions with U+2019
# (Aristotle’s, isn’t); U+02BC is the modifier-letter apostrophe. The reader
# folds a typed straight apostrophe to itself (englishFold) and, in its phrase
# check, folds the text's curly one to straight (engPhraseMatches) — so the
# index must key "aristotle's" as one word or neither path can find it.
_EN_APOSTROPHE = re.compile("[\u2019\u02bc]")


def fold_lemma(beta_key: str) -> str:
    """Strip all Beta Code diacritics; keep only base letters + apostrophe."""
    return _FOLD.sub("", beta_key.lower())


def english_words(text: str) -> list[str]:
    """The English word stream as the reader's fold sees it: lowercase, curly
    apostrophes made straight, split on anything outside [a-z']. An apostrophe
    at a word's edge is a quotation mark (‘change’ closes with the same U+2019
    that Aristotle’s elides with) and is not part of the word. Shared with
    stage8 so english.json and english-segments.json count the same words."""
    words = _EN_WORD.findall(_EN_APOSTROPHE.sub("'", text).lower())
    return [w for w in (raw.strip("'") for raw in words) if w]


# -- Morphology feature vocabulary -------------------------------------------
# Derived from what stage4 actually emits. `parse` is a raw Morpheus string
# ("pres ind act 2nd sg (doric aeolic)") with parentheses glued to the first and
# last word of a qualifier run, so strip the parens and classify word by word.
#
# There is deliberately NO part-of-speech category. Morpheus emits no
# noun/verb/adjective field, and inferring one from feature presence would
# overstate the data: participles carry both nominal and verbal morphology, and
# nouns and adjectives are indistinguishable here. Only Morpheus's own explicit
# markers are indexed, under "marker". Note that `part` is the PARTICIPLE mood,
# not `particle` — they are different tags and must not be conflated.
#
# Dialect words (attic, epic, doric, …) and clitic/format markers (enclitic,
# nu_movable, indeclform, …) are not queryable features and are skipped. Two
# analyses differing only by dialect collapse to one reading, which is right:
# they are the same morphological reading.
_FEATURES: dict[str, str] = {
    value: category
    for category, values in {
        "gender": "masc fem neut masc/fem masc/neut masc/fem/neut",
        "case": "nom gen dat acc voc nom/acc nom/voc nom/voc/acc gen/dat",
        "number": "sg pl dual",
        "person": "1st 2nd 3rd",
        "tense": "pres imperf fut aor perf plup futperf",
        "mood": "ind subj opt imperat inf part",
        "voice": "act mid pass mp",
        "degree": "comp superl irreg_comp",
        "marker": "adverb adverbial particle prep conj interrog exclam indecl numeral letter",
    }.items()
    for value in values.split()
}

# Reserved signature ids, so the column stays aligned with the offset space
# even where there is nothing to say about a token.
SIG_UNKEYED = 0     # token had no Beta Code key (stage3 key failure)
SIG_UNANALYSED = 1  # key resolved, but Morpheus returned no analysis


def parse_reading(parse: str) -> dict[str, list[str]]:
    """One Morpheus parse string -> {category: [values]}.

    Syncretic values expand INSIDE the reading (nom/voc/acc -> nom, voc, acc).
    A single analysis spanning three cases is genuinely three-way ambiguous and
    must never be reported as one certain parse — that expansion is what makes
    the ambiguity count honest rather than a count of analysis records.
    """
    reading: dict[str, list[str]] = {}
    for word in parse.replace("(", " ").replace(")", " ").split():
        category = _FEATURES.get(word)
        if category is None:
            continue
        values = reading.setdefault(category, [])
        for value in word.split("/"):
            if value not in values:
                values.append(value)
    return {c: sorted(v) for c, v in reading.items()}


def signature(entries: list[dict]) -> tuple:
    """The distinct readings a token's analyses license, canonically ordered.

    Whole readings are kept rather than a per-category union, so correlations
    survive: analyses {masc nom sg, fem acc pl} must not satisfy a query for
    masc + acc + sg, which a flattened union would wrongly allow.
    """
    readings = []
    for entry in entries:
        reading = parse_reading(entry.get("parse") or "")
        if not reading:
            continue
        key = tuple((c, tuple(v)) for c, v in sorted(reading.items()))
        if key not in readings:
            readings.append(key)
    return tuple(sorted(readings))


def remap_word_index(line_text: str, tokens: list[dict], word_index: int) -> int | None:
    """Map a chapter anchor's word index onto a stage3 token index.

    Chapter anchors count words the stage1 way (_norm: keep base letters and
    spaces, then split); stage3 counts tokens its own way (split on non-space
    runs, strip edge punctuation, drop inner sigla). The two usually agree, but
    nothing guarantees it — an em-dash, a stray siglum or a bare numeral can
    shift one and not the other. So align the streams by their normalized text
    rather than trusting the index across the seam.

    Returns the token index, or None when the streams don't align or the index
    falls outside the line (caller falls back to the line start).
    """
    # Imported locally: stage1_chapters pulls in lxml, which this stage does not
    # otherwise need.
    from .stage1_chapters import _norm

    words = _norm(line_text.replace("-", "")).split()
    normed = [(i, _norm(t["t"])) for i, t in enumerate(tokens)]
    normed = [(i, n) for i, n in normed if n]
    if len(normed) != len(words) or any(n != w for (_, n), w in zip(normed, words)):
        return None
    if not 0 <= word_index < len(normed):
        return None
    return normed[word_index][0]


def run(manifest: Manifest) -> Path:
    tokens_doc = json.loads(
        (BUILD_DIR / "stage3" / "tokens.json").read_text(encoding="utf-8")
    )
    key_map = json.loads(
        (BUILD_DIR / "stage4" / "key_map.json").read_text(encoding="utf-8")
    )
    analyses = json.loads(
        (BUILD_DIR / "stage4" / "analyses.json").read_text(encoding="utf-8")
    )
    english = json.loads(
        (BUILD_DIR / "stage1" / "english_chunks.json").read_text(encoding="utf-8")
    )
    spine = json.loads(
        (BUILD_DIR / "stage1" / "greek_spine.json").read_text(encoding="utf-8")
    )

    # Ordered segment list for index keys
    segments = tokens_doc["segments"]
    seg_idx = {s["id"]: i for i, s in enumerate(segments)}

    eng_by_id = {c["id"]: c for c in english["chunks"]}

    # -- Greek inverted indexes ----------------------------------------------
    # Two parallel indexes, both fold_lemma -> [(seg_idx, token_pos), ...]:
    #   lemma_posts: keyed by each token's dictionary headword(s) — "all forms".
    #   form_posts:  keyed by the token's surface form as written — "exact form".
    lemma_posts: dict[str, list] = defaultdict(list)
    form_posts: dict[str, list] = defaultdict(list)
    for seg in segments:
        si = seg_idx[seg["id"]]
        pos = 0
        for line in seg["lines"]:
            for tok in line["tokens"]:
                key = tok.get("k")
                if key:
                    sf = fold_lemma(key)  # surface form as written
                    if sf:
                        form_posts[sf].append([si, pos])
                stored = key_map.get(key) if key else None
                if stored:
                    for a in analyses.get(stored, []):
                        fl = fold_lemma(a["lemma"]) if a["lemma"] else fold_lemma(stored)
                        if fl:
                            lemma_posts[fl].append([si, pos])
                pos += 1

    # Deduplicate each index (a lemma may repeat from homonym analyses; a
    # surface key is added once per token but dedupe defensively).
    def _dedupe(posts: dict[str, list]) -> dict[str, list]:
        out: dict[str, list] = {}
        for fl, plist in posts.items():
            seen: set[tuple] = set()
            deduped = []
            for pair in plist:
                t = tuple(pair)
                if t not in seen:
                    seen.add(t)
                    deduped.append(pair)
            out[fl] = deduped
        return out

    greek_lemma = _dedupe(lemma_posts)
    greek_form = _dedupe(form_posts)

    # -- English inverted index -----------------------------------------------
    # word -> [[seg_idx, word_pos], ...] in document order; word_pos counts
    # every word of the segment's English as english_words() splits it.
    eng_posts: dict[str, list] = defaultdict(list)
    for seg in segments:
        eng = eng_by_id.get(seg["id"])
        if not eng:
            continue
        si = seg_idx[seg["id"]]
        for pos, word in enumerate(english_words(eng["text"])):
            eng_posts[word].append([si, pos])
    english_idx = dict(eng_posts)

    # -- Segment metadata -----------------------------------------------------
    meta = []
    for seg in segments:
        # Greek head: join first two lines of surface text
        lines = seg["lines"]
        greek_head = " ".join(
            " ".join(t["t"] for t in l["tokens"])
            for l in lines[:2]
        )
        eng = eng_by_id.get(seg["id"])
        english_head = eng["text"][:500] if eng else ""
        meta.append(
            {
                "id": seg["id"],
                "book": seg["book"],
                "column": seg["column"],
                "greek_head": greek_head,
                "english_head": english_head,
            }
        )

    # -- Offset primitive ------------------------------------------------------
    # One running word number per work, assigned in the same document order the
    # index loop above walks. The global offset of any existing posting is
    # seg_base_offset[seg_idx] + token_pos, so no posting has to change and no
    # reverse map is needed. Counts EVERY stage3 token, keyless ones included,
    # so it stays in step with token_pos.
    seg_base_offset: list[int] = []
    seg_coords: list[dict] = []
    running = 0
    for seg in segments:
        seg_base_offset.append(running)
        # line_runs lets the client turn an offset back into a Bekker line
        # without fetching the whole book-NN.json.
        line_runs = [[l["n"], len(l["tokens"])] for l in seg["lines"]]
        running += sum(n for _, n in line_runs)
        seg_coords.append(
            {"book": seg["book"], "column": seg["column"], "line_runs": line_runs}
        )
    token_count = running

    # A segment is keyed (book, column) and so never straddles a book: each
    # book begins at its first segment's base.
    book_bounds: list[dict] = []
    for i, seg in enumerate(segments):
        if not book_bounds or book_bounds[-1]["book"] != seg["book"]:
            book_bounds.append({"book": seg["book"], "start": seg_base_offset[i]})

    # Chapters DO straddle segments, so each bound is resolved down to a token.
    # The spine and the tokens document are parallel line for line (stage7
    # checks it), so a line's text is looked up by POSITION. A number is not a
    # key: a column can carry it twice with no suffix (DA 430b.20's halves
    # around a secluded block) or once plain and again lettered (Phys 244b's
    # 5, 5a), and a chapter anchor names only the number — its wordIndex
    # counts words within whichever of those lines it fell on.
    spine_lines_by_id = {s["id"]: s["lines"] for s in spine["segments"]}
    chapter_bounds: list[dict] = []
    for ch in english.get("chapters", []):
        si = seg_idx.get(f"{ch['book']}:{ch['column']}")
        if si is None:
            continue
        want = int(ch["line"])
        spine_seg = spine_lines_by_id.get(segments[si]["id"], [])
        base = seg_base_offset[si]
        candidates: list[tuple[int, dict, str]] = []
        for j, l in enumerate(segments[si]["lines"]):
            if l["n"] == want:
                text = spine_seg[j]["text"] if j < len(spine_seg) else ""
                candidates.append((base, l, text))
            base += len(l["tokens"])
        if not candidates:
            continue
        # Only the grc-TEI path matches chapter starts against the Greek text
        # (stage1_chapters sets wordAnchor there); the explicit and extra paths
        # know the Bekker line and write wordIndex 0. Without that anchor the
        # bound snaps to the line start, and says so, rather than pretending to
        # token precision it does not have. With one, the anchor still names
        # its line by number alone: if exactly one same-numbered line can hold
        # the count it is exact there; if more than one can, the count cannot
        # be attributed and the bound snaps rather than guess a half.
        start, idx = candidates[0][0], None
        if ch.get("wordAnchor"):
            aligned = [
                (line_base, i)
                for line_base, line, text in candidates
                if (i := remap_word_index(text, line["tokens"], ch["wordIndex"])) is not None
            ]
            if len(aligned) == 1:
                idx = aligned[0][1]
                start = aligned[0][0] + idx
        chapter_bounds.append(
            {
                "book": ch["book"],
                "chapter": ch["chapter"],
                "start": start,
                "accuracy": "exact" if idx is not None else "line-snapped",
            }
        )
    chapter_bounds.sort(key=lambda c: c["start"])

    offsets = {
        # Doubles as a build fingerprint: every artifact indexed by global
        # offset must agree on it, or they were built from different runs.
        "token_count": token_count,
        "seg_base_offset": seg_base_offset,
        "segments": seg_coords,
        "book_bounds": book_bounds,
        "chapter_bounds": chapter_bounds,
    }

    # -- Grammatical index -----------------------------------------------------
    # A signature dictionary plus a packed column, not an inverted index:
    # grammatical predicates are anti-selective (case=gen matches ~10% of every
    # token in the corpus), so postings would go near-dense and dwarf the lexical
    # indexes. Interning readings instead gives a table of a few thousand
    # signatures and one small int per token, indexed by GLOBAL OFFSET — so the
    # column joins directly onto the offset primitive above.
    sig_ids: dict[tuple, int] = {}
    sig_list: list[tuple] = [(), ()]  # slots 0 and 1 are the reserved kinds
    column: list[int] = []
    # The n-gram source, gathered in the same walk. Two fold streams indexed by
    # global offset, keyed exactly as greek_form.json and greek_lemma.json are —
    # so a phrase found here is a phrase the search can find. null marks a token
    # no index can key, which breaks the stream: an n-gram may not span it.
    form_stream: list[str | None] = []
    lemma_stream: list[list[str] | None] = []
    for seg in segments:
        for line in seg["lines"]:
            for tok in line["tokens"]:
                key = tok.get("k")
                form_stream.append(fold_lemma(key) or None if key else None)
                if not key:
                    column.append(SIG_UNKEYED)
                    lemma_stream.append(None)
                    continue
                stored = key_map.get(key)
                entries = analyses.get(stored, []) if stored else []
                # Every lemma this token licenses, not a chosen one: which lemma
                # an ambiguous position contributes is a policy the corpus pass
                # settles, and deciding it here would hide the choice.
                lemmas = sorted({
                    fold_lemma(a["lemma"]) if a["lemma"] else fold_lemma(stored)
                    for a in entries
                } - {""})
                lemma_stream.append(lemmas or None)
                sig = signature(entries)
                if not sig:
                    column.append(SIG_UNANALYSED)
                    continue
                sid = sig_ids.get(sig)
                if sid is None:
                    sid = len(sig_list)
                    sig_ids[sig] = sid
                    sig_list.append(sig)
                column.append(sid)

    # Uint16 covers a few thousand signatures with room to spare; widen rather
    # than silently truncate if a work ever exceeds it.
    width = 4 if len(sig_list) > 0xFFFF else 2
    grammar_dict = {
        "token_count": token_count,  # must match offsets.json — same build
        "width": width,
        "categories": sorted(set(_FEATURES.values())),
        "reserved": {"unkeyed": SIG_UNKEYED, "unanalysed": SIG_UNANALYSED},
        "sigs": [
            [{category: list(values) for category, values in reading} for reading in sig]
            for sig in sig_list
        ],
    }

    streams_check = check_ngram_streams(
        form_stream, lemma_stream, greek_form, greek_lemma, seg_base_offset, token_count
    )
    offsets_check = check_offsets(offsets, segments)
    grammar_check = check_grammar(
        grammar_dict, column, offsets, segments, key_map, analyses, signature
    )
    for name, check in (("offset", offsets_check), ("grammar", grammar_check),
                        ("n-gram stream", streams_check)):
        if not check["ok"]:
            raise ValueError(
                f"stage6: {name} validation failed —\n  "
                + "\n  ".join(check["problems"][:20])
            )

    out_dir = BUILD_DIR / "stage6"
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "offsets.json").write_text(
        json.dumps(offsets, ensure_ascii=False), encoding="utf-8"
    )
    (out_dir / "grammar-dict.json").write_text(
        json.dumps(grammar_dict, ensure_ascii=False), encoding="utf-8"
    )
    (out_dir / "grammar-col.bin").write_bytes(
        struct.pack(f"<{len(column)}{'I' if width == 4 else 'H'}", *column)
    )

    # The n-gram source goes OUTSIDE build/stage6, which is per-work scratch and
    # is overwritten by the next work. The corpus n-gram pass is the pipeline's
    # first cross-work stage and needs every work's stream present at once.
    ngram_dir = BUILD_DIR / "ngrams"
    ngram_dir.mkdir(parents=True, exist_ok=True)
    (ngram_dir / f"{manifest.work_id}.json").write_text(
        json.dumps(
            {
                "work": manifest.work_id,
                # Fingerprint: the corpus pass refuses to merge streams that
                # disagree with the offsets they are supposed to index.
                "token_count": token_count,
                "book_bounds": book_bounds,
                "chapter_bounds": chapter_bounds,
                "form": form_stream,
                "lemma": lemma_stream,
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    (out_dir / "greek_lemma.json").write_text(
        json.dumps(greek_lemma, ensure_ascii=False), encoding="utf-8"
    )
    (out_dir / "greek_form.json").write_text(
        json.dumps(greek_form, ensure_ascii=False), encoding="utf-8"
    )
    (out_dir / "english.json").write_text(
        json.dumps(english_idx, ensure_ascii=False), encoding="utf-8"
    )
    (out_dir / "meta.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8"
    )
    summary = {
        "greek_lemmata": len(greek_lemma),
        "greek_forms": len(greek_form),
        "english_terms": len(english_idx),
        "segments": len(meta),
        "tokens": token_count,
        "chapter_bounds": len(chapter_bounds),
        "chapter_bounds_line_snapped": sum(
            1 for c in chapter_bounds if c["accuracy"] != "exact"
        ),
        "signatures": grammar_check["signatures"],
        "tokens_unanalysed": grammar_check["tokens_unanalysed"],
        "ngram_form_tokens": streams_check["form_tokens"],
        "ngram_multi_lemma": streams_check["multi_lemma_tokens"],
    }
    (out_dir / "summary.json").write_text(json.dumps(summary, indent=1))
    (out_dir / "grammar_report.json").write_text(
        json.dumps({"offsets": offsets_check, "grammar": grammar_check}, indent=1)
    )
    return out_dir
