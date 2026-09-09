<script lang="ts">
  // The import flow, end to end: Edition → configured layout stages →
  // conversion → metadata → tag scan + alignment → completion summary.
  //
  // The completion summary is a first-class moment, not a log line — it is
  // where "estimates are always labelled" becomes visible to a first-time
  // importer: tagged anchors, alignment-placed anchors, and interpolated
  // (estimate) lines are reported separately and honestly.
  import { onMount, onDestroy } from 'svelte';
  import { WORKS } from '@shared/lib/works';
  import {
    runImport,
    DivisionGapError,
    ImportCollision,
    type ImportSummary,
  } from '../lib/imports';
  import { parseTranslationFile, composeCitation, emphasisScanInput, splitFrontmatter } from '../lib/translation-file';
  import { dehyphenate, listReviewItems, resolveReviews, type ReviewItem } from '../lib/dehyphenate';
  import { scanEmphasis, listEmphasisReviewItems, type EmphasisReviewItem } from '../lib/emphasis';
  import { isLayoutExtraction, type ConvertOptions, type ConvertReport } from '../lib/pdf-import';
  import {
    applyDeletionProposals,
    applyPageBreakJoins,
    beginTaggedPreClean,
    finishTaggedNormalization,
    hasChapterTag,
    lineModeMatters,
    proposePageBreakJoins,
    rebuildPreCleanSource,
    scanDeletionProposals,
    splitPreCleanSource,
    type DeletionScan,
    type PageJoinProposal,
    type PreCleanLineMode,
    type StripCounts,
    type TaggedPreCleanStart,
  } from '../lib/import-preclean';
  import { isTauri, errorText } from '../lib/runtime';
  import {
    DEFAULT_PUBLISHER_PRESET_ID,
    PUBLISHER_PRESETS,
    getPublisherPreset,
    resolveWorkStructure,
    type FootnotePlacement,
    type ImportEditionConfig,
    type PublisherPresetId,
    type ResolvedWorkStructure,
  } from '../lib/import-presets';
  import {
    prepareLayoutImport,
    type LayoutStageReport,
    type PreparedLayoutImport,
  } from '../lib/import-layout-stages';
  import { divisionAuditLine, divisionGapLabel, type DivisionAuditResult } from '../lib/division-audit';
  import type { UnlistenFn } from '@tauri-apps/api/event';

  export let file: { name: string; text: string } | null = null;
  export let presetWork: string | null = null;   // pre-filled when launched from a work
  export let onClose: (imported: ImportSummary | null) => void;

  type Step =
    | 'pick' | 'edition' | 'form' | 'review' | 'line-mode' | 'page-join-review' | 'deletion-review'
    | 'emph-review' | 'running' | 'collision' | 'done' | 'error'
    | 'division-waiver' | 'coverage'
    // Phase 4B: the PDF-conversion pre-stage's own outcomes, ahead of the form.
    | 'convert-refused' | 'convert-choice';
  let step: Step = 'pick';

  // form state
  let work = presetWork ?? 'EN';
  let publisherId: PublisherPresetId = DEFAULT_PUBLISHER_PRESET_ID;
  let workStructure: ResolvedWorkStructure | null = null;
  let structureLoading = false;
  let structureError = '';
  let booksCovered = new Set<number>();
  let footnotePlacementOverride: '' | FootnotePlacement = '';
  let editionChapterTitles: '' | 'yes' | 'no' = '';
  let editionRunningHead = '';
  let editionSpacingEnabled = false;
  let editionFootnotesEnabled = false;
  let editionSliceEnabled = false;
  let editionBodyStart = '';
  let editionBodyStartNextLine = '';
  let editionTrimBodyStartPreamble = false;
  let editionBackMatterStart = '';
  let structureLoadToken = 0;
  let translator = '';
  let personalCopy: 'yes' | 'no' | null = null;
  let advLicense: 'public-domain' | 'cc-by' | 'cc-by-sa' | 'not-sure' = 'not-sure';
  let yearStr = '';
  let sourceStr = '';
  let citationStr = '';
  // Once the person edits the Citation field by hand, stop silently
  // overwriting it as translator/year/source change underneath them.
  let citationTouched = false;

  let progress = '';
  let errorMsg = '';
  let summary: ImportSummary | null = null;
  let collision: ImportCollision | null = null;
  let divisionGapAudit: DivisionAuditResult | null = null;
  let divisionWaiverAccepted = false;
  let currentReplace = false;
  let currentIdOverride: string | undefined;

  // Dehyphenation review queue: sites the dictionary couldn't safely decide.
  let reviewItems: ReviewItem[] = [];
  let reviewChoices = new Map<number, string>();
  let reviewPos = 0;
  let autoJoined = 0;
  let dehyphenatedText: string | null = null;
  let dehyphenatedBody: string | null = null;

  // Tagged-text pre-clean state. Layout imports already arrive reflowed from
  // the converter and stay on their existing path.
  let taggedTextPath = false;
  let taggedPreClean: TaggedPreCleanStart | null = null;
  let taggedBody = '';
  // N2 activation is DECLARED, never detected — see import-preclean.ts.
  let lineMode: PreCleanLineMode = 'paragraph-per-line';
  let pageJoinItems: PageJoinProposal[] = [];
  let pageJoinExclusions = new Set<number>();
  // One entry per pre-clean review step left behind, holding the working text
  // as it stood on entry to that step. N1's joins mutate `taggedBody`, so Back
  // has to restore bytes, not just change `step`.
  let preCleanHistory: { step: Step; body: string; exclusions: Set<number> }[] = [];
  let deletionScan: DeletionScan | null = null;
  let deletionChoices = new Map<number, boolean>();
  let preCleanWarnings: string[] = [];
  let stripCounts: StripCounts = { folioParagraphs: 0, strayHeadingNumerals: 0 };

  // Emphasis review queue: markdown emphasis spans the classifier couldn't
  // confidently place — same shape as the dehyphenation queue above, one
  // decision at a time with a sensible pattern-based default. Runs AFTER
  // dehyphenation resolves (so a rejoined word never straddles a marker in a
  // confusing way) and before the final import call. The dialog only
  // COLLECTS the user's per-item choices here — it never strips markers out
  // of the text itself; parseTranslationFile (inside runImport) re-runs the
  // same pure scanEmphasis classification on this exact text and replays
  // these choices verbatim (see translation-file.ts's parseTranslationFile
  // doc comment). That's what lets a CONFIDENT span's range survive the trip
  // to runImport — if the dialog pre-stripped markers, a second scanEmphasis
  // pass over already-clean text would have nothing left to recognise as
  // emphasis, silently losing every confident range before storage.
  let emphReviewItems: (EmphasisReviewItem & { context: string; before: string; hit: string; after: string })[] = [];
  let emphReviewChoices = new Map<number, 'keep' | 'remove'>();
  let emphReviewPos = 0;
  let emphConfidentCount = 0;

  $: license = personalCopy === 'yes' || advLicense === 'not-sure'
    ? 'user-supplied' as const
    : advLicense as 'public-domain' | 'cc-by' | 'cc-by-sa';
  $: formReady = !!file && translator.trim().length > 0 && personalCopy !== null;
  $: selectedPreset = getPublisherPreset(publisherId);
  $: editionReady = !!file && !!workStructure && !structureLoading
    && !structureError && booksCovered.size > 0
    && (!pendingEditionFile?.layout || !editionSliceEnabled || editionBodyStart.trim().length > 0);

  // Frontmatter the file may already carry (a re-import of a previously
  // exported/tagged file, or one hand-authored by an advanced user) — read
  // once per file to pre-fill translator/year/source/citation. The metadata
  // form still drives the actual import request; this only seeds defaults.
  $: fileMeta = file ? parseTranslationFile(file.text).meta : {};
  $: if (file) {
    if (fileMeta.translator && !translator) translator = fileMeta.translator;
    if (fileMeta.year && !yearStr) yearStr = String(fileMeta.year);
    if (fileMeta.source && !sourceStr) sourceStr = fileMeta.source;
    if (fileMeta.citation && !citationTouched) { citationStr = fileMeta.citation; citationTouched = true; }
  }
  // Keep the Citation field assembled live from translator/year/source until
  // the user edits it directly, or the file's own frontmatter already supplied
  // one (handled above). This is what makes "Citation" pre-filled-but-editable
  // rather than a second freeform field the user has to fill in from scratch.
  $: if (!citationTouched) citationStr = composeCitation({ translator, year: Number(yearStr) || undefined, source: sourceStr });

  // ── PDF layout-extraction pre-stage ─────────────────────────────────────────
  // Detection rule lives in pdf-import/index.ts (isLayoutExtraction) so it's
  // unit-testable without a DOM; those files route through the configured
  // layout stages and conversion BEFORE the metadata form step. Every other
  // file takes the pre-existing path unchanged.
  // Held for the Done step's honesty report (task 1); null for a non-PDF
  // import, which hides that whole report section.
  let convertReport: ConvertReport | null = null;
  let layoutStageReport: LayoutStageReport | null = null;
  // 'b.c' -> title, threaded into runImport (task 2) so this import's chapter
  // titles are shown at chapter openings inside its own column (not merged
  // into the reader's shared chapter headings — that's work-level chrome).
  let convertTitles: Record<string, string> = {};
  // The pristine upload, on every path. Working text may change during
  // conversion and review, but `.original` must always receive these bytes.
  let originalRawText: string | null = null;
  // NOTICK citations peeled from a layout file's frontmatter header (seating
  // pass §2) — threaded to runImport so the aligner skips those estimate ticks.
  let importNoTicks: string[] | undefined;
  let refusalMsg = '';
  let collapsedPages: number[] = [];
  let pendingEditionFile: { name: string; text: string; body: string; layout: boolean } | null = null;

  async function loadEditionWork(workId: string) {
    const token = ++structureLoadToken;
    structureLoading = true;
    structureError = '';
    workStructure = null;
    booksCovered = new Set();
    try {
      const resolved = await resolveWorkStructure(workId);
      if (token !== structureLoadToken) return;
      workStructure = resolved;
      booksCovered = new Set(Array.from({ length: resolved.books }, (_, index) => index + 1));
    } catch (error) {
      if (token !== structureLoadToken) return;
      structureError = errorText(error);
    } finally {
      if (token === structureLoadToken) structureLoading = false;
    }
  }

  function acceptText(name: string, text: string) {
    originalRawText = text;
    // Peel a frontmatter header first: a layout FINAL carries a `noTicks` line
    // the frozen converter would fold into body text. Read it here, convert the
    // body only. A non-layout import keeps its raw text (frontmatter intact) so
    // form pre-fill (fileMeta) and runImport's own parser still see it.
    const { meta: header, body } = splitFrontmatter(text);
    const boundedBody = splitPreCleanSource(text).body;
    const layout = isLayoutExtraction(boundedBody);
    if (!layout) {
      if (!hasChapterTag(boundedBody)) {
        refusalMsg =
          'No {book.chapter} tags found. Add a chapter tag such as {1.7} before '
          + 'the first word of each chapter. The importer will not guess chapter '
          + 'boundaries; use the format help on the import screen for examples.';
        step = 'convert-refused';
        return;
      }
    }
    file = { name, text };
    pendingEditionFile = { name, text, body, layout };
    importNoTicks = header.noTicks;
    convertReport = null;
    layoutStageReport = null;
    convertTitles = {};
    divisionGapAudit = null;
    divisionWaiverAccepted = false;
    step = 'edition';
    void loadEditionWork(work);
  }

  function continueEdition() {
    if (!editionReady || !pendingEditionFile) return;
    if (!pendingEditionFile.layout) {
      taggedTextPath = true;
      file = { name: pendingEditionFile.name, text: pendingEditionFile.text };
      step = 'form';
      return;
    }
    convertPendingLayout();
  }

  function changePublisher(event: Event) {
    publisherId = (event.currentTarget as HTMLSelectElement).value as PublisherPresetId;
    loadEditionDefaults();
  }

  function changeWork(event: Event) {
    work = (event.currentTarget as HTMLSelectElement).value;
    void loadEditionWork(work);
  }

  function changeFootnotePlacement(event: Event) {
    footnotePlacementOverride = (event.currentTarget as HTMLSelectElement).value as '' | FootnotePlacement;
  }

  function loadEditionDefaults() {
    const preset = getPublisherPreset(publisherId);
    const defaults = preset.editionDefaults;
    const defaultSlice = defaults?.slice === false ? undefined : defaults?.slice;
    editionChapterTitles = defaults?.chapterTitles === true
      ? 'yes'
      : defaults?.chapterTitles === false ? 'no' : '';
    editionRunningHead = typeof defaults?.runningHeadPlaceholder === 'string'
      ? defaults.runningHeadPlaceholder
      : '';
    editionSpacingEnabled = defaults?.spacing ?? !!preset.spacing;
    editionFootnotesEnabled = defaults?.footnotes ?? !!preset.footnotes;
    editionSliceEnabled = !!defaultSlice;
    editionBodyStart = defaultSlice?.bodyStart ?? '';
    editionBodyStartNextLine = defaultSlice?.bodyStartNextLine ?? '';
    editionTrimBodyStartPreamble = defaultSlice?.trimBodyStartPreamble ?? false;
    editionBackMatterStart = defaultSlice?.backMatterStart ?? '';
  }

  function currentEditionConfig(): ImportEditionConfig {
    return {
      ...(editionChapterTitles
        ? { chapterTitles: editionChapterTitles === 'yes' }
        : {}),
      ...(editionRunningHead.trim()
        ? { runningHeadPlaceholder: editionRunningHead.trim() }
        : {}),
      spacing: editionSpacingEnabled,
      footnotes: editionFootnotesEnabled,
      ...(editionSliceEnabled ? {
        slice: {
          bodyStart: editionBodyStart,
          ...(editionBodyStartNextLine ? { bodyStartNextLine: editionBodyStartNextLine } : {}),
          ...(editionTrimBodyStartPreamble ? { trimBodyStartPreamble: true } : {}),
          ...(editionBackMatterStart ? { backMatterStart: editionBackMatterStart } : {}),
        },
      } : { slice: false }),
    };
  }

  function toggleCoveredBook(book: number) {
    const next = new Set(booksCovered);
    if (next.has(book)) next.delete(book);
    else next.add(book);
    booksCovered = next;
  }

  function backToEdition() {
    step = 'edition';
  }

  function layoutSeamLabel(seam: string): string {
    const restart = /^book-sequence:restart:(.+)$/u.exec(seam);
    return restart ? `Book ${restart[1]}` : seam;
  }

  function changeBooksCovered() {
    divisionWaiverAccepted = false;
    step = 'coverage';
  }

  function retryWithChangedCoverage() {
    if (booksCovered.size === 0) return;
    divisionGapAudit = null;
    divisionWaiverAccepted = false;
    start(currentReplace, currentIdOverride);
  }

  function convertPendingLayout(opts: ConvertOptions = {}) {
    if (!pendingEditionFile || !workStructure) return;
    taggedTextPath = false;
    let prepared: PreparedLayoutImport;
    try {
      prepared = prepareLayoutImport(
        pendingEditionFile.body,
        selectedPreset,
        currentEditionConfig(),
        workStructure,
        opts,
      );
    } catch (error) {
      errorMsg = errorText(error);
      step = 'error';
      return;
    }
    layoutStageReport = prepared.staged.report;
    const result = prepared.conversion;
    if (result.ok) {
      if (result.report.seams.length > 0) {
        const boundaries = result.report.seams.map(layoutSeamLabel).join(', ');
        errorMsg =
          `This file contains more than one work. The book sequence restarts at ${boundaries}. `
          + 'Slice the file at that boundary and import each work on its own.';
        step = 'error';
        return;
      }
      convertReport = result.report;
      convertTitles = result.titles;
      file = { name: pendingEditionFile.name, text: result.tagged };
      step = 'form';
    } else if ('refused' in result) {
      refusalMsg =
        "No printed Bekker line numbers found in this file. The importer reads the "
        + "Bekker numbers printed in an edition's margins; this extraction has none "
        + "— either the edition doesn't print them, or the extraction lost the page "
        + "layout. Re-extract the PDF with pdftotext -layout, or import a pre-tagged file "
        + "instead.";
      step = 'convert-refused';
    } else {
      collapsedPages = result.collapsedPages;
      step = 'convert-choice';
    }
  }

  // A refused file is usually the wrong file, or one missing its chapter tags
  // — both fixed by picking again, so the refusal screen offers the drop zone
  // back rather than only a Close button.
  function backToPick() {
    file = null;
    refusalMsg = '';
    errorMsg = '';
    collapsedPages = [];
    pendingEditionFile = null;
    taggedTextPath = false;
    taggedPreClean = null;
    taggedBody = '';
    dehyphenatedBody = null;
    dehyphenatedText = null;
    lineMode = 'paragraph-per-line';
    preCleanHistory = [];
    pageJoinItems = [];
    pageJoinExclusions = new Set();
    deletionScan = null;
    deletionChoices = new Map();
    preCleanWarnings = [];
    stripCounts = { folioParagraphs: 0, strayHeadingNumerals: 0 };
    convertReport = null;
    layoutStageReport = null;
    convertTitles = {};
    originalRawText = null;
    importNoTicks = undefined;
    workStructure = null;
    structureError = '';
    structureLoading = false;
    booksCovered = new Set();
    footnotePlacementOverride = '';
    editionChapterTitles = '';
    editionRunningHead = '';
    editionSpacingEnabled = false;
    editionFootnotesEnabled = false;
    editionSliceEnabled = false;
    editionBodyStart = '';
    editionBodyStartNextLine = '';
    editionTrimBodyStartPreamble = false;
    editionBackMatterStart = '';
    loadEditionDefaults();
    divisionGapAudit = null;
    divisionWaiverAccepted = false;
    currentReplace = false;
    currentIdOverride = undefined;
    dropError = '';
    step = 'pick';
  }

  // "Import with page-level anchors only" (the convert-choice step) — re-run
  // the SAME upload and pure stages with the collapsed-page fallback (§3.6).
  function retryPageLevelOnly() {
    if (!pendingEditionFile) return;
    convertPendingLayout({ pageLevelOnly: true });
  }

  // A file the caller already supplied (App.svelte's own drag-drop handling
  // hands a {name, text} straight to this component's `file` prop, bypassing
  // the pick/drop functions below) goes through the same conversion
  // pre-stage as every other accept path.
  if (file) acceptText(file.name, file.text);

  // A file the app cannot read — a Latin-1 OCR .txt is the usual case, since
  // Tauri's readTextFile rejects anything that is not valid UTF-8 — must say
  // so in the drop zone. These reads used to run un-awaited, so the failure
  // went to the console and the dialog simply did nothing.
  function readFailure(name: string, e: unknown): string {
    const detail = errorText(e);
    if (/utf-?8/i.test(detail)) {
      return `Could not read “${name}”: it is not UTF-8 text. Re-save it as UTF-8 (most editors offer an encoding choice) and try again.`;
    }
    return `Could not read “${name}”: ${detail}`;
  }

  const baseName = (path: string) => path.split(/[/\\]/).pop() ?? path;

  /** Read a file and hand it to acceptText; a failed read lands in the drop
   *  zone's error line under `name` instead of on the console. */
  async function readInto(name: string, read: () => Promise<string>) {
    dropError = '';
    try {
      acceptText(name, await read());
    } catch (e) {
      dropError = readFailure(name, e);
    }
  }

  const readTauriFile = async (path: string) =>
    (await import('@tauri-apps/plugin-fs')).readTextFile(path);

  async function pickFile() {
    if (!isTauri()) {
      browserInput?.click();
      return;
    }
    dropError = '';
    let picked: string | string[] | null;
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      picked = await open({
        multiple: false,
        filters: [{ name: 'Translation files', extensions: ['md', 'txt'] }],
      });
    } catch (e) {
      dropError = readFailure('the file', e);
      return;
    }
    if (typeof picked !== 'string') return;
    const path = picked;
    await readInto(baseName(path), () => readTauriFile(path));
  }
  let browserInput: HTMLInputElement | undefined;
  async function onBrowserFile(e: Event) {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f) return;
    await readInto(f.name, () => f.text());
  }

  // ── Drop zone ──────────────────────────────────────────────────────────────
  // Packaged Tauri v2 webviews intercept OS file drags before they ever reach
  // the DOM: no HTML5 `drop` event fires, only `tauri://drag-drop` (exposed via
  // getCurrentWebview().onDragDropEvent). The HTML5 handlers below stay as a
  // harmless fallback for the plain-browser dev harness, guarded so both paths
  // can't double-fire in the packaged app.
  let dropHover = false;
  let dropError = '';
  const ACCEPTED = /\.(txt|md)$/i;

  function acceptName(name: string): boolean {
    return ACCEPTED.test(name);
  }

  async function acceptPath(path: string) {
    dropError = '';
    const name = baseName(path);
    if (!acceptName(name)) {
      dropError = 'Please drop one .txt or .md file.';
      return;
    }
    await readInto(name, () => readTauriFile(path));
  }

  async function acceptBrowserFile(f: File) {
    dropError = '';
    if (!acceptName(f.name)) {
      dropError = 'Please drop one .txt or .md file.';
      return;
    }
    await readInto(f.name, () => f.text());
  }

  let unlistenDragDrop: UnlistenFn | null = null;
  onMount(() => {
    if (!isTauri()) return;
    let cancelled = false;
    (async () => {
      const { getCurrentWebview } = await import('@tauri-apps/api/webview');
      const unlisten = await getCurrentWebview().onDragDropEvent(event => {
        if (step !== 'pick') return; // only while the drop zone is showing
        switch (event.payload.type) {
          case 'enter':
          case 'over':
            dropHover = true;
            break;
          case 'leave':
            dropHover = false;
            break;
          case 'drop': {
            dropHover = false;
            const [firstPath] = event.payload.paths;
            if (firstPath) void acceptPath(firstPath);
            break;
          }
        }
      });
      if (cancelled) unlisten();
      else unlistenDragDrop = unlisten;
    })();
    return () => { cancelled = true; };
  });
  onDestroy(() => {
    if (unlistenDragDrop) unlistenDragDrop();
  });

  // HTML5 fallback (plain-browser dev harness only — see comment above).
  function onZoneDragOver(e: DragEvent) {
    if (isTauri()) return;
    if (e.dataTransfer?.types.includes('Files')) {
      e.preventDefault();
      dropHover = true;
    }
  }
  function onZoneDragLeave() {
    if (isTauri()) return;
    dropHover = false;
  }
  async function onZoneDrop(e: DragEvent) {
    if (isTauri()) return;
    e.preventDefault();
    dropHover = false;
    const f = e.dataTransfer?.files?.[0];
    if (!f) return;
    await acceptBrowserFile(f);
  }

  // Form submit → dehyphenation pass first, then emphasis classification;
  // alignment only once the text is fully settled (auto-decisions applied,
  // every review site resolved by the user).
  async function prepare() {
    if (!file) return;
    step = 'running';
    progress = 'Checking for OCR line-break hyphens…';
    if (taggedTextPath) {
      try {
        taggedPreClean = await beginTaggedPreClean(file.text);
      } catch {
        // Dictionary unavailable: keep every hyphen site unchanged, while
        // still running N4 and N2 over the bounded body.
        taggedPreClean = await beginTaggedPreClean(file.text, async text => ({
          text, decisions: [], reviewCount: 0, ran: false,
        }));
      }
      const d = taggedPreClean.dehyphenation;
      autoJoined = d.decisions.filter(x => x.action === 'joined').length;
      dehyphenatedBody = d.text;
      if (d.reviewCount > 0) {
        reviewItems = listReviewItems(d.text);
        reviewChoices = new Map();
        reviewPos = 0;
        step = 'review';
        return;
      }
      finishTaggedHyphenation();
      return;
    }
    try {
      const d = await dehyphenate(file.text);
      autoJoined = d.decisions.filter(x => x.action === 'joined').length;
      dehyphenatedText = d.text;
      if (d.reviewCount > 0) {
        reviewItems = listReviewItems(d.text);
        reviewChoices = new Map();
        reviewPos = 0;
        step = 'review';
        return;
      }
    } catch {
      // Dictionary unavailable: proceed on the raw text rather than block the
      // import — line-end hyphens then stay exactly as the source had them.
      dehyphenatedText = file.text;
    }
    runEmphasisScan();
  }

  function chooseReview(form: string) {
    reviewChoices.set(reviewItems[reviewPos].index, form);
    if (reviewPos + 1 < reviewItems.length) {
      reviewPos += 1;
    } else {
      if (taggedTextPath) {
        dehyphenatedBody = resolveReviews(dehyphenatedBody!, reviewChoices);
        finishTaggedHyphenation();
      } else {
        dehyphenatedText = resolveReviews(dehyphenatedText!, reviewChoices);
        runEmphasisScan();
      }
    }
  }

  // A pre-clean stage that finds its own state missing must say so: returning
  // quietly leaves the dialog on whatever step it was on, with no controls and
  // no explanation.
  function preCleanLost(stage: string) {
    errorMsg = `The pre-clean lost its working text before ${stage}. `
      + 'Nothing was written. Start the import again from the file.';
    step = 'error';
  }

  function finishTaggedHyphenation() {
    if (!taggedPreClean || dehyphenatedBody === null) {
      preCleanLost('the page-break review');
      return;
    }
    preCleanHistory = [];
    // Ask only when the answer changes the bytes. A file with no joinable
    // newline reads the same under either declaration.
    if (!lineModeMatters(taggedPreClean, dehyphenatedBody)) {
      applyLineMode('paragraph-per-line');
      return;
    }
    lineMode = taggedPreClean.suggestedMode;
    step = 'line-mode';
  }

  function applyLineMode(mode: PreCleanLineMode) {
    if (!taggedPreClean || dehyphenatedBody === null) {
      preCleanLost('the page-break review');
      return;
    }
    lineMode = mode;
    taggedBody = finishTaggedNormalization(taggedPreClean, dehyphenatedBody, mode);
    pageJoinItems = proposePageBreakJoins(taggedBody);
    pageJoinExclusions = new Set();
    if (pageJoinItems.length > 0) {
      if (step === 'line-mode') pushPreCleanStep();
      step = 'page-join-review';
      return;
    }
    findDeletionProposals();
  }

  // Remember the step being left, with the text as it stands BEFORE the step
  // ahead mutates it.
  function pushPreCleanStep() {
    preCleanHistory = [...preCleanHistory, {
      step, body: taggedBody, exclusions: new Set(pageJoinExclusions),
    }];
  }

  function preCleanBack() {
    const previous = preCleanHistory.at(-1);
    if (!previous) return;
    preCleanHistory = preCleanHistory.slice(0, -1);
    taggedBody = previous.body;
    pageJoinExclusions = previous.exclusions;
    step = previous.step;
  }

  function togglePageJoin(index: number) {
    const next = new Set(pageJoinExclusions);
    if (next.has(index)) next.delete(index);
    else next.add(index);
    pageJoinExclusions = next;
  }

  function finishPageJoinReview(acceptAll = false) {
    const accepted = new Set(
      pageJoinItems
        .filter(item => acceptAll || !pageJoinExclusions.has(item.index))
        .map(item => item.index),
    );
    pushPreCleanStep();
    taggedBody = applyPageBreakJoins(taggedBody, pageJoinItems, accepted);
    findDeletionProposals();
  }

  function findDeletionProposals() {
    deletionScan = scanDeletionProposals(taggedBody, selectedPreset.strayNumeralStyle);
    preCleanWarnings = [...deletionScan.warnings];
    deletionChoices = new Map();
    stripCounts = { folioParagraphs: 0, strayHeadingNumerals: 0 };
    if (deletionScan.proposals.length > 0) {
      if (step === 'line-mode') pushPreCleanStep();
      step = 'deletion-review';
      return;
    }
    finishTaggedPreClean();
  }

  function chooseDeletion(index: number, accept: boolean) {
    deletionChoices = new Map(deletionChoices).set(index, accept);
  }

  // 'reviewed' applies the per-item choices; the two blanket verdicts exist
  // because a long list with one right answer should not cost a click a row —
  // and Keep-all is the one that must exist, since without it the only way to
  // refuse every proposal was to abandon the import.
  function finishDeletionReview(verdict: 'accept-all' | 'keep-all' | 'reviewed') {
    if (!deletionScan) {
      preCleanLost('the proposed deletions could be applied');
      return;
    }
    // The "apply reviewed choices" button is disabled until every proposal has
    // a decision; this only guards a stray call.
    if (verdict === 'reviewed' && deletionChoices.size !== deletionScan.proposals.length) return;
    const accepted = new Set(
      deletionScan.proposals
        .filter(item => verdict === 'accept-all'
          || (verdict === 'reviewed' && deletionChoices.get(item.index) === true))
        .map(item => item.index),
    );
    preCleanWarnings = [
      ...preCleanWarnings,
      ...deletionScan.proposals
        .filter(item => !accepted.has(item.index))
        .map(item => `Proposed deletion “${item.text}” was excluded during review.`),
    ];
    const applied = applyDeletionProposals(taggedBody, deletionScan.proposals, accepted);
    taggedBody = applied.text;
    stripCounts = applied.counts;
    finishTaggedPreClean();
  }

  function finishTaggedPreClean() {
    if (!taggedPreClean) {
      preCleanLost('the cleaned text could be reassembled');
      return;
    }
    dehyphenatedText = rebuildPreCleanSource(taggedPreClean.sections, taggedBody);
    runEmphasisScan();
  }

  // Classify markdown emphasis in the dehyphenated text — a discovery pass
  // ONLY: markers are never stripped here. runImport's own parseTranslationFile
  // call re-runs this exact classification later (over the identical text —
  // see emphasisScanInput) and is what actually strips markers into stored
  // EmphasisRanges; this pass exists purely to find review-worthy sites and
  // let the user weigh in before the import proceeds, exactly like the
  // hyphenation step above.
  function runEmphasisScan() {
    const source = dehyphenatedText ?? file!.text;
    const r = scanEmphasis(emphasisScanInput(source));
    emphConfidentCount = r.ranges.length;
    if (r.reviewItems.length > 0) {
      emphReviewItems = listEmphasisReviewItems(r.text, r.reviewItems);
      emphReviewChoices = new Map();
      emphReviewPos = 0;
      step = 'emph-review';
      return;
    }
    start();
  }

  function chooseEmphReview(choice: 'keep' | 'remove') {
    emphReviewChoices.set(emphReviewItems[emphReviewPos].index, choice);
    if (emphReviewPos + 1 < emphReviewItems.length) {
      emphReviewPos += 1;
    } else {
      start();
    }
  }

  // One decision applied to every marker not yet answered — a rough scan can
  // throw dozens of stray markers at the queue (75 on Apostle's APo), and
  // stepping through them one at a time serves nobody. Choices already made
  // on earlier items are preserved.
  function chooseEmphReviewAll(choice: 'keep' | 'remove') {
    for (let i = emphReviewPos; i < emphReviewItems.length; i += 1) {
      emphReviewChoices.set(emphReviewItems[i].index, choice);
    }
    start();
  }

  async function start(replace = false, idOverride?: string) {
    if (!file) return;
    currentReplace = replace;
    currentIdOverride = idOverride;
    step = 'running';
    progress = 'Starting…';
    try {
      summary = await runImport({
        raw: dehyphenatedText ?? file.text,
        original: originalRawText ?? file.text,
        ...(Object.keys(convertTitles).length ? { titles: convertTitles } : {}),
        ...(importNoTicks?.length ? { noTicks: importNoTicks } : {}),
        emphasisChoices: emphReviewChoices.size ? emphReviewChoices : undefined,
        ...(taggedTextPath ? {
          preClean: { warnings: preCleanWarnings, stripCounts },
        } : {}),
        booksCovered: [...booksCovered].sort((a, b) => a - b),
        ...(divisionWaiverAccepted ? { waiveDivisionGaps: true } : {}),
        ...(selectedPreset.footnotePlacement
          ? { footnotePlacement: selectedPreset.footnotePlacement }
          : {}),
        ...(footnotePlacementOverride
          ? { footnotePlacementOverride }
          : {}),
        work,
        translator: translator.trim(),
        license,
        ...(yearStr && !Number.isNaN(Number(yearStr)) ? { year: Number(yearStr) } : {}),
        ...(sourceStr.trim() ? { source: sourceStr.trim() } : {}),
        ...(citationStr.trim() ? { citation: citationStr.trim() } : {}),
        replace,
        ...(idOverride ? { idOverride } : {}),
      }, msg => { progress = msg; });
      step = 'done';
    } catch (e) {
      if (e instanceof ImportCollision) {
        collision = e;
        step = 'collision';
      } else if (e instanceof DivisionGapError) {
        divisionGapAudit = e.audit;
        step = 'division-waiver';
      } else {
        errorMsg = errorText(e);
        step = 'error';
      }
    }
  }

  function importWithDivisionWaiver() {
    divisionWaiverAccepted = true;
    start(currentReplace, currentIdOverride);
  }

  function finish() {
    if (summary) {
      // Drop the reader straight into the new translation, not back at a
      // library view needing a second click.
      try { localStorage.setItem(`reader-trans-${summary.meta.work}`, summary.meta.id); } catch { /* fine */ }
      try {
        localStorage.setItem('desktop-loc', JSON.stringify({ work: summary.meta.work, book: 1 }));
      } catch { /* fine */ }
    }
    onClose(summary);
  }
</script>

<div class="imp-backdrop" role="presentation" on:click={() => onClose(null)}></div>
<div class="imp" role="dialog" aria-label="Import a translation">
  {#if step === 'pick'}
    <h2>Import a translation</h2>
    <p class="imp-note">
      A plain-text or Markdown file. Chapter tags like <code>{'{1.7}'}</code> are required;
      Bekker tags like <code>{'{1094a}'}</code> and <code>{'{20}'}</code> are used when present —
      anything below the tagged detail is filled in by alignment and labelled as an estimate.
    </p>
    <div
      class="imp-drop"
      class:imp-drop-hover={dropHover}
      role="button"
      tabindex="0"
      aria-label="Drop a .txt or .md file here, or click to browse"
      on:click={pickFile}
      on:keydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickFile(); } }}
      on:dragover={onZoneDragOver}
      on:dragleave={onZoneDragLeave}
      on:drop={onZoneDrop}
    >
      <svg class="imp-drop-icon" viewBox="0 0 24 24" width="28" height="28" fill="none"
        stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M12 3v12" />
        <path d="M7 10l5 5 5-5" />
        <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
      </svg>
      <p class="imp-drop-text">
        {#if file}
          <b>{file.name}</b> selected — drop or click to choose a different file
        {:else}
          Drop a <b>.txt</b> or <b>.md</b> file here — or click to browse
        {/if}
      </p>
    </div>
    <input type="file" accept=".md,.txt,text/plain,text/markdown" bind:this={browserInput}
      on:change={onBrowserFile} style="display:none" />
    {#if dropError}<p class="imp-error">{dropError}</p>{/if}

    <div class="imp-actions">
      <button class="imp-quiet" on:click={() => onClose(null)}>Cancel</button>
    </div>

    <details class="imp-help">
      <summary>How do I format a file for import?</summary>
      <div class="imp-help-body">
        <p>Plain text or Markdown, with tags in braces placed immediately
        <em>before</em> the word they belong to (tag, one space, then the word).
        Use the numbers as printed in your source — never a computed count.</p>
        <dl>
          <dt><code>{'{1.7}'}</code></dt>
          <dd><b>Chapter</b> (book.chapter) — <b>required</b>, before the first word of
            each chapter. For single-book works use book 1: <code>{'{1.4}'}</code> = chapter 4.</dd>
          <dt><code>{'{1094a}'}</code></dt>
          <dd><b>Bekker column</b> — optional, before the first word of that column.</dd>
          <dt><code>{'{20}'}</code></dt>
          <dd><b>Bekker line</b> of the current column — optional, if your edition
            prints line numbers (usually every 5th).</dd>
        </dl>
        <p>Example:</p>
        <pre>{'{1.1}'} Every art and every inquiry, and similarly
every action and pursuit, is thought to aim at
some good… {'{1094b}'} But a certain difference is
found among ends…</pre>
        <p>Whatever detail your tags don't provide is filled in by alignment and
        <em>always labelled as an estimate</em> in the margin — chapter tags alone
        are enough for a working parallel text. OCR line-break hyphens
        (like <code>under-</code> at a line end) are detected and fixed with your
        review. You never write the metadata header yourself — this form does.</p>
      </div>
    </details>

  {:else if step === 'edition'}
    <h2>Edition</h2>
    <p class="imp-note">Set the publisher and work before the importer reads or converts the file.</p>
    <label class="imp-field">
      <span>Publisher</span>
      <select bind:value={publisherId} on:change={changePublisher}>
        {#each PUBLISHER_PRESETS as option (option.id)}
          <option value={option.id}>{option.label}</option>
        {/each}
      </select>
    </label>
    <label class="imp-field">
      <span>Work</span>
      <select bind:value={work} on:change={changeWork}>
        {#each WORKS as w (w.id)}
          <option value={w.id}>{w.title}</option>
        {/each}
      </select>
    </label>
    {#if structureLoading}
      <p class="imp-note" aria-live="polite">Loading work structure…</p>
    {:else if structureError}
      <p class="imp-error">{structureError}</p>
    {:else if workStructure}
      <dl class="imp-edition-facts">
        <div><dt>Title</dt><dd>{workStructure.workTitle}</dd></div>
        <div><dt>Books</dt><dd>{workStructure.books}</dd></div>
        <div><dt>Chapters per book</dt><dd>{workStructure.chaptersPerBook.join(', ')}</dd></div>
        <div><dt>Bekker span</dt><dd>{workStructure.bekkerStart}–{workStructure.bekkerEnd}</dd></div>
      </dl>
      <fieldset class="imp-field imp-covered-books">
        <legend>Books covered by this file</legend>
        <div class="imp-book-choices">
          {#each Array.from({ length: workStructure.books }, (_, index) => index + 1) as book}
            <label>
              <input
                type="checkbox"
                checked={booksCovered.has(book)}
                on:change={() => toggleCoveredBook(book)}
              />
              Book {workStructure.bookLabels[book - 1] ?? book}
            </label>
          {/each}
        </div>
        {#if booksCovered.size === 0}<p class="imp-error">Choose at least one book.</p>{/if}
      </fieldset>
    {/if}
    <details class="imp-help imp-edition-override">
      <summary>Edition override</summary>
      <div class="imp-help-body">
        <label class="imp-field">
          <span>Note display</span>
          <select bind:value={footnotePlacementOverride} on:change={changeFootnotePlacement}>
            <option value="">
              Publisher default ({selectedPreset.footnotePlacement === 'endnote'
                ? 'endnotes'
                : selectedPreset.footnotePlacement === 'page-bottom' ? 'page-bottom notes' : 'use file setting'})
            </option>
            <option value="page-bottom">Page-bottom notes</option>
            <option value="endnote">Endnotes</option>
          </select>
        </label>
        {#if pendingEditionFile?.layout}
          <label class="imp-field">
            <span>Running head placeholder</span>
            <input
              type="text"
              bind:value={editionRunningHead}
              placeholder={workStructure?.runningHeadPlaceholder ?? 'Derived from work title'}
            />
          </label>
          <label class="imp-field">
            <span>Printed chapter titles</span>
            <select bind:value={editionChapterTitles}>
              <option value="">Unspecified</option>
              <option value="no">No</option>
              <option value="yes">Yes</option>
            </select>
          </label>
          <label class="imp-check-row">
            <input type="checkbox" bind:checked={editionSpacingEnabled} />
            Normalize layout spacing
          </label>
          <label class="imp-check-row">
            <input type="checkbox" bind:checked={editionFootnotesEnabled} />
            Normalize page-bottom footnotes
          </label>
          <label class="imp-check-row">
            <input type="checkbox" bind:checked={editionSliceEnabled} />
            Slice front and back matter before conversion
          </label>
          {#if editionSliceEnabled}
            <label class="imp-field">
              <span>Body-start pattern</span>
              <input type="text" bind:value={editionBodyStart} aria-invalid={!editionBodyStart.trim()} />
            </label>
            <label class="imp-field">
              <span>Next-line pattern</span>
              <input type="text" bind:value={editionBodyStartNextLine} placeholder="Optional" />
            </label>
            <label class="imp-check-row">
              <input type="checkbox" bind:checked={editionTrimBodyStartPreamble} />
              Trim preamble on the body-start page
            </label>
            <label class="imp-field">
              <span>Back-matter pattern</span>
              <input type="text" bind:value={editionBackMatterStart} placeholder="Optional" />
            </label>
            {#if !editionBodyStart.trim()}
              <p class="imp-error">A body-start pattern is required while slicing is on.</p>
            {/if}
          {/if}
        {/if}
      </div>
    </details>
    <div class="imp-actions">
      <button class="imp-primary" disabled={!editionReady} on:click={continueEdition}>Continue</button>
      <button class="imp-quiet" on:click={backToPick}>Back</button>
      <button class="imp-quiet" on:click={() => onClose(null)}>Cancel</button>
    </div>

  {:else if step === 'convert-refused'}
    <h2>Couldn't read this file</h2>
    <p class="imp-note">{refusalMsg}</p>
    <div class="imp-actions">
      <button class="imp-primary" on:click={backToPick}>Choose another file</button>
      <button class="imp-quiet" on:click={() => onClose(null)}>Close</button>
    </div>

  {:else if step === 'convert-choice'}
    <h2>Some pages lost their layout</h2>
    <p class="imp-note">
      {collapsedPages.length} page{collapsedPages.length === 1 ? '' : 's'} lost
      {collapsedPages.length === 1 ? 'its' : 'their'} print layout in extraction
      (pages {collapsedPages.join(', ')}). Re-extracting the PDF usually fixes this.
    </p>
    <div class="imp-actions">
      <button class="imp-quiet" on:click={() => onClose(null)}>Cancel (re-extract)</button>
      <button class="imp-primary" on:click={retryPageLevelOnly}>Import with page-level anchors only</button>
    </div>

  {:else if step === 'form'}
    <h2>Import “{file?.name}”</h2>
    <label class="imp-field">
      <span>Translator</span>
      <input type="text" bind:value={translator} placeholder="e.g. Rackham" spellcheck="false" />
    </label>
    <label class="imp-field">
      <span>Year (optional)</span>
      <input type="text" bind:value={yearStr} placeholder="e.g. 1926" inputmode="numeric" />
    </label>
    <label class="imp-field">
      <span>Source (optional)</span>
      <input type="text" bind:value={sourceStr} placeholder="e.g. Oxford: Clarendon Press" spellcheck="false" />
    </label>
    <label class="imp-field">
      <span>Citation</span>
      <textarea class="imp-citation" rows="3" spellcheck="false"
        placeholder="Full citation for Copy Citation, e.g. Aristotle. Parts of Animals I–IV. Trans. James G. Lennox. Oxford: Clarendon Press, 2001."
        bind:value={citationStr}
        on:input={() => (citationTouched = true)}
      ></textarea>
    </label>
    <fieldset class="imp-field imp-radio">
      <legend>Is this a personal copy of a copyrighted translation?</legend>
      <label><input type="radio" bind:group={personalCopy} value="yes" /> Yes — keep it private to this computer</label>
      <label><input type="radio" bind:group={personalCopy} value="no" /> No</label>
    </fieldset>
    {#if personalCopy === 'no'}
      <label class="imp-field">
        <span>License</span>
        <select bind:value={advLicense}>
          <option value="public-domain">Public domain</option>
          <option value="cc-by">CC BY</option>
          <option value="cc-by-sa">CC BY-SA</option>
          <option value="not-sure">Not sure</option>
        </select>
      </label>
    {/if}
    <div class="imp-actions">
      <button class="imp-primary" disabled={!formReady} on:click={prepare}>Import</button>
      <button class="imp-quiet" on:click={backToEdition}>Back</button>
      <button class="imp-quiet" on:click={() => onClose(null)}>Cancel</button>
    </div>

  {:else if step === 'review'}
    <h2>Hyphenation check</h2>
    <p class="imp-note">
      This text has printed line-break hyphens. {autoJoined}
      {autoJoined === 1 ? 'was' : 'were'} rejoined automatically; the
      dictionary could not safely decide {reviewItems.length} — choose the
      correct form for each.
    </p>
    {#if reviewItems[reviewPos]}
      {@const item = reviewItems[reviewPos]}
      <p class="imp-review-ctx">…{item.context}…</p>
      <div class="imp-actions">
        <button class="imp-primary" on:click={() => chooseReview(item.closed)}>{item.closed}</button>
        <button class="imp-primary" on:click={() => chooseReview(item.hyphenated)}>{item.hyphenated}</button>
      </div>
      <p class="imp-note">{reviewPos + 1} of {reviewItems.length}</p>
    {/if}
    <div class="imp-actions">
      <button class="imp-quiet" on:click={() => onClose(null)}>Cancel import</button>
    </div>

  {:else if step === 'line-mode'}
    <h2>How are this file's lines broken?</h2>
    <p class="imp-note">
      The importer will not guess this. Pick the one that describes the file —
      the highlighted option is the likelier of the two, not a decision already made.
    </p>
    <div class="imp-actions imp-mode-actions">
      <button
        class:imp-primary={lineMode === 'paragraph-per-line'}
        on:click={() => applyLineMode('paragraph-per-line')}
      >Each paragraph is one line</button>
      <button
        class:imp-primary={lineMode === 'wrapped'}
        on:click={() => applyLineMode('wrapped')}
      >Lines wrapped as printed; blank lines separate paragraphs</button>
    </div>
    <p class="imp-note">
      One line per paragraph: every line break is kept as written. Wrapped as
      printed: line breaks inside a block are joined back into running prose,
      and the blank lines stay as the paragraph breaks.
    </p>
    <div class="imp-actions">
      <button class="imp-quiet" on:click={() => onClose(null)}>Cancel import</button>
    </div>

  {:else if step === 'page-join-review'}
    <h2>Page-break sentence joins</h2>
    <p class="imp-note">
      These paragraph breaks may split a sentence. Review every proposal. Click
      a row to exclude or restore it; no join applies until you confirm below.
    </p>
    <div class="imp-review-list">
      {#each pageJoinItems as item (item.index)}
        <button
          class="imp-review-row"
          class:imp-review-excluded={pageJoinExclusions.has(item.index)}
          aria-pressed={pageJoinExclusions.has(item.index)}
          on:click={() => togglePageJoin(item.index)}
        >
          <span>…{item.before}</span>
          <b>{pageJoinExclusions.has(item.index) ? 'Keep paragraph break' : 'Join here'}</b>
          <span>{item.after}…</span>
        </button>
      {/each}
    </div>
    <div class="imp-actions">
      <button class="imp-primary" on:click={() => finishPageJoinReview(true)}>Accept all</button>
      <button on:click={() => finishPageJoinReview(false)}>
        Apply {pageJoinItems.length - pageJoinExclusions.size} selected join{pageJoinItems.length - pageJoinExclusions.size === 1 ? '' : 's'}
      </button>
      {#if preCleanHistory.length}
        <button class="imp-quiet" on:click={preCleanBack}>Back</button>
      {/if}
      <button class="imp-quiet" on:click={() => onClose(null)}>Cancel import</button>
    </div>

  {:else if step === 'deletion-review'}
    <h2>Proposed paragraph deletions</h2>
    {#if deletionScan}
      <p class="imp-note">
        {deletionScan.proposals.length} of {deletionScan.paragraphCount} paragraphs flagged.
        Nothing below has been removed. Accept or keep every item before the import can continue.
      </p>
      <div class="imp-review-list">
        {#each deletionScan.proposals as item (item.index)}
          <section class="imp-deletion-row">
            {#if item.before}<p>…{item.before}</p>{/if}
            <p class="imp-deletion-hit">{item.text}</p>
            {#if item.after}<p>{item.after}…</p>{/if}
            <p class="imp-note">
              {item.reasons.includes('folio') ? 'Cadence-matched folio paragraph' : ''}
              {item.reasons.length > 1 ? ' · ' : ''}
              {item.reasons.includes('stray-heading') ? 'Heading numeral matching the adjacent chapter tag' : ''}
            </p>
            <div class="imp-actions imp-item-actions">
              <button
                class:imp-choice-active={deletionChoices.get(item.index) === true}
                aria-pressed={deletionChoices.get(item.index) === true}
                on:click={() => chooseDeletion(item.index, true)}
              >Accept deletion</button>
              <button
                class:imp-choice-active={deletionChoices.get(item.index) === false}
                aria-pressed={deletionChoices.get(item.index) === false}
                on:click={() => chooseDeletion(item.index, false)}
              >Keep paragraph</button>
            </div>
          </section>
        {/each}
      </div>
      <div class="imp-actions">
        <button class="imp-primary" on:click={() => finishDeletionReview('accept-all')}>Accept all proposed deletions</button>
        <button on:click={() => finishDeletionReview('keep-all')}>Keep all — delete nothing</button>
        <button disabled={deletionChoices.size !== deletionScan.proposals.length} on:click={() => finishDeletionReview('reviewed')}>
          Apply reviewed choices
        </button>
        {#if preCleanHistory.length}
          <button class="imp-quiet" on:click={preCleanBack}>Back</button>
        {/if}
        <button class="imp-quiet" on:click={() => onClose(null)}>Cancel import</button>
      </div>
    {/if}

  {:else if step === 'emph-review'}
    <h2>Emphasis check</h2>
    <p class="imp-note">
      {#if emphConfidentCount > 0}
        {emphConfidentCount} span{emphConfidentCount === 1 ? '' : 's'} of markdown emphasis
        (<code>_like this_</code> or <code>**like this**</code>) {emphConfidentCount === 1 ? 'was' : 'were'}
        recognised automatically.
      {/if}
      {emphReviewItems.length} marker{emphReviewItems.length === 1 ? '' : 's'} couldn't be classified
      confidently — choose how to treat each one.
    </p>
    {#if emphReviewItems[emphReviewPos]}
      {@const item = emphReviewItems[emphReviewPos]}
      <p class="imp-review-ctx">…{item.before}<mark class="imp-emph-hit">{item.hit}</mark>{item.after}…</p>
      <p class="imp-note">
        {#if item.reason === 'stray-marker'}
          A lone <code>{item.raw}</code> with no matching partner.
        {:else if item.reason === 'mid-word'}
          A marker touching a word rather than a word boundary — likely not emphasis.
        {:else if item.reason === 'too-long'}
          A long span ({item.inner.split(/\s+/).filter(Boolean).length} words) — could be a deliberate
          emphasis run or an OCR artifact.
        {:else}
          An unbalanced or oddly-spaced marker.
        {/if}
      </p>
      <div class="imp-actions">
        <button class="imp-primary" on:click={() => chooseEmphReview('keep')}>
          Keep as {item.style === 'bold' ? 'bold' : 'italics'}
        </button>
        <button class="imp-primary" on:click={() => chooseEmphReview('remove')}>
          Remove markers, plain text
        </button>
      </div>
      <p class="imp-note">
        Default: {item.defaultKeep ? `keep as ${item.style === 'bold' ? 'bold' : 'italics'}` : 'remove markers'}.
        {emphReviewPos + 1} of {emphReviewItems.length}
      </p>
      {#if emphReviewItems.length - emphReviewPos > 1}
        <div class="imp-actions">
          <button class="imp-quiet" on:click={() => chooseEmphReviewAll('keep')}>
            Keep all {emphReviewItems.length - emphReviewPos} remaining as emphasis
          </button>
          <button class="imp-quiet" on:click={() => chooseEmphReviewAll('remove')}>
            Remove markers for all {emphReviewItems.length - emphReviewPos} remaining
          </button>
        </div>
      {/if}
    {/if}
    <div class="imp-actions">
      <button class="imp-quiet" on:click={() => onClose(null)}>Cancel import</button>
    </div>

  {:else if step === 'division-waiver'}
    <h2>Missing chapters in this copy</h2>
    {#if divisionGapAudit}
      <p class="imp-note">{divisionAuditLine(divisionGapAudit)}</p>
      <p class="imp-note">
        Missing:
        {divisionGapAudit.gaps.map(gap => divisionGapLabel(gap, divisionGapAudit!)).join(', ')}.
        Check the source tags first. Use the waiver only when this copy is known to be incomplete.
      </p>
    {/if}
    <div class="imp-actions">
      <button class="imp-primary" on:click={importWithDivisionWaiver}>
        Import anyway — this copy is known incomplete
      </button>
      <button on:click={changeBooksCovered}>Change books covered</button>
      <button class="imp-quiet" on:click={backToPick}>Choose another file</button>
      <button class="imp-quiet" on:click={() => onClose(null)}>Cancel</button>
    </div>

  {:else if step === 'coverage'}
    <h2>Change books covered</h2>
    <p class="imp-note">
      Change only the books this file contains. The importer will reuse your reviewed text and decisions.
    </p>
    {#if workStructure}
      <fieldset class="imp-field imp-covered-books">
        <legend>Books covered by this file</legend>
        <div class="imp-book-choices">
          {#each Array.from({ length: workStructure.books }, (_, index) => index + 1) as book}
            <label>
              <input
                type="checkbox"
                checked={booksCovered.has(book)}
                on:change={() => toggleCoveredBook(book)}
              />
              Book {workStructure.bookLabels[book - 1] ?? book}
            </label>
          {/each}
        </div>
        {#if booksCovered.size === 0}<p class="imp-error">Choose at least one book.</p>{/if}
      </fieldset>
    {/if}
    <div class="imp-actions">
      <button class="imp-primary" disabled={booksCovered.size === 0} on:click={retryWithChangedCoverage}>
        Retry import
      </button>
      <button class="imp-quiet" on:click={() => (step = 'division-waiver')}>Back</button>
      <button class="imp-quiet" on:click={() => onClose(null)}>Cancel</button>
    </div>

  {:else if step === 'running'}
    <h2>Importing…</h2>
    <p class="imp-progress" aria-live="polite">{progress}</p>

  {:else if step === 'collision'}
    <h2>Already in your library</h2>
    <p class="imp-note">
      A translation with the id <b>{collision?.id}</b> already exists for this work.
    </p>
    <div class="imp-actions">
      <button class="imp-primary" on:click={() => start(true)}>Replace it</button>
      <button on:click={() => start(false, `${collision?.id}-2`)}>Keep both</button>
      <button class="imp-quiet" on:click={() => onClose(null)}>Cancel</button>
    </div>

  {:else if step === 'done'}
    <h2>Imported {summary?.meta.translator}</h2>
    {#if summary}
      <p class="imp-summary">
        {summary.chapters} chapters processed
        (tag level: {summary.density === 'exhaustive' ? 'every line tagged'
          : summary.density === 'five-line-or-column' ? 'five-line / column tags'
          : 'chapter tags only'}).
      </p>
      <ul class="imp-stats">
        {#if summary.tagged > 0}
          <li><b>{summary.tagged.toLocaleString()}</b> anchors from your tags</li>
        {/if}
        {#if summary.placed > 0}
          <li><b>{summary.placed.toLocaleString()}</b> anchors placed by alignment</li>
        {/if}
        <li><b>{summary.interpolated.toLocaleString()}</b> lines interpolated — marked as estimates in the gutter</li>
      </ul>
      {#if summary.warnings.length}
        <details class="imp-warn">
          <summary>{summary.warnings.length} tag warning{summary.warnings.length > 1 ? 's' : ''} to review</summary>
          <ul>
            {#each summary.warnings.slice(0, 20) as w}<li>{w}</li>{/each}
          </ul>
        </details>
      {/if}
      {#if summary.footnoteSummary}
        <p class="imp-summary">{summary.footnoteSummary}</p>
      {/if}
      <p class="imp-summary">{divisionAuditLine(summary.divisionAudit)}</p>
      {#if summary.waivedDivisionGaps?.length}
        <p class="imp-error">
          Incomplete-copy waiver recorded for
          {summary.waivedDivisionGaps.map(gap => divisionGapLabel(gap, summary!.divisionAudit)).join(', ')}.
        </p>
      {/if}
      {#if summary.stripCounts}
        <ul class="imp-stats">
          <li><b>{summary.stripCounts.folioParagraphs}</b> folio paragraphs stripped</li>
          <li><b>{summary.stripCounts.strayHeadingNumerals}</b> stray heading numerals stripped</li>
        </ul>
      {/if}
      {#if layoutStageReport}
        {#if layoutStageReport.stagesRun.length === 0}
          <p class="imp-summary">Configured layout stages: not run</p>
        {:else}
          <ul class="imp-stats">
            <li>Configured layout stages: {layoutStageReport.stagesRun.join(' → ')}</li>
            <li><b>{layoutStageReport.sliceChanges}</b> slice changes</li>
            {#each layoutStageReport.sliceBoundaries as boundary}
              <li>{boundary.field}: <b>{boundary.text}</b></li>
            {/each}
            <li><b>{layoutStageReport.headInsertions}</b> running-head placeholders inserted</li>
            <li><b>{layoutStageReport.folioRepairs}</b> folios repaired or stripped</li>
            <li><b>{layoutStageReport.headingNormalizations}</b> headings normalized</li>
            <li>
              <b>{layoutStageReport.spacingNormalizations}</b>
              lines re-spaced; display lines kept by shape only — the app has no per-copy preserve list
            </li>
            {#if layoutStageReport.stagesRun.includes('footnotes')}
              <li><b>{layoutStageReport.footnoteHeadRepairs}</b> footnote headings normalized</li>
              <li><b>{layoutStageReport.detachedFootnoteMarkers}</b> detached footnote markers flagged</li>
              <li>
                <b>{layoutStageReport.unconfirmedFootnoteMarkers}</b>
                marker-glue site{layoutStageReport.unconfirmedFootnoteMarkers === 1 ? '' : 's'} flagged, not fixed — the app has no witness; the FINAL cut repairs confirmed sites
              </li>
            {/if}
          </ul>
        {/if}
      {/if}
      {#if convertReport}
        <!-- Honesty report for a PDF-conversion import: everything the
             converter dropped, suppressed, or preserved verbatim, so the
             claim "labelled as an estimate" extends to what didn't make it
             into the file at all. -->
        {#if convertReport.droppedLines.length}
          <details class="imp-warn">
            <summary>
              {convertReport.droppedLines.length}
              dropped line{convertReport.droppedLines.length === 1 ? '' : 's'}
            </summary>
            <ul>
              {#each convertReport.droppedLines as l}<li>{l}</li>{/each}
            </ul>
          </details>
        {/if}
        {#if convertReport.ticsSuppressed.length}
          <details class="imp-warn">
            <summary>
              {convertReport.ticsSuppressed.reduce((n, s) => n + s.count, 0)}
              Bekker tick{convertReport.ticsSuppressed.reduce((n, s) => n + s.count, 0) === 1 ? '' : 's'} suppressed (not printed as anchors)
            </summary>
            <ul>
              {#each convertReport.ticsSuppressed as s}<li>{s.flag}: {s.count}</li>{/each}
            </ul>
          </details>
        {/if}
        {#if convertReport.displayBlocks.length}
          <p class="imp-note">
            {convertReport.displayBlocks.length}
            table/diagram-like block{convertReport.displayBlocks.length === 1 ? '' : 's'}
            preserved line-by-line — review in the reader.
          </p>
        {/if}
        {#if convertReport.seams.length}
          <p class="imp-error">
            This file appears to contain more than one work — slice per work before importing.
          </p>
        {/if}
      {/if}
    {/if}
    <div class="imp-actions">
      <button class="imp-primary" on:click={finish}>Open in the reader</button>
    </div>

  {:else}
    <h2>Import failed</h2>
    <p class="imp-error">{errorMsg}</p>
    <!-- A failed import is usually answered by a corrected file, so the
         drop zone is offered back here exactly as it is on a refusal. -->
    <div class="imp-actions">
      {#if pendingEditionFile}
        <button class="imp-primary" on:click={backToEdition}>Back to Edition</button>
        <button class="imp-quiet" on:click={backToPick}>Choose another file</button>
      {:else}
        <button class="imp-primary" on:click={backToPick}>Choose another file</button>
      {/if}
      <button class="imp-quiet" on:click={() => onClose(null)}>Close</button>
    </div>
  {/if}
</div>

<style>
  .imp-backdrop { position: fixed; inset: 0; z-index: 210; background: rgba(0, 0, 0, 0.35); }
  .imp {
    position: fixed; z-index: 211; top: 50%; left: 50%; transform: translate(-50%, -50%);
    width: min(92vw, 30rem); max-height: 85vh; overflow-y: auto;
    background: var(--col-bg); color: var(--text);
    border: 1px solid var(--border); border-radius: 10px;
    padding: 1.3rem 1.5rem 1.4rem; font-family: var(--font-ui);
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.3);
  }
  h2 { font-size: 1.05rem; font-weight: 700; margin: 0 0 0.9rem; }
  code { font-size: 0.85em; }
  .imp-note { font-size: 0.83rem; color: var(--text-mid); line-height: 1.5; margin: 0.6rem 0; }
  .imp-drop {
    display: flex; flex-direction: column; align-items: center; gap: 0.5rem;
    text-align: center; cursor: pointer; color: var(--text-mid);
    border: 1.5px dashed var(--border); border-radius: 10px;
    background: var(--page-bg); padding: 1.6rem 1.2rem; margin: 0.8rem 0 0.4rem;
    transition: border-color 0.12s ease, background-color 0.12s ease, color 0.12s ease;
  }
  .imp-drop:hover, .imp-drop:focus-visible {
    border-color: var(--accent); color: var(--text);
  }
  .imp-drop:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .imp-drop-hover {
    border-color: var(--accent); background: color-mix(in srgb, var(--accent) 8%, var(--page-bg));
    color: var(--text);
  }
  .imp-drop-icon { flex: none; }
  .imp-drop-text { font-size: 0.9rem; line-height: 1.5; margin: 0; }
  .imp-drop-text b { color: var(--text); }
  .imp-field { display: block; margin: 0 0 0.8rem; font-size: 0.85rem; }
  .imp-field > span { display: block; font-weight: 600; margin-bottom: 0.25rem; }
  .imp-field input[type="text"], .imp-field select, .imp-field textarea {
    width: 100%; box-sizing: border-box; font: inherit; color: var(--text);
    background: var(--page-bg); border: 1px solid var(--border); border-radius: 6px;
    padding: 0.45rem 0.6rem;
  }
  .imp-field input:focus, .imp-field select:focus, .imp-field textarea:focus { outline: none; border-color: var(--accent); }
  .imp-check-row { display: flex; gap: 0.45rem; align-items: flex-start; margin: 0 0 0.8rem; font-size: 0.85rem; }
  .imp-edition-facts { margin: 0.3rem 0 0.8rem; font-size: 0.84rem; }
  .imp-edition-facts div { display: grid; grid-template-columns: 8rem 1fr; gap: 0.5rem; padding: 0.2rem 0; }
  .imp-edition-facts dt { color: var(--text-mid); }
  .imp-edition-facts dd { margin: 0; font-weight: 600; }
  .imp-covered-books { border: 1px solid var(--border); border-radius: 8px; padding: 0.6rem 0.8rem; }
  .imp-covered-books legend { font-weight: 600; padding: 0 0.3rem; }
  .imp-book-choices { display: flex; flex-wrap: wrap; gap: 0.45rem 0.9rem; }
  .imp-book-choices label { display: inline-flex; align-items: center; gap: 0.3rem; }
  .imp-edition-override { margin-bottom: 0.8rem; }
  .imp-citation { resize: vertical; line-height: 1.4; font-size: 0.85rem; }
  .imp-radio { border: 1px solid var(--border); border-radius: 8px; padding: 0.6rem 0.8rem; margin: 0 0 0.8rem; }
  .imp-radio legend { font-weight: 600; font-size: 0.85rem; padding: 0 0.3rem; }
  .imp-radio label { display: block; margin: 0.35rem 0; font-size: 0.85rem; }
  .imp-actions { display: flex; gap: 0.6rem; margin-top: 1rem; flex-wrap: wrap; }
  /* One declaration per row: the two answers are sentences, not chips, and
     must never wrap into each other on a narrow dialog. */
  .imp-mode-actions { flex-direction: column; align-items: stretch; }
  .imp-mode-actions button { text-align: left; padding: 0.6rem 0.9rem; }
  .imp-actions button {
    font: inherit; font-size: 0.85rem; font-weight: 600; cursor: pointer;
    border: 1px solid var(--border); border-radius: 6px;
    background: transparent; color: var(--text);
    padding: 0.45rem 0.9rem;
  }
  .imp-actions button:disabled { opacity: 0.5; cursor: default; }
  .imp-primary { background: var(--accent) !important; color: var(--on-accent) !important; border-color: var(--accent) !important; }
  .imp-primary:disabled { opacity: 0.5; cursor: default; }
  .imp-quiet { color: var(--text-mid) !important; }
  .imp-progress { font-size: 0.9rem; color: var(--text-mid); }
  .imp-summary { font-size: 0.9rem; margin: 0 0 0.6rem; }
  .imp-stats { font-size: 0.88rem; line-height: 1.7; margin: 0; padding-left: 1.2rem; }
  .imp-warn { margin-top: 0.8rem; font-size: 0.82rem; color: var(--text-mid); }
  .imp-warn ul { margin: 0.4rem 0 0; padding-left: 1.2rem; }
  .imp-error { font-size: 0.88rem; color: var(--error); line-height: 1.5; }
  .imp-help { margin-top: 1rem; font-size: 0.83rem; }
  .imp-help summary { cursor: pointer; font-weight: 600; color: var(--accent); }
  .imp-help-body { margin-top: 0.5rem; color: var(--text-mid); line-height: 1.55; }
  .imp-help-body dl { margin: 0.5rem 0; }
  .imp-help-body dt { float: left; clear: left; width: 4.5rem; font-weight: 600; }
  .imp-help-body dd { margin: 0 0 0.4rem 5rem; }
  .imp-help-body pre {
    background: var(--page-bg); border: 1px solid var(--border); border-radius: 6px;
    padding: 0.5rem 0.7rem; font-size: 0.78rem; white-space: pre-wrap; line-height: 1.5;
  }
  .imp-help-body b { color: var(--text); }
  .imp-review-ctx {
    font-family: var(--font-english); font-size: 0.95rem; line-height: 1.6;
    background: var(--page-bg); border: 1px solid var(--border); border-radius: 8px;
    padding: 0.7rem 0.9rem; margin: 0.8rem 0;
  }
  .imp-review-list { display: grid; gap: 0.65rem; margin-top: 0.8rem; }
  .imp-review-row {
    display: grid; grid-template-columns: 1fr auto 1fr; gap: 0.55rem; align-items: center;
    width: 100%; text-align: left; font: inherit; color: var(--text);
    background: var(--page-bg); border: 1px solid var(--accent); border-radius: 8px;
    padding: 0.65rem 0.75rem; cursor: pointer;
  }
  .imp-review-row span { font-family: var(--font-english); line-height: 1.45; }
  .imp-review-row b { font-size: 0.72rem; color: var(--accent); white-space: nowrap; }
  .imp-review-excluded { border-color: var(--border); opacity: 0.72; }
  .imp-review-excluded b { color: var(--text-mid); }
  .imp-deletion-row {
    background: var(--page-bg); border: 1px solid var(--border); border-radius: 8px;
    padding: 0.65rem 0.75rem;
  }
  .imp-deletion-row > p { margin: 0.2rem 0; font-family: var(--font-english); line-height: 1.45; }
  .imp-deletion-hit { font-weight: 700; color: var(--error); }
  .imp-item-actions { margin-top: 0.5rem; }
  .imp-choice-active { border-color: var(--accent) !important; color: var(--accent) !important; }
  .imp-emph-hit {
    background: var(--accent-soft, rgba(139, 90, 43, 0.18));
    color: inherit; font-weight: 600;
    border-radius: 3px; padding: 0 0.15em;
    box-decoration-break: clone; -webkit-box-decoration-break: clone;
  }
</style>
