# HANDOFF: LSJ presentation

Rewritten: 2026-09-01 midday; §1/§5 updated 2026-09-01 evening; §0/§5 updated 2026-09-07 for the forms-block rules. This is the LSJ-track handoff for aristotle-reader.
Rewrite it (don't append) when this track advances. Do not create a bare
`HANDOFF.md` — see CLAUDE.md.

## 0. 2026-09-03 — the `/lemma` pages mount grammata's T8 entry too

John, shown the three residual forms-block classes on the live `/lemma`
pages: "let's replace those lsj entries on index with the lsj t8 from
grammata." Merged as PR #109 (`main` `52fad397b5`) and deployed to gh-pages
`5f358186` the same day (DEPLOY-STATUS.md). `LemmaPage.astro` no
longer reads the LSJ shards at build time; it renders
`<div class="grammata-mount" data-key=…>` and a page script imports
`https://grammata.pages.dev/t8/lookup.js` and calls
`lookup('', el, { lang: 'grc', key })` — the same contract as the popup (do
not vendor, pin, cache-bust or style). Verified on the dev server: ἀριθμός
renders the T8 entry, no `.lsj-forms` on the page.

Consequences:
- **The website now renders no LSJ entry locally.** `shared/lib/html.ts`
  (`renderLsjEntry` / `buildFormsBlock`) is live only in the desktop app,
  which is offline-first and keeps the shards. `app/src/lib/html.ts`
  re-exports the sanitizer alone.
- **§5's residual classes** (parenthesis openers 83, cross-references 38,
  the two empty-label rows, the >22 path) are desktop-only concerns now. The
  first three rules — a form inside an unclosed "(" is not a row; a lead
  ending in "for" is a cross-reference, prose; one row with an empty label
  is prose — are IMPLEMENTED in `buildFormsBlock` on
  `claude/weekly-usage-catchup-h8go43` (2026-09-07), with nine tests, six of
  which fail on the parent. **The corpus audit has NOT run**: that branch was
  built in a container without `build/dist`. Before the desktop picks it up:
  `node shared/scripts/audit-forms-block.mjs origin/main build/dist/lsj` —
  the §3 audit, recreated as a script. Expect `tables lost` around 83 + 38 +
  2 and `lost characters 0`; anything else is a finding. Two calls the
  audit should confirm: parenthesis depth counts from the start of the
  preamble (an aside spanning LSJ's ";" stays one aside), and a parenthesized
  citation declines its whole segment while a parenthesized Greek span is
  skipped like a quantity mark. The >22 path is untouched.
- The `.lsj-entry-page` styles and `outlineLsjSenses` have no site consumer;
  left in place for the desktop and the sibling readers.
- The porting item in §5 (plato/homer forms-block repairs) stands only if
  those readers keep rendering locally; the popup architecture says they
  should mount T8 too.

## 1. What was live before that, as of 2026-09-01

Deployed to gh-pages `103ce1df` from `origin/main e194646040` (PR #107, on top
of #106). Full record in DEPLOY-STATUS.md; read that before any deploy.

**The word popup's dictionary is served by grammata, not rendered here.** The
site fetches entries from `https://grammata.pages.dev/t8/lookup.js`. One
grammata deploy updates every reader site — that is the architecture, decided
2026-08-29. Do not vendor, proxy, pin or cache-bust the module URL; its deploys
ARE the update mechanism.

**Cards are keyed by dictionary entry**, not by morphological analysis. 15,041
cards → 9,847 corpus-wide; νοῦν 17 → 4. The entry opens under the card tapped.

**The website fetches no LSJ shards.** `data/lsj-heads.json` (14,047 keys, 139
KB gzipped, built by `app/scripts/build-lsj-heads.mjs`) supplies the headword
and homograph letter. The desktop app still reads the shards.

**Four forms-block repairs are live**, all visible on `/lemma/<slug>` pages:
the label-then-form line break; quantity marks opening the table on the
lemma; the headword cut out of the first label (949 → 463 entries, §5); and a
clause LSJ opens with "cf." no longer taken for a row (12 entries, ἱδρόω the
headline).

## 2. The four rules the presentation follows (John's, ruled 2026-08-30)

1. **Aligned columns** — parse left, exception right, as the LSJ forms block sets it.
2. **Attic is the default and never printed.** A form with NO Attic reading says
   what it is limited to. The cut is on Attic's PRESENCE, not on how many
   dialects are named: `(attic)` alone would otherwise flag, and `(epic ionic)`
   would otherwise stay silent, which is backwards. 2,007 of 15,041 flag.
3. **Homographs are not folded.** Each dictionary entry gets its own card,
   carrying **LSJ's own letter** read from the entry text — never derived from
   the key's trailing digit (`ka/r2` is LSJ's (A); 32% of numbered keys carry
   no letter and must show none).
4. **The entry opens under the card tapped**, never below the whole stack.

## 3. Where the code lives

- `shared/components/WordPopup.svelte` — the cards, the grouping, the widget call.
- `shared/lib/data.ts` — `fetchLsjHeads`, and `lookupWord(work, key, { withLsj })`.
  `withLsj` defaults **true**; only the website passes false.
- `shared/lib/html.ts` — `renderLsjEntry` / `buildFormsBlock`. **Live only in
  the desktop app** since 2026-09-03 (§0): the `/lemma/<slug>` pages mount
  grammata's T8 entry and `app/src/lib/html.ts` re-exports the sanitizer alone.
  `LABELISH` (~L440) is the vocabulary guard; `formAt` / `compared` (~L480) is
  the "cf." rule; the lead cut is ~L555.
- `shared/styles/global.css` — ALL popup styles.
- `app/scripts/build-lsj-heads.mjs` — the manifest, wired into `npm run build`.
- Audit tooling, throwaway but worth recreating: a script that transpiles
  `html.ts` with esbuild (`shared/node_modules/esbuild`), renders every entry in
  `build/dist/lsj/*.json` through the working tree AND a git ref, and reports
  changed count, headword-in-first-label count, non-whitespace characters and
  unbalanced tags for both. Every forms-block change on this track was gated on
  it. Append `export { plainLabel, splitOnSeparators, LABELISH };` to the source
  before transpiling to reach the internals.

## 4. Traps, all paid for

- **A component `<style>` block ships NOWHERE.** Reader pages load `global.css`
  and nothing else. It works in `astro dev`, so every local check passes while
  production gets unstyled markup. Verify against `app/dist/_astro`, not the
  dev server.
- **Never pass a surface form to grammata.** It re-analyses from scratch and
  discards this reader's disambiguation: εἰσὶ returns ἵημι, εἰμί and εἶμι with
  ἵημι FIRST. Pass `{ key: a.lsj[0] }` — their pack keys are Perseus betacode,
  identical to ours. Their article order is arbitrary; never present it as ranked.
- **An analysis can name several entries.** Its gloss then belongs to none of
  them in particular. A non-empty exact gloss wins; an empty exact clears a
  fanned-out gloss but never a real one; a fan-out only fills a hole. Verified
  order-independent over all 122,540 tokens.
- **Corpus frequency cannot rank the readings.** νόος appears 110× in
  Aristotle, νέω 126×, so frequency puts the wrong lemma first for νοῦν. Group,
  don't guess.
- **`lemmata.json` is the lemma-PAGE manifest**, not a headword table: 6,441 of
  14,047 keys, missing ὁ, καί, δέ, γάρ, μέν. Use `lsj-heads.json`. It IS the
  right map from key to `/lemma/` slug.
- **A quantity mark is notation, not a form.** Known by its brackets, in both
  shapes LSJ writes them. NOT by length, and square brackets only.
- **A label is known by its vocabulary, not its shape.** The first `LABELISH`
  accepted any short ASCII run ending in a period, so it took "cf." for a
  label and rejected "aor. 1". Do not widen it back to a shape.
- **The lead cut is at the LAST comma of a vocabulary run.** "προσερέσθαι,
  aor. 2 inf., fut. -ερήσομαι": the part before the comma describes the lemma,
  the part after labels the form. The first comma was only ever there to
  protect ἀναγκαίη, and the vocabulary guard does that now.
- **A test of the lead cut needs an `lsj-cit`.** An entry whose form is
  `lsj-greek` + `lsj-bibl` makes `firstAt` -1 and skips the whole block; a
  test built on one passes whatever the guard does. Codex caught that.
- **Never shrink reading type, and never truncate.** The reader is vision
  impaired and reads on a phone in landscape.
- **`shared/lib/html.ts` flows FROM here to plato and homer.** A fix left
  unmade here is reverted in both on the next patch-forward.
- **Quote `--include` globs in zsh.** Unquoted, the leak grep ran on nothing and
  reported 0 for its own positive control; that is the only reason it was
  noticed.

## 5. Open

- **Plato and homer have none of the four forms-block repairs on main** (0
  `.lsj-forms` rules in both) and neither has the grammata popup. Aristotle is
  upstream; port from `main` e194646040.
- **338 entries still open their first label with the headword** (was 463;
  stages 1–2 on PR #107 fixed 125: the article class, and Greek-shaped first
  forms whose last clause is vocabulary). What remains, measured 2026-09-01
  evening:
  - **Other prose after the headword, ~172** — descriptive leads ("ἅτε,
    properly acc. pl. neut. of", "ἀγοράομαι-like prose with no vocabulary last
    clause"). Mostly want nothing; some are wrong labels of the deferred
    >22-path kind.
  - **Parenthesis openers, 83** — "ἀριθμός [ᾰ], (", "ἀντιτίθημι (pres. part.".
    Rule implemented 2026-09-07 (§0): no table opens inside an unclosed "(".
    Audit pending on John's machine.
  - **Cross-references with no form, 38** — ἀναγκαίη, "Ep. and Ion, for
    ἀνάγκη"; "διπλός, ή, όν, poet. for". Rule implemented 2026-09-07 (§0): a
    lead ending in "for" is prose. Audit pending.
  - **Quantity/bracket before the label, 23** — "ἀμβλύνω [ῡ], fut." (some of
    these DID fix in stage 2 where the last clause is vocabulary); κάτειμι's
    lacuna bracket stays correct as it stands.
  - **Bare declension rows, 22 — NOT a defect.** "ἀτμίς" against "ίδος, ἡ":
    LSJ's own line is headword, genitive, gender; the headword is that row's
    natural key. Cutting would leave the row unlabeled. Leave them.
  - The ἀναγκαίη >22 trap is now guarded by a test that REACHES the code
    (Greek-shaped forms take only the vocabulary cut, never the length cut).
- **The >22-character last-comma path is not vocabulary-gated.** 228 of its 386
  leads end in a clause that is not grammatical vocabulary ("but", "also",
  "heterocl. pl.", "impf. ἦγον, Ep. and Ion."). Gating it would change 228
  entries and needs its own audit; Grok suggested it for ἱδρόω and the "cf."
  rule was the right fix instead. Some of the 228 are wrong labels today.
- **Rows with an empty label.** διδάσκαλος and ὅλος opened on one (the row
  was already there as row two; the "cf." rule removed row one). Rule
  implemented 2026-09-07 (§0): exactly one row with an empty label is prose.
  Audit pending.
- **"cf." followed by a mood before the citation** — θλίβω, "(cf. subj.
  ἐκφλῐβῇ Hp.)". `compared` tests "cf." flush against the citation, so this
  comparison is still a row, as it was before. One entry; the regex could
  allow a vocabulary token between.
- **ἁλίσκομαι's Arcadian ϝαλόντοις** sat in a row labelled "(ϝαλ-, cf." and now
  sits in the forms note with the rest of that etymological aside. Grok rated
  it MEDIUM as a lost form; the row it lost was labelled with an etymology.
  Text intact either way.
- **3 quantity-mark survivors**, all `lsj-cit` spans. κάτειμι is CORRECT as it
  stands — do not extend the rule to citation spans. κέρας and θνῄσκω are
  genuine misses.
- **The depth scan in the lead cut counts closing tags without checking their
  names** (Codex, LOW). `sanitizeHtml` does not balance tags, so a mismatched
  close could put the cut inside an open element. No corpus entry does; the
  input is this pipeline's own stage-5 output.
- **Question #2 — the entry inside the popup — is BUILT.** What remains unbuilt
  is the sense-head skeleton for forest entries (λόγος is 64 senses); see the
  memory note `lsj-entry-redesign`.

## 6. Prompt for the next session

Read this file, then DEPLOY-STATUS.md's latest entry. Verify every claim here
against the code before relying on it — several statements in earlier
versions of this file were true when written and false by evening. If you
touch `buildFormsBlock`, rebuild the audit in §3 first and gate on it: changed
count, headword-in-label, non-whitespace characters, unbalanced tags, against
the commit you started from.
