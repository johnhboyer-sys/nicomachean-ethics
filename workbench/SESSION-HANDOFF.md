# WORKBENCH Session Handoff

_This file is the **Translation Workbench** handoff only — `workbench/`. It is
not the repo-wide `HANDOFF.md` at the root, and no other session's handoff
should be written here. Rewrite it (don't append) when you hand off workbench
work._

_Last rewritten: 2026-08-28, morning._

## Where things stand

- **Branch:** `claude/workbench-autonomous-capabilities-e6fc26`, pushed.
- **[PR #102](https://github.com/johnhboyer-sys/aristotle-reader/pull/102) — MERGED** into `main` (2026-08-27): eight backlog items.
- **[PR #103](https://github.com/johnhboyer-sys/aristotle-reader/pull/103) — OPEN**: this morning's three commits (author names, rename a work, the smoke run).
- **Suite:** 1,825 vitest green from `workbench/` (never a worktree root). `npx tsc --noEmit` clean. `npm run smoke` passes.
- **Test app:** `~/Downloads/Translation Workbench.app`, rebuilt from the merged code plus the author fix. De-quarantined. **John has not finished QA of any of it.**

## What shipped since the last handoff

PR #102, in the order it was asked for:

1. **An imported work could not be reopened.** `row_refs` joins addresses with commas and 78 of Aristotle's lines are numbered `205a.25,29`, so the address split in two on read and the 1:1 row check refused the file. John's own `physica/b01c01.md` was in that state (5524 refs vs 5520 rows). Addresses are percent-escaped now; a file already written is repaired on read (bare-number entries rejoin, accepted only when the count lands exactly). **The "imported works get no outline" thread was never about the headers line.**
2. **Marked lines print as headings in the export** — book `##`, chapter `###`, in-page `####`+depth, subtitle as an italic line. Bilingual: English is the heading, source italic under it (John's rule, 2026-07-31), except `block` layout where each stream carries its own.
3. **Disc imports no longer collide** — `importFromDisc` takes `existingIds`.
4. **Remove a work** — rail menu, confirms in the menu itself. Needed a new `fs:allow-remove` capability.
5. **Fold a work; works shelved by author** (`lib/works/authorGroups.ts`).
6. **A work's language is editable** in Work details….
7. **The retired container-slot model** (`books` in works.json) is out of the registry.
8. **Perseus Bekker numbers import.** Milestone state carries across division boundaries, and a page with something finer under it IS the address; a page alone is not, so Plato stays `1.327a`.

PR #103, from John's QA:

- **The disc's alternate name joined the author's.** `TLG0086 …Corpus Aristotelicum&\x80Aristotle` — 0x80 introduces the English name (13 authors have one). The parser dropped the marker and kept reading. Fixed at the parser; **existing registry entries keep the fused name until edited.**
- **Rename a work** — Work details… leads with Title. The id never changes: it is the folder name the chapter files live under.
- **The work you were reading could not be folded** (the unfold effect undid the user's own click).
- **The editor header kept the loaded name** after a rename (a document work's fixture is cached until the locus changes).
- **`npm run smoke`** — see below.

## Run it

```
source ~/.nvm/nvm.sh && nvm use v22.23.1 && source ~/.cargo/env
npm --prefix workbench test            # vitest, 1,825
npm --prefix workbench run smoke       # browser pass, fails on any console error
cd workbench && npm run build && npm run stage:corpus && npm run app:build -- --bundles app
cp -R "src-tauri/target/release/bundle/macos/Translation Workbench.app" ~/Downloads/
xattr -dr com.apple.quarantine ~/Downloads/"Translation Workbench.app"
```

The Tauri build takes ~90s warm. `npm run smoke` needs a browser for THIS
Playwright build — `npx playwright install chromium` if it says so (the cache is
shared with other checkouts and can hold a different revision).

## Hard-won this week

- **A green suite does not mean the app starts.** A prop added to a component's
  TYPE but not to its destructuring threw at render with `tsc` clean and every
  test passing. That is what `npm run smoke` exists for; it fails on any console
  error and names the step. A sweep found no other instance in the 31 components.
- **`.svelte` edits hot-reload; `src/lib/**` edits may not.** Say which kind a
  fix is before asking John to test it.
- **The live tests over the disc cache carry a 60s timeout.** They parse 55
  works and 122,429 citations; the vitest default is a coin flip on a machine
  that is also compiling.
- **The Metaphysics books are lettered in GREEK.** A selector looking for
  "Book A" with a Latin A matches nothing.

## Next, in the order I'd take it

1. **John's QA of the real `.app`** — nothing below is worth much until this
   happens. First: re-import Physics from the disc (it should arrive as
   `physica-2` with eight books in the outline). Then export the Summa and check
   Word's navigation pane. Then the rail: fold, author shelves, rename, remove.
2. **Untested since long before this week**: export settings' Tauri halves
   (reference-doc picker, `run_program` pandoc override, the three bilingual
   layouts and especially the side-by-side table in Word), lexicon pack REMOVAL,
   a true first-run empty state.
3. **Parked on John's taste**: heading style — big titles vs small labels; and
   drag-a-chapter-into-a-Book (he chose "skip for now" once already).
0a. **The Rust backend has been reviewed** — `workbench-design/security-review-2026-09-07.md`.
   Nothing is exploitable today and the three claims the capability description
   makes about Rust-side enforcement all hold. But `run_program` and
   `assist_run` are an unrestricted local-exec primitive: Rust checks only
   "absolute and executable", so the `shell:allow-execute` validators beside
   them are decorative and the CSP is what actually stands between
   remote-fetched content and code execution. Two fixes landed (CSP directives,
   and a PATH pin that never reached the child); the Rust items are recorded,
   not made, because this container cannot compile Rust. **The decision for
   John: have Rust hold the picker-approved paths, or say plainly in the
   description that the CSP is the control.**

0. **Read first — a data-loss class found and fixed 2026-09-07, untested in
   the .app** (`claude/weekly-usage-catchup-h8go43`): the first autosave of a
   source import (scheme `source-ref`) never wrote `rowRefs`, so on reopen
   every row hydrated as `1, 2, 3…` and the source's citations, the outline's
   chapter divisions and the export's reference stamps were gone after one
   keystroke. This is the likely root of the "imported works get no outline"
   thread. Also fixed: an export rebase that dropped heading overrides and
   reference stamps; a work id that is all digits (`1984`) or a YAML word
   written unquoted, so the file could not open; a footnote body line that
   looks like a new entry; a UTF-8 BOM read as "missing frontmatter"; a
   pasted CR in `[ENGLISH.PARA]` breaking the row count; and an autosave
   flush racing the write loop so the last edit was never written. 30 new
   tests (1,829 green). Still open, reported not fixed: `TauriStorage.write`
   is truncate-and-write, not write-then-rename (needs `fs:allow-rename` in
   this package's capabilities — the desktop app's stores were converted on
   the catch-up branch and its grant added, the Workbench's were not; also
   listed as item 5 of `desktop/TODO.md`, because the two stores are the same
   code).

   `ChapterEditor.svelte`'s `reassignDocumentAddresses` — **corrected
   2026-09-09**, this entry used to say the fix had not been made. It WAS made
   for the source-ref case on the catch-up branch (merged as PR #110), but the
   fix is unreachable today: every splice caller gates on a paragraph row unit,
   which `source-ref` is not. So nothing exercises it, and nothing regresses if
   it is wrong. When that gate opens, this is the code that decides whether an
   imported work keeps its citations — reach it with a test before trusting
   it.
   Re-import Physics from the disc, type one character, quit, reopen: the
   outline must still show eight books.
4. **Built 2026-09-07, untested in the .app**: the Add work… dialog's dead end.
   When every corpus work is already in the library it now says so in one
   sentence and offers "Import a text…" (the rail's own opener, passed in by
   App). Source-scan test only; needs John's eye in the real app.