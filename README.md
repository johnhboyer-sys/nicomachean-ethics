# Aristotle Parallel Reader

A static web application for reading and searching Aristotle's complete works with the Greek and English side by side, morphological analysis on every word, multiple translation comparison, and full-text search across both languages.

Live at **[johnhboyer-sys.github.io/aristotle-reader/](https://johnhboyer-sys.github.io/aristotle-reader/)**

---

## What it does

| Feature | Detail |
|---|---|
| Parallel text | TLG Greek and public-domain English translations, aligned at every Bekker column |
| Word popups | Click any Greek word: lemma, short gloss, parse (from Diogenes / Morpheus), and the full LSJ entry |
| Search | Separate Greek and English boxes; All words / Any word / Phrase modes; `*` wildcard on Greek lemmata; AND/OR combination across languages |
| Navigation | Books and chapters; deep-link to any Bekker location from search results; URL tracks scroll position |
| Translation picker | Multiple public-domain English translations available for most works (e.g. Ross, Rackham, Jowett, Fyfe, Owen) |
| Print / PDF | Browser print saves a clean bilingual PDF (landscape) or English-only portrait layout |

### Works covered (41 total)

The registry is `shared/lib/works.ts`; the divisions below are its `CATEGORIES`.

**I. Logic (Organon):** Categories, De Interpretatione, Prior Analytics, Posterior Analytics, Topics, Sophistical Refutations

**II.a Natural Philosophy — Major Works on Nature:** Physics, On the Heavens, On Generation and Corruption, Meteorology, De Anima

**II.b Short Works on Nature (Parva Naturalia):** Sense and Sensibilia, On Memory, On Sleep, On Dreams, On Divination in Sleep, On Length and Shortness of Life, On Youth, Old Age, Life and Death, and Respiration

**II.c Biological Works:** History of Animals, Parts of Animals, Movement of Animals, Progression of Animals, Generation of Animals

**III. Metaphysics**

**IV. Moral and Political Philosophy:** Nicomachean Ethics, Eudemian Ethics, Politics

**V. Rhetoric and Poetics:** Rhetoric, Poetics

**Works of doubted or spurious authorship** (an appendix outside the numbered divisions; each carries its badge from the registry's `authenticity` field — all eleven are marked spurious): De Mundo, De Melisso Xenophane Gorgia, Mechanica, De Coloribus, De Audibilibus, Physiognomonica, De Mirabilibus Auscultationibus, De Lineis Insecabilibus, Ventorum Situs, De Virtutibus et Vitiis, Oeconomica

**Also carried:** Porphyry's Isagoge — not a home-page division; surfaced as the commentary on the Categories, and readable at `/Isa`.

---

## Requirements

### Data (not included in this repo)

| What | Where to get it | Notes |
|---|---|---|
| **Diogenes 4.7+** | [d.iogen.es](https://d.iogen.es) | Free. Provides both the `xml-export.pl` script and the Morpheus data files (`greek-analyses.txt`, `grc.lsj.xml`). |
| **TLG corpus** | Licensed from the [TLG](https://stephanus.tlg.uci.edu) | Required for the Greek text. The corpus files live at `TLG Files/TLG/` one level above this repo and are never committed. |
| **English translations** | Vendored in `sources/` or downloaded automatically on first pipeline run (see `manifests/`) | All public domain. |

### Tools

- **Node.js 22+** — for the Astro app
- **uv** — Python package manager (`brew install uv` on macOS)

---

## Building

### Public build for GitHub Pages

Use the repo-level public build command for anything that may be deployed:

```bash
npm run build:public
```

That single command:

- rebuilds the generated data in the normal local path, `build/dist/`, so the app still reads through `app/public/data -> ../../build/dist`;
- uses `manifests/<work>-public.yaml` whenever that file exists, falling back to `manifests/<work>.yaml` only for works with no public/private split (each work runs as `python -m aristotle_pipeline all --work <work> --public`);
- removes old generated output first, so a previous local/full build cannot leave private overlay JSON behind;
- runs stage 8 (the corpus-wide phrase index), the corpus preflight validation, and the shared-LSJ coverage check;
- runs the Astro build with `PUBLIC_SHOW_PRIVATE=0` (`npm run build` in `app/`). Private translation registry entries are compiled in only when `PUBLIC_SHOW_PRIVATE=1`, which only `npm run dev` sets; unset or `0` hides them, and the public build forces `0` so a stray shell setting cannot leak them;
- checks link integrity of the built site (`scripts/check-links.mjs`), which must report 0 broken.

A GitHub Pages deploy should therefore use exactly:

```bash
npm ci --prefix app
npm run build:public
```

Deploy `app/dist/` only after that command succeeds. Do not deploy an app build made with plain `npm run build` inside `app/`; that build can include local/private translation entries if the data was produced from the full manifests.

### 1. Run the pipeline (per work)

```bash
cd pipeline
uv run python -m aristotle_pipeline all --work EN
```

`--work` takes the work's registry id, which is also its manifest filename stem (`EN`, `Pol`, `Rhet`, `Poet`, `DA`, `Phys`, `Meta`, `GC`, `Mete`, `APr`, `APo`, `Top`, `SE`, `HA`, `Cat`, `Int`, `Sens`, `Mem`, `Somn`, `Insomn`, `DivSomn`, `Juv`, `EE`, …; default `EN`). Add `--public` to use `manifests/<work>-public.yaml` when it exists. The pipeline writes data to `build/dist/{work}/`.

To run a single stage: `uv run python -m aristotle_pipeline stage2 --work EN`

**Pipeline stages:**

| Stage | What it does |
|---|---|
| 1 | Exports Greek from TLG via Diogenes; chunks English translation at Bekker milestones; builds standoff alignment |
| 2 | Validates column completeness, line gaps, alignment coverage, length ratios |
| 3 | Tokenizes Greek text; converts surface forms to Beta Code lookup keys |
| 4 | Single targeted pass over `greek-analyses.txt`; matches 99.9% of tokens |
| 5 | Streams `grc.lsj.xml`; extracts corpus-occurring lemmata only; letter-sharded HTML |
| 6 | Builds inverted search indexes (Greek lemma + English word) with phrase search support |
| 7 | Emits final per-work `build/dist/{WORK}/` tree: `book-*.json`, `analyses.json`, `search/`, `manifest.json`; LSJ entries are merged into one corpus-wide shared `build/dist/lsj/<letter>.json` (served at `/data/lsj/`, fetched once across works — not duplicated per work) |
| 8 | Corpus-wide (no `--work`, not part of `all`): merges every work's token stream into the phrase index behind `/phrases` — surface-form and lemma streams over the Greek, plus an English stream over the translations |

**Alignment pipeline** (produces `anchors.yaml` per work, then wired into Stage 1): the aligner lives in `pipeline/aristotle_pipeline/align/` (see its `README.md` for usage); `uv run python tools/gloss_map_to_anchors.py <WORK> <vid>` emits `anchors.yaml`.

### 2. Run the app

```bash
cd app
npm install       # first time only
npm run dev       # http://localhost:4321
```

```bash
npm run build     # static build → app/dist/
npm run preview   # preview the static build
```

### Review screenshots

With the dev server running, capture key views as PNGs (handy for reviewing changes remotely):

```bash
npm run shots                # all scenes → app/.shots/
npm run shots -- /book/3     # one ad-hoc shot of a path
```

Uses Playwright from the local or npx cache (no project dependency).

---

## Project layout

```
aristotle-reader/
├── manifests/
│   ├── {work}.yaml              # per-work metadata, book boundaries, source paths
│   └── {work}-analyses-patch.json  # hand-reviewed analyses for unmatched forms
├── sources/                     # vendored public-domain English translations (TEI XML)
├── pipeline/                    # uv Python project
│   └── aristotle_pipeline/
│       ├── stage1_greek.py      # TLG export + spine parser
│       ├── stage1_english.py    # Perseus TEI chunker + alignment
│       ├── align/               # translation aligner (see its README.md)
│       ├── stage2_validate.py   # validation suite
│       ├── stage3_tokenize.py   # Greek tokenizer (+ the text-quality gate, quality.py)
│       ├── beta.py              # Unicode ↔ Beta Code conversion
│       ├── stage4_morphology.py # analyses lookup
│       ├── stage5_lsj.py        # LSJ extraction (+ lsj_citation_map.py: citations → reader links)
│       ├── stage6_search.py     # search index build
│       ├── stage7_emit.py       # final dist emission
│       ├── stage8_ngrams.py     # corpus-wide phrase index
│       ├── config.py            # manifest loading, path resolution
│       └── refs.py              # Bekker reference utilities
│   └── tools/                   # one-off helpers, incl. gloss_map_to_anchors.py
├── shared/                      # reader core shared with the sibling readers
│   ├── components/
│   │   ├── Reader.svelte        # parallel text view + word popups
│   │   ├── WordPopup.svelte     # morphology + LSJ popup
│   │   └── Search.svelte        # search UI + engine
│   └── lib/
│       ├── works.ts             # work registry + corpus categories
│       ├── data.ts              # data-fetch helpers
│       └── search.ts            # search engine (inverted index + phrase)
├── app/                         # Astro + Svelte static site
│   └── src/
│       ├── pages/
│       │   ├── index.astro      # home page (5 corpus divisions + appendix)
│       │   ├── [work]/          # per-work landing + reading view
│       │   ├── search.astro     # full-corpus search
│       │   ├── advanced.astro   # advanced search
│       │   ├── phrases.astro    # phrase index
│       │   ├── lemma/           # per-lemma pages
│       │   ├── support.astro    # support / donation page
│       │   └── attribution.astro
│       └── components/          # Astro shells around the shared components
└── build/                       # generated, gitignored
    └── dist/{work}/             # ready-to-serve frontend data per work
```

---

## Data licences

See [`/attribution`](app/src/pages/attribution.astro) in the running app, or the source file directly. The short version:

- **LSJ** — CC BY-SA 3.0 (Perseus Digital Library / Trustees of Tufts University). This app uses a derivative; downstream use must also carry CC BY-SA.
- **English translations** — All public domain (pre-1928 US publications). See attribution page for per-work details.
- **TLG electronic corpus** — Separately licensed; not redistributed by this project. Users must hold their own TLG licence.
- **Morpheus morphological data** — Distributed with Diogenes; see Diogenes licence.
- **This software** — MIT licence (pipeline + app code only; data excluded).

---

## MIT Licence

Copyright © 2026 John Boyer

Permission is hereby granted, free of charge, to any person obtaining a copy of this software to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED.
