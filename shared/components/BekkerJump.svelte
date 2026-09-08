<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { fetchColumns, lineRef, parseBekker, resolveBekker, type ColumnRef } from '../lib/data';
  import { getWork, workPath } from '../lib/works';

  export let work: string = 'EN';
  // Navigation strategy: the site leaves this unset and navigates the tab;
  // the desktop shell passes a callback (a Tauri window has no URL routing).
  export let onJump: ((book: number, column: string, line: number) => void) | null = null;
  // Hosts that mount more than one instance per page must pass distinct ids
  // (the site's ReaderShell mounts two) or the label/input pairing collides.
  // Deterministic prop rather than a generated id: this component is
  // server-rendered, so a random/counter id would break hydration.
  export let inputId = 'bekker-input';

  $: workMeta = getWork(work);

  let open = false;
  let value = '';
  let error = '';
  let columns: Record<string, ColumnRef[]> | null = null;
  let inputEl: HTMLInputElement | undefined;

  // Preload the column index so the first lookup is instant; re-preload when
  // the shell switches works under us (desktop).
  onMount(() => { preload(); });
  $: if (work) preload();
  function preload() {
    columns = null;
    fetchColumns(work).then(c => (columns = c)).catch(() => {});
  }

  async function openBox() {
    open = true;
    error = '';
    await tick();
    inputEl?.focus();
  }

  function closeBox() {
    open = false;
    error = '';
    value = '';
  }

  async function go() {
    error = '';
    const ref = parseBekker(value);
    if (!ref) {
      error = 'Enter a Bekker citation, e.g. 1097a15';
      return;
    }
    const cols = columns ?? (await fetchColumns(work).catch(() => null));
    if (!cols) { error = 'Could not load the index — try again'; return; }
    const book = resolveBekker(cols, ref.column, ref.line);
    if (book == null) {
      error = `${ref.column} is not in the ${workMeta?.title ?? 'text'}`;
      return;
    }
    if (onJump) {
      closeBox();
      onJump(book, ref.column, ref.line);
      return;
    }
    // Same-tab navigation; the reader snaps to the nearest line if exact is absent.
    // A typed "775a11a" parses its letter, so the citation must carry it too —
    // dropping it here landed the reader on the unlettered line.
    window.location.href = `${import.meta.env.BASE_URL.replace(/\/$/, '')}${workPath(work, book)}?loc=${ref.column}:${lineRef(ref.line, ref.sub)}`;
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') { e.preventDefault(); closeBox(); }
  }
</script>

{#if !open}
  <button class="bekker-toggle" on:click={openBox} title="Look up a Bekker citation">
    Go to Bekker line
  </button>
{:else}
  <form class="bekker-jump" on:submit|preventDefault={go} role="search">
    <label class="bekker-label" for={inputId}>Bekker line</label>
    <input
      id={inputId}
      type="text"
      bind:this={inputEl}
      bind:value
      on:keydown={onKey}
      on:input={() => (error = '')}
      placeholder="e.g. 1097a15"
      aria-label="Jump to a Bekker citation"
      spellcheck="false"
      autocapitalize="off"
      autocomplete="off"
    />
    <button type="submit">Go</button>
    <button type="button" class="bekker-close" on:click={closeBox} aria-label="Close">✕</button>
    {#if error}<span class="bekker-err" role="alert">{error}</span>{/if}
  </form>
{/if}
