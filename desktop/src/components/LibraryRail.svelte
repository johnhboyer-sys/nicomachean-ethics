<script lang="ts">
  // The persistent left library rail: the whole corpus grouped traditionally,
  // everything collapsed except the open work (expanded to its books, the open
  // book expanded to its chapters). Quick-filter narrows by title OR category
  // (typing "logic" surfaces the whole Organon) — tree filtering, deliberately
  // NOT full-text search. Categories collapse/expand and remember it; the
  // group holding the open work re-opens itself. The chapter currently at the
  // top of the reading pane is highlighted live (from the scroll-spy cite).
  import { tick } from 'svelte';
  import { CORPUS_GROUPS, dataId, type CorpusEntry } from '../lib/corpus';
  import { getWork, bookLabel, isBookless } from '@shared/lib/works';
  import { fetchChapters, type ChapterRef } from '@shared/lib/data';
  import { columnKey } from '../lib/translation-file';

  export let currentWork: string;          // data id (works.ts id)
  export let currentBook: number;
  /** The scroll-spy's current citation (location.hash without '#'), or null. */
  export let currentCite: string | null = null;
  export let onOpenWork: (id: string, book?: number) => void;
  export let onOpenChapter: (book: number, chapter: string) => void;

  let filter = '';

  // Chapters of the open work, for the expanded tree (keyed by book).
  let chapters: Record<string, ChapterRef[]> = {};
  let chaptersFor = '';
  $: if (currentWork && currentWork !== chaptersFor) {
    chaptersFor = currentWork;
    chapters = {};
    fetchChapters(currentWork).then(c => {
      if (chaptersFor === currentWork) chapters = c;
    }).catch(() => { chapters = {}; });
  }

  // ── collapsible categories (persisted; filter overrides; open work reveals) ─
  let collapsedGroups = new Set<string>(((): string[] => {
    try { return JSON.parse(localStorage.getItem('desktop-rail-collapsed') ?? '[]'); }
    catch { return []; }
  })());
  function toggleGroup(label: string) {
    if (collapsedGroups.has(label)) collapsedGroups.delete(label);
    else collapsedGroups.add(label);
    collapsedGroups = collapsedGroups; // reassign for reactivity
    try { localStorage.setItem('desktop-rail-collapsed', JSON.stringify([...collapsedGroups])); } catch { /* fine */ }
  }
  // Navigating into a work whose category is collapsed re-opens that category —
  // the rail must never hide where the reader actually is.
  $: {
    const home = CORPUS_GROUPS.find(g => g.entries.some(e => dataId(e) === currentWork));
    if (home && collapsedGroups.has(home.label)) {
      collapsedGroups.delete(home.label);
      collapsedGroups = collapsedGroups;
    }
  }

  // ── filter: by work title OR by category label/aliases ─────────────────────
  const entryMatch = (e: CorpusEntry, terms: string[]) => {
    const hay = `${e.title} ${e.work} ${e.siteSlug ?? ''} ${e.aliases ?? ''}`.toLowerCase();
    return terms.every(t => hay.includes(t));
  };
  $: q = filter.trim().toLowerCase();
  $: terms = q.split(/\s+/).filter(Boolean);
  $: groups = CORPUS_GROUPS
    .map(g => {
      if (!q) return { ...g, matchedAsCategory: false };
      const cat = `${g.label} ${g.aliases ?? ''}`.toLowerCase();
      // Category hit → the whole group, expanded; else filter its works.
      if (terms.every(t => cat.includes(t))) return { ...g, matchedAsCategory: true };
      return { ...g, entries: g.entries.filter(e => entryMatch(e, terms)), matchedAsCategory: false };
    })
    .filter(g => g.entries.length > 0);
  // While filtering, collapse state is ignored — a filter that hides its own
  // results would be lying about what matched.
  $: isCollapsed = (label: string) => !q && collapsedGroups.has(label);

  const metaOf = (e: CorpusEntry) => getWork(dataId(e));
  const bookList = (e: CorpusEntry) => {
    const m = metaOf(e);
    if (!m || isBookless(m)) return [];
    return Array.from({ length: m.books }, (_, i) => i + 1);
  };

  // ── live chapter highlight from the scroll-spy citation ────────────────────
  // Bekker works: the cite ("1097a15" or bare column "1097a") maps to the last
  // chapter of the current book whose start position <= the cite's position.
  // Pages of 1–2 digits are Bekker too (Categories 1a–15b, De Interpretatione
  // 16a–24b) — the shared parseBekker only accepts 3–4, so the cite is parsed
  // here. Non-Bekker works (busse): exact column match only.
  const citePos = (column: string, line: number) => columnKey(column) * 1000 + line;
  const BEKKER_CITE = /^(\d{1,4}[ab])\.?(\d+)?$/;
  $: activeChapter = ((): string | null => {
    if (!currentCite) return null;
    const list = chapters[String(currentBook)];
    if (!list?.length) return null;
    const m = currentCite.trim().toLowerCase().replace(/\s+/g, '').match(BEKKER_CITE);
    if (!m) {
      return list.find(c => c.column === currentCite)?.chapter ?? null;
    }
    const pos = citePos(m[1], m[2] ? Number(m[2]) : 1);
    let best: string | null = null;
    for (const c of list) {
      if (citePos(c.column, Number(c.line) || 1) <= pos) best = c.chapter;
      else break;
    }
    return best ?? list[0]?.chapter ?? null;
  })();
  // Keep the highlighted chapter visible in the rail without yanking it.
  $: if (activeChapter !== null) {
    tick().then(() => {
      document.querySelector('.rail-chapter.active')
        ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  }
</script>

<nav class="rail" aria-label="Library">
  <div class="rail-filter">
    <input
      type="search"
      bind:value={filter}
      placeholder="Filter works…"
      aria-label="Filter the library by title"
      spellcheck="false"
    />
  </div>

  {#each groups as group (group.label)}
    <div class="rail-group">
      <button
        class="rail-group-label"
        aria-expanded={!isCollapsed(group.label)}
        on:click={() => toggleGroup(group.label)}
      >
        <span class="rail-group-caret" class:closed={isCollapsed(group.label)} aria-hidden="true">▾</span>
        {group.label}
      </button>
      {#if !isCollapsed(group.label)}
      <ul>
        {#each group.entries as entry}
          {@const id = dataId(entry)}
          {@const live = entry.live && !!metaOf(entry)}
          {@const isOpen = live && id === currentWork}
          <li class:open={isOpen}>
            {#if live}
              <button
                class="rail-work"
                class:current={isOpen}
                on:click={() => onOpenWork(id)}
              >
                <span class="rail-title">{entry.title}</span>
                {#if entry.author && entry.author !== 'aristotle'}
                  <span class="rail-badge author">{entry.author}</span>
                {/if}
                {#if entry.authenticity && entry.authenticity !== 'genuine'}
                  <span class="rail-badge {entry.authenticity}">{entry.authenticity}</span>
                {/if}
              </button>
            {:else}
              <span class="rail-work planned" title="Not yet in the corpus">
                <span class="rail-title">{entry.title}</span>
                {#if entry.authenticity && entry.authenticity !== 'genuine'}
                  <span class="rail-badge {entry.authenticity}">{entry.authenticity}</span>
                {/if}
                <span class="rail-badge planned-badge">planned</span>
              </span>
            {/if}

            {#if isOpen}
              {@const meta = metaOf(entry)}
              {#if meta && bookList(entry).length > 0}
                <ul class="rail-books">
                  {#each bookList(entry) as b}
                    <li>
                      <button
                        class="rail-book"
                        class:current={b === currentBook}
                        on:click={() => onOpenWork(id, b)}
                      >Book {bookLabel(meta, b)}</button>
                      {#if b === currentBook && (chapters[String(b)]?.length ?? 0) > 1}
                        <ul class="rail-chapters">
                          {#each chapters[String(b)] as ch}
                            <li>
                              <button
                                class="rail-chapter"
                                class:active={activeChapter === ch.chapter}
                                on:click={() => onOpenChapter(b, ch.chapter)}
                              >
                                <span>Ch. {ch.chapter}</span>
                                <span class="rail-bek">{ch.bekker}</span>
                              </button>
                            </li>
                          {/each}
                        </ul>
                      {/if}
                    </li>
                  {/each}
                </ul>
              {:else if (chapters['1']?.length ?? 0) > 1}
                <!-- bookless work: chapters hang directly off the work -->
                <ul class="rail-chapters top">
                  {#each chapters['1'] as ch}
                    <li>
                      <button
                        class="rail-chapter"
                        class:active={activeChapter === ch.chapter}
                        on:click={() => onOpenChapter(1, ch.chapter)}
                      >
                        <span>Ch. {ch.chapter}</span>
                        <span class="rail-bek">{ch.bekker}</span>
                      </button>
                    </li>
                  {/each}
                </ul>
              {/if}
            {/if}
          </li>
        {/each}
      </ul>
      {/if}
    </div>
  {/each}
</nav>

<style>
  .rail {
    font-family: var(--font-ui);
    font-size: 0.86rem;
    padding: 0.75rem 0.6rem 2rem;
  }
  .rail-filter { position: sticky; top: 0; padding: 0.25rem 0 0.6rem; background: inherit; z-index: 2; }
  .rail-filter input {
    width: 100%; box-sizing: border-box;
    font: inherit; color: var(--text);
    background: var(--col-bg);
    border: 1px solid var(--border); border-radius: 6px;
    padding: 0.4rem 0.6rem;
  }
  .rail-filter input:focus { outline: none; border-color: var(--accent); }

  .rail-group { margin-bottom: 0.9rem; }
  .rail-group-label {
    display: flex; align-items: center; gap: 0.45em; width: 100%;
    min-height: 2.25rem; box-sizing: border-box;
    font-family: inherit; font-size: 0.68rem; font-weight: 700; letter-spacing: 0.08em;
    text-transform: uppercase; color: var(--text-light); text-align: left;
    background: none; border: none; border-radius: 6px; cursor: pointer;
    padding: 0.3rem 0.5rem;
  }
  .rail-group-label:hover { color: var(--text-mid); background: var(--border); }
  .rail-group-caret {
    display: inline-flex; align-items: center; justify-content: center;
    flex: none; font-size: 1rem; line-height: 1; transition: transform 0.12s ease;
  }
  .rail-group-caret.closed { transform: rotate(-90deg); }
  ul { list-style: none; margin: 0; padding: 0; }

  .rail-work {
    display: flex; align-items: baseline; gap: 0.4em; width: 100%;
    text-align: left; font: inherit; color: var(--text);
    background: none; border: none; border-radius: 6px;
    padding: 0.32rem 0.5rem; cursor: pointer;
  }
  .rail-work:hover { background: var(--border); }
  .rail-work.current { color: var(--accent); font-weight: 600; }
  .rail-work.planned { color: var(--text-light); cursor: default; }
  .rail-title { flex: 0 1 auto; min-width: 0; }

  .rail-badge {
    flex: none; font-size: 0.62rem; font-weight: 600; letter-spacing: 0.04em;
    padding: 0.05em 0.45em; border-radius: 999px;
    border: 1px solid var(--border); color: var(--text-mid);
  }
  .rail-badge.spurious { color: var(--error); border-color: var(--error); opacity: 0.75; }
  .rail-badge.author { font-style: italic; }

  .rail-books { margin: 0.1rem 0 0.3rem 0.9rem; border-left: 1px solid var(--border); }
  .rail-book {
    display: block; width: 100%; text-align: left; font: inherit;
    color: var(--text-mid); background: none; border: none; border-radius: 6px;
    padding: 0.22rem 0.5rem; cursor: pointer;
  }
  .rail-book:hover { background: var(--border); color: var(--text); }
  .rail-book.current { color: var(--accent); font-weight: 600; }

  .rail-chapters { margin: 0.05rem 0 0.35rem 0.9rem; border-left: 1px solid var(--border); }
  .rail-chapters.top { margin-left: 0.9rem; }
  .rail-chapter {
    display: flex; justify-content: space-between; gap: 0.6em; width: 100%;
    text-align: left; font: inherit; font-size: 0.8rem;
    color: var(--text-mid); background: none; border: none; border-radius: 6px;
    padding: 0.18rem 0.5rem; cursor: pointer;
  }
  .rail-chapter:hover { background: var(--border); color: var(--text); }
  .rail-chapter.active { color: var(--accent); font-weight: 600; background: var(--border); }
  .rail-chapter.active .rail-bek { color: var(--accent); }
  .rail-bek { font-variant-numeric: tabular-nums; color: var(--text-light); }
</style>
