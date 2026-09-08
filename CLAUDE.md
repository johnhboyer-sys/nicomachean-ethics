# CLAUDE.md — aristotle-reader

Bilingual Greek/English Aristotle reading site (Astro + Svelte), deployed to GitHub Pages at johnhboyer-sys.github.io/aristotle-reader. Deploy state and the full deploy recipe live in DEPLOY-STATUS.md — read it before any deploy.

## Layout

- `app/` — the Astro site. `pipeline/` — Python corpus pipeline (Diogenes → per-work data). `build/dist` — built corpus data. `shared/` — reader core shared with sibling readers (plato-reader, homer). `workbench/` — Translation Workbench (Tauri, isolated from the site). `desktop/` — desktop reader app (Tauri). Bonitz (Index Aristotelicus OCR) lives in its own repo, `~/Developer/bonitz-text` (`johnhboyer-sys/bonitz-text`); it reads this repo's `build/dist` and nothing here reads it.
- `ocr_translations/CLAUDE.md` is a self-contained OCR recipe, not project instructions.
- **Handoffs are per track — never one shared `HANDOFF.md`.** Each carries the state of that track: what is done, what was decided and why, what failed. Read the one for the track you are working at the start of a session; rewrite it (don't append) when handing off. A new track starts a new `HANDOFF-<TRACK>.md` at the root.
- There is deliberately no bare `HANDOFF.md`. On 2026-08-25 a Lyceum session wrote its handoff over the LSJ one through that filename, and the LSJ handoff survived only in git history. Do not recreate it.
- Live handoffs, one per track: `HANDOFF-CATCHUP.md` (the 2026-09-07 catch-up branch — read first if that branch is unmerged) · `HANDOFF-LSJ.md` (LSJ presentation) · `workbench/SESSION-HANDOFF.md` (Workbench doc-structure tools) · `workbench-design/HANDOFF.md` (Workbench design) · `docs/print-design-handoff.md` (print/PDF layout). The names are inconsistent for historical reasons — read the one for your track, and never start a second file for a track that already has one.
- A track whose work has moved to another repo keeps its handoff there, not here.

## Build and deploy invariants

- App-only build: `PUBLIC_SHOW_PRIVATE=0 npm run build` in `app/`, Node 22. The env var is `PUBLIC_SHOW_PRIVATE` (unset/0 = hidden); `PUBLIC_HIDE_PRIVATE` is a stale name from old notes.
- Full corpus rebuild: `npm run build:public` at repo root (runs all gates: preflight, shared-LSJ verify, link integrity).
- `/bonitz` is 404 on live and must stay so. The page was removed from `app/` on 2026-09-03 (it built empty and carried an unfixed XSS); no move-aside is needed at build time any more. A future Index Aristotelicus reader is built against bonitz-text's output, not resurrected from git.
- Deploy = `npm run deploy` at the root (`scripts/deploy-gh-pages.mjs`: fresh shallow gh-pages clone, rsync with deletions reported by category, live-only files restored, leak check, commit, push; `npm run deploy:dry` rehearses). Never `rm -rf .git && git init` — times out at this repo size.
- Pre-deploy leak check: no gated-translation prose (Ackrill, Tredennick, Irwin, Rackham) in data JSON. The deploy script runs it with a positive control; known benign hits are its `KNOWN_BENIGN` list and DEPLOY-STATUS.md.
- Link-integrity gate must report 0 broken before pushing.

## Hard gotchas

- `serde_json` must stay in `desktop/src-tauri/Cargo.toml` — signed/updater builds need it even though nothing imports it directly.
- Run workbench vitest from `workbench/`, never from a worktree root.
- Svelte 5 tests: `vi.resetModules()` creates a second Svelte runtime (`effect_orphan`); mock `lib/data` to isolate shard caches instead.
