"""Stage 8: the rules that decide which phrases exist at all.

A phrase excluded here is beyond the reach of any later filter — it was never
indexed — so these tests guard the exclusions specifically: book edges, keyless
tokens, the recurrence rule, and the lemma readings that must NOT be narrowed.
"""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "pipeline"))

from aristotle_pipeline.stage8_ngrams import _phrases, _readings  # noqa: E402


def grams(stream, books, total, n=None):
    """{phrase: [offsets]} for a stream of option-lists."""
    out = {}
    for gram, at in _phrases(stream, books, total):
        if n is None or len(gram.split(" ")) == n:
            out.setdefault(gram, []).append(at)
    return out


def one(*words):
    """A stream of unambiguous positions."""
    return [[w] for w in words]


class TestBoundaries:
    def test_a_phrase_never_spans_a_book_edge(self):
        # Book 1 is offsets 0-2, book 2 is 3-5.
        stream = one("a", "b", "c", "d", "e", "f")
        found = grams(stream, [0, 3], 6, n=2)
        assert "b c" in found          # inside book 1
        assert "d e" in found          # inside book 2
        assert "c d" not in found      # across the edge

    def test_a_phrase_never_spans_a_keyless_token(self):
        stream = one("a", "b") + [None] + one("c", "d")
        found = grams(stream, [0], 5, n=2)
        assert "a b" in found
        assert "c d" in found
        assert "b c" not in found      # the gap breaks the stream
        assert not any(g for g in grams(stream, [0], 5, n=3) if g.startswith("b"))

    def test_offsets_are_the_phrase_start(self):
        stream = one("a", "b", "c")
        assert grams(stream, [0], 3, n=2) == {"a b": [0], "b c": [1]}

    def test_every_length_from_two_to_five(self):
        stream = one(*"abcdef")
        lengths = {len(g.split(" ")) for g in grams(stream, [0], 6)}
        assert lengths == {2, 3, 4, 5}


class TestLemmaReadings:
    def test_an_ambiguous_position_contributes_every_reading(self):
        # The second position licenses two lemmas; both phrases must exist.
        stream = [["a"], ["b", "c"]]
        assert set(grams(stream, [0], 2, n=2)) == {"a b", "a c"}

    def test_readings_multiply_across_positions(self):
        stream = [["a", "b"], ["c", "d"]]
        assert set(grams(stream, [0], 2, n=2)) == {"a c", "a d", "b c", "b d"}

    def test_readings_of_an_unambiguous_window_is_one_phrase(self):
        assert _readings([["a"], ["b"]]) == [["a", "b"]]

    def test_every_reading_shares_the_one_offset(self):
        stream = [["a"], ["b", "c"]]
        found = grams(stream, [0], 2, n=2)
        assert found["a b"] == [0] and found["a c"] == [0]


class TestEnglishStream:
    def test_tokenizes_the_translation_the_way_stage6_indexes_it(self, tmp_path, monkeypatch):
        """english-segments.json offsets count words; stage6's english.json
        keys them. Both must split the same text into the same words — the
        archive translations print possessives with U+2019, which the old
        [a-z']+ scan broke into "aristotle" + "s"."""
        import json
        from aristotle_pipeline import stage8_ngrams

        work = tmp_path / "build" / "dist" / "TST"
        work.mkdir(parents=True)
        (work / "book-01.json").write_text(json.dumps({"book": 1, "segments": [
            {"id": "1:244b", "column": "244b",
             "english": {"text": "Aristotle’s first ‘change’ isn’t the last."}},
        ]}), encoding="utf-8")
        monkeypatch.setattr(stage8_ngrams, "BUILD_DIR", tmp_path / "build")
        stream, bounds, segments = stage8_ngrams._english_stream("TST")
        assert stream == [["aristotle's"], ["first"], ["change"], ["isn't"], ["the"], ["last"]]
        assert bounds == [0]
        assert segments == [{"book": 1, "column": "244b", "base": 0, "words": 6}]
