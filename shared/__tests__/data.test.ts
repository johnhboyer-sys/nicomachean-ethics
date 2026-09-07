import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAnalyses, fetchBekkerIndex, fetchBook, fetchColumns, fetchFootnotes, fetchLemmata, fetchLsjShard, invalidateBookCache, lookupWord, lsjShard, parseBekker, resolveBekker } from '../lib/data';

function mockFetch(map: Record<string, unknown>) {
  vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
    const key = Object.keys(map).find((part) => String(url).includes(part));
    if (!key) return Promise.resolve({ ok: false, status: 404, json: async () => ({}) } as Response);
    return Promise.resolve({ ok: true, json: async () => map[key] } as Response);
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as { __ARISTOTLE_BOOK_HOOK__?: unknown }).__ARISTOTLE_BOOK_HOOK__;
});

describe('parseBekker and resolveBekker', () => {
  it.each([
    ['1097a15', { column: '1097a', line: 15 }],
    ['1097a 15', { column: '1097a', line: 15 }],
    ['1097A.15', { column: '1097a', line: 15 }],
    ['  1000b2  ', { column: '1000b', line: 2 }],
    ['16a5', { column: '16a', line: 5 }],      // De Interpretatione
    ['1b12', { column: '1b', line: 12 }],      // Categories
    ['not a citation', null],
    ['1097c15', null],
  ])('parses %s', (raw, expected) => {
    expect(parseBekker(raw)).toEqual(expected);
  });

  it('resolves columns and snaps shared-column gaps to the nearest book', () => {
    const columns = {
      '1097a': [{ book: 1, lo: 1, hi: 20 }],
      '1100b': [{ book: 1, lo: 1, hi: 8 }, { book: 2, lo: 14, hi: 20 }],
    };
    expect(resolveBekker(columns, '1097a', 10)).toBe(1);
    expect(resolveBekker(columns, '1100b', 4)).toBe(1);
    expect(resolveBekker(columns, '1100b', 12)).toBe(2);
    expect(resolveBekker(columns, '999a', 1)).toBeNull();
  });
});

describe('fetch and lookup helpers', () => {
  it('fetchBook returns JSON data and applies the runtime hook', async () => {
    mockFetch({
      'HookWork/book-01.json': { book: 1, segments: [] },
    });
    (globalThis as { __ARISTOTLE_BOOK_HOOK__?: unknown }).__ARISTOTLE_BOOK_HOOK__ = vi.fn((_work, _n, data) => ({
      ...data,
      segments: [{ id: 'hooked', column: '1a', greek: [], english: null }],
    }));

    await expect(fetchBook('HookWork', 1)).resolves.toMatchObject({
      book: 1,
      segments: [{ id: 'hooked' }],
    });
  });

  it('invalidateBookCache forces a re-fetch that re-runs the book hook', async () => {
    // Two fetches of the same book normally hit the promise cache once — the
    // hook runs a single time. This is the desktop import staleness bug: a
    // re-import updates the hook's overlay data, but the open book keeps its
    // first (pre-import) hook result until the cache is dropped.
    mockFetch({ 'EvictWork/book-01.json': { book: 1, segments: [] } });
    const hook = vi.fn((_work, _n, data) => data);
    (globalThis as { __ARISTOTLE_BOOK_HOOK__?: unknown }).__ARISTOTLE_BOOK_HOOK__ = hook;

    await fetchBook('EvictWork', 1);
    await fetchBook('EvictWork', 1);
    expect(hook).toHaveBeenCalledTimes(1);           // cached: hook ran once

    invalidateBookCache('EvictWork');
    await fetchBook('EvictWork', 1);
    expect(hook).toHaveBeenCalledTimes(2);           // evicted: re-fetch re-ran the hook

    // A different work's cache is untouched by the eviction.
    invalidateBookCache('OtherWork');
    await fetchBook('EvictWork', 1);
    expect(hook).toHaveBeenCalledTimes(2);           // still cached — no spurious re-fetch
  });

  it('fetchFootnotes linkifies glossary references for EN only', async () => {
    mockFetch({
      'EN/footnotes.json': { '1': 'See Glossary, <em>hexis</em>.' },
      'DA/footnotes.json': { '1': 'See Glossary, <em>hexis</em>.' },
    });

    await expect(fetchFootnotes('EN')).resolves.toMatchObject({
      '1': expect.stringContaining('class="gloss-ref"'),
    });
    await expect(fetchFootnotes('DA')).resolves.toMatchObject({
      '1': 'See Glossary, <em>hexis</em>.',
    });
  });

  it('selects LSJ shards and de-duplicates lookupWord dictionary entries', async () => {
    mockFetch({
      'LookupWork/analyses.json': {
        logos: [
          { lemma: 'lo/gos', gloss: 'word', parse: 'noun', lsj: ['lo/gos', '*a)rxh/'] },
          { lemma: 'lo/gos', gloss: 'speech', parse: 'noun', lsj: ['lo/gos'] },
        ],
      },
      '/lsj/l.json': { 'lo/gos': { key: 'lo/gos', head: 'λόγος', html: '<p>word</p>' } },
      '/lsj/a.json': { '*a)rxh/': { key: '*a)rxh/', head: 'ἀρχή', html: '<p>beginning</p>' } },
    });

    expect(lsjShard('*a)rxh/')).toBe('a');
    expect(lsjShard('123')).toBe('_');
    const result = await lookupWord('LookupWork', 'logos');
    expect(result.analyses).toHaveLength(2);
    expect(result.lsj.map((e) => e.key)).toEqual(['lo/gos', '*a)rxh/']);
    await expect(fetchLsjShard('missing')).resolves.toEqual({});
  });
});

describe('a failed fetch is not remembered', () => {
  // Every helper evicts a rejection so the next call can retry. Two of them
  // did not, and two more resolved {} on a 404 so the eviction never fired;
  // either way one bad response mid-deploy pinned the failure for the session.
  it('fetchAnalyses retries after a rejection', async () => {
    mockFetch({});
    await expect(fetchAnalyses('RetryWork')).rejects.toThrow('RetryWork analyses: 404');
    mockFetch({ 'RetryWork/analyses.json': { logos: [] } });
    await expect(fetchAnalyses('RetryWork')).resolves.toEqual({ logos: [] });
  });

  it('fetchColumns retries after a rejection', async () => {
    mockFetch({});
    await expect(fetchColumns('RetryWork')).rejects.toThrow('RetryWork columns: 404');
    mockFetch({ 'RetryWork/columns.json': { '1094a': [{ book: 1, lo: 1, hi: 20 }] } });
    await expect(fetchColumns('RetryWork')).resolves.toEqual({ '1094a': [{ book: 1, lo: 1, hi: 20 }] });
  });

  it('fetchBekkerIndex rejects on a bad response and retries, rather than caching {}', async () => {
    mockFetch({});
    await expect(fetchBekkerIndex()).rejects.toThrow('bekker.json: 404');
    mockFetch({ 'bekker.json': { '1094a': [['EN', 1, 1, 20]] } });
    await expect(fetchBekkerIndex()).resolves.toEqual({ '1094a': [{ work: 'EN', book: 1, lo: 1, hi: 20 }] });
  });

  it('fetchLemmata rejects on a bad response and retries, rather than caching {}', async () => {
    mockFetch({});
    await expect(fetchLemmata()).rejects.toThrow('lemmata.json: 404');
    mockFetch({ 'lemmata.json': { 'lo/gos': { slug: 'logos', head: 'λόγος', count: 3 } } });
    await expect(fetchLemmata()).resolves.toEqual({ 'lo/gos': { slug: 'logos', head: 'λόγος', count: 3 } });
  });
});
