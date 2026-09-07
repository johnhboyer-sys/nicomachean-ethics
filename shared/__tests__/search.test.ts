import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ENGLISH_HEAD_LIMIT, engPhraseMatches, greekFold, search, searchGrammar } from '../lib/search';

const meta = [
  { id: 's1', book: 1, column: '1094a', greek_head: 'λόγος ἀρετή', english_head: 'virtue is a habit of choice' },
  { id: 's2', book: 1, column: '1094b', greek_head: 'ψυχή λόγος', english_head: 'happiness and virtue together' },
  { id: 's3', book: 2, column: '1100a', greek_head: 'τέχνη', english_head: 'craft concerns making' },
];

const greekIndex = {
  logos: [[0, 0], [1, 1]],
  areth: [[0, 1]],
  pasa: [[0, 2]],
  meqodos: [[0, 3]],
  kai: [[0, 5]],
  yuxh: [[1, 0]],
  texnh: [[2, 0]],
  lozzz: [[0, 4]],
  xlogos: [[2, 1]],
} satisfies Record<string, [number, number][]>;

const englishIndex = {
  virtue: [0, 1],
  habit: [0],
  choice: [0],
  happiness: [1],
  and: [1],
  craft: [2],
  making: [2],
} satisfies Record<string, number[]>;

function json(data: unknown) {
  return Promise.resolve({ ok: true, json: () => Promise.resolve(data) } as Response);
}

describe('greekFold', () => {
  it.each([
    ['λόγος', 'logos'],
    ['lo/gos', 'logos'],
    ['*a)nqrwpos', 'anqrwpos'],
    ["ἀρετή'", "areth'"],
    ['ψυχή κόσμος', 'yuxhkosmos'],
    ['δ’', "d'"],           // the page's elision mark, U+2019
    ["δ'", "d'"],
  ])('folds %s', (input, expected) => {
    expect(greekFold(input)).toBe(expected);
  });
});

describe('search', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      const path = String(url);
      if (path.endsWith('/meta.json')) return json(meta);
      if (path.endsWith('/greek_lemma.json') || path.endsWith('/greek_form.json')) return json(greekIndex);
      if (path.endsWith('/english.json')) return json(englishIndex);
      return Promise.resolve({ ok: false, status: 404, json: async () => ({}) } as Response);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns no results for empty queries or no works', async () => {
    await expect(search('', ' ', 'all', 'all', 'and', ['TEmpty'])).resolves.toEqual({ results: [], failedWorks: [] });
    await expect(search('logos', '', 'all', 'all', 'and', [])).resolves.toEqual({ results: [], failedWorks: [] });
  });

  it('supports all, any, and phrase modes', async () => {
    expect((await search('logos areth', '', 'all', 'all', 'and', ['TAll'])).results).toHaveLength(1);
    expect((await search('yuxh areth', '', 'any', 'all', 'and', ['TAny'])).results).toHaveLength(2);
    expect((await search('logos areth', '', 'phrase', 'all', 'and', ['TPhraseMiss'])).results).toHaveLength(1);
    expect((await search('areth logos', '', 'phrase', 'all', 'and', ['TPhraseHit'])).results).toHaveLength(0);
  });

  it('matches a mid-word Greek * without widening it to a prefix', async () => {
    const matching = (await search('l*s', '', 'all', 'all', 'and', ['TGreekMidStar'])).results;
    const missing = (await search('l*x', '', 'all', 'all', 'and', ['TGreekMidStar'])).results;
    expect(matching.map((r) => [r.meta.id, r.grkPositions])).toEqual([
      ['s1', [0]],
      ['s2', [1]],
    ]);
    expect(missing).toHaveLength(0);
  });

  it('keeps the trailing-* prefix fast path', async () => {
    const hits = (await search('tex*', '', 'all', 'all', 'and', ['TGreekTrailingStar'])).results;
    expect(hits.map((r) => r.meta.id)).toEqual(['s3']);
  });

  it('makes Greek ? match exactly one fold character', async () => {
    const one = (await search('l?gos', '', 'all', 'all', 'and', ['TGreekQuestion'])).results;
    const zero = (await search('l?ogos', '', 'all', 'all', 'and', ['TGreekQuestion'])).results;
    const two = (await search('l?os', '', 'all', 'all', 'and', ['TGreekQuestion'])).results;
    expect(one.map((r) => r.meta.id)).toEqual(['s1', 's2']);
    expect(zero).toHaveLength(0);
    expect(two).toHaveLength(0);
  });

  it('treats a leading Greek * as a capital marker', async () => {
    const hits = (await search('*logos', '', 'all', 'all', 'and', ['TGreekLeadingStar'])).results;
    expect(hits.map((r) => r.meta.id)).toEqual(['s1', 's2']);
  });

  it('matches a mid-word English * instead of looking up it literally', async () => {
    const hits = (await search('', 'hap*ness', 'all', 'all', 'and', ['TEnglishMidStar'])).results;
    expect(hits.map((r) => r.meta.id)).toEqual(['s2']);
  });

  it('makes English ? match exactly one fold character', async () => {
    const one = (await search('', 'c?aft', 'all', 'all', 'and', ['TEnglishQuestion'])).results;
    const zero = (await search('', 'c?raft', 'all', 'all', 'and', ['TEnglishQuestion'])).results;
    const two = (await search('', 'c?ft', 'all', 'all', 'and', ['TEnglishQuestion'])).results;
    expect(one.map((r) => r.meta.id)).toEqual(['s3']);
    expect(zero).toHaveLength(0);
    expect(two).toHaveLength(0);
  });

  it('keeps a bare English * matching every segment', async () => {
    const hits = (await search('', '*', 'all', 'all', 'and', ['TEnglishBareStar'])).results;
    expect(hits.map((r) => r.meta.id)).toEqual(['s1', 's2', 's3']);
  });

  it('combines Greek and English boxes with AND or OR', async () => {
    const andHits = (await search('logos', 'happiness', 'all', 'all', 'and', ['TAnd'])).results;
    const orHits = (await search('texnh', 'happiness', 'all', 'all', 'or', ['TOr'])).results;
    expect(andHits.map((r) => r.meta.id)).toEqual(['s2']);
    expect(orHits.map((r) => r.meta.id)).toEqual(['s2', 's3']);
  });

  // Regression: phrases used to be verified by substring-matching the user's
  // SURFACE folds against meta.greek_tokens, which was a LEMMA fold stream — so
  // genuine form-mode hits were silently dropped. Real case: EN 1:1094a reads
  // "pas meqodos" in the lemma stream while greek_form holds the surface pasa.
  // Phrases are now verified against posting adjacency, and greek_tokens is gone.
  // The index below stands in for that split: pasa@2, meqodos@3, kai@5.
  it('matches a form phrase whose lemma stream differs from the surface forms', async () => {
    const hits = (await search('pasa meqodos', '', 'phrase', 'all', 'and', ['TPhraseLemmaStream'], 'form')).results;
    expect(hits.map((r) => r.meta.id)).toEqual(['s1']);
    expect(hits[0].grkPositions).toEqual([2, 3]);
  });

  it('rejects phrase terms that are present but not adjacent or out of order', async () => {
    expect((await search('meqodos pasa', '', 'phrase', 'all', 'and', ['TPhraseOrder'], 'form')).results).toHaveLength(0);
    expect((await search('pasa kai', '', 'phrase', 'all', 'and', ['TPhraseGap'], 'form')).results).toHaveLength(0);
  });

  // A wildcard term inside a phrase must contribute its postings to adjacency,
  // and must survive the phrase VERIFICATION as well as the posting lookup.
  it('allows a wildcard inside a Greek phrase', async () => {
    const hits = (await search('pas* meqodos', '', 'phrase', 'all', 'and', ['TPhraseWild'], 'form')).results;
    expect(hits.map((r) => r.meta.id)).toEqual(['s1']);
    expect(hits[0].grkPositions).toEqual([2, 3]);
  });

  it('allows a wildcard inside an English phrase', async () => {
    // Regression: the phrase check folded `*` away and then looked for the
    // literal string "happ virtue", so the postings matched and the check
    // discarded them.
    const hits = (await search('', 'happ* and virtue', 'phrase', 'phrase', 'and', ['TEngPhraseWild'])).results;
    expect(hits.map((r) => r.meta.id)).toEqual(['s2']);
  });

  it.each([
    ['whitespace only', '   ', '\t'],
    ['pure punctuation', '!!!', '...'],
    ['regex metacharacters', '.*+?^${}()|[]\\', '.*+?^${}()|[]\\'],
    ['Greek string', 'λόγος τέχνη', 'virtue'],
    ['very long string', `${'logos '.repeat(500)}texnh`, `${'virtue '.repeat(500)}craft`],
  ])('does not throw for adversarial input: %s', async (_label, grk, eng) => {
    await expect(search(grk, eng, 'any', 'any', 'or', [`TAdv-${_label}`])).resolves.toMatchObject({ results: expect.any(Array), failedWorks: expect.any(Array) });
  });
});

// Four tokens in one segment, indexed by global offset:
//   0 unkeyed · 1 "fem nom sg" (sole reading) · 2 "fem nom/voc sg" (ONE
//   analysis, two possible cases) · 3 two analyses, nom and acc.
const grammarDict = {
  token_count: 4,
  width: 2,
  categories: ['case', 'gender', 'number'],
  reserved: { unkeyed: 0, unanalysed: 1 },
  sigs: [
    [],
    [],
    [{ gender: ['fem'], case: ['nom'], number: ['sg'] }],
    [{ gender: ['fem'], case: ['nom', 'voc'], number: ['sg'] }],
    [
      { gender: ['fem'], case: ['nom'], number: ['sg'] },
      { gender: ['fem'], case: ['acc'], number: ['pl'] },
    ],
  ],
};
const grammarOffsets = {
  token_count: 4,
  seg_base_offset: [0],
  segments: [{ book: 1, column: '1094a', line_runs: [[1, 4]] }],
  book_bounds: [{ book: 1, start: 0 }],
  chapter_bounds: [{ book: 1, chapter: '1', start: 0, accuracy: 'exact' }],
};
const grammarColumn = Uint16Array.from([0, 2, 3, 4]);

describe('lemma search resolves an inflected word to its headword', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      const path = String(url);
      if (path.endsWith('/meta.json')) return json(meta);
      if (path.endsWith('/greek_lemma.json') || path.endsWith('/greek_form.json')) return json(greekIndex);
      if (path.endsWith('/english.json')) return json(englishIndex);
      // fold(surface) -> the headwords it can belong to
      if (path.endsWith('/lemma-map/l.json')) return json({ logou: ['logos'], logos: ['logos'] });
      if (path.endsWith('/lemma-map/y.json')) return json({ yuxhs: ['yuxh'] });
      return Promise.resolve({ ok: false, status: 404, json: async () => ({}) } as Response);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('finds the whole word from a form the reader met on the page', async () => {
    // logou is not a key in the lemma index; logos is. Before the map was
    // consulted this returned nothing for a word occurring twice.
    const { results } = await search('logou', '', 'all', 'all', 'and', ['TInflected'], 'lemma');
    expect(results.map((r) => r.meta.id)).toEqual(['s1', 's2']);
  });

  it('still finds it when the reader types the dictionary form', async () => {
    const { results } = await search('logos', '', 'all', 'all', 'and', ['TDictForm'], 'lemma');
    expect(results.map((r) => r.meta.id)).toEqual(['s1', 's2']);
  });

  it('leaves a wildcard alone — it is a pattern over keys, not a word to resolve', async () => {
    const { results } = await search('l*s', '', 'all', 'all', 'and', ['TWild'], 'lemma');
    expect(results.map((r) => r.meta.id)).toEqual(['s1', 's2']);
  });

  it('does not resolve in form mode, where the typed spelling is the query', async () => {
    const { results } = await search('logou', '', 'all', 'all', 'and', ['TFormMode'], 'form');
    expect(results).toEqual([]);
  });
});

describe('searchGrammar', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      const path = String(url);
      if (path.endsWith('/meta.json')) return json(meta);
      if (path.endsWith('/offsets.json')) return json(grammarOffsets);
      if (path.endsWith('/grammar-dict.json')) return json(grammarDict);
      if (path.endsWith('/grammar-col.bin')) {
        return Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(grammarColumn.buffer) } as Response);
      }
      return Promise.resolve({ ok: false, status: 404, json: async () => ({}) } as Response);
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it('returns nothing for an empty query or no works', async () => {
    await expect(searchGrammar({}, ['TGEmpty'])).resolves.toEqual({ results: [], failedWorks: [] });
    await expect(searchGrammar({ case: 'nom' }, [])).resolves.toEqual({ results: [], failedWorks: [] });
  });

  it('finds every token a query is possible for, and reports its offset', async () => {
    const { results } = await searchGrammar({ case: 'nom' }, ['TGNom']);
    expect(results).toHaveLength(1);
    // Tokens 1, 2 and 3 all license nom; token 0 has no analysis.
    expect(results[0].grkPositions).toEqual([1, 2, 3]);
  });

  it('calls a sole unambiguous reading certain', async () => {
    const { results } = await searchGrammar({ case: 'nom' }, ['TGCertain']);
    expect(results[0].grammar![0]).toEqual({ values: { case: ['nom'] }, certain: true });
  });

  // The honesty tier. Both of these would read as a single certain parse if
  // ambiguity were counted as "number of analysis records".
  it('does not call a syncretic single analysis certain', async () => {
    const { results } = await searchGrammar({ case: 'nom' }, ['TGSyncretic']);
    expect(results[0].grammar![1]).toEqual({ values: { case: ['nom', 'voc'] }, certain: false });
  });

  it('does not call a multi-analysis token certain', async () => {
    const { results } = await searchGrammar({ case: 'nom' }, ['TGMulti']);
    expect(results[0].grammar![2]).toEqual({ values: { case: ['acc', 'nom'] }, certain: false });
  });

  it('requires one single reading to satisfy every part of the query', async () => {
    // Token 3 licenses nom (reading 1) and pl (reading 2), but no reading
    // licenses both — a per-category union would wrongly match it.
    const { results } = await searchGrammar({ case: 'nom', number: 'pl' }, ['TGCorrelation']);
    expect(results).toHaveLength(0);
  });

  it('refuses to join files built from different runs', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      const path = String(url);
      if (path.endsWith('/meta.json')) return json(meta);
      if (path.endsWith('/offsets.json')) return json({ ...grammarOffsets, token_count: 99 });
      if (path.endsWith('/grammar-dict.json')) return json(grammarDict);
      return Promise.resolve({ ok: false, status: 404, json: async () => ({}) } as Response);
    });
    await expect(searchGrammar({ case: 'nom' }, ['TGMismatch'])).rejects.toThrow(/grammar index/);
  });
});

describe('a phrase typed as it stands on the page, under the default lemma mode', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      const path = String(url);
      if (path.endsWith('/meta.json')) return json(meta);
      if (path.endsWith('/greek_lemma.json')) return json(greekIndex);
      if (path.endsWith('/lemma-map/l.json')) return json({ logou: ['logos'], logos: ['logos', 'xlogos'] });
      if (path.endsWith('/lemma-map/a.json')) return json({ areths: ['areth'] });
      if (path.endsWith('/lemma-map/t.json')) return json({ texnh: ['texnh', 'logos'] });
      return Promise.resolve({ ok: false, status: 404, json: async () => ({}) } as Response);
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it('finds the run under the headwords the typed inflections belong to', async () => {
    // logou and areths are not keys in the lemma index; the run "logos areth"
    // stands at s1 positions 0–1. Matching only the typed fold found nothing
    // and then told the reader the words never stand together.
    const { results } = await search('logou areths', '', 'phrase', 'all', 'and', ['TPhraseInfl'], 'lemma');
    expect(results.map((r) => [r.meta.id, r.grkPositions])).toEqual([['s1', [0, 1]]]);
  });

  it('under headword mode takes the keys as given and widens nothing', async () => {
    // The lemma-map says the spelling "texnh" can also belong to logos (s1, s2).
    // A typed word is widened; a picked headword key is exactly itself. (The
    // lemma-map shards are cached for the module, so this uses a letter no
    // earlier block loaded.)
    const typed = await search('texnh', '', 'all', 'all', 'and', ['THeadTyped'], 'lemma');
    expect(typed.results.map((r) => r.meta.id)).toEqual(['s1', 's2', 's3']);
    const picked = await search('texnh', '', 'all', 'all', 'and', ['THeadPicked'], 'headword');
    expect(picked.results.map((r) => r.meta.id)).toEqual(['s3']);
  });
});

describe('engPhraseMatches', () => {
  it.each([
    ['the good', 'the good life', true],
    ['the good', 'breathe goodness', false],        // substrings are not words
    ['the good', 'to breathe good air', false],
    ['virtue is', 'virtue is a habit', true],
    ['virtue is', 'virtue, is it a habit', false],  // punctuation breaks the phrase
    ['virtue is', 'virtue\n  is a habit', true],    // any whitespace joins it
    ["aristotle's view", 'in aristotle’s view', true],
    ['hap* virtue', 'happiness, virtue', false],
    ['hap* virtue', 'happy virtue', true],
    ['*ness of', 'the goodness of it', true],
    ['go?d', 'the good life', true],
    ['go?d', 'the gold life', true],
    ['go?d', 'the god life', false],
    ['first change', 'the first ‘change’ is', true],   // quote marks are not part of the word
    ["aristotle's", "‘aristotle’s’ view", true],
  ])('%s in %j → %s', (phrase, text, expected) => {
    expect(engPhraseMatches(text, phrase.split(' '))).toBe(expected);
  });
});

describe('an English phrase is an adjacency test over word positions', () => {
  // stage6 keeps only the first 500 characters of a segment's English in
  // meta.json; the postings carry every word with its position.
  const filler = 'lorem ipsum '.repeat(60).slice(0, ENGLISH_HEAD_LIMIT);
  const longMeta = [
    { id: 'L1', book: 1, column: '1094a', greek_head: '', english_head: filler },
    { id: 'L2', book: 1, column: '1094b', greek_head: '', english_head: 'virtue and a habit' },
    { id: 'L3', book: 2, column: '1100a', greek_head: '', english_head: filler },
  ];
  // L1: "virtue habit" adjacent past the cut. L2: "virtue and a habit" — not
  // adjacent. L3: "virtue and habit" past the cut — not adjacent.
  const positional = {
    virtue: [[0, 120], [1, 0], [2, 120]],
    habit: [[0, 121], [1, 3], [2, 122]],
    and: [[1, 1], [2, 121]],
  };
  const legacy = { virtue: [0, 1, 2], habit: [0, 1, 2], and: [1, 2] };
  let books: string[];
  const mock = (english: unknown) => {
    books = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      const path = String(url);
      if (path.endsWith('/meta.json')) return json(longMeta);
      if (path.endsWith('/english.json')) return json(english);
      if (/\/book-\d+\.json$/.test(path)) books.push(path);
      return Promise.resolve({ ok: false, status: 404, json: async () => ({}) } as Response);
    });
  };
  afterEach(() => vi.restoreAllMocks());

  it('finds the phrase past the head from the postings, fetching no book', async () => {
    mock(positional);
    const { results } = await search('', 'virtue habit', 'all', 'phrase', 'and', ['TPosIndex']);
    expect(results.map((r) => r.meta.id)).toEqual(['L1']);
    expect(books).toEqual([]);
  });

  it('on an older build without positions checks the head and fetches nothing', async () => {
    // The phrase past the cut is missed on such a build — the older limit,
    // kept rather than fetching every candidate's whole book.
    mock(legacy);
    const { results } = await search('', 'virtue habit', 'all', 'phrase', 'and', ['TLegacyIndex']);
    expect(results).toEqual([]);
    expect(books).toEqual([]);
  });
});

describe('an English word typed or pasted from the page', () => {
  const quoteMeta = [
    { id: 'Q1', book: 1, column: '1094a', greek_head: '', english_head: 'Aristotle’s first ‘change’ isn’t the last.' },
  ];
  // Keyed as stage6's english_words() keys them.
  const index = { "aristotle's": [[0, 0]], first: [[0, 1]], change: [[0, 2]], "isn't": [[0, 3]], the: [[0, 4]], last: [[0, 5]] };
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      const path = String(url);
      if (path.endsWith('/meta.json')) return json(quoteMeta);
      if (path.endsWith('/english.json')) return json(index);
      return Promise.resolve({ ok: false, status: 404, json: async () => ({}) } as Response);
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ['aristotle’s', 1],    // the page's U+2019
    ["aristotle's", 1],
    ['‘change’', 1],       // quote marks are not part of the word
    ["'change'", 1],
    ['aristotles', 0],
  ])('%s → %i segment', async (q, n) => {
    const { results } = await search('', q, 'all', 'all', 'and', ['TQuotes']);
    expect(results).toHaveLength(n);
  });

  it('finds a phrase whose words the page prints with curly marks', async () => {
    const { results } = await search('', 'first ‘change’ isn’t', 'all', 'phrase', 'and', ['TQuotesPhrase']);
    expect(results.map((r) => r.meta.id)).toEqual(['Q1']);
  });
});
