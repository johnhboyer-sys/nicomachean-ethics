"""A real Bekker anchor must not lose its place to an interpolated one.

`add_bekker_gutter` walks the cadence targets in ascending line order and keeps
the first tick to claim each char offset. The targets are a mix: a line the
source really anchors (a TEI Bekker milestone, or a hand-keyed anchors.yaml
phrase) comes out `real: True`; everything else is a proportional estimate,
word-snapped. Because an estimate for an EARLIER line is emitted first, it can
take the offset a later real anchor holds — and the real anchor is then dropped
without a word.

The result is a gutter that prints the wrong Bekker line beside the prose (line
5 where the edition says 6), and one fewer trustworthy anchor for the aligner,
which reads `real` to decide what it can trust (stage1_ross._real_ticks,
align/reference.load_chapters). It bites hardest in `dense=True` mode — the
hand-anchored translations, where the real anchors are packed close enough for
an estimate to land on one.
"""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "pipeline"))

from aristotle_pipeline.stage1_english import add_bekker_gutter

TEXT = "aaaa bbbb cccc dddd eeee ffff gggg hhhh"


def _spine(last=10):
    return {"segments": [{"id": "1:1a", "book": 1, "column": "1a",
                          "lines": [{"n": n, "text": "x"} for n in range(1, last + 1)]}]}


def _english(line_ms):
    return {"chunks": [{"id": "1:1a", "book": 1, "column": "1a",
                        "text": TEXT, "markers": [], "notes": []}],
            "_line_ms": {"1:1a": line_ms}}


def test_a_real_anchor_survives_an_estimate_landing_on_it():
    # Line 6 is hand-anchored at offset 5. Interpolating line 5 word-snaps to
    # the same offset, and used to evict it.
    eng = _english([(6, 5)])
    add_bekker_gutter(eng, _spine(), dense=True)
    ticks = eng["chunks"][0]["bekker"]

    at5 = [t for t in ticks if t["offset"] == 5]
    assert len(at5) == 1
    assert at5[0] == {"n": 6, "offset": 5, "real": True}, ticks
    assert any(t["real"] for t in ticks if t["n"] == 6)


def test_the_column_start_and_other_estimates_are_untouched():
    eng = _english([(6, 5)])
    add_bekker_gutter(eng, _spine(), dense=True)
    ticks = eng["chunks"][0]["bekker"]

    assert ticks[0] == {"n": 1, "offset": 0, "real": True}
    assert ticks == sorted(ticks, key=lambda t: t["offset"])
    assert len({t["offset"] for t in ticks}) == len(ticks)  # still deduped


def test_two_estimates_on_one_offset_still_keep_the_first():
    """Only a real anchor may displace an estimate; estimate-vs-estimate keeps
    the earlier line, as before."""
    eng = {"chunks": [{"id": "1:1a", "book": 1, "column": "1a",
                       "text": "ab", "markers": [], "notes": []}],
           "_line_ms": {}}
    add_bekker_gutter(eng, _spine(last=40), dense=False)
    ticks = eng["chunks"][0]["bekker"]
    assert len({t["offset"] for t in ticks}) == len(ticks)
    by_off = {}
    for t in ticks:
        by_off.setdefault(t["offset"], t)
    # the surviving tick at each offset is the lowest-numbered contender
    assert ticks == sorted(ticks, key=lambda t: t["offset"])


def test_a_real_anchor_does_not_displace_another_real_anchor():
    """Two hand-keyed anchors pinned to the same offset (the column-end fallback
    in stage1_archive does this) keep the first, as before — the collision is a
    data problem for the anchors file, not something to resolve by line order."""
    eng = _english([(5, 5), (10, 5)])
    add_bekker_gutter(eng, _spine(), dense=True)
    ticks = eng["chunks"][0]["bekker"]
    at5 = [t for t in ticks if t["offset"] == 5]
    assert len(at5) == 1 and at5[0]["n"] == 5 and at5[0]["real"] is True
