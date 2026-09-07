# The commentary layer — plan

*Status: plan only. Nothing here is implemented. Drafted 2026-08-07 from a design session; the formal decision doc (schema with worked examples, adversarially reviewed) is still to come.*

Decision doc: commentary-layer-decisions.md

***The UI is not settled.*** *What is committed below is information architecture — the two-pole model, the data model, the anchoring. Every visual and interaction treatment is direction, not design. The shipped UI must work really well and be slick, attractive, and functional; each UI phase gets its own design pass with prototypes in the live reader before anything is called final. The mockups are an option-space map, not a spec.*

Mockup artifact (five UI approaches, real DA 402a content): https://claude.ai/code/artifact/1fa4f361-269b-499b-a37f-819e950a45d2

Reference shots of ten existing commentary interfaces, read against this plan: https://claude.ai/code/artifact/edded879-cae1-4e6d-83e0-810f4a1482e7

## What this is

A layer of textual commentaries over the corpus: line-keyed philological commentaries (Hicks on DA, Ross on Meta, Newman on Pol, Stewart/Burnet/Grant on EN), lectio-structured commentaries (Aquinas), and eventually the ancient Greek commentators (CAG). Which commentaries are hostable, and when, is mapped in the PD commentary map; copyright state is a first-class property of the data, not an afterthought.

"Lemma" throughout means the commentary sense: the quoted span of source text that heads a note, located by Bekker line — not the dictionary-headword sense the parser uses.

## Governing architecture (decided)

**Two primary modes; the other side is always a supplement panel.**

- **Text-primary**: the normal reader, with commentary as a supplement.
- **Commentary-primary**: the commentary is the book — its own route and TOC — with the base text as a supplement ("peek") scoped to the span under discussion.

Rules that follow:

1. The supplement is always scoped by the primary's position. It is never a free-scrolling second book. Sync flows primary → supplement only; there are no lock-mode matrices.
2. The supplement panel is one component family (right sidebar on desktop, bottom sheet on mobile — the WordPopup/EndnoteSidebar slot), parameterized by content (notes vs. text span) and language setting.
3. The two modes are peers: at any location, one flip swaps figure and ground without losing place. URL carries `(work, location, primary, supplement-config)`.
4. Each pole carries its own language setting. Text-primary: Greek/Both/English as today. Commentary-primary: the commentary's own pair (Latin/Both/English for Aquinas; Greek-only for CAG until its English frees). The peek pane has its own Aristotle-language setting. Two independent language controls per screen is intended, not a bug.

The five mockup approaches reduce to this: A (peek drawer) and E (commentary-primary) are the two poles and are core. B (margin rail) and D (interleave) are optional presentations of the text-primary supplement, addable later without touching the model. C (facing pane with sync modes) dissolves.

## Display state machine (working model — interaction details unsettled)

Commentary display in text-primary mode is one setting: **`off → ticks → persistent`**.

- `off`: no commentary UI.
- `ticks`: gutter dots on annotated lines (default once a commentary is selected). Clicking a dot opens an ephemeral peek with parser-popup semantics: click-off closes.
- `persistent`: commentary stays in view and tracks scroll-spy. Presentation is the layout's decision, not the user's: margin rail on wide screens, docked drawer below the width threshold, collapsed strip on phones. "Pin" is not a separate feature — it is the ticks → persistent transition offered in context.

Interplay with the parser popup: distinct click domains (word → lexicon; gutter/margin → note), one supplement slot, last-click wins. A word lookup displaces a pinned note; closing the parser returns to it. Only `persistent` ever negotiates standing real estate.

## Translator commentaries: shown on all translations (recommended)

Commentary keyed to Greek lemmata is commentary on Aristotle, not on the commentator's English; it displays against every translation. Two caveats carried in the data:

- Word-level English highlighting only works on the commentator's home translation; elsewhere fall back to line-range indication via the existing bekker tick offsets.
- Notes about the translation itself ("I render X as Y…") carry `appliesTo: translation` and are suppressed or badged when a different translation is displayed. Boundary rule: footnotes anchor to a translation; commentary anchors to the work.

## Aquinas and the divisio textus (decided)

- Aquinas segments by lectio. His divisio textus — the hierarchical division each lectio opens with — is transcribed as a tree: nodes `{label, range: {column, lo, hi}, children[]}`, leaves at lemma spans. Aristotle's own commentator does the anchoring.
- The tree is one structure with three presentations: an expandable/collapsible **outline page** linked from the work's homepage; the commentary reader's **TOC rail**; a **"you are here" breadcrumb** over the Bekker spine, visible from either pole.
- Clicking a divisio node lands in the commentary reader (the lectio stating that division). Jumping into Aristotle happens from lemma citations inside the lectio view.
- The commentary-primary reader is the existing reader recursed: seg-row grid, view chips, mobile collapse, pointed at Latin|English instead of Greek|English. The Latin morphology packs built for the sibling readers make a Latin word-popup plausible.
- New pipeline need: Latin–English alignment at lectio/paragraph grain (coarser than Bekker-line work). Existing alignment-verification discipline applies.

## Data model direction

- Per-work `commentaries.json` manifest. Each entry: commentary id, type, language streams, copyright state per stream, home translation if any, routes.
- Notes keyed by Bekker range `{column, lo, hi}` with `type: lemma | lectio | essay | continuous`. Lemma text is display metadata, never the join key (the commentator's edition may differ from ours; range always resolves, word-match is best-effort).
- Lectio-type notes may carry a `divisio` tree.
- Commentary content holds parallel language streams from day one. Retrofitting bilingualism later is the migration that hurts.
- Copyright gates per stream, not per commentary (Aquinas Latin PD forever; English translations individually fragile; CAG Greek hostable now, English locked to ~2083 → permanent Greek-only mode with link-out). The gating and pre-deploy leak-check machinery that protects gated translation prose extends to commentary prose.

## AI translation pilot (agreed in principle)

Because CAG English is locked for decades: pilot an AI translation of one Greek commentator from the PD CAG Greek. Candidate: Themistius's DA paraphrase, Book 1 — continuous prose, moderate size, maps to Bekker spans, and exercises the exact schema E needs.

Bright line: a "modified" Bloomsbury/Sorabji translation is a derivative work and is off the table; no label cures that. The published translation is used only as a private **reference check**, under this discipline:

- Generation never sees the reference: translation passes work from the CAG Greek alone, plus a fixed glossary and style sheet. Provenance chain is provably Greek → English.
- The reference appears only in a separate verification pass that flags divergences of meaning, not wording. Flags go back to re-translation from the Greek.
- Divergence flags are data: some are AI errors, some are genuine ambiguities worth footnoting.
- Full audit trail: passes run, flags raised, changes made.
- Standard technical renderings (ἐντελέχεια → "actuality") are scholarly convention and fine; sentences are not.

Labeling: a visible "AI TRANSLATION" badge plus a methods note stating what it is, how it was checked, and why it exists (copyright), with a correction invitation. Manifest stream type `ai-translation` with model, date, method version. Never gated; never disguised; date-stamped and revisable.

## Ingestion QA gates

- Lemma-to-Bekker resolution: quoted span must match our Greek at the stated line; mismatches are flagged, never forced.
- Divisio extraction: tree ranges must tile the text without gaps or overlaps (machine-checkable).
- AI-translation pipeline: verification passes as above.
- Same honesty standard as alignment verification: "confirmed" names the checker.

## Phasing

1. **Schema first, against the hardest real cases**: write actual JSON for a few real Hicks notes and one Aquinas lectio (with divisio) before any UI work. If one schema holds both, everything else stays open.
2. **A (peek drawer + ticks)**: universal foundation; every later presentation degrades to it. Preceded by its own design pass — prototyped in the live reader, judged against the slick/attractive/functional bar, iterated before shipping.
3. **E (commentary reader + divisio outline)** for Aquinas. Same design-pass discipline.
4. **Persistent presentations** (rail/drawer forms) as judgment calls once real reading experience exists.
5. **AI-translation pilot** can run parallel to 2–3; it is pipeline work, not UI work.

## Unknowns register

Surfaced 2026-08-07. Suggested defaults are unratified. Items 2, 3 and 10 were answered by a licensing pass on 2026-08-08 (Grok research, spot-checked against the GitHub API, the TEI headers themselves, and the repositories named); the resolutions are inline below. None of it is legal advice.

### Unregistered risks (found in blindspot pass)

1. **Ingestion cost dominates the feature and is unestimated.** Hicks is ~600pp of mixed polytonic Greek and English; Newman is four volumes. Digitizing one line-keyed commentary likely exceeds all v1 UI work. *Default: before any UI design pass, run one chapter of Hicks end-to-end (OCR → schema → QA) and extrapolate.*
2. **CAG digital source may be legally unusable.** The Berlin editions are PD, but TLG-derived text (the Diogenes path) carries a restrictive license. Hosting CAG Greek may require OCR from PD scans, which changes the pilot's cost. *Resolve before choosing the pilot commentator.*

   **Resolved 2026-08-08 — hostable, by two routes.** TLG stays off the table: its terms forbid redistribution, so the Diogenes path cannot feed the site. But Open Greek and Latin's [`cag-dev`](https://github.com/OpenGreekAndLatin/cag-dev) carries TEI-XML for all 23 volumes, and each file's `<availability>` states CC BY-SA 4.0 — the repo itself has no LICENSE file, so the header is the grant we would be relying on. Themistius on *De Anima* is inside `commentaria_05_1-3.xml` (Heinze's text with Spengel page marginals, ~5,600 lines), not a separate file. The text is dev-grade OCR with errors in the chapter headings themselves (ΠΑΡΑΣΡΑΣΙΣ for ΠΑΡΑΦΡΑΣΙΣ) — a correction pass is part of the cost either way. It carries `<pb>`, `<lb n=>`, marginal page numbers and a footnote apparatus, but no Bekker anchors. Last push 2016. The alternative is OCR of the PD Berlin scans, which owes nothing to anyone. See item 17.
3. **Aquinas's lemmata are Moerbeke's Latin, not Aristotle's Greek.** Divisio-to-Bekker mapping needs the editorial apparatus hop; and the critical Latin editions (Leonine In De Anima, 1984) are in copyright — the PD Latin is an older edition (Parma/Vivès), and Corpus Thomisticum has its own terms. "Latin is PD" is true of the text, not of every edition.

   **Confirmed 2026-08-08.** Leonine is in copyright well into the century; Parma (1852–73) and Vivès are PD with scans on archive.org; Corpus Thomisticum claims all rights reserved on its electronic Latin, so we may link and quote but not mirror. English translations are the softer spot: Foster–Humphries (Yale, 1951) falls in the 1929–1963 renewal window and its status is genuinely unresolved — being freely hosted elsewhere is not evidence. The Moerbeke-to-Bekker apparatus hop is unaffected and still ours to build.
4. **English-only gutter dots inherit bekker-tick quality — and English-only is the mobile default.** Where ticks are `estimate`, dot placement will be visibly wrong in the most-used view. *Default: tick quality becomes a per-work precondition, or dots degrade to paragraph grain where ticks are estimated.*
5. **Deploy and search scale.** Commentary prose could rival the corpus in size, hitting two existing sore spots: gh-pages deploy strain and search-shard growth. *Get a size estimate before phase 2, whatever the indexing decision.*
6. **Lemma highlight sits on parser territory.** The highlighted span is made of clickable word tokens; event interplay with the word-popup (capture-phase handlers, close-path) must be prototyped early in the A design pass.
7. **Edition variants will trip the lemma-match gate legitimately.** Hicks printed his own Greek; CAG authors quote a different Aristotle. *Default: three verdicts — `matches / error / variant-reading` — with variants displayable as scholarly content.*

### Known open questions

8. **Which ingestion stack owns commentaries** — Python pipeline or Workbench (which already has endnote import modes)?
9. **Acceptance criteria for the AI translation** before a full run: sample review by John plus a divergence-rate threshold from the reference check.
10. **PD-map caveat rows** (Poste, Grant, Susemihl–Hicks, Cope, G. R. T. Ross, Butcher, Margoliouth) still need renewal-record verification before hosting. **Cleared 2026-08-08:** every one of them was first published before 1930 — Poste 1866, Grant 1857/1885, Susemihl–Hicks 1894, Cope–Sandys 1877, Ross 1906, Butcher (editions through 1922), Margoliouth 1911, and Hicks *De Anima* 1907 — so all are PD in the US on publication date alone. No renewal search needed, and the UK/EU terms expired decades ago too.
11. **Corrections channel** for the AI translation (presumably GitHub issues; name it in the methods note).
12. Does commentary prose join the search index? (Third searchable stream; gating implications.)
13. Are notes citable/exportable like text?
14. Ratify the "all translations" recommendation above.
17. **Which CAG Greek source — and does share-alike propagate?** (New, from the 2026-08-08 licensing pass.) Building on OGL's `cag-dev` is the cheap route, but BY-SA carries forward: our corrected text inherits it, and an AI translation made from that Greek plausibly does too, which would set the license on the pilot's output. OCR'ing the PD Berlin scans ourselves costs a pipeline run and owes nothing. The choice is a licensing decision, not a sourcing convenience, and it should be made before the pilot starts rather than after there is text to relicense.
18. **Sorabji/Bloomsbury and the Leonine Latin are confirmed blocked** (~2082 and ~2079 respectively), which fixes the AI pilot as the only route to English CAG. Nothing to decide; recorded so the question is not reopened.

### Unwritten standards (to externalize before the A design pass)

15. **Actual audience is unknown** — no analytics; the persona table is hypothetical. *Default: design for John's own reading practice first, and say so.*
16. **What "slick" means.** Strong aesthetic bar exists but is not yet spec. *Default: name 2–3 existing readers to react to (Scaife dual panes, Sefaria panels, print Clarendon conventions) and extract the implicit rules; a prior-art survey is underway to feed this.*

## Post-survey design suggestions

*Appended 2026-08-08 at John's direction, from the design conversation that followed the prior-art survey. Direction, not design — same status as everything above; each still faces its phase's design pass. Wording here is a fuller statement of points made in that session.*

1. **The line number is the locus hub.** The Bekker number in the gutter is already the one stable, meaningful handle on the page; make it the affordance. Clicking it opens a small menu for that locus: copy citation, link here, notes at this line, which commentaries cover it. This gives the survey's "deep link + share of (work, Bekker, commentary, mode)" a home that costs no new chrome.

2. **Annotation-density minimap.** A thin strip beside the scrollbar showing where the selected commentary is dense and where it is silent across the whole work. It answers the coverage-honesty gap the Scaife review exposed (uneven coverage presented as if uniform), and it turns "find the heavily discussed passages" into a glance rather than a hunt.

3. **Weight-encoded ticks.** Gutter dots are not uniform: size or opacity encodes the weight of what is behind them, so a one-line gloss and a two-page essay do not look identical. This is the discipline that keeps `ticks` from degrading into Genius-style saturation, where every span is marked and none is informative.

4. **Graded peek → pin → flip.** The handoff between the two poles is a continuum, not a toggle buried in a menu: the ephemeral peek offers "keep this open" (→ `persistent`), and the persistent note offers "read this commentary" (→ commentary-primary), each step proposed in context from the one before, place preserved throughout. The flip stays available directly for people who know they want it.

5. **URLs as citations.** The address bar carries `(work, locus, commentary, mode)` — e.g. `?comm=hicks#402a2` — so copy-link yields something a student can paste into a paper and a reader can open to exactly this view. Sefaria's `with=` is the precedent; the requirement is that every state worth returning to is addressable.

6. **Coverage bars on the work homepage.** Each work's homepage lists the commentaries that exist for it with their PD-map state — host now / unlocks in YYYY / link out — and a small bar showing what Bekker range each actually covers. This makes the copyright map user-facing information instead of internal metadata, and sets expectations before a reader goes looking for notes that are not there.

7. **Interleave subordination constraint.** If interleave is ever built (it is optional, phase 4 at the earliest), notes must be typographically subordinate to the base text: the text keeps its measure and weight, notes are indented and smaller, and no note breaks the integrity of a Bekker line. This is a hard constraint, not a preference — the ctext reports in the survey show what happens when base and note carry equal visual weight.

8. **One-frame peek latency budget.** The peek opens within one frame of the click, from data already in memory: commentary for the visible span ships with or alongside the work shard, and nothing about opening a note waits on a network round-trip. Most of what reads as "slick" is latency; this is the cheapest place to buy it and the most expensive to retrofit.

## Non-goals for v1

Multi-commentary compare views; cross-commentary "also treated by" links; CAG beyond the single pilot; sync-mode machinery (lock-to-lemma/lock-viewport); commentary annotations by users.
