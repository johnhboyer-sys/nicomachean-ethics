<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import { fade } from 'svelte/transition';
  import { fetchBook, parseBekker, lineAnchor, lineRef, nearestLineAnchor, fetchSidenotes, fetchFigures, fetchQuotations, type Segment, type GreekLine, type Token, type BookData, type OverlayPiece, type Quotation } from '../lib/data';
  import { greekFold } from '../lib/search';
  import { measureGreekTrack as measureTrack } from '../lib/greek-track';
  import { highlightPrefixMatches } from '../lib/text';
  import { sanitizeHtml } from '../lib/html';
  import { lineParts, cellParts, locateToken, type LinePart } from '../lib/line-parts';
  import { getWork, visibleTranslations, bookLabel as workBookLabel, type TranslationRef } from '../lib/works';
  import { touchRecent } from '../lib/resume';
  import WordPopup from './WordPopup.svelte';
  import FootnotePopup from './FootnotePopup.svelte';
  import EndnoteSidebar from './EndnoteSidebar.svelte';
  import QuotationMarker from './QuotationMarker.svelte';

  export let work: string = 'EN';
  export let bookNum: number = 1;
  // The book's segments, read at build time and passed by ReaderShell.astro so
  // the reading text is server-rendered into the static HTML (crawlable, instant
  // paint) and the island hydrates over it. When absent (e.g. a future dynamic
  // mount), the reader falls back to fetching the JSON in onMount as before.
  export let bookData: BookData | null = null;
  // Optional per-chapter section titles {chapter: title} for this book, passed
  // by ReaderShell from chapter-titles.json. Shown in the chapter heading in
  // place of "Chapter N" (used by non-Bekker works like the Isagoge).
  export let chapterTitles: Record<string, string> = {};
  // A translation's OWN chapter titles for this book, {transId: {chapter: title}}
  // — passed by ReaderShell from third-titles.json. Ostwald heads every chapter
  // with a title of his own ("(e) Theoretical wisdom"), which belongs over his
  // column rather than in the shared chapter heading. A title may carry the
  // footnote reference its heading bore.
  export let transTitles: Record<string, Record<string, string>> = {};

  const workMeta = getWork(work);
  // Non-Bekker works (e.g. Porphyry's Isagoge) are cited by Busse page, not a
  // Bekker column:line. For them the reader relabels the column reference (p. N),
  // hides the per-line Greek numbers and the interpolated English gutter, and
  // titles each section from chapterTitles instead of "Chapter N".
  const busse = workMeta?.citation?.scheme === 'busse';
  const hideLineNums = busse && workMeta?.citation?.hideLineNumbers === true;
  // Analytical sidenotes ({N: text}) for a busse work, floated into a right rail.
  let sidenotesData: Record<string, string> = {};
  if (busse) fetchSidenotes(work).then(d => { sidenotesData = d; }).catch(() => {});
  // Diagrams ({N: html}) rendered inline at [[figN]] markers (Tree of Porphyry).
  let figuresData: Record<string, string> = {};
  if (busse) fetchFigures(work).then(d => { figuresData = d; }).catch(() => {});
  // Curated quotation citations. Missing file → empty map, no markers, no DOM.
  let quoteStarts: Map<string, Quotation[]> = new Map();
  fetchQuotations(work).then((rows) => {
    if (!Array.isArray(rows) || rows.length === 0) return;
    const m = new Map<string, Quotation[]>();
    for (const q of rows) {
      const k = `${q.column}:${q.lo}`;
      const list = m.get(k);
      if (list) list.push(q);
      else m.set(k, [q]);
    }
    quoteStarts = m;
  }).catch(() => {});
  const translations = workMeta ? visibleTranslations(workMeta) : [];
  // The reader can render any number of translations. The primary parallel
  // chunk is the 'english' slot; every other translation is a chapter-anchored
  // overlay read from its segment field (secondary / third / overlays[id]).
  // `secondaries` is the ordered list of non-primary translations.
  const engSlot = translations.find(t => t.slot === 'english');
  const thirdSlot = translations.find(t => t.slot === 'third');  // bears footnotes/tables
  // The translation(s) whose prose carries [^label] footnote markers
  // (Ostwald's third slot, a primary like the Isagoge's Owen, or — Phase 4B —
  // any imported overlay whose file carried a footnotes block, flagged via
  // the same TranslationRef.footnotes bit by desktop/src/lib/imports.ts's
  // installHooks). Every such id's column renders the markers and opens the
  // footnote popup. thirdSlot is ALWAYS included (not just as a fallback when
  // nothing is explicitly flagged) so an import gaining footnotes:true never
  // silently un-flags Ostwald — this generalizes the old single-id
  // `fnTransId` without changing behavior for any existing work (today,
  // across the whole corpus, this set never has more than one member: either
  // the one explicitly-flagged translation, or thirdSlot — never both, since
  // no work currently combines them).
  const fnTransIds = new Set([
    ...translations.filter(t => t.footnotes).map(t => t.id),
    ...(thirdSlot ? [thirdSlot.id] : []),
  ]);
  const secondaries = translations.filter(t => t.slot !== 'english');
  const canCompare = translations.length >= 2;
  // Overlay pieces for a translation in a segment, selected by its slot.
  const piecesFor = (seg: Segment, t: TranslationRef | undefined | null): OverlayPiece[] => {
    if (!t) return [];
    // `seg.ross` is the pre-rename emitted field name; stage7_emit still writes
    // it, so read the new name first and fall back until the corpus is rebuilt.
    if (t.slot === 'secondary') return seg.secondary ?? seg.ross ?? [];
    if (t.slot === 'third') return seg.third ?? [];
    if (t.slot === 'overlay') return seg.overlays?.[t.id] ?? [];
    return [];
  };
  const transById = (id: string | null | undefined): TranslationRef | null =>
    id ? (translations.find(t => t.id === id) ?? null) : null;

  // §Phase-4B-revised (John's call 2026-07-06): an imported translation's own
  // converter-derived chapter title is this edition's editorial paratext, not
  // work-level chrome — it renders as a small unaligned heading INSIDE that
  // import's own overlay column (see transFlow below), never merged into the
  // shared chapterTitles heading map above. Resolved through a window-level
  // hook installed by desktop/src/lib/imports.ts's installHooks(), the same
  // site-shared pattern __ARISTOTLE_IMPORT_FOOTNOTE_HOOK__ uses (see
  // FootnotePopup.svelte) — this component is SHARED with the static site
  // build, which never installs the hook, so the lazy read below is always
  // undefined there: inert, byte-identical rendering. Render-only: sourced
  // from ImportRecord.titles, never written into any offset-bearing text
  // stream, so no anchor ever shifts.
  function importChapterTitle(transId: string, chapter: string | null): string {
    if (!chapter) return '';
    const hook = (globalThis as {
      __ARISTOTLE_IMPORT_TITLE_HOOK__?: (work: string, id: string, book: number, chapter: string) => string | null;
    }).__ARISTOTLE_IMPORT_TITLE_HOOK__;
    // The desktop app answers for an imported work; on the site the titles are
    // built data (transTitles), keyed by the translation that wrote them —
    // Ostwald's chapter headings are his, so they belong over his column only.
    return (hook ? hook(work, transId, bookNum, chapter) : null)
      ?? transTitles[transId]?.[chapter] ?? '';
  }
  // A title may carry the footnote its heading bore: strip the marker for the
  // Greek column's invisible spacer, which only needs the same one-line height.
  const titleText = (s: string) => s.replace(/\[\^[\w.*†]+\]/g, '').trim();

  // Compare mode shows two translations side by side; which two is chosen in the
  // settings sidebar. Defaults: primary + first secondary. Persisted per work.
  let compareLeft: string = engSlot?.id ?? translations[0]?.id ?? 'english';
  let compareRight: string = secondaries[0]?.id ?? translations[1]?.id ?? compareLeft;
  const CMPL_KEY = `reader-cmpl-${work}`;
  const CMPR_KEY = `reader-cmpr-${work}`;
  function saveCompare() {
    try { localStorage.setItem(CMPL_KEY, compareLeft); localStorage.setItem(CMPR_KEY, compareRight); } catch {}
  }

  // Seeded from the build-time prop so SSR renders the text; stays empty (and
  // `loading` true) only in the fetch-fallback path.
  let segments: Segment[] = bookData?.segments ?? [];
  let loading = !bookData;
  let error = '';

  // Search jump-in: highlight query terms + scroll to a line (?hlg=&hle=&loc=).
  let hlGrkFolds: string[] = [];
  let hlEngTerms: string[] = [];
  let targetId: string | null = null;

  // Which translation fills the English column: a translation id from the
  // registry (its slot decides what renders) or 'compare' = both slots side by
  // side. Persisted per work (works carry different translations).
  // First-load translation: the work's preferred default if it names one (and
  // it's actually visible in this build), else the primary 'english' slot. A
  // saved choice or ?trans= query param overrides this in onMount.
  const defaultTrans = translations.find(t => t.id === workMeta?.defaultTranslation)?.id;
  let trans: string = defaultTrans ?? engSlot?.id ?? translations[0]?.id ?? 'english';
  // The translation ids currently on screen: the single selection, or the two
  // compare columns. Drives the gutter disclaimer and the citation strip.
  $: shownTransIds = trans === 'compare' ? [compareLeft, compareRight] : [trans];
  // Whether a translation carries any approximate (interpolated) Bekker ticks in
  // a segment — overlays whose gutter is fully anchored show none, so the note
  // is suppressed for them.
  const transApprox = (seg: Segment, id: string): boolean => {
    const t = transById(id);
    if (!t) return false;
    if (t.slot === 'english') return !!seg.english?.bekker?.some((x) => !x.real);
    return piecesFor(seg, t).some((p) => p.bekker?.some((x) => !x.real));
  };
  $: hasApproxTicks = view !== 'greek'
    && segments.some((seg) => shownTransIds.some((id) => transApprox(seg, id)));
  const TRANS_KEY = `reader-trans-${work}`;
  const CITE_KEY  = 'reader-cite-copy';
  // The "ℹ︎ Bekker numbers" popover (upright = fixed, italic = estimate).
  let bekkerInfoOpen = false;
  let citeCopy = true;
  function saveCiteCopy() { try { localStorage.setItem(CITE_KEY, String(citeCopy)); } catch {} }
  // The last single-translation choice, remembered so leaving compare mode
  // returns to it (and so the picker has something to display in compare).
  let lastSingle: string = trans;
  function setTrans(t: string) {
    trans = t;
    if (t !== 'compare') lastSingle = t;
    try { localStorage.setItem(TRANS_KEY, t); } catch {}
  }
  // The dropdowns select WHICH translation; mode (single vs compare) is chosen
  // in the settings sidebar. Picking a translation always means "show me this
  // one" — including from compare mode, which it exits.
  $: pickValue = trans === 'compare' ? lastSingle : trans;
  function onPick(e: Event) {
    setTrans((e.currentTarget as HTMLSelectElement).value);
  }

  // ── Settings sidebar ──────────────────────────────────────────────────────
  let settingsOpen = false;
  const FS_KEY = `reader-fs-${work}`;
  const LH_KEY = `reader-lh-${work}`;
  const COLW_KEY = `reader-colw-${work}`;
  // Base CSS values from global.css; scale as multipliers (1.0 = default).
  const FS_GREEK_BASE = 1.05;
  const FS_ENG_BASE   = 1.08;
  const LH_GREEK_BASE = 1.7;
  const LH_ENG_BASE   = 1.72;
  let fsScale = 1.0;
  let lhScale = 1.0;
  // Column-width scale: multiplies the layout's width caps (reader measure,
  // mono-view column measure) via --colw-scale; 1.0 = the stock layout.

  // ── The shared Greek track ──────────────────────────────────────────────
  // Every .seg-row is its own grid, so `grid-template-columns: max-content …`
  // sizes the Greek column to THAT block's longest line. Blocks differ, so the
  // English column — and the marginal Bekker numbers with it — starts at a
  // different x on every block: 73px of drift across the first ten blocks of
  // NE I alone, which reads as the numbers wandering down the page.
  //
  // One width for the whole work fixes it, and it is the same number the
  // greek-only view wants: the widest Greek line there is, shared by every
  // section, centred, so nothing wraps that needn't.
  //
  // Measured, not computed: the width depends on the face, its size, and which
  // glyphs the work actually uses. Measure by letting the column take its
  // natural width for one synchronous pass, then read the widest line back.
  let greekTrack = 0;
  // Re-measure whenever the number changes: a new book brings different lines,
  // and the type scale changes their width. NOT on window resize — the natural
  // width of a line does not depend on the viewport, only on the type.
  // document.fonts.ready matters more than it looks: Cardo arrives after first
  // paint, and a track measured in the fallback face is measurably narrow.
  // The key carries the SEGMENT COUNT, which is what makes a cold load work.
  // The desktop app mounts with bookData=null, so the first pass renders a
  // loading placeholder with no .reader-body at all and measures nothing;
  // without the count the key was already spent and the real segments were
  // never measured. Whether the fetch beat document.fonts.ready then decided
  // whether the track was ever taken — it read as "fixed" on a warm cache and
  // "still broken" on a cold one.
  //
  // A count rather than retry-until-success: retrying re-enters this reactive
  // block on every failure, and anywhere a rect is always 0 (any non-layout
  // test environment) that is an unbounded microtask loop — it killed a vitest
  // worker. Asking again only when the data actually changed cannot spin.
  //
  // colScale is deliberately absent: the column-width slider scales the caps
  // around the Greek, never the natural width of a line, so including it
  // forced a full-book relayout for a number that cannot have changed.
  let trackKey = '';
  $: if (typeof document !== 'undefined' && enrichedSegments) {
    // `view` belongs in the key too: in view-english the Greek column is
    // display:none and every line measures 0, so the track has to be taken
    // again when Greek comes back, or the per-block fallback returns.
    const key = `${work}/${bookNum}/${view}/${fsGreek}/${fsScale}/${enrichedSegments.length}`;
    if (key !== trackKey) {
      trackKey = key;
      tick()
        .then(() => document.fonts?.ready ?? Promise.resolve())
        .then(() => measureGreekTrack());
    }
  }

  // A face that registers after fonts.ready — Google Fonts can deliver the
  // Greek unicode-range subset late — never fires ready again, so a track
  // measured in the fallback face would stay narrow until the reader happened
  // to change view or type size.
  onMount(() => {
    const fonts = document.fonts;
    if (!fonts?.addEventListener) return;
    // Just re-measure. The key is not touched: it already reflects the data
    // and the type scale, and neither changed — only the face did.
    const again = () => { measureGreekTrack(); };
    fonts.addEventListener('loadingdone', again);
    return () => fonts.removeEventListener('loadingdone', again);
  });

  // Thin wrapper: the measurement itself lives in lib/greek-track so the
  // sequencing defect it exists to prevent — measuring before the lines are
  // rendered — can be tested without mounting a reader.
  function measureGreekTrack(): boolean {
    const measured = measureTrack(document.querySelector<HTMLElement>('.reader-body'));
    // 0 means nothing was measurable, not a width. Publish it anyway so the
    // var is dropped rather than pinning the column to a stale number, and
    // report false so the caller knows the key was not earned.
    greekTrack = measured;
    return measured > 0;
  }
  let colScale = 1.0;
  $: fsGreek = (FS_GREEK_BASE * fsScale).toFixed(3);
  $: fsEng   = (FS_ENG_BASE   * fsScale).toFixed(3);
  $: lhGreek = (LH_GREEK_BASE * lhScale).toFixed(3);
  $: lhEng   = (LH_ENG_BASE   * lhScale).toFixed(3);

  function closeSettings() {
    settingsOpen = false;
    window.dispatchEvent(new CustomEvent('settings-state', { detail: { open: false } }));
  }
  function openSettings() {
    settingsOpen = true;
    window.dispatchEvent(new CustomEvent('settings-state', { detail: { open: true } }));
  }
  function saveFs() { try { localStorage.setItem(FS_KEY, String(fsScale)); } catch {} }
  function saveLh() { try { localStorage.setItem(LH_KEY, String(lhScale)); } catch {} }
  function saveColw() { try { localStorage.setItem(COLW_KEY, String(colScale)); } catch {} }
  function resetSettings() {
    fsScale = 1.0; lhScale = 1.0; colScale = 1.0; citeCopy = true;
    try {
      localStorage.removeItem(FS_KEY); localStorage.removeItem(LH_KEY);
      localStorage.removeItem(COLW_KEY); localStorage.removeItem(CITE_KEY);
    } catch {}
  }

  // ── Citation shown in the controls strip ─────────────────────────────────
  // The strip is filled with the bibliographic provenance so it reads as a
  // header, not a lone toggle. The Greek source comes from the registry; the
  // translation citation from the currently-selected translation. `short` forms
  // ("Ross (1908)") sit beside the controls in bilingual view; the full forms
  // fill the otherwise-empty bar in Greek-only / English-only.
  const greekSrc = workMeta?.greekSource;
  $: selectedTrans = trans === 'compare'
    ? null
    : (translations.find(t => t.id === trans) ?? null);
  const yearOf = (s: string) => { const m = s.match(/(\d{4})/); return m ? m[1] : ''; };
  const citeShort = (t: { short: string; name: string } | null | undefined) => {
    if (!t) return '';
    const y = yearOf(t.name);
    return y ? `${t.short} (${y})` : t.short;
  };
  // Bilingual strip: short Greek source · short translation (omit either if absent).
  $: pairText = [greekSrc?.short, citeShort(selectedTrans)].filter(Boolean).join(' · ');

  type View = 'both' | 'greek' | 'english';
  let view: View = 'both';
  async function setView(v: View) {
    view = v;
    try { localStorage.setItem('reader-view', v); } catch {}
    // The tracked anchors differ by view (Greek lines vs. whole columns), so
    // rebuild the scroll-spy once the DOM reflects the new view.
    await tick();
    if (spyArmed) setupScrollSpy();
  }

  // Print / Save-as-PDF: hand the currently-rendered view to the browser's
  // native print engine. The @media print stylesheet (global.css) strips the
  // app chrome, sets page breaks, and reveals a print-only title. We print the
  // on-screen view as-is, so Both / Greek / English all work via existing CSS.
  function printReader() {
    if (typeof window === 'undefined') return;
    window.print();
  }

  // Print a single chapter by temporarily hiding all seg-rows and chapter heads
  // that don't belong to the selected chapter, then restoring after print.
  function printSingleChapter(ch: string) {
    if (typeof window === 'undefined') return;
    const toRestore: { el: HTMLElement; was: string }[] = [];
    const hide = (el: HTMLElement) => {
      toRestore.push({ el, was: el.style.display });
      el.style.display = 'none';
    };
    document.querySelectorAll<HTMLElement>('.seg-row[data-chapter]').forEach(el => {
      if (el.dataset.chapter !== ch) hide(el);
    });
    document.querySelectorAll<HTMLElement>('.chapter-head').forEach(el => {
      const m = el.id.match(/^ch-\d+-(.+)$/);
      if (!m || m[1] !== ch) hide(el);
    });
    // Hide segments where every row was hidden (so the lone seg-ref doesn't print).
    document.querySelectorAll<HTMLElement>('.segment').forEach(seg => {
      const rows = seg.querySelectorAll<HTMLElement>('.seg-row[data-chapter]');
      if (rows.length > 0 && Array.from(rows).every(r => r.style.display === 'none')) hide(seg);
    });
    window.addEventListener('afterprint', () => {
      toRestore.forEach(({ el, was }) => { el.style.display = was; });
    }, { once: true });
    window.print();
  }

  // Print-menu dropdown state (chapter selector shown when book has > 1 chapter).
  let printMenuOpen = false;
  function togglePrintMenu(e: MouseEvent) {
    e.stopPropagation();
    if (printMenuOpen) { printMenuOpen = false; return; }
    printMenuOpen = true;
    document.addEventListener('click', () => { printMenuOpen = false; }, { once: true });
  }

  // Book label for chapter headings, the live context strip, and print —
  // multi-book works only, using the work's own numbering (Roman for EN).
  $: bookLabel = workMeta && workMeta.books > 1 ? `Book ${workBookLabel(workMeta, bookNum)}` : '';
  $: bekRange = segments.length
    ? (segments.length > 1
        ? `${segments[0].column}–${segments[segments.length - 1].column}`
        : segments[0].column)
    : '';
  // Masthead pieces (critical-edition design): author eyebrow + work title;
  // the full source citation(s) adapted to the printed view live in the footer.
  $: printCite = view === 'greek'
    ? (greekSrc?.full ? `Greek text: ${greekSrc.full}` : '')
    : view === 'english'
      ? (selectedTrans?.name ? `Translation: ${selectedTrans.name}` : '')
      : [greekSrc?.full ? `Greek text: ${greekSrc.full}` : '',
         selectedTrans?.name ? `Translation: ${selectedTrans.name}` : '']
          .filter(Boolean).join('   ·   ');

  // Segments annotated with a running currentChapter so every block — including
  // continuation blocks that don't open a new chapter — knows which chapter it
  // belongs to. Used for per-chapter print filtering via data-chapter attributes.
  $: enrichedSegments = (() => {
    let runCh = '';
    return segments.map(seg => {
      const blocks = splitSegment(seg);
      return {
        seg,
        blocks: blocks.map(b => {
          if (b.chapter) runCh = b.chapter;
          return { ...b, currentChapter: runCh } as EnrichedBlock;
        }),
      };
    });
  })();

  // Ordered list of distinct chapter identifiers present in the loaded book.
  // Empty-string entries (no chapter assignment yet) are filtered out.
  $: chaptersInBook = [...new Set(
    enrichedSegments.flatMap(s => s.blocks.map(b => b.currentChapter)).filter(Boolean)
  )];

  // ── Live URL tracking (aquinas.cc style) ─────────────────────────────────
  // As the reader scrolls, rewrite the location hash to the Bekker citation at
  // the top of the reading area, so any position is a citable link. Line-level
  // when the Greek column is visible (our lineation is canonical Bekker);
  // column-level in English-only view (its line numbers are interpolated
  // estimates). history.replaceState keeps this out of back-history and avoids
  // jumping the scroll. We arm the spy only on the first user scroll so an
  // opened #citation link isn't overwritten before the reader actually moves.
  let spyObserver: IntersectionObserver | null = null;
  let spyState = new Map<Element, number | null>();
  let spyArmed = false;
  let lastCite = '';
  let suppressArmUntil = 0;   // ignore scroll-events from our own programmatic scrolls
  let resizeTimer: ReturnType<typeof setTimeout> | undefined;

  function citeOf(el: Element): string | null {
    const lm = el.id.match(/^L(.+)-(\d+)$/);   // greek line: L{col}-{n} → {col}{n}
    if (lm) return `${lm[1]}${lm[2]}`;
    const cm = el.id.match(/^col-(.+)$/);       // segment: col-{column} → {column}
    return cm ? cm[1] : null;
  }

  function updateHash(cite: string | null) {
    if (!cite || cite === lastCite) return;
    lastCite = cite;
    try { history.replaceState(history.state, '', `#${cite}`); } catch {}
    // Remember the last position per work so the work-switcher can resume here.
    try { localStorage.setItem(`reader-loc-${work}`, cite); } catch {}
  }

  // ── Live book/chapter context in the sticky controls strip ───────────────
  // Chapter heads scroll away with the text (they sit inside segments, so
  // CSS sticky can't carry them across segment boundaries); the strip shows
  // the label of the last chapter head above the reading line instead, so
  // the reader always knows where they are. Sampled on scroll, rAF-throttled.
  let liveChapter = '';
  let ctxRaf = 0;
  function updateChapterContext() {
    const strip = document.querySelector('.reader-controls');
    const boundary = (strip?.getBoundingClientRect().bottom ?? 100) + 12;
    let label = '';
    for (const h of document.querySelectorAll('.chapter-head .chapter-label')) {
      if (h.getBoundingClientRect().top <= boundary) label = h.textContent?.trim() ?? '';
      else break;
    }
    liveChapter = label;
  }
  function onCtxScroll() {
    if (ctxRaf) return;
    ctxRaf = requestAnimationFrame(() => { ctxRaf = 0; updateChapterContext(); });
  }

  function setupScrollSpy() {
    spyObserver?.disconnect();
    spyState = new Map();
    const greekVisible = view === 'greek' || view === 'both';
    const els = Array.from(document.querySelectorAll(greekVisible ? '.greek-line[id]' : '.segment[id]'));
    if (!els.length) return;
    const headerH = Math.round(document.querySelector('.page-header')?.getBoundingClientRect().height ?? 60);
    // The reading area starts below the sticky header AND the sticky controls
    // strip pinned beneath it, so the detection band begins at the strip's bottom.
    const ctrlBottom = document.querySelector('.reader-controls')?.getBoundingClientRect().bottom ?? 0;
    const topInset = Math.max(headerH, Math.round(ctrlBottom));
    // Detection band: a strip just below the sticky chrome. The intersecting
    // anchor highest on screen is the line currently at the top of the reading area.
    spyObserver = new IntersectionObserver((entries) => {
      for (const e of entries) spyState.set(e.target, e.isIntersecting ? e.boundingClientRect.top : null);
      let best: Element | null = null;
      let bestTop = Infinity;
      for (const [el, top] of spyState) {
        if (top != null && top < bestTop) { bestTop = top; best = el; }
      }
      if (best) updateHash(citeOf(best));
    }, { rootMargin: `-${topInset + 8}px 0px -82% 0px`, threshold: 0 });
    els.forEach((el) => spyObserver!.observe(el));
  }

  // Arm on the first genuine user scroll. Scroll events from our own
  // programmatic jumps (citation/search) fall inside the suppression window and
  // are ignored, so an opened #citation stays put until the reader moves.
  function onScrollArm() {
    if (Date.now() < suppressArmUntil) return;
    window.removeEventListener('scroll', onScrollArm);
    spyArmed = true;
    setupScrollSpy();
  }

  function onResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (spyArmed) setupScrollSpy(); }, 200);
  }

  // Open at a Bekker citation from the URL hash: the exact Greek line if it's
  // present and visible, otherwise the owning column. Instant (no animation) so
  // it doesn't stream scroll-events, and suppressed so it doesn't self-arm.
  function scrollToCitation(column: string, line: number, sub?: string) {
    suppressArmUntil = Date.now() + 800;
    const lineEl = document.getElementById(lineAnchor(column, line, sub));
    if (lineEl && (lineEl as HTMLElement).offsetParent !== null) {
      lineEl.scrollIntoView({ behavior: 'auto', block: 'center' });
    } else {
      document.getElementById(`col-${column}`)?.scrollIntoView({ behavior: 'auto', block: 'start' });
    }
  }

  let _onToggleSettings: () => void;
  let _onCloseSettings: () => void;

  onDestroy(() => {
    spyObserver?.disconnect();
    if (typeof window !== 'undefined') {
      window.removeEventListener('scroll', onScrollArm);
      window.removeEventListener('scroll', onCtxScroll);
      window.removeEventListener('resize', onResize);
      if (_onToggleSettings) window.removeEventListener('toggle-settings', _onToggleSettings);
      if (_onCloseSettings)  window.removeEventListener('close-settings',  _onCloseSettings);
      document.removeEventListener('mouseup', checkCopyBtn);
      document.removeEventListener('selectionchange', onSelectionChange);
    }
  });

  function isHit(surface: string): boolean {
    if (!hlGrkFolds.length) return false;
    const f = greekFold(surface);
    return f.length > 0 && hlGrkFolds.some(q => f.startsWith(q));
  }
  function esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function highlightEng(text: string): string {
    // Sidenote [[sN]] and figure [[figN]] markers are rendered elsewhere (the
    // right rail / an inline figure), so strip them from the prose flow.
    text = text.replace(/\s*\[\[(?:s|fig)\d+\]\]\s*/g, ' ');
    if (!hlEngTerms.length) return esc(text);
    return highlightPrefixMatches(text, hlEngTerms);
  }
  // §Phase-3 B5: the printed number is stored as `display`; identity is the
  // (scope, number) pair encoded in the label — continuous scope's label IS
  // the display digits (label === display, zero-change case), while a scoped
  // label ("2.3.1") or a star/dagger glyph carries its display as the
  // trailing component. Pure function of the label alone, so both Reader
  // (button text) and FootnotePopup (popup header) can compute it locally
  // without threading an extra value through the marker string itself.
  function fnDisplay(label: string): string {
    if (label === '*' || label === '†') return label;
    const i = label.lastIndexOf('.');
    return i === -1 ? label : label.slice(i + 1);
  }
  // A footnote-bearing translation (Ostwald's third slot, the Isagoge's Owen,
  // or — Phase 4B — an imported overlay; see fnTransIds above) carries inline
  // `[^label]` footnote references; turn each into a clickable superscript.
  // §B4.2: the label is the full scope-qualified identity (continuous scope:
  // plain digits, unchanged from before); the button only ever displays the
  // printed number. `data-fn-trans` records which translation's footnote map
  // to resolve against (§B4.3/4.4) — needed once more than one translation on
  // the page can carry footnotes. A delegated click handler on the column
  // reads both data attributes and opens the footnote popup.
  function renderThird(text: string, transId: string): string {
    // The marker <button> is an atomic inline box, and engines may take a
    // line-break opportunity at its edge even with no space — WKWebView
    // orphans the superscript onto the next line ("pair, | ¹ one thing").
    // Glue it to the word it annotates with a nowrap wrapper. The capture
    // deliberately stops at whitespace, tag brackets, and entities so it can
    // never swallow a fragment of highlightEng's own markup; if a tag abuts
    // the marker the wrapper just holds the marker alone (no worse than
    // before).
    return highlightEng(text).replace(
      /([^\s<>&]*)\[\^([\w.*†]+)\]/g,
      (_m, lead: string, label: string) => {
        const display = fnDisplay(label);
        return `<span class="fn-anchor">${lead}<button type="button" class="fn-marker" data-fn="${label}" data-fn-trans="${transId}" aria-label="Footnote ${display}">${display}</button></span>`;
      },
    ).replace(
      // Ostwald italicizes a transliterated Greek word or a title (*ethos,*
      // *Metaphysics*), and the Markdown transcription keeps that as emphasis —
      // the same convention the pipeline already renders as <em> in the
      // footnote text (stage1_ostwald._render_footnote), so the two layers
      // agree. Runs AFTER the footnote pass: a footnote label may itself be a
      // star ([^*]), and a pair of those would otherwise read as one long
      // emphasis. The capture stops at tag brackets and entities, so it can
      // neither span a marker's markup nor unbalance highlightEng's own; a span
      // split across a Bekker gutter boundary (each flow part renders on its
      // own) just stays literal rather than emitting an unclosed tag.
      /\*(?!\s)([^*<>&]+?)\*/g,
      '<em>$1</em>',
    );
  }

  // A segment renders as one or more blocks split at chapter boundaries.
  // `chapter` is non-null on the block that begins a new chapter (heading shown).
  // Every English slot (primary / Ross / third) lays out as flowing prose with
  // its Bekker numbers floated into the margin at their exact offsets (see
  // flowParts). A GreekLine may be a partial slice of a real line (cont = its
  // tail half, after a mid-line chapter split): it suppresses the repeated id.
  type RLine = GreekLine & { cont?: boolean };
  interface Block { chapter: string | null; bekker: string; lines: RLine[]; flow: FlowPart[]; oflows: Record<string, FlowPart[]>; otables: Record<string, { n: number; rows: string[][] }[]>; sidenotes: number[]; figs: number[]; }
  // EnrichedBlock annotates each block with the chapter it belongs to (tracking
  // across segments so continuation blocks know their chapter too).
  interface EnrichedBlock extends Block { currentChapter: string; }
  // A flowing-prose part: either a text run (n null) or a Bekker margin marker
  // (text null) placed at an exact mid-sentence offset — no row break.
  interface FlowPart { text: string | null; n: number | null; real: boolean; para?: boolean; }

  // The char position where token `w` begins in a line's text (0 at the start,
  // text.length at/after the end), so a cut preserves the verbatim
  // punctuation/sigla between words on the correct side.
  // locateToken (not a plain indexOf) so a word printed with an editorial
  // siglum inside it ("ἀνακε<κλ>ίσθαι") cuts at its real start; missing it
  // would put the head of the word on both sides of the cut.
  function tokenPos(line: GreekLine, w: number): number {
    if (w <= 0) return 0;
    if (w >= line.tokens.length) return line.text.length;
    let ptr = 0;
    for (let i = 0; i < w; i++) {
      const at = locateToken(line.text, line.tokens[i].t, ptr);
      if (at) ptr = at.end;
    }
    const cut = locateToken(line.text, line.tokens[w].t, ptr);
    return cut ? cut.start : ptr;
  }

  // The sub-line covering tokens [fromW, toW) — used to split a Greek line at a
  // chapter boundary that falls mid-line (most chapters start mid-line). A
  // partial tail (fromW>0) is marked `cont` so the line number/id isn't repeated.
  function lineSlice(line: GreekLine, fromW: number, toW: number): RLine {
    fromW = Math.max(0, fromW);
    toW = Math.min(line.tokens.length, toW);
    if (fromW === 0 && toW === line.tokens.length) return line;
    let text = line.text.slice(tokenPos(line, fromW), tokenPos(line, toW));
    if (fromW > 0) text = text.replace(/^\s+/, '');
    if (toW < line.tokens.length) text = text.replace(/\s+$/, '');
    return { n: line.n, text, tokens: line.tokens.slice(fromW, toW), cont: fromW > 0 };
  }

  // Flowing prose with Bekker numbers floated into the margin at their EXACT
  // offsets (no row break, no in-text number, no sentence-boundary snapping).
  // Used for precisely-placed translations like the gloss-aligned Ross.
  function flowParts(text: string, ticks: { n: number; real: boolean; off: number }[], paraOffsets: number[] = []): FlowPart[] {
    const ts = [
      ...ticks.map(t => ({ ...t, para: false })),
      ...paraOffsets.map(off => ({ n: 0, real: false, off, para: true })),
    ].sort((a, b) => a.off - b.off || Number(a.para) - Number(b.para));
    const parts: FlowPart[] = [];
    let cur = 0;
    const addText = (s: string) => {
      const segs = s.split('\n');
      for (let i = 0; i < segs.length; i++) {
        if (i > 0) parts.push({ text: '\n', n: null, real: false });
        if (segs[i]) parts.push({ text: segs[i], n: null, real: false });
      }
    };
    for (const t of ts) {
      const off = Math.max(0, Math.min(t.off, text.length));
      if (off > cur) { addText(text.slice(cur, off)); cur = off; }
      if (t.para) {
        parts.push({ text: null, n: null, real: false, para: true });
      } else {
        parts.push({ text: null, n: t.n, real: t.real });
      }
    }
    if (cur < text.length) addText(text.slice(cur));
    return parts;
  }

  // A standalone tick span is absolutely positioned with no `top`, so its
  // static position decides which line it reads against — and a marker box
  // sitting BETWEEN two text runs attaches to the END of the previous
  // rendered line whenever the marked word starts a new one. The tick then
  // shows a full rendered line (visually a sentence) too early, at every
  // column width. Merging each tick into the FOLLOWING text run as its first
  // child pins its static position to the first line box of the text it
  // marks. (It also keeps `.para-br + .bk-seg` adjacency intact when a tick
  // lands exactly on a paragraph start.) Ticks with an attached table — or
  // with no following text run — keep the standalone rendering.
  type RenderPart = FlowPart & { tick?: { n: number; real: boolean } };
  function attachTicks(parts: FlowPart[], tableNs: Set<number> = new Set()): RenderPart[] {
    const isText = (p: FlowPart | undefined): p is FlowPart => !!p && p.text !== null && p.text !== '\n';
    const isBreak = (p: FlowPart | undefined): boolean => !!p && (p.text === '\n' || p.para === true);
    const out: RenderPart[] = [];
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i];
      const isTick = part.text === null && part.n !== null && !part.para;
      if (isTick && part.n !== null && !tableNs.has(part.n)) {
        const next = parts[i + 1];
        if (isText(next)) {
          out.push({ ...next, tick: { n: part.n, real: part.real } });
          i += 1;
          continue;
        }
        // A tick coinciding with a paragraph boundary marks the paragraph's
        // OPENING word: emit the break first, then the opener carrying the
        // tick (leaving the tick standalone before the <br> re-creates the
        // previous-line attachment this helper exists to prevent).
        if (isBreak(next) && isText(parts[i + 2])) {
          out.push(next);
          out.push({ ...parts[i + 2], tick: { n: part.n, real: part.real } });
          i += 2;
          continue;
        }
      }
      out.push(part);
    }
    return out;
  }

  // Group a block's Greek lines into render items: runs of table rows (lines
  // carrying `cells`, e.g. the De Int 22a modal square) become one table; other
  // lines render individually.
  type GreekItem = { table: false; line: RLine } | { table: true; rows: RLine[] };
  function greekItems(lines: RLine[]): GreekItem[] {
    const items: GreekItem[] = [];
    let run: RLine[] = [];
    for (const l of lines) {
      if (l.cells && l.cells.length) { run.push(l); continue; }
      if (run.length) { items.push({ table: true, rows: run }); run = []; }
      items.push({ table: false, line: l });
    }
    if (run.length) items.push({ table: true, rows: run });
    return items;
  }

  function splitSegment(seg: Segment): Block[] {
    const greek = seg.greek;
    const text = seg.english?.text ?? '';
    const allTicks = seg.english?.bekker ?? [];
    const allParas = (seg.english?.markers ?? [])
      .filter(m => m.kind === 'paragraph')
      .map(m => m.offset);
    // The primary English slice [a, b) as flowing prose: its Bekker ticks
    // (rebased into the slice) are floated into the margin at their EXACT char
    // offsets — no sentence-snapping, no row break — so a mid-sentence Bekker
    // number renders where it actually falls instead of jumping to the next
    // sentence start (which the older snapped-row gutter did). The secondary
    // Ross slot uses the same flow model.
    const flowFor = (a: number, b: number): FlowPart[] => {
      const slice = text.slice(a, b);
      const ticks = allTicks
        .filter(t => t.offset >= a && t.offset < b)
        .map(t => ({ n: t.n, real: t.real, off: t.offset - a }))
        .sort((x, y) => x.off - y.off);
      const paras = allParas
        .filter(off => off > a && off < b)
        .map(off => off - a);
      return flowParts(slice, ticks, paras);
    };
    // Sidenote numbers ([[sN]] markers) falling in the primary English slice
    // [a, b) — the reader floats these into the right rail (busse works).
    const sidesIn = (a: number, b: number): number[] =>
      [...text.slice(a, b).matchAll(/\[\[s(\d+)\]\]/g)].map(m => Number(m[1]));
    // Diagram numbers ([[figN]] markers) in the slice — rendered inline as figures.
    const figsIn = (a: number, b: number): number[] =>
      [...text.slice(a, b).matchAll(/\[\[fig(\d+)\]\]/g)].map(m => Number(m[1]));
    // Overlay slices for each secondary translation, paired to blocks: the
    // continuation slice (a chapter begun in an earlier column) and one per
    // chapter that starts here. Each lays out as flowing prose with its Bekker
    // numbers floated into the margin at exact offsets. Keyed by translation id
    // so any number of overlays render (the 'third'/footnote-bearing one also
    // carries diagram tables).
    const secPieces = secondaries.map((t) => ({ t, pieces: piecesFor(seg, t) }));
    const flowOf = (p: OverlayPiece | undefined): FlowPart[] =>
      (!p || !p.text) ? [] : flowParts(p.text, (p.bekker ?? []).map(t => ({ n: t.n, real: t.real, off: t.offset })));
    const pieceCont = (pieces: OverlayPiece[]) => pieces.find(p => p.cont) ?? pieces[0];
    const pieceFor = (pieces: OverlayPiece[], chapter: string | null) =>
      pieces.find(p => !p.cont && p.chapter === chapter);
    // {transId: flow} + {transId: tables} for a block, picking each overlay's
    // continuation slice or the slice for `chapter` (null → continuation).
    const overlaysFor = (chapter: string | null): { oflows: Record<string, FlowPart[]>; otables: Record<string, { n: number; rows: string[][] }[]> } => {
      const oflows: Record<string, FlowPart[]> = {};
      const otables: Record<string, { n: number; rows: string[][] }[]> = {};
      for (const { t, pieces } of secPieces) {
        const p = chapter === null ? pieceCont(pieces) : pieceFor(pieces, chapter);
        oflows[t.id] = flowOf(p);
        if (p?.tables?.length) otables[t.id] = p.tables;
      }
      return { oflows, otables };
    };

    const starts = (seg.chapterStarts ?? []).slice()
      .sort((a, b) => a.beforeLine - b.beforeLine || (a.wordIndex || 0) - (b.wordIndex || 0));
    if (!starts.length) return [{ chapter: null, bekker: '', lines: greek, flow: flowFor(0, text.length), sidenotes: sidesIn(0, text.length), figs: figsIn(0, text.length), ...overlaysFor(null) }];

    const lineIdx = (beforeLine: number) => {
      const i = greek.findIndex(l => l.n >= beforeLine);
      return i === -1 ? greek.length : i;
    };
    // Each chapter boundary is a cut at (line index, word index within the line).
    const bounds = starts.map(s => ({
      chapter: s.chapter, bekker: s.bekker, engOffset: s.engOffset,
      idx: lineIdx(s.beforeLine), word: s.wordIndex || 0,
    }));

    // The Greek lines spanning a block from cut (idxA,wA) to cut (idxB,wB),
    // splitting the boundary lines mid-line where wA/wB > 0.
    const linesFor = (idxA: number, wA: number, idxB: number, wB: number): RLine[] => {
      if (idxA >= greek.length) return [];
      if (idxA === idxB) {                       // block lies within one line
        const sl = lineSlice(greek[idxA], wA, wB);
        return sl.tokens.length || sl.text.trim() ? [sl] : [];
      }
      const res: RLine[] = [];
      for (let i = idxA; i < idxB && i < greek.length; i++) {
        res.push(i === idxA && wA > 0 ? lineSlice(greek[i], wA, greek[i].tokens.length) : greek[i]);
      }
      if (wB > 0 && idxB < greek.length) res.push(lineSlice(greek[idxB], 0, wB));
      return res;
    };

    const blocks: Block[] = [];
    const first = bounds[0];
    // Lines/English before the first chapter start continue the previous chapter.
    if (first.idx > 0 || first.word > 0 || starts[0].engOffset > 0) {
      blocks.push({
        chapter: null, bekker: '',
        lines: linesFor(0, 0, first.idx, first.word),
        flow: flowFor(0, starts[0].engOffset), sidenotes: sidesIn(0, starts[0].engOffset), figs: figsIn(0, starts[0].engOffset), ...overlaysFor(null),
      });
    }
    for (let i = 0; i < bounds.length; i++) {
      const b = bounds[i];
      const next = bounds[i + 1];
      const engTo = next ? next.engOffset : text.length;
      blocks.push({
        chapter: b.chapter, bekker: b.bekker,
        lines: linesFor(b.idx, b.word, next ? next.idx : greek.length, next ? next.word : 0),
        flow: flowFor(b.engOffset, engTo), sidenotes: sidesIn(b.engOffset, engTo), figs: figsIn(b.engOffset, engTo), ...overlaysFor(b.chapter),
      });
    }
    return blocks;
  }

  // Active popup state
  let popup: { token: Token; anchor: { x: number; y: number } } | null = null;
  // Active footnote popup (footnote-bearing translations' `[^label]`
  // markers). Opens on hover, with a short close-delay so the cursor can
  // travel from the marker into the popup without it vanishing; click/Enter
  // also open it (touch + keyboard). §B4.3: carries `transId` (from the
  // marker's `data-fn-trans`) alongside the label, so FootnotePopup knows
  // WHICH translation's footnote map to resolve `n` against.
  let footnote: { n: string; transId: string; anchor: { x: number; y: number } } | null = null;
  // A click PINS the popup open (it stays until you dismiss it); hover opens it
  // transiently with a short close delay. Pinning makes click-to-read reliable.
  let fnPinned = false;
  let fnCloseTimer: ReturnType<typeof setTimeout> | null = null;
  function cancelFnClose() {
    if (fnCloseTimer) { clearTimeout(fnCloseTimer); fnCloseTimer = null; }
  }
  function scheduleFnClose() {
    if (fnPinned) return;            // a clicked (pinned) note ignores hover-out
    cancelFnClose();
    fnCloseTimer = setTimeout(() => { footnote = null; fnCloseTimer = null; }, 180);
  }
  // Commentary-class notes (imports whose sentinel declared render=endnote)
  // open the slide-in sidebar, click-only — a hover-triggered sidebar would
  // yank the whole layout on every marker fly-over. The hook is the same
  // lazy window global pattern FootnotePopup uses; on the site build it is
  // never installed, so this always returns null there.
  let endnote: { n: string; transId: string } | null = null;
  function noteRenderFor(transId: string): 'endnote' | null {
    if (!transId) return null;
    const hook = (globalThis as {
      __ARISTOTLE_IMPORT_NOTE_RENDER__?: (work: string, id: string) => 'endnote' | null;
    }).__ARISTOTLE_IMPORT_NOTE_RENDER__;
    return hook ? hook(work, transId) : null;
  }
  function closeEndnote() { endnote = null; }

  function showFootnote(marker: Element, pin = false) {
    cancelFnClose();
    const n = marker.getAttribute('data-fn') ?? '';
    const transId = marker.getAttribute('data-fn-trans') ?? '';
    if (noteRenderFor(transId) === 'endnote') {
      // The sidebar and the popover are mutually exclusive presentations.
      if (pin) { endnote = { n, transId }; closeFootnote(); }
      return;
    }
    if (pin) { fnPinned = true; closeEndnote(); }
    if (footnote?.n === n && footnote?.transId === transId) return;
    const r = marker.getBoundingClientRect();
    footnote = { n, transId, anchor: { x: r.left, y: r.bottom } };
  }
  function onFootnoteOver(e: MouseEvent) {
    const marker = (e.target as HTMLElement | null)?.closest?.('.fn-marker');
    if (marker) showFootnote(marker);
  }
  function onFootnoteOut(e: MouseEvent) {
    if ((e.target as HTMLElement | null)?.closest?.('.fn-marker')) scheduleFnClose();
  }
  function onFootnoteFocus(e: FocusEvent) {
    const marker = (e.target as HTMLElement | null)?.closest?.('.fn-marker');
    if (marker) showFootnote(marker);
  }
  function onFootnoteBlur(e: FocusEvent) {
    if ((e.target as HTMLElement | null)?.closest?.('.fn-marker')) scheduleFnClose();
  }
  function onFootnoteClick(e: MouseEvent | KeyboardEvent) {
    const marker = (e.target as HTMLElement | null)?.closest?.('.fn-marker');
    if (!marker) return;
    if (e instanceof KeyboardEvent && e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    e.stopPropagation();
    showFootnote(marker, true);
  }
  function closeFootnote() { cancelFnClose(); fnPinned = false; footnote = null; }
  // Click anywhere outside the marker/popup dismisses a pinned note; same
  // for the Bekker-numbers info popover.
  function onDocPointerDown(e: MouseEvent) {
    const t = e.target as HTMLElement | null;
    if (bekkerInfoOpen && !t?.closest?.('.bekker-info')) bekkerInfoOpen = false;
    if (endnote && !t?.closest?.('.fn-marker') && !t?.closest?.('.endnote-sidebar')) closeEndnote();
    if (!fnPinned) return;
    if (t?.closest?.('.fn-marker') || t?.closest?.('.footnote-popup')) return;
    closeFootnote();
  }

  onMount(async () => {
    // Remember which book of this work was last open, for the work switcher —
    // and stamp the work's recency so hosts can offer "continue reading".
    try { localStorage.setItem(`reader-book-${work}`, String(bookNum)); } catch {}
    touchRecent(work);

    // Restore font-size / line-height prefs.
    const savedFs = (() => { try { return localStorage.getItem(FS_KEY); } catch { return null; } })();
    if (savedFs) { const v = parseFloat(savedFs); if (!isNaN(v)) fsScale = v; }
    const savedLh = (() => { try { return localStorage.getItem(LH_KEY); } catch { return null; } })();
    if (savedLh) { const v = parseFloat(savedLh); if (!isNaN(v)) lhScale = v; }
    const savedColw = (() => { try { return localStorage.getItem(COLW_KEY); } catch { return null; } })();
    if (savedColw) { const v = parseFloat(savedColw); if (!isNaN(v)) colScale = v; }
    const savedCite = (() => { try { return localStorage.getItem(CITE_KEY); } catch { return null; } })();
    if (savedCite !== null) citeCopy = savedCite === 'true';

    // Settings sidebar events (dispatched by ReaderShell.astro and Escape handler).
    _onToggleSettings = () => { settingsOpen ? closeSettings() : openSettings(); };
    _onCloseSettings  = () => { if (settingsOpen) closeSettings(); };
    window.addEventListener('toggle-settings', _onToggleSettings);
    window.addEventListener('close-settings',  _onCloseSettings);
    const params = new URLSearchParams(window.location.search);
    hlGrkFolds = (params.get('hlg') ?? '').trim().split(/\s+/).filter(Boolean)
      .map(t => greekFold(t.replace(/\*/g, ''))).filter(Boolean);
    hlEngTerms = (params.get('hle') ?? '').trim().split(/\s+/).filter(Boolean);
    const loc = params.get('loc');
    let locCol = '';
    let locLine = NaN;
    if (loc) {
      const [col, ln] = loc.split(':');
      locCol = col;
      // A lettered line arrives as "5a": the id keeps the letter, and the
      // nearest-line fallback below reads the number in front of it.
      locLine = parseInt(ln, 10);
      targetId = `L${col}-${ln}`;
    }
    // Restore saved view, but a jump-in (loc/highlight) forces bilingual so the
    // target Greek line is on screen.
    if (loc || hlGrkFolds.length) {
      view = 'both';
    } else {
      const saved = (() => { try { return localStorage.getItem('reader-view'); } catch { return null; } })();
      if (saved === 'greek' || saved === 'english' || saved === 'both') view = saved;
      // No saved choice: a phone defaults to English only (the bilingual columns
      // are cramped on a narrow screen); desktop stays bilingual. The toggle —
      // and any saved choice — overrides this on either.
      else if (window.matchMedia('(max-width: 680px)').matches) view = 'english';
    }
    const validTrans = new Set([...translations.map(t => t.id), ...(canCompare ? ['compare'] : [])]);
    const savedTrans = (() => { try { return localStorage.getItem(TRANS_KEY); } catch { return null; } })();
    if (savedTrans && validTrans.has(savedTrans)) trans = savedTrans;
    // A restored single choice is also the one "leave compare" returns to.
    if (trans !== 'compare') lastSingle = trans;
    // Restore the chosen compare pair (set in the settings sidebar).
    const transIds = new Set(translations.map(t => t.id));
    const savedL = (() => { try { return localStorage.getItem(CMPL_KEY); } catch { return null; } })();
    const savedR = (() => { try { return localStorage.getItem(CMPR_KEY); } catch { return null; } })();
    if (savedL && transIds.has(savedL)) compareLeft = savedL;
    if (savedR && transIds.has(savedR)) compareRight = savedR;
    // The home index links can preselect a view/translation via query params.
    const qView = params.get('view');
    if (qView === 'greek' || qView === 'both' || qView === 'english') view = qView;
    const qTrans = params.get('trans');
    if (qTrans && validTrans.has(qTrans)) { trans = qTrans; if (view === 'greek') view = 'both'; }
    try {
      // Already seeded from the build-time prop in the normal (SSR) path; only
      // fetch when the reader was mounted without it.
      if (!bookData) {
        const data = await fetchBook(work, bookNum);
        segments = data.segments;
      }
    } catch (e) {
      error = String(e);
    } finally {
      loading = false;
      // After Svelte renders, scroll to the jumped-to line (loc), a Bekker
      // citation in the hash, or a plain element-id hash.
      const hash = window.location.hash.slice(1);
      setTimeout(() => {
        if (targetId) {
          let el = document.getElementById(targetId);
          // Snap to the nearest existing line in the column if the exact
          // citation line isn't a Greek line break (e.g. mid-line citations).
          if (!el && locCol && !Number.isNaN(locLine)) {
            // nearestLineAnchor sees lettered lines. Matching /-(\d+)$/ here
            // did not: GA 775a prints 11a/11b/11c and no bare 11, so a
            // citation of "775a11" skipped the whole group and snapped back to
            // line 10 — a confidently wrong line, which is worse than none.
            const seg = document.getElementById(`col-${locCol}`);
            const ids = [...(seg?.querySelectorAll('.greek-line') ?? [])].map((n) => n.id);
            const near = nearestLineAnchor(ids, locCol, locLine);
            const bestEl = near ? document.getElementById(near) : null;
            if (bestEl) { el = bestEl; targetId = near as string; }
          }
          if (el) { suppressArmUntil = Date.now() + 1500; el.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
        } else if (hash) {
          const ref = parseBekker(hash);
          if (ref) {
            scrollToCitation(ref.column, ref.line, ref.sub);
            lastCite = `${ref.column}${lineRef(ref.line, ref.sub)}`;
            // Tint the cited line so a shared link makes the passage obvious.
            targetId = lineAnchor(ref.column, ref.line, ref.sub);
          } else {
            // Column-level citations (the scroll-spy writes bare "#1107a" when
            // the Greek column is hidden) target the segment element col-<col>.
            // Instant, like scrollToCitation: a smooth animation started during
            // hydration gets canceled by layout churn and strands the reader at
            // the top.
            const el = document.getElementById(hash) ?? document.getElementById(`col-${hash}`);
            if (el) {
              suppressArmUntil = Date.now() + 1500;
              el.scrollIntoView({ behavior: 'auto', block: 'start' });
            }
          }
        }
        // Begin live URL tracking once the reader actually scrolls (programmatic
        // jumps above are suppressed), so an opened #citation isn't overwritten.
        window.addEventListener('scroll', onScrollArm, { passive: true });
        window.addEventListener('scroll', onCtxScroll, { passive: true });
        window.addEventListener('resize', onResize);
        document.addEventListener('mouseup', checkCopyBtn);
        document.addEventListener('selectionchange', onSelectionChange);
        updateChapterContext();
      }, 0);
    }
  });

  // Opening/closing the word sidebar changes the reader body's width (it gains
  // padding-right to clear the panel), which reflows the text and shifts every
  // line vertically — so the passage the reader was looking at jumps. Pin a
  // given element to its current screen position by compensating scroll on each
  // frame for the duration of the width transition. MUST be called BEFORE the
  // `popup` state change so startTop is captured in the pre-reflow layout.
  function pinAcrossReflow(el: HTMLElement | null) {
    if (!el || typeof window === 'undefined') return;
    const startTop = el.getBoundingClientRect().top;
    suppressArmUntil = Date.now() + 500;   // don't let our scrolls arm the spy
    const until = Date.now() + 360;        // padding-right transition is 0.22s
    const step = () => {
      const delta = el.getBoundingClientRect().top - startTop;
      if (Math.abs(delta) >= 0.5) window.scrollBy(0, delta);
      if (Date.now() < until) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // The line currently at the top of the reading area — the fallback anchor to
  // keep fixed when the sidebar closes after the clicked word has scrolled away.
  function topAnchor(): HTMLElement | null {
    const ctrlBottom = document.querySelector('.reader-controls')?.getBoundingClientRect().bottom ?? 0;
    const inset = ctrlBottom + 8;
    const greekVisible = view === 'greek' || view === 'both';
    const els = document.querySelectorAll<HTMLElement>(greekVisible ? '.greek-line[id]' : '.segment[id]');
    let best: HTMLElement | null = null, bestDiff = Infinity;
    for (const el of els) {
      const diff = Math.abs(el.getBoundingClientRect().top - inset);
      if (diff < bestDiff) { bestDiff = diff; best = el; }
    }
    return best;
  }

  function inViewport(el: HTMLElement): boolean {
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.top < window.innerHeight;
  }

  // The word whose click opened the sidebar — pinned again on close so the
  // passage lands back exactly where it opened (symmetric), unless the reader
  // scrolled it out of view, in which case we keep the current top line fixed.
  let pinnedTok: HTMLElement | null = null;

  function handleTokenClick(e: MouseEvent, token: Token | null) {
    if (!token) return;
    e.stopPropagation();
    const el = e.currentTarget as HTMLElement;
    const rect = el.getBoundingClientRect();
    // Only the first open reflows the body (adds .word-open); switching words
    // while the sidebar is already open changes nothing about the layout.
    if (!popup) { pinnedTok = el; pinAcrossReflow(el); }
    popup = { token, anchor: { x: rect.left, y: rect.bottom } };
  }

  function closePopup() {
    if (popup) pinAcrossReflow(pinnedTok && inViewport(pinnedTok) ? pinnedTok : topAnchor());
    popup = null;
    pinnedTok = null;
  }

  // Show line number only for multiples of 5 (and line 1). Suppressed entirely
  // for non-Bekker works whose synthetic line numbers aren't meaningful.
  function showLineNum(n: number, sub?: string): string {
    if (hideLineNums) return '';
    // A lettered line always prints its own number: it is the second line
    // called 5 in that column, and an unlabelled one reads as a stray.
    if (sub) return lineRef(n, sub);
    if (n === 1 || n % 5 === 0) return String(n);
    return '';
  }

  // ── Copy-with-citation helpers ────────────────────────────────────────────
  function nearestGreekLine(node: Node): HTMLElement | null {
    let n: Node | null = node;
    while (n && n !== document.body) {
      if (n instanceof HTMLElement && n.classList.contains('greek-line')) return n;
      n = n.parentNode;
    }
    return null;
  }
  // L1094a-3 → 1094a3; L1094a-3-c → 1094a3
  const idToBekker = (id: string) => id.slice(1).replace(/-(\d+)(-c)?$/, '$1');

  function greekCiteForRange(range: Range): string | null {
    const startLine = nearestGreekLine(range.startContainer);
    const endLine   = nearestGreekLine(range.endContainer);
    if (!startLine && !endLine) return null;
    const s = startLine ? idToBekker(startLine.id) : null;
    const f = endLine   ? idToBekker(endLine.id)   : null;
    const abbr = workMeta?.abbr ?? '';
    return (s && f && s !== f) ? `(${abbr} ${s}–${f})` : `(${abbr} ${s ?? f})`;
  }

  function handleCopy(e: ClipboardEvent) {
    if (!citeCopy) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
    const text = sel.toString().trim();
    if (!text) return;
    const range = sel.getRangeAt(0);
    const cite = greekCiteForRange(range);
    if (!cite) return; // English-only selection; wait for alignment
    e.clipboardData?.setData('text/plain', text + '\n' + cite);
    e.preventDefault();
  }

  // ── Floating copy button (appears on Greek text selection) ────────────────
  let copyBtnPos: { x: number; y: number } | null = null;

  function checkCopyBtn() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) { copyBtnPos = null; return; }
    const range = sel.getRangeAt(0);
    if (!nearestGreekLine(range.startContainer) && !nearestGreekLine(range.endContainer)) {
      copyBtnPos = null; return;
    }
    const rect = range.getBoundingClientRect();
    if (!rect.width && !rect.height) { copyBtnPos = null; return; }
    copyBtnPos = { x: rect.right, y: rect.top };
  }

  function onSelectionChange() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) copyBtnPos = null;
  }

  function clickCopyBtn() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) { copyBtnPos = null; return; }
    const text = sel.toString().trim();
    const cite = greekCiteForRange(sel.getRangeAt(0));
    const full = cite ? text + '\n' + cite : text;
    navigator.clipboard.writeText(full).catch(() => {});
    copyBtnPos = null;
  }
</script>

<!-- View toggle and Print control are rendered in the reader header on desktop
     and inside the ⚙ Settings sidebar on mobile (CSS scopes which is visible).
     Top-level snippets keep a single source of markup and one printMenuOpen. -->
{#snippet viewToggle()}
  <div class="view-toggle" role="group" aria-label="Reading view">
    <button class:active={view === 'greek'} aria-pressed={view === 'greek'} on:click={() => setView('greek')}>Greek</button>
    <button class:active={view === 'both'} aria-pressed={view === 'both'} on:click={() => setView('both')}>Both</button>
    <button class:active={view === 'english'} aria-pressed={view === 'english'} on:click={() => setView('english')}>English</button>
  </div>
{/snippet}

{#snippet printControl()}
  {#if chaptersInBook.length > 1}
    <div class="print-menu">
      <button class="print-btn" on:click={togglePrintMenu} title="Print or save as PDF" aria-label="Print or save as PDF">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M6 9V2h12v7" />
          <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
          <rect x="6" y="14" width="12" height="8" />
        </svg>
        <span class="print-btn-label">Print</span>
        <svg class="print-chevron" viewBox="0 0 10 6" width="8" height="5" fill="currentColor" aria-hidden="true"><path d="M0 0l5 6 5-6z"/></svg>
      </button>
      {#if printMenuOpen}
        <div class="print-dropdown">
          <button class="print-dd-item" on:click={() => { printMenuOpen = false; printReader(); }}>Full book</button>
          <div class="print-dd-sep" role="separator"></div>
          {#each chaptersInBook as ch}
            <button class="print-dd-item" on:click={() => { printMenuOpen = false; printSingleChapter(ch); }}>
              {#if bookLabel}{bookLabel}, {/if}Chapter {ch}
            </button>
          {/each}
        </div>
      {/if}
    </div>
  {:else}
    <button class="print-btn" on:click={printReader} title="Print or save as PDF" aria-label="Print or save as PDF">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M6 9V2h12v7" />
        <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
        <rect x="6" y="14" width="12" height="8" />
      </svg>
      <span class="print-btn-label">Print</span>
    </button>
  {/if}
{/snippet}

{#if loading}
  <p style="padding:2rem;font-family:system-ui;color:#888">Loading Book {bookNum}…</p>
{:else if error}
  <p style="padding:2rem;color:red">{error}</p>
{:else}
  {#snippet greekToks(parts: LinePart[])}{#each parts as part}{#if part.tok}<!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions --><span
        class="tok"
        class:active={popup?.token === part.tok}
        class:hit={isHit(part.tok.t)}
        on:click={(e) => handleTokenClick(e, part.tok)}
      >{part.text}</span>{:else}{part.text}{/if}{/each}{/snippet}
  {#snippet chapterHead(block: Block)}
    <div class="chapter-head" id="ch-{bookNum}-{block.chapter}">
      <span class="chapter-label">{#if bookLabel}<span class="chapter-book">{bookLabel},&nbsp;</span>{/if}Chapter {block.chapter}{#if chapterTitles[block.chapter ?? '']}: {chapterTitles[block.chapter ?? '']}{/if}</span>
      {#if block.bekker && !busse}<span class="chapter-bekker">({block.bekker})</span>{/if}
    </div>
  {/snippet}

  <!-- One English column for a translation: the primary's flow (block.flow) or
       an overlay's (block.oflows[id]), as flowing prose with margin-floated
       Bekker numbers. The footnote/table-bearing translation ('third' slot)
       uses renderThird + clickable `[^N]` markers + diagram tables; the rest
       use plain highlightEng. Works for any number of translations. -->
  {#snippet transFlow(block: Block, transId: string)}
    {@const flow = transId === engSlot?.id ? block.flow : (block.oflows[transId] ?? [])}
    {#if flow.length}
      {@const chTitle = importChapterTitle(transId, block.chapter)}
      <!-- An imported translation's chapter-opening title: a SIBLING before
           .overlay-prose, not its first child — (a) inside .overlay-prose it pushed
           the English prose one line below the Greek (John's review of
           631ff971); the Greek column gets a matching invisible spacer
           instead (see the .greek-col markup below), so Greek line 1 and
           English prose line 1 stay flush and the title takes its own space
           above; (b) the offset walkers (annotations.ts proseOffsetAt,
           emphasis-paint.ts proseText) root at col.querySelector('.overlay-prose')
           and exclude only .bk-num/.eng-table, so title text INSIDE
           .overlay-prose would leak into captured offsets — as a sibling they
           never see it, keeping the render-only/no-offset-shift guarantee
           structural. -->
      {#if chTitle}<div class="overlay-chapter-title">{#if fnTransIds.has(transId)}<!-- eslint-disable-next-line svelte/no-at-html-tags -->{@html renderThird(chTitle, transId)}{:else}{chTitle}{/if}</div>{/if}
      {#if fnTransIds.has(transId)}
        <div
          class="overlay-prose"
          on:mouseover={onFootnoteOver}
          on:mouseout={onFootnoteOut}
          on:focus={onFootnoteFocus}
          on:blur={onFootnoteBlur}
          on:focusin={onFootnoteFocus}
          on:focusout={onFootnoteBlur}
          on:click={onFootnoteClick}
          on:keydown={onFootnoteClick}
          role="presentation"
        >
          {#each attachTicks(flow, new Set((block.otables[transId] ?? []).map(t => t.n))) as part}
            {#if part.text === '\n'}
              <br class="para-br" />
            {:else if part.text !== null}
              <span class="bk-seg"
                >{#if part.tick}<span class="bk-num" class:approx={!part.tick.real}>{part.tick.n}</span
                  >{/if}<!-- eslint-disable-next-line svelte/no-at-html-tags -->{@html renderThird(part.text, transId)}</span>
            {:else if part.para}
              <br class="para-br" />
            {:else}
              <span class="bk-num" class:approx={!part.real}>{part.n}</span>
              {#each (block.otables[transId] ?? []).filter(t => t.n === part.n) as tbl}
                <table class="eng-table"><tbody>
                  {#each tbl.rows as trow}
                    <tr>{#each trow as cell}<td>{cell}</td>{/each}</tr>
                  {/each}
                </tbody></table>
              {/each}
            {/if}
          {/each}
        </div>
      {:else}
        <div class="overlay-prose">
          {#each attachTicks(flow) as part}
            {#if part.text === '\n'}
              <br class="para-br" />
            {:else if part.text !== null}
              <span class="bk-seg"
                >{#if part.tick}<span class="bk-num" class:approx={!part.tick.real}>{part.tick.n}</span
                  >{/if}<!-- eslint-disable-next-line svelte/no-at-html-tags -->{@html highlightEng(part.text)}</span>
            {:else if part.para}
              <br class="para-br" />
            {:else}
              <span class="bk-num" class:approx={!part.real}>{part.n}</span>
            {/if}
          {/each}
        </div>
      {/if}
    {/if}
  {/snippet}

  <div class="reader-body view-{view} trans-{trans}" role="main"
    class:busse={busse}
    class:word-open={!!popup}
    style="--fs-greek:{fsGreek}rem;--fs-english:{fsEng}rem;--lh-greek:{lhGreek};--lh-english:{lhEng};--colw-scale:{colScale};--fs-scale:{fsScale}{greekTrack ? `;--greek-track:${greekTrack}px` : ''}"
    on:copy={handleCopy}>
    <div class="reader-controls">
      {#if liveChapter}
        <span class="rc-context">{liveChapter}</span>
      {/if}
      <div class="rc-cite">
        {#if view === 'greek'}
          {#if greekSrc}<span class="rc-greek">{greekSrc.full}</span>{/if}
        {:else if trans === 'compare'}
          {#if view === 'both'}<span class="rc-col-spacer" aria-hidden="true"></span>{/if}
          <span class="rc-col-name">{citeShort(transById(compareLeft))}</span>
          <span class="rc-col-name">{citeShort(transById(compareRight))}</span>
        {:else if view === 'both'}
          <span class="rc-pair">{pairText}</span>
        {:else if selectedTrans}
          <span class="rc-full">{selectedTrans.name}</span>
        {/if}
      </div>
      <div class="rc-controls">
        {#if view !== 'greek' && translations.length === 1}
          <span class="rc-trans-abbr">{citeShort(translations[0])}</span>
        {/if}
        {#if translations.length > 1}
          <!-- Desktop translation picker, beside the view toggle. On mobile this
               is hidden (see global.css) and the same control lives in the
               ⚙ Settings sidebar instead. -->
          <select class="rc-trans-select" value={pickValue} on:change={onPick} aria-label="English translation">
            {#each translations as t}
              <option value={t.id}>{t.name}</option>
            {/each}
          </select>
        {/if}
        <!-- Desktop only — on mobile these live in the ⚙ Settings sidebar. -->
        <div class="rc-desktop-controls">
          {@render viewToggle()}
          {@render printControl()}
        </div>
      </div>
    </div>
    <!-- Print-only masthead (hidden on screen): author eyebrow, work title with
         its Greek title alongside, and the source citation. -->
    <div class="print-head" aria-hidden="true">
      <div class="print-eyebrow">{workMeta?.author ?? 'Aristotle'}</div>
      <div class="print-titleline">
        <span class="print-title">{workMeta?.title ?? ''}</span>
        {#if workMeta?.greekTitle}<span class="print-title-gk">{workMeta.greekTitle}</span>{/if}
      </div>
      {#if printCite}<div class="print-cite">{printCite}</div>{/if}
    </div>
    {#if hasApproxTicks && !busse}
      <!-- The estimate disclaimer stays one click away, not a paragraph of
           front matter: the honesty lives in the ticks themselves (upright vs
           italic grey); this explains the convention on demand. -->
      <div class="bekker-info">
        <button
          type="button"
          class="bekker-info-btn"
          aria-expanded={bekkerInfoOpen}
          on:click|stopPropagation={() => (bekkerInfoOpen = !bekkerInfoOpen)}
        >ℹ︎ Bekker numbers</button>
        {#if bekkerInfoOpen}
          <div class="bekker-info-pop" role="note" transition:fade={{ duration: 120 }}>
            Greek line numbers are exact. The translations carry no Bekker
            numbers of their own, so those beside the English are aligned to
            the Greek: <span class="bk-fixed">upright</span> = fixed (anchored
            to this point in the text), <span class="bk-approx">italic grey</span>
            = approximate (interpolated estimate).
          </div>
        {/if}
      </div>
    {/if}
    {#each enrichedSegments as {seg, blocks} (seg.id)}
      {@const leadChapter = blocks[0]?.chapter ? blocks[0] : null}
      <div class="segment" id="col-{seg.column}">
        <!-- A chapter that opens this column heads the segment, ABOVE the column
             reference (the column ref is a marker within the chapter, not a
             heading over it). Mid-column chapter starts render inline below. -->
        {#if leadChapter}{@render chapterHead(leadChapter)}{/if}
        {#if !busse}
          <div class="seg-ref">
            {seg.column}
          </div>
        {/if}

        {#each blocks as block, bi}
          <!-- If the on-screen primary translation (English cell of this row)
               opens this chapter with an imported title, the Greek column gets
               an invisible spacer of the same one-line height (see
               .overlay-chapter-title-spacer in global.css) so both columns are
               pushed down equally: title above, Greek line 1 flush with
               English prose line 1. Same gates as the visible title in
               transFlow (chapter start + that import's flow present here);
               skipped in greek-only view (no title shown → no gap). Compare
               mode aligns Greek to the LEFT column; the right column's own
               title still renders in its cell via transFlow. -->
          {@const spacerTransId = trans === 'compare' ? compareLeft : trans}
          {@const spacerFlow = spacerTransId === engSlot?.id ? block.flow : (block.oflows[spacerTransId] ?? [])}
          {@const spacerTitle = view !== 'greek' && spacerFlow.length ? importChapterTitle(spacerTransId, block.chapter) : ''}
          {#if block.chapter && !(bi === 0 && leadChapter)}
            {@render chapterHead(block)}
          {/if}
          <div class="seg-row" data-chapter={block.currentChapter}>
            <!-- Greek column -->
            <div class="greek-col" lang="grc">
              {#if spacerTitle}<div class="overlay-chapter-title overlay-chapter-title-spacer" aria-hidden="true">{titleText(spacerTitle)}</div>{/if}
              {#each greekItems(block.lines) as item}
                {#if item.table}
                  <!-- Greek inline table (the TLG ⎪ column square, e.g. De Int 22a). -->
                  <table class="greek-table"><tbody>
                    {#each item.rows as row}
                      <tr id={lineAnchor(seg.column, row.n, row.sub)} class:target={targetId === lineAnchor(seg.column, row.n, row.sub)}>
                        <td class="line-num">{showLineNum(row.n, row.sub)}</td>
                        {#each (row.cells ?? []) as cell}
                          <td class="line-text" lang="grc">{@render greekToks(cellParts(cell))}</td>
                        {/each}
                      </tr>
                    {/each}
                  </tbody></table>
                {:else}
                  <div class="greek-line" id={item.line.cont ? `${lineAnchor(seg.column, item.line.n, item.line.sub)}-c` : lineAnchor(seg.column, item.line.n, item.line.sub)} class:target={!item.line.cont && targetId === lineAnchor(seg.column, item.line.n, item.line.sub)} class:cont={item.line.cont}>
                    <span class="line-num">{item.line.cont ? '' : showLineNum(item.line.n, item.line.sub)}</span>
                    <!-- The siglum sits in the margin at the gutter's edge; when the
                         line also carries a Bekker number, it slides left of it —
                         the number never yields its slot. -->
                    <!-- A quotation's `lo` is a bare line number, so it belongs
                         to the unlettered line: without the `sub` guard a
                         quotation starting at 244b5 drew its sigla twice, once
                         on 5 and again on 5a. -->
                    {#if !item.line.cont && !item.line.sub && quoteStarts.has(`${seg.column}:${item.line.n}`)}
                      <span class="quotation-sigla" class:has-num={showLineNum(item.line.n) !== ''}>
                        {#each quoteStarts.get(`${seg.column}:${item.line.n}`) ?? [] as q}
                          <QuotationMarker quotation={q} />
                        {/each}
                      </span>
                    {/if}
                    <span class="line-text" lang="grc">{@render greekToks(lineParts(item.line))}</span>
                  </div>
                {/if}
              {/each}
            </div>

            <!-- English column: the selected translation (single view), or the
                 left compare column. Prose laid out beside its Bekker-line
                 gutter — real anchors full weight, estimates lighter/italic. -->
            <div class="english-col" data-trans={trans === 'compare' ? compareLeft : trans}>
              {#if trans === 'compare'}<div class="col-label">{transById(compareLeft)?.short ?? 'English'}</div>{/if}
              {@render transFlow(block, trans === 'compare' ? compareLeft : trans)}
              <!-- Inline diagrams ([[figN]] markers), e.g. the Tree of Porphyry.
                   Corpus HTML like a footnote, so it takes the same sanitizer
                   the footnote and endnote panels apply before {@html}. -->
              {#if busse && view !== 'greek' && block.figs.length}
                {#each block.figs as fig}
                  {#if figuresData[String(fig)]}<!-- eslint-disable-next-line svelte/no-at-html-tags -->{@html sanitizeHtml(figuresData[String(fig)])}{/if}
                {/each}
              {/if}
            </div>

            <!-- Right compare column: the second chosen translation beside the
                 first (hidden in Greek-only). -->
            {#if trans === 'compare' && view !== 'greek'}
              <div class="overlay-col" data-trans={compareRight}>
                <div class="col-label">{transById(compareRight)?.short ?? ''}</div>
                {@render transFlow(block, compareRight)}
              </div>
            {/if}

            <!-- Analytical sidenotes (Owen's marginal notes), floated into a
                 right rail on desktop; on mobile they fall inline below the
                 English (hidden in Greek-only view). -->
            {#if busse && view !== 'greek' && block.sidenotes.length}
              <aside class="sidenote-rail">
                {#each block.sidenotes as sn}
                  {#if sidenotesData[String(sn)]}<p class="sidenote">{sidenotesData[String(sn)]}</p>{/if}
                {/each}
              </aside>
            {/if}
          </div>
        {/each}
      </div>
    {/each}
  </div>
{/if}

<aside class="settings-sidebar" class:open={settingsOpen} aria-label="Reader settings" aria-hidden={!settingsOpen} inert={!settingsOpen}>
  <div class="settings-head">
    <span class="settings-title">Settings</span>
    <button type="button" class="settings-close" on:click={closeSettings} aria-label="Close settings">×</button>
  </div>
  <div class="settings-body">
    <!-- Mobile-only: on desktop the view toggle and print control live in the
         reader header (see .settings-mobile-only in global.css). -->
    <div class="settings-section settings-mobile-only">
      <div class="settings-section-label">View</div>
      {@render viewToggle()}
    </div>
    {#if translations.length > 1}
      <!-- Mobile-only: on desktop the picker sits beside the view toggle in the
           header (see .settings-trans in global.css). -->
      <div class="settings-section settings-trans">
        <div class="settings-section-label">Translation</div>
        <!-- svelte-ignore a11y-label-has-associated-control -->
        <label>
          <select class="settings-select" value={pickValue} on:change={onPick} aria-label="English translation">
            {#each translations as t}
              <option value={t.id}>{t.name}</option>
            {/each}
          </select>
        </label>
      </div>
    {/if}
    {#if canCompare}
      <!-- Mode lives HERE, not in the picker: the dropdowns choose WHICH
           translation, this chooses single vs side-by-side comparison. -->
      <div class="settings-section">
        <div class="settings-section-label">Translations</div>
        <label class="settings-mode-row">
          <input
            type="radio"
            name="trans-mode"
            checked={trans !== 'compare'}
            on:change={() => setTrans(lastSingle)}
          />
          <span>Single translation</span>
        </label>
        <label class="settings-mode-row">
          <input
            type="radio"
            name="trans-mode"
            checked={trans === 'compare'}
            on:change={() => setTrans('compare')}
          />
          <span>Compare two translations</span>
        </label>
      </div>
    {/if}
    {#if canCompare && trans === 'compare'}
      <!-- Compare pair: which two translations sit side by side. -->
      <div class="settings-section">
        <div class="settings-section-label">Compare</div>
        <!-- svelte-ignore a11y-label-has-associated-control -->
        <label class="settings-compare-row">
          <span class="settings-compare-side">Left</span>
          <select class="settings-select" bind:value={compareLeft} on:change={() => { saveCompare(); setTrans('compare'); }} aria-label="Compare left translation">
            {#each translations as t}
              <option value={t.id}>{t.name}</option>
            {/each}
          </select>
        </label>
        <!-- svelte-ignore a11y-label-has-associated-control -->
        <label class="settings-compare-row">
          <span class="settings-compare-side">Right</span>
          <select class="settings-select" bind:value={compareRight} on:change={() => { saveCompare(); setTrans('compare'); }} aria-label="Compare right translation">
            {#each translations as t}
              <option value={t.id}>{t.name}</option>
            {/each}
          </select>
        </label>
      </div>
    {/if}

    <div class="settings-section settings-mobile-only">
      <div class="settings-section-label">Print</div>
      {@render printControl()}
    </div>

    <div class="settings-section">
      <div class="settings-section-label">Text size</div>
      <label class="settings-slider">
        <div class="settings-slider-row">
          <span class="settings-slider-name">Size</span>
          <span class="settings-slider-val">{Math.round(fsScale * 100)}%</span>
        </div>
        <input type="range" min="0.75" max="1.4" step="0.05" bind:value={fsScale} on:change={saveFs} aria-label="Text size" />
      </label>
    </div>

    <div class="settings-section">
      <div class="settings-section-label">Line spacing</div>
      <label class="settings-slider">
        <div class="settings-slider-row">
          <span class="settings-slider-name">Spacing</span>
          <span class="settings-slider-val">{Math.round(lhScale * 100)}%</span>
        </div>
        <input type="range" min="0.8" max="1.4" step="0.05" bind:value={lhScale} on:change={saveLh} aria-label="Line spacing" />
      </label>
    </div>

    <div class="settings-section">
      <div class="settings-section-label">Column width</div>
      <label class="settings-slider">
        <div class="settings-slider-row">
          <span class="settings-slider-name">Width</span>
          <span class="settings-slider-val">{Math.round(colScale * 100)}%</span>
        </div>
        <input type="range" min="0.75" max="1.3" step="0.05" bind:value={colScale} on:change={saveColw} aria-label="Column width" />
      </label>
    </div>

    <div class="settings-section">
      <div class="settings-section-label">Copying</div>
      <label class="settings-check-row">
        <span class="settings-check-name">
          Append citation on copy
          <span class="settings-check-hint">Greek selections only</span>
        </span>
        <span class="settings-pill">
          <input type="checkbox" bind:checked={citeCopy} on:change={saveCiteCopy} aria-label="Append citation when copying text" />
          <span class="settings-pill-track"></span>
          <span class="settings-pill-thumb"></span>
        </span>
      </label>
    </div>

    <div class="settings-section">
      <button type="button" class="settings-reset" on:click={resetSettings}>Reset to defaults</button>
    </div>
  </div>
</aside>

{#if settingsOpen}
  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
  <div class="settings-backdrop" on:click={closeSettings} transition:fade={{ duration: 180 }}></div>
{/if}

{#if popup}
  <WordPopup
    {work}
    token={popup.token}
    anchor={popup.anchor}
    onClose={closePopup}
  />
{/if}

<svelte:window on:pointerdown={onDocPointerDown} />

{#if footnote}
  <FootnotePopup
    {work}
    n={footnote.n}
    transId={footnote.transId}
    anchor={footnote.anchor}
    onClose={closeFootnote}
    onHoverIn={cancelFnClose}
    onHoverOut={scheduleFnClose}
  />
{/if}

{#if endnote}
  <EndnoteSidebar {work} n={endnote.n} transId={endnote.transId} onClose={closeEndnote} />
{/if}

{#if copyBtnPos}
  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
  <button
    class="copy-cite-btn"
    style="left:{copyBtnPos.x}px;top:{copyBtnPos.y}px"
    on:mousedown|preventDefault
    on:click={clickCopyBtn}
    aria-label="Copy with citation"
    title="Copy with citation"
  >
    <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M4 2a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V2z"/>
      <path d="M0 4a2 2 0 0 1 2-2v10a2 2 0 0 0 2 2h8a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2V4z"/>
    </svg>
    Copy
  </button>
{/if}
