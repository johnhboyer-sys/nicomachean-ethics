"""`check_roundtrip` is the aligner's only per-chapter guard, and as written it
could not fail.

It sorted the anchor offsets, dropped any outside the prose, sliced the prose at
the survivors and asserted the pieces re-join to the original. But slicing a
string at any sorted, in-range list of points and concatenating ALWAYS gives the
string back — `text[0:a] + text[a:b] + text[b:len]` is `text` for every a <= b.
Both repairs the check made (the sort and the range filter) are exactly the two
corruptions it is there to catch: an override placed past the end of the prose,
or an anchor that regressed behind its predecessor.

So the guard has to run on the offsets as `align_chapter` actually emits them.
"""

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "pipeline"))

from aristotle_pipeline.align.aligner import Anchor, align_chapter, check_roundtrip
from aristotle_pipeline.align.reference import ChapterRef, RefAnchor

PROSE = "One sentence here. A second one follows. And a third closes it."


def _chapter():
    return ChapterRef(
        book=1,
        chapter="1",
        citation="1094a1",
        ross_text=PROSE,
        ref_text=PROSE,
        ref_anchors=[RefAnchor("1094a1", 0, "chapter"),
                     RefAnchor("1094a5", 19, "half_column")],
    )


def test_well_formed_anchors_pass():
    check_roundtrip(_chapter(), [Anchor("1094a1", 0, "chapter", "certain"),
                                 Anchor("1094a5", 19, "half_column", "reliable")])


def test_an_offset_past_the_end_of_the_prose_fails():
    # The shape a stale override makes: the map was built against a longer
    # parse of the translation than the one now loaded.
    anchors = [Anchor("1094a1", 0, "chapter", "certain"),
               Anchor("1094a5", len(PROSE) + 40, "half_column", "confirmed")]
    with pytest.raises(AssertionError):
        check_roundtrip(_chapter(), anchors)


def test_a_negative_offset_fails():
    anchors = [Anchor("1094a1", -1, "chapter", "certain")]
    with pytest.raises(AssertionError):
        check_roundtrip(_chapter(), anchors)


def test_an_anchor_that_regresses_behind_its_predecessor_fails():
    anchors = [Anchor("1094a1", 0, "chapter", "certain"),
               Anchor("1094a5", 40, "half_column", "reliable"),
               Anchor("1094a10", 19, "half_column", "reliable")]
    with pytest.raises(AssertionError):
        check_roundtrip(_chapter(), anchors)


def test_coincident_offsets_are_still_allowed():
    """Two ticks landing in one sentence is ordinary (`_dedup_monotonic` clamps
    a regression onto its predecessor), so equal offsets must not trip it."""
    check_roundtrip(_chapter(), [Anchor("1094a1", 0, "chapter", "certain"),
                                 Anchor("1094a5", 0, "half_column", "reliable"),
                                 Anchor("1094a10", 19, "half_column", "reliable")])


def test_align_chapter_output_satisfies_the_guard():
    """The invariant the real pipeline relies on, pinned end to end."""
    ch = _chapter()
    check_roundtrip(ch, align_chapter(ch, "lexical"))
