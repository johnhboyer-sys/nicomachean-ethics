# Dubious / spurious works — handoff

Status doc for adding Aristotle's works of **doubted authorship** to the reader.
Supersedes the "authentic works only" line in
[`corpus-expansion.md`](corpus-expansion.md) (that call is intentionally reversed).

## What shipped (PR #21, branch `claude/nervous-bun-08b4c3`)

1. **Authenticity labeling layer** — generic, applies to web **and** the desktop app
   (shared frontend).
   - `Work.authenticity?: 'genuine' | 'dubious' | 'spurious'` in
     [`app/src/lib/works.ts`](../app/src/lib/works.ts) (absent ⇒ genuine ⇒ no badge)
     + exported `AUTHENTICITY_LABEL`.
   - `.status-tag` pill on the homepage card ([`index.astro`](../app/src/pages/index.astro))
     and on the landing page with a disclaimer ([`Landing.astro`](../app/src/components/Landing.astro));
     styling in [`global.css`](../app/src/styles/global.css) (muted-caution pill, modeled
     on `.soon-tag`).
   - The field also flows through **stage7 into `manifest.json`**, so the desktop app
     reads it straight from data.
2. **Search filter** — `All / Genuine / Dubious / Spurious` scope row in the search
   "Refine" panel ([`Search.svelte`](../app/src/components/Search.svelte)); reuses the
   existing `selectOnly` mechanism, empty classes render disabled with a `0`.
3. **First work: Oeconomica** (`Oec`, `spurious`) — imported end-to-end, Opus-verified.

`dubious` vs `spurious`: use **`dubious`** only for genuinely contested works (e.g.
*Magna Moralia*); most opuscula in the corpus are **`spurious`** (transmitted with
Aristotle but not by him). Oeconomica is `spurious` — its Susemihl edition title
literally reads *quae feruntur*, "the works attributed to."

## Recipe for the next dubious work (worked example = Oeconomica)

The pipeline can't just "run" — the bottleneck is a **public-domain English**
translation per work. The Greek is largely cached already.

1. **Vendor a PD English.** Source the Oxford *Works of Aristotle Translated into
   English* opuscula (E. S. Forster et al., mostly 1908–1930 ⇒ US public domain) from
   archive.org / Wayback. Clean it (strip running heads, page numbers, footnotes,
   marginal Bekker numbers, OCR cruft) into `sources/<id>-<translator>/book-0N.html`
   with `Part N` chapter markers — match an existing archive source. **This is a
   network task → Sonnet or hand, not Codex (no network in its sandbox).**
2. **Fidelity check (hard gate).** Chapter/section count per book in the English must
   match the Greek spine book-for-book. Confirm against the grc-TEI (`subtype="section"`
   or `subtype="chapter"` divs). Mismatch ⇒ do not force it.
3. **Write `manifests/<Id>.yaml`.** Copy [`Oec.yaml`](../manifests/Oec.yaml) (itself a
   DA+Meta hybrid): archive-model primary + `chapters.source: grc_tei` +
   `chapter_subtype: section` (if the grc chapters are `section` divs). Add
   `work.authenticity: dubious|spurious`. Seed `bekker_range` + `books:`; stage2 reports
   the exact boundaries — correct them and add `expected_line_gaps` for genuine edition
   discontinuities. **No `-public` variant** if the only translation is PD.
   - The `source: grc_tei` + `chapter_subtype: section` combination works as-is — no
     pipeline change needed (confirmed on Oec).
   - If the Perseus English is copyrighted (e.g. a Loeb), do **not** display it; either
     ship PD-only or use the Loeb as a gated Bekker-milestoned *reference* only (the
     Metaphysics/Tredennick pattern).
4. **Run the pipeline** to green (stage2 PASS, stage3 key_failures=0). See env note below.
   **This is Codex's sweet spot** (network-free, iterate-to-a-hard-pass).
5. **Verify** the built data — canonical Bekker anchors land, Greek‖English topic-match.
   (Opus/deep-reasoner pass; the interpolated gutter is coarse by design.)
6. **Register** in `works.ts`: add the `Work` entry with `authenticity`, its
   `translations[]`, and add `{ id: '<Id>' }` to the right `CATEGORIES` division. It
   inherits the badge + search filter automatically.
7. **Build** (`npm run build`) — confirm the route, card badge, and landing disclaimer.

## Candidate inventory

**Done:** Oeconomica (`Oec`, spurious) — PR #21, deployed 2026-07-08 (`DEPLOY-STATUS.md`).

**Also shipped (verified 2026-09-07):** the next ten went out together as **PR #27**
(`claude/dubious-spuria`, merged 2026-07-09, deployed the same day — `DEPLOY-STATUS.md`
2026-07-09 entry; GitHub PR #27): De Virtutibus et Vitiis (`VV`, Solomon 1915), De Mundo
(`DM`, Forster 1914), Mechanica (`Mech`, Forster 1913), De Coloribus (`Col`),
Physiognomonica (`Phgn`), De Melisso Xenophane Gorgia (`MXG`) [Loveday & Forster 1913],
De Audibilibus (`Aud`), De Lineis Insecabilibus (`Lin`, Joachim 1908), Ventorum Situs
(`Vent`, Forster 1913), De Mirabilibus Auscultationibus (`Mirab`, Dowdall 1909). Each has
`manifests/<Id>.yaml` with `authenticity: spurious` and a `shared/lib/works.ts` entry —
11 spurious works in the registry, grouped under "Spurious Works" on the home page (PR #28,
same deploy). NB `git log --oneline -- manifests/<Id>.yaml` cannot reach these commits:
this clone is shallow and every one of these manifests bottoms out at the boundary
`040423e` (2026-07-27), so the PR numbers above come from `DEPLOY-STATUS.md` and GitHub,
not from git history.

**Greek cached in the Diogenes/TLG export (`build/export/.../tlg0086NNN.xml`), need PD
English** (as of 2026-09-07 only Magna Moralia, Problemata and De Spiritu remain unbuilt —
De Spiritu's Dobson translation is US-PD 2027-01-01 per PR #27 / `DEPLOY-STATUS.md`
2026-07-09; the rest of this list shipped in PR #27 above): De Virtutibus et Vitiis (tlg045), Magna Moralia, De Mundo, Mechanica,
Problemata, De Coloribus, De Audibilibus, Physiognomonica, De Mirabilibus
Auscultationibus, De Lineis Insecabilibus, De Ventorum Situ, De Melisso Xenophane
Gorgia, De Spiritu. (Confirm each `tlg_work` id + Bekker range from the Perseus/TLG
catalog before writing the manifest.)

**Out of scope:** De Plantis (not in the TLG Aristotle corpus), Rhetorica ad Alexandrum
(TLG id ambiguous), Athenian Constitution (not Bekker-paginated — breaks the reader's
citation model, same reason it was excluded before).

## Environment / gotchas

- **Self-contained worktree** (set up on `nervous-bun-08b4c3`): `pipeline/.venv` and
  `build/export` are symlinked to the main checkout (read-only); `build/dist` and
  `app/node_modules` are **real local** dirs. This lets Codex run the pipeline without
  reaching the network or writing outside the worktree. To replicate in a new worktree:
  symlink those two, give `build/dist` a real copy, `npm ci` in `app/`.
- **Pipeline invocation in-sandbox:** use `uv run --no-sync python -m aristotle_pipeline …`
  or `./.venv/bin/python -m aristotle_pipeline …`. Plain `uv run` attempts an offline
  dependency sync and fails.
- **Lesson (Codex):** its sandbox can't write *through* a symlink pointing outside the
  worktree — it will silently replace the symlink with a real dir and clobber the target.
  Keep `build/dist` real+local for any Codex pipeline task.
