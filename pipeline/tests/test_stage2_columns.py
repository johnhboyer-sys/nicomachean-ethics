"""Stage 2's column-completeness check, for the two shapes of citation scheme.

A Bekker work is checked against `column_range(first, last)` — a real expected
set. A busse work (Porphyry's Isagoge, whose Busse CAG pages become synthetic
a-side-only columns "1a".."22a") took `expected = list(seen_cols)`, i.e. the
spine's own columns. `set(expected) - set(seen_cols)` and its converse are then
empty by construction: the check reported "22/22 columns, missing none" no
matter what the Diogenes export contained. A dropped Busse page — the one
failure column completeness exists to catch — passed.

The a/b pairing genuinely does not apply (that is why the Bekker range was not
usable), but the manifest still declares first_column/last_column, so the
a-side pages between them are a real expected set.

Also pinned here: the proper-name spot check looked its columns up with
`expected.index(col)`, which raises rather than reports when a column falls
outside the declared range.
"""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "pipeline"))

from aristotle_pipeline.stage2_validate import validate


class _BusseManifest:
    first_column = "1a"
    last_column = "3a"
    books = [{"n": 1, "start": "1a1", "end": "3a9"}]
    data = {
        "work": {"id": "ISA"},
        "citation": {"scheme": "busse"},
        "bekker_range": {"first_column": "1a", "last_column": "3a"},
        "books": books,
        "proper_names": [],
    }


def _seg(col, texts):
    return {"id": f"1:{col}", "book": 1, "column": col,
            "lines": [{"n": i + 1, "text": t} for i, t in enumerate(texts)]}


def _english(cols):
    return {"chunks": [{"id": f"1:{c}", "book": 1, "column": c,
                        "text": "some english prose here",
                        "markers": [], "bekker": []} for c in cols],
            "chapters": []}


def _alignment(cols):
    return {"pairs": [{"segment": f"1:{c}", "english": f"1:{c}"} for c in cols],
            "english_only": []}


def _run(cols):
    spine = {"work": "ISA", "segments": [_seg(c, ["αβγ", "δεζ"]) for c in cols]}
    return validate(_BusseManifest(), spine, _english(cols), _alignment(cols))


def test_a_complete_busse_spine_passes():
    report = _run(["1a", "2a", "3a"])
    cols = report["checks"]["columns"]
    assert cols["ok"] is True
    assert cols == {"expected": 3, "found": 3, "missing": [], "extra": [],
                    "monotonic": True, "ok": True}


def test_a_dropped_busse_page_is_reported_missing():
    report = _run(["1a", "3a"])
    cols = report["checks"]["columns"]
    assert cols["missing"] == ["2a"], cols
    assert cols["ok"] is False


def test_a_busse_page_outside_the_declared_range_is_extra():
    report = _run(["1a", "2a", "3a", "4a"])
    cols = report["checks"]["columns"]
    assert cols["extra"] == ["4a"]
    assert cols["ok"] is False


class _NameManifest:
    first_column = "1094a"
    last_column = "1094b"
    books = [{"n": 1, "start": "1094a1", "end": "1094b2"}]
    data = {
        "work": {"id": "TST"},
        "bekker_range": {"first_column": "1094a", "last_column": "1094b"},
        "books": books,
        "proper_names": [["πλατων", "Plato"]],
    }


def test_a_name_in_a_column_outside_the_range_is_reported_not_raised():
    """An English chunk keyed to a column the manifest's Bekker range does not
    cover is a data defect the report must name. Looking the column up with
    `list.index` turned it into a ValueError out of validate(), so stage 2
    crashed instead of writing its report."""
    spine = {"work": "TST", "segments": [
        _seg("1094a", ["πλατων λεγει"]),
        _seg("1094b", ["και ετι"]),
    ]}
    english = {
        "chunks": [
            {"id": "1:1094a", "book": 1, "column": "1094a",
             "text": "Plato says", "markers": [], "bekker": []},
            {"id": "1:1094b", "book": 1, "column": "1094b",
             "text": "and further", "markers": [], "bekker": []},
            # outside first_column..last_column
            {"id": "1:1099a", "book": 1, "column": "1099a",
             "text": "Plato again", "markers": [], "bekker": []},
        ],
        "chapters": [],
    }
    alignment = {"pairs": [{"segment": "1:1094a", "english": "1:1094a"},
                           {"segment": "1:1094b", "english": "1:1094b"}],
                 "english_only": ["1:1099a"]}

    report = validate(_NameManifest(), spine, english, alignment)

    names = report["checks"]["proper_names"]["names"][0]
    assert names["english_without_greek"] == ["1099a"]
    assert report["checks"]["proper_names"]["ok"] is False


def test_length_ratio_survives_a_single_aligned_column():
    """statistics.stdev needs two data points. A work (or a partial build) whose
    English aligns to one column made validate() raise StatisticsError, so the
    gate crashed instead of writing the report that names the real problem —
    here, the unmatched second segment."""
    spine = {"work": "TST", "segments": [
        _seg("1094a", ["αβγ"]),
        _seg("1094b", ["δεζ"]),
    ]}
    english = {"chunks": [{"id": "1:1094a", "book": 1, "column": "1094a",
                           "text": "only this column", "markers": [],
                           "bekker": []}],
               "chapters": []}
    alignment = {"pairs": [{"segment": "1:1094a", "english": "1:1094a"},
                           {"segment": "1:1094b", "english": None}],
                 "english_only": []}

    report = validate(_NameManifest(), spine, english, alignment)

    lr = report["checks"]["length_ratio"]
    assert lr["ok"] is True and lr["outliers"] == []
    assert report["checks"]["alignment"]["unexpected_unmatched"] == ["1:1094b"]


def test_length_ratio_survives_no_aligned_columns():
    spine = {"work": "TST", "segments": [_seg("1094a", ["αβγ"])]}
    english = {"chunks": [], "chapters": []}
    alignment = {"pairs": [{"segment": "1:1094a", "english": None}],
                 "english_only": []}

    report = validate(_NameManifest(), spine, english, alignment)
    assert report["checks"]["length_ratio"]["outliers"] == []
