# Bekker gloss-alignment status — by work & translation

Tracks every translation that has had real Bekker line-ticks placed by the
gloss-aligner ([recipe](gloss-aligner-recipe.md)). The **Review** links open the
per-book HTML pages (Greek window · gloss · translation prose with a ▸ at the placed
offset; Spot-on / Early / Late buttons + JSON export).

Tick counts are real ticks (`column` + `five_line` tiers); `chapter`/`line`-tier
anchors are structural/interpolated and not counted.

> **What "confirmed" means here (corrected 2026-07-31).** Every `confirmed` /
> `reliable` / `uncertain` count in this file is an **Opus verifier's** judgment of
> the Sonnet gloss pass — a model checking a model. It is not a human reading.
>
> Almost no tedious human verification has been done on this corpus. Audited
> 2026-07-31: **the repo contains no human verdict export for any work.** The
> review pages export Spot-on/Early/Late JSON (see "How to verify a work"), and no
> such file exists anywhere in `build/align/` or `alignment-results/`. The
> `*_review.json` files hold the aligner's own `confidence`/`score`/`flags`, not
> reviewer marks, and cover only the flagged subset (EN/Ross: 138 rows, not 1293).
>
> The one alignment work with a committed human correction is **Poet / Fyfe**
> (`63d41aa2`, 8 word-exact pins). Human passes claimed below for SE and HA Book 1
> have no surviving artifact either way. Treat every other "reviewed" as machine-only.
>
> Outside alignment, the real hand-verification lives in `bonitz/` — the adjudicated
> page files and the 67 rulings frozen as a fixture in `2e1e6471`.

## ⚠ Not shipped — machine-verified only

> **Corrected 2026-09-07.** Mete/Webster, GC/Joachim, SE/Pickard-Cambridge, DA/Smith and
> HA/Thompson used to sit in this table; all five have been live for weeks (each is wired
> via `anchors:` in its manifest, registered in `shared/lib/works.ts`, and covered by deploy
> entries in `DEPLOY-STATUS.md`). They are moved to the shipped table below with the
> evidence per row. Nothing about their verification changed — still machine-only.

| Work | Translation | Chapters | Real ticks | Confidence | Review |
|------|-------------|---------:|-----------:|------------|--------|
| Categories (`Cat`) | E. M. Edghill (Oxford) — **partial spike** | ch 1–2 only | (not persisted) | n/a | [ch 1–2](../alignment-results/edghill/review/categories-ch1-2.html) |

- **Cat / Edghill** — early spike, only Book/ch 1–2 rendered to a review page; no
  persisted map yet. Needs a full run (all chapters) before verification.
  *Note 2026-09-07:* the Categories work itself is live with Edghill as primary and a
  236-entry `sources/cat-edghill/anchors.yaml` wired in `manifests/Cat.yaml` /
  `Cat-public.yaml` (`/Cat/book/1/` live-verified in `DEPLOY-STATUS.md` 2026-08-13), but
  those anchors came from the Ackrill-stamp keying described in `corpus-expansion.md`, not
  from the gloss-aligner: `alignment-results/edghill/` still holds only
  `categories-ch1-2.html` (plus an `Int_edghill_gloss_map.json`) and no
  `Cat_edghill_gloss_map.json`. This row therefore stays as is.

## ✅ Shipped live (machine-verified unless noted)

| Work | Translation | Chapters | Real ticks | Confidence | Review |
|------|-------------|---------:|-----------:|------------|--------|
| Nicomachean Ethics (`EN`) | W. D. Ross (secondary) | 116 | 1293 | 1288 confirmed · 5 uncertain | [Bk 1–10](../alignment-results/ross/review/) |
| Politics (`Pol`) | B. Jowett (public primary) | 102 | 1555 | 1538 confirmed · 13 uncertain · 4 reliable | [Bk 1–8](../alignment-results/jowett/review/) |
| Prior Analytics (`APr`) | A. J. Jenkinson (public primary) | 73 | 791 | 790 confirmed · 1 reliable | [Bk 1](../alignment-results/jenkinson/review/book-01.html) · [Bk 2](../alignment-results/jenkinson/review/book-02.html) · [index](../alignment-results/jenkinson/index.html) |
| Physics (`Phys`) | R. P. Hardie & R. K. Gaye (public primary) | 71 | 1200 | 1199 confirmed · 1 reliable | [index](../alignment-results/hardie/index.html) · Bk [1](../alignment-results/hardie/review/book-01.html) [2](../alignment-results/hardie/review/book-02.html) [3](../alignment-results/hardie/review/book-03.html) [4](../alignment-results/hardie/review/book-04.html) [5](../alignment-results/hardie/review/book-05.html) [6](../alignment-results/hardie/review/book-06.html) [7](../alignment-results/hardie/review/book-07.html) [8](../alignment-results/hardie/review/book-08.html) |
| Poetics (`Poet`) | W. H. Fyfe (Loeb, 1932) — primary | 26 | 233 | 232 confirmed · 1 uncertain | [Bk 1](../alignment-results/fyfe/review/book-01.html) · [index](../alignment-results/fyfe/index.html) |
| Meteorology (`Mete`) | E. W. Webster (Oxford, 1923) | 41 | 773 | 773 confirmed | [Bk 1](../alignment-results/webster/review/book-01.html) · [Bk 2](../alignment-results/webster/review/book-02.html) · [Bk 3](../alignment-results/webster/review/book-03.html) · [Bk 4](../alignment-results/webster/review/book-04.html) · [index](../alignment-results/webster/index.html) |
| On Generation and Corruption (`GC`) | H. H. Joachim (Oxford, 1922) | 21 | 362 | 362 confirmed | [Bk 1](../alignment-results/joachim/review/book-01.html) · [Bk 2](../alignment-results/joachim/review/book-02.html) · [index](../alignment-results/joachim/index.html) |
| Sophistical Refutations (`SE`) | W. A. Pickard-Cambridge (Oxford, 1928) | 34 | 316 | 316 confirmed | [Bk 1](../alignment-results/pickard/review/book-01.html) · [index](../alignment-results/pickard/index.html) |
| De Anima (`DA`) | J. A. Smith (Oxford, 1931) | 30 | 460 | 454 confirmed · 6 reliable/uncertain | [Bk 1](../alignment-results/smith/review/book-01.html) · [Bk 2](../alignment-results/smith/review/book-02.html) · [Bk 3](../alignment-results/smith/review/book-03.html) · [index](../alignment-results/smith/index.html) |
| History of Animals (`HA`) | D'Arcy W. Thompson (public primary) | 227 | 2067 | 2060 confirmed · 7 reliable | [index](../alignment-results/thompson/index.html) · Bk [1](../alignment-results/thompson/review/book-01.html) [2](../alignment-results/thompson/review/book-02.html) [3](../alignment-results/thompson/review/book-03.html) [4](../alignment-results/thompson/review/book-04.html) [5](../alignment-results/thompson/review/book-05.html) [6](../alignment-results/thompson/review/book-06.html) [7](../alignment-results/thompson/review/book-07.html) [8](../alignment-results/thompson/review/book-08.html) [9](../alignment-results/thompson/review/book-09.html) |

- **Mete / Webster** — aligned 2026-06-24 (sonnet gloss · opus verify ×1 · **two-tier
  targeted correction**). 773 real ticks, all confirmed; wired via
  `sources/mete-webster/anchors.yaml` (713 anchors, 3 unresolved `357b30`/`368a5`/`368b5`)
  + `anchors:` in `manifests/Mete.yaml`. stage2 PASS, app build clean, 809 prose marks.
  **Targeted correction (new this work):** pass-2 was 65% exact / 86% early-late (Webster
  paraphrases more than Joachim). Instead of a full ~1M-token Opus re-judge, ran a cheap
  Sonnet Tier-1 over all 41 ch → flagged 117 ticks whose phrase moved >30 chars from the
  persisted offset → Opus Tier-2 confirmed only those (109 moves, 85 folded). Result:
  **80% exact, 99% within 30 chars, sentence-misses eliminated** (1 tick >30). Still wants a
  human review pass (it shipped without one), but materially better than the raw verify output.
  **shipped (verified 2026-09-07):** `manifests/Mete.yaml` `english.primary.anchors:
  mete-webster/anchors.yaml`; `sources/mete-webster/anchors.yaml` 713 entries; `Mete` /
  `webster` registered in `shared/lib/works.ts`. Live via the full 41-work `build:public`
  deploy of 2026-07-13 (a), the Mete tick re-anchoring that rode along on 2026-08-11, and
  the full corpus rebuilds of 2026-08-13 and 2026-08-22 (`DEPLOY-STATUS.md`). Machine-only.
- **GC / Joachim** — aligned 2026-06-23 (sonnet gloss · opus verify ×1, schema-judged).
  362 real ticks, all confirmed; wired via `sources/gc-joachim/anchors.yaml` (336 anchors,
  1 unresolved `327a35`) + `anchors:` in `manifests/GC.yaml`. stage2 PASS, app build clean.
  **Correction pass skipped after a 4-chapter sample probe:** the Opus verifier marked ~90%
  early/late, but a sample check showed 82% of pass-2 placements are already exact and the
  early/late verdicts are a `current_placement` lead-in artifact (the judge is shown a clause
  before the true offset). Quality is comparable to Ross-EN; **needs a human review pass**
  (watch for clause-level early drift on the ~18% harder ticks) — still outstanding; it
  shipped without one.
  **shipped (verified 2026-09-07):** `manifests/GC.yaml` `english.primary.anchors:
  gc-joachim/anchors.yaml`; `sources/gc-joachim/anchors.yaml` 336 entries; `GC` / `joachim`
  registered in `shared/lib/works.ts`. Live via the full 41-work `build:public` deploy of
  2026-07-13 (a), the GC tick fix that rode along on 2026-08-11, and the full corpus rebuilds
  of 2026-08-13 and 2026-08-22 (`DEPLOY-STATUS.md`). Machine-only.
- **SE / Pickard-Cambridge** — aligned 2026-06-23 (sonnet gloss · opus verify ×2 + a
  claimed human review pass). 100 ticks recorded as human-reviewed (60 ok, 24 early, 16
  late; 51 word-clicked to pin exact phrase) — **no verdict export survives, so this
  cannot be confirmed and the reviewed ticks can no longer be told apart from the rest.**
  Remaining 216 ticks verified by Opus — **Opus marked 87% early/late on
  the unreviewed chapters, which is high vs the claimed human rate of 40%; the unreviewed
  chapters need a further human pass — still outstanding; it shipped without one.** Phase B wired via
  `sources/sr-pickard/anchors.yaml` + `anchors:` in `manifests/SE.yaml`; committed (both are
  in the tree at the shallow boundary `040423e`, 2026-07-27 — the exact commit is out of
  reach of this clone's history).
  **shipped (verified 2026-09-07):** `manifests/SE.yaml` `english.primary.anchors:
  sr-pickard/anchors.yaml`; `sources/sr-pickard/anchors.yaml` 312 entries; `SE` / `pickard`
  registered in `shared/lib/works.ts`. Live via the full 41-work `build:public` deploy of
  2026-07-13 (a), the SE tick fix that rode along on 2026-08-11, and the full corpus rebuilds
  of 2026-08-13 and 2026-08-22 (`DEPLOY-STATUS.md`). Machine-only; no verdict export.
- **DA / Smith** — aligned 2026-07-06 (sonnet gloss · opus verify ×1 · one correction pass
  §5b). 460 real ticks (454 confirmed, 6 reliable/uncertain); the **primary** translation
  (unlike the Ross-secondary NE), so wired via `sources/da-smith/anchors.yaml` (424
  `chapter`+`five_line` anchors, 3 unresolved `418a20`/`424a15`/`428a5`) + `anchors:` under
  `english.primary` in `manifests/DA.yaml`. Wallace secondary stays Tier 0. Correction
  move-size vs verify-once: median 0 / mean 4.3 / max 69 chars, 0 moves >100. stage2 PASS,
  key_failures=0; reader gutter 486 real / 3 interp (99.4%). **Needs a human review pass**
  (`smith/review/book-0{1,2,3}.html`) — still outstanding; it shipped without one.
  **shipped (verified 2026-09-07):** deployed 2026-07-08 as PR #22 "De Anima / J. A. Smith
  Tier 2 gloss alignment", `/DA/book/1/` live-verified (`DEPLOY-STATUS.md`, 2026-07-08 entry).
  `manifests/DA.yaml` `english.primary.anchors: da-smith/anchors.yaml`;
  `sources/da-smith/anchors.yaml` 424 entries; `DA` / `smith` registered in
  `shared/lib/works.ts`. Re-anchored again on 2026-08-11 (Wallace secondary, `1a86339`) and
  rebuilt in the full corpus deploys of 2026-08-13 and 2026-08-22. Machine-only.
- **HA / Thompson** — the corpus's longest work, aligned 2026-06-22 (sonnet gloss · opus
  verify). Book 1 recorded as human-reviewed & approved — **no verdict export survives to
  confirm it.** **§5b correction pass status:** Book 7 applied
  (`d24550c`); **Books 8+9 applied 2026-07-06** (opus, 634 ticks re-judged; move-size vs
  verify-once: median 0 / mean 6.4 / max 82 chars, 0 moves >100). Books 1–6 intentionally
  left at verify-once (the original build's scratch was lost; the correction is a marginal
  nudge and re-running it over all books wasn't worth the regression risk against the
  approved alignment). Reconstruction note: rebuilt overrides from the committed maps
  (Book 8 pre-seed reproduced the committed map with 0 mismatches) before correcting 8+9.
  Phase B wired via `sources/ha-thompson/anchors.yaml` (2008 `chapter`+`five_line` entries
  from `tools/gloss_map_to_anchors.py`) + `anchors:` under `english.primary` in
  `manifests/HA.yaml`. Build: stage2 PASS, key_failures=0; reader gutter 2254 real / 31
  interpolated (98.6%).
  **shipped (verified 2026-09-07):** deployed 2026-07-08 as PR #23 "History of Animals /
  D'Arcy Thompson §5b correction (Books 8–9)", `/HA/book/8/` live-verified
  (`DEPLOY-STATUS.md`, 2026-07-08 entry). `manifests/HA.yaml` `english.primary.anchors:
  ha-thompson/anchors.yaml`; `sources/ha-thompson/anchors.yaml` 2008 entries; `HA` /
  `thompson` registered in `shared/lib/works.ts`. HA tick fix rode along on 2026-08-11;
  rebuilt in the full corpus deploys of 2026-08-13 and 2026-08-22. Machine-only; the Book 1
  human pass still has no surviving verdict export.
- **EN / Ross** — shipped 2026-06-17; reader consumes the combined gloss map via
  `stage1_ross`. **Correction 2026-07-31:** this entry used to read "every tick
  read-and-checked", which nothing supports. What exists is `EN_ross_review.json` (138
  rows) and `EN_ross_gloss_review.json` (134) — the aligner's own confidence/score/flags
  over the flagged subset, no reviewer marks. All 1293 ticks are machine-verified.
- **Pol / Jowett** — shipped live `d322247` after a 2nd Greek-grounded audit round
  (**machine**, not a human pass — no verdict export exists); wired via
  `sources/pol-jowett/anchors.yaml` (archive primary).
- **APr / Jenkinson** — Phase A aligned 2026-06-21 (sonnet gloss · opus verify; lone
  `reliable` tick `37b20`, Bk 1 ch 18, where Jenkinson condenses the line). Phase B wired
  same day via `sources/apr-jenkinson/anchors.yaml` (774 `chapter`+`five_line` entries,
  generated by `tools/gloss_map_to_anchors.py`) + `anchors:` under `english.primary` in
  `manifests/APr.yaml`. `column`-tier (line-1) ticks are omitted — `add_bekker_gutter`
  pins each column's first line structurally. Build: stage2 PASS, 1 unresolved (`32b40`,
  a column-end straddle → interpolated); gutter renders 858 real vs 5 interpolated ticks.
  Deploys on the next gh-pages push.
- **Phys / Hardie & Gaye** — aligned + shipped 2026-06-22 (sonnet gloss · opus
  verify + one opus correction pass — **no human pass**; lone `reliable` tick in Bk 7 where the phrase wasn't
  located verbatim). Phase B wired via `sources/phys-hardie/anchors.yaml` (1105
  `chapter`+`five_line` entries from `tools/gloss_map_to_anchors.py`) + `anchors:` under
  `english.primary` in `manifests/Phys.yaml`. Build: stage2 PASS, key_failures=0, 8
  unresolved column-end/`*35` straddles → interpolated; reader gutter renders 1249 real vs
  7 interpolated ticks.
- **Poet / Fyfe** — aligned + human-reviewed + shipped live 2026-06-24 (gh-pages `b6cff15`;
  sonnet gloss · opus verify ×1 + one scoped opus correction pass + 8 word-exact human
  anchor pins). **The only alignment work with a committed human correction** — `63d41aa2`
  records John flagging 9 ticks early/late and pinning the exact phrase for each; the
  aligner had snapped those sub-clause (3–51 char) fixes away, so they were written into
  `anchors.yaml` directly. 233 real ticks, **232 confirmed · 1 uncertain** (`1458b10`, ch 22, where Fyfe
  condenses the line). **First gloss-aligned work whose primary was converted from the Perseus
  `perseus_tei` path to archive:** Fyfe's prose was extracted from the eng TEI to
  `sources/poet-fyfe/book-01.html` by `tools/extract_fyfe_poetics.py` (footnotes + Bekker
  milestones stripped, inline Greek kept), and `manifests/Poet.yaml` `english.primary` switched
  to `model: archive` + `anchors: poet-fyfe/anchors.yaml` (231 anchors, **0 unresolved**).
  Reader gutter renders **257 real ticks, 0 interpolated**. NB Fyfe's footnotes are dropped by
  the archive conversion (a content tradeoff vs the old `perseus_tei` build).

## Related

- **UGARIT word-aligner spike** (2026-07-31) — tested whether an open Ancient-Greek
  word-alignment model could place these ticks instead of the gloss pipeline. It can't
  (it refines a position rather than finding one), but it beats the interpolated
  fallback 2–4× and could serve translations with no anchors file. See
  [ugarit-aligner-spike.md](ugarit-aligner-spike.md).

## Not gloss-aligned (different method, for completeness)

- **NE / Ostwald** — per-line Bekker gutter comes from the source's inline Bekker markers
  (`stage1_ostwald`), not the gloss-aligner; no review page in this tracker.
  **2026-07-02:** fixed 37 stray page-boundary blank lines in `sources/ostwald/ostwald-ethics.md`
  that rendered as spurious mid-sentence paragraph breaks in the reader (plus one footnote,
  `[^277]`, truncated mid-sentence with its continuation orphaned into the Book VI body text).
  See `ocr_translations/CLAUDE.md` Step 4.4 for the automated scan that should catch this on
  future translations.

## How to verify a work

1. Open each `review/book-NN.html` in a browser.
2. For each tick decide **Spot on** / **Early** (matching content is *after* the ▸) /
   **Late** (it's *before* the ▸); add notes as needed. Verdicts auto-save in the browser.
3. Click **Export JSON** to save the verdicts; the Early/Late ones drive a re-gather +
   re-verify pass on those chapters (`tools/verify_gather.py <book> 4000 <chapters>`).
4. **Commit the export.** Step 2's verdicts live in browser storage only — if the export
   isn't saved into the repo, the pass leaves no trace and the work has to be redone. This
   is why the SE and HA Book 1 passes can't be confirmed today: nothing was committed, so
   there is no way to tell which ticks a human actually looked at.
5. When clean, do Phase B wiring (see each work's note above) + commit/deploy.
