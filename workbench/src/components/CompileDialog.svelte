<script lang="ts">
  // Whole-work compile export (build spec §8, Phase 2). Tauri-only, mirrors
  // ExportButton.svelte's degraded-state rule: every failure is one plain
  // sentence; stderr goes to the console only. Reads every saved chapter of
  // the work directly from library storage (not just the currently open
  // one), compiles them into one .docx via lib/export, and shows the
  // compact gap notice before/while the user decides.
  import { isTauri } from '../lib/runtime';
  import { libraryStorage, chapterFileName } from '../lib/library/storage';
  import { getScheme } from '../lib/citation/registry';
  import { parseChapterFile } from '../lib/chapterfile';
  import type { ChapterFile } from '../lib/chapterfile/types';
  import {
    exportWorkToDocx,
    buildGapReport,
    compileDefaultFilename,
    PANDOC_UNAVAILABLE_MESSAGE,
  } from '../lib/export';
  import type { BilingualLayout, BilingualOrder, CompileMode, StampMode } from '../lib/export';
  import {
    defaultSavePath,
    exportSettings,
    resolveExportPandoc,
    resolveReferenceDoc,
  } from '../lib/export/tauriExport';
  import type { WorkManifest } from '../lib/works/manifest';

  let {
    work,
    onClose,
  }: {
    work: WorkManifest;
    onClose: () => void;
  } = $props();

  type Phase = 'loading' | 'ready' | 'empty' | 'exporting' | 'done';
  type FileType = 'docx' | 'markdown';
  let phase = $state<Phase>('loading');
  let note = $state<string | null>(null);
  let mode = $state<CompileMode>('english');
  let fileType = $state<FileType>('docx');
  let chapters = $state<ChapterFile[]>([]);
  let gapSummary = $state<string>('');

  // Seeded from Settings › Export, then editable for THIS export only — a
  // change here is not written back, so the settings stay the standing default.
  let bilingualLayout = $state<BilingualLayout>('block');
  let bilingualOrder = $state<BilingualOrder>('original-first');
  let stampMode: StampMode | undefined;

  const CHAPTER_FILE_RE = /^b\d{2,}c\d{2,}\.md$/;

  async function loadChapters() {
    phase = 'loading';
    try {
      const prefs = await exportSettings();
      mode = prefs.mode ?? 'english';
      // With no configured layout, seed the one THIS work's rendering path has
      // always used, so an unset setting exports exactly as it did before —
      // block for a corpus (Bekker) work, alternating for a document spine.
      bilingualLayout =
        prefs.bilingualLayout ??
        (getScheme(work.scheme).spineSource === 'document' ? 'alternating' : 'block');
      bilingualOrder = prefs.bilingualOrder ?? 'original-first';
      stampMode = prefs.stampMode;

      const storage = libraryStorage();
      // A document-spine work is ONE file (its in-text marks become the
      // chapters at export time — documentCompileInput below). Only ever
      // consider its primary b01c01, so the gap report can't imply completeness
      // from stray leftover files that the export would silently drop.
      const isDoc = getScheme(work.scheme).spineSource === 'document';
      const files = (await storage.list(work.id)).filter(
        (f) => CHAPTER_FILE_RE.test(f) && (!isDoc || f === chapterFileName(1, 1)),
      );
      const loaded: ChapterFile[] = [];
      const skipped: string[] = [];
      for (const file of files) {
        const raw = await storage.read(work.id, file);
        if (!raw) continue;
        try {
          loaded.push(parseChapterFile(raw, file));
        } catch (err) {
          // A corrupt chapter file shouldn't block compiling every other
          // chapter — skip it and note it plainly, same "degrade, don't
          // block" spirit as onboarding's chapters.json handling.
          console.error(`[compile] skipping unreadable chapter file ${file}`, err);
          skipped.push(file);
        }
      }
      chapters = loaded;
      // Say it in the dialog, not only the console: a chapter that can't be
      // read is LEFT OUT of the export, and a Word file quietly missing a
      // chapter reads as finished work. Shown before the user exports, so the
      // choice is theirs.
      note =
        skipped.length === 0
          ? null
          : skipped.length === 1
            ? `One chapter file couldn’t be read (${skipped[0]}) — it will be left out.`
            : `${skipped.length} chapter files couldn’t be read — they will be left out.`;
      if (loaded.length === 0) {
        phase = 'empty';
        return;
      }
      gapSummary = buildGapReport(
        loaded.map((c) => ({ book: c.meta.book, chapter: c.meta.chapter })),
        work,
      ).summary;
      phase = 'ready';
    } catch (err) {
      console.error('[compile] failed to read the library', err);
      phase = 'empty';
      note = "This work's saved chapters couldn't be read.";
    }
  }

  $effect(() => {
    void loadChapters();
  });

  async function runExport() {
    if (phase !== 'ready' || chapters.length === 0) return;
    phase = 'exporting';
    note = null;
    const asMarkdown = fileType === 'markdown';
    try {
      // Pandoc is only required for Word. Markdown export writes the compiled
      // markdown straight to the save path — no probe, no intermediate file.
      const prefs = await exportSettings();
      let pandoc: Awaited<ReturnType<typeof resolveExportPandoc>> | null = null;
      if (!asMarkdown) {
        // resolveExportPandoc honours a pandoc chosen in Settings › Export and
        // otherwise runs the same GUI-PATH probe this used to run inline.
        const resolved = await resolveExportPandoc(prefs.pandocPath);
        if ('message' in resolved) {
          note = resolved.message;
          phase = 'ready';
          return;
        }
        pandoc = resolved;
      }

      const dialog = await import('@tauri-apps/plugin-dialog');
      // compileDefaultFilename always returns .docx; swap extension for markdown
      // here so other export paths that share that helper stay unchanged.
      const defaultPath = await defaultSavePath(
        asMarkdown
          ? compileDefaultFilename(work, mode).replace(/\.docx$/i, '.md')
          : compileDefaultFilename(work, mode),
        prefs.outputDir,
      );
      const savePath = await dialog.save({
        defaultPath,
        filters: asMarkdown
          ? [{ name: 'Markdown', extensions: ['md'] }]
          : [{ name: 'Word document', extensions: ['docx'] }],
      });
      if (!savePath) {
        phase = 'ready';
        return; // user cancelled — not a failure
      }

      // exportWorkToDocx (index.ts) runs pandoc via node:child_process,
      // which doesn't exist under Tauri's webview — so the compile step
      // here mirrors ExportButton's split: build markdown via the same
      // compile module, run pandoc via the Tauri shell runner.
      const { compileWorkMarkdown } = await import('../lib/export/compile');
      // A marker-driven document work is one file — split it at its in-text
      // Book/Chapter marks so the export carries those headings (the marks ARE
      // the chapters). Corpus works compile their scanned chapter files as-is.
      let compileChapters = chapters;
      let compileWork: typeof work = work;
      const { getScheme } = await import('../lib/citation/registry');
      if (getScheme(work.scheme).spineSource === 'document' && chapters.length > 0) {
        const primary = chapters.find((c) => c.meta.book === 1 && c.meta.chapter === 1) ?? chapters[0];
        const { documentCompileInput } = await import('../lib/export/documentExport');
        const prepared = documentCompileInput(primary, work);
        compileChapters = prepared.chapters;
        compileWork = prepared.work as typeof work;
      }
      const compiled = compileWorkMarkdown(compileChapters, compileWork, {
        mode,
        stampMode,
        bilingualLayout,
        bilingualOrder,
      });

      const fs = await import('@tauri-apps/plugin-fs');
      if (asMarkdown) {
        // The markdown IS the deliverable here, so the pandoc-only language
        // spans around every Greek phrase come back out — they exist to tag
        // Word runs, and nothing downstream of this file reads them.
        const { stripLanguageSpans } = await import('../lib/export');
        await fs.writeTextFile(savePath, stripLanguageSpans(compiled.markdown));
      } else {
        const pathApi = await import('@tauri-apps/api/path');
        const appData = await pathApi.appDataDir();
        await fs.mkdir(appData, { recursive: true }).catch(() => {});
        const mdPath = await pathApi.join(appData, 'export-compile-intermediate.md');

        // The bundler keeps a resource's declared RELATIVE PATH, so
        // "resources/reference.docx" in tauri.conf.json lands at
        // Contents/Resources/resources/reference.docx. Resolving the bare
        // filename produced a path that does not exist, and pandoc — which
        // does not treat a missing --reference-doc as optional — failed every
        // whole-work export. Verify the file is really there and fall back to
        // pandoc's own styling if it is not: a missing template is a worse
        // look, not a reason to refuse the export.
        // The user's own template if they set one, else the bundled resource
        // (whose declared relative path this helper carries — see
        // resolveReferenceDoc).
        const referenceDocPath = await resolveReferenceDoc(prefs.referenceDocPath);

        await fs.writeTextFile(mdPath, compiled.markdown);

        const run = await (pandoc as { run: (job: { markdownPath: string; docxPath: string; referenceDocPath?: string }) => Promise<{ code: number | null; stdout: string; stderr: string }> }).run(
          { markdownPath: mdPath, docxPath: savePath, referenceDocPath },
        );
        if (run.code !== 0) {
          console.error('[compile] pandoc failed:', run.stderr);
          // Say WHAT went wrong. A bare "couldn't be created" leaves the user
          // (and anyone helping them) with nothing to act on — pandoc's own
          // first line names the actual problem.
          note = `The Word document couldn't be created. ${firstLine(run.stderr) || `pandoc exited ${run.code}.`}`;
          phase = 'ready';
          return;
        }
      }

      phase = 'done';
      note = 'Exported.';
      const opener = await import('@tauri-apps/plugin-opener');
      void opener.revealItemInDir(savePath).catch(() => {});
    } catch (err) {
      console.error('[compile]', err);
      const what = asMarkdown ? "The Markdown file couldn't be created." : "The Word document couldn't be created.";
      note = `${what} ${firstLine(err instanceof Error ? err.message : String(err))}`.trim();
      phase = 'ready';
    }
  }

  /** One readable line of a stderr blob / error message for the dialog. */
  function firstLine(text: string | undefined): string {
    const line = (text ?? '').split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
    return line.length > 160 ? `${line.slice(0, 157)}…` : line;
  }
</script>

{#if isTauri()}
  <div class="scrim" role="presentation">
    <div class="dialog" role="dialog" aria-modal="true" aria-label="Export whole work">
      <header class="dialog-head">
        <h2>Export whole work</h2>
        <button class="close-btn" onclick={onClose} aria-label="Close">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </header>

      <div class="dialog-body">
        {#if phase === 'loading'}
          <p class="line">Reading the saved chapters…</p>
        {:else if phase === 'empty'}
          <p class="line">{note ?? 'This work has no saved chapters yet — nothing to export.'}</p>
        {:else}
          <p class="line">{gapSummary}</p>

          <fieldset class="mode-choice">
            <legend>Format</legend>
            <label class="mode-option">
              <input type="radio" name="compile-mode" value="english" disabled={phase === 'exporting'} bind:group={mode} />
              English only
            </label>
            <label class="mode-option">
              <input type="radio" name="compile-mode" value="bilingual" disabled={phase === 'exporting'} bind:group={mode} />
              <!-- Not "Greek and English": a document work's source may be
                   Latin, German, or anything the user imported. -->
              Bilingual
            </label>
          </fieldset>

          <fieldset class="mode-choice">
            <legend>File type</legend>
            <label class="mode-option">
              <input type="radio" name="compile-file-type" value="docx" disabled={phase === 'exporting'} bind:group={fileType} />
              Word (.docx)
            </label>
            <label class="mode-option">
              <input type="radio" name="compile-file-type" value="markdown" disabled={phase === 'exporting'} bind:group={fileType} />
              Markdown (.md)
            </label>
          </fieldset>

          {#if mode === 'bilingual'}
            <fieldset class="mode-choice">
              <legend>Layout</legend>
              <label class="mode-option">
                <input type="radio" name="compile-layout" value="block" bind:group={bilingualLayout} />
                One language after the other
              </label>
              <label class="mode-option">
                <input type="radio" name="compile-layout" value="alternating" bind:group={bilingualLayout} />
                Alternating paragraphs
              </label>
              <label class="mode-option">
                <input type="radio" name="compile-layout" value="table" bind:group={bilingualLayout} />
                Side by side (two-column table)
              </label>
            </fieldset>

            <fieldset class="mode-choice">
              <legend>Order</legend>
              <label class="mode-option">
                <input type="radio" name="compile-order" value="original-first" bind:group={bilingualOrder} />
                Original first
              </label>
              <label class="mode-option">
                <input type="radio" name="compile-order" value="translation-first" bind:group={bilingualOrder} />
                Translation first
              </label>
            </fieldset>
          {/if}

          {#if note}
            <p class="line note">{note}</p>
          {/if}

          <button class="export-btn" onclick={runExport} disabled={phase === 'exporting'}>
            {phase === 'exporting' ? 'Exporting…' : 'Export…'}
          </button>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .scrim {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.22);
    backdrop-filter: blur(2px);
    -webkit-backdrop-filter: blur(2px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 40;
  }

  .dialog {
    width: 380px;
    max-width: calc(100vw - 2 * var(--space-4));
    background: var(--col-bg);
    border: 1px solid var(--border);
    border-radius: 10px;
    box-shadow: var(--popup-shadow);
  }

  .dialog-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--space-3) var(--space-4);
    border-bottom: 1px solid var(--border);
  }
  .dialog-head h2 {
    font-family: var(--font-ui);
    font-size: 0.8rem;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--text-mid);
  }

  .close-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.6rem;
    height: 1.6rem;
    border: none;
    border-radius: 5px;
    background: transparent;
    color: var(--text-mid);
    cursor: pointer;
  }
  .close-btn:hover {
    color: var(--text);
    background: var(--ui-hover);
  }

  .dialog-body {
    padding: var(--space-4);
  }

  .line {
    font-family: var(--font-english);
    font-size: 0.9rem;
    line-height: 1.5;
    color: var(--text-mid);
  }
  .line.note {
    margin-top: var(--space-3);
    color: var(--text);
  }

  .mode-choice {
    margin-top: var(--space-4);
    border: none;
    padding: 0;
  }
  .mode-choice legend {
    font-family: var(--font-ui);
    font-size: 0.72rem;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--text-mid);
    margin-bottom: var(--space-2);
  }
  .mode-option {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-family: var(--font-english);
    font-size: 0.9rem;
    color: var(--text);
    padding: var(--space-1) 0;
    cursor: pointer;
  }

  .export-btn {
    margin-top: var(--space-4);
    width: 100%;
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
  .export-btn:hover:not(:disabled) {
    filter: brightness(1.08);
  }
  .export-btn:disabled {
    opacity: 0.6;
    cursor: default;
  }
</style>
