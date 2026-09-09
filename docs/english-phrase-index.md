# An English phrase index, and the bridge to the Greek

Scoped 2026-07-27. Phase 1 (the English stream) shipped the same day in PR #56
(merge `203c3c1`): `stage8_ngrams.py` carries `ENGLISH_STREAM` as its third
stream, and the index went live in the 2026-07-27 deploy (`DEPLOY-STATUS.md`).
Phase 2, the bridge, stays unbuilt by the decision at the end. Every number
here was measured against the corpus as it stands after that morning's rebuild.

## What it is

The phrase index counts every 2-to-5 word run Aristotle uses more than once.
It runs today over two readings of the Greek. This would add a third over the
**English translations**, and then use the two together to answer a question
neither can answer alone: *what Greek stands behind this English phrase?*

The TLG cannot do this at any price. It has no translations. This is the one
place where our corpus holds something theirs structurally does not.

## What exists already

| | |
|---|---|
| works with aligned English | 41 |
| aligned segments | 2,647 |
| English words | 1,235,389 (against 848,592 Greek tokens) |
| distinct translators | 28 |
| copyright | all public domain; the public build hides encumbered translations |

The prose is already in the shipped data, one block per segment, with its
markers and notes held separately — so the text is clean to tokenize.

## What is missing

Only a **token stream with positions**. The Greek n-grams come from a per-word
stream stage 6 emits to `build/ngrams/<work>.json`; English is currently
indexed at segment granularity only (`english.json` maps a token to the
segments holding it, not to positions). Everything downstream of the stream is
already stream-agnostic: stage 8 runs two streams through one code path and
would run three.

## Size

Measured by counting the corpus, not estimated:

| n | distinct | kept (≥2) | occurrences |
|---|---|---|---|
| 2 | 298,061 | 98,520 | 1,033,201 |
| 3 | 769,651 | 123,491 | 583,935 |
| 4 | 1,060,736 | 71,583 | 238,295 |
| 5 | 1,167,782 | 32,219 | 89,238 |
| **total** | | **325,813** | **1,944,669** |

Against the Greek: form 173,884 phrases in 18 MB, lemma 390,675 in 42 MB. The
English stream projects to **roughly 37 MB**, taking the corpus n-gram payload
from 61 MB to about 98 MB. Sharded by initial letter as now, so a reader still
loads one shard, not the index.

## The bridge — evidence, not hope

An English phrase and a Greek phrase both resolve to a set of Bekker columns.
If the same idea stands in both, their column sets should overlap. Tested on
ὡς ἐπὶ τὸ πολύ and "for the most part":

**As a rule it fails.** 125 columns hold the Greek, 56 hold the English, only
22 hold both — 18% of the Greek columns, 39% of the English ones. With 28
translators rendering one phrase a dozen ways, no threshold will make this a
reliable equivalence.

**As a ranking it works.** Rank Greek phrases by how concentrated they are in
the English phrase's 56 columns (columns-in-set over the square root of the
corpus count):

```
26 cols / 230 corpus   epi to polu
22 / 204               ws epi to polu      <- the phrase itself
22 / 215               ws epi to
 6 /  16               ta de pleista       <- a real alternative rendering
 5 /  13               ouq' ws epi to polu <- the negated variant
```

The top three are the target phrase and its substrings; the fourth is a
different Greek expression a translator also renders "for the most part". That
is the feature: not "this means that", but *here are the Greek phrases that
keep company with this English one, commonest first.*

**Caveat: this is one probe on one phrase.** It should be run over a few dozen
known pairs before the bridge is promised to anyone.

## Work

1. **English stream.** Tokenize each segment's English into a per-work stream
   with positions. A phrase must not span a segment edge — the analogue of the
   existing book-edge rule, and natural here since the English is stored per
   segment.
2. **Third stream in stage 8.** Counting, scoring, sharding and the occurrence
   files are stream-agnostic; this is mostly widening `STREAMS`.
3. **Reference resolution.** An English offset resolves to a column, not a
   line — see the limits below.
4. **UI.** A third choice under "Count phrases by".
5. **Explainer.** A section built the way the Greek one now is, on one worked
   phrase.
6. **Phase 2 — the bridge.** For an expanded English phrase, rank the Greek
   phrases sharing its columns. Needs no new alignment data; it is a join
   between two indexes we already hold.

Needs a corpus rebuild, so it pairs with the stage 8 change the forms
checklist already wants.

## Limits to state plainly in the UI

- **28 translators.** A phrase index over the English measures the translators
  as much as the author. The *Works* column already separates the two cases: a
  phrase in 22 works is Aristotle recurring; a phrase in one work is that
  translator's habit. Say so rather than pretend otherwise.
- **Column granularity.** A segment is a whole Bekker column — median 331
  Greek tokens, 476 English words. An English phrase resolves to the column,
  where a Greek phrase resolves to the line.
- **The bridge ranks, it does not assert.** Present candidates ordered by
  company kept, never as a translation.
- **Stopwords will dominate raw frequency** ("of the", "and the"), exactly as
  καὶ τό did on the Greek side. Distinctiveness orders them out, but the
  landing state has to be chosen deliberately.

## Decision, 2026-07-27 (John)

**Build Phase 1 only. The bridge waits until every translation is fully Tier 2
aligned.**

That is the right call and it supersedes the Phase 2 design above. The
column-overlap ranking is a workaround for coarse alignment — it exists only
because a segment is a whole Bekker column. Tier 2 alignment attacks the cause
instead: with the English aligned finely, the bridge stops being a statistical
guess about which phrases keep company and becomes a lookup. Building the
ranking now would mean investing in a technique whose whole purpose is to
compensate for something we intend to fix, and then carrying it afterwards.

Phase 1 stands on its own: an English-only reader gets at the recurring
formulae of the translation and can jump to the passages. Keep the evidence
above — when Tier 2 lands, the 18%/39% column overlap is the baseline that
shows how much the alignment work bought.

See [[aristotle-bekker-alignment-tiers]] for the tier framework.
