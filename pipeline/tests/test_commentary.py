"""The commentary ingestion gates (docs/commentary-layer-decisions.md §6).

Every gate gets its passing shape and each way it is meant to fail. The
fixtures are the decision doc's own worked examples cut down: Hicks on De
Anima 402a as lemma notes, Aquinas's lectio 1 divisio over the same columns,
and a Themistius ai-translation stream.
"""

import pytest

from aristotle_pipeline.commentary import (
    check_ai,
    check_all,
    check_applies_to,
    check_coverage,
    check_divisio,
    check_honesty,
    check_identity,
    check_lemmata,
    check_ranges,
    check_streams,
    stitch_fragments,
)

# De Anima I: 402a and 402b, thirty lines each; one gap at 402b29-30 so an
# inter-book anchor can be tested.
SPINE = {"402a": set(range(1, 31)), "402b": set(range(1, 31))}


def book_for_line(column, line):
    if column == "402b" and line >= 29:
        return None          # stands in for an inter-book numbering gap
    return 1


def note(**over):
    base = {
        "id": "hicks.1",
        "type": "lemma",
        "range": {"column": "402a", "lo": 1, "hi": 10},
        "anchor": {"column": "402a", "line": 1},
        "snapped": False,
        "appliesTo": "work",
        "lemma": {"text": "τῶν καλῶν", "lang": "grc", "verdict": "matches", "checker": "R. D. Hicks (transcribed 2026-08-10)"},
        "body": {"en": "<p>The opening sentence.</p>"},
        "weight": 28,
    }
    base.update(over)
    return base


STREAMS = [
    {"id": "en", "lang": "en", "role": "translation", "hosted": True,
     "copyright": {"state": "pd", "basis": "Hicks 1907; author d. 1929."}},
]


# -- Gate 1: ranges -----------------------------------------------------------

def test_a_range_inside_the_spine_passes():
    check = check_ranges([note()], SPINE, book_for_line)
    assert check["ok"] and check["notes"] == 1 and check["snapped"] == 0


def test_a_column_the_work_does_not_have_fails():
    check = check_ranges([note(range={"column": "999a", "lo": 1, "hi": 2})], SPINE, book_for_line)
    assert not check["ok"] and "not in this work's spine" in check["problems"][0]


def test_a_range_that_runs_backwards_fails():
    bad = note(range={"column": "402b", "lo": 5, "hi": 2, "toColumn": "402a"})
    assert not check_ranges([bad], SPINE, book_for_line)["ok"]


def test_a_span_across_two_columns_passes():
    wide = note(range={"column": "402a", "lo": 25, "hi": 2, "toColumn": "402b"},
                anchor={"column": "402a", "line": 25})
    assert check_ranges([wide], SPINE, book_for_line)["ok"]


def test_an_anchor_within_two_lines_snaps_and_says_so():
    # The commentator's edition numbers a line or two off ours; the reader
    # already snaps to the nearest line in the column, and so may ingestion.
    near = note(range={"column": "402a", "lo": 12, "hi": 20},
                anchor={"column": "402a", "line": 14}, snapped=True)
    assert check_ranges([near], SPINE, book_for_line)["ok"]

    far = note(range={"column": "402a", "lo": 12, "hi": 20},
               anchor={"column": "402a", "line": 17}, snapped=True)
    assert "snapped 5 lines" in check_ranges([far], SPINE, book_for_line)["problems"][0]


def test_a_moved_anchor_that_does_not_admit_it_fails():
    quiet = note(anchor={"column": "402a", "line": 2}, snapped=False)
    assert "snapped is not set" in check_ranges([quiet], SPINE, book_for_line)["problems"][0]


def test_snapped_set_on_an_anchor_that_did_not_move_fails():
    assert not check_ranges([note(snapped=True)], SPINE, book_for_line)["ok"]


def test_an_anchor_on_a_line_the_work_lacks_fails():
    assert not check_ranges([note(anchor={"column": "402a", "line": 99})], SPINE, book_for_line)["ok"]


def test_an_anchor_in_an_inter_book_gap_fails():
    gap = note(range={"column": "402b", "lo": 29, "hi": 30},
               anchor={"column": "402b", "line": 29})
    assert "inter-book gap" in check_ranges([gap], SPINE, book_for_line)["problems"][0]


# -- Gate 2: lemmata ----------------------------------------------------------

def test_a_variant_reading_passes_and_is_counted():
    variant = note(lemma={"text": "τῶν καλῶν", "lang": "grc", "verdict": "variant-reading",
                          "checker": "opus-4.1 run 2026-08-10T09:14Z", "variant": "τῶν καλλίστων"})
    check = check_lemmata([variant])
    assert check["ok"] and check["variant_readings"] == 1


def test_a_variant_reading_that_does_not_say_what_we_read_fails():
    thin = note(lemma={"text": "x", "lang": "grc", "verdict": "variant-reading", "checker": "someone"})
    assert not check_lemmata([thin])["ok"]


@pytest.mark.parametrize("verdict", ["error", "unchecked"])
def test_an_error_or_an_unchecked_lemma_blocks(verdict):
    bad = note(lemma={"text": "x", "lang": "grc", "verdict": verdict, "checker": "someone"})
    assert not check_lemmata([bad])["ok"]


def test_a_latin_incipit_needs_its_table_entry():
    lectio = note(id="aquinas.1.1", lemma={"text": "Bonorum honorabilium", "lang": "la",
                                           "verdict": "foreign-lemma", "checker": "Marietti apparatus"})
    assert not check_lemmata([lectio])["ok"]
    assert check_lemmata([lectio], latin_table={"aquinas.1.1": "402a1"})["ok"]


# -- Gate 3: divisio ----------------------------------------------------------

def node(lo, hi, statedIn="aquinas.1.1", children=None, midLine=False):
    out = {
        "label": {"la": "pars"},
        "at": {"column": "402a", "line": lo},
        "range": {"column": "402a", "lo": lo, "hi": hi},
        "statedIn": statedIn,
        "children": children or [],
    }
    if midLine:
        out["midLine"] = True
    return out


def test_children_that_tile_their_parent_pass():
    tree = node(1, 22, children=[node(1, 4), node(5, 10), node(11, 22)])
    check = check_divisio(tree, {"aquinas.1.1"})
    assert check["ok"] and check["nodes"] == 4


def test_a_gap_between_children_fails():
    tree = node(1, 22, children=[node(1, 4), node(7, 22)])
    assert "gap before it" in check_divisio(tree, {"aquinas.1.1"})["problems"][0]


def test_an_overlap_fails_unless_it_is_a_declared_mid_line_division():
    overlap = node(1, 22, children=[node(1, 7), node(7, 22)])
    assert "overlaps the previous child" in check_divisio(overlap, {"aquinas.1.1"})["problems"][0]

    # Aquinas divides mid-line (402a4, 402a7); a Bekker line is our finest
    # grain, so the two parts share one and say they do.
    declared = node(1, 22, children=[node(1, 7), node(7, 22, midLine=True)])
    check = check_divisio(declared, {"aquinas.1.1"})
    assert check["ok"] and check["mid_line"] == 1


def test_children_that_do_not_reach_the_parents_ends_fail():
    short_start = node(1, 22, children=[node(2, 10), node(11, 22)])
    assert "first child starts at" in check_divisio(short_start, {"aquinas.1.1"})["problems"][0]
    short_end = node(1, 22, children=[node(1, 10), node(11, 20)])
    assert "last child ends at" in check_divisio(short_end, {"aquinas.1.1"})["problems"][0]


def test_a_dangling_statedIn_fails():
    assert not check_divisio(node(1, 4, statedIn="aquinas.9.9"), {"aquinas.1.1"})["ok"]


def test_fragments_stitch_by_containment_and_an_orphan_is_reported():
    whole = node(1, 22)
    part = node(5, 10)
    roots, orphans = stitch_fragments([part, whole])
    assert roots == [whole] and orphans == []
    assert whole["children"] == [part]

    elsewhere = node(1, 4)
    elsewhere["range"] = {"column": "402b", "lo": 1, "hi": 4}
    roots, orphans = stitch_fragments([node(1, 22), elsewhere])
    assert len(orphans) == 1


# -- Gate 4 and 5: streams ----------------------------------------------------

def test_every_full_hosted_stream_needs_a_body():
    two = STREAMS + [{"id": "la", "lang": "la", "role": "original", "hosted": True,
                      "copyright": {"state": "pd", "basis": "Aquinas, d. 1274."}}]
    assert not check_streams([note()], two, public=False)["ok"]
    assert check_streams([note(body={"en": "<p>x</p>", "la": "<p>y</p>"})], two, public=False)["ok"]


def test_a_partial_stream_may_miss_a_note():
    partial = STREAMS + [{"id": "en2", "lang": "en", "role": "translation", "hosted": True,
                          "partial": True, "copyright": {"state": "pd", "basis": "…"}}]
    assert check_streams([note()], partial, public=False)["ok"]


def test_a_body_for_a_stream_this_build_does_not_host_fails():
    gated = STREAMS + [{"id": "en-gated", "lang": "en", "role": "translation", "hosted": False,
                        "copyright": {"state": "restricted", "basis": "Bloomsbury, in copyright.", "freesIn": 2083}}]
    leaked = note(body={"en": "<p>x</p>", "en-gated": "<p>the gated prose</p>"})
    check = check_streams([leaked], gated, public=True)
    assert not check["ok"] and "does not host" in check["problems"][0]


def test_a_public_build_refuses_to_host_encumbered_text():
    bad = [{"id": "en", "lang": "en", "role": "translation", "hosted": True,
            "copyright": {"state": "restricted", "basis": "in copyright"}}]
    assert not check_streams([note()], bad, public=True)["ok"]
    # The same declaration is fine on a local build, which is how the gated
    # translations already work (manifests/<Work>-public.yaml).
    assert check_streams([note()], bad, public=False)["ok"]


def test_leak_probes_must_not_reach_the_emitted_manifest():
    with_probes = [dict(STREAMS[0], leakProbes=["a quoted phrase"])]
    assert not check_streams([note()], with_probes, public=True)["ok"]


# -- Gate 7: identity ---------------------------------------------------------

def test_a_duplicate_id_fails_but_a_continuation_copy_does_not():
    duplicate = [note(), note()]
    assert not check_identity(duplicate)["ok"]

    head = note(range={"column": "402b", "lo": 28, "hi": 2, "toColumn": "403a"})
    tail = dict(head, cont=True)
    check = check_identity([head, tail])
    assert check["ok"] and check["continuations"] == 1


def test_a_continuation_whose_body_diverged_fails():
    head = note()
    tail = dict(head, cont=True, body={"en": "<p>something else</p>"})
    assert not check_identity([head, tail])["ok"]


def test_an_id_may_not_move_to_another_line_between_builds():
    previous = {"hicks.1": {"column": "402a", "line": 1}}
    assert check_identity([note()], previous)["ok"]
    moved = note(anchor={"column": "402a", "line": 9}, snapped=True)
    assert not check_identity([moved], previous)["ok"]


# -- Gate 8: appliesTo --------------------------------------------------------

def test_a_translation_note_names_a_translation_the_build_carries():
    about = note(appliesTo="translation", translationId="smith")
    assert check_applies_to([about], {"smith", "wallace"})["ok"]
    assert not check_applies_to([about], {"wallace"})["ok"]


def test_a_work_note_may_not_carry_a_translation_id():
    assert not check_applies_to([note(translationId="smith")], {"smith"})["ok"]


def test_a_translation_note_without_a_translation_id_fails():
    assert not check_applies_to([note(appliesTo="translation")], {"smith"})["ok"]


# -- Gate 10: honesty ---------------------------------------------------------

@pytest.mark.parametrize("checker", ["", "   ", "verified", "Confirmed", "auto"])
def test_a_verdict_that_names_nobody_fails(checker):
    anonymous = note(lemma={"text": "x", "lang": "grc", "verdict": "matches", "checker": checker})
    assert not check_honesty([anonymous])["ok"]


def test_a_model_run_is_a_checker_and_so_is_a_person():
    for name in ("opus-4.1 run 2026-08-10T09:14Z", "John Boyer, 2026-08-11"):
        assert check_honesty([note(lemma={"text": "x", "lang": "grc", "verdict": "matches", "checker": name})])["ok"]


# -- Gate 11: coverage --------------------------------------------------------

def test_coverage_counts_the_notes_and_stays_inside_the_work():
    entry = {"id": "hicks", "work": "DA", "noteCount": 1,
             "coverage": [{"column": "402a", "lo": 1, "hi": 10}]}
    assert check_coverage(entry, [note()], ("402a", "435b"))["ok"]

    outside = dict(entry, coverage=[{"column": "1094a", "lo": 1, "hi": 10}])
    assert not check_coverage(outside, [note()], ("402a", "435b"))["ok"]

    miscounted = dict(entry, noteCount=7)
    assert not check_coverage(miscounted, [note()], ("402a", "435b"))["ok"]


def test_a_continuation_copy_is_not_a_second_note_in_the_count():
    entry = {"id": "hicks", "work": "DA", "noteCount": 1, "coverage": []}
    assert check_coverage(entry, [note(), dict(note(), cont=True)], None)["ok"]


# -- Gate 9: the AI translation pilot -----------------------------------------

def ai_streams(**over):
    methods = {
        "model": "claude-opus-5", "date": "2026-10-01", "methodVersion": "ai-xl-0.3",
        "glossaryVersion": "cag-glossary-2", "sourceStream": "grc",
        "referenceCheck": {"reference": "Todd 1996 (named, not hosted)", "passes": 2,
                           "flagsRaised": 41, "flagsResolved": 41, "divergenceRate": 0.06,
                           "checker": "opus-4.1 run 2026-10-01T11:02Z"},
        "auditTrail": "pipeline/data/commentary/DA/themistius/run-2026-10-01.jsonl",
        "correctionsUrl": "https://github.com/johnhboyer-sys/aristotle-reader/issues",
        "methodsNoteHtml": "<p>Translated from the CAG Greek by a model.</p>",
        "revisions": [{"version": "1", "date": "2026-10-01", "summary": "first run"}],
    }
    methods.update(over)
    return [
        {"id": "grc", "lang": "grc", "role": "original", "hosted": True,
         "copyright": {"state": "pd", "basis": "CAG, 1899."}},
        {"id": "en-ai", "lang": "en", "role": "ai-translation", "hosted": True,
         "copyright": {"state": "cc-by-sa", "basis": "ours, from PD Greek."}, "ai": methods},
    ]


def test_a_complete_ai_stream_passes_and_warns_about_the_unset_threshold():
    check = check_ai(ai_streams(), audit_trail_exists=lambda p: True)
    assert check["ok"] and check["streams"] == 1
    assert "no threshold is set" in check["warnings"][0]


def test_unresolved_divergence_flags_block():
    unresolved = ai_streams(referenceCheck={"reference": "Todd 1996", "passes": 2,
                                            "flagsRaised": 41, "flagsResolved": 30,
                                            "divergenceRate": 0.06, "checker": "opus-4.1 run x"})
    check = check_ai(unresolved, audit_trail_exists=lambda p: True)
    assert not check["ok"] and "11 of 41" in check["problems"][0]


def test_generation_must_read_the_greek_not_a_translation():
    from_english = ai_streams(sourceStream="en-ai")
    assert not check_ai(from_english, audit_trail_exists=lambda p: True)["ok"]


def test_a_missing_audit_trail_blocks():
    assert not check_ai(ai_streams(), audit_trail_exists=lambda p: False)["ok"]


def test_ai_methods_belong_only_to_an_ai_stream():
    mislabelled = ai_streams()
    mislabelled[1]["role"] = "translation"
    assert not check_ai(mislabelled, audit_trail_exists=lambda p: True)["ok"]

    bare = [{"id": "en-ai", "lang": "en", "role": "ai-translation", "hosted": True,
             "copyright": {"state": "cc-by-sa", "basis": "…"}}]
    assert not check_ai(bare, audit_trail_exists=lambda p: True)["ok"]


# -- The whole set ------------------------------------------------------------

def test_check_all_reports_the_two_gates_it_cannot_run_rather_than_passing_them():
    entry = {"id": "hicks", "work": "DA", "streams": STREAMS, "noteCount": 1,
             "coverage": [{"column": "402a", "lo": 1, "hi": 10}]}
    report = check_all(
        entry, [note()],
        spine_lines=SPINE, book_for_line=book_for_line, translation_ids={"smith"},
        bekker_range=("402a", "435b"),
    )
    assert report["ok"]
    # A green report must not read as "everything was checked": the sanitizer
    # gate lives in Node, where the sanitizer is.
    assert report["not_checked"] == ["html_safety"]
    assert "sanitizer" in report["checks"]["html_safety"]["skipped"]
    assert report["checks"]["html_safety"]["ok"] is None


def test_check_all_fails_the_commentary_and_names_every_problem():
    entry = {"id": "hicks", "work": "DA", "streams": STREAMS, "noteCount": 2, "coverage": []}
    broken = note(anchor={"column": "402a", "line": 99},
                  lemma={"text": "x", "lang": "grc", "verdict": "error", "checker": ""})
    report = check_all(
        entry, [broken],
        spine_lines=SPINE, book_for_line=book_for_line, translation_ids=set(),
    )
    assert not report["ok"]
    assert len(report["problems"]) >= 4
