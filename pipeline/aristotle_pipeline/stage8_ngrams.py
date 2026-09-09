"""Stage 8: recurrent phrases across the whole corpus.

The pipeline's first CROSS-WORK stage. Every other stage builds one manifest per
invocation, but a phrase that appears once in the Physics and once in the
Metaphysics recurs in Aristotle and is exactly the kind a reader wants; deciding
that needs all the works at once. Stage 6 leaves each work's fold streams in
build/ngrams/<work>.json; this merges them.

Sharded by the phrase's fold-initial letter — the pattern the LSJ and the lemma
picker already use — and split again by what a reader actually needs when. The
browse list needs every phrase; only an EXPANDED phrase needs its offsets, and
keeping the two together made one shard 10.4 MB, which defeats the point of
sharding at all.

  build/dist/ngrams/<stream>/<letter>.json          the browse list
      { "<fold phrase>": [n, count, score, works] }

  build/dist/ngrams/<stream>/occ/<letter>-<n>.json  fetched on expand
      { "<fold phrase>": { "EN": [1204, 88, 310], "Meta": [90211] } }

Occurrences are per-work global offsets, delta-encoded after the first. The work
map doubles as the per-work breakdown, so a reader can be told "37 times across
5 works" from the browse list alone, without loading a single offset.

Rules, none of them re-derived here:
  * A phrase never spans a BOOK edge. Book bounds come from the same
    offsets.json the search uses.
  * A phrase never spans a token no index can key (a stage 3 key failure).
  * A phrase is kept only if it occurs at least twice CORPUS-WIDE.
  * Chapter straddling is NOT filtered at build time. It is a query-time toggle
    defaulting to keep, and dropping the occurrences here would make the toggle
    unimplementable. Each phrase records how many of its occurrences cross a
    chapter so the UI can say so.

Also emits build/dist/lemma-map/<letter>.json — fold(surface) -> the headwords
that surface can belong to. Not an n-gram artifact, but it needs the same
corpus-wide pass, and it is what lets a typed phrase be widened to its inflected
variants without the reader knowing any headwords.

Both streams are indexed: `form` (the surface word as written) and `lemma`. A
position licensing several lemmas contributes EVERY reading, not a chosen one —
excluding a reading here would put it beyond the reach of any later filter.
"""

from __future__ import annotations

import json
import math
from collections import Counter, defaultdict
from pathlib import Path

from .config import BUILD_DIR
from .stage6_search import english_words

NS = (2, 3, 4, 5)
MIN_COUNT = 2          # corpus-wide; the whole point of a cross-work stage
GREEK_STREAMS = ("form", "lemma")
# The translations are indexed too. Everything past ingestion is stream-agnostic
# — counting, scoring, sharding and the occurrence files do not care which
# language they hold — so English joins as a third stream rather than a second
# system. What differs is where the tokens come from (the emitted books, not
# stage 6's fold streams) and what bounds a phrase (a segment, not a book).
ENGLISH_STREAM = "english"
STREAMS = (*GREEK_STREAMS, ENGLISH_STREAM)


def _shard_letter(phrase: str) -> str:
    first = phrase[0] if phrase else ""
    return first if "a" <= first <= "z" else "_"


def _readings(entry, limit: int = 0):
    """Every phrase a window of positions licenses, not a chosen one.

    19% of positions license more than one lemma. Picking one would make the
    other readings unfindable — and unlike a ranking, no later filter could
    recover them, because the phrase would never have been indexed. Expanding
    every combination costs 2.15x the n-gram occurrences measured corpus-wide,
    and the recurrence rule then prunes most of the exotic readings, since a
    phrase built from an unlikely lemma usually occurs once.
    """
    combos = [[]]
    for options in entry:
        combos = [c + [o] for c in combos for o in options]
        if limit and len(combos) > limit:
            return combos[:limit]
    return combos


def _phrases(stream: list, books: list[int], total: int):
    """Yield (gram, offset) for every n-gram that respects the boundaries.

    `stream` holds one LIST of options per position — a single item for the
    surface form, one or more lemmas where a token is ambiguous.
    """
    edges = books + [total]
    for b in range(len(edges) - 1):
        lo, hi = edges[b], edges[b + 1]
        for n in NS:
            for i in range(lo, hi - n + 1):
                window = stream[i:i + n]
                if any(o is None for o in window):
                    continue
                for reading in _readings(window):
                    yield " ".join(reading), i


def _english_stream(work: str) -> tuple[list[list[str]], list[int], list[dict]]:
    """One work's English as a token stream, with the segment bounds it obeys.

    Returns (stream, bounds, segments). `stream` is one list per position so it
    can go through _phrases unchanged — English carries a single reading, where
    the Greek lemma stream may carry several. `bounds` are the offsets a phrase
    may not cross: a segment, not a book, because the translation is aligned and
    stored one block per segment and a phrase running from the end of one into
    the start of the next would join two passages that are not adjacent prose.
    `segments` is what turns an offset back into a citation.
    """
    stream: list[list[str]] = []
    bounds: list[int] = []
    segments: list[dict] = []
    work_dir = BUILD_DIR / "dist" / work
    for book_path in sorted(work_dir.glob("book-*.json")):
        book = json.loads(book_path.read_text(encoding="utf-8"))
        for seg in book.get("segments", []):
            text = (seg.get("english") or {}).get("text") or ""
            # Split exactly as stage6 keys english.json, so a phrase found
            # here is one the search can find (and offsets count the same
            # words that the index does).
            words = english_words(text)
            if not words:
                continue
            bounds.append(len(stream))
            segments.append({
                "book": book.get("book"),
                "column": seg.get("column"),
                "base": len(stream),
                "words": len(words),
            })
            stream.extend([w] for w in words)
    return stream, bounds, segments


def run() -> Path:
    source = BUILD_DIR / "ngrams"
    files = sorted(source.glob("*.json"))
    if not files:
        raise ValueError(
            "stage8: no per-work streams in build/ngrams — run stage6 for every work first"
        )

    # fold(surface) -> the headwords that surface can belong to. Small (about
    # 200 KB gzipped) and a by-product of the streams, but it is what lets a
    # reader widen a typed phrase to its inflected variants without knowing any
    # headwords — the barrier that otherwise makes the lemma index unusable to
    # anyone not already thinking in dictionary forms.
    surface_lemmas: dict[str, set] = defaultdict(set)
    counts: dict[str, Counter] = {s: Counter() for s in STREAMS}
    offsets: dict[str, dict[str, dict[str, list[int]]]] = {
        s: defaultdict(lambda: defaultdict(list)) for s in STREAMS
    }
    straddles: dict[str, Counter] = {s: Counter() for s in STREAMS}
    unigrams: dict[str, Counter] = {s: Counter() for s in STREAMS}
    tokens: dict[str, int] = {s: 0 for s in STREAMS}
    works: list[str] = []
    # offset -> citation for the English stream, the counterpart of the Greek
    # offsets.json the reader already fetches.
    english_segments: dict[str, list[dict]] = {}

    for path in files:
        doc = json.loads(path.read_text(encoding="utf-8"))
        work, total = doc["work"], doc["token_count"]
        works.append(work)
        if len(doc["form"]) != total or len(doc["lemma"]) != total:
            raise ValueError(
                f"stage8: {work} stream length disagrees with its token_count "
                f"({len(doc['form'])}/{len(doc['lemma'])} vs {total}) — stale build"
            )
        books = [b["start"] for b in doc["book_bounds"]]
        chapters = {c["start"] for c in doc["chapter_bounds"]}
        for surface, lemmas in zip(doc["form"], doc["lemma"]):
            if surface and lemmas:
                surface_lemmas[surface].update(lemmas)

        for stream_name in GREEK_STREAMS:
            # One list of options per position, so both streams n-gram the
            # same way: the form stream simply never has more than one.
            raw = doc[stream_name]
            stream = [
                None if e is None else ([e] if isinstance(e, str) else e)
                for e in raw
            ]
            for options in stream:
                if not options:
                    continue
                # Counted per licensed reading, matching how the phrases are
                # built, so the score's independence baseline is consistent.
                for token in options:
                    unigrams[stream_name][token] += 1
                    tokens[stream_name] += 1
            for gram, at in _phrases(stream, books, total):
                counts[stream_name][gram] += 1
                offsets[stream_name][gram][work].append(at)
                if any(x in chapters for x in range(at + 1, at + gram.count(" ") + 1)):
                    straddles[stream_name][gram] += 1

        # English, from the emitted books rather than stage 6's fold streams.
        eng_stream, eng_bounds, eng_segments = _english_stream(work)
        if eng_stream:
            english_segments[work] = eng_segments
            for options in eng_stream:
                unigrams[ENGLISH_STREAM][options[0]] += 1
                tokens[ENGLISH_STREAM] += 1
            # Segment bounds stand in for book bounds: _phrases never lets a
            # window cross one. Chapter straddling is not recorded — the English
            # is stored per segment, so a phrase cannot straddle anything the
            # reader would care about.
            for gram, at in _phrases(eng_stream, eng_bounds, len(eng_stream)):
                counts[ENGLISH_STREAM][gram] += 1
                offsets[ENGLISH_STREAM][gram][work].append(at)

    summary: dict = {"works": len(works), "streams": {}}
    out_root = BUILD_DIR / "dist" / "ngrams"
    for stream_name in STREAMS:
        kept = {g: c for g, c in counts[stream_name].items() if c >= MIN_COUNT}
        total_tokens = tokens[stream_name]
        shards: dict[str, dict] = defaultdict(dict)
        occ_shards: dict[tuple, dict] = defaultdict(dict)
        for gram, count in kept.items():
            words = gram.split(" ")
            # Frequency-weighted pointwise mutual information: how much more
            # often the phrase occurs than independent words would predict,
            # weighted by how often it actually occurs so that a pair of rare
            # words meeting twice does not outrank a real formula. Generalises
            # to any n, unlike the 2x2 log-likelihood ratio.
            expected = total_tokens
            for word in words:
                expected *= unigrams[stream_name][word] / total_tokens
            score = count * math.log2(count / expected) if expected > 0 else 0.0
            per_work = {}
            for work, at in offsets[stream_name][gram].items():
                at.sort()
                per_work[work] = [at[0]] + [at[i] - at[i - 1] for i in range(1, len(at))]
            letter = _shard_letter(gram)
            n = len(words)
            # Browse row, positional to keep the list small: length, corpus
            # count, score, how many works, and how many occurrences straddle a
            # chapter (the query-time toggle needs to be able to say so).
            row = [n, count, round(score, 1), len(per_work)]
            straddle = straddles[stream_name][gram]
            if straddle:
                row.append(straddle)
            shards[letter][gram] = row
            occ_shards[(letter, n)][gram] = per_work

        out_dir = out_root / stream_name
        occ_dir = out_dir / "occ"
        occ_dir.mkdir(parents=True, exist_ok=True)
        for existing in list(out_dir.glob("*.json")) + list(occ_dir.glob("*.json")):
            existing.unlink()
        for letter, data in shards.items():
            (out_dir / f"{letter}.json").write_text(
                json.dumps(data, ensure_ascii=False), encoding="utf-8"
            )
        for (letter, n), data in occ_shards.items():
            (occ_dir / f"{letter}-{n}.json").write_text(
                json.dumps(data, ensure_ascii=False), encoding="utf-8"
            )
        by_n = Counter(len(g.split(" ")) for g in kept)
        summary["streams"][stream_name] = {
            "distinct": len(counts[stream_name]),
            "kept": len(kept),
            "occurrences": sum(kept.values()),
            "shards": len(shards),
            "by_n": {str(n): by_n[n] for n in NS},
        }

    # What an English occurrence offset means. One corpus-wide file rather than
    # one per work: it is small, and a reader browsing English phrases crosses
    # works constantly.
    (out_root / "english-segments.json").write_text(
        json.dumps(english_segments, ensure_ascii=False), encoding="utf-8"
    )
    summary["english_works"] = len(english_segments)

    # Sharded by fold-initial letter, like every other index here.
    map_dir = BUILD_DIR / "dist" / "lemma-map"
    map_dir.mkdir(parents=True, exist_ok=True)
    for existing in map_dir.glob("*.json"):
        existing.unlink()
    map_shards: dict[str, dict] = defaultdict(dict)
    for surface, lemmas in surface_lemmas.items():
        map_shards[_shard_letter(surface)][surface] = sorted(lemmas)
    for letter, data in map_shards.items():
        (map_dir / f"{letter}.json").write_text(
            json.dumps(data, ensure_ascii=False), encoding="utf-8"
        )
    summary["surface_forms"] = len(surface_lemmas)
    summary["surface_forms_ambiguous"] = sum(
        1 for v in surface_lemmas.values() if len(v) > 1
    )

    (out_root / "summary.json").write_text(json.dumps(summary, indent=1), encoding="utf-8")
    return out_root
