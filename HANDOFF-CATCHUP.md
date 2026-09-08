# HANDOFF: the 2026-09-07 catch-up branch

Written 2026-09-08 for whoever picks this up on the Mac. This is the handoff
for the `claude/weekly-usage-catchup-h8go43` track. Rewrite it (don't append)
if the track advances; delete it once the branch is merged and its list here is
empty.

## Where it stands

- Branch `claude/weekly-usage-catchup-h8go43`, 31 commits, head `21a77d5`.
- **[PR #110](https://github.com/johnhboyer-sys/aristotle-reader/pull/110)** —
  open, all seven CI checks green, mergeable clean, no review comments. Nobody
  is watching it: the remote session's subscription and check-ins were stopped
  on request.
- **Nothing is built and nothing is deployed.** The whole branch was written in
  a container with no `build/dist`, no TLG disc and no network, so every test
  is a unit test and no gate ran against real corpus data.
- Suites on this head: shared 467, desktop 464, workbench 1,854, pipeline 458,
  app 84, scripts 43. `tsc` and `svelte-check` clean in every package.

## Read in this order

1. This file.
2. `DEPLOY-STATUS.md` — the "Pending on `claude/weekly-usage-catchup-h8go43`"
   note at the top. It is the authority on what needs a rebuild and what the
   rebuild will move.
3. `workbench/SESSION-HANDOFF.md` items **0a** and **0** — the Rust review's
   open decision, and the data-loss class that was fixed.
4. `HANDOFF-LSJ.md` §0 — the three forms-block rules and the audit that has to
   run before the desktop takes them.

## Do this, in order

```
git fetch origin && git checkout claude/weekly-usage-catchup-h8go43
npm ci --prefix app && npm ci --prefix shared && npm ci --prefix desktop && npm ci --prefix workbench
```

**1. `npm run build:public`** — the corpus rebuild. Several fixes only reach
the site through it. Expect `english.json` and every `search/` file to change
(the English index now carries word positions). Expect `english_head` and the
offsets NOT to change.

Two things may go red, and both are meant to:

- **The Isagoge's stage 2.** Its Busse column check used to compare the spine
  against itself and could not fail; it now compares against the manifest's
  declared range. If the export really is missing a page, the build stops.
- **The link gate.** `check-links.mjs` now refuses a root-relative href in
  emitted HTML that lacks the `/aristotle-reader` base. Every source was traced
  and none should trip it, but the first real build is the proof. A false fail
  is loud, not silent.

**Diff `build/dist`, don't just gate on it.** Two pipeline fixes change emitted
values: a chapter opening now needs a word boundary (it could match inside a
longer word and still be stamped `wordAnchor`), and the milestone fallback
searches from the monotonic cursor instead of the start of the work. Chapter
`column`/`line`/`wordIndex` can shift, and a chapter that used to resolve may
now come out unresolved — that is the intended trade. Separately,
`add_bekker_gutter` no longer lets an interpolated tick evict a real
hand-keyed anchor, so the per-chunk ticks of the densely-anchored works
(Categories and its family) can move.

**2. The LSJ audit**, before the desktop app takes `shared/lib/html.ts`:

```
node shared/scripts/audit-forms-block.mjs origin/main build/dist/lsj
```

Expect roughly 123 tables lost (83 parenthesis openers + 38 cross-references +
2 empty-label rows) and **`lost characters 0`**. Anything else is a finding —
the rules are stated in `HANDOFF-LSJ.md` §0 and the script prints both
renderers side by side.

**3. Deploy.** `npm run deploy:dry` first — read the deletion report by
category — then `npm run deploy`. The script is new and its clone-and-rsync
path has never run against the real gh-pages branch.

**4. Rebuild both apps.** In the Workbench, the acceptance test for the
data-loss fix: re-import Physics from the disc, type one character, quit,
reopen. **The outline must still show eight books.** If it shows lines
1, 2, 3… the fix did not take.

Also worth a look in the real `.app`, since neither has been run outside a test
harness: the Add work… dialog when every corpus work is already in the library
(it threw `ReferenceError` before this branch), and importing a chapter over
the one open in the editor.

## Decisions waiting on you

1. **The Workbench's Rust trust boundary.**
   `workbench-design/security-review-2026-09-07.md` has the detail. Nothing is
   exploitable, and the three claims the capability description makes about
   Rust-side enforcement all hold. But `run_program` and `assist_run` are an
   unrestricted local-exec primitive — Rust checks only "absolute and
   executable" — so the `shell:allow-execute` validators beside them are
   decorative and the CSP is what actually stands between remote-fetched
   content and code execution. Either have Rust hold the picker-approved paths,
   or say plainly in the description that the CSP is the control.
2. **Four Rust findings** in that same memo are recorded, not fixed — the
   remote container cannot compile Rust. A hostile lexicon pack's shard HTML is
   rendered raw (bounded to markup by the CSP); the timeout can leave a reader
   thread blocked forever on a grandchild's pipe; an unclamped `timeout_ms` can
   overflow and orphan a child; zip extraction caps neither entries nor size.
3. **`TauriStorage.write` is truncate-and-write**, not write-then-rename, so a
   crash mid-save leaves a file the parser refuses. Fixing it needs
   `fs:allow-rename` in the Workbench's capabilities. The desktop app's stores
   were converted on this branch and its grant added; the Workbench was not.
4. **`ChapterEditor.reassignDocumentAddresses`** was fixed for the source-ref
   case but the fix is unreachable today — every splice caller gates on a
   paragraph row unit, which `source-ref` is not. When that gate opens, this is
   the code that decides whether an imported work keeps its citations.
5. **The commentary layer's 15 open questions** —
   `docs/commentary-layer-decisions.md` §7. The gates are built and tested
   (`pipeline/aristotle_pipeline/commentary.py`); nothing is wired into a stage,
   because the ingestion stack is question 1.

## Not done

- **The shared fixes are not ported to plato-reader and homer-reader.**
  Attaching those repos to the remote session was refused by a permission
  check. What needs to go forward: `shared/lib/html.ts` (the sanitizer escapes
  a stray `<` and decodes attribute entities before the scheme check),
  `shared/lib/betacode.ts` (a capital with iota subscript stays one letter),
  `shared/lib/search.ts` and `data.ts` (the search fixes, the `memo.ts` helper,
  the lettered line), and `shared/components/Reader.svelte` and
  `Phrases.svelte`. `HANDOFF-LSJ.md` §4 records that a fix left unmade there is
  reverted in both on the next patch-forward.
- Two commentary gates are declared and not implemented, and say so in their
  own report rather than passing silently: HTML safety wants the real
  TypeScript sanitizer, and the AI divergence threshold is unset.

## Traps this branch found the hard way

- **`tsc` does not read `.svelte` files.** A prop declared in a component's
  `$props()` type and never destructured compiles, typechecks, passes every
  source-scan test, and throws at render. There is now a sweep over all 31
  Workbench components (`propsDestructuring.test.ts`); the desktop and shared
  packages have no equivalent.
- **A gate that compares a thing to itself reports green forever.** Two were
  found on this branch. When you add a check, write the failing case first.
- **CI now runs the script tests and typechecks the Workbench**, and no longer
  tolerates a pytest run that collects nothing. If a local run passes and CI
  does not, that difference is new and deliberate.
