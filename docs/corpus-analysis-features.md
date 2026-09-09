# Corpus analysis — possible reader features

*Status: scoping survey; features 1, 2, 5 and 8 have since shipped (marked in the
tables below). From the 2026-08-18 session that started
as a stylometry experiment (`analysis/`, branch `claude/greek-statistical-analysis-tihpcs`)
and turned into a survey of what statistical/semantic methods could give the reader.*

The stylometry itself is research output, not a site feature. What follows is the
part that could reach readers.

## The governing constraint

TLG terms forbid redistribution — already settled doctrine here (`README.md`,
`commentary-layer-plan.md` item 17). But that ruling is about **strings**. Derived
**numbers** — a frequency, a rank, a first-attestation date, a citation like
"Il. 2.204" — are facts about Greek, not the TLG's expression of it.

**Rule of thumb: compute on the disc, publish an integer.** No shipped artifact
should let anyone reconstruct TLG text from it.

Not a lawyer's opinion. The licence governs.

## Features that need the TLG disc

| | What a reader gets | Cost | Notes |
|---|---|---|---|
| **1. Is this word technical?** | Popup says *"coined by Aristotle"* vs *"ordinary word used technically"*, plus first attestation | **Low** | **Shipped** — offline counter PR #88, rulings PR #89–90, reader wiring PR #94 (`spec-word-distinctiveness.md`). Highest value-for-effort. One number per lemma, one shard, no new UI. ἐντελέχεια (139× in corpus, ~0 before him) vs οὐσία (1,077×, ordinary Greek for "property") |
| **2. Quotation detection** | Unmarked quotations get citations — *Meta.* Λ ends on *Il.* 2.204 with no attribution | Medium | **Shipped** — matcher PR #88, curated *Metaphysics* pilot PR #91, marginal siglum PR #94 (`spec-quotation-detection.md`); only *Meta.* carries a quotations file so far. Ship the citation, link out to Perseus for text. Fuzzy: he quotes from memory, needs a human pass. Also surfaces Presocratic fragments, which survive *because* he quotes them |
| **3. Reception counts** | "recurs 5× in Aristotle, 40× in the commentators" | Medium | **Parked.** Scholar's instrument, not a reader feature. A lookup, not a second index — the phrase list already exists in stage 8 |
| **4. CAG anchoring oracle** | — (enabler) | Medium | The commentary layer takes CAG text from OGL `cag-dev`: dev-grade OCR, no Bekker anchors. Use the TLG's clean CAG to *compute* the anchor table; ship OGL text + our anchors. Turns a manual project into a mostly-automated one. Highest leverage, but only once that layer moves |

## Features that need no TLG at all

| | What a reader gets | Cost | Notes |
|---|---|---|---|
| **5. Live LSJ citations** | Every `Arist.` citation in an LSJ entry becomes an internal reader link | **Low** | **Shipped** — PR #81 (`spec-lsj-citations.md`). Before it, `stage5_lsj.py` rendered `<bibl>` as an inert `.lsj-bibl` span. Pure parsing. Was the best hours-to-value item on this page |
| **6. Contextual sense** | *"here: responsible, answerable — the moral sense"* instead of LSJ's full sense list | Medium–high | Demonstrated on αἴτιος: *EN* 1114b (moral) vs *Phys.* 197a (efficient cause), identical grammar. See §Limits — the machine groups, a scholar labels |
| **7. Parallel passages** | Same doctrine in different words, across works | Medium | *EN* 1114b / *EE* 1223a on responsibility surfaced with nothing asked for. String search cannot do this; the corpus is very self-referential |
| **8. Text-quality gate** | — (pipeline QA) | **Low** | **Shipped** — PR #82, armed in PR #85 (`spec-text-quality-gate.md`). Breathing marks in orthographically illegal positions: **First1K 3.00/10k vs Perseus 0.92/10k**. Catches run-together words (`ποιοῦσιναἱ`, `τὴνφορὰνἔφαμεν`) and displaced glyphs. Worth a build gate regardless of any feature here |

## Limits any of these inherit

Established the hard way on αἰτία/αἴτιον this session. Anything touching Greek
morphology inherits all of it.

- **Accent-stripping merges distinct words.** The `analysis/` feature set collapses
  ἡ (art.) / ἥ (rel.) / ᾗ / ἦ into one string — 19,979 occurrences under one
  "feature". Likewise ἀλλά ("but") = ἄλλα ("other things"), εἰ ("if") = εἶ
  ("you are"). Uniform across works, so noise rather than bias, but "161 function
  words" was never true.
- **Syncretism.** αἴτια (n. pl.) and αἰτία (f. sg.) differ only by accent —
  18.7% of αἰτι- tokens were decided by accent placement alone, in texts with
  measurable accent corruption.
- **No backup from verb agreement.** Neuter plural subjects take singular verbs
  (τὰ ζῷα τρέχει), so verb number cannot disambiguate the above.
- **Agreement cuts both ways.** A feminine subject forces αἰτία (ἡ παρουσία
  αἰτία, *Phys.* 195a); plural/mixed subjects force neuter αἴτια (ἡ παρουσία
  καὶ ἡ στέρησις αἴτια, *Meta.* 1013b). Raw gender counts are contaminated in
  both directions; only substantival (articular, non-predicated) uses are clean.
- **Absences scale; ratios don't.** "Zero in 830,000 words" strengthens with
  corpus size. "13% vs 71%" accumulates every premise underneath it.
- **Answer keys are the only automated defence.** The common-books study caught
  its own failures because seven undisputed books *had* to classify correctly.
  Studies with no known-answer control rest on plausibility — which is exactly
  what these errors preserve.

## Known traps

Everything below cost real time this session. All verified against the data.

### Corpus / TEI

- **Bekker anchoring is not uniform.** Perseus `grc2` carries real
  `<milestone unit="page" resp="Bekker">`. Most First1K files carry **no Bekker at
  all** — only `<pb>`, which is the *volume page* of Bekker's 1837 Oxford reprint
  and is not a citation. A few (Physics, De caelo) mark columns as
  `<note type="marginal">184a</note>`. **The stable unit across the whole corpus
  is the div hierarchy (book/part/chapter), not Bekker.**
- **Any note-stripping pass deletes those marginal columns before you see them.**
  Promote them to milestones first, then strip notes.
- **A milestone `n=` without an a/b side is not a Bekker column.** SE has
  milestones numbered 1–25 that are section numbers; they silently became
  "columns". Require `^\d+[ab]$`.
- **Marginal columns can run backwards** (a stray note gave Physics a "5a" before
  184a). A printed text runs forward — guard on monotonicity.
- **tlg001 holds BOTH Analytics.** Split on `<div subtype="book" n="priora">` /
  `n="posteriora"`.
- **tlg918 is De Juventute + De Respiratione combined.** Using it *and* tlg018 +
  tlg037 double-counts ~110k characters.
- **Categories, De Interpretatione and the Isagoge have no Greek TEI in
  `sources/`** — they come from the Diogenes/TLG export and need the disc.
  **Magna Moralia is absent entirely** (no Bekker divs).

### Greek text handling

- **Five different characters mark elision**: U+02BC, U+2019, U+0027, U+1FBD,
  U+1FBF, U+1FFD. **U+1FBF (psili) alone accounts for 6,430** and was the one
  missed first pass — δ᾿ stayed a separate type from δέ, deflating δέ by ~1,700.
- **The Greek Unicode block contains punctuation.** A naive `[Ͱ-Ͽ]+` class glues
  ano teleia (U+0387) and the Greek question mark (U+037E) onto tokens. Match
  letters only, then require at least one Greek letter.
- **First1K files carry superscript apparatus markers glued to words** (δε¹,
  καί²). Unicode category `No`, so `\w` matches them.
- **Accent position, not letters, distinguishes the declensions.** αἴτιον (2nd,
  accent on letter 1) vs αἰτία (1st, accent on letter 3); αἰτίων (2nd, acute) vs
  αἰτιῶν (1st, circumflex). Strip accents and you merge two words.
- **Accent-stripping merges function words too** — see §Limits. Check any
  feature list for ἡ/ἥ/ᾗ/ἦ-type collisions before trusting it.

### Statistical method

- **Do not use "one edit from a frequent word" as an OCR detector.** In a
  heavily inflected language nearly every rare form is one edit from a common
  one. It scored First1K and Perseus identically (116 vs 105 per 10k) — it was
  measuring inflection. Use orthographic *impossibility* (breathing marks in
  illegal positions) instead: that separated them 3.00 vs 0.92.
- **Word-window collocation tests must check case.** A ±2-token window for "δια"
  counted διὰ τοῦ αἰτίου (genitive, "by means of the cause") as the accusative
  frame. Five of six apparent counterexamples were false positives.
- **Any per-book distance metric needs a length correction.** Across 72 books,
  raw Burrows's Delta correlates **−0.49** with log book length. Rank by raw
  distance and you rank by shortness — Metaphysics α *elatton* looked like the
  treatise's biggest outlier until corrected, then became unremarkable.
- **Chunks cut from one work are contiguous and not independent.** Chunk-level
  p-values are optimistic; prefer a book-level exact test.

## Suggested order

1. **(5) LSJ citation linking** — no TLG, low cost, closes an obvious loop. *Shipped.*
2. **(8) text-quality gate** — no TLG, low cost, protects everything else. *Shipped.*
3. **(1) word distinctiveness** — needs the disc, but offline and self-contained. *Shipped.*
4. **(4) CAG anchoring** — when the commentary layer moves.

(6) and (7) are the interesting ones and the least certain; they want a prototype
before a plan.
