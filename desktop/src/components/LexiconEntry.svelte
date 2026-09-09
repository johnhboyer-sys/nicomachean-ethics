<script lang="ts">
  // A single lemma's reference view — desktop port of LemmaPage.astro.
  // Same precomputed shard (lemmata/<slug>.json from app/scripts/
  // build-lemmata.mjs): LSJ definition + frequency by work + concordance, with
  // the Bonitz section stubbed exactly as on the site (digitisation pending —
  // the stub is honest, not filler). Citation chips jump into the reader via
  // the same ?hlg=&loc= contract the site's search uses.
  import { fetchLsjShard, lsjShard, lineRef } from '@shared/lib/data';
  import { renderLsjEntry } from '@shared/lib/html';
  import { getWork, bookLabel, isBookless } from '@shared/lib/works';

  export let slug: string;
  export let onJumpTo: (work: string, book: number, column: string, line: number, surface: string, sub?: string) => void;
  export let onBack: () => void;

  // The trailing sub is a lettered Bekker line's letter, written by
  // app/scripts/build-lemmata.mjs and present only on a lettered line. Reading
  // this tuple as three elements dropped it, so a chip for GA 775a11a printed
  // "775a11" and jumped to a line the reader does not emit.
  type Instance = [col: string, line: number, surface: string, sub?: string];
  interface ChapterInstances { chapter: string; bekker: string; instances: Instance[]; }
  interface BookInstances { book: number; chapters: ChapterInstances[]; }
  interface WorkInstances { work: string; title: string; count: number; shown: number; books: BookInstances[]; }
  interface LemmaData {
    slug: string; key: string; head: string; lemmaBeta: string;
    count: number; glosses: string[];
    byWork: { work: string; title: string; count: number }[];
    instancesByWork: WorkInstances[];
    truncated: boolean;
  }

  const dataRoot = () =>
    (globalThis as { __ARISTOTLE_DATA_ROOT__?: string }).__ARISTOTLE_DATA_ROOT__ ?? '/data';

  let data: LemmaData | null = null;
  let lsjHtml = '';
  let loading = true;
  let error = '';

  let loadedFor = '';
  $: if (slug && slug !== loadedFor) { loadedFor = slug; load(slug); }

  async function load(s: string) {
    loading = true; error = ''; data = null; lsjHtml = '';
    try {
      const r = await fetch(`${dataRoot()}/lemmata/${s}.json`);
      if (!r.ok) throw new Error(`lemma ${s}: ${r.status}`);
      const d: LemmaData = await r.json();
      if (loadedFor !== s) return; // superseded by a newer selection
      data = d;
      const shard = await fetchLsjShard(lsjShard(d.key));
      // Same renderer the site uses: sanitized, sense hierarchy intact, with a
      // jump list over the top-level senses. No base — the desktop serves the
      // reader at the root. (Until 2026-08-19 this injected shard HTML raw,
      // which both skipped the sanitizer and lost every sense boundary.)
      if (loadedFor === s) {
        lsjHtml = renderLsjEntry(shard[d.key]?.html ?? '', {
          scale: 'page', outline: true,
        });
      }
    } catch (e) {
      if (loadedFor === s) error = String(e);
    } finally {
      if (loadedFor === s) loading = false;
    }
  }

  // The sense outline links by fragment (`#lsj-sense-a`), which is right on the
  // site — a lemma page is its own document. Here the lexicon is an OVERLAY
  // over the reader, sharing one location.hash, and App.svelte reads that hash
  // as the live citation (the rail's scroll-spy and Copy Citation). So scroll
  // to the sense ourselves and leave the hash alone. Delegated, because the
  // entry is injected HTML; a keyboard Enter on the link fires this same click.
  function onEntryClick(e: MouseEvent) {
    const link = (e.target as HTMLElement | null)?.closest?.('.lsj-outline-list a');
    if (!(link instanceof HTMLAnchorElement)) return;
    const target = document.getElementById(link.getAttribute('href')?.slice(1) ?? '');
    if (!target) return;
    e.preventDefault();
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  $: maxWork = data?.byWork[0]?.count ?? 1;
  $: worksView = (data?.instancesByWork ?? []).map((w) => {
    const ww = getWork(w.work);
    const bookless = ww ? isBookless(ww) : false;
    return {
      ...w,
      bookless,
      flat: w.shown <= 30,
      capped: w.shown < w.count,
      barPct: Math.max(2, (w.count / maxWork) * 100),
      books: w.books.map((bk) => ({
        book: bk.book,
        label: ww ? bookLabel(ww, bk.book) : String(bk.book),
        bookCount: bk.chapters.reduce((n, c) => n + c.instances.length, 0),
        chapters: bk.chapters,
      })),
    };
  });
</script>

<div class="lx">
  <button class="lx-back" on:click={onBack}>‹ All lexicon entries</button>

  {#if loading}
    <p class="lx-note">Loading…</p>
  {:else if error || !data}
    <p class="lx-note">Could not load this entry. {error}</p>
  {:else}
    <h1 class="lx-head-gk">{data.head}</h1>
    <p class="lx-translit">{data.slug}</p>
    {#if data.glosses.length}
      <p class="lx-gloss">{data.glosses.join('; ')}</p>
    {/if}
    <p class="lx-freq">Appears <b>{data.count.toLocaleString()}</b> times across Aristotle's works.</p>

    <h2 class="lx-h">Frequency by work</h2>
    <p class="lx-note">Click a work to list every occurrence by Bekker number — each opens the passage in the reader.</p>
    <ul class="lx-freqbars">
      {#each worksView as w (w.work)}
        <li>
          <details class="fb-item">
            <summary>
              <span class="fb-name">{w.title}</span>
              <span class="fb-track"><span class="fb-fill" style={`width:${w.barPct}%`}></span></span>
              <span class="fb-n">{w.count.toLocaleString()}</span>
              <span class="fb-caret" aria-hidden="true">▸</span>
            </summary>
            <div class="fb-cites">
              {#each w.books as bk (bk.book)}
                {#if w.bookless}
                  <div class="fb-book-group">
                    {#each bk.chapters as ch}
                      <div class="fb-chapter">
                        <div class="fb-ch-head">
                          <span class="fb-ch-label">Chapter {ch.chapter}</span>
                          {#if ch.bekker}<span class="fb-ch-bekker">{ch.bekker}</span>{/if}
                        </div>
                        <ul class="fb-citelist">
                          {#each ch.instances as inst}
                            <li><button on:click={() => onJumpTo(w.work, bk.book, inst[0], inst[1], inst[2], inst[3])}>{inst[0]}{lineRef(inst[1], inst[3])}</button></li>
                          {/each}
                        </ul>
                      </div>
                    {/each}
                  </div>
                {:else}
                  <details class="fb-book-d" open={w.flat}>
                    <summary>
                      <span class="fb-book">Book {bk.label}</span>
                      <span class="fb-book-n">{bk.bookCount}</span>
                      <span class="fb-caret fb-book-caret" aria-hidden="true">▸</span>
                    </summary>
                    <div class="fb-book-body">
                      {#each bk.chapters as ch}
                        <div class="fb-chapter">
                          <div class="fb-ch-head">
                            <span class="fb-ch-label">Chapter {ch.chapter}</span>
                            {#if ch.bekker}<span class="fb-ch-bekker">{ch.bekker}</span>{/if}
                          </div>
                          <ul class="fb-citelist">
                            {#each ch.instances as inst}
                              <li><button on:click={() => onJumpTo(w.work, bk.book, inst[0], inst[1], inst[2], inst[3])}>{inst[0]}{lineRef(inst[1], inst[3])}</button></li>
                            {/each}
                          </ul>
                        </div>
                      {/each}
                    </div>
                  </details>
                {/if}
              {/each}
              {#if w.capped}
                <p class="lx-note">Showing {w.shown.toLocaleString()} of {w.count.toLocaleString()} (list capped).</p>
              {/if}
            </div>
          </details>
        </li>
      {/each}
    </ul>

    {#if lsjHtml}
      <h2 class="lx-h">Dictionary (LSJ)</h2>
      <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
      <!-- The handler only ever acts on real <a> elements inside, which carry
           their own keyboard semantics; Enter on one fires this click. -->
      <div on:click={onEntryClick}>
        <!-- eslint-disable-next-line svelte/no-at-html-tags — sanitized by renderLsjEntry, same as the site -->
        {@html lsjHtml}
      </div>
    {/if}

    <h2 class="lx-h">Key passages &amp; sense analysis (Bonitz)</h2>
    <div class="lx-bonitz">
      <b>Index Aristotelicus.</b> Hermann Bonitz's sense-by-sense analysis of
      <span class="gk"> {data.head}</span> — with the passages he singles out as decisive
      for each meaning — will appear here.
      <span class="lx-note">Digitisation in progress; this entry is not yet available.</span>
    </div>
  {/if}
</div>

<style>
  .lx { max-width: 820px; margin: 0 auto; padding: 1.5rem 1rem 5rem; font-family: var(--font-english); color: var(--text); }
  .lx-back {
    display: inline-block; margin: 0 0 1.4rem; font-family: var(--font-ui); font-size: 0.9rem;
    color: var(--accent); background: none; border: none; padding: 0; cursor: pointer;
  }
  .lx-back:hover { text-decoration: underline; }
  .lx-head-gk { font-family: var(--font-greek); font-size: 2.6rem; font-weight: 600; line-height: 1.1; margin: 0; }
  .lx-translit { font-family: var(--font-ui); font-size: 0.85rem; letter-spacing: .06em; text-transform: uppercase; color: var(--text-mid); margin: 0.3rem 0 0; }
  .lx-gloss { font-size: 1.15rem; margin: 0.7rem 0 0; }
  .lx-freq { font-family: var(--font-ui); font-size: 0.95rem; color: var(--text-mid); margin: 1rem 0 0; }
  .lx-freq b { color: var(--accent); font-size: 1.1rem; }
  h2.lx-h { font-family: var(--font-ui); font-size: 0.95rem; font-weight: 700; letter-spacing: .03em; color: var(--accent); margin: 2.4rem 0 0.8rem; padding-bottom: 0.3rem; border-bottom: 1px solid var(--border); }
  .lx-note { font-size: 0.82rem; color: var(--text-mid); margin: 0.4rem 0 0; }
  .gk { font-family: var(--font-greek); }

  .lx-freqbars { list-style: none; padding: 0; margin: 0; }
  .fb-item > summary {
    display: grid; grid-template-columns: minmax(6rem, 12rem) 1fr 3.2rem 1rem;
    align-items: center; gap: 0.7rem; cursor: pointer; list-style: none;
    padding: 0.28rem 0.4rem; border-radius: 5px;
  }
  .fb-item > summary::-webkit-details-marker { display: none; }
  .fb-item > summary:hover { background: rgba(128, 128, 128, .08); }
  .fb-name { font-size: 0.9rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .fb-item > summary:hover .fb-name { color: var(--accent); }
  .fb-track { height: 0.7rem; background: var(--border); border-radius: 4px; overflow: hidden; }
  .fb-fill { display: block; height: 100%; background: var(--accent); border-radius: 4px; }
  .fb-n { font-family: var(--font-ui); font-variant-numeric: tabular-nums; font-size: 0.82rem; color: var(--text-mid); text-align: right; }
  .fb-caret { font-size: 0.7rem; color: var(--text-mid); transition: transform .12s ease; justify-self: center; }
  .fb-item[open] > summary .fb-caret { transform: rotate(90deg); }
  .fb-cites { padding: 0.5rem 0.4rem 1rem 0.4rem; }
  .fb-citelist { list-style: none; padding: 0; margin: 0; display: flex; flex-wrap: wrap; gap: 0.35rem; }
  .fb-citelist button {
    display: inline-block; font-family: var(--font-ui); font-variant-numeric: tabular-nums;
    font-size: 0.78rem; color: var(--text); cursor: pointer; background: none;
    border: 1px solid var(--border); border-radius: 4px; padding: 0.15rem 0.45rem;
  }
  .fb-citelist button:hover { border-color: var(--accent); color: var(--accent); }
  .fb-book-group { margin: 0 0 0.9rem; }
  .fb-book-d { border-top: 1px solid var(--border); }
  .fb-book-d > summary {
    display: flex; align-items: center; gap: 0.5rem; cursor: pointer; list-style: none;
    padding: 0.4rem 0.2rem;
  }
  .fb-book-d > summary::-webkit-details-marker { display: none; }
  .fb-book-d > summary:hover .fb-book { color: var(--accent); }
  .fb-book { font-family: var(--font-ui); font-size: 0.88rem; font-weight: 700; }
  .fb-book-n { font-family: var(--font-ui); font-variant-numeric: tabular-nums; font-size: 0.78rem; color: var(--text-mid); margin-left: auto; }
  .fb-book-caret { font-size: 0.65rem; }
  .fb-book-d[open] > summary .fb-book-caret { transform: rotate(90deg); }
  .fb-book-body { padding: 0.2rem 0 0.6rem 0.5rem; }
  .fb-chapter { margin: 0 0 0.7rem 0.2rem; }
  .fb-ch-head { display: flex; align-items: baseline; gap: 0.5rem; margin: 0 0 0.35rem; }
  .fb-ch-label { font-family: var(--font-ui); font-size: 0.82rem; font-weight: 600; color: var(--text-mid); }
  .fb-ch-bekker { font-family: var(--font-ui); font-size: 0.72rem; color: var(--text-mid); font-variant-numeric: tabular-nums; opacity: .8; }
  /* No LSJ rules here: shared/styles/global.css styles the entry, its sense
     hierarchy and its outline for every host. */
  .lx-bonitz { border: 1px dashed var(--border); border-radius: 8px; padding: 1rem 1.1rem; color: var(--text-mid); font-size: 0.9rem; line-height: 1.6; }
  .lx-bonitz b { color: var(--text); }
</style>
