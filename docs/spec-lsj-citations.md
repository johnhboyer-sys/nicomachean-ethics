# Spec: live LSJ citations (feature 5)

*Status: shipped — PR #81 (merge `2d40d8a`, commit `099ab4b`, 2026-08-18):
`lsj_citation_map.py` + the `bibl` branch in `stage5_lsj.py` render resolving
`Arist.` citations as reader links; `check-links.mjs` gates them. Parent:
`corpus-analysis-features.md` §5. No TLG disc needed at runtime; the LSJ TEI
ships with Diogenes.*

## Goal

Every Aristotle citation inside an LSJ entry becomes an internal reader link.
Today `stage5_lsj.py` renders TEI `<bibl>` as an inert
`<span class="lsj-bibl">` (there is no bibl-specific branch — `bibl` flows
through the generic `_TAG_MAP` path, and `el.get("n")` is read only for
`sense`); the machine-readable ref in its `n=` attribute is dropped. After
this change, a citation that fully resolves renders as

```html
<a class="lsj-bibl" href="/EN/book/3?loc=1094a:5">1094a5</a>
```

and everything else renders exactly as it does now.

## Source data

The LSJ TEI (`grc.lsj.xml`, ~110 MB per the `stage5_lsj.py` docstring, path
from `manifest.diogenes_data()` — the file ships with Diogenes, not this repo)
carries three `<bibl>` shapes that matter:

```xml
<bibl n="Perseus:abo:tlg,0086,010:1172a:9"><author>Arist.</author> <title>EN</title> 1172a9</bibl>
<bibl n="Perseus:abo:tlg,0086,001:27a:15" default="NO">27a15</bibl>   <!-- no author/title text -->
<bibl n="Perseus:abo:tlg,0012,001:17:443">17.443</bibl>               <!-- non-Aristotle -->
```

21,098 bibls cite Aristotle (`tlg,0086`). ~89k bibls carry no `n=` at all.
`default="NO"` carries no signal. (These counts, and the LSJ-side work
numbers cited below, were read from the Diogenes-shipped LSJ on 2026-08-18;
they are not checkable from the repo alone — re-verify against the file
before relying on them.) Link only what fully resolves; never guess.

## Decisions

1. **Parse `n=` only for `tlg,0086` with a column:line ref.** No `n=`,
   non-Aristotle authors, works the site does not build, and refs without a
   parseable Bekker column all stay the inert span. (Rationale: minimal correct
   policy; a wrong link is worse than no link.)
2. **The tlg-work → site-work map is a new standalone table, not a manifest
   edit.** Manifest `tlg_work` drives the Diogenes export and uses a different
   numbering in two known cases: SE is `040` in `manifests/SE.yaml` but LSJ
   cites `039`; Juv is `918` (its First1K file) but LSJ cites `018`. The two
   namespaces collide for most works, which is exactly why the divergence went
   unnoticed. Touching manifests would change the corpus source — forbidden.
3. **APr and APo both cite tlg-work `001`.** Disambiguate by Bekker column
   against each work's range: APr 24a–70b, APo 71a–100b. A lookup, not a
   heuristic.
4. **Book resolution reuses `Manifest.book_for_line()`** (`config.py:92`, via
   `Manifest.for_work()` at `config.py:37`) with a module-level manifest cache.
   No new column index. Resolution always uses the **target** manifest, never
   the current work's: LSJ shards are corpus-wide
   (`stage7_emit._merge_shared_lsj`), and an entry's HTML is built once by
   whichever work first needs the key — a link must not depend on which work's
   popup shows it.
5. **Link format `/{work}/book/{n}?loc={col}:{line}`, site-root-relative,
   base-prefixed at render time.** The path shape is what `Reader.svelte`
   consumes (`L{col}-{line}` targets) and `check-links.mjs` verifies. But the
   live site serves under `base: '/aristotle-reader'`
   (`app/astro.config.mjs:16`), and `BekkerJump.svelte` prepends
   `import.meta.env.BASE_URL` to every link it builds. The pipeline cannot
   know the base, so shard HTML carries the base-less path and **every
   renderer prepends the base**. A raw `/EN/book/3?...` href shipped as-is
   would 404 on GH Pages while still passing `check-links.mjs` (which resolves
   it against `app/dist` as root) — this is the deploy-trap to guard with a
   test, not a gate.
6. **Two small render-time changes, both base-prefixing.** `sanitizeHtml`
   (`shared/lib/html.ts`) already allowlists `href` on `<a>`
   (`html.ts:90-92`); the site is an Astro MPA, so full-page navigation from
   the popup is correct. But the entry HTML is rendered in two places, and
   both must rewrite `.lsj-bibl` hrefs to `BASE_URL + path`:
   `WordPopup.svelte` (post-process the sanitized string before `{@html}`)
   and `app/src/components/LemmaPage.astro` (which already reads and
   sanitizes shard HTML at build time, `LemmaPage.astro:49-51`).
   Note: `security.test.ts` today only asserts a `javascript:` href is
   stripped — add an assertion that a safe relative href survives.
7. **`check-links.mjs` learns to see the shards.** Entry HTML reaches readers
   two ways: build-time on lemma pages (those links the existing crawler
   already sees once LemmaPage renders them) and client-side in the popup,
   fetched from `app/dist/data/lsj/<letter>.json` — invisible to the crawler.
   A shard pass over `app/dist/data/lsj/*.json` covers the popup path and any
   entry no lemma page renders.
8. **LSJ-sourced `?loc=` lines check against the reader's contract, not exact
   ids.** LSJ cites its own editions' lineation, which can differ from ours by
   a line or two (~48 of ~21k on the first build — Phys 7, PA 3, Rhet 2–3);
   the reader already snaps a missing line to the nearest line in the column
   (`Reader.svelte` nearest-line fallback). The gate mirrors that: for
   `.lsj-bibl` anchors (in HTML and in the shard pass) the COLUMN must exist
   on the target page, the exact line need not. Every other link keeps the
   strict exact-line check — real-data links have no excuse.

## Files

| File | Change |
|---|---|
| `pipeline/aristotle_pipeline/lsj_citation_map.py` | new — static table + `resolve_citation()` |
| `pipeline/aristotle_pipeline/stage5_lsj.py` | add a bibl-specific branch to `_to_html` (`stage5_lsj.py:81-113`) |
| `shared/components/WordPopup.svelte` | prepend `BASE_URL` to `.lsj-bibl` hrefs before `{@html}` |
| `app/src/components/LemmaPage.astro` | same rewrite at build time (`LemmaPage.astro:49-51`) |
| `scripts/check-links.mjs` | factor ref-check; add `app/dist/data/lsj/*.json` pass |
| `pipeline/tests/test_stage5_lsj.py` | new |
| `app/src/__tests__/security.test.ts` | assert a safe relative href survives sanitize |

Out of scope: `verify_shared_lsj.py` (its contract — every referenced key
resolves — is orthogonal) and all manifests.

## Data shape

```python
# lsj_citation_map.py — keyed by LSJ's Perseus-canon number, NOT manifest tlg_work
CITATION_WORKS: dict[str, str | list[tuple[str, str, str]]] = {
    "001": [("APr", "24a", "70b"), ("APo", "71a", "100b")],
    "006": "Cat",
    "010": "EN",
    "039": "SE",   # manifest says 040; LSJ cites 039
    # ... one entry per built work. Absent numbers (003 Ath., 011 Ep., 022 MM,
    # 036 Pr., 037 Resp., 043 Spir., 033/048/049/050/051 frr.) resolve to None.
}

def resolve_citation(tlg_work: str, column: str) -> str | None: ...
```

Populate the table by cross-checking each built work's `<title>` abbreviation
against the LSJ file's own `tlg,0086,NNN` usage (the method that caught SE and
Juv), not by copying manifest numbers. `047` is `MXG` (LSJ abbreviates it
`Xen.`).

## Implementation steps

1. `lsj_citation_map.py`: table + `resolve_citation(tlg_work, column)`, with
   the APr/APo boundary logic unit-testable on its own.
2. `stage5_lsj.py::_to_html` bibl branch: parse `n=`; on
   `resolve_citation()` + cached `book_for_line()` success emit the `<a>`;
   else the current span. No other rendering change.
3. Module-level manifest cache `{work_id: Manifest | None}` — the scan sees
   ~21k bibls; do not reload YAML per bibl.
4. `WordPopup.svelte` and `LemmaPage.astro`: rewrite `.lsj-bibl` hrefs to
   `BASE_URL + path` at render time (popup: post-process the sanitized
   string; lemma page: string rewrite where it already sanitizes,
   `LemmaPage.astro:49-51`).
5. `check-links.mjs`: extract the target-exists + `?loc=` anchor logic from
   `checkReference` (line 133) into a shared function; add a pass reading
   `app/dist/data/lsj/*.json`, regex-extracting `href="…"` from each entry's
   `html`, and running the shared check.
6. Tests (below), then a local `npm run build:public` and popup spot-checks:
   one SE lemma, one lemma citing near the APr/APo boundary — confirming the
   rendered href carries the base prefix.

## Test plan

`pipeline/tests/test_stage5_lsj.py`, fixture-string style of
`test_short_defs.py`:

- valid Aristotle bibl → `<a>` with correct work, book, `?loc=`
- APr/APo boundary: column `70b` → APr, `71a` → APo
- SE regression: `tlg,0086,039` → `SE` (and `040` absent from the table)
- non-Aristotle (`tlg,0059,...`, Plato) → inert span
- no `n=` / malformed `n=` / column-only ref → inert span
- unbuilt work (`tlg,0086,022` MM) → inert span

Front-end: a `WordPopup` (or shared helper) test asserting the `.lsj-bibl`
href rewrite prepends the base; the `security.test.ts` addition above.

`check-links.mjs` has no test harness. Either add a minimal fixture-dir Node
test for the new shard pass or record the gap in the PR — do not skip
silently.

## Acceptance criteria

- `uv run pytest tests/test_stage5_lsj.py` passes (from `pipeline/`).
- Full `npm run build:public` passes every existing gate.
- `node scripts/check-links.mjs app/dist` reports 0 broken, including the new
  shard pass.
- A built lemma page whose LSJ entry carries an Aristotle citation shows the
  href WITH the `/aristotle-reader` base prefix (grep `app/dist`); the shard
  JSON itself stays base-less.
- Grep proof that unresolved bibls are unchanged: entry HTML for a
  Theopompus-only entry is byte-identical before/after.
