<script lang="ts">
  // App chrome for the Translation Workbench. The library rail lists every
  // work from the manifests; corpus-ready works open in the row-lock editor
  // with rows sliced from the Greek spine (src/lib/data). Works without a
  // corpus on this machine degrade to one quiet line. The footnote panel and
  // lexicon drawer are wired below.
  import { onMount, tick } from 'svelte';
  import ThemeToggle from './components/ThemeToggle.svelte';
  import LibraryRail from './components/LibraryRail.svelte';
  import type { RailSelection, RailWork } from './components/LibraryRail.svelte';
  import AddWorkDialog from './components/AddWorkDialog.svelte';
  import ImportDialog from './components/ImportDialog.svelte';
  import NewDocumentDialog from './components/NewDocumentDialog.svelte';
  import SourceImportDialog from './components/SourceImportDialog.svelte';
  import ProfileDialog from './components/ProfileDialog.svelte';
  import WorkDetailsDialog from './components/WorkDetailsDialog.svelte';
  import LexiconDrawer from './components/LexiconDrawer.svelte';
  import AskPanel from './components/AskPanel.svelte';
  import AiPanel from './components/AiPanel.svelte';
  import FootnotePanel from './components/FootnotePanel.svelte';
  import ReferencePanel from './components/ReferencePanel.svelte';
  import ReferenceImportDialog from './components/ReferenceImportDialog.svelte';
  import ExportButton from './components/ExportButton.svelte';
  import ChapterEditor from './lib/editor/ChapterEditor.svelte';
  import type { OutlineItem } from './lib/editor/outline';
  import { buildOutlineTree } from './lib/editor/outline';
  import EditorToolbar from './lib/editor/EditorToolbar.svelte';
  import { listWorks } from './lib/works/manifest';
  import type { WorkManifest } from './lib/works/manifest';
  import {
    listFreeWorks,
    removeFreeWork,
    updateFreeWorkAuthor,
    updateFreeWorkBookContainers,
    updateFreeWorkLanguage,
    updateFreeWorkTitle,
  } from './lib/works/freeWorks';
  import {
    withAddedBookContainer,
    withInsertedBookContainerAfter,
    withRenamedBookContainer,
    withRemovedBookContainer,
    withBookStartAt,
  } from './lib/works/bookContainers';
  import type { BookContainer } from './lib/works/bookContainers';
  import { createBookContainerQueue } from './lib/works/bookContainerQueue';
  import { invalidateCorpus, loadCorpus } from './lib/data/corpusStore';
  import type { WorkCorpus } from './lib/data/corpusStore';
  import { bookChapterNumbers, chapterForEditor } from './lib/data/chapterRows';
  import { documentChapterForEditor } from './lib/data/documentChapter';
  import { loadChapterFile, awaitPendingWrites } from './lib/library/autosave';
  import { getScheme } from './lib/citation/registry';
  import type { FixtureChapter } from './dev/fixture-meta-z17';
  import { loadSettings, updateSettings } from './lib/settings';
  import { isTauri } from './lib/runtime';
  import { wordAt, latinWordAt } from './lib/lexicon/wordAt';
  import { libraryStorage, chapterFileName } from './lib/library/storage';
  import { chapterLibraryStatuses } from './lib/library/sync';
  import type { ChapterLibraryStatus } from './lib/library/sync';
  import { session, syncCommands } from './lib/editor/session.svelte';
  import { zoomIn, zoomOut, zoomReset, zoomAtMin, zoomAtMax, zoomPercent } from './lib/editor/zoom.svelte';
  import SettingsDialog from './components/SettingsDialog.svelte';

  // Built-in works from the static manifests, plus corpus-free documents
  // from the library's free-work registry (loaded at boot / after creation).
  let works = $state<WorkManifest[]>(listWorks());

  /** Document-spine work (D8): the chapter file is the spine — no corpus is
   * ever loaded for it. Capability gate, never a scheme-id comparison. */
  function isDocumentWork(work: WorkManifest): boolean {
    return getScheme(work.scheme).spineSource === 'document';
  }

  async function reloadWorks() {
    works = [...listWorks(), ...(await listFreeWorks())];
  }

  let railOpen = $state(true);
  let footnotesOpen = $state(false);
  let referenceOpen = $state(false);
  let lexiconOpen = $state(false);
  let addWorkOpen = $state(false);
  let newDocumentOpen = $state(false);
  let sourceImportOpen = $state(false);
  let settingsOpen = $state(false);
  // The document work whose organization profile the "Manage levels…" dialog
  // is editing (null = closed).
  let manageLevelsWork = $state<WorkManifest | null>(null);
  let workDetailsWork = $state<WorkManifest | null>(null);
  let importOpen = $state(false);
  let importDefaultWorkId = $state<string | undefined>(undefined);
  let referenceImportWorkId = $state<string | null>(null);
  /** Bumped after every reference import so an open panel re-reads storage. */
  let referenceReloadKey = $state(0);

  // Per-work corpus (null = not on this machine). Loaded once at startup;
  // refreshed per work after onboarding.
  let corpora = $state<Record<string, WorkCorpus | null>>({});
  let booted = $state(false);
  let selection = $state<RailSelection | null>(null);
  // Heading outline of the OPEN document-spine work (D8 heading tools), emitted
  // by the editor; drives the rail's table-of-contents. Reset on every
  // selection change so a previous doc's outline never leaks to the next.
  let docOutline = $state<OutlineItem[]>([]);
  let editorRef = $state<ReturnType<typeof ChapterEditor>>();

  // Per-work library-file status (placeholders/conflicted copies — build
  // spec §11), keyed by chapterFileName. Tauri only (mtime/listing are null
  // in the browser dev harness); refreshed at boot and on every window
  // focus so a collaborator's new/downloaded files show up promptly.
  let libraryStatus = $state<Record<string, Map<string, ChapterLibraryStatus>>>({});

  async function refreshLibraryStatus() {
    if (!isTauri()) return;
    const storage = libraryStorage();
    const entries = await Promise.all(
      works.map(async (work) => {
        const files = await storage.list(work.id);
        return [work.id, chapterLibraryStatuses(files)] as const;
      }),
    );
    libraryStatus = Object.fromEntries(entries);
  }

  const railWorks: RailWork[] = $derived(
    works.map((work) => {
      if (isDocumentWork(work)) {
        // Corpus-free document (D8): the lines marked in the text ARE its Books
        // & Chapters. The rail mirrors the live heading outline — no separate
        // container slots — so a mark and its sidebar entry can never drift.
        return {
          work,
          status: 'ready' as const,
          books: [],
          document: true,
          bookContainers: work.documentBookContainers ?? [],
          chapterContainers: work.documentChapterContainers ?? [],
        };
      }
      const corpus = corpora[work.id] ?? null;
      const statuses = libraryStatus[work.id];
      return {
        work,
        status: corpus ? ('ready' as const) : ('absent' as const),
        books: corpus
          ? work.books.map((b) => {
              const chapters = bookChapterNumbers(corpus, b.n);
              const status: Record<number, { isPlaceholder: boolean; conflictCount: number }> = {};
              if (statuses) {
                for (const chapter of chapters) {
                  const s = statuses.get(chapterFileName(b.n, chapter));
                  if (s) status[chapter] = { isPlaceholder: s.isPlaceholder, conflictCount: s.conflicts.length };
                }
              }
              return { n: b.n, label: b.label, chapters, status };
            })
          : [],
      };
    }),
  );

  const currentWork: WorkManifest | null = $derived(
    selection ? (works.find((w) => w.id === selection!.workId) ?? null) : null,
  );

  // Document-spine works have no corpus: the editor fixture is built from
  // the saved chapter file itself, read asynchronously when the selection
  // lands on such a work. Keyed so a stale read never renders under a new
  // selection.
  let docFixture = $state<FixtureChapter | null>(null);
  let docFixtureKey = $state('');
  const selectionKey = $derived(
    selection ? `${selection.workId}:${selection.book}.${selection.chapter}` : '',
  );

  $effect(() => {
    const sel = selection;
    const work = currentWork;
    const key = selectionKey;
    if (!sel || !work || !isDocumentWork(work)) return;
    let cancelled = false;
    void (async () => {
      const res = await loadChapterFile(
        libraryStorage(),
        work.id,
        chapterFileName(sel.book, sel.chapter),
      );
      if (cancelled) return;
      docFixture = res.file ? documentChapterForEditor(work, res.file) : null;
      docFixtureKey = key;
    })();
    return () => {
      cancelled = true;
    };
  });

  const currentChapter = $derived.by(() => {
    if (!selection || !currentWork) return null;
    if (isDocumentWork(currentWork)) {
      return docFixtureKey === selectionKey ? docFixture : null;
    }
    const corpus = corpora[selection.workId];
    if (!corpus) return null;
    return chapterForEditor(currentWork, corpus, selection.book, selection.chapter);
  });

  /** Breadcrumb parts: work title carries the weight, locus stays quiet. */
  const breadcrumb = $derived.by(() => {
    if (!selection || !currentWork) return { work: 'Translation Workbench', locus: null };
    if (isDocumentWork(currentWork)) {
      // A document work's locus lives in its outline, not the breadcrumb.
      return { work: currentWork.title, locus: null };
    }
    const label = currentWork.books[selection.book - 1]?.label ?? String(selection.book);
    return { work: currentWork.title, locus: `${label} · ${selection.chapter}` };
  });

  function validSelection(sel: RailSelection): boolean {
    const work = works.find((w) => w.id === sel.workId);
    if (work && isDocumentWork(work)) {
      // Marker-driven document work: one file (book 1, chapter 1); the in-text
      // marks provide the navigation, not separate chapter files.
      return sel.book === 1 && sel.chapter === 1;
    }
    const corpus = corpora[sel.workId];
    if (!corpus) return false;
    return bookChapterNumbers(corpus, sel.book).includes(sel.chapter);
  }

  /** First chapter of the first book of the first ready work (Metaphysics
   * preferred) — the first-run landing. Null when no corpus exists at all. */
  function defaultSelection(): RailSelection | null {
    const ordered = [...works].sort((a, b) =>
      a.id === 'metaphysics' ? -1 : b.id === 'metaphysics' ? 1 : 0,
    );
    for (const work of ordered) {
      const corpus = corpora[work.id];
      if (!corpus) continue;
      for (const book of work.books) {
        const chapters = bookChapterNumbers(corpus, book.n);
        if (chapters.length > 0) return { workId: work.id, book: book.n, chapter: chapters[0] };
      }
    }
    return null;
  }

  // Drive-folder sync (build spec §11): when the window regains focus, check
  // the open chapter for an external change (reload seamlessly, or prompt if
  // there are unsaved edits) and refresh the library listing so a
  // collaborator's new chapters / downloaded placeholders show up. The
  // browser dev harness has no real focus signal from another process, but
  // visibilitychange still fires on tab-switch-back, which is close enough
  // for manual testing there.
  function onWindowFocus() {
    void refreshLibraryStatus();
    void syncCommands.checkExternalChange();
  }
  function onVisibilityVisible() {
    if (document.visibilityState === 'visible') onWindowFocus();
  }

  onMount(() => {
    // Startup: load every work's corpus, then land on the last-opened chapter
    // (or book Α chapter 1 of the Metaphysics on first run).
    void (async () => {
      const settings = await loadSettings();
      await reloadWorks();
      const loaded: Record<string, WorkCorpus | null> = {};
      await Promise.all(
        works
          // Document-spine works have no corpus — never call loadCorpus for
          // them (D8; capability gate via isDocumentWork).
          .filter((work) => !isDocumentWork(work))
          .map(async (work) => {
            loaded[work.id] = await loadCorpus(work.id);
          }),
      );
      corpora = loaded;
      await refreshLibraryStatus();
      const last = settings.lastOpened;
      if (last && works.some((w) => w.id === last.workId) && validSelection(last)) {
        selection = last;
      } else {
        selection = defaultSelection();
      }
      booted = true;
    })();

    window.addEventListener('focus', onWindowFocus);
    document.addEventListener('visibilitychange', onVisibilityVisible);
    return () => {
      window.removeEventListener('focus', onWindowFocus);
      document.removeEventListener('visibilitychange', onVisibilityVisible);
    };
  });

  function select(workId: string, book: number, chapter: number) {
    // Clear the outline whenever the open locus changes so a previous chapter's
    // table of contents never lingers under a different (or empty) selection —
    // the editor re-emits it for the chapter it actually loads.
    const sel = selection;
    if (!sel || sel.workId !== workId || sel.book !== book || sel.chapter !== chapter) {
      docOutline = [];
    }
    selection = { workId, book, chapter };
    void updateSettings({ lastOpened: { workId, book, chapter } });
  }

  async function handleOnboarded(workId: string) {
    invalidateCorpus(workId);
    corpora = { ...corpora, [workId]: await loadCorpus(workId) };
  }

  function openImportDialog(workId: string) {
    importDefaultWorkId = workId;
    importOpen = true;
  }

  // ── corpus-free "New document…" (design doc D8 §6) ──────────────────────
  /** An imported work lands exactly like a created one — same registry, same
   * storage — so it opens the same way. */
  async function handleSourceImported(workId: string) {
    sourceImportOpen = false;
    await handleDocumentCreated(workId);
  }

  async function handleDocumentCreated(workId: string) {
    newDocumentOpen = false;
    await reloadWorks();
    await refreshLibraryStatus();
    select(workId, 1, 1);
  }

  function openWorkDetails(workId: string) {
    const work = works.find((candidate) => candidate.id === workId);
    workDetailsWork = work && isDocumentWork(work) ? work : null;
  }

  async function saveWorkDetails(workId: string, title: string, author: string, language: string) {
    await updateFreeWorkTitle(workId, title);
    await updateFreeWorkAuthor(workId, author);
    await updateFreeWorkLanguage(workId, language);
    await reloadWorks();
  }

  /**
   * Remove a document work: its registry entry and every file under it. The
   * rail asks before this runs.
   *
   * Closing it first is what makes the delete safe: the editor tears down, its
   * autosave flushes, and awaitPendingWrites lets the save land BEFORE the
   * folder goes — otherwise a write already on its way would recreate the file
   * a moment after it was deleted.
   */
  async function removeWork(workId: string) {
    if (selection?.workId === workId) {
      selection = null;
      docOutline = [];
      await tick();
    }
    if (workDetailsWork?.id === workId) workDetailsWork = null;
    if (manageLevelsWork?.id === workId) manageLevelsWork = null;
    await awaitPendingWrites(workId);
    await removeFreeWork(workId);
    await reloadWorks();
    await refreshLibraryStatus();
  }

  // ── Book containers (D8): organization WITHOUT touching the text ─────────
  // The workbench edits TRANSLATIONS, so a Book must never be a line in the
  // document — it is a saved boundary over the outline's root nodes. Every
  // handler below is the same shape: pure transform → persist → reload.
  // Chapters are still made by MARKING a line, in the text or in the rail.

  /** The open document work's chapter boundaries (empty when it has none). */
  const docChapterContainers = $derived(
    railWorks.find((rw) => rw.work.id === selection?.workId)?.chapterContainers ?? [],
  );

  /** The open document work's saved Books (empty when it has none). */
  const docBookContainers: BookContainer[] = $derived(
    railWorks.find((rw) => rw.work.id === selection?.workId)?.bookContainers ?? [],
  );

  /** Root outline nodes = the chapters a Book boundary can point at. */
  const docRootCount = $derived(buildOutlineTree(docOutline).length);

  // Serialized so two quick clicks can't both transform the same saved list and
  // silently drop one of the edits (bookContainerQueue.ts).
  const bookQueue = createBookContainerQueue(async (workId, containers) => {
    await updateFreeWorkBookContainers(workId, containers);
    await reloadWorks();
  });

  function editBookContainers(transform: (current: BookContainer[]) => BookContainer[]) {
    // The work is captured HERE, not when the write runs: opening another
    // document while a save is in flight must not land these Books on it.
    const workId = selection?.workId;
    if (!workId) return;
    void bookQueue.edit(workId, docBookContainers, transform);
  }

  /** Placeholder name — the user renames from the Book's right-click menu.
   * Derived from the list the transform actually sees, so two fast "+ Book"
   * clicks name themselves 1 and 2 rather than both claiming the same number. */
  const nextBookLabel = (current: BookContainer[]) => `Book ${current.length + 1}`;

  const addBookContainer = () =>
    editBookContainers((current) =>
      withAddedBookContainer(current, nextBookLabel(current), docRootCount),
    );
  const addBookContainerAfter = (index: number) =>
    editBookContainers((current) =>
      withInsertedBookContainerAfter(current, index, nextBookLabel(current), docRootCount),
    );
  const renameBookContainer = (index: number, label: string) =>
    editBookContainers((current) => withRenamedBookContainer(current, index, label));
  const removeBookContainer = (index: number) =>
    editBookContainers((current) => withRemovedBookContainer(current, index));
  const setBookStart = (index: number, rootOrdinal: number) =>
    editBookContainers((current) => withBookStartAt(current, index, rootOrdinal));

  // ── reference-translation import (design doc D5 §5) ─────────────────────
  function openReferenceImport(workId: string) {
    referenceImportWorkId = workId;
  }

  /** The dialog's work + the same book/chapter lists the rail shows. */
  const referenceImportTarget = $derived.by(() => {
    if (!referenceImportWorkId) return null;
    const work = works.find((w) => w.id === referenceImportWorkId);
    if (!work) return null;
    const books = (railWorks.find((rw) => rw.work.id === work.id)?.books ?? []).map((b) => ({
      n: b.n,
      label: b.label,
      chapters: b.chapters,
    }));
    // Default the assignment to the chapter you're currently viewing (still
    // editable) when the reference belongs to the open work — so "which
    // chapter is this for?" is answered by one sensible default.
    const sameWork = selection && selection.workId === work.id;
    return {
      work,
      books,
      defaultBook: sameWork ? selection!.book : null,
      defaultChapter: sameWork ? selection!.chapter : null,
    };
  });

  function handleReferenceImported() {
    // An open panel re-targets from storage; the dialog stays on its own
    // "Imported…" confirmation until the user dismisses it.
    referenceReloadKey += 1;
  }

  async function handleImported(workId: string, book: number, chapter: number) {
    importOpen = false;
    await refreshLibraryStatus();
    select(workId, book, chapter);
    // The import may have REPLACED the chapter that is already open. Its
    // locus hasn't changed, so the editor doesn't remount: it still holds the
    // pre-import model, and its next autosave would write that back over the
    // file just imported. This is the same check the window-focus path runs —
    // it reloads the editor from disk, or asks first when there are unsaved
    // edits. A no-op for any other chapter.
    await tick();
    await syncCommands.checkExternalChange();
  }

  function toggleRail() {
    railOpen = !railOpen;
  }
  // Footnotes and Reference share the right rail and are mutually exclusive
  // (design doc D5 §4, John-confirmed 2026-07-03): opening one closes the
  // other.
  function toggleFootnotes() {
    footnotesOpen = !footnotesOpen;
    if (footnotesOpen) referenceOpen = false;
  }
  function toggleReference() {
    referenceOpen = !referenceOpen;
    if (referenceOpen) footnotesOpen = false;
  }
  function toggleLexicon() {
    lexiconOpen = !lexiconOpen;
  }
  function closeLexicon() {
    lexiconOpen = false;
  }
  // Ask-AI panel: docked bottom panel in the center column. Open state lives on
  // the session bridge so the ctx-menu ("Ask AI about this line…") can open it
  // too; the panel follows the focused line via session.askTarget.
  function toggleAsk() {
    session.askPanelOpen = !session.askPanelOpen;
  }
  function closeAsk() {
    session.askPanelOpen = false;
  }

  // ── click-to-parse: word-click delegation over the Greek column ─────────
  //
  // The editor (lib/editor/**) is read-only from here — this listener sits
  // on the viewport container and never touches editor internals. It finds
  // the click's text offset via caretRangeFromPoint (Safari/Chrome) or
  // caretPositionFromPoint (Firefox), walks up to the nearest .grc-cell (the
  // read-only Greek spine cell — see lib/editor/GreekCell.svelte), and pulls
  // the clicked word out of that cell's own text via wordAt(). A transient
  // CSS class flashes the clicked word (removed on the next click / timeout)
  // — applied to a synthetic wrapper span injected around the exact text
  // range, then unwrapped again so the cell's plain-text contract used by
  // caretRangeFromPoint on subsequent clicks is undisturbed.
  let lexiconWord = $state<string | null>(null);

  /** Which lexicon the open work's source column belongs to. A free work
   * declares its language as free text, so anything that reads as Latin counts;
   * built-in manifests use the `original_language` field. */
  const lexiconLanguage = $derived.by<'greek' | 'latin'>(() => {
    const work = currentWork;
    if (!work) return 'greek';
    if (work.originalLanguage) return work.originalLanguage;
    return work.language?.trim().toLowerCase() === 'latin' ? 'latin' : 'greek';
  });
  let highlightTimer: ReturnType<typeof setTimeout> | undefined;

  function caretOffsetInCell(cell: HTMLElement, x: number, y: number): number | null {
    const docWithCaret = document as Document & {
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
      caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    };
    let node: Node | null = null;
    let offset = 0;
    if (docWithCaret.caretRangeFromPoint) {
      const range = docWithCaret.caretRangeFromPoint(x, y);
      if (!range) return null;
      node = range.startContainer;
      offset = range.startOffset;
    } else if (docWithCaret.caretPositionFromPoint) {
      const pos = docWithCaret.caretPositionFromPoint(x, y);
      if (!pos) return null;
      node = pos.offsetNode;
      offset = pos.offset;
    } else {
      return null;
    }
    if (!cell.contains(node)) return null;
    // Always resolve via a Range spanning from the cell's start to the click
    // point: GreekCell normally holds a single text node (where this equals
    // `offset` directly), but a still-animating flash from a PRIOR click
    // splits the cell into three siblings (text-before / .lex-word-flash
    // span / text-after) for up to 900ms — a raw `offset` would then be
    // local to whichever fragment was clicked, not the cell's full text, so
    // this must always account for preceding sibling text length.
    try {
      const full = document.createRange();
      full.selectNodeContents(cell);
      full.setEnd(node, offset);
      return full.toString().length;
    } catch {
      return null;
    }
  }

  function flashWord(cell: HTMLElement, start: number, end: number) {
    clearTimeout(highlightTimer);
    cell.querySelectorAll<HTMLElement>('.lex-word-flash').forEach((el) => {
      // Undo any previous wrap so the cell returns to a single text node.
      const parent = el.parentNode;
      if (!parent) return;
      while (el.firstChild) parent.insertBefore(el.firstChild, el);
      parent.removeChild(el);
      parent.normalize();
    });
    const textNode = [...cell.childNodes].find((n) => n.nodeType === Node.TEXT_NODE) as Text | undefined;
    if (!textNode) return;
    try {
      const range = document.createRange();
      range.setStart(textNode, start);
      range.setEnd(textNode, end);
      const wrap = document.createElement('span');
      wrap.className = 'lex-word-flash';
      range.surroundContents(wrap);
    } catch {
      return; // best-effort highlight only — never block the lookup
    }
    highlightTimer = setTimeout(() => {
      cell.querySelectorAll<HTMLElement>('.lex-word-flash').forEach((el) => {
        const parent = el.parentNode;
        if (!parent) return;
        while (el.firstChild) parent.insertBefore(el.firstChild, el);
        parent.removeChild(el);
        parent.normalize();
      });
    }, 900);
  }

  function onEditorClick(e: MouseEvent) {
    const target = e.target as HTMLElement | null;
    const cell = target?.closest<HTMLElement>('.grc-cell');
    if (!cell) return;
    const offset = caretOffsetInCell(cell, e.clientX, e.clientY);
    if (offset === null) return;
    const text = cell.textContent ?? '';
    // A Latin source cell needs its own word-boundary rule (Latin letters, no
    // elision apostrophe) — see lib/lexicon/wordAt.
    const span = (lexiconLanguage === 'latin' ? latinWordAt : wordAt)(text, offset);
    if (!span) return;
    lexiconWord = span.text;
    lexiconOpen = true;
    flashWord(cell, span.start, span.end);
  }
</script>

<div class="shell">
  <header class="topbar">
    <button
      class="icon-btn"
      onclick={toggleRail}
      title={railOpen ? 'Hide library' : 'Show library'}
      aria-label="Toggle library"
      aria-pressed={railOpen}
    >
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
        <path d="M4 6h16M4 12h16M4 18h16" />
      </svg>
    </button>

    <span class="breadcrumb">
      <span class="crumb-work">{breadcrumb.work}</span>
      {#if breadcrumb.locus}
        <span class="crumb-locus">{breadcrumb.locus}</span>
      {/if}
    </span>

    <span class="spacer"></span>

    <div class="toolbar-slot" role="toolbar" aria-label="Toolbar">
      <EditorToolbar />
    </div>

    <ExportButton work={currentWork} book={selection?.book ?? 0} chapter={selection?.chapter ?? 0} />

    <span class="tb-divider" aria-hidden="true"></span>

    <div class="panel-toggles" role="group" aria-label="Panels">
      <button
        class="icon-btn"
        class:active={footnotesOpen}
        onclick={toggleFootnotes}
        title={footnotesOpen ? 'Hide footnotes' : 'Show footnotes'}
        aria-label="Toggle footnotes panel"
        aria-pressed={footnotesOpen}
      >
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M4 4h16v12H8l-4 4V4z" />
        </svg>
      </button>

      <button
        class="icon-btn"
        class:active={referenceOpen}
        onclick={toggleReference}
        title={referenceOpen ? 'Hide reference translation' : 'Show reference translation'}
        aria-label="Toggle reference translation panel"
        aria-pressed={referenceOpen}
      >
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M2 4h6a4 4 0 0 1 4 4v12a3 3 0 0 0-3-3H2z" />
          <path d="M22 4h-6a4 4 0 0 0-4 4v12a3 3 0 0 1 3-3h7z" />
        </svg>
      </button>

      <button
        class="icon-btn"
        class:active={lexiconOpen}
        onclick={toggleLexicon}
        title={lexiconOpen ? 'Hide lexicon' : 'Show lexicon'}
        aria-label="Toggle lexicon drawer"
        aria-pressed={lexiconOpen}
      >
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
          <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
        </svg>
      </button>

      <button
        class="icon-btn"
        class:active={session.askPanelOpen}
        onclick={toggleAsk}
        title={session.askPanelOpen ? 'Hide Ask AI' : 'Ask AI about a line'}
        aria-label="Toggle Ask AI panel"
        aria-pressed={session.askPanelOpen}
      >
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          <path d="M9.5 9a2.5 2.5 0 1 1 3 2.5c-.5.2-1 .7-1 1.5" />
          <path d="M12 16.5h.01" />
        </svg>
      </button>

      <span class="tb-divider" aria-hidden="true"></span>

      <span class="zoom-group" role="group" aria-label="Text size">
        <button
          class="icon-btn zoom-step"
          onclick={zoomOut}
          disabled={zoomAtMin()}
          title="Smaller text (⌘−)"
          aria-label="Decrease text size"
        >−</button>
        <button
          class="icon-btn zoom-pct"
          onclick={zoomReset}
          title="Reset text size (⌘0)"
          aria-label="Reset text size"
        >{zoomPercent()}%</button>
        <button
          class="icon-btn zoom-step"
          onclick={zoomIn}
          disabled={zoomAtMax()}
          title="Larger text (⌘+)"
          aria-label="Increase text size"
        >+</button>
      </span>

      <span class="tb-divider" aria-hidden="true"></span>

      {#if isTauri() || import.meta.env.DEV}
        <button
          class="icon-btn"
          onclick={() => (settingsOpen = true)}
          title="Settings…"
          aria-label="Settings"
        >
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
      {/if}

      <ThemeToggle />
    </div>
  </header>

  <div class="body">
    {#if railOpen}
      <aside class="rail">
        {#if booted}
          <LibraryRail
            {railWorks}
            selected={selection}
            outline={docOutline}
            levels={currentWork?.profile?.levels ?? []}
            onOutlineSelect={(rowIndex) => editorRef?.scrollToRow(rowIndex)}
            onOutlineRename={(rowIndex, title) => editorRef?.setHeadingTitle(rowIndex, title)}
            onOutlineSetLevel={(rowIndex, level) => editorRef?.setRowLevelAt(rowIndex, level)}
            onManageLevels={(workId) => (manageLevelsWork = works.find((w) => w.id === workId) ?? null)}
            onWorkDetails={openWorkDetails}
            onWorkRemove={removeWork}
            bookContainers={docBookContainers}
            chapterContainers={docChapterContainers}
            onAddBookContainer={isTauri() || import.meta.env.DEV ? addBookContainer : undefined}
            onAddBookContainerAfter={addBookContainerAfter}
            onRenameBookContainer={renameBookContainer}
            onRemoveBookContainer={removeBookContainer}
            onSetBookStart={setBookStart}
            onSelect={select}
            onAddWork={isTauri() ? () => (addWorkOpen = true) : undefined}
            onNewDocument={isTauri() || import.meta.env.DEV ? () => (newDocumentOpen = true) : undefined}
            onImportSource={isTauri() ? () => (sourceImportOpen = true) : undefined}
            onImportChapter={isTauri() || import.meta.env.DEV ? openImportDialog : undefined}
            onImportReference={isTauri() || import.meta.env.DEV ? openReferenceImport : undefined}
          />
        {/if}
      </aside>
    {/if}

    <div class="center-col">
      <main class="editor-viewport" onclick={onEditorClick}>
        {#if !booted}
          <!-- corpus still loading; keep the viewport quiet -->
        {:else if currentChapter}
          {#key `${selection?.workId}:${selection?.book}.${selection?.chapter}`}
            <ChapterEditor
              bind:this={editorRef}
              fixture={currentChapter}
              workTitle={currentWork?.title}
              onOutline={(o) => (docOutline = o)}
            />
          {/key}
        {:else if selection}
          <div class="empty-state-wrap">
            <div class="empty-state">
              <p>This chapter isn't available.</p>
            </div>
          </div>
        {:else}
          <div class="empty-state-wrap">
            <div class="empty-state">
              <p>Nothing to work on yet.</p>
              <p class="empty-sub">Works appear in the library once their texts are on this Mac.</p>
            </div>
          </div>
        {/if}
      </main>

      {#if lexiconOpen}
        <LexiconDrawer
          workId={selection?.workId ?? ''}
          word={lexiconWord}
          language={lexiconLanguage}
          onClose={closeLexicon}
        />
      {/if}
    </div>

    {#if session.aiPanel}
      <!-- AI output (Translation Check / AI reference) takes the right slot
           while open; closing it reveals whatever tool panel was toggled. -->
      <AiPanel />
    {:else if session.askPanelOpen}
      <!-- Ask-AI chat as a tall right sidebar (John: chat reads best vertical). -->
      <AskPanel onClose={closeAsk} />
    {:else if footnotesOpen}
      <aside class="side-panel" aria-label="Footnotes">
        <header class="panel-head">
          <h2>Footnotes</h2>
          <button class="icon-btn" onclick={toggleFootnotes} aria-label="Close footnotes">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </header>
        <div class="panel-body">
          <FootnotePanel />
        </div>
      </aside>
    {:else if referenceOpen}
      <aside class="side-panel" aria-label="Reference translation">
        <ReferencePanel
          workId={selection?.workId ?? null}
          book={selection?.book ?? null}
          chapter={selection?.chapter ?? null}
          reloadKey={referenceReloadKey}
          onClose={toggleReference}
          onImport={(isTauri() || import.meta.env.DEV) && selection
            ? () => openReferenceImport(selection!.workId)
            : undefined}
        />
      </aside>
    {/if}
  </div>

  {#if addWorkOpen}
    <AddWorkDialog
      works={works.filter((w) => !isDocumentWork(w) && !corpora[w.id])}
      onClose={() => (addWorkOpen = false)}
      onOnboarded={handleOnboarded}
      onImportSource={() => (sourceImportOpen = true)}
    />
  {/if}

  {#if newDocumentOpen}
    <NewDocumentDialog
      existingIds={works.map((w) => w.id)}
      onClose={() => (newDocumentOpen = false)}
      onCreated={handleDocumentCreated}
    />
  {/if}

  {#if sourceImportOpen}
    <SourceImportDialog
      existingIds={works.map((w) => w.id)}
      onClose={() => (sourceImportOpen = false)}
      onCreated={handleSourceImported}
    />
  {/if}

  {#if manageLevelsWork}
    <ProfileDialog
      workId={manageLevelsWork.id}
      initialLevels={manageLevelsWork.profile?.levels ?? []}
      onClose={() => (manageLevelsWork = null)}
      onSaved={reloadWorks}
    />
  {/if}

  {#if workDetailsWork}
    <WorkDetailsDialog
      title={workDetailsWork.title}
      initialAuthor={workDetailsWork.author}
      initialLanguage={workDetailsWork.language ?? ''}
      onClose={() => (workDetailsWork = null)}
      onSave={(title, author, language) => saveWorkDetails(workDetailsWork!.id, title, author, language)}
    />
  {/if}

  {#if settingsOpen}
    <SettingsDialog {works} onClose={() => (settingsOpen = false)} />
  {/if}

  {#if importOpen}
    <ImportDialog
      works={works.filter((w) => corpora[w.id])}
      defaultWorkId={importDefaultWorkId}
      onClose={() => (importOpen = false)}
      onImported={handleImported}
    />
  {/if}

  {#if referenceImportTarget}
    <ReferenceImportDialog
      work={referenceImportTarget.work}
      books={referenceImportTarget.books}
      defaultBook={referenceImportTarget.defaultBook}
      defaultChapter={referenceImportTarget.defaultChapter}
      onClose={() => (referenceImportWorkId = null)}
      onImported={handleReferenceImported}
    />
  {/if}

  {#if session.externalChangePrompt}
    {@const prompt = session.externalChangePrompt}
    <div class="scrim" role="presentation">
      <div class="dialog conflict-dialog" role="alertdialog" aria-modal="true" aria-label="Chapter changed in the shared folder">
        <div class="dialog-body">
          <p class="line">
            This chapter changed in the shared folder while you were editing — keep your version or
            load theirs?
          </p>
        </div>
        <div class="dialog-actions">
          <button class="secondary-btn" onclick={prompt.onLoadTheirs}>Load theirs</button>
          <button class="primary-btn" onclick={prompt.onKeepMine}>Keep mine</button>
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .shell {
    display: flex;
    flex-direction: column;
    height: 100vh;
  }

  /* ── Top bar ──────────────────────────────────────────────────────── */
  .topbar {
    flex: none;
    display: flex;
    align-items: center;
    gap: var(--space-3);
    height: 3rem;
    padding: 0 var(--space-4);
    background: var(--col-bg);
    border-bottom: 1px solid var(--border);
  }
  .breadcrumb {
    display: inline-flex;
    align-items: baseline;
    gap: var(--space-2);
    font-family: var(--font-ui);
    font-size: 0.85rem;
    letter-spacing: 0.01em;
    white-space: nowrap;
    min-width: 0;
    overflow: hidden;
  }
  .crumb-work {
    font-weight: 600;
    color: var(--text);
  }
  .crumb-locus {
    font-weight: 400;
    font-size: 0.8rem;
    color: var(--text-mid);
    font-variant-numeric: tabular-nums;
  }
  .crumb-locus::before {
    content: '·';
    color: var(--text-light);
    margin-right: var(--space-2);
  }
  .spacer {
    flex: 1;
  }
  .toolbar-slot {
    min-width: 0;
  }

  .tb-divider {
    flex: none;
    width: 1px;
    height: 1.1rem;
    background: var(--border);
    margin: 0 var(--space-2);
  }

  .panel-toggles {
    display: flex;
    align-items: center;
    gap: var(--space-1);
  }

  /* Quiet toolbar buttons: borderless, a soft wash on hover — the native-
     toolbar treatment rather than a row of outlined web buttons. */
  .icon-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.9rem;
    height: 1.9rem;
    flex: none;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--text-mid);
    cursor: pointer;
  }
  .icon-btn:hover {
    color: var(--text);
    background: var(--ui-hover);
  }
  .icon-btn.active {
    color: var(--accent);
    background: color-mix(in srgb, var(--accent) 12%, transparent);
  }
  .icon-btn:disabled {
    opacity: 0.35;
    cursor: default;
  }
  .icon-btn:disabled:hover {
    color: var(--text-mid);
    background: transparent;
  }

  /* Text-size (zoom) control: − [percent] + */
  .zoom-group {
    display: inline-flex;
    align-items: center;
    gap: 1px;
  }
  .zoom-step {
    font-size: 1.15rem;
    line-height: 1;
    font-family: var(--font-ui);
  }
  .zoom-pct {
    width: auto;
    min-width: 3rem;
    padding: 0 var(--space-2);
    font-family: var(--font-ui);
    font-size: 0.74rem;
    font-variant-numeric: tabular-nums;
    color: var(--text-light);
  }

  /* ── Body: rail · center · side panel ────────────────────────────── */
  .body {
    flex: 1;
    display: flex;
    min-height: 0;
  }

  .rail {
    flex: none;
    width: 260px;
    min-height: 0;
    overflow-y: auto;
    background: var(--page-bg);
    border-right: 1px solid var(--border);
  }

  .center-col {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }

  .editor-viewport {
    flex: 1;
    min-height: 0;
    /* The ChapterEditor owns its own scroll container (scroll anchoring +
       settle guard need direct scrollTop control). */
    overflow: hidden;
  }

  .empty-state-wrap {
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .empty-state {
    font-family: var(--font-english);
    font-size: 1rem;
    color: var(--text-light);
    font-style: italic;
    text-align: center;
  }
  .empty-sub {
    margin-top: var(--space-2);
    font-size: 0.85rem;
  }

  .side-panel {
    flex: none;
    width: 320px;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: var(--page-bg);
    border-left: 1px solid var(--border);
  }

  /* Transient click-to-parse highlight: a synthetic wrapper span injected
     around the clicked word's exact text range inside a read-only .grc-cell
     (see onEditorClick/flashWord above). Global, not scoped — Svelte's
     scoped-style attribute is only added to elements present at compile
     time, and this span is created imperatively at runtime. */
  :global(.lex-word-flash) {
    background: var(--greek-active);
    border-radius: 2px;
    transition: background 0.6s ease-out;
  }

  .panel-head {
    flex: none;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-4);
    border-bottom: 1px solid var(--border);
  }
  .panel-head h2 {
    font-family: var(--font-ui);
    font-size: 0.8rem;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--text-mid);
  }

  .panel-body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: var(--space-4);
  }

  .placeholder-text {
    font-family: var(--font-english);
    font-size: 0.9rem;
    line-height: 1.6;
    color: var(--text-light);
  }

  /* External-change prompt (build spec §11) — same scrim/dialog skin as
     AddWorkDialog, sized for one or two lines of plain-sentence copy. */
  .scrim {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.22);
    backdrop-filter: blur(2px);
    -webkit-backdrop-filter: blur(2px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 50;
  }
  .dialog {
    width: 380px;
    max-width: calc(100vw - 2 * var(--space-4));
    background: var(--col-bg);
    border: 1px solid var(--border);
    border-radius: 10px;
    box-shadow: var(--popup-shadow);
  }
  .conflict-dialog .dialog-body {
    padding: var(--space-4);
  }
  .conflict-dialog .line {
    font-family: var(--font-english);
    font-size: 0.92rem;
    line-height: 1.55;
    color: var(--text);
  }
  .dialog-actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
    padding: 0 var(--space-4) var(--space-4);
  }
  .primary-btn {
    font-family: var(--font-ui);
    font-size: 0.85rem;
    font-weight: 500;
    color: var(--on-accent);
    background: var(--accent);
    border: 1px solid var(--accent);
    border-radius: 6px;
    padding: var(--space-2) var(--space-3);
    cursor: pointer;
  }
  .primary-btn:hover {
    filter: brightness(1.08);
  }
  .secondary-btn {
    font-family: var(--font-ui);
    font-size: 0.85rem;
    color: var(--text-mid);
    background: var(--input-bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: var(--space-2) var(--space-3);
    cursor: pointer;
  }
  .secondary-btn:hover {
    color: var(--text);
    background: var(--ui-hover);
  }
</style>
