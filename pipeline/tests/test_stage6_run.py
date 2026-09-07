"""Stage 6 end to end on a synthetic build, pinning what the reader joins on.

shared/lib/search.ts consumes these files by POSITION, not by name: a posting
is (seg_idx, token_pos), its global offset is seg_base_offset[seg_idx] + pos,
and offsetRef() walks line_runs to name the Bekker line. meta.json's
english_head is what the English phrase check reads first. Each test here
builds the smallest corpus that exercises one seam and reads the emitted
files back the way the reader would.
"""

import json
import re
import sys
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "pipeline"))

from aristotle_pipeline import stage6_search  # noqa: E402
from aristotle_pipeline.beta import to_beta_key  # noqa: E402
from aristotle_pipeline.stage3_tokenize import tokenize  # noqa: E402
from aristotle_pipeline.stage6_search import fold_lemma  # noqa: E402


class _Manifest:
    work_id = "TST"


# Physics 244b as Ross prints it (lettered 5a between 5 and 6) and DA 430b.20
# as the OCT sets it (the plain number 20 twice around a secluded block), then
# a second book so book_bounds has an edge to find.
_SPINE = {
    "work": "TST",
    "segments": [
        {"id": "1:244b", "book": 1, "column": "244b", "lines": [
            {"n": 4, "text": "ἅπασι γὰρ"},
            {"n": 5, "text": "τὸ πρῶτον ἀλλοιούμενον"},
            {"n": 5, "sub": "a", "text": "ὑπόκειται γὰρ"},
            {"n": 6, "text": "εἰρημένων ταῦτα"},
        ]},
        {"id": "1:245a", "book": 1, "column": "245a", "lines": [
            {"n": 20, "text": "καὶ χρόνῳ καὶ μήκει."},
            {"n": 20, "text": "ἡ δὲ στιγμὴ"},
        ]},
        {"id": "2:245b", "book": 2, "column": "245b", "lines": [
            {"n": 1, "text": "Σωκράτης ᾠδῇ προϊέναι"},
        ]},
    ],
}

_LONG_ENGLISH = ("The point and every division " * 30).strip()  # > 500 chars


def _english(chapters):
    return {
        "chunks": [
            {"id": "1:244b", "book": 1, "column": "244b",
             "text": "Aristotle’s first ‘change’ isn’t the last.",
             "notes": [], "markers": []},
            {"id": "1:245a", "book": 1, "column": "245a",
             "text": _LONG_ENGLISH, "notes": [], "markers": []},
        ],
        "chapters": chapters,
    }


def _build(tmp_path, monkeypatch, chapters=()):
    build = tmp_path / "build"
    (build / "stage1").mkdir(parents=True)
    (build / "stage3").mkdir()
    (build / "stage4").mkdir()
    tokens, _, failures = tokenize(_SPINE)
    assert not failures, failures
    keys = sorted({t["k"] for s in tokens["segments"] for l in s["lines"] for t in l["tokens"]})
    key_map = {k: k for k in keys}
    # Morpheus-style analyses for a few tokens; the rest stay unanalysed.
    analyses = {
        "ga/r": [{"lemma": "ga/r", "gloss": "for", "parse": "conj"}],
        "kai/": [{"lemma": "kai/", "gloss": "and", "parse": "conj"}],
        "to/": [{"lemma": "o(", "gloss": "the", "parse": "neut nom/acc sg"}],
    }
    (build / "stage1" / "greek_spine.json").write_text(
        json.dumps(_SPINE, ensure_ascii=False), encoding="utf-8")
    (build / "stage1" / "english_chunks.json").write_text(
        json.dumps(_english(list(chapters)), ensure_ascii=False), encoding="utf-8")
    (build / "stage3" / "tokens.json").write_text(
        json.dumps(tokens, ensure_ascii=False), encoding="utf-8")
    (build / "stage4" / "key_map.json").write_text(json.dumps(key_map), encoding="utf-8")
    (build / "stage4" / "analyses.json").write_text(
        json.dumps(analyses, ensure_ascii=False), encoding="utf-8")
    monkeypatch.setattr(stage6_search, "BUILD_DIR", build)
    out = stage6_search.run(_Manifest())
    load = lambda name: json.loads((out / name).read_text(encoding="utf-8"))  # noqa: E731
    return {
        "offsets": load("offsets.json"),
        "meta": load("meta.json"),
        "english": load("english.json"),
        "form": load("greek_form.json"),
        "lemma": load("greek_lemma.json"),
        "ngrams": json.loads((build / "ngrams" / "TST.json").read_text(encoding="utf-8")),
        "tokens": tokens,
    }


# -- The offset primitive ----------------------------------------------------

def test_line_runs_follow_stage3_lines_one_run_per_line(tmp_path, monkeypatch):
    """One run per stage3 line, lettered and repeated lines included, so that
    offsetRef() walking the runs lands on the same line stage7 emits at that
    position. A lettered line carries its suffix as a third element, so a
    token on 244b5a is cited as 244b5a and not as 244b5; a repeated bare
    number (DA 430b.20 twice) still has none to carry."""
    offsets = _build(tmp_path, monkeypatch)["offsets"]
    runs = [s["line_runs"] for s in offsets["segments"]]
    assert runs[0] == [[4, 2], [5, 3], [5, 2, "a"], [6, 2]]
    assert runs[1] == [[20, 4], [20, 3]]
    assert runs[2] == [[1, 3]]


def test_seg_base_offset_is_the_running_token_count(tmp_path, monkeypatch):
    got = _build(tmp_path, monkeypatch)
    offsets = got["offsets"]
    assert offsets["seg_base_offset"] == [0, 9, 16]
    assert offsets["token_count"] == 19
    assert offsets["book_bounds"] == [{"book": 1, "start": 0}, {"book": 2, "start": 16}]
    # Every posting resolves to the token it names through base + pos.
    stream = [t for s in got["tokens"]["segments"] for l in s["lines"] for t in l["tokens"]]
    for key, posts in got["form"].items():
        for si, pos in posts:
            assert fold_lemma(stream[offsets["seg_base_offset"][si] + pos]["k"]) == key


def test_ngram_stream_shares_the_offset_space(tmp_path, monkeypatch):
    got = _build(tmp_path, monkeypatch)
    ng = got["ngrams"]
    assert ng["token_count"] == got["offsets"]["token_count"]
    assert len(ng["form"]) == len(ng["lemma"]) == ng["token_count"]
    assert ng["book_bounds"] == got["offsets"]["book_bounds"]


# -- Chapter bounds ----------------------------------------------------------

def _chapters(**second):
    return [
        {"book": 1, "chapter": "1", "column": "244b", "line": "4",
         "wordIndex": 0, "bookstart": True},
        {"chapter": "2", "wordAnchor": True, "bookstart": False, **second},
    ]


def test_chapter_bound_on_a_repeated_line_number_is_exact(tmp_path, monkeypatch):
    """A chapter anchored by word index onto a line whose number the column
    carries twice (DA 430b.20's halves around a secluded block) resolves to
    the token on the half that can hold the count.

    stage6 used to look the line's text up by (column, n), which for a
    repeated number returns the LAST such line — while its token walk stopped
    at the FIRST. The two never aligned, so the bound always fell back to
    line-snapped and said nothing better was known. The lookup is positional
    now: the spine and the tokens document are parallel line for line.
    """
    # "μήκει" is word 3 of the first line numbered 20; the second half has
    # only three words, so the count can belong to one line only.
    chapters = _chapters(book=1, column="245a", line="20", wordIndex=3)
    offsets = _build(tmp_path, monkeypatch, chapters)["offsets"]
    by_chapter = {c["chapter"]: c for c in offsets["chapter_bounds"]}
    assert by_chapter["2"] == {
        "book": 1, "chapter": "2", "start": 9 + 3, "accuracy": "exact"}


def test_chapter_bound_on_a_plain_line_shadowed_by_a_lettered_one_is_exact(
        tmp_path, monkeypatch):
    """Phys 244b prints 5 then 5a; both carry n=5. "ἀλλοιούμενον" is word 2 of
    plain 5, and 5a has only two words, so the anchor is unambiguous."""
    chapters = _chapters(book=1, column="244b", line="5", wordIndex=2)
    offsets = _build(tmp_path, monkeypatch, chapters)["offsets"]
    by_chapter = {c["chapter"]: c for c in offsets["chapter_bounds"]}
    assert by_chapter["2"] == {
        "book": 1, "chapter": "2", "start": 2 + 2, "accuracy": "exact"}


def test_chapter_bound_that_two_same_numbered_lines_could_hold_snaps_and_says_so(
        tmp_path, monkeypatch):
    """stage1_chapters records an anchor as (column, n, word-within-line) and
    nothing says WHICH same-numbered line the word was counted on. Word 1
    exists on both halves of 245a.20, so the count cannot be attributed: the
    bound snaps to the first half's start and is flagged line-snapped rather
    than claiming token precision on a guessed half."""
    chapters = _chapters(book=1, column="245a", line="20", wordIndex=1)
    offsets = _build(tmp_path, monkeypatch, chapters)["offsets"]
    by_chapter = {c["chapter"]: c for c in offsets["chapter_bounds"]}
    assert by_chapter["2"] == {
        "book": 1, "chapter": "2", "start": 9, "accuracy": "line-snapped"}


def test_chapter_bound_without_a_word_anchor_snaps_to_the_line_and_says_so(
        tmp_path, monkeypatch):
    chapters = [
        {"book": 1, "chapter": "1", "column": "244b", "line": "4",
         "wordIndex": 0, "bookstart": True},
        {"book": 1, "chapter": "2", "column": "244b", "line": "6",
         "wordIndex": 1, "bookstart": False},
    ]
    offsets = _build(tmp_path, monkeypatch, chapters)["offsets"]
    by_chapter = {c["chapter"]: c for c in offsets["chapter_bounds"]}
    assert by_chapter["2"] == {
        "book": 1, "chapter": "2", "start": 7, "accuracy": "line-snapped"}


# -- English index and heads -------------------------------------------------

def test_english_index_keeps_a_curly_possessive_as_one_word(tmp_path, monkeypatch):
    """The archive translations print Aristotle’s with U+2019. The reader
    folds a typed straight apostrophe to itself and, in its phrase check,
    folds the text's curly one to straight — so the index has to key the
    possessive as one word, "aristotle's", for either path to find it.
    Splitting it into "aristotle" + "s" (the old [a-z']+ scan) made every
    possessive unfindable and put a bare "s" in every such segment."""
    english = _build(tmp_path, monkeypatch)["english"]
    # Postings carry the word's position: "Aristotle’s first ‘change’ isn’t
    # the last." is aristotle's(0) first(1) change(2) isn't(3) the(4) last(5),
    # so the reader can test a phrase by adjacency, as it does for Greek.
    assert english["aristotle's"] == [[0, 0]]
    assert english["isn't"] == [[0, 3]]
    assert "s" not in english and "t" not in english
    # Opening quotes are punctuation, not apostrophes: ‘change’ is "change".
    assert english["change"] == [[0, 2]]


def test_english_words_matches_the_readers_fold():
    """Mirror of englishFold()/engPhraseMatches() in shared/lib/search.ts:
    lowercase, U+2019 and U+02BC become ', anything outside [a-z'] splits."""
    from aristotle_pipeline.stage6_search import english_words

    assert english_words("Aristotle’s ‘good’ isnʼt—well") == [
        "aristotle's", "good", "isn't", "well"]


def test_english_head_is_cut_at_the_readers_limit(tmp_path, monkeypatch):
    """search.ts falls back to the book text only when the head is AT the cut
    (head.length >= ENGLISH_HEAD_LIMIT). A shorter cut here would hide every
    phrase past it; a longer one is merely wasted bytes. Pin both sides."""
    meta = _build(tmp_path, monkeypatch)["meta"]
    head = meta[1]["english_head"]
    assert len(head) == 500 and _LONG_ENGLISH.startswith(head)
    assert meta[0]["english_head"] == "Aristotle’s first ‘change’ isn’t the last."
    assert meta[2]["english_head"] == ""
    search_ts = (ROOT / "shared" / "lib" / "search.ts").read_text(encoding="utf-8")
    m = re.search(r"export const ENGLISH_HEAD_LIMIT = (\d+);", search_ts)
    assert m and int(m.group(1)) == 500


# -- Greek index keys --------------------------------------------------------

_GREEK_BETA = {
    "α": "a", "β": "b", "γ": "g", "δ": "d", "ε": "e", "ζ": "z", "η": "h",
    "θ": "q", "ι": "i", "κ": "k", "λ": "l", "μ": "m", "ν": "n", "ξ": "c",
    "ο": "o", "π": "p", "ρ": "r", "σ": "s", "ς": "s", "τ": "t", "υ": "u",
    "φ": "f", "χ": "x", "ψ": "y", "ω": "w", "ϝ": "v",
}


def _reader_fold(text: str) -> str:
    """Line-for-line port of greekFold() in shared/lib/search.ts."""
    out = []
    for ch in unicodedata.normalize("NFD", text):
        low = ch.lower()
        if low in _GREEK_BETA:
            out.append(_GREEK_BETA[low])
        elif "a" <= low <= "z":
            out.append(low)
        elif ch == "'":
            out.append("'")
    return "".join(out)


def test_index_keys_are_what_the_reader_folds_a_query_to(tmp_path, monkeypatch):
    """greek_form.json is keyed by fold_lemma(beta key); the reader keys a
    query by greekFold(unicode). They are two implementations of one fold and
    must agree on every surface form in the corpus — capitals, final sigma,
    iota subscript, diaeresis, digamma, elision — or a typed word misses."""
    got = _build(tmp_path, monkeypatch)
    surfaces = [t["t"] for s in got["tokens"]["segments"] for l in s["lines"] for t in l["tokens"]]
    for surface in surfaces + ["Ϝάναξ", "δ’", "δ᾽", "ᾠδῇ", "προϊέναι", "Σωκράτης"]:
        # The text elides with U+2019/U+1FBD; beta.py keys those as a straight
        # apostrophe, and greekFold() keeps only a straight one — so the
        # contract holds for the form a reader types. (A curly apostrophe
        # pasted from the page folds to "d", not "d'", on the reader side.)
        typed = surface.replace("’", "'").replace("᾽", "'")
        assert fold_lemma(to_beta_key(surface)) == _reader_fold(typed), surface
    assert {"apasi", "swkraths", "wdh", "proienai"} <= set(got["form"])


def test_index_keys_do_not_depend_on_unicode_normalization_form():
    for word in ("ἅπασι", "ᾠδῇ", "προϊέναι", "Σωκράτης"):
        nfc, nfd = unicodedata.normalize("NFC", word), unicodedata.normalize("NFD", word)
        assert nfc != nfd
        assert fold_lemma(to_beta_key(nfc)) == fold_lemma(to_beta_key(nfd))


def test_lemma_index_is_keyed_by_folded_headword(tmp_path, monkeypatch):
    got = _build(tmp_path, monkeypatch)
    # "τὸ" is analysed to the article o(; the token has no posting under "to".
    assert got["lemma"]["o"] == [[0, 2]]
    assert "to" not in got["lemma"]
    assert got["form"]["to"] == [[0, 2]]
    # γὰρ occurs on 244b4 and 244b5a: both postings, in document order.
    assert got["lemma"]["gar"] == [[0, 1], [0, 6]]
