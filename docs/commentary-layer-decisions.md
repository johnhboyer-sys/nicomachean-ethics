# The commentary layer — decisions

*Decision doc, drafted 2026-09-07. Schema and anchoring only; UI remains direction, not design (plan §The UI is not settled).*

Parent: `docs/commentary-layer-plan.md` (the plan). Survey: `docs/commentary-ux-survey.md`. Nothing visual is decided here. Where this doc names a route, a URL parameter, or a display state, it is fixing the information architecture the plan already committed (plan §Governing architecture rule 3: the URL carries `(work, location, primary, supplement-config)`), not how any of it looks.

Every decision below cites the plan section it restates. Where the schema had to refine a plan decision to be machine-checkable, the refinement is called out in §7 rather than made silently.

## 1. What is decided here

1. The on-disk shape of commentary data per work: a manifest, per-book note shards, a divisio tree, and the stream model with per-stream copyright.
2. How a note is keyed to the Bekker spine, and which existing code resolves that key.
3. How the public build removes gated streams, and how the pre-deploy leak check extends to commentary prose.
4. The ingestion gates, as pass/fail checks.

Not decided: any presentation. The tick/peek/persistent state machine (plan §Display state machine) is referred to only because the URL has to carry it.

## 2. Data model

### 2.1 Files per work

All under `build/dist/<work>/`, beside `book-NN.json`, `chapters.json`, `columns.json`, `footnotes.json`, `quotations.json` (`pipeline/aristotle_pipeline/stage7_emit.py`; fetched by `shared/lib/data.ts`).

| File | Shape | Fetch pattern |
|---|---|---|
| `commentaries.json` | `CommentaryEntry[]` | Like `quotations.json`: missing file → `[]`, never a throw (`fetchQuotations` in `shared/lib/data.ts`). A work with no commentaries ships nothing. |
| `commentary/<comm>/book-NN.json` | `CommentaryShard` | Like `book-NN.json`: `NN` zero-padded, fetched when the reader opens that book. Cached per `work:comm:book`. |
| `commentary/<comm>/divisio.json` | `DivisioNode` (one root) | Fetched by the outline page and the commentary-primary TOC. Absent unless the entry declares `divisio: true`. |
| `commentary/<comm>/front.json` | `CommentaryNote[]` (`type: essay`, no book) | Introductions and excursus not bound to a book. |

Notes are sharded per book, not embedded in `book-NN.json`. Reason: a gated stream must be droppable from the public build without rebuilding the corpus, and the peek latency budget (plan §Post-survey 8: "with or alongside the work shard") is met by fetching the commentary shard together with the book shard, not inside it. The plan allowed either; this picks *alongside*.

Source data is committed as curated sidecar files, the way quotations are (`pipeline/data/quotations/<work>.json` → `stage7_emit.copy_quotations`): `pipeline/data/commentary/<work>/<comm>/…`. A new stage 7 step validates (§6) and emits them. Which ingestion stack produces the sidecar files (Python pipeline vs. Workbench) is plan unknown 8 and stays open (§7).

### 2.2 Types

TypeScript-style, in the idiom of `shared/lib/data.ts`. Field comments are normative.

```ts
// ---- Bekker keys: identical to the rest of the data --------------------------
// column: a Bekker page+side string, "402a" (refs.py column_key; data.ts parseBekker).
// line: an int. Never "402a1" strings inside records — those are for prose.

interface BekkerPos { column: string; line: number; }

// A span. {column, lo, hi} is exactly quotations.json's shape (spec-quotation-
// detection.md §Data shape) and stays valid unchanged. `toColumn` is the one
// extension: when present the span runs from column:lo to toColumn:hi across
// every intervening column (refs.py column_range order). lo/hi inclusive.
interface BekkerSpan { column: string; lo: number; hi: number; toColumn?: string; }

// ---- Manifest: commentaries.json --------------------------------------------
type StreamLang = 'grc' | 'la' | 'en';
type StreamRole = 'original' | 'translation' | 'ai-translation';
type CopyrightState = 'pd' | 'cc-by-sa' | 'restricted' | 'unresolved';

interface StreamCopyright {
  state: CopyrightState;
  basis: string;          // one line: why. "First published 1907; author d. 1929."
  freesIn?: number;       // year, when known (restricted/unresolved only)
  sourceUrl?: string;     // where the text came from (scan, TEI repo)
  license?: string;       // the grant relied on, verbatim short form ("CC BY-SA 4.0 per TEI <availability>")
}

interface AiMethods {                 // plan §AI translation pilot
  model: string;                      // exact provider model id string
  date: string;                       // ISO date of the run this version was made by
  methodVersion: string;              // version of the pipeline recipe, e.g. "ai-xl-0.3"
  glossaryVersion: string;            // the fixed glossary + style sheet used for generation
  sourceStream: string;               // the stream id generation read from — always the Greek
  referenceCheck: {                   // the private verification pass; never a generation input
    reference: string;                // named, not hosted, not quoted
    passes: number;
    flagsRaised: number;
    flagsResolved: number;
    divergenceRate: number;           // flagsRaised / units checked
    checker: string;                  // who/what raised the flags — names the checker (plan §Ingestion QA gates)
  };
  auditTrail: string;                 // repo path of the run log
  correctionsUrl: string;             // plan unknown 11
  methodsNoteHtml: string;            // the visible methods note, pre-rendered, sanitized
  revisions: { version: string; date: string; summary: string }[];  // newest last
}

interface CommentaryStream {
  id: string;                // stream id used as the key in CommentaryNote.body: "grc" | "la" | "en" | "en-ai" …
  lang: StreamLang;
  role: StreamRole;
  name: string;              // full citation, like TranslationRef.name (works.ts)
  short: string;             // chip label, like TranslationRef.short
  copyright: StreamCopyright;
  hosted: boolean;           // EMITTED, not authored: true iff this build carries the stream's text.
                             // Public build: hosted = (state is pd | cc-by-sa). See §4.
  linkOut?: string;          // where a reader can get the text when hosted=false (plan §Data model direction: "link-out")
  ai?: AiMethods;            // required iff role === 'ai-translation'; forbidden otherwise
  partial?: boolean;         // the stream does not cover every note (e.g. an English that stops at Book II)
}

type CommentaryType = 'lemma' | 'lectio' | 'continuous';   // the commentary's dominant note type

interface CommentaryEntry {
  id: string;                // URL segment + data dir under commentary/: "hicks", "aquinas", "themistius"
  work: string;              // Work.id it comments on; self-describing like quotations' column
  title: string;             // "Aristotle, De Anima, with translation, introduction and notes"
  short: string;             // "Hicks"
  author: string;            // "R. D. Hicks"
  date: string;              // display date of the commentary: "1907", "c. 1268", "c. 350"
  type: CommentaryType;
  streams: CommentaryStream[];      // picker order, like Work.translations
  homeTranslation?: string;         // a Work.translations[].id (plan §Translator commentaries); absent when the
                                    // commentator's translation is not hosted
  divisio: boolean;                 // commentary/<id>/divisio.json exists
  routes: {                         // IA only (plan rule 3); pathnames under the site base
    reader: string;                 // "/DA/commentary/aquinas/book/{n}/" — the commentary-primary pole
    outline?: string;               // "/DA/commentary/aquinas/" — the divisio outline page (plan §Aquinas)
  };
  units: { label: string; count: number };   // the commentary's own book-like unit: {"liber", 3}, {"book", 7}, {"book", 3}
  coverage: BekkerSpan[];           // EMITTED: union of note ranges, merged; for the homepage coverage bars (plan §Post-survey 6)
  noteCount: number;                // EMITTED
}

// ---- Notes: commentary/<comm>/book-NN.json ------------------------------------
type NoteType = 'lemma' | 'lectio' | 'essay' | 'continuous';   // plan §Data model direction
type LemmaVerdict = 'matches' | 'variant-reading' | 'error' | 'unchecked' | 'foreign-lemma';

interface LemmaHead {
  text: string;              // the printed lemma, display metadata ONLY — never a join key (plan §Data model direction)
  lang: 'grc' | 'la';
  verdict: LemmaVerdict;     // plan unknown 7: matches / error / variant-reading; + unchecked; + foreign-lemma (Moerbeke, plan unknown 3)
  checker: string;           // who/what issued the verdict — the honesty rule (plan §Ingestion QA gates)
  variant?: string;          // when verdict = variant-reading: our Greek at the anchor, for display as scholarly content
}

interface CommentaryNote {
  id: string;                // opaque, unique within the commentary, assigned once at ingestion and never reassigned.
                             // Convention: lemma/continuous notes "<comm>.<int>"; lectio notes "<comm>.<liber>.<lectio>".
  type: NoteType;
  range: BekkerSpan;         // the commentator's OWN cited range, verbatim (his lineation)
  anchor: BekkerPos;         // EMITTED: a line that exists in our spine; the join key for ticks and the L{col}-{line} anchor
  snapped: boolean;          // EMITTED: anchor != {range.column, range.lo}
  appliesTo: 'work' | 'translation';   // plan §Translator commentaries
  translationId?: string;    // required iff appliesTo === 'translation'; must be a hosted Work.translations[].id
  lemma?: LemmaHead;         // lemma notes: the quoted head. Lectio notes: the Moerbeke incipit.
  label?: string;            // the commentary's own label: "Lectio 1", "§ 7", "b 3." — display only
  loc?: Record<string, string>;   // per-stream source location, display only: {"la": "Marietti §1–§9", "grc": "Heinze 1.1–2.14"}
  body: Record<string, string>;   // stream id → pre-rendered, sanitized HTML (same contract as footnotes.json values).
                                  // A gated stream's key is ABSENT in the public build, never empty.
  divisio?: DivisioNode;     // lectio notes only: the divisio textus THIS lectio states (a fragment; see §2.4)
  weight: number;            // EMITTED: characters of the longest hosted body — for weight-encoded ticks (plan §Post-survey 3). Never an excerpt.
  cont?: boolean;            // EMITTED: this is a copy in a second shard because the range crosses a book boundary (cf. OverlayPiece.cont)
  rev?: string;              // ai-translation streams: the AiMethods.revisions[].version the body was last changed in
}

interface CommentaryShard {
  commentary: string;        // CommentaryEntry.id
  book: number;              // the WORK's book (Manifest.book_for_line), not the commentary's unit
  notes: CommentaryNote[];   // in anchor order (refs.py line_key)
}

// ---- Divisio: commentary/<comm>/divisio.json ----------------------------------
// Plan §Aquinas: nodes {label, range, children[]}, leaves at lemma spans.
interface DivisioNode {
  label: Record<string, string>;   // per stream: {"la": "Ostendit dignitatem huius scientiae", "en": "…"}
  at: BekkerPos;                   // AUTHORED: where the commentator says the part begins ("ibi 'Videtur autem'")
  range: BekkerSpan;               // EMITTED: at → next sibling's at (−1 line), or parent's hi for the last child
  midLine?: boolean;               // AUTHORED: the part begins mid-line, so range.lo == previous sibling's range.hi
  statedIn: string;                // the CommentaryNote.id of the lectio that states this division
  lemma?: LemmaHead;               // leaf nodes: the Moerbeke incipit
  children: DivisioNode[];
}
```

### 2.3 Conventions matched, with the file that sets each

- **Column strings, integer lines.** `refs.py` (`column_key`, `line_key`), `data.ts` (`parseBekker` → `{column, line}`), `columns.json` (`{book, lo, hi}` per column), `quotations.json` (`{column, lo, hi}`). Commentary records use exactly these. No record stores `"402a1"`.
- **Resolution of a `{column, line}` to a page and an anchor.** Pipeline side: `Manifest.book_for_line(column, line)` in `pipeline/aristotle_pipeline/config.py` returns the book or `None` in an inter-book gap. Client side: `resolveBekker(columns, column, line)` in `shared/lib/data.ts` over `columns.json`, snapping to the nearer book in a gap. Page: `/<work>/book/<n>/`. Anchor: the element id `L{column}-{line}` in `shared/components/Reader.svelte` (rows `id={`L${seg.column}-${row.n}`}`; `scrollToCitation` and the `?loc=` path both target it).
- **Pre-rendered HTML bodies.** `footnotes.json` is `{ label → html }` and passes through `sanitizeHtml` (`shared/lib/html.ts`) before render; `EndnoteSidebar.svelte` does the same for commentary-class endnotes. Commentary bodies are the same contract: HTML, sanitized at build and again at render.
- **Names and chips.** `CommentaryStream.name`/`short` mirror `TranslationRef.name`/`short` in `shared/lib/works.ts`.
- **Missing-file semantics.** Manifest missing → `[]` (the `fetchQuotations` pattern). A shard missing for a book a manifest claims → error (the `fetchBook` pattern), because that is a build defect, not an absence.
- **Continuation copies.** `cont` reuses the `OverlayPiece.cont` idea (`data.ts`): the same content appears in two shards and the reader knows which one is the head.
- **Manifest section.** `manifests/<work>.yaml` gains a `commentaries:` list that names each commentary and its streams, in the style of `english.primary/secondary/overlays` (`manifests/DA.yaml`). The `-public.yaml` variant omits gated streams (§4).

### 2.4 The divisio is authored as fragments and emitted as one tree

The plan says "lectio-type notes may carry a divisio tree" (§Data model direction) and also that the tree "is one structure with three presentations" (§Aquinas). Both hold:

- Each lectio note carries the fragment it states — Aquinas opens each lectio by dividing the part he is about to read.
- The build stitches fragments into `divisio.json`: a fragment's root attaches under the existing node whose range contains it, and its `statedIn` names the lectio. Stitching is by range containment, never by label text.
- Ranges are emitted from the authored `at` positions. A transcriber records start points (that is what "ibi 'Videtur autem'" gives); ends are derived. This is what makes the tiling check (§6 gate 3) possible without hand-typed `hi` values that drift.

### 2.5 Manifest example (skeleton)

```json
// build/dist/DA/commentaries.json — public build. Illustrative comments are not JSON.
[
  { "id": "hicks", "work": "DA", "title": "Aristotle, De Anima, with translation, introduction and notes",
    "short": "Hicks", "author": "R. D. Hicks", "date": "1907", "type": "lemma",
    "streams": [
      { "id": "en", "lang": "en", "role": "original", "name": "R. D. Hicks (Cambridge, 1907)", "short": "Hicks",
        "copyright": { "state": "pd", "basis": "First published 1907; author d. 1929 (sources/da-hicks/PROVENANCE.md).",
                       "sourceUrl": "https://archive.org/details/in.ernet.dli.2015.154226" },
        "hosted": true }
    ],
    "divisio": false,
    "routes": { "reader": "/DA/commentary/hicks/book/{n}/" },
    "units": { "label": "book", "count": 3 },
    "coverage": [ { "column": "402a", "lo": 1, "hi": 25, "toColumn": "435b" } ],
    "noteCount": 0 },
  { "id": "aquinas", "...": "see §3b" },
  { "id": "themistius", "...": "see §3c" }
]
```

Hicks has one stream. His commentary is English prose with Greek inside it; the Greek is not a separate stream. His own translation is not hosted (`docs/pd-translations-staging.md` C1), so `homeTranslation` is absent — see §8 item 7.

## 3. Worked examples

All three are real content in the shapes above. Wording that is quoted from a source in this repo says so; wording I could not verify is marked `PLACEHOLDER` inside the value and must be replaced at ingestion, not shipped.

### 3a. Hicks on De Anima 402a1–402a10 (line-keyed)

Hicks's notes have two grains, visible on the transcribed p. 314 (`sources/da-hicks/work/grok-2026-08-10/out/p314-notes.txt`): a range-keyed summary paragraph ("412 b 6—9. There is no need to question…[§ 7]") and line-keyed lemma notes under it ("b 6. διὸ καὶ οὐ. With the foregoing view…"). The summary is `continuous`; the lemma notes are `lemma`. Both key to Bekker; a line can carry several notes, which the reader groups by `column:lo` exactly as `quoteStarts` groups quotations (`Reader.svelte`).

The 402a1–a10 notes below are **placeholders**: the pages that carry them (Hicks pp. 173 ff.) have not been transcribed, and I am not confident enough of the wording to quote from memory. The fourth record is real, from the repo's own transcription of p. 314 — a single-model offline reading (Grok, `--disable-web-search`), not yet adjudicated, so its `checker` says so.

```json
// build/dist/DA/commentary/hicks/book-01.json
{ "commentary": "hicks", "book": 1, "notes": [
  { "id": "hicks.1", "type": "continuous",
    "range": { "column": "402a", "lo": 1, "hi": 10 },
    "anchor": { "column": "402a", "line": 1 }, "snapped": false,
    "appliesTo": "work", "label": "402 a 1—10.",
    "loc": { "en": "p. 173" },
    "body": { "en": "<p>PLACEHOLDER — Hicks's summary paragraph for 402a1–10 (the dignity and difficulty of the enquiry), to be transcribed from p. 173. Not Hicks's wording.</p>" },
    "weight": 0 },
  { "id": "hicks.2", "type": "lemma",
    "range": { "column": "402a", "lo": 1, "hi": 1 },
    "anchor": { "column": "402a", "line": 1 }, "snapped": false,
    "appliesTo": "work", "label": "a 1.",
    "lemma": { "text": "τῶν καλῶν καὶ τιμίων", "lang": "grc", "verdict": "unchecked", "checker": "none yet" },
    "loc": { "en": "p. 173" },
    "body": { "en": "<p>PLACEHOLDER — Hicks on the pairing of καλόν and τίμιον at the opening. Not Hicks's wording.</p>" },
    "weight": 0 },
  { "id": "hicks.3", "type": "lemma",
    "range": { "column": "402a", "lo": 4, "hi": 4 },
    "anchor": { "column": "402a", "line": 4 }, "snapped": false,
    "appliesTo": "work", "label": "a 4.",
    "lemma": { "text": "δοκεῖ δὲ καὶ πρὸς ἀλήθειαν ἅπασαν", "lang": "grc", "verdict": "unchecked", "checker": "none yet" },
    "loc": { "en": "p. 174" },
    "body": { "en": "<p>PLACEHOLDER — Hicks on the contribution of psychology to truth in general and to natural science in particular. Not Hicks's wording.</p>" },
    "weight": 0 }
] }
```

```json
// build/dist/DA/commentary/hicks/book-02.json — REAL wording, from the repo's p. 314 transcription.
// Verdicts are "unchecked": the lemma text has not yet been compared with our Greek at 412b3/b4/b6.
{ "commentary": "hicks", "book": 2, "notes": [
  { "id": "hicks.412", "type": "lemma",
    "range": { "column": "412b", "lo": 3, "hi": 3 },
    "anchor": { "column": "412b", "line": 3 }, "snapped": false,
    "appliesTo": "work", "label": "b 3.",
    "lemma": { "text": "αἱ δὲ ῥίζαι τῷ στόματι ἀνάλογον", "lang": "grc", "verdict": "unchecked",
               "checker": "transcription: grok-4.5 offline 2026-08-10, unadjudicated" },
    "loc": { "en": "p. 314" },
    "body": { "en": "<p>Cf. <i>De Part. An.</i> IV. 10, 686 b 28 sqq., especially 686 b 32 καὶ τὸ κατὰ τὴν κεφαλὴν μόριον τέλος ἀκίνητόν ἐστι καὶ ἀναίσθητον, καὶ γίνεται φυτόν, ἔχον τὰ μὲν ἄνω κάτω, τὰ δὲ κάτω ἄνω· αἱ γὰρ ῥίζαι τοῖς φυτοῖς στόματος καὶ κεφαλῆς ἔχουσι δύναμιν κτέ.</p>" },
    "weight": 232 },
  { "id": "hicks.413", "type": "lemma",
    "range": { "column": "412b", "lo": 4, "hi": 4 },
    "anchor": { "column": "412b", "line": 4 }, "snapped": false,
    "appliesTo": "work", "label": "b 4.",
    "lemma": { "text": "κοινὸν ἐπὶ πάσης ψυχῆς", "lang": "grc", "verdict": "unchecked",
               "checker": "transcription: grok-4.5 offline 2026-08-10, unadjudicated" },
    "loc": { "en": "p. 314" },
    "body": { "en": "<p>Cf. <i>supra</i> 412 a 5 κοινότατος λόγος. Again it becomes clear that we are not so much laying down the nature of soul as indicating the scope of the enquiry.</p>" },
    "weight": 173 },
  { "id": "hicks.414", "type": "continuous",
    "range": { "column": "412b", "lo": 6, "hi": 9 },
    "anchor": { "column": "412b", "line": 6 }, "snapped": false,
    "appliesTo": "work", "label": "412 b 6—9.",
    "loc": { "en": "p. 314" },
    "body": { "en": "<p>There is no need to question the unity of soul and body, the one being form, and the other the matter corresponding to it; for that which is in the fullest sense actual possesses being and unity [§ 7].</p>" },
    "weight": 214 }
] }
```

The `[§ 7]` inside the summary is Hicks's cross-reference to his own translation's paragraph numbering. It stays as printed text: there is no field for it because the translation it points into is not hosted.

### 3b. Aquinas, Sententia libri De anima, Book I lectio 1 (with divisio)

Range: Marietti's lectio 1 runs **402a1–402a22** (lectio 2 opens at 402a23, "Πρῶτον δ' ἴσως ἀναγκαῖον"). The brief for this doc said "roughly 402a1–402b8"; the Marietti division is the one I am confident of, and the `hi` is a value the ingestion gate will confirm against the Parma/Marietti apparatus, not something the reader trusts from this doc.

Streams: Latin PD (Parma 1852–73; plan unknown 3, confirmed 2026-08-08 — the Leonine is not usable), English gated (Foster–Humphries 1951, status unresolved; plan unknown 3). Lemmata are Moerbeke's Latin, so `verdict: foreign-lemma` and the Bekker positions are the editorial hop the plan names, authored by the transcriber and checked by gate 2's Latin branch (§6).

Latin quoted below is from memory of the Marietti text and is marked as such; the English body is absent because the stream is gated, which is what the public shard looks like. Divisio labels paraphrase Aquinas's Latin heads; the incipits are Moerbeke's.

```json
// build/dist/DA/commentaries.json entry
{ "id": "aquinas", "work": "DA", "title": "Sententia libri De anima", "short": "Aquinas",
  "author": "Thomas Aquinas", "date": "c. 1268", "type": "lectio",
  "streams": [
    { "id": "la", "lang": "la", "role": "original", "name": "Parma edition (1852–73), Moerbeke lemmata", "short": "Latin",
      "copyright": { "state": "pd", "basis": "Parma 1852–73; scans on archive.org (plan unknown 3, 2026-08-08).",
                     "sourceUrl": "https://archive.org/" },
      "hosted": true },
    { "id": "en", "lang": "en", "role": "translation", "name": "K. Foster and S. Humphries (Yale, 1951)", "short": "Foster–Humphries",
      "copyright": { "state": "unresolved", "basis": "1929–1963 renewal window; status genuinely unresolved (plan unknown 3). Being hosted elsewhere is not evidence.",
                     "freesIn": 2047 },
      "hosted": false,
      "linkOut": "https://isidore.co/aquinas/DeAnima.htm" }
  ],
  "divisio": true,
  "routes": { "reader": "/DA/commentary/aquinas/book/{n}/", "outline": "/DA/commentary/aquinas/" },
  "units": { "label": "liber", "count": 3 },
  "coverage": [ { "column": "402a", "lo": 1, "hi": 25, "toColumn": "435b" } ],
  "noteCount": 0 }
```

```json
// build/dist/DA/commentary/aquinas/book-01.json — public build: no "en" key in body.
{ "commentary": "aquinas", "book": 1, "notes": [
  { "id": "aquinas.1.1", "type": "lectio",
    "range": { "column": "402a", "lo": 1, "hi": 22 },
    "anchor": { "column": "402a", "line": 1 }, "snapped": false,
    "appliesTo": "work", "label": "Liber I, lectio 1",
    "lemma": { "text": "Bonorum honorabilium notitiam opinantes", "lang": "la", "verdict": "foreign-lemma",
               "checker": "none yet — Moerbeke incipit; Bekker hop authored, unverified" },
    "loc": { "la": "Marietti §1–§9; Parma XX", "en": "Foster–Humphries pp. 43–48" },
    "body": {
      "la": "<p>PLACEHOLDER-MARKED: quoted from memory, verify against the Parma scan. — Sicut docet Philosophus in undecimo de animalibus, in quolibet genere rerum necesse est prius considerare communia et seorsum, et postea propria unicuique illius generis; quem quidem modum Aristoteles servat in philosophia prima. […]</p><p>Dividitur autem liber iste in duas partes: in prooemium et tractatum […]</p>"
    },
    "divisio": {
      "label": { "la": "Liber De anima" },
      "at": { "column": "402a", "line": 1 },
      "range": { "column": "402a", "lo": 1, "hi": 25, "toColumn": "435b" },
      "statedIn": "aquinas.1.1",
      "children": [
        { "label": { "la": "Prooemium" },
          "at": { "column": "402a", "line": 1 },
          "range": { "column": "402a", "lo": 1, "hi": 22 },
          "statedIn": "aquinas.1.1",
          "children": [
            { "label": { "la": "Ostendit dignitatem et utilitatem huius scientiae" },
              "at": { "column": "402a", "line": 1 },
              "range": { "column": "402a", "lo": 1, "hi": 7 },
              "statedIn": "aquinas.1.1",
              "children": [
                { "label": { "la": "Dignitas, ex certitudine et ex nobilitate subiecti" },
                  "at": { "column": "402a", "line": 1 },
                  "range": { "column": "402a", "lo": 1, "hi": 4 },
                  "statedIn": "aquinas.1.1",
                  "lemma": { "text": "Bonorum honorabilium notitiam opinantes", "lang": "la", "verdict": "foreign-lemma", "checker": "none yet" },
                  "children": [] },
                { "label": { "la": "Utilitas, ad veritatem omnem et maxime ad naturam" },
                  "at": { "column": "402a", "line": 4 }, "midLine": true,
                  "range": { "column": "402a", "lo": 4, "hi": 7 },
                  "statedIn": "aquinas.1.1",
                  "lemma": { "text": "Videtur autem et ad veritatem omnem", "lang": "la", "verdict": "foreign-lemma", "checker": "none yet" },
                  "children": [] }
              ] },
            { "label": { "la": "Ostendit difficultatem" },
              "at": { "column": "402a", "line": 7 }, "midLine": true,
              "range": { "column": "402a", "lo": 7, "hi": 22 },
              "statedIn": "aquinas.1.1",
              "children": [
                { "label": { "la": "Quid quaerimus: naturam, substantiam, accidentia" },
                  "at": { "column": "402a", "line": 7 }, "midLine": true,
                  "range": { "column": "402a", "lo": 7, "hi": 10 },
                  "statedIn": "aquinas.1.1",
                  "lemma": { "text": "Quaerimus autem considerare et cognoscere", "lang": "la", "verdict": "foreign-lemma", "checker": "none yet" },
                  "children": [] },
                { "label": { "la": "Difficultas in genere, et quantum ad methodum" },
                  "at": { "column": "402a", "line": 10 },
                  "range": { "column": "402a", "lo": 10, "hi": 22 },
                  "statedIn": "aquinas.1.1",
                  "lemma": { "text": "Omnino autem et penitus difficillimum est accipere aliquam fidem de ipsa", "lang": "la", "verdict": "foreign-lemma", "checker": "none yet" },
                  "children": [] }
              ] }
          ] },
        { "label": { "la": "Tractatus" },
          "at": { "column": "402a", "line": 23 },
          "range": { "column": "402a", "lo": 23, "hi": 25, "toColumn": "435b" },
          "statedIn": "aquinas.1.2",
          "children": [] }
      ]
    },
    "weight": 0 }
] }
```

Three things this example exercises:

- **`midLine`.** The Greek at 402a4 reads "…τιθείημεν. δοκεῖ δὲ καὶ πρὸς ἀλήθειαν…": the first part ends and the second begins on one line. The sibling that begins there carries `midLine: true` and its `lo` equals the previous sibling's `hi`. Gate 3 allows exactly that one-line overlap and no other. This is the refinement of the plan's "no gaps or overlaps" (§7).
- **The tree crosses lectiones.** "Tractatus" is a child of the root stated in lectio 1 but subdivided only in lectio 2 (`statedIn: aquinas.1.2`, children empty in this fragment). The stitched `divisio.json` fills them in from lectio 2's fragment by range containment (§2.4).
- **Absent `en`.** The public shard has no English key. Nothing in the data says "hidden"; the stream entry in the manifest (`hosted: false`, `linkOut`) is where the reader learns why.

### 3c. Themistius, paraphrase of De Anima, Book 1 (Greek PD + `ai-translation`)

Greek: CAG V.3 (Heinze 1899), via OGL `cag-dev` `commentaria_05_1-3.xml`, CC BY-SA 4.0 per the TEI `<availability>` (plan unknown 2, resolved 2026-08-08) — or OCR of the PD Berlin scan, which plan unknown 17 leaves open because share-alike would propagate to the AI translation. The example below assumes the OGL route and says so in `copyright.license`; if John chooses the OCR route, only the two copyright blocks change. Bekker anchoring comes from the TLG-computed anchor table (`docs/corpus-analysis-features.md` §4), shipped as our `anchor` values against OGL text.

Themistius paraphrases continuously, so every note is `type: continuous`, one per paraphrase paragraph, ranged to the Aristotle it paraphrases. Which DA chapters Heinze's Book 1 covers, and its page span, are marked placeholder: the TEI has `<pb>` and Spengel marginals but no Bekker anchors, and I have not computed them.

```json
// build/dist/DA/commentaries.json entry
{ "id": "themistius", "work": "DA", "title": "In libros Aristotelis De anima paraphrasis", "short": "Themistius",
  "author": "Themistius", "date": "c. 350", "type": "continuous",
  "streams": [
    { "id": "grc", "lang": "grc", "role": "original", "name": "R. Heinze, CAG V.3 (Berlin, 1899), via OGL cag-dev", "short": "Greek",
      "copyright": { "state": "cc-by-sa", "basis": "Berlin 1899 edition is PD; the OGL TEI transcription carries CC BY-SA 4.0 in its <availability> (repo has no LICENSE file).",
                     "sourceUrl": "https://github.com/OpenGreekAndLatin/cag-dev", "license": "CC BY-SA 4.0 per TEI <availability>" },
      "hosted": true },
    { "id": "en-ai", "lang": "en", "role": "ai-translation", "name": "AI translation from Heinze's Greek (method ai-xl-0.1)", "short": "AI English",
      "copyright": { "state": "cc-by-sa", "basis": "Derived from the OGL Greek; share-alike carried forward (plan unknown 17). Never gated (plan §AI translation pilot)." },
      "hosted": true,
      "ai": {
        "model": "PLACEHOLDER — the exact model id string the provider API returns for the run",
        "date": "2026-10-01",
        "methodVersion": "ai-xl-0.1",
        "glossaryVersion": "da-glossary-2026-09",
        "sourceStream": "grc",
        "referenceCheck": {
          "reference": "R. B. Todd, Themistius: On Aristotle On the Soul (Bloomsbury, 1996) — private reference check only; never a generation input; not quoted",
          "passes": 2, "flagsRaised": 41, "flagsResolved": 41, "divergenceRate": 0.087,
          "checker": "PLACEHOLDER — verifier model id + run id"
        },
        "auditTrail": "pipeline/data/commentary/DA/themistius/audit/ai-xl-0.1/",
        "correctionsUrl": "https://github.com/johnhboyer-sys/aristotle-reader/issues/new?labels=ai-translation,themistius",
        "methodsNoteHtml": "<p><b>AI translation.</b> This English was generated from Heinze's Greek text alone, with a fixed glossary and style sheet, by a language model on 2026-10-01 (method ai-xl-0.1). It was then checked, in a separate pass that never fed the generator, against a published translation for divergences of meaning; every flag went back to re-translation from the Greek. It exists because no English translation of Themistius will be public domain until about 2083. It is a reading aid, not a scholarly translation. Corrections: <a href=\"https://github.com/johnhboyer-sys/aristotle-reader/issues/new?labels=ai-translation,themistius\">open an issue</a>.</p>",
        "revisions": [ { "version": "ai-xl-0.1", "date": "2026-10-01", "summary": "First run, Book 1." } ]
      } },
    { "id": "en-todd", "lang": "en", "role": "translation", "name": "R. B. Todd (Bloomsbury, 1996)", "short": "Todd",
      "copyright": { "state": "restricted", "basis": "In copyright; Sorabji/Bloomsbury confirmed blocked (plan unknown 18).", "freesIn": 2083 },
      "hosted": false,
      "linkOut": "https://www.bloomsbury.com/" }
  ],
  "divisio": false,
  "routes": { "reader": "/DA/commentary/themistius/book/{n}/" },
  "units": { "label": "book", "count": 7 },
  "coverage": [ { "column": "402a", "lo": 1, "hi": 31, "toColumn": "405b" } ],
  "noteCount": 0 }
```

The `en-todd` entry exists only so the homepage coverage bars can say "unlocks 2083 / link out" (plan §Post-survey 6). It has no body anywhere, in any build.

```json
// build/dist/DA/commentary/themistius/book-01.json
{ "commentary": "themistius", "book": 1, "notes": [
  { "id": "themistius.1", "type": "continuous",
    "range": { "column": "402a", "lo": 1, "hi": 10 },
    "anchor": { "column": "402a", "line": 1 }, "snapped": false,
    "appliesTo": "work", "label": "Heinze 1,1",
    "loc": { "grc": "Heinze 1,1–1,PLACEHOLDER (Spengel 1)", "en-ai": "ai-xl-0.1 ¶1" },
    "body": {
      "grc": "<p>PLACEHOLDER — Themistius's opening paragraph on the dignity of the science of the soul, from commentaria_05_1-3.xml after correction (the TEI is dev-grade OCR; plan unknown 2).</p>",
      "en-ai": "<p>PLACEHOLDER — the ai-xl-0.1 rendering of that paragraph.</p>"
    },
    "weight": 0, "rev": "ai-xl-0.1" }
] }
```

Themistius quotes an Aristotle that is not Ross's. His paraphrase carries no lemma head, so there is no `lemma` field and gate 2 does not run on him; the anchoring is the computed table, and a wrong anchor surfaces as a `snapped`/distance failure in gate 1, not as a lemma mismatch.

## 4. Copyright gates per stream

Restates plan §Data model direction: gates are per stream, not per commentary.

**The mechanism the corpus already has.** `scripts/build-public.mjs` builds every work with `--public`; `Manifest.for_work(work, public=True)` (`config.py`) loads `manifests/<work>-public.yaml` when it exists, else the normal manifest. A public manifest is the full manifest with the gated translation removed (`manifests/Cat-public.yaml` drops Ackrill), so the gated text never enters `build/dist` or the search index. Separately, the app registry compiles out `private: true` translations unless `PUBLIC_SHOW_PRIVATE=1` (`SHOW_PRIVATE` in `shared/lib/works.ts`); `build-public.mjs` forces `PUBLIC_SHOW_PRIVATE: '0'` on the Astro build. Two gates, data and registry, both fail-safe.

**How commentaries use it.**

1. `manifests/<work>.yaml` gets a `commentaries:` section listing each commentary and every stream with its `copyright.state`. `manifests/<work>-public.yaml` lists the same commentaries with gated streams marked `hosted: false` — not deleted, because the manifest entry is what tells the reader "unlocks in YYYY / link out". The stage refuses to emit a body for any stream whose `hosted` is false, whatever the sidecar file contains.
2. Derivation of `hosted` on a public build is mechanical: `pd` and `cc-by-sa` → true; `restricted` and `unresolved` → false. `unresolved` is gated, not hosted-with-a-note — the Foster–Humphries case.
3. `ai-translation` streams are never gated (plan §AI translation pilot). Their copyright state is whatever their Greek source's is.
4. The registry gate does not apply: `commentaries.json` is runtime data, not compiled into `works.ts`. The existing `Work.commentaries?: string[]` field in `works.ts` is a different thing (hosted ancient works that are commentaries, e.g. `Isa` on `Cat`) and needs renaming or reconciling before this lands (§7).
5. Every stream's sidecar text, gated or not, lives in the repo under `pipeline/data/commentary/` so the local full build renders it. Same as Ackrill in `Cat.yaml`.

**Extending the pre-deploy leak check.** Today (`DEPLOY-STATUS.md`, every deploy entry): after the build, grep gated translators' names (`Ackrill`, `Tredennick`, `Rackham`, `Irwin`) over `app/dist/data` JSON with a quoted `--include='*.json'` glob and a positive control (`Aristotle`, ~1,626 files) proving the grep ran; known-benign hits are read in context and listed (the `EN/manifest.json` attribution field; Ostwald's two footnotes citing Rackham as editor; the Cat/Int landing-page in-print citations).

For commentary prose the name grep is the wrong probe: a gated stream's translator name legitimately appears in the public `commentaries.json` (`name`, `linkOut`), so "Foster" or "Todd" hits are expected and would drown the signal. The extension is:

1. Each gated stream in the full manifest carries `leakProbes: string[]` — two or three short distinctive phrases from its prose (a manifest is source, not a served file, and a few words are not distribution). The public manifest carries the probes too; the stage strips them before emitting `commentaries.json`.
2. The leak check greps every probe over `app/dist/data` and `app/dist/**/*.html` and `app/dist/_astro/*.js`, with the same quoted glob and the same positive control. Any hit is a failure; there are no benign probe hits by construction.
3. A structural check runs alongside: for every note in every emitted commentary shard, `Object.keys(body) ⊆ {streams with hosted: true}`. This catches a stream that leaked under a stream id the probes did not cover.
4. The name grep continues, and its benign-hit list gains the `commentaries.json` attribution fields. The list lives in `DEPLOY-STATUS.md` as it does now.

## 5. Anchoring rules

Restates plan §Data model direction ("range always resolves, word-match is best-effort") and §Ingestion QA gates.

1. **The range is the key.** A note is placed by `anchor` (emitted from `range.column`, `range.lo`), and `anchor` is guaranteed to name a line in our spine. Every tick, peek, `L{col}-{line}` target and coverage bar is computed from `anchor`/`range`, never from lemma text.
2. **Lemma text is display metadata.** `lemma.text` is shown in the note head and used only for the best-effort word highlight on the home translation (plan §Translator commentaries). If highlight fails to find the words, the fallback is the range indicated through the existing English Bekker tick offsets (`EnglishChunk.bekker` / `OverlayPiece.bekker` in `data.ts`, `real: false` where estimated — plan unknown 4).
3. **When the commentator's lineation differs from ours.** Hicks printed his own Greek; LSJ cites its editions' lines; both differ from Ross/Bekker by a line or two. The reader already handles this at runtime: a `?loc=` whose exact line is not a Greek line break snaps to the nearest `.greek-line` in the column (`Reader.svelte`, the block commented "Snap to the nearest existing line in the column"), and the LSJ citation gate mirrors it — the column must exist, the exact line need not (`docs/spec-lsj-citations.md` decision 8). Commentary uses the same contract, resolved at build rather than at render:
   - The stage looks up `range.column:lo` in the spine. If the line exists, `anchor` is it and `snapped` is false.
   - If not, `anchor` is the nearest existing line in that column, `snapped` is true, and the distance is logged. Distance ≤ 2 passes (edition drift); > 2 fails (transcription error until a human says otherwise). Gate 1 in §6.
   - `range` keeps the commentator's numbers verbatim so the note head can cite what he printed.
   - The runtime snap remains as a second net for anything the build missed; it never disagrees with the build because both pick the nearest line in the same column.
4. **Book resolution.** `Manifest.book_for_line` decides which shard a note lives in. A position in an inter-book gap (`None`) is a gate failure, not a snap.
5. **Two-column spans** use `toColumn`; the anchor is still the head line. Coverage and tiling checks expand the span through `refs.column_range`.
6. **Chapter division is irrelevant to anchoring.** Our `chapters.json` and a commentator's own units (lectio, Heinze book, Hicks's chapter heads) never meet in the data; both hang off Bekker. See §8 item 3.

## 6. Ingestion QA gates, as pass/fail checks

Each is a function of the sidecar files plus the work's spine (`build/stage1`) and manifest; each names what it checked. A stage 7 step runs them per commentary; any FAIL stops emission of that commentary, not the work. Restates plan §Ingestion QA gates and unknowns 4, 7.

| # | Gate | PASS | FAIL |
|---|---|---|---|
| 1 | Range resolves | Every `range.column` (and `toColumn`) is a spine column of this work; `lo ≤ hi` (by `line_key` when `toColumn`); the anchor line exists or snaps within 2 lines; `book_for_line(anchor)` is not `None`. | Unknown column; inverted range; snap distance > 2; anchor in an inter-book gap. |
| 2 | Lemma-to-Bekker | Greek lemma: the lemma's tokens (accent-folded, via `beta.to_beta_key` conventions) occur in our Greek within `range` → `matches`; occur with a different reading → `variant-reading` with `variant` filled; verdict names its `checker`. Latin lemma (`foreign-lemma`): the Moerbeke incipit is listed in the authored Latin→Bekker table for this commentary and the table entry is contiguous with its neighbours. | Any `error` verdict without a human adjudication record; any `unchecked` on a public build; a `foreign-lemma` with no table entry. Mismatches are flagged, never forced to `matches`. |
| 3 | Divisio tiling | After stitching (§2.4): every node's children are in `line_key` order; each child's `lo` is the previous child's `hi + 1`, or equal to it when `midLine` is set; the first child starts at the parent's `lo`; the last ends at the parent's `hi`; every `statedIn` names an existing lectio note; every fragment root found a containing parent. | Any gap; any overlap other than the flagged one-line `midLine` case; an orphan fragment; a dangling `statedIn`. |
| 4 | Stream completeness | For every hosted stream not marked `partial`, every note has a non-empty body in that stream. | A missing body in a full stream. |
| 5 | Public-build containment | On `--public`: `Object.keys(note.body) ⊆ hosted stream ids` for every note; no `leakProbes` field survives into `commentaries.json`; every probe grep over `app/dist` returns 0 with the positive control > 0. | Any body key for a non-hosted stream; any probe hit; a positive control of 0 (the grep did not run — the 2026-09-01 zsh glob lesson in `DEPLOY-STATUS.md`). |
| 6 | HTML safety | `sanitizeHtml(body) === body` for every body and every `methodsNoteHtml` and every divisio label (`shared/lib/html.ts`). | Any change — the sidecar carries something the sanitizer would strip (the removed `/bonitz` page's XSS is the precedent, `CLAUDE.md`). |
| 7 | Identity | `id` unique within the commentary; ids in the sidecar match ids in the previous emitted build for unchanged notes (no reassignment); `cont` copies have byte-identical bodies to their head. | Duplicate or reassigned id; divergent `cont` copy. |
| 8 | `appliesTo` | `translationId` present iff `appliesTo === 'translation'`, and names a translation in `works.ts` for this work that survives the current build's gate. | Dangling or gated `translationId`. |
| 9 | AI-translation pipeline | `ai` present iff `role === 'ai-translation'`; every `AiMethods` field non-empty; `sourceStream` is a `grc` stream; `auditTrail` path exists and its log lists ≥ 1 generation pass and ≥ 1 verification pass; `flagsResolved === flagsRaised`; `divergenceRate ≤ threshold` (threshold: plan unknown 9, unset — until set, the gate WARNS and John's sample review is the pass). | Missing field; unresolved flags; audit trail absent; any generation-pass log line that names the reference. |
| 10 | Honesty | Every `checker` field is non-empty and is either a named human or a model id + run id. "confirmed" without a checker does not exist in the data (`docs/alignment-status.md`'s correction of 2026-07-31 is the standard). | Empty or generic checker ("verified"). |
| 11 | Coverage | `coverage` ⊆ the work's `bekker_range`; `noteCount` equals the notes emitted. | Otherwise. |

Gate 2's Greek branch is expected to produce `variant-reading` often for Hicks and the CAG authors (plan unknown 7). That is scholarly content, not an error; only `error` blocks.

### 6a. What is built (2026-09-07)

`pipeline/aristotle_pipeline/commentary.py` implements the gates above as pure
functions over the sidecar plus the work's spine and manifest — nothing in it
reads a file, the way `quality.check_breathing` takes its tokens and allowlist
as arguments. `check_all` runs them and returns a report in
`stage2_validate` house style; a stage 7 step will call it per commentary and
refuse to emit that commentary (not the work) on a FAIL. 46 tests
(`pipeline/tests/test_commentary.py`), one passing shape and every failing
shape per gate, fixtured on the worked examples of §3.

Two gates are NOT implemented, and the report says so rather than omitting
them: a `skipped` check carries `ok: None` and its reason, so a green report
cannot be read as "everything was checked".

- **Gate 6, HTML safety** belongs where the sanitizer is. Re-stating
  `sanitizeHtml`'s allowlist in Python would drift from it, and a drifted
  sanitizer gate is worse than none; it wants a Node step that imports the real
  function (`shared/scripts/audit-forms-block.mjs` shows the esbuild route).
- **Gate 9's divergence threshold** is open question 3 and unset, so the rate
  is reported as a warning and John's sample review is the pass. The rest of
  gate 9 — every field filled, flags resolved, the audit trail where it says,
  generation reading a `grc` stream — is checked.

`stitch_fragments` implements §2.4: fragments fold into one tree by range
containment, deepest container wins, and a fragment nothing contains comes back
as an orphan for gate 3 to fail on.

Nothing here is wired into a stage yet: the ingestion stack is open question 1,
and these gates are the part of the decision that does not depend on its answer.

## 7. Open questions

Each waits on a decision; owner is John unless stated.

1. **Ingestion stack** — Python pipeline or Workbench (plan unknown 8). This doc assumes committed sidecar JSON emitted by stage 7, which either stack can produce. Waits on: a look at Workbench's endnote import modes against the Hicks page taxonomy in `sources/da-hicks/PROVENANCE.md`.
2. **CAG Greek source: OGL BY-SA vs. own OCR** (plan unknown 17). Changes the two copyright blocks in §3c and the license on the AI output. Waits on: John, before the pilot starts.
3. **AI divergence threshold** (plan unknown 9). Gate 9 warns until it exists. Waits on: John's sample review of the first run.
4. **Corrections channel** (plan unknown 11). §3c assumes GitHub issues with labels; the URL is in the methods note. Waits on: John.
5. **Search indexing of commentary prose** (plan unknown 12). Not modelled here; if yes, `stage6_search.py` gains a stream and gate 5 must cover `search/` files too. Waits on: the size estimate (plan unknown 5).
6. **Citable/exportable notes** (plan unknown 13). The `L{col}-{line}` + `?comm=` URL (§8 item 8) makes every note addressable; export format is undecided.
7. **Ratify "shown on all translations"** (plan unknown 14). The schema carries `appliesTo`/`translationId` either way.
8. **`Work.commentaries` in `shared/lib/works.ts`** already means "hosted ancient works that comment on this one" (`Cat` → `Isa`). Rename that field (`relatedCommentaries`?) or fold the Isagoge into `commentaries.json` as a commentary whose streams are a hosted work. Waits on: John; blocks the manifest field name.
9. **Refinement of a plan decision — divisio tiling.** Plan §Ingestion QA gates says "without gaps or overlaps". Aquinas's divisions fall mid-line (402a4, 402a7), and Bekker lines are our finest grain, so exact tiling is impossible at line grain. Gate 3 permits a one-line overlap flagged `midLine`. I think the plan's wording was unaware of this, not opposed to it; confirm.
10. **Refinement — divisio storage.** Plan §Data model direction puts the tree on lectio notes; §Aquinas calls it one structure. §2.4 stores fragments and stitches. Confirm.
11. **Hicks's translation notes have no home.** His "I render X as Y" notes would be `appliesTo: translation`, but his translation is not hosted (`docs/pd-translations-staging.md` C1), so gate 8 would reject them. Options: ingest them as `appliesTo: work` with the translator's remark left in the prose; or host Hicks's English as a DA overlay first. Waits on: John.
12. **Aquinas lectio 1 range.** Marietti 402a1–a22 here; the brief said ~402b8. Settle at ingestion against the Parma apparatus.
13. **Versioned URLs for AI translations** (§8 item 9). Waits on: John.
14. **Duplicate line numbers in the spine** (§8 item 2, DA 430b20). Waits on: a decision whether to add a sub-line ordinal to `BekkerPos` now or accept "first wins".
15. **A possible wrong turn in the plan — none found.** I looked for a plan decision the schema could not hold and did not find one; the two refinements above (9, 10) are the closest. The phasing note in plan §Phasing 1 ("write actual JSON for a few real Hicks notes… before any UI work") is met only in part: the real Hicks JSON is 412b, from a page that happened to be transcribed, not the 402a notes the plan wanted. That is a transcription gap, not a schema gap.

## 8. Adversarial review

Re-reading §2 as a hostile reviewer. Each item ends with **handled** or **GAP**.

1. **A note spanning two Bekker columns** (e.g. Hicks on 402b25–403a2). `{column, lo, hi}` alone cannot say it. `toColumn` does: `{ "column": "402b", "lo": 25, "hi": 2, "toColumn": "403a" }`. Order is `line_key`; coverage expansion is `column_range`. The anchor stays `402b:25`, so the note is in book 1's shard once; only a span that crosses a *book* boundary gets a `cont` copy. Quotations keep the plain subset. **Handled.**

2. **A note on a line the spine does not have.** Two cases. (a) The line is absent because our edition numbers differently: gate 1 snaps within 2 and records it; the runtime snap agrees (§5.3). (b) The line is absent because the spine has a gap our manifest declares (`expected_line_gaps` in `manifests/DA.yaml`) or an inter-book gap (`book_for_line` → `None`): gate 1 fails and a human decides. **Handled** for absence. But DA.yaml also records that "430b numbers a line 20 twice". Two `.greek-line` elements would carry `id="L430b-20"`; `getElementById` returns the first; `BekkerPos` has no way to name the second. A Hicks note on the second 430b20 lands on the first. **GAP** — recorded as open question 14. Cheap fix if wanted: an optional `ordinal` on `BekkerPos` and an `-2` suffix on the element id, mirroring the existing `-c` suffix for continuation rows.

3. **A commentary on a work the site builds under a different chapter division.** Mechanica is built with `skip: [8, 27]` and a re-pinned Part 27; the Isagoge is Busse-paged; EE's books IV–VI are not carried. A commentator's own chapter/problem numbering never enters the data except as `label` (display) and `units` (the commentary's own book unit). Anchoring is Bekker only; the divisio tree hangs off Bekker; `chapters.json` is never consulted. For a `busse` work (`Work.citation.scheme`), `column` would have to be a Busse page, which `refs.py` would reject — so commentaries on non-Bekker works are out of scope until that is decided. **Handled** for Bekker works; **GAP** (explicit non-goal) for `busse` works.

4. **Two commentaries on one work with different home translations.** `homeTranslation` is per entry. Plan §Governing architecture and the survey's synthesis (a)4 fix one active commentary at a time, and multi-commentary compare is a v1 non-goal, so two home translations are never live together. Word-level highlight runs only when the displayed translation equals the active commentary's `homeTranslation`; otherwise the tick-offset fallback. **Handled.**

5. **A lectio whose divisio ranges overlap.** Ranges are not authored; `at` positions are, and ranges are derived so siblings cannot overlap by construction except at a shared boundary line, which must be declared `midLine` or gate 3 fails. Overlap between a fragment and an already-stitched node (two lectiones both claiming to divide the same span differently) fails stitching (orphan or double parent). **Handled**, with the one-line exception recorded as open question 9.

6. **Latin PD, English not, on a public build.** `manifests/DA-public.yaml` lists the `en` stream with `hosted: false`; the stage emits no `en` body; gate 5 asserts `body` keys ⊆ hosted ids and greps the `leakProbes`; the manifest entry survives so the reader can show "unlocks 2047 / link out". The full local build (`DA.yaml`, `hosted: true`) renders both. **Handled.** One residual: `leakProbes` are quoted phrases of a gated text sitting in a committed YAML. The repo is public. Three short phrases are not the work, but if John would rather not, probes can be stored as hashes of normalized 12-grams and the check hashes the built output the same way. Decision for John; not a schema gap.

7. **A translation-note shown while a different translation is selected.** `appliesTo: 'translation'` plus `translationId` gives the reader what it needs to suppress or badge (plan §Translator commentaries leaves the choice to the design pass; this doc does not pick). **Handled** for hosted home translations. **GAP** for Hicks, whose translation is not hosted — open question 11.

8. **A URL that carries (work, location, primary, supplement-config) and stays shareable.** Existing state: path `/<work>/book/<n>/`, `?loc=402a:1`, `#402a2` (scroll-spy writes it), `?trans=`, `?view=`, `?hlg=`/`?hle=` (`Reader.svelte`). Additions, all query parameters so no existing link changes meaning:
   - *primary* is the route: `/<work>/book/<n>/` is text-primary; `/<work>/commentary/<comm>/book/<n>/` (`CommentaryEntry.routes.reader`) is commentary-primary. One flip = same `loc`, other route.
   - `?comm=<id>` — the active commentary (post-survey 5: `?comm=hicks#402a2`). Absent = commentary off.
   - `?cs=ticks|persistent` — the text-primary display state (plan §Display state machine); absent = `ticks` when `comm` is set.
   - `?cl=<lang>|both` — commentary-pole language; `?pl=grc|both|en` — the peek pane's Aristotle language (plan rule 4: two independent controls).
   - Precedence: an explicit parameter beats `localStorage`, as `?view=`/`?trans=` already do.
   Every state worth returning to is in the address; nothing lives only in local storage. **Handled.** Note the existing duplication (`?loc=` vs `#hash`) is inherited, not introduced.

9. **The AI translation revised after publication.** `AiMethods.revisions[]` (newest last), `methodVersion` for the recipe, `date` for the run, and per-note `rev` for the last version that touched the body. The methods note is regenerated from these. Old bodies live in git history of the sidecar, not on the site, so a URL always shows the latest. A student who cited the 2026-10-01 wording cannot get it back from the site. **GAP** — whether to serve versioned snapshots (`?rev=`) is open question 13. The data does not prevent it; the routes do not yet promise it.

10. **A vision-impaired reader on a phone in landscape.** The constraint is the reader's (DEPLOY-STATUS 2026-08-13: type size deliberately not cut; the LSJ jump list was capped and scrolled rather than shrunk). What the schema owes it: bodies are shipped whole — there is no `summary`, `excerpt` or `teaser` field, so no presentation can truncate from the data; `weight` is a number for sizing a tick, not text; `short` is a chip label, not reading matter. Anything that must fit a 430 px-high viewport must scroll inside itself, and the data gives it nothing to cut. **Handled** at the data layer; the layout itself is the design pass's problem, and this doc decides none of it.

Two further items the list did not ask for:

11. **Several notes on one line** (Hicks b 3., b 4. on 412b). Grouping by `anchor` `column:line` with a list, as `quoteStarts` does for quotations. **Handled.**

12. **A note whose `translationId` names a translation the public build gates** (a hypothetical Ackrill-keyed note on Cat). Gate 8 fails it on the public build. The note is lost, not leaked — fail-safe, same direction as `SHOW_PRIVATE`. **Handled.**
