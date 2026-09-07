<script lang="ts">
  import { onMount } from 'svelte';
  import {
    decodeOffsets,
    fetchEnglishSegments,
    fetchNgramOccurrences,
    fetchNgramShard,
    fetchSearchOffsets,
    type NgramRow,
    type NgramStream,
  } from '../lib/data';
  import { betaToGreek } from '../lib/betacode';
  import {
    VARIANT_READING_CAP,
    greekFold,
    lemmaOptions,
    lemmaReadings,
    offsetRef,
    pool,
    type Offsets,
  } from '../lib/search';
  import { WORKS, getWork, workPath } from '../lib/works';

  type SortMode = 'score' | 'frequency' | 'length' | 'alphabetical';

  interface PhraseItem {
    key: string;
    row: NgramRow;
  }

  // What the typed prefix resolves to: the shards to read and, in each, the key
  // prefixes that count as a match. One letter and one prefix for the surface
  // and English streams; for dictionary forms, one prefix per reading of the
  // typed words, and those readings do not all live in the same shard.
  interface Plan {
    key: string;                 // stream + typed prefix, the signature it answers
    stream: NgramStream;
    // An empty prefix list on a letter means every phrase in that shard.
    byLetter: Array<{ letter: string; prefixes: string[] }>;
    readings: string[][];        // dictionary forms only; [] when nothing was widened
    cappedFrom: number;          // 0 unless the fan-out was truncated
  }

  interface Citation {
    column: string;
    // null for English: the translation is aligned per segment, so the
    // citation is the column and there is no line to name.
    line: number | null;
    book: number;
    href: string;
  }

  interface WorkCitations {
    id: string;
    title: string;
    total: number;
    citations: Citation[];
    error?: string;
  }

  interface PhraseDetails {
    loading: boolean;
    error: string;
    works: WorkCitations[];
  }

  const DEFAULT_LETTER = 'k';
  // The three the guide works through, so the page and the explainer teach the
  // same phrases rather than each inventing its own.
  const EXAMPLES = [
    { beta: 'to ti hn einai', greek: '\u03c4\u1f78 \u03c4\u03af \u1f26\u03bd \u03b5\u1f36\u03bd\u03b1\u03b9', gloss: 'the essence — 103 times' },
    { beta: 'ws epi to polu', greek: '\u1f61\u03c2 \u1f10\u03c0\u1f76 \u03c4\u1f78 \u03c0\u03bf\u03bb\u03cd', gloss: 'for the most part — 204 times' },
    { beta: 'kata sumbebhkos', greek: '\u03ba\u03b1\u03c4\u1f70 \u03c3\u03c5\u03bc\u03b2\u03b5\u03b2\u03b7\u03ba\u03cc\u03c2', gloss: 'accidentally — 330 times' },
  ];
  // Chosen the same way: real rows, and each standing in many works so it is
  // Aristotle recurring rather than one translator's habit.
  const ENGLISH_EXAMPLES = [
    { beta: 'as a general rule', greek: 'as a general rule', gloss: '80 times, 9 works' },
    { beta: 'equal to two right angles', greek: 'equal to two right angles', gloss: '40 times, 12 works' },
    { beta: 'it makes no difference whether', greek: 'it makes no difference whether', gloss: '38 times, 16 works' },
  ];
  const BROWSE_LETTERS = 'abcdefghiklmnoprstuwxyz'.split('');

  // Distinctiveness ranks the English badly. English builds its grammar out of
  // small words in fixed order — "in the case of" is nearly the only order those
  // four ever take — so the measure reads them as inseparable and they take the
  // whole top of the list: it is (8,508), of the (12,183), the same (4,490).
  // Greek does that work with endings instead, so its small words move freely
  // and do not clump as hard.
  //
  // This filters the DEFAULT VIEW; it changes no score and hides nothing the
  // reader cannot unhide. Strictly grammatical words only: nothing that could
  // carry weight in Aristotle — no end, mean, part, whole, cause, form.
  //
  // Known cost, John's call 2026-07-27: phrases made only of these words go too,
  // including some that do philosophical work — that which is (τὸ ὄν, 988),
  // what it is (τί ἐστι, 93), that it is (721). Judged too common here to be
  // worth finding this way; an allowlist is the later fix.
  const FUNCTION_WORDS = new Set(`a an the this that these those which who whom whose what
    and or but nor if then than as so because although though while whereas
    of in on at to for from by with without within into upon about against
    among between through during over under above below across along
    is are was were be been being am do does did done have has had having
    will would shall should may might can could must let
    it its he she they them their his her our your my we you i one
    not no nor never ever also too very much more most less least
    there here now when where how why some any all both each every other another same`
    .split(/\s+/));

  function contentWords(phrase: string): number {
    let n = 0;
    for (const w of phrase.split(' ')) if (!FUNCTION_WORDS.has(w)) n++;
    return n;
  }

  // The shard a phrase lives in, by its first letter — the same rule stage 8
  // sharded it with. Taken from the phrase itself, never from the typed box: a
  // widened query reads several shards at once, and a row's citations must be
  // fetched from the shard that actually holds it.
  function shardLetter(phrase: string): string {
    const first = phrase[0] ?? '';
    return first >= 'a' && first <= 'z' ? first : '_';
  }
  const PAGE_SIZE = 50;
  const CITATION_CAP = 40;
  const BASE_URL = import.meta.env.BASE_URL.replace(/\/$/, '');
  const WORK_ORDER = new Map(WORKS.map((work, index) => [work.id, index]));
  const countFormat = new Intl.NumberFormat('en-US');
  const scoreFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });

  let mounted = false;
  let stream: NgramStream = 'form';
  let prefix = '';
  let lengths: number[] = [2, 3, 4, 5];
  let minCount = 2;
  let selectedWorks: string[] = [];
  let sort: SortMode = 'score';
  let hideCommon = true;
  let page = 0;

  let plan: Plan = { key: '', stream: 'form', byLetter: [], readings: [], cappedFrom: 0 };
  let planLoading = false;
  let requestedPlanKey = '';
  let planRequest = 0;

  // One entry per shard the plan asks for, in its order.
  let loadedShards: Array<Record<string, NgramRow>> = [];
  let loadedShardSignature = '';
  let shardLoading = false;
  let shardError = '';
  let requestedShardSignature = '';
  let shardRequest = 0;

  let requestedWorkSignature = '';
  let loadedWorkSignature = '';
  let matchingWorkPhrases: Set<string> | null = null;
  let workFilterLoading = false;
  let workFilterError = '';
  let workRequest = 0;

  let expanded = new Set<string>();
  let details: Record<string, PhraseDetails> = {};

  const offsetsCache = new Map<string, Promise<Offsets>>();

  // The index is keyed on accent-folded Beta Code, but nobody should have to
  // know that: fold whatever is typed, Greek or Latin. greekFold drops every
  // character it does not recognise — including the spaces between a phrase's
  // words — so it has to run per word and the words be rejoined.
  $: isEnglish = stream === 'english';
  $: isLemma = stream === 'lemma';
  $: normalizedPrefix = isEnglish
    ? prefix.trim().toLowerCase().replace(/[^a-z' ]+/g, '').replace(/\s+/g, ' ')
    : prefix
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .map(greekFold)
      .filter(Boolean)
      .join(' ');
  $: letter = normalizedPrefix ? shardLetter(normalizedPrefix) : DEFAULT_LETTER;
  $: minimum = Number.isFinite(minCount) ? Math.max(2, Math.floor(minCount)) : 2;
  $: selectedLengthKey = [...lengths].sort((a, b) => a - b).join(',');
  $: selectedWorkKey = [...selectedWorks].sort().join(',');

  $: planKey = `${stream}|${normalizedPrefix}`;
  $: if (mounted && planKey !== requestedPlanKey) {
    void makePlan(planKey, stream, normalizedPrefix, letter);
  }

  // Nothing downstream may act on a plan that answers an older query.
  $: activePlan = plan.key === planKey ? plan : null;
  $: shardSignature = activePlan
    ? `${activePlan.stream}/${activePlan.byLetter.map((b) => b.letter).join(',')}`
    : '';

  $: if (mounted && shardSignature && shardSignature !== requestedShardSignature) {
    void loadShards(shardSignature, activePlan!);
  }

  $: scan = loadedShardSignature === shardSignature && activePlan
    ? scanShards(activePlan, loadedShards, lengths, minimum, isEnglish && hideCommon)
    : { rows: [] as PhraseItem[], matched: [] as string[] };
  $: localRows = scan.rows;

  // The work filter reads occurrence files, one per shard letter per length.
  // Only the letters that actually produced rows are worth fetching: widening
  // ἦν asks for three shards and two of them are routinely dead ends.
  $: matchedLetters = [...new Set(localRows.map((item) => shardLetter(item.key)))].sort();
  $: workSignature = selectedWorks.length && matchedLetters.length
    ? `${stream}/${matchedLetters.join(',')}|${selectedLengthKey}|${selectedWorkKey}`
    : '';

  $: if (mounted && workSignature !== requestedWorkSignature) {
    void loadWorkFilter(
      workSignature,
      stream,
      [...matchedLetters],
      [...lengths],
      [...selectedWorks],
    );
  }

  $: filteredRows = selectedWorks.length === 0
    ? localRows
    : loadedWorkSignature === workSignature && matchingWorkPhrases
      ? localRows.filter((item) => matchingWorkPhrases?.has(item.key))
      : [];

  $: shardBadge = (activePlan?.byLetter ?? [{ letter }])
    .map((b) => b.letter.toUpperCase())
    .join(', ');
  $: widened = activePlan?.readings.length ? activePlan : null;

  // The readings for the line under the box: the ones that produced rows, not
  // the ones that were tried — ἦν licenses five headwords and most are dead
  // ends. Listed rather than counted, because a reader has to be able to see
  // that ἦν was read as εἰμί; long lists are cut off rather than allowed to
  // bury the page.
  const READINGS_SHOWN = 6;
  $: matchedReadings = widened
    ? scan.matched.slice(0, READINGS_SHOWN).map((p) => betaToGreek(p))
    : [];
  $: matchedRest = widened ? Math.max(0, scan.matched.length - READINGS_SHOWN) : 0;
  $: triedReadings = widened
    ? widened.readings.slice(0, READINGS_SHOWN).map((r) => betaToGreek(r.join(' ')))
    : [];
  $: triedRest = widened ? Math.max(0, widened.readings.length - READINGS_SHOWN) : 0;

  $: sortedRows = [...filteredRows].sort((a, b) => comparePhrases(a, b, sort));
  $: pageCount = Math.max(1, Math.ceil(sortedRows.length / PAGE_SIZE));
  $: if (page >= pageCount) page = pageCount - 1;
  $: pageRows = sortedRows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  $: shownFrom = sortedRows.length ? page * PAGE_SIZE + 1 : 0;
  $: shownTo = Math.min((page + 1) * PAGE_SIZE, sortedRows.length);

  onMount(() => {
    mounted = true;
  });

  function comparePhrases(a: PhraseItem, b: PhraseItem, mode: SortMode): number {
    if (mode === 'frequency') {
      return b.row[1] - a.row[1] || b.row[2] - a.row[2] || a.key.localeCompare(b.key);
    }
    if (mode === 'length') {
      return a.row[0] - b.row[0] || b.row[2] - a.row[2] || a.key.localeCompare(b.key);
    }
    if (mode === 'alphabetical') return a.key.localeCompare(b.key);
    return b.row[2] - a.row[2] || b.row[1] - a.row[1] || a.key.localeCompare(b.key);
  }

  // A single word is left alone. The letter buttons below type into the same
  // box, and widening one letter would quietly move the browse elsewhere: h is
  // the surface of ἡ, whose headword is ὁ, so browsing H would show the O shard.
  function widenable(prefixText: string): boolean {
    return prefixText.length > 1;
  }

  /** Which shards to read for the typed prefix, and what counts as a match.
   *
   * The dictionary-form index is keyed on headwords, so the phrase a reader has
   * in front of them matches nothing typed literally: τὸ τί ἦν εἶναι is stored
   * as ὁ τίς εἰμί εἰμί, and knowing that is exactly the knowledge the index is
   * supposed to save them. So resolve each typed word to the headwords it can
   * belong to and match every reading of the phrase.
   *
   * A word the map does not record falls back to itself — that is the fragment
   * still being typed, and it is what keeps the list narrowing as a reader types.
   * A word the map DOES record is left to its headwords alone: a dictionary form
   * is always among its own headwords (ὁ maps to ὁ and ὅ), so adding it back
   * changes no result and can cost a whole extra shard — τό is not a headword of
   * anything, and reading it literally fetched 3.3 MB with nothing in it.
   */
  async function makePlan(
    key: string,
    nextStream: NgramStream,
    prefixText: string,
    fallbackLetter: string,
  ) {
    const request = ++planRequest;
    requestedPlanKey = key;
    const literal: Plan = {
      key,
      stream: nextStream,
      byLetter: [{
        letter: prefixText ? shardLetter(prefixText) : fallbackLetter,
        prefixes: prefixText ? [prefixText] : [],
      }],
      readings: [],
      cappedFrom: 0,
    };

    if (nextStream !== 'lemma' || !widenable(prefixText)) {
      plan = literal;
      planLoading = false;
      return;
    }

    planLoading = true;
    try {
      const terms = prefixText.split(' ');
      const options = await lemmaOptions(terms);
      if (request !== planRequest) return;
      // No map, or no headword recorded for any word: match what was typed,
      // which is what this page did before widening existed.
      if (!options || options.every((o) => !o.length)) {
        plan = literal;
        return;
      }
      const perTerm = terms.map((term, i) => (options[i].length ? options[i] : [term]));
      const { readings, total } = lemmaReadings(perTerm, VARIANT_READING_CAP);
      const byLetter = new Map<string, string[]>();
      for (const reading of readings) {
        const l = shardLetter(reading[0]);
        const prefixes = byLetter.get(l) ?? [];
        prefixes.push(reading.join(' '));
        byLetter.set(l, prefixes);
      }
      plan = {
        key,
        stream: nextStream,
        byLetter: [...byLetter].map(([l, prefixes]) => ({ letter: l, prefixes })),
        readings,
        cappedFrom: total > readings.length ? total : 0,
      };
    } catch {
      if (request !== planRequest) return;
      plan = literal;
    } finally {
      if (request === planRequest) planLoading = false;
    }
  }

  async function loadShards(signature: string, forPlan: Plan) {
    const request = ++shardRequest;
    requestedShardSignature = signature;
    shardLoading = true;
    shardError = '';
    page = 0;
    expanded = new Set();
    try {
      const next = await Promise.all(
        forPlan.byLetter.map((b) => fetchNgramShard(forPlan.stream, b.letter)),
      );
      if (request !== shardRequest) return;
      loadedShards = next;
      loadedShardSignature = signature;
    } catch {
      if (request !== shardRequest) return;
      loadedShards = [];
      loadedShardSignature = '';
      const letters = forPlan.byLetter.map((b) => b.letter.toUpperCase()).join(', ');
      shardError = forPlan.byLetter.length > 1
        ? `The ${letters} phrase shards could not be loaded.`
        : `The ${letters} phrase shard could not be loaded.`;
    } finally {
      if (request === shardRequest) shardLoading = false;
    }
  }

  /** The rows that pass every filter, and the readings that produced them.
   *
   * One pass, because a shard holds up to 93,000 phrases and the prefix test is
   * per reading. Each shard is only tested against the readings that begin with
   * its own letter, which is what keeps the fan-out from multiplying the work.
   */
  function scanShards(
    forPlan: Plan,
    shards: Array<Record<string, NgramRow>>,
    keepLengths: number[],
    minimumCount: number,
    dropCommon: boolean,
  ): { rows: PhraseItem[]; matched: string[] } {
    const rows: PhraseItem[] = [];
    const seenMatch = new Set<string>();
    forPlan.byLetter.forEach(({ prefixes }, i) => {
      const shard = shards[i];
      if (!shard) return;
      for (const [key, row] of Object.entries(shard)) {
        let hit = '';
        if (prefixes.length) {
          for (const p of prefixes) if (key.startsWith(p)) { hit = p; break; }
          if (!hit) continue;
        }
        if (!keepLengths.includes(row[0])) continue;
        if (row[1] < minimumCount) continue;
        if (dropCommon && contentWords(key) < 2) continue;
        rows.push({ key, row });
        if (hit) seenMatch.add(hit);
      }
    });
    // In the order the readings were generated, not the order the shards happen
    // to be iterated, so the note under the box does not reshuffle itself.
    const matched = forPlan.readings
      .map((r) => r.join(' '))
      .filter((p) => seenMatch.has(p));
    return { rows, matched };
  }

  async function loadWorkFilter(
    signature: string,
    nextStream: NgramStream,
    nextLetters: string[],
    nextLengths: number[],
    works: string[],
  ) {
    const request = ++workRequest;
    requestedWorkSignature = signature;
    loadedWorkSignature = '';
    matchingWorkPhrases = null;
    workFilterError = '';

    if (!signature) {
      workFilterLoading = false;
      return;
    }

    workFilterLoading = true;
    try {
      const occurrences = await Promise.all(
        nextLetters.flatMap((l) =>
          [...nextLengths]
            .sort((a, b) => a - b)
            .map((n) => fetchNgramOccurrences(nextStream, l, n)),
        ),
      );
      if (request !== workRequest) return;
      const matches = new Set<string>();
      for (const occurrenceShard of occurrences) {
        for (const [phrase, byWork] of Object.entries(occurrenceShard)) {
          if (works.some((work) => work in byWork)) matches.add(phrase);
        }
      }
      matchingWorkPhrases = matches;
      loadedWorkSignature = signature;
      page = 0;
    } catch {
      if (request !== workRequest) return;
      workFilterError = 'The extra occurrence data needed for this work filter could not be loaded.';
    } finally {
      if (request === workRequest) workFilterLoading = false;
    }
  }

  function retryShard() {
    requestedShardSignature = '';
  }

  function retryWorkFilter() {
    requestedWorkSignature = '';
  }

  function clampMinimum() {
    minCount = minimum;
    page = 0;
  }

  function clearWorks() {
    selectedWorks = [];
    page = 0;
  }

  function phraseId(item: PhraseItem): string {
    return `${stream}-${shardLetter(item.key)}-${item.row[0]}-${item.key.replace(/[^a-z0-9_-]+/g, '-')}`;
  }

  function togglePhrase(item: PhraseItem) {
    const id = phraseId(item);
    const next = new Set(expanded);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
      if (!details[id]) void loadPhraseDetails(id, item);
    }
    expanded = next;
  }

  function fetchWorkOffsets(work: string): Promise<Offsets> {
    const cached = offsetsCache.get(work);
    if (cached) return cached;
    const promise = fetchSearchOffsets(work) as Promise<Offsets>;
    promise.catch(() => {
      if (offsetsCache.get(work) === promise) offsetsCache.delete(work);
    });
    offsetsCache.set(work, promise);
    return promise;
  }

  async function loadPhraseDetails(id: string, item: PhraseItem) {
    details = { ...details, [id]: { loading: true, error: '', works: [] } };
    try {
      const occurrenceShard = await fetchNgramOccurrences(
        stream,
        shardLetter(item.key),
        item.row[0],
      );
      const byWork = occurrenceShard[item.key];
      if (!byWork) throw new Error('Phrase missing from its occurrence shard');

      const entries = Object.entries(byWork).sort(
        ([a], [b]) => (WORK_ORDER.get(a) ?? Number.MAX_SAFE_INTEGER) -
          (WORK_ORDER.get(b) ?? Number.MAX_SAFE_INTEGER),
      );
      const groups: WorkCitations[] = entries.map(([work, deltas]) => ({
        id: work,
        title: getWork(work)?.title ?? work,
        total: deltas.length,
        citations: [],
      }));

      const englishSegments = isEnglish ? await fetchEnglishSegments() : null;

      await pool(entries, 6, async ([work, deltas], index) => {
        try {
          // The English is aligned one block per segment, so an English offset
          // resolves to a column and no further. A Greek offset resolves to the
          // line, because the Greek is indexed per token.
          let citations: Citation[];
          if (englishSegments) {
            const segs = englishSegments[work] ?? [];
            citations = decodeOffsets(deltas)
              .map((global) => {
                let found: (typeof segs)[number] | null = null;
                for (const seg of segs) {
                  if (seg.base > global) break;
                  found = seg;
                }
                return found;
              })
              .filter((seg): seg is (typeof segs)[number] => seg !== null)
              .slice(0, CITATION_CAP)
              .map((seg) => ({
                column: seg.column,
                line: null,
                book: seg.book,
                href: `${BASE_URL}${workPath(work, seg.book)}?loc=${seg.column}`,
              }));
          } else {
            const offsets = await fetchWorkOffsets(work);
            citations = decodeOffsets(deltas)
              .map((global) => offsetRef(offsets, global))
              .filter((ref): ref is NonNullable<typeof ref> => ref !== null)
              .slice(0, CITATION_CAP)
              .map((ref) => ({
                column: ref.column,
                line: ref.line,
                book: ref.book,
                href: `${BASE_URL}${workPath(work, ref.book)}?loc=${ref.column}:${ref.line}`,
              }));
          }
          groups[index] = { ...groups[index], citations };
        } catch {
          groups[index] = {
            ...groups[index],
            error: 'Citations for this work could not be resolved.',
          };
        }
      });

      details = { ...details, [id]: { loading: false, error: '', works: groups } };
    } catch {
      details = {
        ...details,
        [id]: {
          loading: false,
          error: 'Occurrences for this phrase could not be loaded.',
          works: [],
        },
      };
    }
  }
</script>

<main class="phrases-page">
  <header class="page-intro">
    <p class="eyebrow">Corpus phrase index</p>
    <h1>Phrases</h1>
    <p>
      Browse every recurrent two- to five-word phrase in the corpus: 173,884
      surface-form phrases and 390,675 dictionary-form phrases, each occurring
      at least twice.
      <a class="guide-link" href={`${BASE_URL}/advanced#phrases`} target="_blank" rel="noreferrer">What is this?</a>
    </p>
  </header>

  <section class="phrase-panel" aria-labelledby="phrase-filters">
    <h2 id="phrase-filters">Filter the index</h2>

    <fieldset class="stream-control">
      <legend>Count phrases by</legend>
      <label>
        <input
          type="radio"
          name="phrase-stream"
          value="form"
          bind:group={stream}
          on:change={() => page = 0}
        />
        Word as written
      </label>
      <label>
        <input
          type="radio"
          name="phrase-stream"
          value="lemma"
          bind:group={stream}
          on:change={() => page = 0}
        />
        Word in any of its forms
      </label>
      <label>
        <input
          type="radio"
          name="phrase-stream"
          value="english"
          bind:group={stream}
          on:change={() => page = 0}
        />
        English translation
      </label>
    </fieldset>

    <label class="field prefix-field" for="phrase-prefix">
      <span>Phrase starts with</span>
      <input
        id="phrase-prefix"
        type="search"
        placeholder="ws epi to polu"
        bind:value={prefix}
        on:input={() => page = 0}
        autocomplete="off"
        autocorrect="off"
        autocapitalize="none"
        spellcheck="false"
      />
      <small>
        {#if isEnglish}
          Type the English words as they stand in the translation.
        {:else if isLemma}
          Type Greek or plain letters, as the words stand on the page: this list
          stores <span lang="grc">τὸ τί ἦν εἶναι</span> as
          <span lang="grc">ὁ τίς εἰμί εἰμί</span>, and either finds it.
        {:else}
          Type Greek or plain letters — <span lang="grc">τὸ τί</span> and
          <code>to ti</code> both work. Accents are ignored.
        {/if}
        {#if normalizedPrefix && !widened}Matching <code>{normalizedPrefix}</code>.{/if}
      </small>
    </label>

    {#if widened && matchedReadings.length}
      <p class="widen-note" aria-live="polite">
        Reading these words as
        {#each matchedReadings as reading, i}<span lang="grc">{reading}</span>{i < matchedReadings.length - 1 ? ', ' : ''}{/each}{#if matchedRest} and {countFormat.format(matchedRest)} more{/if}.
        {#if widened.cappedFrom}
          These words have {countFormat.format(widened.cappedFrom)} readings in
          all; the first {VARIANT_READING_CAP} were tried.
        {/if}
      </p>
    {/if}

    <div class="control-grid">
      <fieldset class="length-control">
        <legend>Length</legend>
        {#each [2, 3, 4, 5] as n}
          <label>
            <input type="checkbox" value={n} bind:group={lengths} on:change={() => page = 0} />
            {n}
          </label>
        {/each}
      </fieldset>

      <label class="field compact-field" for="phrase-minimum">
        <span>Minimum count</span>
        <input
          id="phrase-minimum"
          type="number"
          min="2"
          step="1"
          bind:value={minCount}
          on:input={() => page = 0}
          on:change={clampMinimum}
        />
      </label>

      {#if isEnglish}
        <label class="field common-words">
          <span>
            <input type="checkbox" bind:checked={hideCommon} on:change={() => page = 0} />
            Hide phrases of common words only
          </span>
          <small>
            English builds its grammar from small words in fixed order, so
            <em>of the</em> and <em>it is</em> outrank anything Aristotle says.
            This hides them; it changes no count and no score.
          </small>
        </label>
      {/if}

    </div>

    <div class="work-field">
      <!-- Checkboxes, not a multi-select list. Picking two works out of 41 in a
           list box takes a modifier key nobody is told about, and one stray
           click throws the whole selection away. -->
      <fieldset class="work-list" aria-describedby="work-filter-note">
        <legend>Work</legend>
        <div class="work-options">
          {#each WORKS as work}
            <label>
              <input
                type="checkbox"
                value={work.id}
                bind:group={selectedWorks}
                on:change={() => page = 0}
              />
              {work.title}
            </label>
          {/each}
        </div>
      </fieldset>
      <div class="work-meta">
        <p id="work-filter-note">
          No selection includes every work. Tick one or more to keep phrases
          found in any of them. This filter needs an extra occurrence fetch for
          each selected phrase length, and one more for each shard the words are
          read in.
        </p>
        {#if selectedWorks.length}
          <button type="button" class="quiet-button" on:click={clearWorks}>
            Clear work filter ({selectedWorks.length})
          </button>
        {/if}
      </div>
    </div>
  </section>

  <section class="results" aria-labelledby="phrase-results">
    <div class="results-head">
      <div>
        <h2 id="phrase-results">Recurrent phrases</h2>
        {#if !shardLoading && !workFilterLoading && !shardError && !workFilterError}
          <p aria-live="polite">
            Showing {countFormat.format(shownFrom)}–{countFormat.format(shownTo)}
            of {countFormat.format(sortedRows.length)} matching phrases.
          </p>
        {/if}
      </div>
      <div class="results-tools">
        <label class="sort-field" for="phrase-sort">
          <span>Sort</span>
          <select id="phrase-sort" bind:value={sort} on:change={() => page = 0}>
            <option value="score">Distinctiveness</option>
            <option value="frequency">Frequency</option>
            <option value="length">Length</option>
            <option value="alphabetical">Alphabetical</option>
          </select>
        </label>
        <span class="loaded-shard">{stream === 'form' ? 'Surface' : stream === 'lemma' ? 'Lemma' : 'English'} · {shardBadge}</span>
      </div>
    </div>

    <p class="score-note">
      Distinctiveness measures how much more often the phrase occurs than its
      words appearing independently would predict. It only orders the list; it
      never removes anything.
    </p>

    {#if !normalizedPrefix}
      <div class="phrase-start">
        <p>
          Every run of two to five words that Aristotle uses more than once,
          counted. Start with one of these, or type a phrase above.
          {#if isEnglish}
            These are the translations, so a phrase standing in one work alone is
            that translator's habit; one standing in many is Aristotle recurring.
            The <em>Works</em> column tells them apart.
          {/if}
        </p>
        <ul class="phrase-examples">
          {#each (isEnglish ? ENGLISH_EXAMPLES : EXAMPLES) as ex}
            <li>
              <button type="button" class="phrase-example" on:click={() => { prefix = ex.beta; page = 0; }}>
                <span lang={isEnglish ? 'en' : 'grc'}>{ex.greek}</span>
                <small>{ex.gloss}</small>
              </button>
            </li>
          {/each}
        </ul>
        <p class="phrase-start-browse">
          Or browse phrases beginning with a letter:
          {#each BROWSE_LETTERS as l}
            <button type="button" class="letter-button" on:click={() => { prefix = l; page = 0; }}>{l}</button>
          {/each}
        </p>
      </div>
    {:else if planLoading}
      <p class="status" aria-live="polite">Looking up the forms of these words…</p>
    {:else if shardLoading || !activePlan}
      <p class="status" aria-live="polite">
        Loading the {shardBadge} phrase
        {(activePlan?.byLetter.length ?? 1) > 1 ? 'shards' : 'shard'}…
      </p>
    {:else if shardError}
      <div class="status error" role="alert">
        {shardError}
        <button type="button" class="text-button" on:click={retryShard}>Retry</button>
      </div>
    {:else if workFilterLoading}
      <p class="status" aria-live="polite">Loading occurrence data for the work filter…</p>
    {:else if workFilterError}
      <div class="status error" role="alert">
        {workFilterError}
        <button type="button" class="text-button" on:click={retryWorkFilter}>Retry</button>
      </div>
    {:else if sortedRows.length === 0}
      <p class="status">
        No phrases match these filters. Try a shorter prefix, a lower count, or
        another work.
        {#if widened && !matchedReadings.length}
          No reading of these words recurs in the corpus. Tried
          {#each triedReadings as reading, i}<span lang="grc">{reading}</span>{i < triedReadings.length - 1 ? ', ' : ''}{/each}{#if triedRest} and {countFormat.format(triedRest)} more{/if}.
        {/if}
      </p>
    {:else}
      <div class="column-head" aria-hidden="true">
        <span>Phrase</span>
        <span>Words</span>
        <span>Count</span>
        <span>Works</span>
        <span>Score</span>
        <span></span>
      </div>

      <ul class="phrase-list">
        {#each pageRows as item (item.key)}
          {@const id = phraseId(item)}
          {@const isExpanded = expanded.has(id)}
          {@const itemDetails = details[id]}
          <li class:expanded={isExpanded}>
            <button
              id={`phrase-button-${id}`}
              type="button"
              class="phrase-row"
              aria-expanded={isExpanded}
              aria-controls={`phrase-details-${id}`}
              on:click={() => togglePhrase(item)}
            >
              <span class="phrase-name">
                {#if isEnglish}
                  <span class="phrase-english">{item.key}</span>
                {:else}
                  <span class="phrase-greek" lang="grc">{betaToGreek(item.key)}</span>
                  <span class="phrase-key">{item.key}</span>
                {/if}
              </span>
              <span class="metric" data-label="Words">{item.row[0]}</span>
              <span class="metric" data-label="Count">{countFormat.format(item.row[1])}</span>
              <span class="metric" data-label="Works">{item.row[3]}</span>
              <span class="metric score" data-label="Score">{scoreFormat.format(item.row[2])}</span>
              <span class="caret" aria-hidden="true">›</span>
            </button>

            {#if isExpanded}
              <div
                id={`phrase-details-${id}`}
                class="phrase-details"
                role="region"
                aria-labelledby={`phrase-button-${id}`}
              >
                {#if item.row[4]}
                  <p class="crossing-note">
                    {countFormat.format(item.row[4])}
                    {item.row[4] === 1 ? ' occurrence crosses' : ' occurrences cross'}
                    a chapter boundary.
                  </p>
                {/if}

                {#if itemDetails?.loading}
                  <p class="detail-status" aria-live="polite">Resolving citations from the corpus offsets…</p>
                {:else if itemDetails?.error}
                  <p class="detail-status error" role="alert">{itemDetails.error}</p>
                {:else if itemDetails}
                  {#each itemDetails.works as group}
                    <section class="work-citations" aria-labelledby={`phrase-${id}-${group.id}`}>
                      <div class="work-heading">
                        <h3 id={`phrase-${id}-${group.id}`}>{group.title}</h3>
                        <span>{countFormat.format(group.total)}</span>
                      </div>
                      {#if group.error}
                        <p class="detail-status error">{group.error}</p>
                      {:else}
                        <ul class="citation-list">
                          {#each group.citations as citation}
                            <li>
                              <a href={citation.href}>
                                {citation.column}{citation.line ?? ''}
                              </a>
                            </li>
                          {/each}
                        </ul>
                        {#if group.citations.length < group.total}
                          <p class="cap-note">
                            Showing {countFormat.format(group.citations.length)}
                            of {countFormat.format(group.total)} occurrences.
                          </p>
                        {/if}
                      {/if}
                    </section>
                  {/each}
                {/if}
              </div>
            {/if}
          </li>
        {/each}
      </ul>

      {#if pageCount > 1}
        <nav class="pager" aria-label="Phrase result pages">
          <button
            type="button"
            on:click={() => page -= 1}
            disabled={page === 0}
            aria-label="Previous phrase page"
          >‹ Previous</button>
          <span>Page {page + 1} of {pageCount}</span>
          <button
            type="button"
            on:click={() => page += 1}
            disabled={page >= pageCount - 1}
            aria-label="Next phrase page"
          >Next ›</button>
        </nav>
      {/if}
    {/if}
  </section>
</main>

<style>
  .phrases-page {
    max-width: 820px;
    margin: 0 auto;
    padding: 1.5rem 1rem 4rem;
    color: var(--text);
  }

  .page-intro {
    margin: 0 0 1.25rem;
  }

  .page-intro .eyebrow {
    margin: 0 0 0.25rem;
    font-family: var(--font-ui);
    font-size: 0.72rem;
    font-weight: 700;
    letter-spacing: 0.09em;
    text-transform: uppercase;
    color: var(--accent);
  }

  .page-intro h1 {
    margin: 0;
    font-family: var(--font-english);
    font-size: 2rem;
    font-weight: 600;
    line-height: 1.15;
  }

  .page-intro > p:last-child {
    max-width: 68ch;
    margin: 0.45rem 0 0;
    font-family: var(--font-english);
    font-size: 1rem;
    line-height: 1.55;
    color: var(--text-mid);
  }

  .guide-link {
    font-family: var(--font-ui);
    font-size: 0.72rem;
    color: var(--text-light);
    text-decoration: underline;
    text-underline-offset: 0.12em;
  }

  .guide-link:hover {
    color: var(--accent);
  }

  .phrase-panel {
    display: flex;
    flex-direction: column;
    gap: 0.85rem;
    padding: 1.15rem 1.35rem 1.25rem;
    background: var(--col-bg);
    border: 1px solid var(--border);
    border-radius: 6px;
  }

  .phrase-panel h2,
  .results h2 {
    margin: 0;
    font-family: var(--font-ui);
    font-size: 0.95rem;
    font-weight: 700;
    letter-spacing: 0.03em;
  }

  fieldset {
    min-width: 0;
    margin: 0;
    padding: 0;
    border: 0;
  }

  legend,
  .field > span {
    font-family: var(--font-ui);
    font-size: 0.76rem;
    font-weight: 600;
    letter-spacing: 0.04em;
    color: var(--text-mid);
  }

  .stream-control,
  .length-control {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.45rem 1rem;
  }

  .stream-control legend,
  .length-control legend {
    float: left;
    margin-right: 0.4rem;
  }

  .stream-control label,
  .length-control label {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    font-family: var(--font-ui);
    font-size: 0.84rem;
    color: var(--text);
    cursor: pointer;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  input[type='search'],
  input[type='number'],
  select {
    box-sizing: border-box;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--input-bg);
    color: var(--text);
  }

  input[type='search'] {
    width: 100%;
    padding: 0.48rem 0.65rem;
    font-family: var(--font-ui);
    font-size: 0.95rem;
  }

  input[type='number'],
  select {
    padding: 0.36rem 0.45rem;
    font-family: var(--font-ui);
    font-size: 0.84rem;
  }

  input:focus-visible,
  select:focus-visible,
  button:focus-visible,
  a:focus-visible {
    outline: 2px solid var(--accent-light);
    outline-offset: 2px;
  }

  .prefix-field small {
    font-family: var(--font-ui);
    font-size: 0.72rem;
    line-height: 1.4;
    color: var(--text-mid);
  }

  .control-grid {
    display: grid;
    grid-template-columns: minmax(13rem, 1fr) auto auto;
    align-items: end;
    gap: 0.85rem 1rem;
  }

  .compact-field input {
    width: 7rem;
  }

  .score-note,
  .work-meta p {
    margin: 0;
    font-family: var(--font-ui);
    font-size: 0.76rem;
    line-height: 1.45;
    color: var(--text-mid);
  }

  .score-note {
    padding: 0 0 0.65rem;
  }

  .widen-note {
    margin: -0.35rem 0 0;
    font-family: var(--font-ui);
    font-size: 0.78rem;
    line-height: 1.5;
    color: var(--text-mid);
  }

  .widen-note span[lang='grc'] {
    font-family: var(--font-greek);
    color: var(--text);
  }

  .work-field {
    display: grid;
    grid-template-columns: minmax(17rem, 26rem) 1fr;
    align-items: start;
    gap: 0.45rem 1rem;
  }

  .work-list legend {
    margin-bottom: 0.3rem;
  }

  /* Forty-one works: two columns, and scrolled rather than allowed to push the
     results off the screen. */
  .work-options {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.1rem 0.75rem;
    max-height: 9.5rem;
    padding: 0.35rem 0.5rem;
    overflow-y: auto;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--input-bg);
  }

  .work-options label {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    font-family: var(--font-ui);
    font-size: 0.78rem;
    line-height: 1.5;
    color: var(--text);
    cursor: pointer;
  }

  .work-meta {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.5rem;
  }

  .quiet-button,
  .text-button,
  .pager button {
    font-family: var(--font-ui);
    color: var(--accent);
    background: var(--input-bg);
    border: 1px solid var(--border);
    border-radius: 4px;
    cursor: pointer;
  }

  .quiet-button {
    padding: 0.25rem 0.55rem;
    font-size: 0.74rem;
    font-weight: 600;
  }

  .results {
    margin-top: 1.5rem;
  }

  .results-head {
    display: flex;
    align-items: end;
    justify-content: space-between;
    gap: 1rem;
    margin-bottom: 0.65rem;
  }

  .results-head p {
    margin: 0.25rem 0 0;
    font-family: var(--font-ui);
    font-size: 0.76rem;
    color: var(--text-mid);
  }

  .results-tools {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    gap: 0.9rem;
  }

  .sort-field {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-family: var(--font-ui);
    font-size: 0.76rem;
    color: var(--text-mid);
  }

  .loaded-shard {
    flex-shrink: 0;
    font-family: var(--font-ui);
    font-size: 0.7rem;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-mid);
  }

  .status {
    margin: 0;
    padding: 1rem;
    font-family: var(--font-ui);
    font-size: 0.86rem;
    line-height: 1.5;
    color: var(--text-mid);
    background: var(--col-bg);
    border: 1px solid var(--border);
    border-radius: 5px;
  }

  .error {
    color: var(--text);
  }

  .text-button {
    margin-left: 0.5rem;
    padding: 0.15rem 0.45rem;
    font-size: 0.78rem;
  }

  .phrase-start {
    padding: 0.4rem 0.7rem 0.9rem;
    font-family: var(--font-ui);
    font-size: 0.85rem;
    color: var(--text-mid);
    max-width: 62ch;
  }
  .phrase-examples {
    list-style: none;
    margin: 0.7rem 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .phrase-example {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    text-align: left;
    font: inherit;
    padding: 0.4rem 0.7rem;
    border: 1px solid var(--border);
    border-radius: 5px;
    background: var(--col-bg);
    color: var(--text);
    cursor: pointer;
  }
  .phrase-example:hover {
    background: color-mix(in srgb, var(--accent) 8%, transparent);
  }
  .phrase-example span {
    font-family: var(--font-greek);
    font-size: 1rem;
  }
  .phrase-example small {
    color: var(--text-mid);
    font-size: 0.72rem;
  }
  .phrase-start-browse {
    margin-top: 0.9rem;
    line-height: 2;
  }
  .letter-button {
    font: inherit;
    font-size: 0.8rem;
    margin-left: 0.25rem;
    padding: 0.1rem 0.4rem;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--col-bg);
    color: var(--text);
    cursor: pointer;
  }
  .letter-button:hover {
    background: color-mix(in srgb, var(--accent) 10%, transparent);
  }

  .common-words small {
    display: block;
    margin-top: 0.25rem;
    max-width: 46ch;
  }

  .column-head,
  .phrase-row {
    display: grid;
    grid-template-columns: minmax(15rem, 1fr) 3.2rem 4.6rem 4rem 5rem 1rem;
    align-items: center;
    gap: 0.45rem;
  }

  .column-head {
    padding: 0 0.7rem 0.3rem;
    font-family: var(--font-ui);
    font-size: 0.66rem;
    font-weight: 700;
    letter-spacing: 0.05em;
    text-align: right;
    text-transform: uppercase;
    color: var(--text-mid);
  }

  .column-head span:first-child {
    text-align: left;
  }

  .phrase-list {
    margin: 0;
    padding: 0;
    list-style: none;
    border: 1px solid var(--border);
    border-radius: 6px;
    overflow: hidden;
  }

  .phrase-list > li {
    background: var(--input-bg);
    border-bottom: 1px solid var(--border);
  }

  .phrase-list > li:last-child {
    border-bottom: 0;
  }

  .phrase-list > li.expanded {
    background: var(--col-bg);
  }

  .phrase-row {
    width: 100%;
    padding: 0.62rem 0.7rem;
    font: inherit;
    text-align: left;
    color: var(--text);
    background: transparent;
    border: 0;
    cursor: pointer;
  }

  .phrase-row:hover {
    background: color-mix(in srgb, var(--accent) 6%, transparent);
  }

  .phrase-name {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.08rem;
  }

  .phrase-greek {
    overflow: hidden;
    font-family: var(--font-greek);
    font-size: 1.12rem;
    line-height: 1.25;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .phrase-key {
    overflow: hidden;
    font-family: var(--font-ui);
    font-size: 0.69rem;
    color: var(--text-mid);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .metric {
    font-family: var(--font-ui);
    font-size: 0.76rem;
    font-variant-numeric: tabular-nums;
    text-align: right;
    color: var(--text-mid);
  }

  .metric.score {
    color: var(--accent);
  }

  .caret {
    justify-self: end;
    font-family: var(--font-ui);
    color: var(--accent);
    transition: transform 0.12s ease;
  }

  .expanded .caret {
    transform: rotate(90deg);
  }

  .phrase-details {
    padding: 0.8rem 1rem 1rem;
    border-top: 1px solid var(--border);
  }

  .crossing-note,
  .detail-status,
  .cap-note {
    margin: 0;
    font-family: var(--font-ui);
    font-size: 0.74rem;
    line-height: 1.45;
    color: var(--text-mid);
  }

  .crossing-note {
    margin-bottom: 0.75rem;
    color: var(--text);
  }

  .work-citations + .work-citations {
    margin-top: 0.85rem;
  }

  .work-heading {
    display: flex;
    align-items: baseline;
    gap: 0.7rem;
    margin-bottom: 0.35rem;
    padding-bottom: 0.2rem;
    border-bottom: 1px solid var(--border);
  }

  .work-heading h3 {
    margin: 0;
    font-family: var(--font-ui);
    font-size: 0.82rem;
    font-weight: 700;
  }

  .work-heading span {
    font-family: var(--font-ui);
    font-size: 0.7rem;
    font-variant-numeric: tabular-nums;
    color: var(--text-mid);
  }

  .citation-list {
    display: flex;
    flex-wrap: wrap;
    gap: 0.32rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .citation-list a {
    display: inline-block;
    padding: 0.14rem 0.42rem;
    font-family: var(--font-ui);
    font-size: 0.74rem;
    font-variant-numeric: tabular-nums;
    text-decoration: none;
    color: var(--text);
    background: var(--input-bg);
    border: 1px solid var(--border);
    border-radius: 4px;
  }

  .citation-list a:hover {
    color: var(--accent);
    border-color: var(--accent);
  }

  .cap-note {
    margin-top: 0.35rem;
  }

  .pager {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.8rem;
    margin-top: 1rem;
    font-family: var(--font-ui);
    font-size: 0.78rem;
    color: var(--text-mid);
  }

  .pager button {
    padding: 0.32rem 0.7rem;
    font-size: 0.78rem;
  }

  .pager button:disabled {
    opacity: 0.45;
    cursor: default;
  }

  @media (prefers-reduced-motion: reduce) {
    .caret {
      transition: none;
    }
  }

  @media (max-width: 650px) {
    .phrase-panel {
      padding: 1rem;
    }

    .control-grid,
    .work-field {
      grid-template-columns: 1fr;
      align-items: start;
    }

    .work-options {
      grid-template-columns: 1fr;
    }

    .column-head {
      display: none;
    }

    .phrase-row {
      grid-template-columns: minmax(0, 1fr) repeat(4, auto) 0.75rem;
      gap: 0.35rem 0.6rem;
    }

    .metric {
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      font-size: 0.7rem;
    }

    .metric::before {
      content: attr(data-label);
      font-size: 0.54rem;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: var(--text-mid);
    }
  }

  @media (max-width: 470px) {
    .phrase-row {
      grid-template-columns: minmax(0, 1fr) repeat(2, auto) 0.75rem;
    }

    .metric[data-label='Words'],
    .metric[data-label='Works'] {
      display: none;
    }

    .phrase-details {
      padding-inline: 0.7rem;
    }
  }
</style>
