<script module lang="ts">
  import type { AssistUiState } from './assistController';

  // What a RowEditor needs from the chapter — kept minimal so the row side
  // can later become mount-on-focus without touching this contract.
  // View identity is (row, segment, layer) — the model (Bekker-line) row
  // index, the English segment index (design doc D6), and the EDITING LAYER
  // (D8 §4): the default 'sentence' layer edits english/english2 (segment i ↔
  // sentence i); the 'para' layer edits englishPara (paragraph view, segment
  // always 0). A ChapterEditor renders exactly one layer at a time (view mode
  // is exclusive), so the two never mount simultaneously; the layer keeps
  // their view keys distinct and lets commit/undo route to the right field.
  export type EditLayer = 'sentence' | 'para';
  export interface RowViewHost {
    createView(row: number, segment: number, el: HTMLElement, layer: EditLayer): void;
    destroyView(row: number, segment: number, layer: EditLayer): void;
    // ── AI-assist (design doc D4) ──
    /** Suggest-for-row entry point (the row glyph; ⌘⏎ arrives via rowKeymap). */
    requestAssist(row: number, segment: number): void;
    /** Popover state for cell (row, segment); null unless assist targets it. Reactive. */
    assistStateFor(row: number, segment: number): AssistUiState | null;
    /** Viewport point to anchor the popover at (under the clicked word), or null
     * to fall back to the cell-anchored placement. Reactive. */
    assistAnchor(): { x: number; y: number } | null;
    /** THE one editor mutation assist may perform, surfaced to the popover
     * as RowEditor.insertSuggestion — a normal transaction on the cell's
     * view, through the same dispatch path as typing. */
    insertSuggestion(row: number, segment: number, text: string): void;
    dismissAssist(): void;
  }

  // ── document-spine addresses across a row splice (D8 §2) ────────────────
  // Pure, so the rule can be tested without a mounted editor; used by
  // spliceRows / reassignDocumentAddresses below.
  import type { Address, CitationScheme } from '../citation/types';

  /**
   * Whether a document-spine work's addresses are the SOURCE's own citations
   * ("184a.10", "205a.25,29", "1.327a") rather than the ordinals the scheme
   * derives from row position.
   *
   * This is what a row splice must ask before touching them. An ordinal names
   * a POSITION, so it has to be re-derived after every splice. A source
   * citation names a LINE OF AN EDITION: nothing can re-derive it, and
   * overwriting it with an ordinal drops the file's `row_refs` at the next
   * save (lib/library/autosave.ts `sourceRowRefs` keeps them only while the
   * addresses are not the ordinals) — and with them go the outline's chapter
   * divisions and the export's reference stamps.
   *
   * Mirrors `sourceRowRefs` exactly, so the answer here and the answer the
   * save makes can never disagree: every address must be non-empty and
   * parseable, and at least one must differ from its ordinal.
   */
  export function documentAddressesAreSource(
    scheme: CitationScheme,
    addresses: readonly string[],
    ordinalOf: (rowIndex: number) => string,
  ): boolean {
    if (addresses.length === 0) return false;
    let differs = false;
    for (let i = 0; i < addresses.length; i++) {
      const raw = addresses[i];
      if (raw === '') return false;
      try {
        scheme.parseAddress(raw);
      } catch {
        return false;
      }
      if (raw !== ordinalOf(i + 1)) differs = true;
    }
    return differs;
  }

  /**
   * The address a row spliced in at offset `k` inherits, for a work whose
   * addresses are the source's citations (see above): a split's two halves
   * both carry the split line's citation — they are two pieces of one printed
   * line — a merge keeps the first of the rows it replaced, and an insert
   * (nothing removed) takes the address of the row it displaced, or of the row
   * before it at the end of the document. Null only for an empty model.
   */
  export function inheritedSpliceAddress(
    before: readonly Address[],
    index: number,
    removeCount: number,
    k: number,
  ): Address | null {
    if (removeCount > 0) return before[index + Math.min(k, removeCount - 1)] ?? null;
    return before[index] ?? before[index - 1] ?? null;
  }
</script>

<script lang="ts">
  // ChapterEditor — owns the ChapterModel, the app-level undo stack, focus
  // state and the commit-on-idle cycle (design doc D1). One flat CSS grid for
  // the whole chapter: each row's three cells (Greek, gutter, English) are
  // siblings on the same explicit row track, so track height = max(Greek,
  // English) with zero JS.
  //
  // Line splits (design doc D6): the grid renders DISPLAY rows — expandRows
  // (gridRows.ts) expands each paragraph-split Bekker line into one grid row
  // per English segment, all sharing the line's one address. The MODEL row
  // stays the commit/autosave/undo unit; navigation (Enter/Tab/Arrows) walks
  // display rows. The split gesture is a right-click on the Greek cell
  // ("Start new paragraph here"); un-split is the explicit "Merge paragraph
  // back" command, confirm-guarded only when both English cells hold text.
  //
  // Persistence (this is user data — nothing typed may ever be silently
  // lost): on open the chapter hydrates from its saved chapter file when one
  // exists (the FILE is canonical; see lib/library/autosave.ts); every model
  // commit schedules a debounced autosave; chapter switch, window blur and
  // visibilitychange→hidden flush immediately. The saved file is written
  // through the pinned libraryStorage() contract.
  import { onMount, tick } from 'svelte';
  import { EditorState, TextSelection } from '@tiptap/pm/state';
  import type { Transaction } from '@tiptap/pm/state';
  import { EditorView } from '@tiptap/pm/view';
  import type { Node as PMNode } from '@tiptap/pm/model';
  import { toggleMark } from '@tiptap/pm/commands';

  import type { FixtureChapter } from '../../dev/fixture-meta-z17';
  import { modelFromFixture, nextFootnoteId, cloneFootnotes, displayNumbers, segmentCount, englishDocsOf, hasSentenceEnglish, hasParagraphEnglish } from './model';
  import type { ChapterModel, RowModel } from './model';
  import { rowSchema, docFromJSON, markerIdsIn, emptyRowDocJSON } from './schema';
  import { buildOutline } from './outline';
  import type { OutlineItem } from './outline';
  import type { PMDocJSON } from './schema';
  import { assertRoundTrip, buildRowDoc, runsOf, orphanFnRefIds, joinRowDocs } from './serialize';
  import type { InlineRun } from './serialize';
  import { AppHistory } from './history';
  import type { SelRef, UndoEntry, RowSnapshot, StructuralRowSnapshot } from './history';
  import { rowPlugins, isTypingTransaction } from './plugins/rowKeymap';
  import type { RowContext } from './plugins/rowKeymap';
  import { greekInput, resetGreekRun } from './plugins/greekInput';
  import { footnotePlugin, FN_REFRESH } from './plugins/footnote';
  import { session, registerEditor, unregisterEditor, setStatus } from './session.svelte';
  import { zoom, zoomIn, zoomOut, zoomReset } from './zoom.svelte';
  import type {
    EditorCommands,
    FootnoteCommands,
    FootnoteListEntry,
    SyncCommands,
    AssistCommands,
    AskResult,
    AiPanelState,
  } from './session.svelte';
  import { hasChanged, decideReload, snapshotOf } from '../library/sync';
  import type { FileSnapshot } from '../library/sync';
  import { parseChapterFile } from '../chapterfile';
  import { buildCitationClipboardText } from './copyCitation';
  import type { CitationRowInput } from './copyCitation';
  import { resolveEndpointPos } from './citationSelection';
  import { expandRows, snapToWordStart, splitUnsplitRow, mergeSegments, mergeNeedsConfirm } from './gridRows';
  import type { DisplayRow } from './gridRows';
  import {
    canEditRowStructure,
    canGroupLines,
    splitParagraphRow,
    mergeParagraphRows,
    paragraphMergeNeedsConfirm,
    addSentenceBoundary,
    joinBoundaryAt,
    addParagraphStart,
    removeParagraphStart,
  } from './rowStructure';
  import type { RowStructure } from './rowStructure';
  import { currentViewMode, setViewMode } from './viewMode.svelte';
  import { currentGranularity, setGranularity } from './viewMode.svelte';
  import { currentInterpLayout, setInterpLayout } from './viewMode.svelte';
  import type { InterpLayout } from './viewMode.svelte';
  import { legalViews } from './viewPolicy';
  import type { ViewMode, InterpolatedGranularity } from './viewPolicy';
  import { usesParaLayer, showGranularityToggle, sourceSlices, sourceOffsetAtDisplay } from './interpolated';
  import { getScheme } from '../citation/registry';
  import type { WorkMeta } from '../citation/types';
  import { isTauri } from '../runtime';
  import { libraryStorage, chapterFileName } from '../library/storage';
  import {
    createAutosave,
    loadChapterFile,
    hydrateFromFile,
    serializeModel,
    spansFromModel,
    anchoredFootnoteCount,
    documentOrdinalAddress,
  } from '../library/autosave';
  import type { AutosaveHandle, ChapterSpans, SaveState } from '../library/autosave';
  import {
    loadFootnoteIndex,
    precedingFootnoteCount,
    updateFootnoteCount,
    onFootnoteIndexChange,
  } from '../library/footnoteIndex';
  import type { BookOrder } from '../library/footnoteIndex';
  import { getWork } from '../works/manifest';
  import { loadSettings, updateSettings } from '../settings';
  import {
    AssistController,
    buildAssistContext,
    buildInsertTransaction,
    sanitizeSuggestion,
    plainRowText,
    resolveTauriAssistProvider,
  } from './assistController';
  import { buildCtxMenu } from './ctxMenu';
  import type { CtxMenuItemId, CtxMenuModel } from './ctxMenu';
  import { buildClipboardPayload } from '../assist/clipboardPayload';
  import { NO_LINE_MESSAGE, NO_PARAGRAPH_MESSAGE, GENERIC_ERROR_MESSAGE } from '../assist/messages';
  import { ClipboardProvider } from '../assist/clipboardProvider';
  import type { AssistContext, AssistProvider, AssistResult, AssistUnit } from '../assist/provider';
  import type { RunInvokeFn } from '../assist/cliProvider';
  import GreekCell from './GreekCell.svelte';
  import RowGutter from './RowGutter.svelte';
  import EnglishCell from './EnglishCell.svelte';
  import InterpolatedUnit from './InterpolatedUnit.svelte';
  import { DEFAULT_PROFILE, levelName, navRoleOf } from '../works/profile';
  import type { NavRole } from '../works/profile';
  import './editor.css';

  let {
    fixture,
    onOutline,
    workTitle,
  }: {
    fixture: FixtureChapter;
    /** Emitted whenever the heading outline changes (roles toggled or a
     * heading's translation commits). Document-spine works only carry one. */
    onOutline?: (items: OutlineItem[]) => void;
    /**
     * The work's CURRENT title. The model keeps the name the chapter loaded
     * with, and a document work's fixture is cached until the locus changes —
     * so without this a rename in Work details… showed up everywhere but the
     * one place the reader is looking.
     */
    workTitle?: string;
  } = $props();

  // ── model + non-reactive machinery ─────────────────────────────────────
  const model: ChapterModel = modelFromFixture(fixture);
  // The work's organization profile (D8 heading tools): names the heading tiers
  // shown in the "Mark as…" menu and looked up for status text. Default (two
  // in-page tiers) when the work carries none.
  // $derived so an edit to the work's organization profile (Manage levels…)
  // flows in without remounting the editor: App reloads the work, currentChapter
  // re-derives the fixture with the new profile, and this recomputes.
  const profile = $derived(fixture.profile ?? DEFAULT_PROFILE);
  const levelNames = $derived(profile.levels.map((l) => l.name));
  /** A heading row whose tier is the 'subtitle' nav-role renders as a small
   * subtitle (under its heading) rather than a big title. */
  const isSubtitleLevel = (headingLevel: number | undefined): boolean =>
    headingLevel != null && navRoleOf(profile, headingLevel) === 'subtitle';
  const history = new AppHistory();
  const storage = libraryStorage();
  const fileName = chapterFileName(fixture.book, fixture.chapter);
  // Live views keyed by (row, segment, layer) — the stable view identity (see
  // RowViewHost above); grid ordinals are never keys. Sentence-layer cells
  // keep the historical `${row}:${segment}` key (byte-for-byte the D6 key);
  // paragraph-layer cells (segment always 0) use `${row}:para`. Since only one
  // layer is mounted at a time, `viewAt` reads the ACTIVE layer's view.
  const views = new Map<string, EditorView>();
  const vkey = (row: number, segment: number, layer: EditLayer = activeLayer()) =>
    layer === 'para' ? `${row}:para` : `${row}:${segment}`;

  let rootEl = $state<HTMLDivElement>(); // the scroll container
  let gridEl = $state<HTMLDivElement>();

  let focusedRow = -1; // last MODEL row that held focus (toolbar targets it)
  let focusedSegment = 0; // …and the segment within it
  // Reactive mirror of the CURRENTLY-focused (row, segment), cleared on blur —
  // drives the focused-row whisper on the Greek + gutter cells. Needed because
  // those cells no longer sit adjacent to their English sibling in the DOM (the
  // columns are grouped so a Greek selection can't span English), so the old
  // sibling-`:has()` CSS can't reach them; the English cell keeps :focus-within.
  let focusRow = $state(-1);
  let focusSeg = $state(-1);
  let savedX: number | null = null; // goal column for cross-row Arrow moves
  let activeFn: string | null = null;
  let fnDisplay = new Map<string, number>(); // chapter-local order (1-based)
  let fnBase = 0; // work-wide offset: footnotes in all preceding chapters
  let pendingFn: { before: ReturnType<typeof cloneFootnotes>; after: ReturnType<typeof cloneFootnotes> } | null = null;
  const commitTimers = new Map<number, ReturnType<typeof setTimeout>>(); // keyed by MODEL row

  let autosave: AutosaveHandle | null = null;
  let spans: ChapterSpans = spansFromModel(model);
  let destroyed = false;

  // ── Drive-folder sync (build spec §11) ──────────────────────────────────
  // The snapshot (mtime + content hash) as of the last load or successful
  // save — what checkExternalChange() compares the live disk file against.
  // Null until initChapter() sets it (no file yet, or still loading).
  let lastSnapshot: FileSnapshot | null = null;
  let checkingExternal = false;

  // Books in manifest order for work-wide numbering; null → numeric fallback
  // (the dev fixture's workId isn't in the manifest registry yet).
  let workBooks: BookOrder = null;
  try {
    workBooks = getWork(model.workId).books;
  } catch {
    workBooks = null;
  }

  // WorkMeta for scheme.formatCitation (copy-as-citation). Prefer the real
  // manifest; fall back to a synthetic single-book WorkMeta built from the
  // model/fixture fields (same "manifest lookup can miss" case as workBooks
  // above — the dev fixture's workId isn't registered yet).
  let citationWork: WorkMeta;
  try {
    citationWork = getWork(model.workId);
  } catch {
    citationWork = {
      id: model.workId,
      title: model.workTitle,
      author: '',
      scheme: model.scheme,
      books: [{ n: model.book, label: model.bookLabel }],
    };
  }

  // Work metadata for the assist prompt (design doc D4): prefer the real
  // manifest (title/author/scheme/originalLanguage), fall back to the
  // model/fixture fields — same "manifest lookup can miss" case as
  // citationWork above. Lazy: read at request time, inside a closure.
  function assistWorkMeta(): AssistContext['work'] {
    try {
      const w = getWork(model.workId);
      return {
        title: w.title,
        author: w.author,
        originalLanguage: w.originalLanguage ?? 'greek',
        // Built-ins: an explicit label so prompt wording never guesses.
        language: w.originalLanguage === 'latin' ? 'Latin' : 'Greek',
        scheme: w.scheme,
      };
    } catch {
      return {
        title: model.workTitle,
        author: fixture.author,
        originalLanguage: 'greek',
        // Free works (and dev fixtures): the record's VERBATIM language, or
        // null = unknown — the prompts then drop the language claim instead
        // of falling back to Greek (D8 §7 Phase E2; fixes the Phase C note).
        language: fixture.language ?? null,
        scheme: model.scheme,
      };
    }
  }

  /** The source-language noun for menu descriptions ('Greek', 'German', …;
   * 'original' when unknown). Static per chapter. */
  const sourceNoun: string = (() => {
    const lang = assistWorkMeta().language;
    return lang && lang.trim().length > 0 ? lang.trim() : 'original';
  })();

  // ── reactive UI state ──────────────────────────────────────────────────
  let ready = $state(false);

  // ── view mode (D8 §5) ──────────────────────────────────────────────────
  // ViewMode string values as named constants. The paragraph view-mode string
  // collides textually with the paragraph SCHEME id, and
  // schemeIdIsolation.test.ts's grep can't tell a legitimate ViewMode
  // comparison from a forbidden scheme-id comparison (both read as
  // `=== '<that string>'`). Comparing against these constants keeps the bare
  // quoted literal out of the source while staying just as clear.
  const MODE_GRID: ViewMode = 'grid';
  const MODE_PARAGRAPH: ViewMode = 'paragraph';
  const MODE_INTERPOLATED: ViewMode = 'interpolated';
  // The work's citation scheme (capability object) — legalViews/defaultView
  // and the current-mode clamp are all keyed on it, never a scheme id.
  const scheme = getScheme(model.scheme);
  const legalViewModes = legalViews(scheme);
  // The current, validated view mode for this work (reactive store, clamped
  // to legalViews). `grid` (line grid) · `paragraph` (paragraph-unit view /
  // chunked line view) · `interpolated` (single-column stack: the English
  // field with its display-only original beneath it).
  const viewMode = $derived<ViewMode>(currentViewMode(model.workId, scheme));
  // The toggle offers every legal mode (interpolated landed this phase). It
  // appears only when more than one mode exists — a hypothetical one-mode
  // scheme shows no lone button.
  const toggleModes = legalViewModes;
  function chooseView(mode: ViewMode) {
    setViewMode(model.workId, scheme, mode);
  }
  function viewLabel(m: ViewMode): string {
    return m === MODE_GRID ? 'Lines' : m === MODE_PARAGRAPH ? 'Paragraphs' : 'Interpolated';
  }
  // Interpolated granularity for this work (D8 §5): 'unit' (one block per
  // model row) or 'sentence' (one block per sentence segment). Only
  // meaningful for paragraph-row-unit docs; the sub-toggle is offered only
  // for DOCUMENT-SPINE ones (showGranularityToggle — line docs interpolate
  // by line, their natural unit).
  const granularity = $derived<InterpolatedGranularity>(currentGranularity(model.workId));
  const granularityToggle = $derived(showGranularityToggle(scheme, viewMode));
  const GRAN_UNIT: InterpolatedGranularity = 'unit';
  const GRAN_SENTENCE: InterpolatedGranularity = 'sentence';
  function chooseGranularity(g: InterpolatedGranularity) {
    setGranularity(model.workId, g);
  }
  // Interpolated LAYOUT for line-based works (John 2026-07-14): the flowing
  // interpolated view renders the Greek as continuous prose (not one stacked
  // block per line). `lane` flows the Greek above a per-line English lane;
  // `weave` puts each line's English inline right after its own Greek. Offered
  // only for LINE docs in the interpolated view — paragraph docs keep the
  // stacked unit/sentence view + its granularity sub-toggle. The English model
  // is per-line in both, so switching to Lines still lines up.
  const interpLayout = $derived<InterpLayout>(currentInterpLayout(model.workId));
  const interpFlowing = $derived(viewMode === MODE_INTERPOLATED && !isParagraphRowUnit());
  const showLayoutToggle = $derived(interpFlowing);
  const LAYOUT_LANE: InterpLayout = 'lane';
  const LAYOUT_WEAVE: InterpLayout = 'weave';
  function chooseInterpLayout(l: InterpLayout) {
    setInterpLayout(model.workId, l);
  }
  /**
   * Display-only SHORT Bekker tick for the flowing view (John 2026-07-14 —
   * "cut out the Bekker page, just leave column and line number"): drop a
   * leading page number, keep column+line (1041a6 → a6, 1041b33 → b33). Pure
   * abbreviation of the tick label — the full opaque address is untouched in
   * the model and still shown in the Lines-view gutter. Falls back to the raw
   * address if it carries no leading page digits (nothing to trim).
   */
  function shortTick(raw: string): string {
    const short = raw.replace(/^\d+/, '');
    return short.length > 0 ? short : raw;
  }
  /** The tick label for a flowing-view line: the FIRST line of the chapter
   * keeps its full Bekker citation (page anchors the reader); every line after
   * it shows column+line only (John 2026-07-14). */
  function tickFor(raw: string, g: number): string {
    return g === 0 ? raw : shortTick(raw);
  }
  /**
   * PARA-LAYER UNIT view (usesParaLayer, interpolated.ts): a paragraph-row-
   * unit doc showing one visual unit per model row, whose English field edits
   * the paragraph layer (englishPara) — the `paragraph` view (D1 semantics
   * unchanged) or the `interpolated` view at 'unit' granularity. A plain-line
   * doc in `paragraph` mode is still line-based (grouped chunks, per-line
   * sentence cells) — NOT unit-view — so this is gated on the row unit being
   * a paragraph, never the mode alone.
   */
  const paragraphUnitView = $derived(usesParaLayer(scheme, viewMode, granularity));
  /** The row-unit test as a `switch` (not a `rowUnit ===` literal) on
   * purpose: the paragraph rowUnit string is both a GutterSpec rowUnit AND a
   * registered scheme id, and schemeIdIsolation.test.ts's source scan for
   * `=== '<id>'` can't tell the two apart by text — the switch is the
   * sanctioned way to compare a rowUnit (same pattern as viewPolicy.ts). */
  function isParagraphRowUnit(): boolean {
    switch (scheme.gutter.rowUnit) {
      case 'paragraph':
        return true;
      default:
        return false;
    }
  }
  const wrapColumns = $derived(viewMode === MODE_PARAGRAPH || isParagraphRowUnit());
  /** The editing layer the mounted cells use right now (D8 §4). Only the
   * para-layer unit views edit englishPara; every other view edits the
   * sentence layer. Non-reactive read used by vkey/viewAt (they run in plain
   * functions); paragraphUnitView is the reactive source of truth. */
  function activeLayer(): EditLayer {
    return paragraphUnitView ? 'para' : 'sentence';
  }

  // ── unit-aware assist plumbing (D8 §7 Phase E2) ─────────────────────────
  /**
   * The translation unit an assist TARGET at (row, layer) speaks in:
   * line docs → 'line' (wording unchanged — the Bekker prompt goldens stay
   * byte-identical); paragraph rows in the para layer → 'paragraph';
   * paragraph rows in the sentence layer → 'sentence' when the row IS
   * sentence-divided, else 'paragraph' (an undivided row's single cell holds
   * the whole paragraph — calling it a sentence would misdirect the model).
   */
  function assistUnitFor(layer: EditLayer, row: number): AssistUnit {
    if (!isParagraphRowUnit()) return 'line';
    if (layer === 'para') return 'paragraph';
    return segmentCount(model.rows[row]) > 1 ? 'sentence' : 'paragraph';
  }
  /** The ROW-unit noun for whole-row actions (Ask, batch translate). */
  function rowUnitNoun(): 'line' | 'paragraph' {
    return isParagraphRowUnit() ? 'paragraph' : 'line';
  }
  /** The target cell's slice of the row's source text (sentence-unit
   * targets); falls back to the whole row when the cell isn't displayed. */
  function greekSliceOf(row: number, segment: number): string {
    const g = gridOrdinalOf(row, segment);
    return displayRows[g]?.greekSlice ?? model.rows[row].greek;
  }
  /**
   * Draft English for CONTEXT row i as the given layer's view shows it: the
   * para layer reads englishPara first and falls back to the joined sentence
   * text (the read-only block under the para field — the draft the user
   * SEES); sentence-layer context stays the joined sentence docs, exactly
   * the pre-D8 behaviour.
   */
  function contextDraft(layer: EditLayer, i: number): string | null {
    if (layer === 'para') return plainRowText(paraDoc(i)) ?? plainRowText(joinedRowDoc(i));
    return plainRowText(joinedRowDoc(i));
  }

  // The flat display-row list the grid renders (design doc D6). Derived from
  // the model EXPLICITLY (the model itself is non-reactive): refreshed on
  // hydration, reload, split/un-split and structural undo/redo. In the
  // paragraph-unit view each model row is ONE display row (expandRows 'unit');
  // every other view keeps the sentence-granularity expansion.
  let displayRows = $state<DisplayRow[]>([]);
  function refreshDisplayRows() {
    displayRows = expandRows(model.rows, paragraphUnitView ? 'unit' : 'sentence');
    refreshOutline();
  }

  // Heading outline (D8 heading tools) for the rail's table-of-contents. The
  // model is non-reactive, so — like displayRows — this is refreshed
  // explicitly: on every structural change (via refreshDisplayRows) and when a
  // heading's translation commits (commitRowNow). The $effect re-emits to the
  // host whenever the array identity changes.
  let outline = $state<OutlineItem[]>([]);
  function refreshOutline() {
    outline = buildOutline(model.rows, profile);
  }
  $effect(() => {
    onOutline?.(outline);
  });
  // Recompute the outline when the work's profile changes (Manage levels…) so
  // the rail's nav-roles/labels reflect the new tiers. The model is
  // non-reactive, so this profile dependency must be wired explicitly.
  $effect(() => {
    void profile;
    refreshOutline();
  });

  /** Scroll a model row into view (rail outline click). Resolves the row to its
   * segment-0 display ordinal, then scrolls the matching grid cell. */
  export function scrollToRow(rowIndex: number): void {
    const g = displayRows.findIndex((d) => d.rowIndex === rowIndex && d.segment === 0);
    if (g < 0) return;
    const el = gridEl?.querySelector<HTMLElement>(`[data-row-en="${g}"], [data-row="${g}"]`);
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  // Flowing-view paragraph grouping (John 2026-07-14): a D6 line-split is a
  // paragraph break, so group the display rows into paragraphs — a new group
  // starts at row 0 and at every continuation segment (segment > 0). The Lane
  // view renders each group as a flowing Greek paragraph over a flowing English
  // paragraph; Weave inserts a break before each continuation pair. Each row
  // carries its global display index `g` (cell identity / focus / handlers all
  // key off it). Purely a display regrouping — the per-line model is untouched.
  const flowParagraphs = $derived.by(() => {
    const groups: { key: string; heading: boolean; rows: { d: DisplayRow; g: number }[] }[] = [];
    let prevWasHeading = false;
    displayRows.forEach((d, g) => {
      // A heading row (D8 heading tools) never flows: it is its own single-row
      // group, and the row after it opens a fresh paragraph too.
      const isHeading = !!d.headingLevel;
      if (g === 0 || d.continuation || isHeading || prevWasHeading) {
        groups.push({ key: d.key, heading: isHeading, rows: [] });
      }
      groups[groups.length - 1]?.rows.push({ d, g });
      prevWasHeading = isHeading;
    });
    return groups;
  });
  // Re-expand when the view mode OR the interpolated granularity flips (both
  // change the expansion): the keyed {#each} then remounts cells for the new
  // layer. Runs after `ready`, so the initial hydrate (which calls
  // refreshDisplayRows itself) isn't doubled.
  $effect(() => {
    void viewMode; // track
    void granularity; // track (interpolated 'unit' ⇄ 'sentence' re-expands)
    if (ready) {
      // A view/granularity switch changes the ACTIVE LAYER: cancel assist
      // work invoked under the old layer so a suggestion popover or batch
      // fill can never land against remounted cells of the other layer
      // (D8 §7 Phase E2 — writes are layer-explicit, so a stale request
      // would only no-op, but cancelling keeps the UI honest).
      dismissAssist();
      batchAbort?.abort();
      pendingBatchTranslate = null;
      refreshDisplayRows();
    }
  });
  let flashRowIdx = $state(-1); // grid ordinal
  let flashTimer: ReturnType<typeof setTimeout> | undefined;
  let greekMode = $state(false);
  let pendingPaste = $state<{ grid: number; segments: string[] } | null>(null);
  // Greek-cell context menu (design doc D6 §4): split on unsplit lines,
  // merge on split ones. `offset` is the snapped split point (null = the
  // click found no valid word gap → the status line, never a silent split).
  // D8 §2 extends the same menu with STRUCTURE editing for document-spine
  // works: `paraDoc` (paragraph-unit docs — row-level split/merge + the
  // relabelled sentence fix-up) and `chunk` (plain-line docs — paragraph
  // grouping). Both are set ONLY by the Greek/source handler under their
  // capability gates; Bekker/corpus menus never carry them.
  let ctxMenu = $state<{
    x: number;
    y: number;
    row: number;
    segment: number;
    merge: boolean;
    offset: number | null;
    aiOnly?: boolean;
    /** Unit nouns for the AI item wording (D8 §7 Phase E2): `noun` is the
     * TARGET unit of the cell-scoped modes (Translate/Reference/Check),
     * `rowNoun` the whole-row unit (Ask, batch). Line docs: both 'line'. */
    noun?: AssistUnit;
    rowNoun?: 'line' | 'paragraph';
    translateRows?: number[];
    /** Paragraph-unit document-spine rows (D8 §2/§3): row-level ops + the
     * sentence fix-up. `offset` above is the snapped click offset both split
     * gestures share; `joinBoundary` is the sentence boundary a "Join
     * sentences" would remove (null in the first sentence). */
    paraDoc?: { canMergePrev: boolean; joinBoundary: number | null };
    /** Plain-line document-spine rows (D8 §5): grouping toggle for this row. */
    chunk?: 'add' | 'remove';
    /** Heading-role toggle for document-spine source cells (D8 heading tools):
     * the clicked row's current role. Set only by the source handlers under
     * the document-spine gate; corpus menus never carry it. */
    heading?: { level: number | null; levelNames: string[] };
    /** Whether the heading group offers "Insert heading line here" (document
     * paragraph docs only — canEditRowStructure). */
    canInsertHeading?: boolean;
    /** Viewport-clamped cap on the menu's height (px): the menu grows to fit
     * or scrolls internally, never off the bottom of the window. */
    maxHeight: number;
    /** True when the "Mark as ▸" submenu must open to the LEFT (no room right). */
    submenuFlip: boolean;
    /** The rendered items — built by buildCtxMenu (ctxMenu.ts) from the
     * fields above; the template renders the model, never re-decides it. */
    model: CtxMenuModel;
  } | null>(null);
  // The open "Mark as ▸" flyout (D8 heading tools). Rendered as a SEPARATE
  // fixed element (not a child of the scrollable menu, whose overflow would
  // clip it) with JS-computed, viewport-clamped coordinates.
  let openSubmenu = $state<{ items: CtxMenuItem[]; x: number; y: number; maxHeight: number } | null>(null);
  // Close the flyout whenever the menu itself closes.
  $effect(() => {
    if (!ctxMenu) openSubmenu = null;
  });
  /** Open the "Mark as ▸" flyout beside its parent item, clamped to the window
   * (flips left when submenuFlip; never runs off top/bottom — caps + scrolls). */
  function openMarkSubmenu(e: MouseEvent, items: CtxMenuItem[]) {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const MARGIN = 8;
    const SUB_W = 200;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let x = ctxMenu?.submenuFlip ? rect.left - SUB_W : rect.right;
    x = Math.max(MARGIN, Math.min(x, vw - SUB_W - MARGIN));
    const y = Math.max(MARGIN, Math.min(rect.top - 4, vh - MARGIN - Math.min(160, vh - 2 * MARGIN)));
    const maxHeight = Math.max(120, vh - y - MARGIN);
    openSubmenu = { items, x, y, maxHeight };
  }
  /** Attach the display model to a menu state: every ctxMenu assignment
   * routes through here so items/wording/grouping have exactly one source
   * of truth (buildCtxMenu — matrix-tested in ctxMenu.test.ts). */
  /** Keep the context menu fully inside the viewport: it's position:fixed at
   * the click point (max-width 19rem). Clamp x against the CSS max-width; clamp
   * the TOP so the menu keeps a minimum visible height, and cap `maxHeight` to
   * the space from the (clamped) top to the bottom margin — the menu grows to
   * fit or scrolls internally (never off the bottom, John's screenshot).
   * `submenuFlip` says the "Mark as ▸" flyout must open LEFT (not enough room
   * to its right). */
  function clampMenu(x: number, y: number): { x: number; y: number; maxHeight: number; submenuFlip: boolean } {
    const MARGIN = 8;
    const MENU_W = 304; // 19rem max-width
    const SUBMENU_W = 200; // ~12rem flyout
    const MIN_MENU_H = 160; // keep at least a few items visible near the bottom
    const vw = typeof window !== 'undefined' ? window.innerWidth : Infinity;
    const vh = typeof window !== 'undefined' ? window.innerHeight : Infinity;
    const cx = Math.max(MARGIN, Math.min(x, vw - MENU_W - MARGIN));
    const cy = Math.max(MARGIN, Math.min(y, vh - MARGIN - Math.min(MIN_MENU_H, vh - 2 * MARGIN)));
    const maxHeight = Math.max(MIN_MENU_H, vh - cy - MARGIN);
    const submenuFlip = cx + MENU_W + SUBMENU_W > vw;
    return { x: cx, y: cy, maxHeight, submenuFlip };
  }
  function withMenuModel(m: Omit<NonNullable<typeof ctxMenu>, 'model' | 'maxHeight' | 'submenuFlip'>): NonNullable<typeof ctxMenu> {
    menuPointer = { x: m.x, y: m.y }; // raw click, before the menu clamp below
    const { x, y, maxHeight, submenuFlip } = clampMenu(m.x, m.y);
    return {
      ...m,
      x,
      y,
      maxHeight,
      submenuFlip,
      model: buildCtxMenu({
        scheme,
        paraDoc: m.paraDoc,
        aiOnly: m.aiOnly,
        chunk: m.chunk,
        heading: m.heading,
        canInsertHeading: m.canInsertHeading,
        merge: m.merge,
        batchRowCount: m.translateRows?.length ?? 1,
        noun: m.noun,
        rowNoun: m.rowNoun,
        sourceNoun,
      }),
    };
  }
  // Pending merge confirms. `pendingUnsplit` is the D6 segment un-split AND
  // the D8 sentence join (same mergeSegments machinery; `message` overrides
  // the cell dialog's D6 wording for sentence joins). `pendingParaMerge` is
  // the D8 row-level paragraph merge, confirmed only when BOTH rows carry
  // paragraph-layer English (paragraphMergeNeedsConfirm).
  let pendingUnsplit = $state<{ row: number; boundary: number; message?: string } | null>(null);
  let pendingParaMerge = $state<{ row: number } | null>(null);
  // Structural-remount window (D8 §2): TRUE from a row splice until the
  // keyed {#each} has settled (next tick). Row indices in view keys are
  // stale inside the window, so commits are suppressed — every pending
  // commit is flushed BEFORE the splice, making the model canonical.
  let structuralRemount = false;
  // Set by spliceRows from the model as it stood BEFORE the splice: true when
  // this document's addresses are the source's own citations rather than the
  // ordinals the scheme derives. Read by reassignDocumentAddresses, which runs
  // inside the same synchronous splice.
  let sourceAddressed = false;
  // Keys whose mounted view was evicted by a newer createView on the same
  // key (a keyed remount can create the new cell before the old one is
  // destroyed): the old cell's destroyView must then do nothing.
  const evictedViewKeys = new Set<string>();
  let saveState = $state<SaveState>('idle');
  let saveBlocked = $state(false);
  let loadNotice = $state<string | null>(null);

  const saveLabel = $derived(
    saveBlocked
      ? 'Autosave off'
      : saveState === 'saving'
        ? 'Saving…'
        : saveState === 'saved'
          ? 'Saved'
          : saveState === 'error'
            ? 'Save failed — will retry'
            : '',
  );

  // ── helpers ────────────────────────────────────────────────────────────
  function viewAt(row: number, segment = 0): EditorView | null {
    return views.get(vkey(row, segment)) ?? null;
  }
  function focusedView(): EditorView | null {
    return focusedRow >= 0 ? viewAt(focusedRow, focusedSegment) : null;
  }
  /** Grid ordinal of cell (row, segment); -1 when it isn't displayed. */
  function gridOrdinalOf(row: number, segment: number): number {
    return displayRows.findIndex((d) => d.rowIndex === row && d.segment === segment);
  }
  function focusedGrid(): number {
    return focusedRow >= 0 ? gridOrdinalOf(focusedRow, focusedSegment) : -1;
  }
  /** SENTENCE-layer doc of cell (row, segment): live sentence view when
   * mounted, else the committed model. The layer is EXPLICIT — never viewAt,
   * whose active-layer default would hand back the mounted PARA view for
   * every segment in a para-layer view and let paragraph text masquerade as
   * (and, via commit/undo snapshots, LEAK INTO) the sentence layer. */
  function segmentDoc(row: number, segment: number): PMNode {
    const view = views.get(vkey(row, segment, 'sentence'));
    if (view) return view.state.doc;
    const r = model.rows[row];
    return docFromJSON(segment === 0 ? r.english : (r.english2?.[segment - 1] ?? emptyRowDocJSON()));
  }
  /** The paragraph-layer (englishPara) doc for row i: live para view when
   * mounted, else the committed model field (empty when the row has none). */
  function paraDoc(i: number): PMNode {
    const view = views.get(vkey(i, 0, 'para'));
    if (view) return view.state.doc;
    return docFromJSON(model.rows[i].englishPara ?? emptyRowDocJSON());
  }
  /** All of row i's segment docs in document order (live views win). */
  function rowDocs(i: number): PMNode[] {
    return englishDocsOf(model.rows[i]).map((_, s) => segmentDoc(i, s));
  }
  function rowDocsJSON(i: number): PMDocJSON[] {
    return rowDocs(i).map((d) => d.toJSON());
  }
  /** The whole Bekker line's English as ONE doc — segments joined by the
   * app's single-space convention (d6 §7 call-site folding). */
  function joinedRowDoc(i: number): PMNode {
    return docFromJSON(joinRowDocs(rowDocsJSON(i)));
  }

  // ── paragraph-view display helpers (D8 §4/§5) ──────────────────────────
  /**
   * "Text stays at its unit" (§4): in the paragraph-unit view, when a row ALSO
   * carries a sentence-layer translation (any non-empty english/english2), it
   * is shown READ-ONLY beneath the editable englishPara field — subdued and
   * labelled — so a view switch never moves or destroys it. This is the joined
   * sentence text (marks flattened to plain text — the block is copyable
   * reference, not an editor). Null when the row has no sentence English.
   */
  function sentenceLayerText(i: number): string | null {
    if (!hasSentenceEnglish(model.rows[i])) return null;
    return plainRowText(joinedRowDoc(i));
  }

  /**
   * Read-only paragraph-layer text for row i (§4 "text stays at its unit",
   * the mirror of sentenceLayerText): in sentence-granularity interpolated
   * blocks a non-empty englishPara renders ONCE per row — above the row's
   * first sentence block — as a labelled read-only block, copyable for
   * manual distribution. Never moved or destroyed by a granularity switch.
   */
  function paraLayerText(i: number): string | null {
    if (!hasParagraphEnglish(model.rows[i])) return null;
    return plainRowText(paraDoc(i));
  }

  /**
   * Display slices of a display row's original text for the interpolated
   * view (§5): the unit view shows the WHOLE paragraph with its sentence
   * divisions (splitOffsets) as subtle separators; sentence/line blocks show
   * their own slice. Display-only (sourceSlices trims); the model text is
   * untouched.
   */
  function interpSlices(d: DisplayRow): string[] {
    if (paragraphUnitView) {
      const row = model.rows[d.rowIndex];
      return sourceSlices(row.greek, row.splitOffsets);
    }
    return sourceSlices(d.greekSlice);
  }

  /**
   * Paragraph-chunk grouping for PLAIN-LINE document-spine works (§5): the
   * display rows whose model row begins a paragraph chunk (1-based ordinals in
   * model.paragraphStarts). Pure display metadata — the doc stays line-based.
   * Row 1 always begins the first chunk. Returns a Set of grid ordinals that
   * open a chunk (used to add chunk spacing/border in the line grid).
   */
  const chunkStartGrids = $derived.by(() => {
    const starts = new Set(model.paragraphStarts ?? []);
    const out = new Set<number>();
    // Grouping applies to the line-doc chunk view (§5) and the interpolated
    // stack (§3): line docs group by paragraph_starts; a paragraph doc's
    // sentence blocks group by their paragraph row. Unit views need none —
    // every unit already IS a paragraph.
    const interp = viewMode === MODE_INTERPOLATED;
    if (paragraphUnitView || (viewMode !== MODE_PARAGRAPH && !interp)) return out;
    const perRow = interp && isParagraphRowUnit(); // sentence blocks per paragraph row
    for (let g = 0; g < displayRows.length; g++) {
      const d = displayRows[g];
      // A chunk break lands on the FIRST display row of a model row that starts
      // a paragraph (a split line's continuation segments never open a chunk).
      if (d.segment === 0 && (perRow || d.rowIndex === 0 || starts.has(d.rowIndex + 1))) out.add(g);
    }
    return out;
  });
  /** Doc size of grid cell g's ACTIVE field (rowKeymap emptiness for paste
   * distribution): the live view when mounted (the normal case — every
   * displayed cell mounts), else the active layer's committed field. */
  function gridDocSize(g: number): number {
    const d = displayRows[g];
    if (!d) return 0;
    const view = viewAt(d.rowIndex, d.segment);
    if (view) return view.state.doc.content.size;
    if (activeLayer() === 'para') {
      return docFromJSON(model.rows[d.rowIndex].englishPara ?? emptyRowDocJSON()).content.size;
    }
    return segmentDoc(d.rowIndex, d.segment).content.size;
  }
  /** The row's full structural state for an undo payload (docs + offsets +
   * the paragraph layer). englishPara is captured whenever the row has one
   * (live para view wins), so any undo/redo restores the whole row: a
   * paragraph-view edit reverts its englishPara, and a sentence edit
   * round-trips englishPara untouched (D8 §4). */
  function snapshotRow(i: number): RowSnapshot {
    const row = model.rows[i];
    const offsets = row.splitOffsets;
    const paraView = views.get(vkey(i, 0, 'para'));
    const para = paraView ? paraView.state.doc : row.englishPara ? docFromJSON(row.englishPara) : undefined;
    return {
      docs: rowDocs(i),
      ...(offsets && offsets.length > 0 ? { splitOffsets: offsets.slice() } : {}),
      ...(para && para.content.size > 0 ? { englishPara: para } : {}),
    };
  }

  // ── structural row ops: shared splice machinery (D8 §2) ────────────────
  /** A row's full STRUCTURAL state for a row-splice undo payload, read from
   * the committed MODEL (callers flush pending commits first, so the model
   * is canonical — no live-view reads with about-to-shift indices). */
  function structSnapshotOfRow(row: RowModel): StructuralRowSnapshot {
    const offsets = row.splitOffsets;
    const para = row.englishPara ? docFromJSON(row.englishPara) : undefined;
    const snap: StructuralRowSnapshot = {
      greek: row.greek,
      docs: englishDocsOf(row).map((d) => docFromJSON(d)),
      ...(offsets && offsets.length > 0 ? { splitOffsets: offsets.slice() } : {}),
      ...(para && para.content.size > 0 ? { englishPara: para } : {}),
      ...(row.headingLevel ? { headingLevel: row.headingLevel } : {}),
    };
    snapshotAddresses.set(snap, row.address);
    return snap;
  }

  /** A structural snapshot's ADDRESS. StructuralRowSnapshot deliberately
   * carries none — a document spine's addresses are its ordinals, re-derived
   * after every splice — but a source import's addresses are the source's own
   * citations, which nothing can re-derive, so undo/redo has to put back
   * exactly the address each snapshotted row had (undoing a merge otherwise
   * gives both restored rows the first one's citation). Keyed on the snapshot
   * object the history entry holds, so it dies with the entry. */
  const snapshotAddresses = new WeakMap<StructuralRowSnapshot, Address>();

  /** RowModel from a pure RowStructure result — the address is a placeholder
   * immediately re-derived by reassignDocumentAddresses after the splice. */
  function rowModelFromStruct(s: RowStructure): RowModel {
    return {
      address: { scheme: model.scheme, raw: '' },
      greek: s.greek,
      english: s.english,
      ...(s.english2 && s.english2.length > 0 ? { english2: s.english2 } : {}),
      ...(s.splitOffsets && s.splitOffsets.length > 0 ? { splitOffsets: s.splitOffsets } : {}),
      ...(s.englishPara ? { englishPara: s.englishPara } : {}),
      ...(s.headingLevel ? { headingLevel: s.headingLevel } : {}),
    };
  }

  function rowModelFromStructSnapshot(s: StructuralRowSnapshot): RowModel {
    const row = rowModelFromStruct({
      greek: s.greek,
      english: s.docs[0]?.toJSON() ?? emptyRowDocJSON(),
      ...(s.docs.length > 1 ? { english2: s.docs.slice(1).map((d) => d.toJSON()) } : {}),
      ...(s.splitOffsets && s.splitOffsets.length > 0 ? { splitOffsets: s.splitOffsets.slice() } : {}),
      ...(s.englishPara ? { englishPara: s.englishPara.toJSON() } : {}),
    });
    if (s.headingLevel) row.headingLevel = s.headingLevel;
    // Put back the snapshotted row's own address. Ordinals are re-derived
    // after the splice either way; a source citation could not be.
    const addr = snapshotAddresses.get(s);
    if (addr) row.address = { ...addr };
    return row;
  }

  /** Re-derive every row's ordinal address (¶N / N) after a splice — for
   * document-spine works the addresses ARE the ordinals (D8 §1), and nothing
   * else references them (spans/line_splits re-derive at save). */
  function reassignDocumentAddresses() {
    if (scheme.spineSource !== 'document') return;
    // …unless the addresses are the SOURCE's citations rather than ordinals
    // (a source import). Those name lines of an edition, not positions:
    // renumbering them 1, 2, 3… loses the work's row_refs at the next save,
    // and with them the outline's chapter divisions and the export's
    // reference stamps. spliceRows decided this from the PRE-splice model and
    // gave every spliced-in row its inherited address, so there is nothing
    // left to derive here.
    if (sourceAddressed) return;
    for (let i = 0; i < model.rows.length; i++) {
      model.rows[i].address = documentOrdinalAddress(scheme, i + 1);
    }
  }

  /**
   * THE row-splice primitive (split/merge/structural undo all go through
   * here). Flushes every pending commit FIRST — uncommitted text in ANY row
   * lands in the model before indices shift, so a remount can never lose a
   * keystroke — then opens the structural-remount window (commits suppressed
   * while view keys are stale; see commitRowNow) until the keyed {#each}
   * settles on the next tick.
   */
  function spliceRows(index: number, removeCount: number, newRows: RowModel[]) {
    for (const i of [...commitTimers.keys()]) commitRowNow(i);
    // Asked of the PRE-splice model: a spliced-in row carries a placeholder
    // address, so after the splice the rows can no longer answer it.
    sourceAddressed =
      scheme.spineSource === 'document' &&
      documentAddressesAreSource(
        scheme,
        model.rows.map((r) => r.address.raw),
        (n) => documentOrdinalAddress(scheme, n).raw,
      );
    if (sourceAddressed) {
      const before = model.rows.map((r) => r.address);
      for (let k = 0; k < newRows.length; k++) {
        // A row restored by undo/redo brought its own address back.
        if (newRows[k].address.raw !== '') continue;
        const inherited = inheritedSpliceAddress(before, index, removeCount, k);
        if (inherited) newRows[k].address = { ...inherited };
      }
    }
    structuralRemount = true;
    model.rows.splice(index, removeCount, ...newRows);
    reassignDocumentAddresses();
    refreshDisplayRows();
    // Ordinal addresses name a POSITION, not a row — so a shifted row keeps
    // the display key its position always had, and Svelte REUSES the mounted
    // component for what is now a DIFFERENT model row. Push every row's
    // committed content into whatever views are mounted from the splice
    // point down; keys that genuinely changed remount from the model.
    for (let i = index; i < model.rows.length; i++) refreshRowViews(i);
    void tick().then(() => {
      structuralRemount = false;
      evictedViewKeys.clear();
    });
  }

  /** Push model row i's committed docs into whatever views are mounted at
   * its EXACT (row, segment, layer) keys — the survivors of a splice whose
   * keys didn't change but whose content did (e.g. the kept row of a merge).
   * No-ops on identical docs so an untouched surviving cell keeps its
   * selection. */
  function refreshRowViews(i: number) {
    const row = model.rows[i];
    if (!row) return;
    const docs = englishDocsOf(row);
    for (let s = 0; s < docs.length; s++) {
      const view = views.get(vkey(i, s, 'sentence'));
      if (!view) continue;
      const doc = docFromJSON(docs[s]);
      if (view.state.doc.eq(doc)) continue;
      view.dispatch(
        view.state.tr
          .replaceWith(0, view.state.doc.content.size, doc.content)
          .setMeta('appHistoryIgnore', true)
          .setMeta(FN_REFRESH, true),
      );
    }
    const paraView = views.get(vkey(i, 0, 'para'));
    if (paraView) {
      const doc = docFromJSON(row.englishPara ?? emptyRowDocJSON());
      if (!paraView.state.doc.eq(doc)) {
        paraView.dispatch(
          paraView.state.tr
            .replaceWith(0, paraView.state.doc.content.size, doc.content)
            .setMeta('appHistoryIgnore', true),
        );
      }
    }
  }

  function selRefOf(row: number, segment: number, state: EditorState): SelRef {
    return { row, segment, anchor: state.selection.anchor, head: state.selection.head };
  }

  function focusedSelRef(): SelRef | null {
    const view = focusedView();
    if (!view || focusedRow < 0) return null;
    // The focused view is the ACTIVE layer's (viewAt) — record that layer so
    // an undo from a paragraph-unit view refocuses the para cell, not a
    // sentence cell that isn't mounted there (D8 §4).
    return { ...selRefOf(focusedRow, focusedSegment, view.state), layer: activeLayer() };
  }

  function flash(g: number) {
    flashRowIdx = -1;
    clearTimeout(flashTimer);
    // Re-set on the next frame so a repeated flash restarts the animation.
    requestAnimationFrame(() => {
      flashRowIdx = g;
      flashTimer = setTimeout(() => (flashRowIdx = -1), 400);
    });
  }

  function syncToolbar(state: EditorState) {
    const marks = { bold: false, italic: false, underline: false, greek: false };
    const { from, to, empty } = state.selection;
    const fromResolved = state.selection.$from;
    for (const name of ['bold', 'italic', 'underline', 'greek'] as const) {
      const type = rowSchema.marks[name];
      if (empty) {
        marks[name] = !!type.isInSet(state.storedMarks ?? fromResolved.marks());
      } else {
        marks[name] = state.doc.rangeHasMark(from, to, type);
      }
    }
    session.activeMarks = marks;
  }

  // ── persistence: dirty tracking + commit-to-model (blur / ~400ms idle) ──
  function markModelDirty() {
    model.dirty = true;
    autosave?.markDirty();
  }

  /** Commit MODEL ROW i — every mounted segment view's doc lands in
   * english/english2[k] (the model row is the commit unit, design doc D6). */
  function commitRowNow(i: number, changed = false) {
    // Inside a structural-remount window every view key may point at a
    // SHIFTED row (D8 §2) — committing would write one row's text into
    // another. All pending commits were flushed before the splice, so the
    // model is already canonical; skip (blur/unmount commits included).
    if (structuralRemount) return;
    const row = model.rows[i];
    if (!row) return;
    const count = segmentCount(row);
    // Ingest DOM mutations ProseMirror hasn't observed yet (its DOMObserver
    // batches the tail of a typing burst for ~20ms). Without this, a commit
    // fired by an instant chapter-switch/blur could read a stale doc and drop
    // the last keystrokes. This may dispatch (and schedule a commit timer),
    // so it runs BEFORE the timer check. domObserver is internal but stable.
    // The paragraph-layer view (englishPara) is flushed/committed alongside
    // the sentence segments — a row mounts at most one layer at a time
    // (D8 §4). Both loops address their layer's views EXPLICITLY (never
    // viewAt, whose active-layer default would resolve every sentence
    // segment to the mounted para view in a para-layer view and commit the
    // paragraph text into english/english2 — cross-layer corruption).
    const paraView = views.get(vkey(i, 0, 'para'));
    for (let s = 0; s < count; s++) {
      const view = views.get(vkey(i, s, 'sentence'));
      if (view) (view as unknown as { domObserver?: { flush?: () => void } }).domObserver?.flush?.();
    }
    if (paraView) (paraView as unknown as { domObserver?: { flush?: () => void } }).domObserver?.flush?.();
    const timer = commitTimers.get(i);
    if (timer !== undefined) {
      clearTimeout(timer);
      commitTimers.delete(i);
      changed = true; // a scheduled commit only ever follows a doc change
    }
    let sawView = false;
    for (let s = 0; s < count; s++) {
      const view = views.get(vkey(i, s, 'sentence'));
      if (!view) continue;
      sawView = true;
      const doc = view.state.doc;
      if (s === 0) row.english = doc.toJSON();
      else row.english2![s - 1] = doc.toJSON();
      if (import.meta.env.DEV) assertRoundTrip(doc); // round-trip asserted on every commit
    }
    if (paraView) {
      sawView = true;
      const doc = paraView.state.doc;
      // Empty englishPara is absent, not an empty doc — keeps files that never
      // used the paragraph layer byte-identical (chapterfile omits blank rows).
      if (doc.content.size > 0) row.englishPara = doc.toJSON();
      else delete row.englishPara;
      if (import.meta.env.DEV) assertRoundTrip(doc);
    }
    if (!sawView) return;
    history.breakCoalescing();
    if (changed) {
      markModelDirty();
      publishFootnotes(); // anchored-phrase snippets follow the text
      // A heading's translation just changed → refresh its rail-outline label.
      if (row.headingLevel) refreshOutline();
    }
  }

  function scheduleCommit(i: number) {
    clearTimeout(commitTimers.get(i));
    commitTimers.set(
      i,
      setTimeout(() => commitRowNow(i), 400),
    );
  }

  /** Commit anything pending and save NOW (chapter switch / blur / hidden). */
  function flushPending() {
    for (const i of [...commitTimers.keys()]) commitRowNow(i);
    void autosave?.flush();
  }

  // ── chapter open: hydrate from the saved file (the file is canonical) ───
  async function initChapter() {
    const res = await loadChapterFile(storage, model.workId, fileName);
    if (destroyed) return;

    let fresh = false;
    if (res.error) {
      // A file EXISTS but can't be parsed. Never autosave over it — that
      // could destroy the very data that made it unreadable.
      saveBlocked = true;
      loadNotice = 'Saved chapter file could not be read — autosave is off so it won’t be overwritten.';
      console.error(`chapter load: ${fileName}: ${res.error}`);
    } else if (res.file) {
      const h = hydrateFromFile(res.file, fixture.lines, model.scheme);
      model.rows = h.rows;
      model.footnotes = h.footnotes;
      model.paragraphStarts = h.paragraphStarts;
      spans = h.spans;
      loadNotice = h.notice;
    } else {
      fresh = true;
    }

    try {
      const index = await loadFootnoteIndex(storage, model.workId);
      fnBase = precedingFootnoteCount(index, workBooks, model.book, model.chapter);
    } catch {
      /* regenerable cache — numbering self-heals on next save */
    }
    if (destroyed) return;

    refreshDisplayRows();
    fnDisplay = displayNumbers(model.rows.flatMap((_, i) => rowDocs(i).flatMap((d) => markerIdsIn(d))));

    if (!saveBlocked) {
      autosave = createAutosave({
        workId: model.workId,
        fileName,
        storage,
        snapshot: () => serializeModel(model, spans),
        onState: (s) => {
          if (!destroyed) saveState = s;
        },
        onSaved: () => {
          void updateFootnoteCount(storage, model.workId, model.book, model.chapter, anchoredFootnoteCount(model));
          void refreshSnapshot(); // our own save moved the file — track its new state
        },
      });
      if (fresh) {
        // Write the initial file immediately so it exists from first open.
        autosave.markDirty();
        void autosave.flush();
      }
    }

    await refreshSnapshot();

    ready = true;
    await tick();
    publishFootnotes();
    requestAnimationFrame(() => focusRowEnd(0));
  }

  /** Re-read the file's current mtime + content as the sync baseline (called
   * after load and after every successful save — see initChapter/onSaved). */
  async function refreshSnapshot(): Promise<void> {
    try {
      const [mtime, content] = await Promise.all([
        storage.mtime(model.workId, fileName),
        storage.read(model.workId, fileName),
      ]);
      if (destroyed) return;
      lastSnapshot = snapshotOf(mtime, content ?? '');
    } catch {
      /* best-effort baseline only; a failed stat just means the next check
         re-tries from whatever lastSnapshot already holds */
    }
  }

  /** Drive-folder sync check (build spec §11): called on window focus. Stats
   * the open chapter's file; reloads seamlessly, prompts, or no-ops per the
   * decision matrix. Never runs concurrently with itself. */
  async function checkExternalChange(): Promise<void> {
    if (checkingExternal || destroyed || !ready || saveBlocked || !lastSnapshot) return;
    checkingExternal = true;
    try {
      const [mtime, content] = await Promise.all([
        storage.mtime(model.workId, fileName),
        storage.read(model.workId, fileName),
      ]);
      if (destroyed || content === null) return;
      const changed = hasChanged(lastSnapshot, mtime, content);
      const decision = decideReload(changed, model.dirty);
      if (decision.kind === 'none') return;

      if (decision.kind === 'reload-seamless') {
        reloadFromDisk(content, mtime);
        setStatus('Updated from the shared folder.');
        return;
      }

      // decision.kind === 'ask' — do not clobber either side.
      session.externalChangePrompt = {
        onKeepMine: () => {
          session.externalChangePrompt = null;
          // Local edits win: mark dirty so the next autosave overwrites the
          // incoming version, and adopt the disk snapshot so we don't keep
          // re-prompting for the same external change.
          lastSnapshot = snapshotOf(mtime, content);
          markModelDirty();
        },
        onLoadTheirs: () => {
          session.externalChangePrompt = null;
          reloadFromDisk(content, mtime);
        },
      };
    } finally {
      checkingExternal = false;
    }
  }

  /** Discard whatever's live and re-hydrate the model from `content` (the
   * file just read off disk). Used by both the seamless path and "Load
   * theirs". Clears any pending commit timers first so a stale scheduled
   * commit can't stomp the freshly loaded rows a moment later. */
  function reloadFromDisk(content: string, mtime: number | null) {
    for (const timer of commitTimers.values()) clearTimeout(timer);
    commitTimers.clear();

    let parsed: ReturnType<typeof parseChapterFile> | null = null;
    try {
      parsed = parseChapterFile(content, fileName);
    } catch (err) {
      console.error(`sync reload: ${fileName} failed to parse`, err);
      setStatus("The shared folder's version of this chapter couldn't be read.");
      return;
    }
    const h = hydrateFromFile(parsed, fixture.lines, model.scheme);
    model.rows = h.rows;
    model.footnotes = h.footnotes;
    model.paragraphStarts = h.paragraphStarts;
    model.dirty = false;
    spans = h.spans;
    loadNotice = h.notice;
    lastSnapshot = snapshotOf(mtime, content);

    // Rebuild every cell view that still exists in the reloaded model
    // (mirrors applyEntry's replaceWith for the undo/redo path). Cells whose
    // row/segment vanished (row-count drift, un-split in the incoming file)
    // fall through to the keyed {#each} remount below — their components
    // unmount and destroyView skips the stale commit.
    for (const [key, view] of views) {
      const [rStr, sStr] = key.split(':');
      const r = Number(rStr);
      if (r >= model.rows.length) continue;
      const row = model.rows[r];
      // A paragraph-layer view keys as `${row}:para` (D8 §4) — refresh it
      // from englishPara, never from the sentence fields (and never let
      // Number('para') = NaN slip past the segment guard below).
      if (sStr === 'para') {
        view.dispatch(
          view.state.tr
            .replaceWith(0, view.state.doc.content.size, docFromJSON(row.englishPara ?? emptyRowDocJSON()).content)
            .setMeta('appHistoryIgnore', true),
        );
        continue;
      }
      const s = Number(sStr);
      if (s >= segmentCount(row)) continue;
      const newDoc = docFromJSON(s === 0 ? row.english : row.english2![s - 1]);
      view.dispatch(
        view.state.tr
          .replaceWith(0, view.state.doc.content.size, newDoc.content)
          .setMeta('appHistoryIgnore', true)
          .setMeta(FN_REFRESH, true),
      );
    }
    refreshDisplayRows();
    fnDisplay = displayNumbers(model.rows.flatMap((_, i) => rowDocs(i).flatMap((d) => markerIdsIn(d))));
    history.clear();
    refreshFnDisplay();
  }

  // ── footnote bookkeeping (model side; the plugin is view-only) ─────────
  function refreshFnDisplay() {
    const order: string[] = [];
    for (let i = 0; i < model.rows.length; i++) {
      // Segments walked in document order — a marker can live in a
      // continuation segment of a split row (design doc D6).
      for (const doc of rowDocs(i)) order.push(...markerIdsIn(doc));
    }
    fnDisplay = displayNumbers(order);
    for (const view of views.values()) {
      view.dispatch(view.state.tr.setMeta(FN_REFRESH, true).setMeta('appHistoryIgnore', true));
    }
    publishFootnotes();
  }

  function setActiveFootnote(id: string | null) {
    activeFn = id;
    session.activeFootnoteId = id;
    for (const view of views.values()) {
      view.dispatch(view.state.tr.setMeta(FN_REFRESH, true).setMeta('appHistoryIgnore', true));
    }
  }

  /** Work-wide display number for a chapter-local id (plugin + panel). */
  function fnDisplayNumber(id: string): number | undefined {
    const local = fnDisplay.get(id);
    return local === undefined ? undefined : fnBase + local;
  }

  /** Publish the panel's view of this chapter's footnotes (document order). */
  function publishFootnotes() {
    const phrases = new Map<string, string>();
    const markerRow = new Map<string, number>();
    const order: string[] = [];
    for (let i = 0; i < model.rows.length; i++) {
      for (const doc of rowDocs(i)) {
        for (const run of runsOf(doc)) {
          if (run.kind === 'marker') {
            if (!markerRow.has(run.id)) {
              markerRow.set(run.id, i);
              order.push(run.id);
            }
          } else if (run.marks.fnRef !== undefined) {
            phrases.set(run.marks.fnRef, (phrases.get(run.marks.fnRef) ?? '') + run.text);
          }
        }
      }
    }
    const entries: FootnoteListEntry[] = [];
    for (const id of order) {
      const fn = model.footnotes.find((f) => f.id === id);
      entries.push({
        id,
        displayNumber: fnDisplayNumber(id) ?? null,
        snippet: phrases.get(id) ?? '',
        body: fn?.body ?? '',
        anchored: true,
        row: markerRow.get(id) ?? null,
      });
    }
    for (const fn of model.footnotes) {
      if (markerRow.has(fn.id)) continue;
      entries.push({ id: fn.id, displayNumber: null, snippet: '', body: fn.body, anchored: false, row: null });
    }
    session.footnotes = entries;
  }

  /** Re-read the per-work index (another chapter's count changed). */
  async function reloadFnBase() {
    try {
      const index = await loadFootnoteIndex(storage, model.workId);
      const next = precedingFootnoteCount(index, workBooks, model.book, model.chapter);
      if (!destroyed && next !== fnBase) {
        fnBase = next;
        refreshFnDisplay();
      }
    } catch {
      /* keep the current base */
    }
  }

  // ── the dispatch pipeline ──────────────────────────────────────────────
  function dispatchFor(row: number, segment: number, layer: EditLayer = 'sentence') {
    return (tr: Transaction) => {
      const view = layer === 'para' ? (views.get(vkey(row, 0, 'para')) ?? null) : viewAt(row, segment);
      if (!view) return;
      const oldState = view.state;
      const newState = oldState.apply(tr);
      view.updateState(newState);

      if (tr.docChanged && !tr.getMeta('appHistoryIgnore')) {
        savedX = null;
        if (layer === 'para') afterParaChange(row, oldState, tr);
        else afterDocChange(row, segment, oldState, tr);
        scheduleCommit(row);
      }
      if (view.hasFocus() || (focusedRow === row && focusedSegment === segment)) syncToolbar(view.state);
    };
  }

  /** Undo bookkeeping for a paragraph-layer (englishPara) edit (D8 §4): the
   * sentence `docs` are unchanged in this entry — only `englishPara` differs
   * before→after. The whole row snapshot round-trips so one ⌘Z reverts the
   * paragraph edit and nothing else. Footnotes don't ride the paragraph layer
   * (englishPara carries no markers in Phase D), so no fnBefore/fnAfter. */
  function afterParaChange(row: number, oldState: EditorState, tr: Transaction) {
    const view = views.get(vkey(row, 0, 'para'))!;
    const beforeDoc = oldState.doc;
    const afterDoc = view.state.doc;
    const offsets = model.rows[row].splitOffsets;
    const docs = rowDocs(row); // sentence layer, unchanged by a para edit
    const structural = {
      docs,
      ...(offsets && offsets.length > 0 ? { splitOffsets: offsets.slice() } : {}),
    };
    const coalesceKey =
      !tr.getMeta('noCoalesce') && (tr.getMeta('coalesce') === 'typing' || isTypingTransaction(tr))
        ? `typing:${row}.para`
        : null;
    history.push(
      {
        edits: [
          {
            row,
            before: { ...structural, ...(beforeDoc.content.size > 0 ? { englishPara: beforeDoc } : {}) },
            after: { ...structural, ...(afterDoc.content.size > 0 ? { englishPara: afterDoc } : {}) },
          },
        ],
        selBefore: { row, segment: 0, layer: 'para', anchor: oldState.selection.anchor, head: oldState.selection.head },
        selAfter: { row, segment: 0, layer: 'para', anchor: view.state.selection.anchor, head: view.state.selection.head },
      },
      { coalesceKey },
    );
  }

  function afterDocChange(row: number, segment: number, oldState: EditorState, tr: Transaction) {
    const view = viewAt(row, segment)!;
    const beforeDoc = oldState.doc;

    // Footnote invariant upkeep: markers deleted by this edit unanchor their
    // footnotes; fnRef runs whose marker is gone lose the mark (see
    // serialize.ts header — orphaned anchors are unrepresentable).
    const beforeIds = markerIdsIn(beforeDoc);
    const afterIds = new Set(markerIdsIn(view.state.doc));
    const removed = beforeIds.filter((id) => !afterIds.has(id));

    let fnBefore = pendingFn?.before;
    let fnAfter = pendingFn?.after;
    pendingFn = null;

    if (removed.length > 0) {
      fnBefore ??= cloneFootnotes(model.footnotes);
      for (const id of removed) {
        const fn = model.footnotes.find((f) => f.id === id);
        if (fn) fn.anchored = false;
        if (activeFn === id) setActiveFootnote(null);
      }
      fnAfter = cloneFootnotes(model.footnotes);
      setStatus(removed.length === 1 ? 'Footnote unanchored — body kept in the footnote table' : `${removed.length} footnotes unanchored — bodies kept`);
    }

    const orphans = orphanFnRefIds(view.state.doc);
    if (orphans.length > 0) {
      const cleanup = view.state.tr;
      view.state.doc.descendants((node, pos) => {
        if (!node.isText) return true;
        const mark = node.marks.find((m) => m.type === rowSchema.marks.fnRef && orphans.includes(String(m.attrs.id)));
        if (mark) cleanup.removeMark(pos, pos + node.nodeSize, mark);
        return true;
      });
      cleanup.setMeta('appHistoryIgnore', true);
      view.dispatch(cleanup);
    }

    const afterDoc = view.state.doc;
    const coalesceKey =
      !tr.getMeta('noCoalesce') && (tr.getMeta('coalesce') === 'typing' || isTypingTransaction(tr))
        ? `typing:${row}.${segment}`
        : null;

    // Undo payload = the row's SEGMENT BUNDLE (design doc D6): the edited
    // segment's before/after doc plus the sibling segments as they stand. The
    // paragraph layer (englishPara) is unchanged by a sentence edit but rides
    // BOTH snapshots so undo/redo round-trips it untouched (D8 §4).
    const offsets = model.rows[row].splitOffsets;
    const beforeDocs = rowDocs(row);
    beforeDocs[segment] = beforeDoc;
    const afterDocs = rowDocs(row); // segment's view already holds afterDoc
    const paraDocJSON = model.rows[row].englishPara;
    const para = paraDocJSON ? docFromJSON(paraDocJSON) : undefined;
    const paraField = para && para.content.size > 0 ? { englishPara: para } : {};

    history.push(
      {
        edits: [
          {
            row,
            before: { docs: beforeDocs, ...(offsets ? { splitOffsets: offsets.slice() } : {}), ...paraField },
            after: { docs: afterDocs, ...(offsets ? { splitOffsets: offsets.slice() } : {}), ...paraField },
          },
        ],
        fnBefore,
        fnAfter,
        selBefore: selRefOf(row, segment, oldState),
        selAfter: selRefOf(row, segment, view.state),
      },
      { coalesceKey },
    );

    if (removed.length > 0 || markerIdsIn(afterDoc).length !== beforeIds.length) refreshFnDisplay();
  }

  // ── undo/redo ──────────────────────────────────────────────────────────
  /** Row-splice undo/redo (D8 §2): replace the spliced span with the
   * captured row snapshots, re-derive ordinal addresses (spliceRows),
   * refresh surviving views in place, and restore focus once the keyed
   * remount settles. */
  function applyStructuralEntry(entry: UndoEntry, dir: 'undo' | 'redo') {
    const s = entry.structural!;
    const snaps = dir === 'undo' ? s.before : s.after;
    const removeCount = dir === 'undo' ? s.after.length : s.before.length;
    withScrollAnchor(gridOrdinalOf(s.index, 0), () => {
      spliceRows(s.index, removeCount, snaps.map(rowModelFromStructSnapshot));
      history.breakCoalescing();
      markModelDirty();
      const sel = dir === 'undo' ? entry.selBefore : entry.selAfter;
      void tick().then(() => {
        refreshFnDisplay();
        if (sel) focusSel(sel);
      });
    });
  }

  function applyEntry(entry: UndoEntry, dir: 'undo' | 'redo') {
    if (entry.structural) {
      applyStructuralEntry(entry, dir);
      return;
    }
    const firstRow = entry.edits[0]?.row ?? focusedRow;
    withScrollAnchor(firstRow >= 0 ? gridOrdinalOf(firstRow, 0) : -1, () => {
      for (const edit of entry.edits) {
        const snap = dir === 'undo' ? edit.before : edit.after;
        const row = model.rows[edit.row];
        if (!row) continue;
        // Restore the row's structural state (docs + offsets) — one ⌘Z fully
        // reverses a split/un-split (design doc D6).
        row.english = snap.docs[0].toJSON();
        if (snap.docs.length > 1) row.english2 = snap.docs.slice(1).map((d) => d.toJSON());
        else delete row.english2;
        if (snap.splitOffsets && snap.splitOffsets.length > 0) row.splitOffsets = snap.splitOffsets.slice();
        else delete row.splitOffsets;
        // Restore the paragraph layer (D8 §4): a para-view undo reverts
        // englishPara; a sentence undo round-trips it (the snapshot carries
        // the unchanged doc), so this always reflects the snapshot exactly.
        if (snap.englishPara && snap.englishPara.content.size > 0) row.englishPara = snap.englishPara.toJSON();
        else delete row.englishPara;
        // Refresh surviving mounted views by their EXACT (row, segment, layer)
        // key — never viewAt, whose active-layer resolution would push a
        // sentence doc into a mounted para view (or vice versa). Vanished/new
        // cells remount via the keyed {#each} after refreshDisplayRows below.
        for (let s = 0; s < snap.docs.length; s++) {
          const view = views.get(vkey(edit.row, s, 'sentence'));
          if (!view) continue;
          view.dispatch(
            view.state.tr
              .replaceWith(0, view.state.doc.content.size, snap.docs[s].content)
              .setMeta('appHistoryIgnore', true)
              .setMeta(FN_REFRESH, true),
          );
        }
        const paraView = views.get(vkey(edit.row, 0, 'para'));
        if (paraView) {
          const content = (snap.englishPara ?? docFromJSON(emptyRowDocJSON())).content;
          paraView.dispatch(
            paraView.state.tr
              .replaceWith(0, paraView.state.doc.content.size, content)
              .setMeta('appHistoryIgnore', true),
          );
        }
        markModelDirty();
      }
      history.breakCoalescing();
      // paragraph_starts grouping (D8 §5) rides the entry like the footnote
      // table: restore the captured list, then re-derive the chunk display.
      if (entry.paraStarts) {
        const starts = dir === 'undo' ? entry.paraStarts.before : entry.paraStarts.after;
        model.paragraphStarts = starts.length > 0 ? starts.slice() : undefined;
        markModelDirty();
      }
      // Heading mark (D8 heading tools): restore the row's headingLevel; the
      // refreshDisplayRows below re-renders the title + rail outline.
      if (entry.headingLevel) {
        const hl = dir === 'undo' ? entry.headingLevel.before : entry.headingLevel.after;
        const row = model.rows[entry.headingLevel.row];
        if (row) {
          row.headingLevel = hl === null ? undefined : hl;
          markModelDirty();
        }
      }
      // Heading title override (D8 heading tools): restore the row's headingTitle;
      // refreshDisplayRows re-derives the rail outline label.
      if (entry.headingTitle) {
        const t = dir === 'undo' ? entry.headingTitle.before : entry.headingTitle.after;
        const row = model.rows[entry.headingTitle.row];
        if (row) {
          row.headingTitle = t === null ? undefined : t;
          markModelDirty();
        }
      }
      refreshDisplayRows();
      const fnTable = dir === 'undo' ? entry.fnBefore : entry.fnAfter;
      if (fnTable) {
        model.footnotes = cloneFootnotes(fnTable);
        markModelDirty();
      }
      refreshFnDisplay();
      const sel = dir === 'undo' ? entry.selBefore : entry.selAfter;
      // tick(): a structural undo/redo may mount the target segment's view
      // on the next flush — focus once it exists.
      if (sel) void tick().then(() => focusSel(sel));
    });
  }

  function undo() {
    const entry = history.undo();
    if (!entry) {
      setStatus('Nothing to undo');
      return;
    }
    applyEntry(entry, 'undo');
  }

  function redo() {
    const entry = history.redo();
    if (!entry) {
      setStatus('Nothing to redo');
      return;
    }
    applyEntry(entry, 'redo');
  }

  function focusSel(sel: SelRef) {
    // Layer-EXPLICIT lookup (D8 §4): a sentence-layer SelRef must never
    // focus a mounted para view (viewAt resolves through the ACTIVE layer);
    // if the recorded layer's view isn't mounted in the current view mode,
    // the focus restore is a quiet no-op.
    const view =
      sel.layer === 'para'
        ? (views.get(vkey(sel.row, 0, 'para')) ?? null)
        : (views.get(vkey(sel.row, sel.segment, 'sentence')) ?? null);
    if (!view) return;
    const size = view.state.doc.content.size;
    const anchor = Math.min(sel.anchor, size);
    const head = Math.min(sel.head, size);
    view.focus();
    view.dispatch(
      view.state.tr
        .setSelection(TextSelection.create(view.state.doc, anchor, head))
        .scrollIntoView()
        .setMeta('appHistoryIgnore', true),
    );
    focusedRow = sel.row;
    focusedSegment = sel.segment;
  }

  // ── scroll anchoring (design doc D1 §"Height sync") ────────────────────
  function withScrollAnchor(grid: number, fn: () => void) {
    const cellEl = grid >= 0 ? gridEl?.querySelector<HTMLElement>(`[data-row-en="${grid}"]`) : null;
    const before = cellEl?.getBoundingClientRect().top ?? null;
    fn();
    if (before === null || !cellEl) return;
    requestAnimationFrame(() => {
      const after = cellEl.getBoundingClientRect().top;
      const delta = after - before;
      if (delta !== 0 && rootEl) rootEl.scrollTop += delta;
    });
  }

  // ── focus / navigation (grid ordinals — display rows, design doc D6) ───
  function focusGridSel(g: number, pos: 'start' | 'end') {
    const d = displayRows[g];
    if (!d) return;
    const view = viewAt(d.rowIndex, d.segment);
    if (!view) return;
    view.focus();
    const target = pos === 'end' ? view.state.doc.content.size : 0;
    view.dispatch(
      view.state.tr
        .setSelection(TextSelection.create(view.state.doc, target))
        .scrollIntoView()
        .setMeta('appHistoryIgnore', true),
    );
    focusedRow = d.rowIndex;
    focusedSegment = d.segment;
  }

  function focusRowEnd(g: number) {
    focusGridSel(g, 'end');
  }

  function focusRowStart(g: number) {
    focusGridSel(g, 'start');
  }

  function focusRowAtX(g: number, edge: 'first' | 'last', x: number) {
    const d = displayRows[g];
    if (!d) return;
    const view = viewAt(d.rowIndex, d.segment);
    if (!view) return;
    view.focus();
    const rect = view.dom.getBoundingClientRect();
    const y = edge === 'first' ? rect.top + 2 : rect.bottom - 2;
    const clampedX = Math.min(Math.max(x, rect.left + 1), rect.right - 1);
    const found = view.posAtCoords({ left: clampedX, top: y });
    const pos = found ? found.pos : edge === 'first' ? 0 : view.state.doc.content.size;
    view.dispatch(
      view.state.tr
        .setSelection(TextSelection.create(view.state.doc, Math.min(pos, view.state.doc.content.size)))
        .scrollIntoView()
        .setMeta('appHistoryIgnore', true),
    );
    focusedRow = d.rowIndex;
    focusedSegment = d.segment;
  }

  // ── cross-row selection helpers ────────────────────────────────────────
  function rowOfDomNode(node: Node | null): number {
    if (!node) return -1;
    const el = node instanceof Element ? node : node.parentElement;
    const cell = el?.closest('[data-row-en]');
    return cell ? Number((cell as HTMLElement).dataset.rowEn) : -1;
  }

  /** Same row lookup, but recognizes Greek/gutter cells too (`data-row`), for
   * copy-as-citation's "selection may sit in Greek cells" case. */
  function anyRowOfDomNode(node: Node | null): number {
    if (!node) return -1;
    const el = node instanceof Element ? node : node.parentElement;
    const cell = el?.closest('[data-row-en], [data-row]');
    if (!cell) return -1;
    const raw = (cell as HTMLElement).dataset.rowEn ?? (cell as HTMLElement).dataset.row;
    return raw !== undefined ? Number(raw) : -1;
  }

  function crossRowSelection(): boolean {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return false;
    const range = sel.getRangeAt(0);
    const a = rowOfDomNode(range.startContainer);
    const b = rowOfDomNode(range.endContainer);
    return a >= 0 && b >= 0 && a !== b;
  }

  /** Which column a DOM node sits in, for column-scoped selection/copy. */
  function columnOfDomNode(node: Node | null): 'greek' | 'english' | null {
    const el = node instanceof Element ? node : node?.parentElement;
    // The interpolated original counts as the source column (refinement
    // pass): a multi-block source selection batch-translates, like the grid.
    if (el?.closest('.grc-cell') || el?.closest('.interp-source') || el?.closest('.flow-grc')) return 'greek';
    if (el?.closest('.en-cell')) return 'english';
    return null;
  }

  /** Constrain a drag-selection to the column it starts in (John): mark the
   * OTHER column user-select:none while the pointer is down, so the highlight —
   * and any copied text — stays within one language. Imperative (not reactive)
   * so it applies synchronously before the browser extends the selection. */
  function onGridPointerDown(e: PointerEvent) {
    if (e.button !== 0 || !gridEl) return;
    gridEl.classList.remove('sel-greek', 'sel-english');
    const col = columnOfDomNode(e.target as Node | null);
    if (col === 'greek') gridEl.classList.add('sel-greek');
    else if (col === 'english') gridEl.classList.add('sel-english');
  }

  function clearSelectionColumn() {
    gridEl?.classList.remove('sel-greek', 'sel-english');
  }

  function onCopy(e: ClipboardEvent) {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    // A Greek-column selection copies natively (the read-only spine text) —
    // the per-row English extraction below is only for cross-row ENGLISH
    // selections (spanning multiple ProseMirror editors).
    if (columnOfDomNode(range.startContainer) === 'greek') return;
    const startRow = rowOfDomNode(range.startContainer);
    const endRow = rowOfDomNode(range.endContainer);
    if (startRow < 0 || endRow < 0 || startRow === endRow) return; // single row → PM handles

    const parts: string[] = [];
    for (let g = startRow; g <= endRow; g++) {
      const d = displayRows[g];
      if (!d) continue;
      const view = viewAt(d.rowIndex, d.segment);
      if (!view) continue;
      const size = view.state.doc.content.size;
      let from = 0;
      let to = size;
      try {
        if (g === startRow) from = Math.max(0, Math.min(view.posAtDOM(range.startContainer, range.startOffset), size));
        if (g === endRow) to = Math.max(0, Math.min(view.posAtDOM(range.endContainer, range.endOffset), size));
      } catch {
        /* keep full-row fallback */
      }
      parts.push(view.state.doc.textBetween(from, to, undefined, ''));
    }
    e.clipboardData?.setData('text/plain', parts.join('\n'));
    e.preventDefault();
  }

  function onCut(e: ClipboardEvent) {
    if (crossRowSelection()) {
      e.preventDefault();
      setStatus('Select within one row to edit — cross-row selections are read-only');
    }
  }

  // ── copy as citation (build spec §10) ──────────────────────────────────
  // Row range = every MODEL row touched by the native selection, whether it
  // sits in English or Greek cells; caret-only → the focused row alone. A
  // paragraph-split line is ONE citable row (design doc D6 §7): both segment
  // cells fold back into a single CitationRowInput — one address, englishDoc
  // = the segments joined (joinRowDocs). Assembly (English/Greek extraction,
  // the exact clipboard string, scheme.formatCitation) is pure and lives in
  // copyCitation.ts — this only resolves DOM selection to rows and per-row
  // englishSelected text, mirroring onCopy above.
  async function writeClipboardText(text: string): Promise<void> {
    if (isTauri()) {
      const { writeText } = await import('@tauri-apps/plugin-clipboard-manager');
      await writeText(text);
    } else {
      await navigator.clipboard.writeText(text);
    }
  }

  async function copyCitation() {
    const sel = window.getSelection();
    let startG: number;
    let endG: number;
    let range: Range | null = null;

    if (sel && !sel.isCollapsed && sel.rangeCount > 0) {
      range = sel.getRangeAt(0);
      startG = anyRowOfDomNode(range.startContainer);
      endG = anyRowOfDomNode(range.endContainer);
      if (startG < 0 || endG < 0) {
        // Selection isn't inside the chapter grid at all — fall back to the
        // focused row, same as caret-only.
        range = null;
        startG = endG = focusedGrid();
      } else if (startG > endG) {
        [startG, endG] = [endG, startG];
      }
    } else {
      startG = endG = focusedGrid();
    }

    if (startG < 0 || endG < 0) {
      setStatus('Click into a row first');
      return;
    }

    const startRow = displayRows[startG].rowIndex;
    const endRow = displayRows[endG].rowIndex;

    const rows: CitationRowInput[] = [];
    for (let r = startRow; r <= endRow; r++) {
      // A split line folds to ONE citable row: full English = segments
      // joined by a single space (the app's one join convention).
      const englishDoc = joinedRowDoc(r);
      // englishSelected only when the selection PARTIALLY covers this row's
      // English (an endpoint inside an English cell, or a segment of a split
      // line outside the selected grid range). Fully covered / interior /
      // Greek-endpoint rows stay null and contribute their FULL English
      // inside buildCitationClipboardText.
      let englishSelected: string | null = null;
      if (range) {
        const parts: string[] = [];
        let partial = false;
        const count = segmentCount(model.rows[r]);
        for (let s = 0; s < count; s++) {
          const g = gridOrdinalOf(r, s);
          if (g < startG || g > endG) {
            partial = true; // this segment sits outside the selection
            continue;
          }
          const doc = segmentDoc(r, s);
          const size = doc.content.size;
          let from = 0;
          let to = size;
          const view = viewAt(r, s);
          const startsHere = g === startG && rowOfDomNode(range.startContainer) === g;
          const endsHere = g === endG && rowOfDomNode(range.endContainer) === g;
          if (view && (startsHere || endsHere)) {
            // Element-level endpoints (e.g. a triple-clicked paragraph, whose
            // Range boundary sits on the cell wrapper rather than inside a
            // text node) never get handed to posAtDOM: its default bias can
            // resolve a boundary offset back to an empty point, which — via
            // buildCitationClipboardText's "all-empty is nothing to cite"
            // check — surfaced as a false-negative "Nothing to cite" even
            // though rows were visibly selected. Treat such an endpoint as
            // full coverage of this cell from its edge instead.
            // resolveEndpointPos duck-types nodes as DomNodeLike (so it can be
            // unit-tested without jsdom); here the containers are real DOM
            // nodes, so the cast back to Node is sound.
            if (startsHere) {
              from = resolveEndpointPos(range.startContainer, range.startOffset, size, 'start', (node, offset) =>
                view.posAtDOM(node as unknown as Node, offset),
              );
            }
            if (endsHere) {
              to = resolveEndpointPos(range.endContainer, range.endOffset, size, 'end', (node, offset) =>
                view.posAtDOM(node as unknown as Node, offset),
              );
            }
            if (from > 0 || to < size) partial = true;
          }
          parts.push(doc.textBetween(from, to, ' ', ''));
        }
        if (partial) englishSelected = parts.join(' ').trim();
      }
      rows.push({
        address: model.rows[r].address,
        greek: model.rows[r].greek,
        englishDoc,
        englishSelected,
      });
    }

    const scheme = getScheme(model.scheme);
    const result = buildCitationClipboardText({
      rows,
      scheme,
      work: citationWork,
      book: model.book,
      chapter: model.chapter,
    });

    if (result.kind === 'empty') {
      setStatus('Nothing to cite — the selected rows have no English yet.');
      return;
    }

    try {
      await writeClipboardText(result.text);
      setStatus('Citation copied.');
    } catch {
      setStatus('Could not copy — try again.');
    }
  }

  // ── AI-assist (design doc D4, build spec §12 — UI slice) ────────────────
  // Lazy, first-use only: nothing here runs until the glyph or ⌘⏎ fires.
  // (assistRow, assistSeg) anchors the popover under that CELL — a request
  // from a continuation segment targets that segment for Insert, but the
  // context is assembled per ADDRESS (a split line is one context line, its
  // draft = segments joined; the ±6 window counts Bekker LINES — d6 §7).
  let assistRow = $state(-1);
  let assistSeg = $state(0);
  // The editing LAYER captured when the request was invoked (D8 §7 Phase E2):
  // Insert writes through the layer-explicit view key `vkey(row, seg, layer)`
  // — NEVER viewAt, whose active-layer default could hand a suggestion
  // invoked in one layer to the other layer's view after a view switch.
  let assistLayer: EditLayer = 'sentence';
  let assistUi = $state<AssistUiState | null>(null);
  // Viewport point to anchor the popover at (John 2026-07-14): the flowing
  // views separate a line's Greek from its English cell, so a cell-anchored
  // popover lands far from the word you clicked. When assist is invoked from a
  // Greek/source context menu we anchor the popover under the CLICK instead;
  // null falls back to the cell-anchored placement (glyph / ⌘⏎).
  let assistAnchorPos = $state<{ x: number; y: number } | null>(null);
  // Raw cursor of the last context-menu open (before the menu's own clamp) —
  // the click point a menu-triggered translate anchors its popover to.
  let menuPointer = { x: 0, y: 0 };

  // ── AI reference popups (right-click Greek → "AI reference") ──────────────
  // Independent of the translate flow: the AI's own translation appears in a
  // FLOATING popup that never touches the English cell and stays open until
  // the user closes it. Multiple can coexist, so this is an ARRAY; each entry
  // owns its own AbortController (closing a popup aborts its in-flight
  // request). All are torn down on chapter switch / unmount.
  // ── AI output sidebar (Translation Check / AI reference) ────────────────
  // The result renders in the right-docked AiPanel (session.aiPanel bridge),
  // not a floating popup — one panel at a time, superseded by the next request.
  // `aiPanelAbort` cancels the in-flight request on close / supersede / unmount
  // so a stale result can never land; `aiPanelText` is the raw Markdown kept
  // for the Copy action.
  let aiPanelAbort: AbortController | null = null;
  let aiPanelText = '';

  // ── Ask-AI (docked bottom panel; free-form question about a line) ────────
  // ONE-SHOT: each question is answered independently (no prior-turn history is
  // sent). The panel accumulates a transcript for readability only; multi-turn
  // would slot in by threading the transcript into the prompt here. Each
  // in-flight ask has its own AbortController so a chapter switch / unmount
  // (and a superseding ask) aborts it — its result can never render in a gone
  // chapter. `askAssistTarget` is the model row the next ask runs against: it
  // follows focus, and the ctx-menu pins it to the right-clicked row.
  let askAbort: AbortController | null = null;
  let askAssistTarget = $state(-1);

  /** Display locus for a model row, e.g. "Ζ.17" (book label + chapter). */
  function rowLocus(): string {
    return `${model.bookLabel}.${model.chapter}`;
  }

  /** Point session.askTarget at model row `i` (address + locus) so an open
   * panel follows the line. No-op for an out-of-range row. */
  function setAskTarget(i: number) {
    const row = model.rows[i];
    if (!row) return;
    askAssistTarget = i;
    session.askTarget = { address: row.address.raw, locus: rowLocus() };
  }

  const assistCtl = new AssistController({
    getProvider: getAssistProvider,
    copyPayload: async (ctx) => {
      try {
        await writeClipboardText(buildClipboardPayload(ctx));
        return true;
      } catch {
        return false;
      }
    },
    onState: (s) => {
      assistUi = s;
    },
  });

  /** Suggest-for-row (glyph click / ⌘⏎). Guards run BEFORE any provider
   * work: no active cell → no-op; no source text on the row → the unit's
   * no-line message. Captures the ACTIVE layer so the eventual Insert
   * writes back to the layer the request came from (D8 §7 Phase E2). */
  function invokeAssist(row: number, segment: number, anchor: { x: number; y: number } | null = null) {
    if (row < 0 || row >= model.rows.length || !viewAt(row, segment)) return;
    assistAnchorPos = anchor;
    assistRow = row;
    assistSeg = segment;
    assistLayer = activeLayer();
    if (model.rows[row].greek.trim().length === 0) {
      assistCtl.cancel();
      assistUi = {
        kind: 'message',
        text: rowUnitNoun() === 'line' ? NO_LINE_MESSAGE : NO_PARAGRAPH_MESSAGE,
      };
      return;
    }
    void runAssist(row, segment, assistLayer);
  }

  async function runAssist(row: number, segment: number, layer: EditLayer) {
    const settings = await loadSettings(); // includeDraft (John: default ON)
    if (destroyed || assistRow !== row || assistSeg !== segment) return;
    const unit = assistUnitFor(layer, row);
    const ctx = buildAssistContext({
      rowCount: model.rows.length,
      rowAt: (i) => ({ address: model.rows[i].address.raw, greek: model.rows[i].greek }),
      // Live views when mounted, committed model otherwise — the draft the
      // user SEES is the draft that goes out as context. A split line is ONE
      // context line: its segments joined (d6 §7 call-site folding); para-
      // layer context reads englishPara first (contextDraft).
      draftAt: (i) => contextDraft(layer, i),
      targetIndex: row,
      includeDraft: settings.assist?.includeDraft ?? true,
      unit,
      // Sentence-unit targets translate ONE sentence of the paragraph — the
      // clicked cell's slice; the whole row rides along as ctx.enclosing.
      ...(unit === 'sentence' ? { targetSlice: greekSliceOf(row, segment) } : {}),
      work: assistWorkMeta(),
      book: { index: model.book, label: model.bookLabel },
      chapter: model.chapter,
    });
    await assistCtl.request(ctx);
  }

  function dismissAssist() {
    assistCtl.cancel();
    assistUi = null;
    assistRow = -1;
    assistSeg = 0;
  }

  // ── batch translate (multi-line selection) ─────────────────────────────
  // When the Greek right-click fires on a multi-line selection, "Translate with
  // AI" fills EVERY selected line's English cell in one sweep (design: the
  // single-line flow reviews in a popover; a batch would be N popovers, so it
  // auto-fills instead). Non-destructive: only EMPTY cells are filled; lines
  // that already have English are left alone and reported. Sequential (one CLI
  // call at a time) with a status counter; abortable on unmount / re-invoke.
  let batchAbort: AbortController | null = null;

  /** Model rows covered by a multi-line selection in the GREEK column — sorted,
   * de-duped, Greek-non-empty only. Empty unless the selection spans >1 row in
   * the Greek column. Grid ordinals → model rows via displayRows (a split
   * line's two segments fold to one model row). */
  function selectedGreekModelRows(): number[] {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return [];
    const range = sel.getRangeAt(0);
    if (columnOfDomNode(range.startContainer) !== 'greek') return [];
    const a = anyRowOfDomNode(range.startContainer);
    const b = anyRowOfDomNode(range.endContainer);
    if (a < 0 || b < 0) return [];
    const rows = new Set<number>();
    for (let g = Math.min(a, b); g <= Math.max(a, b); g++) {
      const d = displayRows[g];
      if (d && (model.rows[d.rowIndex]?.greek.trim().length ?? 0) > 0) rows.add(d.rowIndex);
    }
    return [...rows].sort((x, y) => x - y);
  }

  /** Replace a cell's FULL English content with `text` (already sanitized),
   * without stealing focus/scroll — the batch fills many cells at once. The
   * LAYER is explicit (D2/D8 vkey discipline — never viewAt for writes): a
   * para-layer batch writes englishPara views, a sentence-layer batch writes
   * sentence views; each view's own dispatch pipeline handles undo/commit.
   * Its own app-undo entry. Returns false if the view is gone (e.g. the user
   * switched views mid-batch) or the text is empty. */
  function fillRowEnglish(row: number, segment: number, layer: EditLayer, text: string): boolean {
    const view = views.get(vkey(row, segment, layer));
    if (!view || text.length === 0) return false;
    const size = view.state.doc.content.size;
    history.breakCoalescing();
    view.dispatch(view.state.tr.replaceWith(0, size, view.state.schema.text(text)).setMeta('noCoalesce', true));
    return true;
  }

  /** A pending multi-row translate awaiting the overwrite confirmation
   * (non-null only when some target rows already have English). Carries the
   * layer + unit noun captured at invocation. */
  let pendingBatchTranslate = $state<{
    rows: number[];
    withText: number;
    layer: EditLayer;
    noun: 'line' | 'paragraph';
  } | null>(null);

  /** Entry point for a multi-row translate. Translates EVERY source-non-empty
   * row in `rows`, overwriting existing English — but if any target already
   * has text, warn first (John). One row → defer to the popover-review flow.
   * On paragraph docs the rows ARE paragraphs: a para-layer batch fills
   * englishPara, a sentence-layer batch fills the row's first cell (the D6
   * batch convention), both with whole-paragraph wording. */
  function invokeAssistRange(rows: number[]) {
    const targets = rows.filter(
      (r) => r >= 0 && r < model.rows.length && model.rows[r].greek.trim().length > 0,
    );
    if (targets.length <= 1) {
      if (targets.length === 1) invokeAssist(targets[0], 0);
      return;
    }
    const layer = activeLayer();
    const noun = rowUnitNoun();
    const hasText = (r: number) =>
      layer === 'para' ? plainRowText(paraDoc(r)) !== null : plainRowText(joinedRowDoc(r)) !== null;
    const withText = targets.filter(hasText).length;
    if (withText > 0) {
      pendingBatchTranslate = { rows: targets, withText, layer, noun }; // confirm before overwriting
    } else {
      void runAssistRange(targets, layer, noun);
    }
  }

  function confirmBatchTranslate() {
    const p = pendingBatchTranslate;
    pendingBatchTranslate = null;
    if (p) void runAssistRange(p.rows, p.layer, p.noun);
  }

  function cancelBatchTranslate() {
    pendingBatchTranslate = null;
  }

  /** Translate each target row SEQUENTIALLY, overwriting its full English.
   * Progress via the status pill; abortable on unmount / re-invoke. */
  async function runAssistRange(targets: number[], layer: EditLayer, noun: 'line' | 'paragraph') {
    batchAbort?.abort();
    const abort = new AbortController();
    batchAbort = abort;

    const settings = await loadSettings();
    if (abort.signal.aborted || destroyed) return;
    let provider: AssistProvider;
    try {
      provider = await getAssistProvider();
    } catch {
      setStatus(GENERIC_ERROR_MESSAGE);
      return;
    }
    if (abort.signal.aborted || destroyed) return;

    const includeDraft = settings.assist?.includeDraft ?? true;
    // A batch target is always the WHOLE row: paragraph wording on paragraph
    // docs (regardless of layer — the row is a paragraph), line wording else.
    const unit: AssistUnit = noun;
    let filled = 0;
    let failed = 0;
    for (let i = 0; i < targets.length; i++) {
      if (abort.signal.aborted || destroyed) break;
      const r = targets[i];
      setStatus(`Translating ${noun} ${i + 1} of ${targets.length}…`, 120_000);
      const ctx = buildAssistContext({
        rowCount: model.rows.length,
        rowAt: (k) => ({ address: model.rows[k].address.raw, greek: model.rows[k].greek }),
        draftAt: (k) => contextDraft(layer, k),
        targetIndex: r,
        includeDraft,
        unit,
        work: assistWorkMeta(),
        book: { index: model.book, label: model.bookLabel },
        chapter: model.chapter,
      });
      let result: AssistResult;
      try {
        result = await provider.suggest(ctx, abort.signal);
      } catch {
        failed++;
        continue;
      }
      if (abort.signal.aborted || destroyed) break;
      if (
        result.kind === 'suggestion' &&
        fillRowEnglish(r, 0, layer, sanitizeSuggestion(result.text, { multiline: layer === 'para' }))
      ) {
        filled++;
      } else {
        failed++;
      }
    }
    if (abort.signal.aborted || destroyed) return;
    const parts = [`Translated ${filled} ${noun}${filled === 1 ? '' : 's'}`];
    if (failed) parts.push(`${failed} failed`);
    setStatus(parts.join(' · '), 4000);
  }

  /** Right-click → "AI reference" / "Check my translation": run the SAME
   * provider the translate flow uses (mode 'reference' or 'check') and show the
   * result in the right-docked AiPanel — never touching the English cell.
   * Guards run first (row valid, Greek non-empty; check needs existing English
   * → else a brief status). Supersedes any open panel (one at a time) and
   * aborts its in-flight request. `title` is the panel header. */
  function invokeAiPanel(
    row: number,
    segment: number,
    mode: 'reference' | 'check',
    title: string,
  ) {
    if (row < 0 || row >= model.rows.length || !viewAt(row, segment)) return;
    const layer = activeLayer();
    const unit = assistUnitFor(layer, row);
    if (model.rows[row].greek.trim().length === 0) {
      setStatus(rowUnitNoun() === 'line' ? NO_LINE_MESSAGE : NO_PARAGRAPH_MESSAGE);
      return;
    }
    // Check mode diagnoses the EXISTING English of the TARGET unit — nothing
    // to check when that unit is blank (para layer reads englishPara, falling
    // back to the sentence join the para view displays; a sentence-unit
    // target reads its own cell; a line the joined row).
    if (mode === 'check' && targetEnglish(row, segment, layer, unit) === null) {
      setStatus(
        unit === 'line'
          ? 'There is no English on this line to check yet.'
          : `There is no English in this ${unit} to check yet.`,
      );
      return;
    }
    aiPanelAbort?.abort(); // supersede any open panel's request
    const abort = new AbortController();
    aiPanelAbort = abort;
    aiPanelText = '';
    session.aiPanel = { title, locus: model.rows[row].address.raw, state: { kind: 'thinking' } };
    void runAiPanel(row, segment, layer, mode, abort);
  }

  /** The TARGET's own English for check/ask: the para layer reads
   * englishPara, falling back to the joined sentence text — the read-only
   * draft the para view SHOWS when englishPara is empty (same
   * read-what-the-user-sees rule as contextDraft and Ask); a sentence-unit
   * target reads its own cell's doc; a line-unit target reads the whole row
   * joined (the D4 behaviour). */
  function targetEnglish(row: number, segment: number, layer: EditLayer, unit: AssistUnit): string | null {
    if (layer === 'para') return plainRowText(paraDoc(row)) ?? plainRowText(joinedRowDoc(row));
    if (unit === 'sentence') return plainRowText(segmentDoc(row, segment));
    return plainRowText(joinedRowDoc(row));
  }

  /** Only apply a result if `abort` is still THE current panel request (not
   * superseded / closed / unmounted). */
  function setAiPanelState(abort: AbortController, state: AiPanelState) {
    if (abort.signal.aborted || destroyed || aiPanelAbort !== abort || !session.aiPanel) return;
    session.aiPanel = { ...session.aiPanel, state };
  }

  async function runAiPanel(
    row: number,
    segment: number,
    layer: EditLayer,
    mode: 'reference' | 'check',
    abort: AbortController,
  ) {
    const signal = abort.signal;
    let provider: AssistProvider;
    try {
      provider = await getAssistProvider();
    } catch {
      setAiPanelState(abort, { kind: 'error', text: GENERIC_ERROR_MESSAGE });
      return;
    }
    if (signal.aborted || destroyed) return;

    const settings = await loadSettings();
    if (signal.aborted || destroyed) return;

    // Check mode MUST include the surrounding drafts (the passage under review)
    // regardless of the user's default; reference honours the setting.
    const includeDraft = mode === 'check' ? true : (settings.assist?.includeDraft ?? true);
    const unit = assistUnitFor(layer, row);
    const base = buildAssistContext({
      rowCount: model.rows.length,
      rowAt: (i) => ({ address: model.rows[i].address.raw, greek: model.rows[i].greek }),
      draftAt: (i) => contextDraft(layer, i),
      targetIndex: row,
      includeDraft,
      unit,
      ...(unit === 'sentence' ? { targetSlice: greekSliceOf(row, segment) } : {}),
      work: assistWorkMeta(),
      book: { index: model.book, label: model.bookLabel },
      chapter: model.chapter,
    });
    // Check mode sends the target's OWN English (the translation being
    // diagnosed); reference never does.
    const ctx: AssistContext =
      mode === 'check'
        ? { mode, ...base, target: { ...base.target, english: targetEnglish(row, segment, layer, unit) } }
        : { mode, ...base };

    let result: AssistResult;
    try {
      result = await provider.suggest(ctx, signal);
    } catch {
      setAiPanelState(abort, { kind: 'error', text: GENERIC_ERROR_MESSAGE });
      return;
    }
    if (signal.aborted || destroyed) return;

    if (result.kind === 'suggestion') {
      aiPanelText = result.text;
      setAiPanelState(abort, { kind: 'text', text: result.text });
    } else {
      // clipboard fallback or error — both carry one vetted plain sentence.
      setAiPanelState(abort, { kind: 'error', text: result.message });
    }
  }

  /** Close the AI panel: abort its in-flight request and clear the bridge. */
  function closeAiPanel() {
    aiPanelAbort?.abort();
    aiPanelAbort = null;
    aiPanelText = '';
    session.aiPanel = null;
  }

  /** Copy the AI panel's current text to the clipboard; true on success. */
  async function copyAiPanel(): Promise<boolean> {
    if (session.aiPanel?.state.kind !== 'text' || !aiPanelText) return false;
    try {
      await writeClipboardText(aiPanelText);
      return true;
    } catch {
      return false;
    }
  }

  /** Ask-AI (docked panel): answer the translator's free-form `question` about
   * the current ask target's line, via assist mode 'ask'. ONE-SHOT — the
   * question is the only turn sent; the passage context + target English ride
   * along, but no prior transcript entries. Resolves the row from
   * askAssistTarget (the ctx-menu / focus target), falling back to the last
   * focused row. Returns {ok, answer} or {ok:false, message}; never throws, and
   * the message is always a vetted plain sentence (no stack trace). Aborts any
   * prior in-flight ask so only the latest answer can land. */
  async function askAboutLine(question: string): Promise<AskResult> {
    const row = askAssistTarget >= 0 ? askAssistTarget : focusedRow;
    const noun = rowUnitNoun();
    if (row < 0 || row >= model.rows.length) {
      return { ok: false, message: `Click into a ${noun} first, then ask about it.` };
    }
    if (model.rows[row].greek.trim().length === 0) {
      return { ok: false, message: noun === 'line' ? NO_LINE_MESSAGE : NO_PARAGRAPH_MESSAGE };
    }
    // Ask is a whole-ROW mode (the target follows focus row-wise), so on
    // paragraph docs it speaks 'paragraph' in either layer; the English shown
    // to the assistant is the layer the translator is looking at.
    const layer = activeLayer();

    askAbort?.abort();
    const abort = new AbortController();
    askAbort = abort;

    let provider: AssistProvider;
    try {
      provider = await getAssistProvider();
    } catch {
      return { ok: false, message: GENERIC_ERROR_MESSAGE };
    }
    if (abort.signal.aborted || destroyed) return { ok: false, message: GENERIC_ERROR_MESSAGE };

    const base = buildAssistContext({
      rowCount: model.rows.length,
      rowAt: (i) => ({ address: model.rows[i].address.raw, greek: model.rows[i].greek }),
      draftAt: (i) => contextDraft(layer, i),
      targetIndex: row,
      includeDraft: true, // the passage the question is about
      unit: noun,
      work: assistWorkMeta(),
      book: { index: model.book, label: model.bookLabel },
      chapter: model.chapter,
    });
    // Ask mode sends the target's OWN English (so the translator may ask about
    // their own draft) plus the free-form question. Layer-aware: the para
    // layer sends englishPara (falling back to the sentence join it shows).
    const english =
      layer === 'para'
        ? (plainRowText(paraDoc(row)) ?? plainRowText(joinedRowDoc(row)))
        : plainRowText(joinedRowDoc(row));
    const ctx: AssistContext = {
      mode: 'ask',
      question,
      ...base,
      target: { ...base.target, english },
    };

    let result: AssistResult;
    try {
      result = await provider.suggest(ctx, abort.signal);
    } catch {
      if (abort.signal.aborted) return { ok: false, message: GENERIC_ERROR_MESSAGE };
      return { ok: false, message: GENERIC_ERROR_MESSAGE };
    }
    if (abort.signal.aborted || destroyed) return { ok: false, message: GENERIC_ERROR_MESSAGE };

    if (result.kind === 'suggestion') {
      const text = result.text.trim();
      return text ? { ok: true, answer: text } : { ok: false, message: GENERIC_ERROR_MESSAGE };
    }
    // clipboard fallback or error — both carry one vetted plain sentence.
    return { ok: false, message: result.message };
  }

  /** The assist→editor mutation (RowEditor.insertSuggestion delegates here):
   * ONE normal transaction on the target CELL's view, dispatched through
   * dispatchFor — the exact same pipeline as typing (app undo, dirty
   * tracking, commit-on-idle). */
  function insertSuggestionIntoRow(row: number, segment: number, text: string) {
    // Layer-EXPLICIT write (D2/D8 vkey discipline — never viewAt for writes):
    // the suggestion lands in the layer the request was invoked from. If that
    // layer's view is gone (view switched mid-flight), quietly do nothing.
    const view = views.get(vkey(row, segment, assistLayer));
    if (!view) return;
    const tr = buildInsertTransaction(view.state, text, { multiline: assistLayer === 'para' });
    if (!tr) return;
    history.breakCoalescing();
    resetGreekRun(view);
    view.dispatch(tr);
    view.focus();
    focusedRow = row;
    focusedSegment = segment;
  }

  /** Dev-only browser-harness hookup (mirrors ImportDialog's devHarness
   * gating): set `window.__assistFake` at localhost:1421 to exercise the
   * full popover/Insert flow without Tauri —
   *   true            → a canned suggestion
   *   'some text'     → that suggestion text
   *   { kind: ... }   → any AssistResult (error/clipboard/suggestion)
   * Optional `window.__assistFakeDelayMs` (default 600) exercises Thinking….
   * The import.meta.env.DEV gate strips all of this from production builds. */
  async function devFakeAssistProvider(): Promise<AssistProvider | null> {
    if (!import.meta.env.DEV || isTauri()) return null;
    const w = window as unknown as { __assistFake?: unknown; __assistFakeDelayMs?: number };
    const raw = w.__assistFake;
    if (raw === undefined || raw === null || raw === false) return null;
    const { FakeProvider } = await import('../assist/fakeProvider');
    const result: AssistResult =
      typeof raw === 'string'
        ? { kind: 'suggestion', text: raw }
        : typeof raw === 'object' && 'kind' in (raw as object)
          ? (raw as AssistResult)
          : { kind: 'suggestion', text: 'and this is the substance and actuality of each thing.' };
    return new FakeProvider({ result, delayMs: w.__assistFakeDelayMs ?? 600 });
  }

  /** Provider for THIS request: dev fake (browser harness) → Tauri flow
   * (cached cliPath / resolution ladder / clipboard floor, see
   * assistController.resolveTauriAssistProvider) → plain browser clipboard. */
  async function getAssistProvider(): Promise<AssistProvider> {
    const fake = await devFakeAssistProvider();
    if (fake) return fake;
    if (!isTauri()) {
      return new ClipboardProvider({ writeText: writeClipboardText });
    }
    const [{ invoke }, fs, path] = await Promise.all([
      import('@tauri-apps/api/core'),
      import('@tauri-apps/plugin-fs'),
      import('@tauri-apps/api/path'),
    ]);
    return resolveTauriAssistProvider({
      loadSettings,
      updateSettings,
      exists: (p) => fs.exists(p),
      home: () => path.homeDir(),
      invokeRun: ((cmd, args) => invoke(cmd, args)) as RunInvokeFn,
      invokeWhich: (candidates, binName) =>
        invoke<string | null>('assist_which', { candidates, binName }),
      writeClipboard: writeClipboardText,
    });
  }

  // ── line split / un-split (design doc D6 §4) ───────────────────────────
  /** Code-unit offset of the right-click position within the Greek cell's
   * text (WebKit caretRangeFromPoint / Firefox caretPositionFromPoint);
   * null when the click missed the text. Resolved via a Range from the
   * cell's start rather than the raw node-local offset: the cell normally
   * holds a single text node, but App.svelte's click-to-parse flash can
   * transiently split it into siblings (same gotcha its caretOffsetInCell
   * documents), and a fragment-local offset would then be wrong. */
  function caretOffsetFromPoint(e: MouseEvent): number | null {
    const cell = e.currentTarget as HTMLElement | null;
    if (!cell) return null;
    const doc = document as Document & {
      caretPositionFromPoint?(x: number, y: number): { offsetNode: Node; offset: number } | null;
      caretRangeFromPoint?(x: number, y: number): Range | null;
    };
    let node: Node | null = null;
    let offset = 0;
    if (typeof doc.caretPositionFromPoint === 'function') {
      const p = doc.caretPositionFromPoint(e.clientX, e.clientY);
      if (p) {
        node = p.offsetNode;
        offset = p.offset;
      }
    } else if (typeof doc.caretRangeFromPoint === 'function') {
      const r = doc.caretRangeFromPoint(e.clientX, e.clientY);
      if (r) {
        node = r.startContainer;
        offset = r.startOffset;
      }
    }
    if (!node || !cell.contains(node)) return null;
    try {
      const full = document.createRange();
      full.selectNodeContents(cell);
      full.setEnd(node, offset);
      return full.toString().length;
    } catch {
      return null;
    }
  }

  function onGreekContextMenu(e: MouseEvent, g: number) {
    e.preventDefault();
    const d = displayRows[g];
    if (!d) return;
    // Unit nouns for the AI items (D8 §7 Phase E2) — the AI modes are live in
    // EVERY view; para-layer targets read/write englishPara.
    const noun = assistUnitFor(activeLayer(), d.rowIndex);
    const rowNoun = rowUnitNoun();
    // Heading roles (D8 heading tools): offered on a document-spine work's
    // source cell only, at the row's first segment. Undefined elsewhere (corpus
    // menus never show it); buildCtxMenu drops it on aiOnly cells too.
    const heading =
      scheme.spineSource === 'document' && d.segment === 0
        ? { level: model.rows[d.rowIndex].headingLevel ?? null, levelNames }
        : undefined;
    // "Insert heading line here" rides the heading group, but only where rows
    // can be spliced (paragraph-unit document works — canEditRowStructure).
    const canInsertHeading = heading ? canEditRowStructure(scheme) : undefined;
    // Paragraph-unit view (D8 §4): document-spine paragraph docs get
    // STRUCTURE editing here (D8 §2/§3): row-level paragraph split/merge plus
    // the sentence-boundary fix-up — the same snapped-click offset drives
    // both split gestures. Corpus-spine paragraph docs (Busse) get the
    // AI-only menu: the corpus owns their row count. A right-click inside a
    // multi-paragraph source selection batch-translates every selected
    // paragraph into englishPara (same overwrite confirmation as lines).
    if (paragraphUnitView) {
      const paraSel = selectedGreekModelRows();
      const paraTranslateRows = paraSel.length > 1 && paraSel.includes(d.rowIndex) ? paraSel : undefined;
      if (canEditRowStructure(scheme)) {
        const paraRow = model.rows[d.rowIndex];
        const within = caretOffsetFromPoint(e);
        const snapped = within === null ? null : snapToWordStart(paraRow.greek, within);
        ctxMenu = withMenuModel({
          x: e.clientX,
          y: e.clientY,
          row: d.rowIndex,
          segment: 0,
          merge: false,
          offset: snapped,
          noun,
          rowNoun,
          translateRows: paraTranslateRows,
          heading,
          canInsertHeading,
          paraDoc: {
            canMergePrev: d.rowIndex > 0,
            joinBoundary: within === null ? null : joinBoundaryAt(paraRow.splitOffsets, within),
          },
        });
        return;
      }
      ctxMenu = withMenuModel({ x: e.clientX, y: e.clientY, row: d.rowIndex, segment: 0, merge: false, offset: null, aiOnly: true, noun, rowNoun, translateRows: paraTranslateRows });
      return;
    }
    const row = model.rows[d.rowIndex];
    // Plain-line document-spine rows (D8 §5): the grouping toggle — row 1
    // always begins the first chunk, every other row either starts a
    // paragraph or merges back into the one above. Pure display metadata.
    const chunk =
      canGroupLines(scheme) && d.rowIndex > 0 && d.segment === 0
        ? (model.paragraphStarts ?? []).includes(d.rowIndex + 1)
          ? ('remove' as const)
          : ('add' as const)
        : undefined;
    // If the right-click sits inside a multi-line Greek selection, "Translate
    // with AI" acts on every selected line (batch fill); otherwise it's the
    // usual single-line, popover-reviewed translate.
    const selRows = selectedGreekModelRows();
    const translateRows = selRows.length > 1 && selRows.includes(d.rowIndex) ? selRows : undefined;
    if (segmentCount(row) > 1) {
      // Already split (Phase-1 UI is single-split): offer the merge.
      ctxMenu = withMenuModel({ x: e.clientX, y: e.clientY, row: d.rowIndex, segment: d.segment, merge: true, offset: null, noun, rowNoun, translateRows, chunk, heading });
      return;
    }
    // Split gesture (John's §4.1): the offset is the click's nearest word
    // gap, snapped BEFORE the clicked word; isValidSplitOffset (via
    // snapToWordStart) rejects offset 0 and the line end.
    const within = caretOffsetFromPoint(e);
    const offset = within === null ? null : snapToWordStart(row.greek, d.greekStart + within);
    ctxMenu = withMenuModel({ x: e.clientX, y: e.clientY, row: d.rowIndex, segment: d.segment, merge: false, offset, noun, rowNoun, translateRows, chunk, heading });
  }

  /** Right-click the English cell → the 4 AI modes only. Split/Merge is a
   * Greek-word gesture (it needs a clicked Greek offset), so it stays on the
   * Greek cell; the AI modes operate on the whole row and work from either
   * column, so we surface them where the translator's cursor already is. */
  function onEnglishContextMenu(e: MouseEvent, g: number) {
    e.preventDefault();
    const d = displayRows[g];
    if (!d) return;
    // The AI modes are live in every view (D8 §7 Phase E2): para-layer unit
    // views target englishPara, everything else the sentence layer — the
    // menu just labels the target with its unit noun.
    ctxMenu = withMenuModel({
      x: e.clientX,
      y: e.clientY,
      row: d.rowIndex,
      segment: d.segment,
      merge: false,
      offset: null,
      aiOnly: true,
      noun: assistUnitFor(activeLayer(), d.rowIndex),
      rowNoun: rowUnitNoun(),
    });
  }

  /** Right-click the interpolated ORIGINAL (refinement pass): the same
   * structure menu as the work's two-column views — full parity. The only
   * new mechanics is the offset: the block displays TRIMMED slices joined by
   * text-less separators, so the caret offset is mapped back to a model
   * offset via sourceOffsetAtDisplay before the usual word-start snap.
   * Document-spine paragraph docs get the paraDoc menu in BOTH granularities
   * (a sentence block's click maps into its whole row); everything else
   * mirrors the grid's Greek-cell menu (chunk toggle on plain-line rows, D6
   * split/merge — sentence-labelled on corpus paragraph rows by
   * buildCtxMenu). */
  function onInterpSourceContextMenu(e: MouseEvent, g: number) {
    e.preventDefault();
    const d = displayRows[g];
    if (!d) return;
    const noun = assistUnitFor(activeLayer(), d.rowIndex);
    const rowNoun = rowUnitNoun();
    const within = caretOffsetFromPoint(e);
    const row = model.rows[d.rowIndex];
    const selRows = selectedGreekModelRows();
    const translateRows = selRows.length > 1 && selRows.includes(d.rowIndex) ? selRows : undefined;
    // Heading roles (D8 heading tools): same document-spine gate as the grid.
    const heading =
      scheme.spineSource === 'document' && d.segment === 0
        ? { level: model.rows[d.rowIndex].headingLevel ?? null, levelNames }
        : undefined;
    if (canEditRowStructure(scheme)) {
      // Unit granularity displays the whole row (its sentence separators
      // contribute no text); sentence granularity displays one slice of it —
      // both map to an offset in the row's own source.
      let mapped: number | null = null;
      if (within !== null) {
        if (paragraphUnitView) {
          mapped = sourceOffsetAtDisplay(row.greek, row.splitOffsets, within);
        } else {
          const local = sourceOffsetAtDisplay(d.greekSlice, undefined, within);
          mapped = local === null ? null : d.greekStart + local;
        }
      }
      const snapped = mapped === null ? null : snapToWordStart(row.greek, mapped);
      ctxMenu = withMenuModel({
        x: e.clientX,
        y: e.clientY,
        row: d.rowIndex,
        segment: d.segment,
        merge: false,
        offset: snapped,
        noun,
        rowNoun,
        translateRows,
        heading,
        canInsertHeading: canEditRowStructure(scheme),
        paraDoc: {
          canMergePrev: d.rowIndex > 0,
          joinBoundary: mapped === null ? null : joinBoundaryAt(row.splitOffsets, mapped),
        },
      });
      return;
    }
    if (paragraphUnitView) {
      // Corpus-spine paragraph docs (Busse) at unit granularity: the corpus
      // owns their row count — AI-only, exactly like their paragraph view.
      ctxMenu = withMenuModel({ x: e.clientX, y: e.clientY, row: d.rowIndex, segment: 0, merge: false, offset: null, aiOnly: true, noun, rowNoun, translateRows });
      return;
    }
    const chunkState =
      canGroupLines(scheme) && d.rowIndex > 0 && d.segment === 0
        ? (model.paragraphStarts ?? []).includes(d.rowIndex + 1)
          ? ('remove' as const)
          : ('add' as const)
        : undefined;
    if (segmentCount(row) > 1) {
      ctxMenu = withMenuModel({ x: e.clientX, y: e.clientY, row: d.rowIndex, segment: d.segment, merge: true, offset: null, noun, rowNoun, translateRows, chunk: chunkState, heading });
      return;
    }
    const local = within === null ? null : sourceOffsetAtDisplay(d.greekSlice, undefined, within);
    const offset = local === null ? null : snapToWordStart(row.greek, d.greekStart + local);
    ctxMenu = withMenuModel({ x: e.clientX, y: e.clientY, row: d.rowIndex, segment: d.segment, merge: false, offset, noun, rowNoun, translateRows, chunk: chunkState, heading });
  }

  function menuSplit() {
    const m = ctxMenu;
    ctxMenu = null;
    if (!m || m.merge) return;
    if (m.offset === null) {
      setStatus('Choose the Greek word where the new paragraph starts.');
      return;
    }
    performSplit(m.row, m.offset);
  }

  function menuMerge() {
    const m = ctxMenu;
    ctxMenu = null;
    if (!m || !m.merge) return;
    requestUnsplit(m.row, m.segment);
  }

  // ── document-spine structure menu commands (D8 §2/§3/§5) ────────────────
  function menuParaSplit() {
    const m = ctxMenu;
    ctxMenu = null;
    if (!m?.paraDoc) return;
    if (m.offset === null) {
      setStatus('Choose the word where the new paragraph starts.');
      return;
    }
    performParagraphSplit(m.row, m.offset);
  }

  function menuParaMerge() {
    const m = ctxMenu;
    ctxMenu = null;
    if (!m?.paraDoc || !m.paraDoc.canMergePrev) return;
    requestParagraphMerge(m.row);
  }

  function menuSentenceSplit() {
    const m = ctxMenu;
    ctxMenu = null;
    if (!m?.paraDoc) return;
    if (m.offset === null) {
      setStatus('Choose the word where the new sentence starts.');
      return;
    }
    performSentenceSplit(m.row, m.offset);
  }

  function menuSentenceJoin() {
    const m = ctxMenu;
    ctxMenu = null;
    if (!m?.paraDoc || m.paraDoc.joinBoundary === null) return;
    requestSentenceJoin(m.row, m.paraDoc.joinBoundary);
  }

  function menuChunkToggle() {
    const m = ctxMenu;
    ctxMenu = null;
    if (!m?.chunk) return;
    toggleChunkStart(m.row, m.chunk);
  }

  function menuSetLevel(level: number | null) {
    const m = ctxMenu;
    ctxMenu = null;
    if (!m) return;
    setRowLevel(m.row, level);
  }

  function menuInsertLevel(level?: number) {
    const m = ctxMenu;
    ctxMenu = null;
    if (!m) return;
    performInsertHeading(m.row, level);
  }

  /** Dispatch a clicked menu item. `heading-mark`/`heading-insert` carry a
   * per-tier level on the item (one id, N tiers); everything else is a static
   * id → command. */
  function runMenuItem(item: CtxMenuItem) {
    // A submenu parent ("Mark as ▸" / "Insert heading line ▸") dispatches
    // nothing — its children do.
    if (item.submenu) return;
    if (item.id === 'heading-mark') {
      menuSetLevel(item.level ?? 1);
      return;
    }
    if (item.id === 'heading-insert') {
      menuInsertLevel(item.level);
      return;
    }
    menuActions[item.id]();
  }

  /** Right-click the Greek → "Translate with AI" (the discoverable entry
   * point; the hover glyph + ⌘⏎ still work). Translates the whole Bekker
   * line via the same per-row assist flow; the suggestion lands in this
   * row's English cell. */
  function menuAssist() {
    const m = ctxMenu;
    ctxMenu = null;
    if (!m) return;
    if (m.translateRows && m.translateRows.length > 1) {
      invokeAssistRange(m.translateRows);
    } else {
      // NOTE: click-anchoring (position:fixed at menuPointer) broke translate in
      // the flowing views — reverted to the cell-anchored popover, which works
      // and is viewport-clamped. Revisit anchoring via a body portal later.
      invokeAssist(m.row, m.segment);
    }
  }

  /** Right-click → "AI reference": the AI's own translation in the right-docked
   * AI panel. Independent of the translate/cell flow. */
  function menuReference() {
    const m = ctxMenu;
    ctxMenu = null;
    if (!m) return;
    invokeAiPanel(m.row, m.segment, 'reference', 'AI reference');
  }

  /** Right-click → "Check my translation": a linguist's diagnosis of the row's
   * existing English against the Greek, in the right-docked AI panel. */
  function menuCheck() {
    const m = ctxMenu;
    ctxMenu = null;
    if (!m) return;
    invokeAiPanel(m.row, m.segment, 'check', 'Translation check');
  }

  /** Right-click the Greek → "Ask AI about this line…": pin the ask target to
   * this row and open the docked panel (App focuses its input). The panel then
   * follows focus, but starts on the row you chose. */
  function menuAsk() {
    const m = ctxMenu;
    ctxMenu = null;
    if (!m) return;
    setAskTarget(m.row);
    session.askPanelOpen = true;
  }

  /** Item ids (ctxMenu.ts) → the menu commands above. Each command still
   * reads its own guard fields off ctxMenu, so a stray id is a no-op. */
  const menuActions: Record<CtxMenuItemId, () => void> = {
    'line-split': menuSplit,
    'line-merge': menuMerge,
    'chunk-add': menuChunkToggle,
    'chunk-remove': menuChunkToggle,
    'para-split': menuParaSplit,
    'para-merge': menuParaMerge,
    'sentence-split': menuSentenceSplit,
    'sentence-join': menuSentenceJoin,
    // heading-mark / heading-insert carry a per-item level → dispatched by
    // runMenuItem; the *-menu ids are submenu parents (also runMenuItem). All
    // are no-ops here, kept only to satisfy the exhaustive Record.
    'heading-mark': () => {},
    'heading-mark-menu': () => {},
    'heading-clear': () => menuSetLevel(null),
    'heading-insert': () => {},
    'heading-insert-menu': () => {},
    'ai-translate': menuAssist,
    'ai-translate-batch': menuAssist,
    'ai-reference': menuReference,
    'ai-check': menuCheck,
    'ai-ask': menuAsk,
  };

  /** Split model row r at a validated Greek offset — ONE undo entry that
   * captures the row's structural before/after (offsets + both English
   * docs) and restores focus on ⌘Z. */
  function performSplit(r: number, offset: number) {
    const row = model.rows[r];
    if (!row) return;
    commitRowNow(r); // live edits land in the model before the snapshot
    const before = snapshotRow(r);
    const selBefore = focusedSelRef();
    // English division (John's §4.2): at the caret when it's currently in
    // THIS row's English cell; otherwise all existing English stays in
    // segment 0 and the continuation starts empty.
    const caret = focusedRow === r && focusedSegment === 0 ? (viewAt(r, 0)?.state.selection.head ?? null) : null;
    const result = splitUnsplitRow(row, offset, caret);
    if (!result) {
      setStatus('Choose the Greek word where the new paragraph starts.');
      return;
    }
    dismissAssist();
    history.breakCoalescing();

    row.english = result.english;
    row.english2 = result.english2;
    row.splitOffsets = result.splitOffsets;
    refreshDisplayRows();

    // Segment 0 keeps its mounted view (stable key) — push the divided doc
    // into it; the continuation mounts fresh from the model.
    const seg0 = viewAt(r, 0);
    if (seg0) {
      seg0.dispatch(
        seg0.state.tr
          .replaceWith(0, seg0.state.doc.content.size, docFromJSON(result.english).content)
          .setMeta('appHistoryIgnore', true)
          .setMeta(FN_REFRESH, true),
      );
    }

    const selAfter: SelRef = { row: r, segment: 1, anchor: 0, head: 0 };
    history.push({
      edits: [{ row: r, before, after: snapshotRow(r) }],
      selBefore,
      selAfter,
    });
    markModelDirty();
    refreshFnDisplay();
    void tick().then(() => focusSel(selAfter));
  }

  /** Un-split entry point (context menu on either segment). Confirms ONLY
   * when both English cells hold text (John's adopted default); an empty
   * side rejoins silently. */
  function requestUnsplit(r: number, segment: number) {
    const row = model.rows[r];
    if (!row || segmentCount(row) < 2) return;
    const boundary = Math.min(segment === 0 ? 0 : segment - 1, segmentCount(row) - 2);
    commitRowNow(r);
    if (mergeNeedsConfirm(row, boundary)) {
      pendingUnsplit = { row: r, boundary };
      return;
    }
    performUnsplit(r, boundary);
  }

  function confirmUnsplit() {
    const p = pendingUnsplit;
    pendingUnsplit = null;
    if (p) performUnsplit(p.row, p.boundary);
  }

  function cancelUnsplit() {
    pendingUnsplit = null;
  }

  /** Merge segments boundary/boundary+1 back into one — English rejoined
   * with a single space (joinRowDocs), ONE undo entry. NOT the forbidden
   * Bekker merge: both segments share one address. */
  function performUnsplit(r: number, boundary: number) {
    const row = model.rows[r];
    if (!row) return;
    commitRowNow(r);
    const before = snapshotRow(r);
    const selBefore = focusedSelRef();
    const merged = mergeSegments(row, boundary);
    if (!merged) return;
    dismissAssist();
    history.breakCoalescing();

    row.english = merged.english;
    if (merged.english2) row.english2 = merged.english2;
    else delete row.english2;
    if (merged.splitOffsets) row.splitOffsets = merged.splitOffsets;
    else delete row.splitOffsets;
    refreshDisplayRows();

    // The surviving segment keeps its view — push the merged doc into it;
    // the vanished continuation unmounts (destroyView skips the stale
    // commit). Layer-EXPLICIT: a sentence join can fire from the
    // paragraph-unit view (D8 §3), where viewAt would hand back the mounted
    // para view and write sentence text into englishPara.
    const keep = views.get(vkey(r, boundary, 'sentence')) ?? null;
    if (keep) {
      const json = boundary === 0 ? row.english : row.english2![boundary - 1];
      keep.dispatch(
        keep.state.tr
          .replaceWith(0, keep.state.doc.content.size, docFromJSON(json).content)
          .setMeta('appHistoryIgnore', true)
          .setMeta(FN_REFRESH, true),
      );
    }

    const selAfter: SelRef = { row: r, segment: boundary, anchor: merged.joinPos, head: merged.joinPos };
    history.push({
      edits: [{ row: r, before, after: snapshotRow(r) }],
      selBefore,
      selAfter,
    });
    markModelDirty();
    refreshFnDisplay();
    void tick().then(() => focusSel(selAfter));
  }

  // ── document-spine structure editing (D8 §2/§3/§5) ──────────────────────
  /**
   * Insert a NEW empty heading row ABOVE row r (D8 heading tools) and focus it
   * so the user types the label immediately. Document paragraph works only
   * (canEditRowStructure — where paragraphStarts never coexists, so nothing to
   * shift). Reuses the row-splice primitive: ordinal addresses re-derive, and
   * headingLevel + footnote anchoring ride on the row objects. ONE structural
   * undo entry removes it (headingLevel now round-trips in the snapshot). The
   * label lives in the row's English/translation cell; the Greek column stays
   * empty (a user-authored marker, not source text).
   */
  function performInsertHeading(r: number, level?: number) {
    if (!canEditRowStructure(scheme)) return;
    if (r < 0 || r > model.rows.length) return;
    // The tier is picked from the "Insert heading line ▸" submenu; fall back to
    // the shallowest in-page heading tier (else level 1) if invoked without one.
    const headingIdx = profile.levels.findIndex((l) => l.navRole === 'heading');
    const lvl = level ?? (headingIdx >= 0 ? headingIdx : 0) + 1;
    dismissAssist();
    history.breakCoalescing();
    const selBefore = focusedSelRef();
    const newRow: RowModel = {
      address: { scheme: model.scheme, raw: '' },
      greek: '',
      english: emptyRowDocJSON(),
      headingLevel: lvl,
    };
    spliceRows(r, 0, [newRow]);
    const selAfter: SelRef = { row: r, segment: 0, layer: activeLayer(), anchor: 0, head: 0 };
    history.push({
      edits: [],
      structural: { index: r, before: [], after: [structSnapshotOfRow(newRow)] },
      selBefore,
      selAfter,
    });
    markModelDirty();
    setStatus(`Inserted a ${levelName(profile, lvl)} line — type its text.`);
    void tick().then(() => {
      refreshFnDisplay();
      focusSel(selAfter);
    });
  }

  /**
   * Row-level PARAGRAPH SPLIT (D8 §2 — the user owns row count): model row r
   * becomes TWO rows at a validated word-start offset. Distribution is the
   * pure splitParagraphRow's: sentence boundaries partition, sentence
   * segments follow their sentences, englishPara stays entirely on the first
   * row. Ordinal addresses re-derive across the splice; ONE structural undo
   * entry restores the exact prior row.
   */
  function performParagraphSplit(r: number, offset: number) {
    if (!canEditRowStructure(scheme)) return;
    const row = model.rows[r];
    if (!row) return;
    commitRowNow(r); // this row's live para/sentence edits land in the model first
    const result = splitParagraphRow(row, offset);
    if (!result) {
      setStatus('Choose the word where the new paragraph starts.');
      return;
    }
    dismissAssist();
    history.breakCoalescing();
    const before = [structSnapshotOfRow(row)];
    const selBefore = focusedSelRef();
    const newRows = [rowModelFromStruct(result.first), rowModelFromStruct(result.second)];
    spliceRows(r, 1, newRows);
    const selAfter: SelRef = { row: r + 1, segment: 0, layer: 'para', anchor: 0, head: 0 };
    history.push({
      edits: [],
      structural: { index: r, before, after: newRows.map(structSnapshotOfRow) },
      selBefore,
      selAfter,
    });
    markModelDirty();
    void tick().then(() => {
      refreshFnDisplay();
      focusSel(selAfter);
    });
  }

  /** Row-level paragraph merge entry point: confirm-guarded ONLY when both
   * rows carry paragraph-layer English (the layer the merge actually joins —
   * the D6 un-split confirm pattern); otherwise merge immediately. */
  function requestParagraphMerge(r: number) {
    if (!canEditRowStructure(scheme)) return;
    if (r <= 0 || r >= model.rows.length) return;
    commitRowNow(r - 1);
    commitRowNow(r);
    if (paragraphMergeNeedsConfirm(model.rows[r - 1], model.rows[r])) {
      pendingParaMerge = { row: r };
      return;
    }
    performParagraphMerge(r);
  }

  function confirmParaMerge() {
    const p = pendingParaMerge;
    pendingParaMerge = null;
    if (p) performParagraphMerge(p.row);
  }

  function cancelParaMerge() {
    pendingParaMerge = null;
  }

  /**
   * Row-level PARAGRAPH MERGE (D8 §2): rows r-1 and r become one. Source
   * joins with a single space; sentence boundaries concatenate (the join
   * point becomes a boundary only where one exists); sentence segments
   * append; englishPara joins per mergeParagraphRows. ONE structural undo
   * entry restores both rows exactly.
   */
  function performParagraphMerge(r: number) {
    if (!canEditRowStructure(scheme)) return;
    const a = model.rows[r - 1];
    const b = model.rows[r];
    if (!a || !b) return;
    commitRowNow(r - 1);
    commitRowNow(r);
    const merged = mergeParagraphRows(a, b);
    dismissAssist();
    history.breakCoalescing();
    const before = [structSnapshotOfRow(a), structSnapshotOfRow(b)];
    const selBefore = focusedSelRef();
    const newRow = rowModelFromStruct(merged.row);
    spliceRows(r - 1, 2, [newRow]); // refreshes surviving/reused views itself
    const selAfter: SelRef = { row: r - 1, segment: 0, layer: 'para', anchor: merged.paraJoinPos, head: merged.paraJoinPos };
    history.push({
      edits: [],
      structural: { index: r - 1, before, after: [structSnapshotOfRow(newRow)] },
      selBefore,
      selAfter,
    });
    markModelDirty();
    void tick().then(() => {
      refreshFnDisplay();
      focusSel(selAfter);
    });
  }

  /**
   * SENTENCE fix-up on a paragraph row (D8 §3): the D6 splitOffsets
   * machinery under its sentence name — "Start new sentence here" adds a
   * boundary plus an empty segment (English stays with the sentence start,
   * never divided by guesswork). No row is created; the division shows in
   * the by-sentence interpolated view. ONE row-bundle undo entry.
   */
  function performSentenceSplit(r: number, offset: number) {
    const row = model.rows[r];
    if (!row) return;
    commitRowNow(r);
    const result = addSentenceBoundary(row, offset);
    if (!result) {
      setStatus(
        row.splitOffsets?.includes(offset)
          ? 'There is already a sentence break here.'
          : 'Choose the word where the new sentence starts.',
      );
      return;
    }
    dismissAssist();
    history.breakCoalescing();
    const before = snapshotRow(r);
    const selBefore = focusedSelRef();
    row.english = result.english;
    if (result.english2 && result.english2.length > 0) row.english2 = result.english2;
    else delete row.english2;
    row.splitOffsets = result.splitOffsets;
    refreshDisplayRows();
    history.push({
      edits: [{ row: r, before, after: snapshotRow(r) }],
      selBefore,
      selAfter: selBefore,
    });
    markModelDirty();
    refreshFnDisplay();
    setStatus('New sentence started — visible in the interpolated view, by sentence.');
  }

  /** "Join sentences" (D8 §3): remove the boundary at the start of the
   * clicked sentence via the SAME pure mergeSegments/confirm machinery as
   * the D6 un-split, with sentence wording on the confirm. */
  function requestSentenceJoin(r: number, boundary: number) {
    const row = model.rows[r];
    if (!row || boundary < 0 || boundary >= segmentCount(row) - 1) return;
    commitRowNow(r);
    if (mergeNeedsConfirm(row, boundary)) {
      pendingUnsplit = {
        row: r,
        boundary,
        message: 'Both sentences already have English — join them into one sentence?',
      };
      return;
    }
    performUnsplit(r, boundary);
  }

  /** Chunk grouping for plain-line docs (D8 §5): toggle this row's 1-based
   * ordinal in paragraph_starts. Pure display metadata — no row or text
   * changes — with its own undo entry; persists via paragraph_starts. */
  function toggleChunkStart(r: number, mode: 'add' | 'remove') {
    if (!canGroupLines(scheme) || r <= 0 || r >= model.rows.length) return;
    const ordinal = r + 1;
    const before = (model.paragraphStarts ?? []).slice();
    const after = mode === 'add' ? addParagraphStart(before, ordinal) : removeParagraphStart(before, ordinal);
    history.breakCoalescing();
    model.paragraphStarts = after.length > 0 ? after : undefined;
    const sel = focusedSelRef();
    history.push({
      edits: [],
      paraStarts: { before, after: after.slice() },
      selBefore: sel,
      selAfter: sel,
    });
    markModelDirty();
    refreshDisplayRows(); // chunkStartGrids re-derives from the fresh displayRows
    setStatus(mode === 'add' ? 'Paragraph starts here.' : 'Merged with the paragraph above.');
  }

  /** Set (or clear) a row's heading level (D8 heading tools). Document-spine
   * only; `level` is a 1-based rank into the work profile, null clears it.
   * Pushes its own undo/redo entry (headingLevel before/after) so a mis-mark is
   * one ⌘Z. Autosave persists it as the chapter-file `headers` frontmatter. */
  function setRowLevel(r: number, level: number | null) {
    if (scheme.spineSource !== 'document' || r < 0 || r >= model.rows.length) return;
    const before = model.rows[r].headingLevel ?? null;
    if (before === level) return;
    const sel = focusedSelRef();
    history.breakCoalescing();
    model.rows[r].headingLevel = level === null ? undefined : level;
    history.push({ edits: [], headingLevel: { row: r, before, after: level }, selBefore: sel, selAfter: sel });
    markModelDirty();
    refreshDisplayRows();
    setStatus(level === null ? 'Heading cleared.' : `Marked as ${levelName(profile, level)}.`);
  }

  /** Re-tier (or clear) a row from the RAIL right-click menu — same gated,
   * undoable mutator as the text "Mark as"; the outline refreshes through
   * refreshDisplayRows so the rail updates in place. */
  export function setRowLevelAt(rowIndex: number, level: number | null): void {
    setRowLevel(rowIndex, level);
  }

  /** Append a new heading line at the given nav-role's tier (rail "+ Book" /
   * "+ Chapter"): inserts an empty marked row at the end of the document and
   * focuses it so the user types its title. No-op if the profile has no tier
   * with that role, or the scheme can't carry heading rows. */
  export function appendHeadingForRole(role: NavRole): void {
    const idx = profile.levels.findIndex((l) => l.navRole === role);
    if (idx < 0) {
      // No tier of this role in the work's profile — tell the user rather than
      // failing silently (a default document has only heading tiers).
      setStatus(`This work has no ${role} tier yet — add one in “Manage levels…” first.`);
      return;
    }
    performInsertHeading(model.rows.length, idx + 1);
  }

  /** Set (or clear) a heading row's rail TITLE OVERRIDE (D8 heading tools) —
   * called from the rail's inline rename. Document-spine heading rows only; an
   * empty title clears the override (rail falls back to translation/original).
   * Its own ⌘Z step (headingTitle before/after); persisted to [HEADING_TITLES]. */
  export function setHeadingTitle(rowIndex: number, title: string): void {
    const r = rowIndex;
    if (scheme.spineSource !== 'document' || r < 0 || r >= model.rows.length) return;
    if (!model.rows[r].headingLevel) return; // only headings carry a title
    const next = title.replace(/[\r\n]+/g, ' ').trim();
    const before = model.rows[r].headingTitle ?? null;
    const after = next.length > 0 ? next : null;
    if (before === after) return;
    history.breakCoalescing();
    model.rows[r].headingTitle = after === null ? undefined : after;
    history.push({ edits: [], headingTitle: { row: r, before, after }, selBefore: null, selAfter: null });
    markModelDirty();
    refreshDisplayRows();
    setStatus(after === null ? 'Heading title cleared.' : `Renamed to “${after}”.`);
  }

  // ── commands (toolbar + shortcuts) ─────────────────────────────────────
  function applyMark(name: 'bold' | 'italic' | 'underline') {
    if (crossRowSelection()) {
      setStatus('Select within one row');
      return;
    }
    const view = focusedView();
    if (!view) {
      setStatus('Click into a row first');
      return;
    }
    history.breakCoalescing();
    toggleMark(rowSchema.marks[name])(view.state, view.dispatch);
    view.focus();
    syncToolbar(view.state);
  }

  function toggleGreek() {
    greekMode = !greekMode;
    session.greekMode = greekMode;
    const view = focusedView();
    if (view) {
      resetGreekRun(view);
      const greek = rowSchema.marks.greek;
      const stored = view.state.storedMarks ?? view.state.selection.$head.marks();
      const marks = greekMode
        ? greek.isInSet(stored)
          ? [...stored]
          : [...stored, greek.create()]
        : stored.filter((m) => m.type !== greek);
      view.dispatch(view.state.tr.setStoredMarks(marks).setMeta('appHistoryIgnore', true));
      view.focus();
      syncToolbar(view.state);
    }
    setStatus(greekMode ? 'Greek input on — Beta Code decodes as you type (⌘G to leave)' : 'Greek input off');
  }

  function insertFootnote() {
    // Para-layer guard (D8 Phase E2, D2 note #3): [ENGLISH.PARA] doesn't
    // model footnote markers, so footnotes can't be inserted while a
    // paragraph-layer view is focused — quiet no-op + notice.
    if (activeLayer() === 'para') {
      setStatus('Footnotes aren’t available when translating by paragraph — switch to a by-sentence view');
      return;
    }
    if (crossRowSelection()) {
      setStatus('Select within one row');
      return;
    }
    const view = focusedView();
    if (!view) {
      setStatus('Click into a row first');
      return;
    }
    const sel = view.state.selection;
    if (sel.empty) {
      setStatus('Select the phrase to footnote');
      return;
    }
    const i = focusedRow;
    const id = nextFootnoteId(model.footnotes);
    const before = cloneFootnotes(model.footnotes);
    model.footnotes.push({ id, body: '', anchored: true });
    pendingFn = { before, after: cloneFootnotes(model.footnotes) };

    history.breakCoalescing();
    const marker = rowSchema.nodes.footnoteMarker.create({ id });
    const tr = view.state.tr
      .addMark(sel.from, sel.to, rowSchema.marks.fnRef.create({ id }))
      .insert(sel.to, marker);
    tr.setSelection(TextSelection.create(tr.doc, sel.to + marker.nodeSize));
    tr.setMeta('noCoalesce', true);
    view.dispatch(tr);
    view.focus();

    setActiveFootnote(id);
    refreshFnDisplay();
    commitRowNow(i);
    // An open panel focuses the new entry's body field.
    session.fnFocusRequest = { id, ts: Date.now() };
  }

  // ── footnote panel commands ────────────────────────────────────────────
  /** The (row, segment) whose doc holds footnote id's marker, if any. */
  function anchorLocOf(id: string): { row: number; segment: number } | null {
    for (let i = 0; i < model.rows.length; i++) {
      const docs = rowDocs(i);
      for (let s = 0; s < docs.length; s++) {
        if (markerIdsIn(docs[s]).includes(id)) return { row: i, segment: s };
      }
    }
    return null;
  }

  function focusFootnote(id: string) {
    setActiveFootnote(id);
    const loc = anchorLocOf(id);
    if (!loc) return;
    const g = gridOrdinalOf(loc.row, loc.segment);
    if (g < 0) return;
    gridEl
      ?.querySelector(`[data-row-en="${g}"]`)
      ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  /** Delete marker + fnRef mark + body as ONE undo entry. */
  function deleteFootnote(id: string) {
    const fnIdx = model.footnotes.findIndex((f) => f.id === id);
    const loc = anchorLocOf(id);
    if (fnIdx < 0 && !loc) return;

    history.breakCoalescing();
    const fnBefore = cloneFootnotes(model.footnotes);
    if (fnIdx >= 0) model.footnotes.splice(fnIdx, 1);
    const fnAfter = cloneFootnotes(model.footnotes);

    if (loc) {
      const view = viewAt(loc.row, loc.segment);
      if (view) {
        const oldState = view.state;
        const offsets = model.rows[loc.row].splitOffsets;
        const beforeDocs = rowDocs(loc.row); // marker still present here
        const runs: InlineRun[] = runsOf(oldState.doc)
          .filter((r) => !(r.kind === 'marker' && r.id === id))
          .map((r) =>
            r.kind === 'text' && r.marks.fnRef === id ? { ...r, marks: { ...r.marks, fnRef: undefined } } : r,
          );
        const after = buildRowDoc(runs);
        view.dispatch(
          view.state.tr
            .replaceWith(0, oldState.doc.content.size, after.content)
            .setMeta('appHistoryIgnore', true)
            .setMeta(FN_REFRESH, true),
        );
        commitRowNow(loc.row, true);
        history.push({
          edits: [
            {
              row: loc.row,
              before: { docs: beforeDocs, ...(offsets ? { splitOffsets: offsets.slice() } : {}) },
              after: snapshotRow(loc.row),
            },
          ],
          fnBefore,
          fnAfter,
          selBefore: selRefOf(loc.row, loc.segment, oldState),
          selAfter: selRefOf(loc.row, loc.segment, view.state),
        });
      }
    } else {
      history.push({ edits: [], fnBefore, fnAfter, selBefore: null, selAfter: null });
      markModelDirty();
    }

    if (activeFn === id) setActiveFootnote(null);
    refreshFnDisplay();
    setStatus('Footnote deleted');
  }

  /** Re-anchor an unanchored footnote at the current selection. */
  function reanchorFootnote(id: string) {
    const fn = model.footnotes.find((f) => f.id === id);
    if (!fn || fn.anchored) return;
    if (crossRowSelection()) {
      setStatus('Select within one row');
      return;
    }
    const view = focusedView();
    if (!view) {
      setStatus('Click into a row first — the footnote anchors at your selection');
      return;
    }
    const sel = view.state.selection;

    history.breakCoalescing();
    const before = cloneFootnotes(model.footnotes);
    fn.anchored = true;
    pendingFn = { before, after: cloneFootnotes(model.footnotes) };

    const marker = rowSchema.nodes.footnoteMarker.create({ id });
    const tr = view.state.tr;
    if (!sel.empty) tr.addMark(sel.from, sel.to, rowSchema.marks.fnRef.create({ id }));
    tr.insert(sel.to, marker);
    tr.setSelection(TextSelection.create(tr.doc, sel.to + marker.nodeSize));
    tr.setMeta('noCoalesce', true);
    view.dispatch(tr);
    view.focus();

    setActiveFootnote(id);
    refreshFnDisplay();
    commitRowNow(focusedRow);
    setStatus('Footnote re-anchored');
  }

  /** Body edit from the panel: its own undo entry, rides autosave. */
  function updateFootnoteBody(id: string, body: string) {
    const fn = model.footnotes.find((f) => f.id === id);
    if (!fn || fn.body === body) return;
    const fnBefore = cloneFootnotes(model.footnotes);
    fn.body = body;
    const fnAfter = cloneFootnotes(model.footnotes);
    history.breakCoalescing();
    history.push({ edits: [], fnBefore, fnAfter, selBefore: null, selAfter: null });
    markModelDirty();
    publishFootnotes();
  }

  // ── paste distribution ─────────────────────────────────────────────────
  function requestPasteDistribute(grid: number, segments: string[]) {
    pendingPaste = { grid, segments };
  }

  function confirmPaste() {
    const pending = pendingPaste;
    pendingPaste = null;
    if (!pending) return;
    const { grid, segments } = pending;

    const first = displayRows[grid];
    if (!first) return;
    const firstView = viewAt(first.rowIndex, first.segment);
    if (!firstView) return;
    const selBefore = selRefOf(first.rowIndex, first.segment, firstView.state);

    withScrollAnchor(grid, () => {
      // Group edits per MODEL row (the undo payload is the row's segment
      // bundle) while distributing text per DISPLAY row.
      const touched: number[] = [];
      const beforeByRow = new Map<number, RowSnapshot>();
      let applied = 0;
      for (let k = 0; k < segments.length; k++) {
        const d = displayRows[grid + k];
        if (!d) break;
        const view = viewAt(d.rowIndex, d.segment);
        if (!view) break;
        if (!beforeByRow.has(d.rowIndex)) {
          beforeByRow.set(d.rowIndex, snapshotRow(d.rowIndex));
          touched.push(d.rowIndex);
        }
        const beforeDoc = view.state.doc;
        const runs: InlineRun[] =
          k === 0
            ? [...runsOf(beforeDoc), { kind: 'text', text: segments[k], marks: {} }]
            : [{ kind: 'text', text: segments[k], marks: {} }];
        const after = buildRowDoc(runs);
        view.dispatch(
          view.state.tr
            .replaceWith(0, view.state.doc.content.size, after.content)
            .setMeta('appHistoryIgnore', true),
        );
        applied++;
      }
      const edits: UndoEntry['edits'] = touched.map((r) => {
        commitRowNow(r, true);
        return { row: r, before: beforeByRow.get(r)!, after: snapshotRow(r) };
      });
      history.breakCoalescing();
      const lastG = grid + applied - 1;
      const lastD = applied > 0 ? displayRows[lastG] : null;
      history.push({
        edits,
        selBefore,
        selAfter: lastD
          ? {
              row: lastD.rowIndex,
              segment: lastD.segment,
              anchor: segmentDoc(lastD.rowIndex, lastD.segment).content.size,
              head: segmentDoc(lastD.rowIndex, lastD.segment).content.size,
            }
          : null,
      });
      if (lastD) focusRowEnd(lastG);
    });
    setStatus(`Pasted ${segments.length} lines into ${segments.length} rows`);
  }

  function cancelPaste() {
    const grid = pendingPaste?.grid ?? -1;
    pendingPaste = null;
    if (grid >= 0) focusRowEnd(grid);
  }

  // ── per-row plugin wiring ──────────────────────────────────────────────
  // The context is bound to the CELL identity (row, segment); its `index` is
  // a live getter for the current grid ordinal, so navigation stays correct
  // when a split above shifts the grid (design doc D6, deep-reasoner §3).
  function rowContext(row: number, segment: number): RowContext {
    return {
      get index() {
        return gridOrdinalOf(row, segment);
      },
      rowCount: () => displayRows.length,
      isRowEmpty: (k) => gridDocSize(k) === 0,
      isContinuation: (k) => displayRows[k]?.continuation ?? false,
      focusRowEnd,
      focusRowStart,
      focusRowAtX,
      getSavedX: () => savedX,
      setSavedX: (x) => (savedX = x),
      clearSavedX: () => (savedX = null),
      flash,
      hint: setStatus,
      toast: setStatus,
      toggleGreek,
      undo,
      redo,
      insertFootnote,
      requestPasteDistribute,
      requestAssist: () => invokeAssist(row, segment),
    };
  }

  const host: RowViewHost = {
    createView(row, segment, el, layer) {
      // A keyed remount may CREATE the new cell for a (row, segment, layer)
      // before the old cell is destroyed (a row splice shifts indices onto
      // keys other rows held — D8 §2). Evict the stale view so the newest
      // mount owns the key; the old cell's destroyView then no-ops via
      // evictedViewKeys. Outside a structural window the old view's text is
      // committed first (belt and braces — nothing typed may be lost).
      const stale = views.get(vkey(row, segment, layer));
      if (stale) {
        if (!structuralRemount) commitRowNow(row);
        stale.destroy();
        views.delete(vkey(row, segment, layer));
        evictedViewKeys.add(vkey(row, segment, layer));
      }
      const r = model.rows[row];
      const json =
        layer === 'para'
          ? (r.englishPara ?? emptyRowDocJSON())
          : segment === 0
            ? r.english
            : (r.english2?.[segment - 1] ?? emptyRowDocJSON());
      const state = EditorState.create({
        doc: docFromJSON(json),
        plugins: [
          greekInput({ isGreekMode: () => greekMode }),
          ...rowPlugins(rowContext(row, segment)),
          footnotePlugin({
            displayNumber: fnDisplayNumber,
            activeFootnoteId: () => activeFn,
            setActiveFootnote,
            showAllAnchors: () => session.fnPanelOpen,
          }),
        ],
      });
      const view = new EditorView(el, {
        state,
        dispatchTransaction: dispatchFor(row, segment, layer),
        handleDOMEvents: {
          focus: (v) => {
            focusedRow = row;
            focusedSegment = segment;
            focusRow = row;
            focusSeg = segment;
            syncToolbar(v.state);
            // Keep the ask target on the line you're on, so an already-open
            // Ask panel follows the caret.
            setAskTarget(row);
            return false;
          },
          blur: () => {
            commitRowNow(row);
            // Drop the Greek/gutter whisper when THIS cell loses focus (a newer
            // focus event re-sets it first, so cell-to-cell moves don't flicker).
            if (focusRow === row && focusSeg === segment) {
              focusRow = -1;
              focusSeg = -1;
            }
            return false;
          },
        },
      });
      views.set(vkey(row, segment, layer), view);
    },
    destroyView(row, segment, layer) {
      // A row splice's keyed remount may have already EVICTED this cell's
      // view (a newer mount claimed the same key before this teardown ran —
      // see createView): the map now holds the NEW cell's view, which must
      // not be destroyed here.
      if (evictedViewKeys.delete(vkey(row, segment, layer))) return;
      const view = views.get(vkey(row, segment, layer));
      if (!view) return;
      // Commit only while the model still HAS this cell — after an un-split
      // the stale continuation unmounts and must not clobber the freshly
      // merged row (paragraph cells always exist while the row does).
      const alive = layer === 'para' ? row < model.rows.length : row < model.rows.length && segment < segmentCount(model.rows[row]);
      if (alive) commitRowNow(row);
      view.destroy();
      views.delete(vkey(row, segment, layer));
    },
    requestAssist: (row, segment) => invokeAssist(row, segment),
    assistStateFor: (row, segment) => (assistRow === row && assistSeg === segment ? assistUi : null),
    assistAnchor: () => assistAnchorPos,
    insertSuggestion: (row, segment, text) => insertSuggestionIntoRow(row, segment, text),
    dismissAssist,
  };

  // ── lifecycle ──────────────────────────────────────────────────────────
  const editorCommands: EditorCommands = {
    toggleMark: applyMark,
    toggleGreek,
    insertFootnote,
    undo,
    redo,
    copyCitation,
  };

  const footnoteCommands: FootnoteCommands = {
    focusFootnote,
    deleteFootnote,
    reanchorFootnote,
    updateFootnoteBody,
    setActiveFootnote,
  };

  const syncCommandsImpl: SyncCommands = {
    checkExternalChange,
  };

  const assistCommandsImpl: AssistCommands = {
    askAboutLine,
    closeAiPanel,
    copyAiPanel,
  };

  function onWindowKeydown(e: KeyboardEvent) {
    if (e.defaultPrevented) return;
    const mod = e.metaKey || e.ctrlKey;
    if (!mod || e.altKey) return;
    // Zoom the working text: ⌘+ / ⌘- / ⌘0 (⌘= is the unshifted "+"). `+` and `=`
    // share a key, and `_` shares `-`, so match both forms.
    if (e.key === '=' || e.key === '+') {
      e.preventDefault();
      zoomIn();
    } else if (e.key === '-' || e.key === '_') {
      e.preventDefault();
      zoomOut();
    } else if (e.key === '0') {
      e.preventDefault();
      zoomReset();
    } else if (e.key === 'z' || e.key === 'Z') {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    } else if (e.key === 'y') {
      e.preventDefault();
      redo();
    } else if (e.shiftKey && (e.key === 'c' || e.key === 'C')) {
      e.preventDefault();
      void copyCitation();
    }
  }

  function onWindowBlur() {
    flushPending();
  }

  function onVisibilityHidden() {
    if (document.visibilityState === 'hidden') flushPending();
  }

  function onRootKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape' && pendingBatchTranslate) {
      e.preventDefault();
      cancelBatchTranslate();
      return;
    }
    if (e.key === 'Escape' && ctxMenu) {
      e.preventDefault();
      ctxMenu = null;
      return;
    }
    if (e.key === 'Escape' && pendingUnsplit) {
      e.preventDefault();
      cancelUnsplit();
      return;
    }
    if (e.key === 'Escape' && pendingParaMerge) {
      e.preventDefault();
      cancelParaMerge();
      return;
    }
    if (e.key === 'Escape' && assistUi) {
      e.preventDefault();
      dismissAssist();
      return;
    }
    if (e.key === 'Escape' && pendingPaste) {
      e.preventDefault();
      cancelPaste();
    }
  }

  // Context menu: any mousedown outside it closes it (capture phase so a
  // click that also focuses a row still closes the menu first).
  $effect(() => {
    if (!ctxMenu) return;
    const close = (ev: MouseEvent) => {
      const target = ev.target as Element | null;
      if (!target?.closest('.ctx-menu')) ctxMenu = null;
    };
    window.addEventListener('mousedown', close, true);
    return () => window.removeEventListener('mousedown', close, true);
  });

  // Panel open/close: repaint anchor highlights on every row.
  $effect(() => {
    const open = session.fnPanelOpen;
    if (!ready) return;
    for (const view of views.values()) {
      view.dispatch(view.state.tr.setMeta(FN_REFRESH, true).setMeta('appHistoryIgnore', true));
    }
    if (open) publishFootnotes();
  });

  // Settle guard: ONE ResizeObserver on the grid container — caret
  // visibility re-assert only, coalesced through a single rAF. It never
  // writes heights (the flat grid owns those).
  $effect(() => {
    if (!ready || !gridEl) return;
    let settleQueued = false;
    const ro = new ResizeObserver(() => {
      if (settleQueued) return;
      settleQueued = true;
      requestAnimationFrame(() => {
        settleQueued = false;
        const view = focusedView();
        if (view?.hasFocus()) {
          view.dispatch(view.state.tr.scrollIntoView().setMeta('appHistoryIgnore', true));
        }
      });
    });
    ro.observe(gridEl);
    return () => ro.disconnect();
  });

  onMount(() => {
    registerEditor(editorCommands, footnoteCommands, syncCommandsImpl, assistCommandsImpl);
    session.greekMode = false;

    const unsubIndex = onFootnoteIndexChange((workId) => {
      if (workId === model.workId) void reloadFnBase();
    });

    window.addEventListener('keydown', onWindowKeydown);
    window.addEventListener('blur', onWindowBlur);
    window.addEventListener('pointerup', clearSelectionColumn);
    window.addEventListener('pointercancel', clearSelectionColumn);
    document.addEventListener('visibilitychange', onVisibilityHidden);

    void initChapter();

    return () => {
      destroyed = true;
      assistCtl.cancel(); // in-flight suggestion can never land in a gone chapter
      askAbort?.abort(); // in-flight ask can never answer in a gone chapter
      askAbort = null;
      // Abort the AI panel's in-flight request and clear the bridge.
      aiPanelAbort?.abort();
      aiPanelAbort = null;
      session.aiPanel = null;
      batchAbort?.abort(); // stop any in-flight multi-line translate
      batchAbort = null;
      pendingBatchTranslate = null;
      window.removeEventListener('keydown', onWindowKeydown);
      window.removeEventListener('blur', onWindowBlur);
      window.removeEventListener('pointerup', clearSelectionColumn);
      window.removeEventListener('pointercancel', clearSelectionColumn);
      document.removeEventListener('visibilitychange', onVisibilityHidden);
      unsubIndex();
      // Chapter switch: commit every row, then flush BEFORE the next chapter
      // loads (loadChapterFile awaits this write via the pending registry).
      for (let i = 0; i < model.rows.length; i++) commitRowNow(i);
      void autosave?.dispose();
      unregisterEditor(editorCommands);
    };
  });
</script>

<div
  class="chapter-editor"
  bind:this={rootEl}
  style="--zoom: {zoom.factor}"
  oncopy={onCopy}
  oncut={onCut}
  onkeydown={onRootKeydown}
>
  {#if ready}
    <header class="chapter-head">
      <h1>
        {workTitle ?? model.workTitle}
        <span class="chapter-head-ref">{model.bookLabel}.{model.chapter} · {model.bekkerRange}</span>
      </h1>
      {#if toggleModes.length > 1}
        <!-- View-mode toggle (D8 §5): only shown when more than one legal
             view exists. Sits in the chapter chrome (not the top-bar) because
             legality is per-work — it needs this editor's scheme. -->
        <div class="view-toggle" role="group" aria-label="View mode">
          {#each toggleModes as m (m)}
            <button
              class="view-toggle-btn"
              class:active={viewMode === m}
              type="button"
              aria-pressed={viewMode === m}
              onmousedown={(e) => e.preventDefault()}
              onclick={() => chooseView(m)}
            >{viewLabel(m)}</button>
          {/each}
        </div>
      {/if}
      {#if granularityToggle}
        <!-- Interpolated granularity sub-toggle (D8 §5): offered only while
             the interpolated view is active on a document-spine paragraph doc
             (showGranularityToggle) — 'unit' edits englishPara per paragraph,
             'sentence' edits the normal sentence layer per sentence. -->
        <div class="view-toggle" role="group" aria-label="Interpolated granularity">
          <button
            class="view-toggle-btn"
            class:active={granularity === GRAN_UNIT}
            type="button"
            aria-pressed={granularity === GRAN_UNIT}
            onmousedown={(e) => e.preventDefault()}
            onclick={() => chooseGranularity(GRAN_UNIT)}
          >By paragraph</button>
          <button
            class="view-toggle-btn"
            class:active={granularity === GRAN_SENTENCE}
            type="button"
            aria-pressed={granularity === GRAN_SENTENCE}
            onmousedown={(e) => e.preventDefault()}
            onclick={() => chooseGranularity(GRAN_SENTENCE)}
          >By sentence</button>
        </div>
      {/if}
      {#if showLayoutToggle}
        <!-- Interpolated layout sub-toggle (John 2026-07-14): line docs only.
             `Lane` flows the Greek over a per-line English lane; `Weave` puts
             each line's English inline after its Greek. Both keep the per-line
             English model, so the Lines view stays aligned. -->
        <div class="view-toggle" role="group" aria-label="Interpolated layout">
          <button
            class="view-toggle-btn"
            class:active={interpLayout === LAYOUT_LANE}
            type="button"
            aria-pressed={interpLayout === LAYOUT_LANE}
            onmousedown={(e) => e.preventDefault()}
            onclick={() => chooseInterpLayout(LAYOUT_LANE)}
          >Lane</button>
          <button
            class="view-toggle-btn"
            class:active={interpLayout === LAYOUT_WEAVE}
            type="button"
            aria-pressed={interpLayout === LAYOUT_WEAVE}
            onmousedown={(e) => e.preventDefault()}
            onclick={() => chooseInterpLayout(LAYOUT_WEAVE)}
          >Weave</button>
        </div>
      {/if}
      {#if saveLabel}
        <span class="save-state" data-state={saveBlocked ? 'blocked' : saveState} role="status">{saveLabel}</span>
      {/if}
      {#if loadNotice}
        <p class="load-notice">{loadNotice}</p>
      {/if}
    </header>

    {#if viewMode === MODE_INTERPOLATED}
      <!-- INTERPOLATED view (D8 §5): a single-column stack — for each display
           unit, the English field on top with the display-only original
           beneath it. Same displayRows / same keyed identity as the grid, so
           navigation, commit, undo and assist plumbing are untouched. The
           original is plain text (never an editor); right-clicking it opens
           the full structure menu (refinement pass — see
           onInterpSourceContextMenu), the field the AI-only one. -->
      {#if interpFlowing}
        <!-- FLOWING interpolated view (line docs, John 2026-07-14): the Greek
             reads as continuous prose; the per-line English stays separate
             editable cells (SAME displayRows / keyed identity / host as the
             grid, so commit/undo/assist/paste are inherited), so switching to
             Lines still lines up. `lane` = Greek block over a per-line English
             lane; `weave` = each line's English inline after its own Greek. -->
        {#snippet flowEnCell(d: DisplayRow, g: number)}
          <EnglishCell
            gridRow={g}
            row={d.rowIndex}
            segment={d.segment}
            layer="sentence"
            sentenceText={null}
            {host}
            flash={flashRowIdx === g}
            headingLevel={d.headingLevel}
            subtitle={isSubtitleLevel(d.headingLevel)}
            pasteConfirm={pendingPaste?.grid === g ? pendingPaste.segments.length : null}
            onPasteConfirm={confirmPaste}
            onPasteCancel={cancelPaste}
            unsplitConfirm={pendingUnsplit?.row === d.rowIndex && d.segment === 0}
            unsplitMessage={pendingUnsplit?.message ?? null}
            onUnsplitConfirm={confirmUnsplit}
            onUnsplitCancel={cancelUnsplit}
            onContext={(e) => onEnglishContextMenu(e, g)}
          />
        {/snippet}
        {#if interpLayout === LAYOUT_WEAVE}
          <!-- Interlinear weave (John's mockup): each Bekker line is a
               Greek-over-English pair; the pairs are inline-block and flow /
               wrap, so the Greek reads as continuous prose while each line's
               English sits directly beneath its own words. -->
          <div class="interp-flow weave" bind:this={gridEl}>
            {#each displayRows as d, g (d.key)}{#if d.continuation}<div class="flow-break" aria-hidden="true"></div>{/if}<!-- svelte-ignore a11y_no_static_element_interactions --><div
                class="weave-pair"
                class:lit={focusRow === d.rowIndex && focusSeg === d.segment}
                class:row-heading={!!d.headingLevel && !isSubtitleLevel(d.headingLevel)}
                class:row-subtitle={isSubtitleLevel(d.headingLevel)}
                data-heading-level={isSubtitleLevel(d.headingLevel) ? undefined : (d.headingLevel ?? undefined)}
                data-row={g}
              ><div
                  class="weave-grc flow-grc"
                  lang="grc"
                  oncontextmenu={(e) => onInterpSourceContextMenu(e, g)}
                ><span class="flow-tick">{tickFor(d.address.raw, g)}</span>{d.greekSlice}</div><div class="weave-en">{@render flowEnCell(d, g)}</div></div>{/each}
          </div>
        {:else}
          <!-- Lane (John's spec): alternating paragraphs — a flowing Greek
               paragraph, then a flowing English paragraph directly beneath it,
               for each paragraph (split at every D6 line-split). The English
               cells flow inline so the translation reads continuously, not one
               stacked line per row. -->
          <div class="interp-flow lane" bind:this={gridEl}>
            {#each flowParagraphs as para (para.key)}
              <section
                class="flow-para"
                class:flow-heading={para.heading}
                class:row-heading={!!para.rows[0]?.d.headingLevel && !isSubtitleLevel(para.rows[0]?.d.headingLevel)}
                class:row-subtitle={isSubtitleLevel(para.rows[0]?.d.headingLevel)}
                data-heading-level={isSubtitleLevel(para.rows[0]?.d.headingLevel) ? undefined : (para.rows[0]?.d.headingLevel ?? undefined)}
              >
                <!-- svelte-ignore a11y_no_static_element_interactions -->
                <div class="flow-grc-block" lang="grc">
                  {#each para.rows as { d, g } (d.key)}<span
                      class="flow-grc"
                      class:lit={focusRow === d.rowIndex && focusSeg === d.segment}
                      data-row={g}
                      oncontextmenu={(e) => onInterpSourceContextMenu(e, g)}
                    ><sup class="flow-tick">{tickFor(d.address.raw, g)}</sup>{d.greekSlice}</span>{' '}{/each}
                </div>
                <div class="flow-en-block">
                  {#each para.rows as { d, g } (d.key)}<span
                      class="flow-en-seg"
                      class:lit={focusRow === d.rowIndex && focusSeg === d.segment}
                    ><sup class="flow-tick en-tick">{tickFor(d.address.raw, g)}</sup>{@render flowEnCell(d, g)}</span>{' '}{/each}
                </div>
              </section>
            {/each}
          </div>
        {/if}
      {:else}
      <div class="interp-stack" bind:this={gridEl}>
        {#each displayRows as d, g (d.key)}
          <InterpolatedUnit
            gridRow={g}
            row={d.rowIndex}
            segment={d.segment}
            {host}
            layer={paragraphUnitView ? 'para' : 'sentence'}
            addr={d.address.raw}
            slices={interpSlices(d)}
            paraText={paragraphUnitView || d.segment !== 0 ? null : paraLayerText(d.rowIndex)}
            sentenceText={paragraphUnitView ? sentenceLayerText(d.rowIndex) : null}
            headingLevel={d.headingLevel}
            subtitle={isSubtitleLevel(d.headingLevel)}
            flash={flashRowIdx === g}
            focused={focusRow === d.rowIndex && focusSeg === d.segment}
            chunkStart={chunkStartGrids.has(g)}
            pasteConfirm={pendingPaste?.grid === g ? pendingPaste.segments.length : null}
            onPasteConfirm={confirmPaste}
            onPasteCancel={cancelPaste}
            unsplitConfirm={pendingUnsplit?.row === d.rowIndex && d.segment === 0}
            unsplitMessage={pendingUnsplit?.message ?? null}
            onUnsplitConfirm={confirmUnsplit}
            onUnsplitCancel={cancelUnsplit}
            onContext={(e) => onEnglishContextMenu(e, g)}
            onSourceContext={(e) => onInterpSourceContextMenu(e, g)}
          />
        {/each}
      </div>
      {/if}
    {:else}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <!-- The three columns are grouped in DOM order (all Greek, then all
         gutters, then all English) rather than interleaved per row, so a drag
         across Greek lines can't run through the English cells that would
         otherwise sit between rows — the highlight (and any copied text) stays
         within one language. Visual layout is unchanged: every cell is placed
         by explicit grid-row + grid-column, so DOM order is free. -->
    <div
      class="chapter-grid"
      class:view-paragraph={wrapColumns}
      class:view-para-unit={paragraphUnitView}
      bind:this={gridEl}
      onpointerdown={onGridPointerDown}
    >
      {#each displayRows as d, g (d.key)}
        <GreekCell
          gridRow={g}
          greek={d.greekSlice}
          continuation={d.continuation}
          flash={flashRowIdx === g}
          focused={focusRow === d.rowIndex && focusSeg === d.segment}
          chunkStart={chunkStartGrids.has(g)}
          headingLevel={d.headingLevel}
          subtitle={isSubtitleLevel(d.headingLevel)}
          onContext={(e) => onGreekContextMenu(e, g)}
        />
      {/each}
      {#each displayRows as d, g (d.key)}
        <RowGutter
          gridRow={g}
          raw={d.address.raw}
          focused={focusRow === d.rowIndex && focusSeg === d.segment}
          chunkStart={chunkStartGrids.has(g)}
        />
      {/each}
      {#each displayRows as d, g (d.key)}
        <EnglishCell
          gridRow={g}
          row={d.rowIndex}
          segment={d.segment}
          layer={paragraphUnitView ? 'para' : 'sentence'}
          sentenceText={paragraphUnitView ? sentenceLayerText(d.rowIndex) : null}
          {host}
          flash={flashRowIdx === g}
          chunkStart={chunkStartGrids.has(g)}
          headingLevel={d.headingLevel}
          subtitle={isSubtitleLevel(d.headingLevel)}
          pasteConfirm={pendingPaste?.grid === g ? pendingPaste.segments.length : null}
          onPasteConfirm={confirmPaste}
          onPasteCancel={cancelPaste}
          unsplitConfirm={pendingUnsplit?.row === d.rowIndex && d.segment === 0}
          unsplitMessage={pendingUnsplit?.message ?? null}
          onUnsplitConfirm={confirmUnsplit}
          onUnsplitCancel={cancelUnsplit}
          onContext={(e) => onEnglishContextMenu(e, g)}
        />
      {/each}
    </div>
    {/if}
  {/if}

  {#if ctxMenu}
    <!-- Items, wording and grouping all come from buildCtxMenu (ctxMenu.ts)
         — the per-view matrix is decided (and tested) there, never here. -->
    <div class="ctx-menu" role="menu" style="left: {ctxMenu.x}px; top: {ctxMenu.y}px; max-height: {ctxMenu.maxHeight}px">
      {#each ctxMenu.model.groups as group, gi (gi)}
        {#if gi > 0}
          <div class="ctx-menu-divider" role="separator"></div>
        {/if}
        {#each group as item (item.title)}
          {#if item.submenu}
            <button
              class="ctx-menu-item has-submenu"
              type="button"
              role="menuitem"
              aria-haspopup="menu"
              onmouseenter={(e) => openMarkSubmenu(e, item.submenu ?? [])}
              onfocus={(e) => openMarkSubmenu(e, item.submenu ?? [])}
              onclick={(e) => openMarkSubmenu(e, item.submenu ?? [])}
            >
              <span class="ctx-menu-title">{item.title}</span>
              <span class="ctx-submenu-caret" aria-hidden="true">▸</span>
            </button>
          {:else}
            <button
              class="ctx-menu-item"
              type="button"
              role="menuitem"
              onmouseenter={() => (openSubmenu = null)}
              onfocus={() => (openSubmenu = null)}
              onclick={() => runMenuItem(item)}
            >
              <span class="ctx-menu-title">{item.title}</span>
              {#if item.desc}
                <span class="ctx-menu-desc">{item.desc}</span>
              {/if}
            </button>
          {/if}
        {/each}
      {/each}
    </div>
    {#if openSubmenu}
      <!-- Separate fixed element so the scrollable parent's overflow can't clip
           it; coordinates are viewport-clamped in openMarkSubmenu. -->
      <div
        class="ctx-menu ctx-submenu"
        role="menu"
        style="left: {openSubmenu.x}px; top: {openSubmenu.y}px; max-height: {openSubmenu.maxHeight}px"
      >
        {#each openSubmenu.items as sub (sub.title)}
          <button
            class="ctx-menu-item ctx-menu-choice"
            class:checked={sub.checked}
            type="button"
            role="menuitem"
            aria-checked={sub.checked ? 'true' : undefined}
            onclick={() => runMenuItem(sub)}
          >
            <span class="ctx-menu-check" aria-hidden="true">{sub.checked ? '✓' : ''}</span>
            <span class="ctx-menu-title">{sub.title}</span>
          </button>
        {/each}
      </div>
    {/if}
  {/if}

  {#if session.status}
    <div class="status-pill" role="status">{session.status.text}</div>
  {/if}

  {#if pendingBatchTranslate}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="batch-scrim" role="presentation" onclick={cancelBatchTranslate}>
      <div
        class="batch-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-label="Confirm overwrite"
        tabindex="-1"
        onclick={(e) => e.stopPropagation()}
      >
        <p class="batch-msg">
          {pendingBatchTranslate.withText} of the {pendingBatchTranslate.rows.length} selected
          {pendingBatchTranslate.rows.length === 1 ? pendingBatchTranslate.noun : `${pendingBatchTranslate.noun}s`} already
          {pendingBatchTranslate.withText === 1 ? 'has' : 'have'} a translation.
          Translate all {pendingBatchTranslate.rows.length} and <strong>replace</strong> the existing English?
        </p>
        <div class="batch-actions">
          <button class="batch-btn" type="button" onclick={cancelBatchTranslate}>Cancel</button>
          <button class="batch-btn batch-btn-danger" type="button" onclick={confirmBatchTranslate}>
            Translate &amp; replace
          </button>
        </div>
      </div>
    </div>
  {/if}

  {#if pendingParaMerge}
    <!-- Paragraph-merge confirm (D8 §2): shown ONLY when both rows carry a
         paragraph-layer translation — the merge joins them with a space. -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="batch-scrim" role="presentation" onclick={cancelParaMerge}>
      <div
        class="batch-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-label="Confirm paragraph merge"
        tabindex="-1"
        onclick={(e) => e.stopPropagation()}
      >
        <p class="batch-msg">
          Both paragraphs already have a translation. Merge them and
          <strong>join</strong> their English into one paragraph?
        </p>
        <div class="batch-actions">
          <button class="batch-btn" type="button" onclick={cancelParaMerge}>Cancel</button>
          <button class="batch-btn batch-btn-danger" type="button" onclick={confirmParaMerge}>
            Merge &amp; join
          </button>
        </div>
      </div>
    </div>
  {/if}
</div>
