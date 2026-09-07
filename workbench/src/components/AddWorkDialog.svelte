<script lang="ts">
  // "Add work…" dialog (Tauri only — App never mounts this in the browser
  // harness). One small panel, one calm line at a time. Every failure mode is
  // a single plain sentence; stderr/exit codes never reach the UI (the
  // onboarding module logs them to the console).
  import { onMount } from 'svelte';
  import type { WorkManifest } from '../lib/works/manifest';
  import {
    diogenesAvailable,
    looksLikeTlgDir,
    onboardWork,
    pickTlgDir,
  } from '../lib/data/onboarding';
  import { SPINE_CONFIG } from '../lib/data/spineConfig';
  import { loadSettings, updateSettings } from '../lib/settings';

  let {
    works,
    onClose,
    onOnboarded,
  }: {
    /** Works not yet on this machine (App passes corpus-absent works). */
    works: WorkManifest[];
    onClose: () => void;
    /** Called after a work onboards fully (corpus ready). */
    onOnboarded: (workId: string) => void;
    /** "Import a text…" — where the dialog sends someone when every corpus
     * work is already here. Same action as the library rail's button; App
     * passes the same opener. */
    onImportSource?: () => void;
  } = $props();

  // Only offer works this app version actually knows how to onboard.
  const candidates = works.filter((w) => SPINE_CONFIG[w.id] && w.tlgAuthor && w.tlgWork);

  type Phase = 'checking' | 'blocked' | 'pick' | 'need-tlg' | 'running' | 'done';
  let phase = $state<Phase>('checking');
  let note = $state<string | null>(null);
  let chosen = $state<WorkManifest | null>(null);

  onMount(() => {
    void (async () => {
      if (!(await diogenesAvailable())) {
        phase = 'blocked';
        note = "Diogenes isn't installed on this Mac, so new works can't be added.";
        return;
      }
      phase = 'pick';
    })();
  });

  /** The empty state's one action: close this dialog and open Import a text…. */
  function importInstead() {
    onClose();
    onImportSource?.();
  }

  async function chooseWork(work: WorkManifest) {
    chosen = work;
    note = null;
    const settings = await loadSettings();
    if (settings.tlgDir && (await looksLikeTlgDir(settings.tlgDir))) {
      await run(settings.tlgDir);
    } else {
      phase = 'need-tlg';
    }
  }

  async function chooseTlgFolder() {
    const dir = await pickTlgDir();
    if (dir === null) return; // cancelled — stay put
    if (!(await looksLikeTlgDir(dir))) {
      note = "That folder doesn't contain the TLG texts.";
      return;
    }
    note = null;
    await updateSettings({ tlgDir: dir });
    await run(dir);
  }

  async function run(tlgDir: string) {
    if (!chosen) return;
    phase = 'running';
    note = 'Preparing the Greek text…';
    const outcome = await onboardWork(chosen, tlgDir);
    if (outcome === 'ready') {
      onOnboarded(chosen.id);
      onClose();
      return;
    }
    phase = 'done';
    note =
      outcome === 'export-failed'
        ? "The Greek text couldn't be prepared."
        : "This work isn't fully supported yet.";
  }
</script>

<div class="scrim" role="presentation">
  <div class="dialog" role="dialog" aria-modal="true" aria-label="Add work">
    <header class="dialog-head">
      <h2>Add work</h2>
      <button class="close-btn" onclick={onClose} aria-label="Close">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
    </header>

    <div class="dialog-body">
      {#if phase === 'checking'}
        <p class="line">Checking this Mac…</p>
      {:else if phase === 'blocked' || phase === 'running' || phase === 'done'}
        <p class="line">{note}</p>
      {:else if phase === 'pick'}
        {#if candidates.length === 0}
          {#if onImportSource}
            <p class="line">Every available work is already here — to bring in another text, import it.</p>
            <button class="folder-btn" onclick={importInstead}>Import a text…</button>
          {:else}
            <p class="line">Every available work is already here.</p>
          {/if}
        {:else}
          <p class="line">Choose a work to add:</p>
          <ul class="work-list">
            {#each candidates as work (work.id)}
              <li>
                <button class="work-choice" onclick={() => chooseWork(work)}>
                  {work.title}
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      {:else if phase === 'need-tlg'}
        <p class="line">Choose the folder that holds the TLG texts.</p>
        {#if note}
          <p class="line">{note}</p>
        {/if}
        <button class="folder-btn" onclick={chooseTlgFolder}>Choose folder…</button>
      {/if}
    </div>
  </div>
</div>

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
    width: 340px;
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
  .line + .line {
    margin-top: var(--space-2);
  }

  .work-list {
    list-style: none;
    margin-top: var(--space-3);
  }
  .work-choice {
    display: block;
    width: 100%;
    text-align: left;
    font-family: var(--font-english);
    font-size: 0.95rem;
    color: var(--text);
    background: var(--input-bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: var(--space-2) var(--space-3);
    margin-bottom: var(--space-2);
    cursor: pointer;
  }
  .work-choice:hover {
    border-color: var(--accent-light);
    background: color-mix(in srgb, var(--accent) 5%, var(--input-bg));
  }

  /* The one affirmative action on its screen — a filled accent button, the
     way a native sheet would present its default. */
  .folder-btn {
    margin-top: var(--space-3);
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
  .folder-btn:hover {
    filter: brightness(1.08);
  }
</style>
