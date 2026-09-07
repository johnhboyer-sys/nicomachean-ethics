# Corpus expansion — adding Aristotle works

Working doc for the 2026-06-15 push to add as many works as feasible. Branch
`feat/complete-works-da` (the registry-driven multi-work site). Recipe:
[`ADDING-A-WORK.md`](../ADDING-A-WORK.md). NB: the just-shipped **translation
aligner lives on `main`, not here** — these works use the Perseus Bekker-
milestoned English path (NE-grade) or the First1KGreek + MIT-archive path (DA).

## Data on hand
- **Greek spine:** whole-author Diogenes export cached at
  `build/export/Diogenes-Resources/xml/tlg/tlg0086NNN.xml` (works 001–056). No
  TLG re-export needed. Spine needs `type="Bekker-page"` divs + numeric `<l n>`.
- **Perseus TEI** (grc2 + eng2, both Bekker-milestoned) available for 9 Aristotle
  works: 003, 009, 010(NE), 025, 029, 034(Poetics), 035, 038, 045.
- Network reachable; vendor TEI into `sources/`.

## Feasibility (Bekker-lineated Greek + a chapter/English source)

### Tier A — Perseus grc+eng (best, reuses NE path)
| TLG | slug | work | Bekker cols | books | status |
|---|---|---|---|---|---|
| 010 | EN | Nicomachean Ethics | 176 | 10 | ✅ built (shipped on main) |
| 002 | DA | De Anima | 68 | 3 | ✅ built (First1K+MIT path) |
| 034 | Poet | Poetics | 32 | 1 | ✅ built + registered |
| 045 | Virt | De virtutibus et vitiis | 6 | 1 | ✅ built + registered as `VV` (spurious) — shipped 2026-07-09, PR #27 (`manifests/VV.yaml`, `shared/lib/works.ts`, `DEPLOY-STATUS.md` 2026-07-09) |
| 029 | Oec | Oeconomica | 22 | 3 | ✅ built + registered (spurious) — shipped 2026-07-08, PR #21 (`manifests/Oec.yaml`, `shared/lib/works.ts`, `DEPLOY-STATUS.md` 2026-07-08); see `dubious-works.md` |
| 038 | Rhet | Rhetorica | 133 | 3 | ✅ built + registered (Freese primary + Roberts secondary) — live; `/Rhet` ch-2-1 verified in the 2026-07-10 deploy (`manifests/Rhet.yaml`, `shared/lib/works.ts`, `DEPLOY-STATUS.md`) |
| 035 | Pol | Politica | 182 | 8 | ✅ built + registered — live; public build serves Jowett + Ellis from `manifests/Pol-public.yaml`, Rackham gated (`shared/lib/works.ts`, `DEPLOY-STATUS.md` 2026-07-09 "Pol/EE/Meta serve Jowett/Solomon/Ross publicly") |
| 025 | Meta | Metaphysica | 228 | 14 | ✅ built + registered — live; public build serves Ross from `manifests/Meta-public.yaml`, Tredennick gated; `/Meta/book/7/` live-verified 2026-08-22 (`shared/lib/works.ts`, `DEPLOY-STATUS.md`) |
| 009 | EE | Ethica Eudemia | 72 | 8* | ✅ built + registered as 5 Eudemian-proper books with the IV–VI gap annotated in the reader (`manifests/EE.yaml` / `EE-public.yaml`, `shared/lib/works.ts` `missing: IV–VI`); public build serves Solomon (`DEPLOY-STATUS.md` 2026-07-09). Was: ⚠ shares books IV–VI with NE V–VII; defer |

### Tier B — Greek only (need First1KGreek chapters + MIT-archive English)
Big biological/logical works with Bekker Greek but no Perseus TEI: Historia
animalium (306), Problemata (218), Physica (172), Analytica (154), De gen.
animalium (150), Topica (130), De partibus animalium (118), Meteorologica (106),
De caelo (92), De gen. et corr. (50), Sophistici elenchi (42), Categoriae (30),
De interpretatione (18), De motu animalium (14), De memoria (9), etc.
*Shipped (verified 2026-09-07):* every work named here except Problemata now has a
`manifests/<Id>.yaml` and a `shared/lib/works.ts` entry (HA, Phys, APr/APo, GA, Top, PA,
Mete, Cael, GC, SE, Cat, Int, MA, Mem) and was in the full 41-work `build:public` deploy
of 2026-07-13 (`DEPLOY-STATUS.md`). Problemata is still unbuilt.

### Excluded
Athenaion Politeia (003 — not Bekker-paginated), Magna moralia / Protrepticus /
fragments (no Bekker divs).

## Strategy (per John, 2026-06-15)
- **Authentic works only** — drop works of dubious authorship: Oeconomica,
  De virtutibus et vitiis, Problemata, De mundo, Mechanica, Magna Moralia,
  Rhet. ad Alexandrum, the minor spuria. (Oec manifest deleted.)
- **Big works first** — they drive interest. **Metaphysics is the priority.**
- **Gradual git rollout**, one work per commit/checkpoint.
- **Metaphysics should feature multiple translations** to showcase the project's
  alignment value-add.

## Aligner port (prerequisite for multi-translation)
The translation aligner shipped on `main` only. To show any *unmarked* PD
translation with real Bekker ticks, port `pipeline/aristotle_pipeline/align/`
here and generalize it (currently NE/Rackham-hardcoded) to: work-scoped, with the
Bekker-milestoned Perseus eng as the alignment *reference*. Then each work can
carry N translations: the milestoned one (if PD) shown directly + unmarked PD
ones aligned to it.

## Metaphysics (025) — target, 14 books, chapter_subtype: section
Translations:
- **W. D. Ross (1924)** — PD, gold standard, MIT archive (unmarked → align).
- **Hugh Tredennick (Loeb 1933)** — Perseus eng2, Bekker-milestoned. Great
  alignment *reference*, but **US copyright until 2029** → scaffold only, do not
  publish as display text unless licensing cleared.
- **J. H. M'Mahon (1857)** — PD, archaic (optional 3rd).
DECISION (John 2026-06-15): **display Tredennick + Ross.** PD risk accepted for
now; the Tredennick TEI is "clutch" (Bekker-milestoned). Build it in but keep it
toggleable so Tredennick can be withheld from the public deploy until John clears
the risk (or it goes PD in 2029). → Metaphysics mirrors NE: Tredennick = primary
(perseus_tei, real ticks from TEI), Ross = secondary (aligned via aligner, with
Tredennick as the Bekker reference). Aligner port: YES.

## Build steps per work
1. Vendor TEI (done for 009/025/035/038; 029/045 dropped as spurious).
2. `manifests/<SLUG>.yaml` (copy Poet/DA; seed Bekker book ranges, stage2 corrects).
3. `python -m aristotle_pipeline all --work <SLUG>`; spot-check canonical anchors.
4. Register in `app/src/lib/works.ts`; `npm run build`; commit.

## Remaining authentic Tier-A (after Metaphysics)
Politica (035, 8 bk), Rhetorica (038, 3 bk). Eudemia (009) — shares books with NE.
*Shipped (verified 2026-09-07):* all three are built, registered and live — see the Tier A
table above for the evidence per row (`manifests/Pol.yaml`, `Rhet.yaml`, `EE.yaml`;
`shared/lib/works.ts`; `DEPLOY-STATUS.md`).

## Aligner port — status ✅ COMPLETE
Package ported + generalized (110de85), then wiring finished this session:
1. ✅ `stage1_ross.build_chunks(spine, chapters, prose, align_map=None)` — real-
   tick logic restored from main (`_load_align_map(work_id, version_id)`,
   `_real_ticks`, anchor-based column cuts; `_REAL_CONF={certain,reliable}`).
   `run()` reads `english.secondary` via `reference.default_target` (NE Ross
   fallback) for the prose + version id, loads `{work}_{version}_map.json`.
2. ✅ `__main__._stage1` (else branch): after `stage1_english.run`, calls
   `align(work_id, version_id, target_prose=prose)` before `stage1_ross.run`.
3. ✅ `EN.yaml` `english.secondary` block (id ross, dir ross, books 10).
Regression: EN build is byte-identical to shipped main (276 real ticks among
1327; stage2 PASS, stage3 key_failures=0).

## Metaphysics build — ✅ BUILT + REGISTERED
- Ross vendored: MIT archive `metaphysics.<n>.<roman>.html` per book →
  `sources/meta-ross/book-01..14.html` ("Part N" markers, parsed with marker
  `part`). 142 chapters, counts match grc TEI sections exactly.
- `manifests/Meta.yaml`: tlg_work 025, Tredennick (perseus eng2) primary via the
  perseus path, Ross secondary (meta-ross), grc_tei section chapter override, 14
  canonical Bekker book ranges (derived from TLG line seq cut at grc book divs).
  `expected_line_gaps`: 993a (28 skip) + 1029b (Z.1 transposition, non-monotonic
  3..12,1,2,13..). proper_names: Socrates/Anaxagoras/Empedocles (Plato omitted —
  Tredennick over-supplies it in Books M–N).
- Enablers: `config.perseus_eng()` generalized (work.english_source / tlg_work,
  no longer tlg010-hardcoded); stage3 strips `|` verse-divider (Empedocles frr.).
- `all --work Meta` clean: stage2 PASS, key_failures=0, 14 books emitted.
  Spot-check Λ/12 1072a25 ἔστι τι ὃ οὐ κινούμενον κινεῖ ✓ (unmoved mover; Ross
  real tick at 1072a1). Registered in works.ts (Greek-letter book labels). App
  builds, all 14 pages prerender.
- ⚠ Tredennick US-copyright to 2029 — built in as primary but withhold from the
  public deploy until John clears (toggle/registry gate still TODO if deploying).

## Politics (035) — ✅ BUILT + REGISTERED
8 books. Rackham (perseus eng2) primary, Jowett (MIT archive) secondary aligned
via Rackham. Spot-checks + warts:
- **Chapters via section milestones, not divs.** Politics' grc TEI has NO chapter
  `<div>`s — chapters are `<milestone unit="section" resp="Ross">` (103, reset per
  book; counts match traditional chapters 13,12,18,16,12,8,17,7). Generalized
  `stage1_chapters`: `chapter_marker: milestone` reads section milestones, carries
  each milestone's Bekker (col,line) as an authoritative fallback when the opening
  text's orthography diverges from the spine (3 chapters needed it).
- **Jowett markers are "Part <Roman>"** → new `part_roman` marker + Roman→int in
  `stage1_ross`.
- **Jowett Book 5 = 11 chapters to Ross's 12** (Jowett folds/omits the closing
  Plato critique 1315b10ff). Per John: keep Ross's numbering; Ross-ch12 of book 5
  carries no Jowett overlay (degrades to empty, no crash).
- **Rackham TEI can't pair 8 columns**: omits Bekker page milestones for
  1254b/1279a/1297a/1297b/1314b (English merged into preceding column) and assigns
  book-straddling 1301a/1323a/1337a to one book. New manifest key
  `alignment_allow_unmatched` lists them so stage2 surfaces-but-tolerates;
  aligner `reference.resolve_idx` snaps missing cols to the preceding chunk.
- stage3 now strips ‘ (U+2018) opening-quote (poets quoted in Politics).
- Clean build (stage2 PASS, key_failures=0). Registered in works.ts (Roman I–VIII,
  Rackham+Jowett). App prerenders 8 pages. ⚠ Rackham US-copyright ~2027 — withhold
  from public deploy like Tredennick.

## Rhetoric (038) — ✅ BUILT + REGISTERED
3 books, single translation. **Freese (Loeb 1926) is public-domain** (1926 works
entered US PD in 2022) → first new work that's fully **deployable**. Chapters are
`<div subtype="chapter">` (60 = 15+26+19), div path. Notes:
- **Secondary made optional.** `__main__._stage1` only aligns/chunks a secondary
  when the manifest declares `english.secondary`; else primary-only. It also
  clears a stale `build/stage1/ross_chunks.json` at entry (single-work scratch)
  so a prior work's overlay can't leak into stage7 — latent bug, now fixed.
- **No usable PD secondary:** MIT's Roberts uses a coarse non-standard part
  division (8/16/15 vs 15/26/19) that won't chapter-anchor; omitted.
- **Div path got the Bekker-position fallback too.** `_chapter_openings` now
  returns (book,chap,opening,col,line) from each chapter div's first line
  milestone, so a chapter whose opening orthography diverges (Rhet II.3 had two
  words fused with no space in the TEI) still pins via its milestone.
- Freese's TEI places the I/II + II/III book divisions one column before the
  Greek → 2 unpaired Greek segs + 2 unpaired English chunks; `stage2` allowance
  now covers english_only too. `expected_line_gaps`: 1377b(13-15), 1403b(4-5).
- Clean build (stage2 PASS, key_failures=0); registered (Roman I–III, Freese).
  App prerenders 3 pages; home index now lists all 6 works.

## Categories (006) — ✅ built + registered (THREE translations, 2026-06-16)
First work with **three parallel translations**, all keyed to Bekker via the
**Bekker-stamped guide** approach the user asked for:
- **Edghill** (1928, PD) primary · **Taylor** (1812, PD) secondary · **Ackrill**
  (1963, *US-copyright*) third — Ackrill is the alignment guide AND a displayed
  translation, gated out of the public build.
- **New pipeline capabilities** (all manifest-gated, prior 6 works regression-pass):
  - `chapters.source: explicit` — chapter divisions declared as Bekker starts in
    the manifest (`stage1_chapters.extract_chapters_explicit`); no grc TEI needed.
  - `english.third` + per-translation `anchors` on secondary/third — the archive
    overlay path (`stage1_archive.build_overlay` / `_inject_real_ticks`) now gives
    a secondary/third its own **dense real Bekker gutter** from a hand-keyed
    anchors file, not just interpolation. stage7 emits a `third` overlay.
  - `add_bekker_gutter(dense=…)` — a densely-anchored primary ticks at every
    resolved anchor line, not just the 5-line cadence (gated; Rackham/TEI works
    keep their cadence — EN regression-identical).
- **Keying:** Ackrill's 93 per-paragraph Bekker stamps are authoritative; Edghill
  & Taylor were aligned to those 93 points (one verbatim anchor phrase each per
  point). Resolution: Taylor 93/93, Ackrill 93/93, Edghill 91/93 (2 near a column
  edge interpolate). 15 chapters, Bekker 1a–15b, 12 `expected_line_gaps`.
- **Gating:** `Cat.yaml` (3 translations, local) + `Cat-public.yaml` (Edghill +
  Taylor only — Ackrill text absent from data/search). Registry: `ACKRILL` entry
  in works.ts is behind a compile-time `HIDE_PRIVATE` (PUBLIC_HIDE_PRIVATE=1) so
  the public bundle drops it entirely. Verified: public dist has no "Ackrill".
- Clean build (stage2 PASS, key_failures=0, token match 99.9%). Frontend: 3rd
  translation slot in Reader (picker + solo render); Compare stays Edghill+Taylor.

## De Interpretatione (017) — ✅ built + registered (2026-06-16)
Second 3-translation work, same pattern as Categories: Edghill (1928, PD)
primary + Taylor (1812, PD) secondary + Ackrill (1963, US-copyright) third
(local-only, gated). Bekker 16a–24b9, 14 chapters, bookless route `/Int`. All
three keyed to Ackrill's 68 Bekker segments (Edghill 68/68, Taylor 68/68,
Ackrill 68/68) via 14 per-chapter alignment subagents.
- **Taylor ch14 gap:** CLAA's chapter-14 page is a broken duplicate of ch13;
  Taylor's actual ch14 was reconstructed from the 1812 *Organon* scan on
  archive.org (OCR cleaned of commentary/footnotes) — flagged in Int.yaml.
- **Inline table rendering (new, reusable):** these chapters have tables.
  - The Greek itself carries the ch13 modal square at 22a24–31, encoded with the
    `⎪` (U+23AA) column divider — added to stage3 sigla; stage7 `_greek_cells`
    splits such lines into cells; the reader renders them as a real 2-col table
    (vertical divider, clickable tokens per cell).
  - Ackrill's diagrams (ch10 squares of opposition, ch13 implications I/II/III/IV)
    are extracted from the markdown as structured `sources/int-ackrill/tables.json`,
    attached to overlay pieces by Bekker line (`_attach_tables`), and rendered as
    grids after their segment's row. Edghill/Taylor render these as prose in their
    originals (no diagram), so nothing to gridify there.
  - `_find_phrase` prefix-fallback added so an anchor phrase split across a column
    cut still resolves.
- Gating: `Int.yaml` (3 translations) local + `Int-public.yaml` (Edghill+Taylor).

## Biological works II.c — Movement / Progression / Generation of Animals (✅ built + registered)
Completes division II.c (joining HA + PA). Translations chosen per the copyright
findings (all Oxford Translation, PD now): **Movement of Animals** (`MA`, tlg021,
698a–704b, 11 ch, bookless) and **Progression of Animals** (`IA`, tlg015,
704a–714b, 19 ch, bookless) — both A. S. L. Farquharson (Oxford, 1912), Greek =
Jaeger (Teubner, 1913); **Generation of Animals** (`GA`, tlg012, 715a–789b, 5
books, 23/8/11/10/8 = 60 ch) — Arthur Platt (Oxford, 1910), Greek = Drossaart
Lulofs (OCT, 1965). Standard grc-TEI/archive recipe (like Phys/HA/PA).
- **Sources.** MA/IA English from the MIT archive (`motion_animals` / `gait_anim`,
  added to `fetch_natphil.py`). GA is **not on the MIT archive** → English vendored
  from the eBooks@Adelaide "complete.html" web edition via the Wayback Machine
  (`tools/fetch_ga_platt.py`), split into 5 book files on its `<h3>Book N</h3>` /
  `<h4>N</h4>` markers (number marker). grc TEIs from First1KGreek; spine from the
  cached TLG export. Chapter counts match the Greek book-for-book, no digitization
  drift.
- **GA book boundaries** fall on the edition's own line-number gaps at the shared
  transition columns (731b 14→18, 749a 6→10, 763b 16→20, 778a 12→16); one mid-book
  gap declared (`expected_line_gaps` 775a 10→12).
- **Pipeline change:** stage3 `_SIGLA` now strips `⟦ ⟧` (U+27E6/27E7), the double
  brackets marking editorially secluded text in GA's Greek. Regression-clean
  (EN + Cat unchanged, key_failures=0).
- All three stage2 PASS, key_failures=0 (MA 99.3% / IA 99.6% / GA 99.6% token
  match). App builds (102 pages), home II.c shows all 5 biological works as
  clickable, reader renders Greek‖English correctly (screenshots verified). All PD
  → deployable. **NOT committed/pushed (awaiting John's review).**
  *Shipped (verified 2026-09-07):* `manifests/MA.yaml`, `IA.yaml`, `GA.yaml` and their
  `shared/lib/works.ts` entries are on main; the three were among the 41 works of the full
  `build:public` deploy of 2026-07-13 (a) and every full rebuild since (`DEPLOY-STATUS.md`).

## Per-work progress
- Poetics (034) ✅ built+registered (pre-existing)
- Aligner port ✅ wiring complete
- Metaphysics (025) ✅ built + registered  (Tredennick — withhold till 2029) — shipped: live with Ross as the public primary (`manifests/Meta-public.yaml`; `DEPLOY-STATUS.md` 2026-07-09, 2026-08-22)
- Politics (035) ✅ built + registered     (Rackham — withhold till ~2028) — shipped: live with Jowett primary + Ellis secondary (`manifests/Pol-public.yaml`; `DEPLOY-STATUS.md` 2026-07-09)
- Rhetoric (038) ✅ built + registered     (Freese PD — DEPLOYABLE) — shipped: live, Freese + Roberts secondary (`manifests/Rhet.yaml`; `DEPLOY-STATUS.md` 2026-07-10)
- All 5 prior works regression-pass identical after each change.
- Remaining authentic: Eudemian Ethics (009) shares books IV–VI with NE V–VII → defer/special-case. — shipped: built as 5 Eudemian-proper books with the gap annotated (`manifests/EE.yaml`, `EE-public.yaml`; `shared/lib/works.ts`; live per `DEPLOY-STATUS.md` 2026-07-09).
