"""What a stage-3 token's `o` actually is, and who is allowed to rely on it.

`o` is `m.start()` of the RAW whitespace-delimited run, before punctuation and
sigla are stripped from its edges — not the offset of the cleaned surface form.
So for `(λόγος` or `†λόγος†`, `line.text[o:o + len(t)]` is NOT `t`. That is a
live trap: the golden in test_repeated_line_numbers builds its fixture tokens
the other way round (`text.index(word)`), and the one consumer in the pipeline,
stage7_emit._greek_cells, partitions a table row's tokens by comparing `o`
against the ⎪ divider positions.

The reader does not use `o` at all — shared/lib/line-parts.ts re-locates each
token by text search, precisely so it can render the editorial sigla verbatim
around the bare word. Nothing here is broken; the contract just was not written
down anywhere, so a future change to either convention would pass silently.
"""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "pipeline"))

from aristotle_pipeline.stage3_tokenize import tokenize
from aristotle_pipeline.stage7_emit import _greek_cells


def _tokens(text):
    spine = {"work": "TST", "segments": [
        {"id": "1:1a", "book": 1, "column": "1a",
         "lines": [{"n": 1, "text": text}]}]}
    doc, _sigla, _fail = tokenize(spine)
    return doc["segments"][0]["lines"][0]["tokens"]


def test_o_is_the_raw_run_start_not_the_cleaned_word_start():
    text = "καὶ †λόγος† ἐστι"
    toks = _tokens(text)
    assert [t["t"] for t in toks] == ["καὶ", "λόγος", "ἐστι"]
    daggered = toks[1]
    # the raw run "†λόγος†" begins at the dagger …
    assert text[daggered["o"]] == "†"
    # … so the surface form does NOT sit at its own offset
    assert text[daggered["o"]:daggered["o"] + len(daggered["t"])] != daggered["t"]
    # every token's raw run does start where `o` says
    for t in toks:
        assert t["t"] in text[t["o"]:t["o"] + len(t["t"]) + 4]


def test_o_is_a_word_start_for_an_unadorned_token():
    text = "καὶ λόγος ἐστι"
    for t in _tokens(text):
        assert text[t["o"]:t["o"] + len(t["t"])] == t["t"]


def test_greek_cells_partitions_a_table_row_on_the_raw_offsets():
    """The ⎪ divider is both a cell boundary and stripped sigla, so the two
    conventions have to agree for a table row to split correctly."""
    text = "ἀληθές ⎪ ψεῦδος"
    toks = _tokens(text)
    cells = _greek_cells(text, toks)
    assert [c["text"] for c in cells] == ["ἀληθές", "ψεῦδος"]
    assert [[t["t"] for t in c["tokens"]] for c in cells] == [["ἀληθές"], ["ψεῦδος"]]
    # rebased offsets locate inside their own cell
    for c in cells:
        for t in c["tokens"]:
            assert c["text"][t["o"]:t["o"] + len(t["t"])] == t["t"]


def test_a_non_table_line_is_not_split():
    assert _greek_cells("καὶ λόγος", _tokens("καὶ λόγος")) is None
