<script lang="ts">
  // The desktop shell: persistent library rail · top bar · the website's
  // Reader.svelte mounted unchanged as the reading pane. Navigation is state
  // (work + book) with a keyed remount; jump-ins reuse the Reader's existing
  // URL contract (?loc=column:line, #hash) via history.replaceState, so the
  // Reader needs no desktop-specific changes.
  import Reader from '@shared/components/Reader.svelte';
  import { getWork, bookLabel, visibleTranslations } from '@shared/lib/works';
  import { invalidateBookCache, lineRef } from '@shared/lib/data';
  import { parseCitation } from '@shared/lib/palette';
  import { entryByDataId } from './lib/corpus';
  import { isTauri, errorText, type DataLayerInfo } from './lib/runtime';
  import LibraryRail from './components/LibraryRail.svelte';
  import BekkerJump from '@shared/components/BekkerJump.svelte';
  import ThemeToggle from './components/ThemeToggle.svelte';
  import LexiconIndex from './components/LexiconIndex.svelte';
  import LexiconEntry from './components/LexiconEntry.svelte';
  import ImportDialog from './components/ImportDialog.svelte';
  import Search from '@shared/components/Search.svelte';
  import CommandPalette from '@shared/components/CommandPalette.svelte';
  import Phrases from '@shared/components/Phrases.svelte';
  import { getImportCitation, type ImportSummary } from './lib/imports';
  import AnnotationsPanel from './components/AnnotationsPanel.svelte';
  import { exportLibrary, openExternal, reportProblem } from './lib/export';
  import { parseRouteHref, type RouteAction } from './lib/route-href';
  import {
    addAnnotation, annotationsProblem, captureSelection, listAnnotations, newId, paintAnnotations,
    paintPending, clearPending, greekRange, englishRange,
    copySelectionPlain, copySelectionWithCitation, CROSS_COLUMN, PALETTE,
    extractCleanText, greekCiteForRange, segCiteForRange,
    type Annotation, type AnnStyle, type AnnColor, type CaptureResult,
  } from './lib/annotations';
  import { paintEmphasis } from './lib/emphasis-paint';
  import { importLoadProblems } from './lib/imports';
  import { onMount, onDestroy, tick } from 'svelte';

  export let dataLayer: DataLayerInfo;

  // ── Location state ────────────────────────────────────────────────────────
  let workId = 'EN';
  let bookNum = 1;
  let navSeq = 0;              // bumps on every navigation → keyed remount
  try {
    const saved = JSON.parse(localStorage.getItem('desktop-loc') ?? 'null');
    if (saved && getWork(saved.work)) {
      workId = saved.work;
      bookNum = Math.min(Math.max(1, saved.book ?? 1), getWork(saved.work)!.books);
    }
  } catch { /* first launch */ }

  $: meta = getWork(workId);
  $: busse = meta?.citation?.scheme === 'busse';
  $: titleSuffix = meta && meta.books > 1 ? ` · Book ${bookLabel(meta, bookNum)}` : '';

  // Optional curated chapter titles ({book: {chapter: title}}) — the website
  // reads this at build time in ReaderShell; the desktop fetches it at runtime.
  // Missing file = headings fall back to "Chapter N", same as the site.
  // Loaded BEFORE the Reader remounts (see nav below): a late title update
  // re-renders the chapter headings, and that layout shift aborts the Reader's
  // in-flight smooth scroll to a jumped-to line.
  const dataRoot = () =>
    (globalThis as { __ARISTOTLE_DATA_ROOT__?: string }).__ARISTOTLE_DATA_ROOT__ ?? '/data';
  let chapterTitles: Record<string, string> = {};
  const _titlesCache = new Map<string, Record<string, Record<string, string>>>();
  async function loadTitles(id: string): Promise<Record<string, Record<string, string>>> {
    const cached = _titlesCache.get(id);
    if (cached) return cached;
    const all = await fetch(`${dataRoot()}/${id}/chapter-titles.json`)
      .then(r => (r.ok ? r.json() : {}))
      .catch(() => ({}));
    _titlesCache.set(id, all);
    return all;
  }
  // §Phase-4B-revised (John's call 2026-07-06): this map is built-in
  // chapter-titles.json ONLY — work-level chrome shared by every
  // translation. An imported translation's own converter-derived titles are
  // NOT merged in here; they render as a small unaligned heading inside that
  // import's own overlay column instead (Reader.svelte's transFlow, via
  // imports.ts's getImportTitle/__ARISTOTLE_IMPORT_TITLE_HOOK__).
  loadTitles(workId).then(all => { chapterTitles = all[String(bookNum)] ?? {}; });

  function persistLoc() {
    try { localStorage.setItem('desktop-loc', JSON.stringify({ work: workId, book: bookNum })); } catch { /* fine */ }
  }

  // Set the URL the Reader will parse on mount (?loc= forces bilingual + line
  // scroll, ?hlg= highlights a Greek term; #hash covers chapter targets), then
  // remount it.
  async function nav(id: string, book?: number, opts: { loc?: string; hash?: string; hlg?: string; hle?: string } = {}) {
    const m = getWork(id);
    if (!m) return;
    // A note editor (or its ann-pending highlight) or the context menu can be
    // left open across a work/book change — since navigation here can change
    // workId/bookNum, an editor still open afterwards would save its captured
    // target (anchored to the PREVIOUS work/book) tagged with the NEW workId,
    // cross-contaminating that work's annotation file. Cancel/close before any
    // state changes below. (Belt-and-braces: saveNote() also uses the work id
    // stamped onto the noteEditor at open time, not the live workId, so even a
    // missed navigation path here can't cross-contaminate.)
    if (noteEditor) cancelNote();
    if (ctxMenu) closeCtx();
    let b = book ?? bookNum;
    if (id !== workId && book === undefined) {
      // Entering a work fresh: resume its last-read book if the Reader saved one —
      // and, when the caller didn't ask for a specific spot, the last-read
      // Bekker position within it (the site's work-switcher does the same).
      const savedBook = (() => { try { return localStorage.getItem(`reader-book-${id}`); } catch { return null; } })();
      b = savedBook ? Number(savedBook) : 1;
      if (!opts.loc && !opts.hash && !opts.hlg && !opts.hle) {
        const savedLoc = (() => { try { return localStorage.getItem(`reader-loc-${id}`); } catch { return null; } })();
        if (savedLoc) opts = { ...opts, hash: savedLoc };
      }
    }
    b = Math.min(Math.max(1, b), m.books);
    // Titles resolved before the remount so the first render is final (no
    // late heading reflow under the Reader's jump scroll).
    const allTitles = await loadTitles(id);
    chapterTitles = allTitles[String(b)] ?? {};
    const params = new URLSearchParams();
    if (opts.loc) params.set('loc', opts.loc);
    if (opts.hlg) params.set('hlg', opts.hlg);
    if (opts.hle) params.set('hle', opts.hle);
    const qs = params.toString();
    const url = `/${qs ? `?${qs}` : ''}${opts.hash ? `#${opts.hash}` : ''}`;
    try { history.replaceState(null, '', url); } catch { /* tauri origin quirks */ }
    workId = id;
    bookNum = b;
    navSeq += 1;
    persistLoc();
    scrollTo({ top: 0 });
    if (opts.loc) {
      const [col, ln] = opts.loc.split(':');
      armJumpVerifier(col, ln);
    }
  }

  // The Reader's own jump-in scroll is smooth and one-shot; anything that
  // shifts layout mid-flight (font swap, image, late data) can abort it and
  // strand the view at the top. Verify the target actually made it on screen
  // and correct instantly if not — never fight a scroll that succeeded.
  let jumpSeq = 0;
  // `line` is the citation's line as written, letter and all ("11a"): it is
  // spliced straight into the anchor id, and Number('11a') is NaN.
  function armJumpVerifier(col: string, line: string) {
    const seq = ++jumpSeq;
    const check = (attempt: number) => {
      if (seq !== jumpSeq) return;             // superseded by a newer jump
      const el = document.getElementById(`L${col}-${line}`);
      if (el) {
        const r = el.getBoundingClientRect();
        const inView = r.top >= 0 && r.top <= window.innerHeight * 0.85;
        if (inView) return;                     // the Reader's scroll landed
        el.scrollIntoView({ behavior: 'auto', block: 'center' });
        // Late layout drift (fonts, figures) can nudge the line back out of
        // view after an instant correction — verify once more before trusting.
        if (attempt < 3) setTimeout(() => check(attempt + 1), 900);
        return;
      }
      if (attempt < 3) setTimeout(() => check(attempt + 1), 900); // book still loading
    };
    setTimeout(() => check(0), 1100);
  }

  function onOpenWork(id: string, book?: number) { nav(id, book); }

  function onOpenChapter(book: number, chapter: string) {
    const target = `ch-${book}-${chapter}`;
    if (book === bookNum) {
      document.getElementById(target)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else {
      nav(workId, book, { hash: target });
    }
  }

  function onBekkerJump(book: number, column: string, line: number, sub?: string) {
    nav(workId, book, { loc: `${column}:${lineRef(line, sub)}` });
  }

  // ── Live citation tracking for the rail ───────────────────────────────────
  // The Reader's scroll-spy rewrites location.hash via history.replaceState,
  // which fires NO event — so sample the hash on (throttled) scroll and hand
  // it to the rail, which maps it to the on-screen chapter.
  let currentCite: string | null = null;
  let citeTimer: ReturnType<typeof setTimeout> | undefined;
  function sampleCite() {
    const h = decodeURIComponent(location.hash.slice(1));
    const cite = h && !h.startsWith('ch-') ? h : null;
    if (cite !== currentCite) currentCite = cite;
  }
  function onWinScroll() {
    if (ctxMenu) closeCtx();
    if (citeTimer) return;
    citeTimer = setTimeout(() => { citeTimer = undefined; sampleCite(); }, 250);
  }

  // ── Lexicon overlay ───────────────────────────────────────────────────────
  // The browsable dictionary (site: /lemma + /lemma/<slug>), ported as a
  // full-pane overlay with its own scroll so the reader underneath keeps its
  // exact position. null = closed; { slug: null } = the index.
  let lexicon: { slug: string | null } | null = null;
  function openLexicon(slug: string | null = null) { lexicon = { slug }; }
  function closeLexicon() { lexicon = null; }
  function lexiconJump(work: string, book: number, column: string, line: number, surface: string, sub?: string) {
    closeLexicon();
    nav(work, book, { loc: `${column}:${lineRef(line, sub)}`, hlg: surface });
  }
  function onEsc(e: KeyboardEvent) {
    // The palette binds Escape itself (bubble). Capture would close the
    // overlay underneath it first; leave the event alone while it's open.
    if (e.key === 'Escape' && document.querySelector('.cp-backdrop')) return;
    if (e.key === 'Escape' && ctxMenu) { e.stopPropagation(); closeCtx(); return; }
    if (e.key === 'Escape' && noteEditor) { e.stopPropagation(); cancelNote(); return; }
    if (e.key === 'Escape' && searchOpen) { e.stopPropagation(); searchOpen = false; return; }
    if (e.key === 'Escape' && phrasesOpen) { e.stopPropagation(); phrasesOpen = false; return; }
    if (e.key === 'Escape' && lexicon) { e.stopPropagation(); closeLexicon(); }
    if (e.key === 'Escape' && armed && !searchOpen && !phrasesOpen && !lexicon) { setArmed(false); return; }
    // Palette owns ⌘K. ⇧⌘K / Ctrl-Shift-K opens search from anywhere.
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      e.stopPropagation();
      searchOpen = true;
    }
  }

  // ── Search overlay ────────────────────────────────────────────────────────
  // The site's Search.svelte mounted whole (dual boxes, All/Any/Phrase,
  // lemma/form, wildcards, works refine, CSV export), plus the desktop-only
  // accent-sensitivity toggle via its accentOption prop. Result links are
  // ordinary reader hrefs — the global click interceptor below turns them
  // into in-app navigation. Prefill arrives via location.search (?g= / ?e=)
  // on a fresh mount — the palette writes that query then opens this overlay.
  let searchOpen = false;

  // ── Phrase browser overlay ────────────────────────────────────────────────
  // The site's Phrases.svelte as a full-pane overlay (same chrome as Search).
  // Result links are ordinary reader hrefs — the interceptor navigates in-app.
  let phrasesOpen = false;

  // ── Import flow ───────────────────────────────────────────────────────────
  // Both entry points the plan requires: a button (native picker) and true
  // drag-and-drop onto the library. A finished import re-attaches the new
  // overlay to the open book (see closeImport) without a full page reload.
  let importDlg: { file: { name: string; text: string } | null } | null = null;
  function openImport() { importDlg = { file: null }; }
  function closeImport(imported: ImportSummary | null) {
    importDlg = null;
    if (!imported) return;
    // runImport already updated the registered overlays and (for a fresh
    // translation) the picker list — both surface through globals the Reader
    // reads at mount time: works.ts's visibleTranslations and the fetchBook
    // book hook. But fetchBook caches the hooked BookData, so a book already
    // loaded before the import keeps showing its pre-import text until that
    // cache is dropped and the Reader re-fetches. We used to force this with
    // location.reload(), but reload is unreliable in the Tauri webview (⌘R
    // isn't wired there either) and the stale text survived a re-import.
    // Instead: evict every cached book for the affected work, then navigate
    // into it — nav() bumps navSeq, remounting the Reader, which re-fetches
    // (now a cache miss) and re-runs the book hook against the fresh
    // registration, so the overlay re-attaches. finish() already pointed
    // desktop-loc + reader-trans at the imported translation (book 1); nav
    // here mirrors that jump.
    invalidateBookCache(imported.meta.work);
    nav(imported.meta.work, 1);
  }
  let dragOver = false;
  const IMPORTABLE = /\.(txt|md)$/i;

  // HTML5 fallback for the plain-browser dev harness. Packaged Tauri v2
  // webviews intercept OS file drags before any HTML5 `drop` event fires
  // (see the Tauri-event subscription below), so this path is dead weight
  // there but harmless — isTauri() gates it off.
  function onDragOver(e: DragEvent) {
    if (isTauri()) return;
    if (e.dataTransfer?.types.includes('Files')) {
      e.preventDefault();
      dragOver = true;
    }
  }
  function onDragLeave() {
    if (isTauri()) return;
    dragOver = false;
  }
  async function onDrop(e: DragEvent) {
    if (isTauri()) return;
    dragOver = false;
    const f = e.dataTransfer?.files?.[0];
    if (!f) return;
    e.preventDefault();
    if (!IMPORTABLE.test(f.name)) return;
    importDlg = { file: { name: f.name, text: await f.text() } };
  }

  // Packaged-app path: subscribe to Tauri's native drag-drop events for the
  // whole window. Only acts when the import dialog isn't already open — once
  // it is, ImportDialog.svelte owns its own subscription so a drop is handled
  // exactly once.
  let unlistenShellDragDrop: (() => void) | null = null;
  onMount(() => {
    if (!isTauri()) return;
    let cancelled = false;
    (async () => {
      const { getCurrentWebview } = await import('@tauri-apps/api/webview');
      const unlisten = await getCurrentWebview().onDragDropEvent(event => {
        if (importDlg) return; // dialog's own listener is handling this drop
        switch (event.payload.type) {
          case 'enter':
          case 'over':
            dragOver = true;
            break;
          case 'leave':
            dragOver = false;
            break;
          case 'drop': {
            dragOver = false;
            const [path] = event.payload.paths;
            if (!path) break;
            const name = path.split(/[/\\]/).pop() ?? path;
            if (!IMPORTABLE.test(name)) break;
            (async () => {
              const { readTextFile } = await import('@tauri-apps/plugin-fs');
              importDlg = { file: { name, text: await readTextFile(path) } };
            })();
            break;
          }
        }
      });
      if (cancelled) unlisten();
      else unlistenShellDragDrop = unlisten;
    })();
    return () => { cancelled = true; };
  });
  onDestroy(() => {
    if (unlistenShellDragDrop) unlistenShellDragDrop();
  });

  // ── Annotations ───────────────────────────────────────────────────────────
  // Highlights + notes (one type; see lib/annotations.ts for the anchor
  // rules). Painting uses the CSS Custom Highlight API and re-runs whenever
  // the reader's DOM changes (nav, book load, view/translation switch) via a
  // debounced MutationObserver — the Reader itself is never modified.
  let annOpen = (() => {
    try { return localStorage.getItem('desktop-ann') === 'open'; } catch { return false; }
  })();
  function toggleAnn() {
    annOpen = !annOpen;
    try { localStorage.setItem('desktop-ann', annOpen ? 'open' : 'closed'); } catch { /* fine */ }
  }
  let annotations: Annotation[] = [];
  // The translation currently filling the English column — the Reader's own
  // resolution order: saved choice (if still valid), else the work's declared
  // default, else the primary 'english' slot.
  const activeTrans = (): string => {
    const m = getWork(workId);
    const ts = m ? visibleTranslations(m) : [];
    try {
      const saved = localStorage.getItem(`reader-trans-${workId}`);
      if (saved && (saved === 'compare' || ts.some(t => t.id === saved))) return saved;
    } catch { /* fall through */ }
    return ts.find(t => t.id === m?.defaultTranslation)?.id
      ?? ts.find(t => t.slot === 'english')?.id
      ?? ts[0]?.id
      ?? '';
  };
  // Which translation id(s) are actually on screen — mono: the one active
  // translation; compare: the pair actually rendered by Reader.svelte.
  //
  // Reader only WRITES its reader-cmpl-<work>/reader-cmpr-<work> localStorage
  // keys when the user changes the compare-pair dropdown (see saveCompare()
  // there) — entering compare mode with the defaults left untouched leaves
  // those keys absent, which used to make this resolve to [] and blank out
  // every compare-view highlight/note. Most robust source of truth is the
  // rendered DOM itself: the compare columns carry a `data-trans` attribute
  // (see Reader's .english-col/.overlay-col) naming exactly what's on screen,
  // regardless of how the pair was arrived at. Fall back to the localStorage
  // keys, then to Reader's own default-pair resolution (mirrored here) for
  // the brief window right after mount/nav before the Reader has painted —
  // the MutationObserver below re-runs this once that DOM lands.
  const shownTranslations = (t: string): string[] => {
    if (t !== 'compare') return [t];
    const fromDom = new Set<string>();
    document.querySelectorAll<HTMLElement>('.english-col[data-trans], .overlay-col[data-trans]')
      .forEach(el => { const v = el.getAttribute('data-trans'); if (v) fromDom.add(v); });
    if (fromDom.size) return [...fromDom];
    try {
      const l = localStorage.getItem(`reader-cmpl-${workId}`);
      const r = localStorage.getItem(`reader-cmpr-${workId}`);
      const pair = [l, r].filter((x): x is string => !!x);
      if (pair.length) return pair;
    } catch { /* fall through */ }
    // Mirrors Reader.svelte's own compareLeft/compareRight defaults:
    // engSlot ?? translations[0] for the left, first secondary ?? translations[1]
    // ?? left for the right.
    const m = getWork(workId);
    const ts = m ? visibleTranslations(m) : [];
    const engSlot = ts.find(x => x.slot === 'english');
    const secondaries = ts.filter(x => x.slot !== 'english');
    const left = engSlot?.id ?? ts[0]?.id ?? 'english';
    const right = secondaries[0]?.id ?? ts[1]?.id ?? left;
    return [left, right].filter((x, i, a) => !!x && a.indexOf(x) === i);
  };
  let annTransShown = '';       // single active translation id (mono) or 'compare'
  let annShown: string[] = [];  // translation id(s) actually rendered — for paint/panel
  // Works whose annotations file could not be read, already announced —
  // once per work, not on every repaint.
  const annProblemShown = new Set<string>();
  async function refreshAnnotations() {
    annotations = [...await listAnnotations(workId)];
    const annProblem = annotationsProblem(workId);
    if (annProblem && !annProblemShown.has(workId)) {
      annProblemShown.add(workId);
      showToast(annProblem, 15000);
    }
    annTransShown = activeTrans();
    annShown = shownTranslations(annTransShown);
    paintAnnotations(annotations, annShown);
    // Imported-translation markdown emphasis (italic/bold) — a no-op for any
    // id in annShown that isn't a registered import (getImportEmphasis
    // returns [] for built-ins), so this is safe to call unconditionally
    // alongside paintAnnotations. See emphasis-paint.ts for why DOM surgery
    // (real <em>/<strong> elements) is used instead of ::highlight() — the
    // Custom Highlight API can't paint font-style.
    paintEmphasis(workId, bookNum, annShown);
  }
  $: if (workId) refreshAnnotations();

  let paintTimer: ReturnType<typeof setTimeout> | undefined;
  onMount(() => {
    const mo = new MutationObserver(() => {
      clearTimeout(paintTimer);
      paintTimer = setTimeout(() => {
        annTransShown = activeTrans();
        annShown = shownTranslations(annTransShown);
        paintAnnotations(annotations, annShown);
        paintEmphasis(workId, bookNum, annShown);
      }, 300);
    });
    mo.observe(document.body, { childList: true, subtree: true });
    return () => mo.disconnect();
  });

  // Capture-phase interception for the packaged app's native context menu —
  // see the long comment above `shouldInterceptContextMenu` for why this is
  // registered on `window` at capture phase instead of relying solely on the
  // `.dt-main` bubble-phase `contextmenu` listener.
  onMount(() => {
    window.addEventListener('contextmenu', onReaderContextMenu, true);
    window.addEventListener('mousedown', onReaderMouseDownCapture, true);
    document.addEventListener('copy', onDocumentCopy, true);
    // Stored translations loadImports() could not read at startup: say so
    // here rather than let them vanish from the picker unexplained.
    const problems = importLoadProblems();
    if (problems.length) showToast(problems.join(' '), 15000);
  });
  onDestroy(() => {
    window.removeEventListener('contextmenu', onReaderContextMenu, true);
    window.removeEventListener('mousedown', onReaderMouseDownCapture, true);
    document.removeEventListener('copy', onDocumentCopy, true);
  });

  // ── Annotate mode: armed toggle + persistent palette ──────────────────────
  // ReadCube-Papers style: no selection-anchored popup. While armed, a
  // selection instantly applies the active tool+color at mouseup. Disarmed,
  // left-click selection does nothing (the site's own Copy pill is killed
  // unconditionally — see desktop.css — and copy/annotate both live in the
  // right-click menu below).
  let armed = (() => {
    try { return localStorage.getItem('desktop-annmode') === 'on'; } catch { return false; }
  })();
  let tool: AnnStyle | 'note' = (() => {
    try { return (localStorage.getItem('desktop-anntool') as AnnStyle | 'note' | null) ?? 'highlight'; }
    catch { return 'highlight'; }
  })();
  let color: AnnColor = (() => {
    try { return (localStorage.getItem('desktop-anncolor') as AnnColor | null) ?? 'yellow'; }
    catch { return 'yellow'; }
  })();
  function setArmed(v: boolean) {
    armed = v;
    try { localStorage.setItem('desktop-annmode', v ? 'on' : 'off'); } catch { /* fine */ }
  }
  function toggleArmed() { setArmed(!armed); }
  $: try { localStorage.setItem('desktop-anntool', tool); } catch { /* fine */ }
  $: try { localStorage.setItem('desktop-anncolor', color); } catch { /* fine */ }

  // The palette strip docks left-aligned under the Annotate toggle — measure
  // the button (and re-measure) whenever anything could move it or the
  // reader area it must stay clear of: arming, the Notes panel opening/
  // closing (it's a flex sibling that narrows `.dt-main`), the library rail
  // toggling, or a window resize. Fixed-position elements are never
  // repositioned by layout alone, so without this it strands at its
  // first-measured spot and can overlap the Notes panel once that panel
  // narrows the reader area.
  let annotateBtnEl: HTMLButtonElement | null = null;
  let topbarEl: HTMLElement | null = null;
  let dtMainEl: HTMLElement | null = null;
  let annBarEl: HTMLElement | null = null;
  let annBarLeft = 16;
  let annBarTop = 56;
  function measureAnnBar() {
    if (annotateBtnEl) annBarLeft = annotateBtnEl.getBoundingClientRect().left;
    if (topbarEl) annBarTop = topbarEl.getBoundingClientRect().bottom + 6;
    clampAnnBar();
  }
  // Clamp so the palette's right edge never crosses the reader area's right
  // boundary (`.dt-main`'s own right edge — this shrinks when the Notes
  // panel is open, unlike `innerWidth`) — shift left as needed, min left 8px.
  function clampAnnBar() {
    const w = annBarEl?.getBoundingClientRect().width ?? 0;
    const rightBound = dtMainEl ? dtMainEl.getBoundingClientRect().right : innerWidth;
    if (annBarLeft + w > rightBound - 8) annBarLeft = Math.max(8, rightBound - 8 - w);
  }
  async function placeAnnBar() {
    await tick();
    measureAnnBar();
    // The top bar (and `.dt-main`'s width, if the Notes panel is mid-
    // transition) can still be settling right when this runs — one
    // follow-up measurement after layout settles avoids stranding the strip
    // at a transient position.
    setTimeout(measureAnnBar, 250);
  }
  // Re-anchor whenever armed flips on, the Notes panel toggles, or the
  // library rail toggles — each of these changes `.dt-main`'s width/position
  // without moving the (fixed) palette itself, so it must be re-measured.
  // `annReanchorKey` changes on every one of those events; Svelte re-runs the
  // dependent statement below each time it does (even when armed was already
  // true, which a plain `if (armed)` alone would miss).
  $: annReanchorKey = `${armed}:${annOpen}:${railOpen}`;
  $: if (armed) { annReanchorKey; placeAnnBar(); }
  function onAnnBarResize() {
    if (armed) measureAnnBar();
  }
  onMount(() => {
    window.addEventListener('resize', onAnnBarResize);
    return () => window.removeEventListener('resize', onAnnBarResize);
  });

  /** Instant highlight/underline apply — no popup, no capture-at-toolbar-open
   * dance: capture happens right at mouseup (or at context-menu open), before
   * any focus change, so there's no selection-clearing hazard. */
  async function applyMark(cap: CaptureResult, style: AnnStyle) {
    try {
      await addAnnotation({
        id: newId(), work: workId, created: new Date().toISOString(),
        body: '', layer: cap.layer, target: cap.target, exact: cap.exact,
        style, color,
      });
    } catch (e) {
      showToast(`Highlight not saved: ${errorText(e)}`, 10000);
      return;
    }
    // Deliberately keep the selection alive: in armed mode instant-apply would
    // otherwise consume it, leaving right-click (Copy with citation, etc.)
    // nothing to act on. It clears itself on the next click.
    await refreshAnnotations();             // repaints via paintAnnotations
  }

  function onReaderMouseUp(e: MouseEvent) {
    if (e.button !== 0 || e.ctrlKey) return; // right-click & macOS ctrl-click = context menu path
    if (!armed) return;                      // disarmed: nothing happens on plain selection
    setTimeout(() => {
      if (lexicon || searchOpen || importDlg) return;
      if (noteEditor) return;                // don't tear down an open note editor
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
      const el = sel.anchorNode?.nodeType === 1 ? sel.anchorNode as Element
               : sel.anchorNode?.parentElement ?? null;
      if (!el?.closest('.segment')) return;  // outside reader prose
      const t = activeTrans();
      const cap = captureSelection(bookNum, t === 'compare' ? '' : t);
      if (cap === CROSS_COLUMN) { showToast('Select within one column to annotate'); return; }
      if (!cap) return;                      // unanchorable — silently ignore (armed)
      if (tool === 'note') {
        openNoteEditor(cap, sel.getRangeAt(0).getBoundingClientRect());
      } else {
        void applyMark(cap, tool);           // instant highlight/underline
      }
    }, 0);
  }

  // ── Note editor ────────────────────────────────────────────────────────────
  // Replaces the old selection-toolbar textarea. Capture-first-then-focus:
  // `cap` is captured at mouseup/context-menu (above), THEN the editor opens,
  // so focusing the textarea (which clears the DOM selection) is harmless.
  // `placed` starts false so the initial (possibly off-screen) x/y is never
  // painted at all — the clamp reactive block below runs before first paint
  // is visible to the user, same tick()-then-measure shape as the ctxMenu
  // flip clamp, and flips `placed` true once it has clamped into the viewport.
  // `work` is the id captured at OPEN time — belt-and-braces against any
  // navigation path that changes workId without going through nav()'s
  // cancelNote() call: saveNote() writes annotations tagged with THIS stored
  // id, never the (possibly since-changed) live workId, so a missed cancel
  // can't cross-contaminate another work's annotation file.
  let noteEditor: { work: string; cap: CaptureResult; x: number; y: number; text: string; placed: boolean } | null = null;
  let noteEditorEl: HTMLElement | null = null;
  function openNoteEditor(cap: CaptureResult, rect: DOMRect) {
    noteEditor = {
      work: workId, cap, text: '', placed: false,
      x: Math.min(rect.right + 10, window.innerWidth - 300),
      y: Math.max(8, rect.bottom + 10),
    };
    // Focusing the textarea (autofocus, right below) clears the DOM selection,
    // so without this the user can't see what text the note is about until
    // Save repaints it for real. Re-derive the Range from the already-captured
    // target (not a clone of the live selection Range) — the capture-first
    // pattern means `cap` outlives the selection anyway, and re-resolving
    // through the same greekRange/englishRange the real painter uses keeps
    // this in lockstep with however the reader is currently rendered.
    const rs = cap.target.kind === 'greek'
      ? greekRange(cap.target)
      : englishRange(cap.target, annShown);
    paintPending(rs, color);
    _pendingSelRect = rect;
  }
  let _pendingSelRect: DOMRect | null = null;
  // Clamp the editor fully inside the viewport once its real size is known
  // (mirrors the ctxMenu flip-clamp below: measure after render, adjust once).
  // If the natural position (bottom-right of the selection) doesn't fit,
  // prefer placing ABOVE the selection rect before falling back to a raw clamp.
  $: if (noteEditor && !noteEditor.placed && noteEditorEl) {
    const r = noteEditorEl.getBoundingClientRect();
    const margin = 8;
    let { x, y } = noteEditor;
    const overflowsRight = x + r.width > innerWidth - margin;
    const overflowsBottom = y + r.height > innerHeight - margin;
    if (overflowsBottom && _pendingSelRect) {
      const above = _pendingSelRect.top - r.height - 10;
      if (above >= margin) y = above;
    }
    x = Math.min(Math.max(x, margin), Math.max(margin, innerWidth - r.width - margin));
    y = Math.min(Math.max(y, margin), Math.max(margin, innerHeight - r.height - margin));
    if (x !== noteEditor.x || y !== noteEditor.y || overflowsRight || overflowsBottom) {
      noteEditor = { ...noteEditor, x, y, placed: true };
    } else {
      noteEditor.placed = true;
    }
  }

  // Dragging: pointer-down on the slim header handle only (never the textarea).
  // Clamped so at least the handle stays on-screen while dragging.
  let dragOff: { x: number; y: number } | null = null;
  function onNoteDragStart(e: PointerEvent) {
    if (!noteEditor) return;
    dragOff = { x: e.clientX - noteEditor.x, y: e.clientY - noteEditor.y };
    // setPointerCapture can throw (NotFoundError) if the platform has no
    // active pointer with this id — harmless to skip; dragging still works
    // via the bubbled pointermove/pointerup, capture just makes it robust
    // against the pointer leaving the handle mid-drag.
    try { (e.target as HTMLElement).setPointerCapture(e.pointerId); } catch { /* fine */ }
  }
  function onNoteDragMove(e: PointerEvent) {
    if (!noteEditor || !dragOff) return;
    const w = noteEditorEl?.getBoundingClientRect().width ?? 0;
    const h = noteEditorEl?.getBoundingClientRect().height ?? 0;
    const margin = 8;
    const x = Math.min(Math.max(e.clientX - dragOff.x, margin), Math.max(margin, innerWidth - w - margin));
    const y = Math.min(Math.max(e.clientY - dragOff.y, margin), Math.max(margin, innerHeight - h - margin));
    noteEditor = { ...noteEditor, x, y };
  }
  function onNoteDragEnd(e: PointerEvent) {
    dragOff = null;
    try { (e.target as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* fine */ }
  }

  async function saveNote() {
    if (!noteEditor) return;
    const { work, cap, text } = noteEditor;
    try {
      await addAnnotation({
        id: newId(), work, created: new Date().toISOString(),
        body: text.trim(), layer: cap.layer, target: cap.target, exact: cap.exact,
        style: tool === 'note' ? 'highlight' : tool, color,
      });
    } catch (e) {
      // The editor stays open with the text intact — nothing was written.
      showToast(`Note not saved: ${errorText(e)}`, 10000);
      return;
    }
    noteEditor = null;
    _pendingSelRect = null;
    clearPending();
    window.getSelection()?.removeAllRanges();
    // If navigation happened without a cancel (shouldn't, given nav()'s guard,
    // but this stays correct either way) the panel/list refresh below is for
    // the CURRENT workId, which may differ from the work the note was just
    // saved to — refreshAnnotations() reads workId's own file, so that's still
    // correct; the note simply won't show until you're back on its work.
    await refreshAnnotations();
    annOpen = true;                          // reveal the panel so the note is visible
    showToast('Note saved');
  }
  function cancelNote() {
    noteEditor = null;
    _pendingSelRect = null;
    clearPending();
    window.getSelection()?.removeAllRanges();
  }

  // ── Right-click context menu (armed AND disarmed) ─────────────────────────
  // Net rule: the desktop app has NO selection-anchored popup of any kind.
  // Selection actions live here (armed or not) and in armed-mode instant
  // apply above. Capture happens at menu-open (same capture-first pattern as
  // the note editor) so later clicks/focus changes can't lose the anchor.
  //
  // Belt-and-braces interception: packaged Tauri (WKWebView on macOS) can let
  // its NATIVE context menu (Look Up / Translate / Search with Google /
  // Writing Tools) break through even when a `contextmenu` listener on
  // `.dt-main` calls preventDefault — Chromium dev never showed this, only
  // the packaged webview. Two capture-phase `window` listeners registered in
  // onMount (below `.dt-main`'s own DOM position is irrelevant — capture runs
  // top-down from window first) close both gaps:
  //   1. `contextmenu` at capture phase — runs before any bubble-phase
  //      handler, so the native menu has no chance to see an un-prevented
  //      event first.
  //   2. `mousedown` (button 2) at capture phase — macOS webviews can commit
  //      to the native menu right at right-mousedown, before `contextmenu`
  //      ever fires; preventDefault there heads that off too.
  // The `.dt-main` `on:contextmenu` wiring is removed so this can't double-fire.
  // `rect` is the selection's bounding rect captured AT MENU-OPEN TIME (same
  // capture-first pattern as `cap`) — on WebKit, focusing a menu button can
  // collapse or clear window.getSelection() before a later click handler runs,
  // so ctxNote() must never re-read the live selection to position the note
  // editor; it uses this stored rect instead.
  let ctxMenu: { x: number; y: number; cap: CaptureResult | null; crossCol: boolean; rect: DOMRect | null } | null = null;
  let ctxEl: HTMLElement | null = null;
  // Exact predicate (unchanged from the original .dt-main handler): intercept
  // only when the target is inside `.segment` AND there is a non-collapsed,
  // non-empty text selection AND no overlay (lexicon/search/import/note
  // editor) is open. Native menu must still appear over inputs/chrome/no
  // selection — this returns false in those cases.
  function isEditableTarget(target: EventTarget | null): boolean {
    const el = target instanceof Element ? target : (target as Node | null)?.parentElement ?? null;
    return !!el?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])');
  }

  function shouldInterceptContextMenu(target: EventTarget | null): boolean {
    if (lexicon || searchOpen || importDlg || noteEditor) return false; // overlay open: default menu
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0 || !sel.toString().trim()) return false; // empty: default menu
    const el = target instanceof Element ? target : (target as Node | null)?.parentElement ?? null;
    if (!el?.closest('.segment')) return false;                        // outside reader prose: default menu
    return true;
  }
  function onReaderContextMenu(e: MouseEvent) {
    if (!shouldInterceptContextMenu(e.target)) {
      // Editable fields keep the native menu (paste, spelling); everywhere
      // else suppress it outright — the webview default ("Reload") has no
      // place in a shipped reading app.
      if (!isEditableTarget(e.target)) e.preventDefault();
      return;
    }
    e.preventDefault();                                                // suppress native webview menu
    e.stopPropagation();
    const t = activeTrans();
    const c = captureSelection(bookNum, t === 'compare' ? '' : t);
    // Capture the selection's rect NOW — by the time a menu item is clicked,
    // WebKit may have already collapsed/cleared the selection (button focus),
    // and getRangeAt(0) on a rangeCount-0 selection throws.
    let rect: DOMRect | null = null;
    try {
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0) rect = sel.getRangeAt(0).getBoundingClientRect();
    } catch { /* leave null; ctxNote falls back to the menu position */ }
    ctxMenu = {
      x: e.clientX, y: e.clientY,
      cap: (c === CROSS_COLUMN || !c) ? null : c,
      crossCol: c === CROSS_COLUMN,
      rect,
    };
  }
  // macOS WKWebView can commit to the native menu at right-mousedown itself,
  // before `contextmenu` fires — preventDefault here under the same predicate
  // heads that off. Button 0 (ctrl-click) is untouched; ctrl-click is covered
  // by the contextmenu event above.
  function onReaderMouseDownCapture(e: MouseEvent) {
    if (e.button !== 2) return;
    if (!shouldInterceptContextMenu(e.target)) return;
    e.preventDefault();
  }
  function closeCtx() { ctxMenu = null; }
  async function ctxCopy() {
    const ok = await copySelectionPlain();
    closeCtx();
    showToast(ok ? 'Copied' : 'Could not access the clipboard');
  }
  async function ctxCopyCite() {
    const ok = await copySelectionWithCitation(meta?.abbr ?? '');
    closeCtx();
    showToast(ok ? 'Copied with citation' : 'Could not access the clipboard');
  }

  // ── Normal copy path (⌘C / Edit ▸ Copy / native copy) ──────────────────────
  // The site's own Reader.svelte has an `on:copy` handler on `.reader-body`
  // (bubble phase) that reads raw `selection.toString()` — which inserts a
  // newline between every separately-rendered `.greek-line` and leaves Ostwald's
  // inline `.fn-marker` footnote digits in the text — then, ONLY when the
  // reader's "Append citation on copy" setting (localStorage
  // 'reader-cite-copy', default true) is on AND the selection resolves to a
  // Greek line, appends `\n(ABBR start–end)` and calls preventDefault; with the
  // setting off, or off a Greek line, it does nothing at all and the browser's
  // raw (uncleaned) copy goes through untouched. That raw-newline/raw-digit
  // path is exactly what the owner is reporting here.
  //
  // Fix, desktop-side only: intercept 'copy' at the DOCUMENT capture phase —
  // ahead of the site's own bubble-phase listener — so ours runs first and
  // (by calling stopPropagation) the site's handler never runs at all for a
  // reader-prose selection. We rewrite the clipboard with the SAME
  // extractCleanText() the right-click menu already uses, and reproduce the
  // site's own citation behavior byte-for-byte: same setting key, same
  // Greek-only gate (greekCiteForRange only; NOT segCiteForRange — the site's
  // handleCopy never cites English-only selections, so this path doesn't
  // either, to stay a faithful drop-in replacement for the site handler it is
  // suppressing). Selections outside `.segment` (note editor, ⌘K search box,
  // Lexicon panel, etc.) are left completely alone — native copy behavior.
  const CITE_COPY_KEY = 'reader-cite-copy';
  function citeCopyEnabled(): boolean {
    try {
      const v = localStorage.getItem(CITE_COPY_KEY);
      return v === null ? true : v === 'true';   // default true, mirrors Reader.svelte
    } catch { return true; }
  }
  function onDocumentCopy(e: ClipboardEvent) {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;   // nothing selected: leave alone
    const anchorEl = sel.anchorNode instanceof Element ? sel.anchorNode : sel.anchorNode?.parentElement ?? null;
    if (!anchorEl?.closest('.segment')) return;   // note editor / search box / lexicon / chrome: native copy
    const range = sel.getRangeAt(0);
    const text = extractCleanText(range);
    if (!text) return;
    const cite = citeCopyEnabled() ? greekCiteForRange(range, meta?.abbr ?? '') : null;
    const payload = cite ? `${text}\n${cite}` : text;
    e.clipboardData?.setData('text/plain', payload);
    e.preventDefault();
    e.stopPropagation();   // the site's own on:copy handler must not also run
  }
  async function ctxMark(style: AnnStyle) {
    const cap = ctxMenu?.cap;
    closeCtx();
    if (cap) await applyMark(cap, style);   // uses the CURRENT palette color, armed or not
  }
  function ctxNote() {
    const m = ctxMenu;
    closeCtx();
    if (!m?.cap) return;
    // Use the rect captured at menu-open time — the live selection may already
    // be gone by now (WebKit can clear it on button focus). Fall back to a
    // small rect anchored at the menu's own position so openNoteEditor still
    // has something sane to place the editor against.
    const rect = m.rect ?? new DOMRect(m.x, m.y, 0, 0);
    openNoteEditor(m.cap, rect);
  }
  // Clamp the menu on screen: after render, measure and flip if it overflows.
  $: if (ctxMenu && ctxEl) {
    const r = ctxEl.getBoundingClientRect();
    if (ctxMenu.x + r.width > innerWidth - 8) ctxMenu.x = Math.max(8, ctxMenu.x - r.width);
    if (ctxMenu.y + r.height > innerHeight - 8) ctxMenu.y = Math.max(8, ctxMenu.y - r.height);
  }
  function onCtxWindowMouseDown(e: MouseEvent) {
    if (ctxMenu && ctxEl && !ctxEl.contains(e.target as Node)) closeCtx();
  }

  function annJump(a: Annotation) {
    if (a.target.kind === 'greek') {
      nav(workId, a.target.book, { loc: `${a.target.start.column}:${a.target.start.line}` });
    } else {
      const col = a.target.column;
      nav(workId, a.target.book).then(() => {
        let tries = 0;
        const seek = () => {
          const el = document.getElementById(`col-${col}`);
          if (el) el.scrollIntoView({ behavior: 'auto', block: 'start' });
          else if (++tries < 5) setTimeout(seek, 700);
        };
        setTimeout(seek, 900);
      });
    }
  }

  // ── Library rail visibility ───────────────────────────────────────────────
  let railOpen = (() => {
    try { return localStorage.getItem('desktop-rail') !== 'closed'; } catch { return true; }
  })();
  function toggleRail() {
    railOpen = !railOpen;
    try { localStorage.setItem('desktop-rail', railOpen ? 'open' : 'closed'); } catch { /* fine */ }
  }

  // ── Copy Citation ─────────────────────────────────────────────────────────
  // A desktop window has no address bar, so the site's live-hash-as-citation
  // needs a real control. The scroll-spy inside Reader keeps location.hash at
  // the citation of the top visible line; format it properly and copy.
  let toast = '';
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  function showToast(msg: string, ms = 3500) {
    toast = msg;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast = ''), ms);
  }

  function currentCitation(): string | null {
    if (!meta) return null;
    const hash = decodeURIComponent(location.hash.slice(1));
    // Only hashes that are actual citations count (not #ch-… chapter targets).
    const isCite = busse ? /^p?\d+/.test(hash) : !!parseCitation(hash);
    if (!hash || !isCite) return null;
    // An imported translation carries its own full bibliographic citation
    // (stored with the import, or composed from translator/year/source if
    // the import predates/omits the field) — use that verbatim instead of the
    // "Arist. {abbr} {loc}, trans. {short}" form built for the site's
    // registry-driven built-ins, whose metadata (edition, translator) lives
    // in works.ts rather than in a per-import record.
    try {
      const view = localStorage.getItem('reader-view');
      const transId = localStorage.getItem(`reader-trans-${workId}`);
      if (view !== 'greek' && transId && transId !== 'compare') {
        const imported = getImportCitation(workId, transId);
        if (imported) return imported;
      }
    } catch { /* fall through to the built-in citation form */ }
    const entry = entryByDataId(workId);
    const authorAbbr = entry?.author && entry.author !== 'aristotle'
      ? `${entry.author.slice(0, 5)}.`   // e.g. Porphyry → Porph.
      : 'Arist.';
    let cite = `${authorAbbr} ${meta.abbr} ${busse ? `p. ${hash.replace(/^p/, '')}` : hash}`;
    // Name the translation unless the reader is in Greek-only view.
    try {
      const view = localStorage.getItem('reader-view');
      const transId = localStorage.getItem(`reader-trans-${workId}`);
      if (view !== 'greek' && transId && transId !== 'compare') {
        const t = visibleTranslations(meta).find(x => x.id === transId);
        if (t) cite += `, trans. ${t.short}`;
      }
    } catch { /* citation without translator is still valid */ }
    return cite;
  }

  async function copyCitation() {
    const cite = currentCitation();
    if (!cite) { showToast('Scroll the text first — no citation at the top yet'); return; }
    try {
      // Packaged app: the OS clipboard via Tauri's plugin (WKWebView can deny
      // navigator.clipboard); browser dev: the web API.
      if ('__TAURI_INTERNALS__' in window) {
        const { writeText } = await import('@tauri-apps/plugin-clipboard-manager');
        await writeText(cite);
      } else {
        await navigator.clipboard.writeText(cite);
      }
      showToast(`Copied: ${cite}`);
    } catch {
      showToast('Could not access the clipboard');
    }
  }

  // ── Library export + Report a Problem ─────────────────────────────────────
  async function doExport() {
    try {
      const summary = await exportLibrary();
      if (summary) showToast(`Library exported — ${summary}`);
    } catch (e) {
      showToast(`Export failed: ${errorText(e)}`);
    }
  }
  function doReport() {
    reportProblem('0.1.0').catch(() => showToast('Could not open the issue page'));
  }

  // ── Link interception ─────────────────────────────────────────────────────
  // Reused site components emit real <a href> links (word popup, search hits,
  // phrase citations, the command palette). parseRouteHref is the single
  // decision; the click interceptor and the palette's onNavigate share it.
  async function applyRoute(action: RouteAction) {
    switch (action.kind) {
      case 'passthrough':
      case 'swallow':
        return;
      case 'lemma':
        searchOpen = false;
        phrasesOpen = false;
        openLexicon(action.slug);
        return;
      case 'reader': {
        if (!getWork(action.work)) return;
        searchOpen = false;
        phrasesOpen = false;
        closeLexicon();
        await nav(action.work, action.book, action.params);
        return;
      }
      case 'search': {
        phrasesOpen = false;
        closeLexicon();
        const qs = action.query ? `?${action.query}` : '';
        try { history.replaceState(null, '', `/${qs}`); } catch { /* tauri origin quirks */ }
        // Search reads window.location.search on mount — force a fresh mount
        // so a palette hand-off prefills even if the overlay was already open.
        if (searchOpen) {
          searchOpen = false;
          await tick();
        }
        searchOpen = true;
        return;
      }
      case 'external':
        openExternal(action.url).catch(() => showToast('Could not open the page'));
        return;
    }
  }

  function onPaletteNavigate(href: string) {
    void applyRoute(parseRouteHref(href));
  }

  function onGlobalClick(e: MouseEvent) {
    const a = (e.target as HTMLElement).closest?.('a[href]');
    if (!(a instanceof HTMLAnchorElement)) return;
    const href = a.getAttribute('href') ?? '';
    if (a.download) return;                     // CSV export, etc.
    // The parser runs before preventDefault: if it ever threw, the webview
    // would follow the raw href and navigate away — so a throw swallows.
    let action: RouteAction;
    try { action = parseRouteHref(href); } catch { action = { kind: 'swallow' }; }
    if (action.kind === 'passthrough') return;
    e.preventDefault();
    void applyRoute(action);
  }
</script>

<svelte:window on:click|capture={onGlobalClick} on:keydown|capture={onEsc} on:scroll={onWinScroll} on:mousedown|capture={onCtxWindowMouseDown} />

<div class="dt-shell" class:drag-over={dragOver} class:dt-no-rails={!railOpen && !annOpen}
  on:dragover={onDragOver} on:dragleave={onDragLeave} on:drop={onDrop} role="application">
  {#if railOpen}
    <aside class="dt-rail">
      <div class="dt-rail-head">
        <span class="dt-rail-brand">The Aristotle Reader</span>
      </div>
      <div class="dt-rail-ref">
        <button class="dt-lexicon-link" on:click={() => openLexicon()}>
          <span>Greek Lexicon</span>
          <span class="dt-lexicon-arr" aria-hidden="true">→</span>
        </button>
        <button class="dt-lexicon-link" on:click={openImport}>
          <span>Import translation…</span>
          <span class="dt-lexicon-arr" aria-hidden="true">＋</span>
        </button>
      </div>
      <LibraryRail
        currentWork={workId}
        currentBook={bookNum}
        {currentCite}
        {onOpenWork}
        {onOpenChapter}
      />
      <div class="dt-rail-foot">
        <button on:click={doExport} title="Bundle your annotations and imported translations into one file">Export library…</button>
        <button on:click={doReport} title="Open a pre-filled GitHub issue — nothing is sent automatically">Report a problem</button>
      </div>
    </aside>
  {/if}

  <div class="dt-main" bind:this={dtMainEl} on:mouseup={onReaderMouseUp} role="presentation">
    <header class="page-header dt-topbar" bind:this={topbarEl}>
      <button class="dt-railtoggle" on:click={toggleRail} title={railOpen ? 'Hide library' : 'Show library'} aria-label="Toggle library rail">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <path d="M4 6h16M4 12h16M4 18h16" />
        </svg>
      </button>
      <h1>{meta?.title ?? workId}{titleSuffix}</h1>
      <span class="dt-spacer"></span>
      {#if !busse}
        <BekkerJump work={workId} onJump={onBekkerJump} />
      {/if}
      <button class="dt-cite" on:click={() => (searchOpen = true)} title="Search the corpus (⇧⌘K)">
        Search
      </button>
      <button class="dt-cite" on:click={() => (phrasesOpen = true)} title="Browse recurring phrases">
        Phrases
      </button>
      <button class="dt-cite" on:click={copyCitation} title="Copy a citation for the current position">
        Copy citation
      </button>
      <button class="dt-cite" class:dt-on={armed} on:click={toggleArmed} bind:this={annotateBtnEl}
        title="Annotation mode — select text to highlight, underline, or note">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z" />
        </svg>
        Annotate
      </button>
      <button class="dt-cite" class:dt-on={annOpen} on:click={toggleAnn} title="Show highlights and notes">
        Notes{annotations.length ? ` (${annotations.length})` : ''}
      </button>
      <!-- Opens the Reader's own settings sidebar (text size, line spacing,
           compare-pair pickers, copy behavior) — the same toggle-settings
           event the site's header dispatches to it. -->
      <button
        class="dt-railtoggle"
        on:click={() => window.dispatchEvent(new CustomEvent('toggle-settings'))}
        title="Reader settings — text size, line spacing, compare translations"
        aria-label="Reader settings"
      >
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>
      <ThemeToggle />
    </header>

    {#if armed}
      <div class="dt-annmode-bar" bind:this={annBarEl} style="left:{annBarLeft}px;top:{annBarTop}px" role="toolbar" aria-label="Annotation tools">
        <div class="dt-annmode-tools" role="group" aria-label="Tool">
          <button class="dt-annmode-tool" class:on={tool === 'highlight'} on:click={() => (tool = 'highlight')} title="Highlight">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M9 11l6-6 4 4-6 6H9z" />
              <path d="M3 21l3-1 8-8-4-4-8 8-1 3z" />
            </svg>
            Highlight
          </button>
          <button class="dt-annmode-tool" class:on={tool === 'underline'} on:click={() => (tool = 'underline')} title="Underline">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M6 4v6a6 6 0 0 0 12 0V4" />
              <path d="M4 20h16" />
            </svg>
            Underline
          </button>
          <button class="dt-annmode-tool" class:on={tool === 'note'} on:click={() => (tool = 'note')} title="Note">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            Note
          </button>
        </div>
        <span class="dt-annmode-div" aria-hidden="true"></span>
        <div class="dt-annmode-swatches" role="group" aria-label="Color">
          {#each PALETTE as c}
            <button
              class="dt-swatch dt-swatch-{c}"
              class:on={color === c}
              on:click={() => (color = c)}
              title={c}
              aria-label={c}
              aria-pressed={color === c}
            ></button>
          {/each}
        </div>
      </div>
    {/if}

    {#key `${workId}:${bookNum}:${navSeq}`}
      <Reader work={workId} bookNum={bookNum} bookData={null} {chapterTitles} />
    {/key}
  </div>

  {#if annOpen}
    <AnnotationsPanel
      work={workId}
      shown={annShown}
      {annotations}
      onChanged={refreshAnnotations}
      onJump={annJump}
      onClose={toggleAnn}
    />
  {/if}
</div>

{#if noteEditor}
  <div
    class="dt-note-editor"
    class:dt-note-editor-hidden={!noteEditor.placed}
    bind:this={noteEditorEl}
    style="left:{noteEditor.x}px;top:{noteEditor.y}px"
    role="dialog" aria-label="Add note"
  >
    <div
      class="dt-note-editor-handle"
      role="presentation"
      on:pointerdown={onNoteDragStart}
      on:pointermove={onNoteDragMove}
      on:pointerup={onNoteDragEnd}
      on:pointercancel={onNoteDragEnd}
    >
      <span class="dt-note-editor-grip" aria-hidden="true"></span>
    </div>
    <!-- svelte-ignore a11y_autofocus -->
    <textarea bind:value={noteEditor.text} rows="3" placeholder="Your note…" autofocus></textarea>
    <div class="dt-note-editor-row">
      <button on:click={saveNote} disabled={!noteEditor.text.trim()}>Save</button>
      <button class="quiet" on:click={cancelNote}>Cancel</button>
    </div>
  </div>
{/if}

{#if ctxMenu}
  <div class="dt-ctxmenu" bind:this={ctxEl} style="left:{ctxMenu.x}px;top:{ctxMenu.y}px" role="menu">
    <button role="menuitem" on:mousedown|preventDefault on:click={ctxCopy}>Copy</button>
    <button role="menuitem" on:mousedown|preventDefault on:click={ctxCopyCite}>Copy with citation</button>
    <hr />
    <button role="menuitem" disabled={!ctxMenu.cap} title={!ctxMenu.cap ? 'Select within one column to annotate' : undefined}
      on:mousedown|preventDefault on:click={() => ctxMark('highlight')}>Highlight</button>
    <button role="menuitem" disabled={!ctxMenu.cap} title={!ctxMenu.cap ? 'Select within one column to annotate' : undefined}
      on:mousedown|preventDefault on:click={() => ctxMark('underline')}>Underline</button>
    <button role="menuitem" disabled={!ctxMenu.cap} title={!ctxMenu.cap ? 'Select within one column to annotate' : undefined}
      on:mousedown|preventDefault on:click={ctxNote}>Add Note…</button>
  </div>
{/if}

{#if lexicon}
  <div class="dt-lexicon" role="dialog" aria-label="Greek Lexicon">
    <header class="page-header dt-lexicon-bar">
      <h1>Greek Lexicon</h1>
      <span class="dt-spacer"></span>
      <button class="dt-lexicon-close" on:click={closeLexicon} aria-label="Close the Lexicon">✕</button>
    </header>
    <div class="dt-lexicon-body">
      {#if lexicon.slug}
        <LexiconEntry slug={lexicon.slug} onJumpTo={lexiconJump} onBack={() => openLexicon()} />
      {:else}
        <LexiconIndex onOpenEntry={(s) => openLexicon(s)} />
      {/if}
    </div>
  </div>
{/if}

{#if searchOpen}
  <div class="dt-lexicon" role="dialog" aria-label="Search">
    <header class="page-header dt-lexicon-bar">
      <h1>Search</h1>
      <span class="dt-spacer"></span>
      <button class="dt-lexicon-close" on:click={() => (searchOpen = false)} aria-label="Close search">✕</button>
    </header>
    <div class="dt-lexicon-body">
      <Search />
    </div>
  </div>
{/if}

{#if phrasesOpen}
  <div class="dt-lexicon" role="dialog" aria-label="Phrases">
    <header class="page-header dt-lexicon-bar">
      <h1>Phrases</h1>
      <span class="dt-spacer"></span>
      <button class="dt-lexicon-close" on:click={() => (phrasesOpen = false)} aria-label="Close phrases">✕</button>
    </header>
    <div class="dt-lexicon-body">
      <Phrases />
    </div>
  </div>
{/if}

<CommandPalette work={workId} onNavigate={onPaletteNavigate} />

{#if importDlg}
  <ImportDialog file={importDlg.file} presetWork={workId} onClose={closeImport} />
{/if}

{#if toast}
  <div class="dt-toast" role="status">{toast}</div>
{/if}

{#if dataLayer.host === 'tauri' && !dataLayer.corpusDir}
  <!-- Packaged app with no corpus found on disk AND no dev server data:
       everything will show load errors; say why once, honestly. -->
  <div class="dt-datanote">
    No local corpus directory found — reading data is being served from the dev
    server if available. A packaged build needs a corpus at app-data/corpus or
    bundled resources.
  </div>
{/if}

<style>
  .dt-shell { display: flex; align-items: flex-start; min-height: 100vh; }
  .dt-shell.drag-over { outline: 3px dashed var(--accent); outline-offset: -3px; }

  .dt-rail {
    position: sticky; top: 0;
    width: 290px; flex: none;
    height: 100vh; overflow-y: auto;
    background: var(--page-bg);
    border-right: 1px solid var(--border);
  }
  .dt-rail-head { padding: 0.85rem 1.1rem 0.15rem; }
  .dt-rail-brand {
    font-family: var(--font-ui); font-size: 0.8rem; font-weight: 700;
    letter-spacing: 0.03em; color: var(--text-mid);
  }

  .dt-main { flex: 1; min-width: 0; }

  /* Extends the site's .page-header (sticky, themed) with desktop controls. */
  .dt-topbar { align-items: center; }
  .dt-spacer { flex: 1; }

  .dt-railtoggle {
    display: inline-flex; align-items: center; justify-content: center;
    width: 30px; height: 30px; flex: none;
    border: 1px solid var(--border); border-radius: 6px;
    background: transparent; color: var(--text-mid); cursor: pointer;
  }
  .dt-railtoggle:hover { color: var(--text); border-color: var(--text-light); }

  .dt-cite {
    font-family: var(--font-ui); font-size: 0.78rem; font-weight: 600;
    color: var(--text-mid); background: transparent;
    border: 1px solid var(--border); border-radius: 6px;
    padding: 0.32rem 0.7rem; cursor: pointer; white-space: nowrap;
  }
  .dt-cite:hover { color: var(--text); border-color: var(--text-light); }

  .dt-rail-ref { padding: 0.5rem 0.6rem 0; }
  .dt-rail-foot {
    padding: 0.4rem 0.6rem 1.2rem;
    display: flex; flex-direction: column; gap: 0.15rem;
  }
  .dt-rail-foot button {
    font-family: var(--font-ui); font-size: 0.75rem; text-align: left;
    color: var(--text-light); background: none; border: none;
    padding: 0.2rem 0.7rem; cursor: pointer;
  }
  .dt-rail-foot button:hover { color: var(--accent); }
  .dt-lexicon-link {
    display: flex; justify-content: space-between; align-items: baseline; width: 100%;
    font-family: var(--font-ui); font-size: 0.86rem; font-weight: 600;
    color: var(--text); background: var(--col-bg);
    border: 1px solid var(--border); border-radius: 6px;
    padding: 0.45rem 0.7rem; cursor: pointer;
  }
  .dt-lexicon-link:hover { border-color: var(--accent); color: var(--accent); }
  .dt-lexicon-arr { color: var(--text-light); }
  .dt-lexicon-link:hover .dt-lexicon-arr { color: var(--accent); }

  /* Full-pane overlay with its own scroll: the reader underneath keeps its
     window scroll position untouched while the Lexicon is open. */
  .dt-lexicon {
    position: fixed; inset: 0; z-index: 150;
    display: flex; flex-direction: column;
    background: var(--col-bg);
  }
  .dt-lexicon-bar { position: static; flex: none; display: flex; align-items: center; }
  .dt-lexicon-close {
    font-size: 1rem; color: var(--text-mid); background: transparent;
    border: 1px solid var(--border); border-radius: 6px;
    width: 30px; height: 30px; cursor: pointer;
  }
  .dt-lexicon-close:hover { color: var(--text); border-color: var(--text-light); }
  .dt-lexicon-body { flex: 1; overflow-y: auto; }

  .dt-on { color: var(--accent) !important; border-color: var(--accent) !important; }

  /* Persistent annotate palette: docked under the top bar, left-aligned
     under the Annotate toggle. Never selection-anchored — no positioning
     math against a selection rect. */
  .dt-annmode-bar {
    position: fixed; z-index: 120;
    display: flex; align-items: center; gap: 0.5rem;
    background: var(--col-bg); border: 1px solid var(--border); border-radius: 8px;
    padding: 0.3rem 0.5rem; box-shadow: var(--popup-shadow);
    font-family: var(--font-ui);
  }
  .dt-annmode-tools, .dt-annmode-swatches { display: flex; align-items: center; gap: 0.25rem; }
  .dt-annmode-tool {
    display: inline-flex; align-items: center; gap: 0.3rem;
    font: inherit; font-size: 0.76rem; font-weight: 600; cursor: pointer;
    color: var(--text-mid); background: transparent;
    border: 1px solid transparent; border-radius: 6px; padding: 0.3rem 0.55rem;
  }
  .dt-annmode-tool:hover { color: var(--text); }
  .dt-annmode-tool.on { color: var(--on-accent); background: var(--accent); }
  .dt-annmode-div { width: 1px; height: 1.4rem; background: var(--border); flex: none; }

  .dt-swatch {
    width: 20px; height: 20px; flex: none; border-radius: 50%; cursor: pointer;
    border: 1px solid rgba(0, 0, 0, 0.15); padding: 0;
  }
  .dt-swatch.on { outline: 2px solid var(--accent); outline-offset: 2px; }
  .dt-swatch-yellow { background: rgba(235, 195, 80, 0.9); }
  .dt-swatch-green  { background: rgba(120, 190, 120, 0.9); }
  .dt-swatch-pink   { background: rgba(230, 120, 140, 0.9); }
  .dt-swatch-blue   { background: rgba(120, 165, 225, 0.9); }
  .dt-swatch-purple { background: rgba(175, 135, 220, 0.9); }
  .dt-swatch-orange { background: rgba(235, 150, 70, 0.9); }

  .dt-note-editor {
    position: fixed; z-index: 180;
    display: flex; flex-direction: column; gap: 0.35rem;
    background: var(--col-bg); border: 1px solid var(--border); border-radius: 8px;
    padding: 0 0.35rem 0.35rem; box-shadow: var(--popup-shadow);
    font-family: var(--font-ui);
  }
  /* Suppress the very first paint at the pre-clamp x/y (offscreen candidate
     position) — the reactive clamp block runs on the next tick and flips
     `placed` true, at which point this class is removed. Kept in the layout
     (not display:none) so its real size can be measured for the clamp. */
  .dt-note-editor-hidden { visibility: hidden; }
  .dt-note-editor-handle {
    height: 0.85rem; margin: 0 -0.35rem; padding-top: 0.3rem;
    display: flex; align-items: center; justify-content: center;
    cursor: grab; touch-action: none;
  }
  .dt-note-editor-handle:active { cursor: grabbing; }
  .dt-note-editor-grip {
    width: 2rem; height: 4px; border-radius: 2px;
    background: var(--border);
  }
  .dt-note-editor button {
    font: inherit; font-size: 0.78rem; font-weight: 600; cursor: pointer;
    color: var(--text); background: transparent;
    border: 1px solid var(--border); border-radius: 6px; padding: 0.3rem 0.7rem;
  }
  .dt-note-editor button:hover { border-color: var(--accent); color: var(--accent); }
  .dt-note-editor button.quiet { color: var(--text-mid); }
  .dt-note-editor button:disabled { opacity: 0.5; }
  .dt-note-editor textarea {
    width: 16rem; font-family: var(--font-ui); font-size: 0.82rem;
    color: var(--text); background: var(--page-bg);
    border: 1px solid var(--border); border-radius: 6px; padding: 0.4rem 0.5rem;
  }
  .dt-note-editor textarea:focus { outline: none; border-color: var(--accent); }
  .dt-note-editor-row { display: flex; gap: 0.4rem; }

  .dt-ctxmenu {
    position: fixed; z-index: 185; min-width: 12rem;
    display: flex; flex-direction: column; padding: 0.3rem;
    background: var(--popup-bg); border: 1px solid var(--border); border-radius: 8px;
    box-shadow: var(--popup-shadow); font-family: var(--font-ui);
  }
  .dt-ctxmenu button {
    font: inherit; font-size: 0.8rem; text-align: left; cursor: pointer;
    color: var(--text); background: transparent; border: none; border-radius: 5px;
    padding: 0.35rem 0.7rem;
  }
  .dt-ctxmenu button:hover:not(:disabled) { background: var(--accent); color: var(--on-accent); }
  .dt-ctxmenu button:disabled { color: var(--text-light); cursor: default; }
  .dt-ctxmenu hr { border: none; border-top: 1px solid var(--border); margin: 0.25rem 0.4rem; }

  .dt-toast {
    position: fixed; bottom: 1.2rem; left: 50%; transform: translateX(-50%);
    z-index: 200; max-width: min(80vw, 40rem);
    font-family: var(--font-ui); font-size: 0.82rem;
    color: var(--on-accent); background: var(--accent);
    border-radius: 8px; padding: 0.55rem 1rem;
    box-shadow: 0 4px 18px rgba(0, 0, 0, 0.25);
  }

  .dt-datanote {
    position: fixed; bottom: 1.2rem; right: 1.2rem; z-index: 190;
    max-width: 22rem; font-family: var(--font-ui); font-size: 0.75rem;
    color: var(--text-mid); background: var(--col-bg);
    border: 1px solid var(--border); border-radius: 8px; padding: 0.6rem 0.8rem;
  }
</style>
