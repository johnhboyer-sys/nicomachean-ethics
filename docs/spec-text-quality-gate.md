# Spec: text-quality gate (feature 8)

*Status: shipped — PR #82 (merge `6072cc4`, commit `a2ed465`, report-only) and
armed in PR #85 (merge `d781745`, commit `904e36d`, `HARD_GATE = True` in
`quality.py`), both 2026-08-18. Parent: `corpus-analysis-features.md` §8. No TLG
licence question — the gate ships nothing; it guards the build.*

## Goal

A per-work build check that flags Greek tokens whose breathing mark sits in an
orthographically impossible position. This one signature catches real
corruption with high specificity: run-together words (`ποιοῦσιναἱ`,
`τὴνφορὰνἔφαμεν`) and displaced glyphs (`οἰὀμεθʼ`). On the vendored TEI it
separated First1K from Perseus 3.00 vs 0.92 per 10k tokens (as recorded in
`corpus-analysis-features.md` §8 — the study computes rates at runtime and
stores none), where an edit-distance probe scored them identically. The
detector's history is in `analysis/studies/text_quality.py` on
`origin/claude/greek-statistical-analysis-tihpcs`.

What it guards here: the **Diogenes-export spine plus stage1 line-joining**.
The authoritative Greek is the Diogenes export
(`stage1_greek.py` → `build/stage1/greek_spine.json`), not the Perseus/First1K
XML in `sources/` (used only to align chapter boundaries) — so the gate
protects exactly the text every downstream consumer reads. Today nothing
checks breathing position anywhere: `beta.to_beta_key()` transliterates
`ποιοῦσιναἱ` without complaint, and stage2's sigla check inventories
characters, not positions.

## Decisions

1. **Lift `illegal_breathing()` unchanged as the core check**, with a
   docstring crediting the origin (`analysis/studies/text_quality.py` — a pure
   bool function flagging a breathing past a token's opening vowel cluster).
   The crasis handling in decision 3 is an addition AROUND it, not a change TO
   it: the lifted function stays pure; a wrapper classifies its hits.
2. **Run at the tail of stage3**, not as a new stage number. Stage3 already
   walks every token and already writes sibling diagnostics
   (`sigla_log.json`, `key_failures.json` — `stage3_tokenize.py:54-77`); this
   is a third check of the same kind at the same altitude.
3. **Crasis is a special case, not a blanket exemption — and it is lexical,
   not mark-based.** U+0343 (coronis) canonically decomposes to U+0313 (smooth
   breathing) under NFD, so coronis cannot be detected by codepoint. The
   detector already passes first-cluster crasis untouched (κἀγώ, τἀγαθόν,
   τοὐναντίον — the breathing sits in the opening vowel cluster); the
   classifier only needs known crasis whose fusion sits past the first
   cluster, kept as a small documented NFD-prefix set (ἐγᾠ-/ἐγᾦ-, μεντἀ-,
   καλοκἀ- — the καλοκἀγαθία family is the one such form in the emitted
   corpus). Hits match → `reason: "crasis"`; rarities go in the allowlist.
   Separately, a breathing on **rho** is never the run-together signature:
   this spine writes orthodox medial ῤῥ (ἐῤῥήθη, πυῤῥῷ), which the detector
   flags — classified `reason: "rho-breathing"` when every flagged breathing
   in the token sits on ρ.
4. **Allowlist = manifest-declared exceptions, the established pattern.**
   `illegal_breathing_allow: [{ref, surface}]` — its own shape, consulted the
   way `alignment_allow_unmatched` is (`stage2_validate.py:438`, the closest
   sibling: allowed leftovers) and declared the way `expected_line_gaps` is
   (`stage2_validate.py:398`). Allowed hits appear in the report as expected;
   only unexpected hits fail. Never the prose known-benign-notes pattern.
5. **Report in `stage2_validate.py` house style**: per-check dict with
   domain-named keys plus an `ok` flag per check,
   `report["ok"] = all(c.get("ok") ...)` (`stage2_validate.py:644`), JSON plus
   a Markdown twin, a one-line stdout summary from `__main__.py`.
6. **Report-only first, hard gate second.** Land with
   `HARD_GATE = False`; one full `build:public` establishes the corpus
   baseline; John reviews the per-work table, populates allowlists, then the
   flag flips in a follow-up one-line change. **The flip timing is John's
   call.**
7. **Fix the report-copy trap while adding the report.**
   `stage7_emit.py:616-626` copies each `rel` path to
   `reports / Path(rel).name` — fixed basenames into a shared dir, last work
   wins. Appending another `rel` entry inherits the trap, so the copy loop
   must learn destination names: extend it to accept `(rel, dest_name)` pairs
   and copy the new report as `quality_<work>.{json,md}`. Existing entries
   keep their behavior.

## Files

| File | Change |
|---|---|
| `pipeline/aristotle_pipeline/quality.py` | new — detector, crasis handling, `check_breathing()` |
| `pipeline/aristotle_pipeline/stage3_tokenize.py` | call `check_breathing`, write report |
| `pipeline/aristotle_pipeline/__main__.py` | `_stage3` (line 171): summary line + gated `SystemExit` |
| `pipeline/aristotle_pipeline/stage7_emit.py` | copy report, work-qualified name |
| manifests (opt-in, per work) | `illegal_breathing_allow` key |
| `pipeline/tests/test_quality.py` | new |

Out of scope: `sources/` XML (not re-checked at that layer), `build-public.mjs`
(the per-work `aristotle_pipeline all` subprocess already propagates a non-zero
exit), all UI.

## Data shapes

```json
// build/stage3/quality_report.json — one per work, stage2_validate house style
{
  "checks": {
    "breathing_position": {
      "tokens_checked": 12345,
      "flagged": [
        {"ref": "1172a9", "surface": "ποιοῦσιναἱ", "allowed": false},
        {"ref": "979a9",  "surface": "κἀγώ", "allowed": true, "reason": "crasis"}
      ],
      "unexpected": [{"ref": "1172a9", "surface": "ποιοῦσιναἱ"}],
      "per_10k": 3.0,
      "ok": false
    }
  },
  "ok": false
}
```

```yaml
# manifest addition — same declared-exception family as expected_line_gaps
illegal_breathing_allow:
  - { ref: "979a9", surface: "θοἰμάτιον" }  # a rare crasis the coronis detection misses
```

(κἀγώ-type crasis should be caught by the automatic detection and needs no
allowlist entry; the allowlist is for what the detection misses.)

## Implementation steps

1. `quality.py`: `illegal_breathing()` (lifted unchanged), a crasis-classifying
   wrapper, and `check_breathing(tokens, allowlist) -> dict` returning the
   shape above. `check_breathing` takes the allowlist as a plain argument — it
   never touches the manifest itself.
2. `stage3_tokenize.run()`: after tokenizing, read
   `manifest.data.get("illegal_breathing_allow", [])`, run `check_breathing`
   over every token with its ref, write `build/stage3/quality_report.json` and
   a small `.md` twin.
3. `__main__.py::_stage3`: print
   `stage3-quality: checked=N unexpected=N ok/FLAGGED`; `SystemExit(1)` on
   `not ok` only when `HARD_GATE` (module constant, initially `False`).
4. `stage7_emit.py`: extend the copy loop to `(rel, dest_name)` pairs; copy
   the report pair as `quality_<work>.{json,md}` (decision 7).
5. Baseline: run `npm run build:public`, hand John the per-work
   flagged/`per_10k` table. Expect the Diogenes spine to be cleaner than the
   vendored First1K numbers; treat the actual counts as the finding.
6. After allowlists land: flip `HARD_GATE = True` (separate small PR).

## Test plan

`pipeline/tests/test_quality.py`:

- flagged: `ποιοῦσιναἱ`, `τὴνφορὰνἔφαμεν`, `οἰὀμεθʼ`
- not flagged: ordinary words with initial breathing, initial-diphthong
  breathing (second element), and crasis forms `κἀγώ`, `τἀγαθόν` (or
  flagged-with-`reason: crasis`, per the detection route)
- allowlist: a flagged `{ref, surface}` present in the manifest fixture lands
  in `flagged` with `allowed: true` and not in `unexpected`
- `ok` flag: false iff `unexpected` is non-empty

Integration: extend the existing stage2/stage3 test module with a synthetic
spine holding one corrupt token and one allowlisted form; assert the report's
`ok`/`unexpected` split and that `_stage3` does not exit while
`HARD_GATE = False`.

## Acceptance criteria

- `uv run pytest tests/test_quality.py` passes (from `pipeline/`).
- `npm run build:public` completes with the new report present per work under
  `build/dist/reports/quality_<work>.json`, no gate behavior change while
  report-only.
- The baseline table delivered to John lists every work with a non-zero
  unexpected count.
