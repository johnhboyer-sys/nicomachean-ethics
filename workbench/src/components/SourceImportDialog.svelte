<script lang="ts">
  // "Import a text…" — bring in any author from a TLG/PHI disc or from Perseus,
  // keeping the citations the source printed (src/lib/import/createSourceImport.ts).
  //
  // Three routes in one dialog because they end in the same place: rows with
  // addresses. They differ only in where the TEI comes from, and in what they
  // need installed — the disc route needs Diogenes to read the disc, the two
  // Perseus routes need nothing. The dialog says so rather than letting a user
  // discover it from a failure.
  import { pickDiscDir, readDiscAuthors, readAuthorWorks, importFromDisc } from '../lib/import/discImport';
  import type { DiscAuthor } from '../lib/corpus/authtab';
  import type { DiscWork } from '../lib/corpus/idtWorks';
  import type { Corpus, LineMode } from '../lib/corpus/discExport';
  import { filterAuthors } from '../lib/corpus/authtab';
  import { fetchPerseusTei, importPerseusTei, parseCtsUrn, languageFor } from '../lib/import/perseusSource';
  import type { SourceImport } from '../lib/import/createSourceImport';
  import { serializeChapterFile } from '../lib/chapterfile';
  import { libraryStorage, chapterFileName } from '../lib/library/storage';
  import { registerFreeWork } from '../lib/works/freeWorks';
  import { loadSettings, updateSettings } from '../lib/settings';

  let {
    existingIds,
    onClose,
    onCreated,
  }: {
    existingIds: string[];
    onClose: () => void;
    onCreated: (workId: string) => void;
  } = $props();

  type Route = 'disc' | 'file' | 'link';

  let route = $state<Route>('disc');
  let errorMessage = $state<string | null>(null);
  /** Set while a slow step runs; also the text shown on the button. */
  let busy = $state<string | null>(null);

  // ── disc route ────────────────────────────────────────────────────────────
  let discDir = $state<string | null>(null);
  let authors = $state<DiscAuthor[]>([]);
  let authorQuery = $state('');
  let selectedAuthor = $state<DiscAuthor | null>(null);
  let works = $state<DiscWork[]>([]);
  let selectedWork = $state<DiscWork | null>(null);
  // Verse by default: it is the only mode that keeps the edition's line
  // numbers, and it is what the corpus pipeline has always run.
  let lineMode = $state<LineMode>('lines');

  // Cap what's rendered: a TLG disc lists ~1,800 authors and drawing them all
  // makes every keystroke in the filter box janky.
  const AUTHOR_LIMIT = 200;
  const matchingAuthors = $derived(filterAuthors(authors, authorQuery));
  const shownAuthors = $derived(matchingAuthors.slice(0, AUTHOR_LIMIT));
  const hiddenAuthorCount = $derived(matchingAuthors.length - shownAuthors.length);

  // ── perseus routes ────────────────────────────────────────────────────────
  let fileXml = $state<string | null>(null);
  let fileName = $state<string | null>(null);
  let link = $state('');
  const linkUrn = $derived(link.trim().length === 0 ? null : parseCtsUrn(link));

  $effect(() => {
    void (async () => {
      const settings = await loadSettings();
      const saved = settings.tlgDir ?? settings.phiDir;
      if (saved && discDir === null) await useDisc(saved, null);
    })();
  });

  /**
   * What to show the user for a thrown value. Tauri's `invoke` rejects with a
   * plain STRING, not an Error, so an `instanceof Error` check alone throws
   * away the only useful sentence — a missing fs permission surfaced as the
   * generic fallback and said nothing about which permission.
   */
  function messageOf(err: unknown, fallback: string): string {
    if (err instanceof Error) return err.message;
    if (typeof err === 'string' && err.trim().length > 0) return err;
    return fallback;
  }

  /**
   * One button per disc. Which corpus a folder holds is the user's to say, not
   * ours to infer: the two discs sit in separate folders, Diogenes reads them
   * through separate environment variables, and the app remembers them
   * separately — so guessing from the first author id it happened to find was
   * both fragile and a thing the user could not correct.
   */
  async function chooseDisc(corpus: Corpus) {
    let picked: string | null;
    try {
      picked = await pickDiscDir(corpus);
    } catch (err) {
      // The native folder picker can refuse (no permission, plugin missing).
      // Unhandled, the button simply did nothing and said nothing.
      console.error('[import] choosing the disc folder failed', err);
      errorMessage = messageOf(err, 'That folder could not be opened.');
      return;
    }
    if (picked === null) return;
    await useDisc(picked, corpus);
  }

  /** Read a disc folder's author list. A corpus given means remember it. */
  async function useDisc(dir: string, corpus: Corpus | null) {
    errorMessage = null;
    busy = 'Reading the disc…';
    try {
      const list = await readDiscAuthors(dir);
      authors = list;
      discDir = dir;
      selectedAuthor = null;
      works = [];
      selectedWork = null;
      if (corpus !== null) {
        await updateSettings(corpus === 'phi' ? { phiDir: dir } : { tlgDir: dir });
      }
    } catch (err) {
      console.error('[import] reading disc failed', err);
      errorMessage = messageOf(err, 'That folder could not be read.');
    } finally {
      busy = null;
    }
  }

  async function chooseAuthor(author: DiscAuthor) {
    if (discDir === null) return;
    selectedAuthor = author;
    selectedWork = null;
    works = [];
    errorMessage = null;
    try {
      works = await readAuthorWorks(discDir, author);
    } catch (err) {
      console.error('[import] reading works failed', err);
      errorMessage = messageOf(err, 'That author’s works could not be read.');
    }
  }

  async function pickTeiFile() {
    errorMessage = null;
    // Every step here can reject — the picker (no permission), and the read
    // (a file outside the app's allowed scope, or gone since it was picked).
    // Unhandled, the rejection went to the console and the dialog just sat
    // there still saying "Choose a TEI file first."
    try {
      const dialog = await import('@tauri-apps/plugin-dialog');
      const path = await dialog.open({
        multiple: false,
        title: 'Choose a TEI file',
        filters: [{ name: 'TEI XML', extensions: ['xml'] }],
      });
      if (typeof path !== 'string') return;
      const fs = await import('@tauri-apps/plugin-fs');
      fileXml = await fs.readTextFile(path);
      fileName = path.split(/[\\/]/).pop() ?? path;
    } catch (err) {
      console.error('[import] reading the TEI file failed', err);
      errorMessage = messageOf(err, 'That file could not be read.');
    }
  }

  const blocked = $derived(
    busy
      ? busy
      : route === 'disc'
        ? discDir === null
          ? 'Choose your TLG or PHI folder first.'
          : selectedWork === null
            ? 'Choose a work.'
            : null
        : route === 'file'
          ? fileXml === null
            ? 'Choose a TEI file first.'
            : null
          : link.trim().length === 0
            ? 'Paste a Scaife address or CTS urn.'
            : linkUrn === null
              ? 'That doesn’t look like a Perseus address.'
              : null,
  );

  async function build(): Promise<SourceImport> {
    if (route === 'disc') {
      // Diogenes cannot export one work, so the first import of an author
      // exports all of them. Say so instead of looking frozen.
      busy = `Reading ${selectedAuthor?.name ?? 'the author'} from the disc — this can take a few minutes the first time…`;
      return importFromDisc({ discDir: discDir!, author: selectedAuthor!, work: selectedWork!, lineMode, existingIds });
    }
    if (route === 'file') {
      busy = 'Reading the file…';
      return importPerseusTei(fileXml!, { existingIds });
    }
    busy = 'Fetching from Perseus…';
    const xml = await fetchPerseusTei(link);
    return importPerseusTei(xml, {
      ...(linkUrn ? { language: languageFor(linkUrn) } : {}),
      existingIds,
    });
  }

  async function importNow() {
    if (blocked) return;
    errorMessage = null;
    try {
      const { work, file } = await build();
      busy = 'Saving…';
      await libraryStorage().write(work.id, chapterFileName(1, 1), serializeChapterFile(file));
      await registerFreeWork(work);
      onCreated(work.id);
    } catch (err) {
      console.error('[import] failed', err);
      errorMessage = messageOf(err, 'That text could not be imported.');
    } finally {
      busy = null;
    }
  }
</script>

<div class="scrim" role="presentation">
  <div class="dialog" role="dialog" aria-modal="true" aria-label="Import a text">
    <header class="dialog-head">
      <h2>Import a text</h2>
      <button class="close-btn" onclick={onClose} aria-label="Close">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
    </header>

    <div class="dialog-body">
      <div class="routes" role="tablist" aria-label="Where the text comes from">
        <button role="tab" aria-selected={route === 'disc'} class:active={route === 'disc'} onclick={() => (route = 'disc')}>
          TLG or PHI disc
        </button>
        <button role="tab" aria-selected={route === 'file'} class:active={route === 'file'} onclick={() => (route = 'file')}>
          A file
        </button>
        <button role="tab" aria-selected={route === 'link'} class:active={route === 'link'} onclick={() => (route = 'link')}>
          Perseus
        </button>
      </div>

      {#if route === 'disc'}
        <p class="note">
          Reading a TLG or PHI disc needs Diogenes installed — it does the work of decoding the disc.
          The other two ways of importing need nothing.
        </p>

        <div class="row">
          <button class="secondary-btn" onclick={() => chooseDisc('tlg')}>Choose your TLG folder…</button>
          <button class="secondary-btn" onclick={() => chooseDisc('phi')}>Choose your PHI folder…</button>
        </div>
        {#if discDir}
          <p class="path">Reading {discDir}</p>
        {/if}

        {#if authors.length > 0}
          <label class="field">
            <span>Author</span>
            <input type="text" bind:value={authorQuery} placeholder="Type to narrow {authors.length} authors" />
          </label>

          <ul class="picker">
            {#each shownAuthors as author (author.id)}
              <li>
                <button class:selected={selectedAuthor?.id === author.id} onclick={() => chooseAuthor(author)}>
                  {author.name}
                </button>
              </li>
            {/each}
          </ul>
          {#if hiddenAuthorCount > 0}
            <p class="hint">…and {hiddenAuthorCount} more — keep typing to narrow the list.</p>
          {/if}
        {/if}

        {#if works.length > 0}
          <ul class="picker">
            {#each works as work (work.number)}
              <li>
                <button class:selected={selectedWork?.number === work.number} onclick={() => (selectedWork = work)}>
                  {work.title}
                  <span class="levels">{work.levelNames.join(' · ')}</span>
                </button>
              </li>
            {/each}
          </ul>
        {:else if selectedAuthor}
          <p class="hint">That author has no works listed on this disc.</p>
        {/if}

        {#if selectedWork}
          <label class="field">
            <span>Rows</span>
            <select bind:value={lineMode}>
              <option value="lines">One printed line each, numbered — 402a.1, 402a.2</option>
              <option value="prose">One section each, lines run together — 402a</option>
              <option value="auto">Whatever Diogenes judges right for this work</option>
            </select>
          </label>
          <p class="hint">
            Numbered lines are what a citation like <em>De anima</em> 402a.7 refers to. Running them
            together reads better but loses the numbers, and Diogenes' own judgment calls most of
            Aristotle prose.
          </p>
        {/if}
      {:else if route === 'file'}
        <p class="note">
          A TEI file you downloaded — from Perseus, the First1KGreek project, or anywhere else that
          publishes TEI. The citations come from the file.
        </p>
        <div class="row">
          <button class="secondary-btn" onclick={pickTeiFile}>Choose a TEI file…</button>
          {#if fileName}
            <span class="path">{fileName}</span>
          {/if}
        </div>
      {:else}
        <p class="note">
          Paste an address from Scaife, or a CTS urn. The whole work is imported, so a passage
          reference on the end is ignored.
        </p>
        <label class="field">
          <span>Address</span>
          <input type="text" bind:value={link} placeholder="urn:cts:greekLit:tlg0059.tlg030.perseus-grc2" />
        </label>
        {#if linkUrn}
          <p class="hint">{linkUrn.group}.{linkUrn.work}{linkUrn.version ? `.${linkUrn.version}` : ''} — {languageFor(linkUrn) ?? 'unknown language'}</p>
        {/if}
      {/if}

      {#if errorMessage}
        <p class="error">{errorMessage}</p>
      {/if}
    </div>

    <footer class="dialog-foot">
      {#if blocked && !busy}
        <span class="hint">{blocked}</span>
      {/if}
      <button class="primary-btn" disabled={blocked !== null} onclick={importNow}>
        {busy ? 'Working…' : 'Import'}
      </button>
    </footer>
  </div>
</div>

<style>
  .scrim {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.22);
    display: grid;
    place-items: center;
    z-index: 50;
  }

  .dialog {
    /* Sized to the window, not to a guess. The author list on a TLG disc runs
       to ~1,800 names and the work list to 56 for Aristotle alone, so the
       lists want every row the screen can give them. */
    width: min(44rem, calc(100vw - 2rem));
    height: min(46rem, calc(100vh - 4rem));
    display: flex;
    flex-direction: column;
    background: var(--col-bg);
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
    margin: 0;
    font-size: 0.85rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .close-btn {
    background: none;
    border: 0;
    color: var(--text-light);
    cursor: pointer;
    padding: var(--space-1);
  }

  .dialog-body {
    flex: 1;
    overflow-y: auto;
    padding: var(--space-4);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .routes {
    display: flex;
    gap: var(--space-1);
    border-bottom: 1px solid var(--border);
  }

  .routes button {
    background: none;
    border: 0;
    border-bottom: 2px solid transparent;
    padding: var(--space-2) var(--space-3);
    color: var(--text-mid);
    cursor: pointer;
    font: inherit;
  }

  .routes button.active {
    color: var(--text);
    border-bottom-color: var(--accent, currentColor);
  }

  .note {
    margin: 0;
    color: var(--text-mid);
    font-size: 0.9rem;
    line-height: 1.5;
  }

  .row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  .path {
    margin: 0;
    color: var(--text-light);
    font-size: 0.8rem;
    word-break: break-all;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .field span {
    font-size: 0.8rem;
    color: var(--text-mid);
  }

  .field input {
    font: inherit;
    padding: var(--space-2);
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--input-bg);
    color: var(--text);
  }

  .picker {
    list-style: none;
    margin: 0;
    padding: 0;
    /* Share out whatever the dialog has left rather than taking a fixed slice:
       with one list open it fills the panel, with both open they split it. */
    flex: 1 1 12rem;
    min-height: 8rem;
    overflow-y: auto;
    border: 1px solid var(--border);
    border-radius: 6px;
  }

  .picker button {
    display: flex;
    justify-content: space-between;
    gap: var(--space-3);
    width: 100%;
    text-align: left;
    background: none;
    border: 0;
    padding: var(--space-2) var(--space-3);
    color: var(--text);
    cursor: pointer;
    font: inherit;
  }

  .picker button.selected {
    background: var(--ui-hover);
  }

  .levels {
    color: var(--text-light);
    font-size: 0.75rem;
    white-space: nowrap;
  }

  .hint {
    margin: 0;
    color: var(--text-light);
    font-size: 0.8rem;
  }

  .error {
    margin: 0;
    color: var(--error);
    font-size: 0.9rem;
  }

  .dialog-foot {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4);
    border-top: 1px solid var(--border);
  }

  .primary-btn {
    font: inherit;
    padding: var(--space-2) var(--space-4);
    border: 0;
    border-radius: 6px;
    background: var(--accent, #6b4423);
    color: var(--on-accent, #fff);
    cursor: pointer;
  }

  .primary-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .secondary-btn {
    font: inherit;
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--border);
    border-radius: 6px;
    background: none;
    color: var(--text);
    cursor: pointer;
  }
</style>
