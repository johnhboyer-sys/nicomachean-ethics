// Search engine — operates on the prebuilt inverted indexes from Stage 6.
//
// Greek search: input is Unicode Greek OR TLG Beta Code (with optional * wildcards).
//   Converted to fold form (base Beta Code letters only) to match the index.
//   Beta Code letters already ARE the fold form (θ→q, φ→f, χ→x, ψ→y, ξ→c,
//   η→h, ω→w, …), so Latin input passes straight through; accents/breathings
//   (the ) ( / \ = | + markers) are stripped, matching the index's fold form.
// English search: whitespace-tokenized, lowercase.
// Phrase search: after intersection, verify token adjacency in segment data.
// Cross-language: AND (intersection) or OR (union) the two result sets.
import { memoAsyncBy } from './memo';

// Honour Astro's base path. BASE_URL may lack a trailing slash, so strip + join.
// Same host override as data.ts: the desktop app points the whole data layer
// at an on-disk corpus via globalThis.__ARISTOTLE_DATA_ROOT__ (read lazily so
// module-import order doesn't matter); the site never sets it.
const DEFAULT_ROOT = `${import.meta.env.BASE_URL.replace(/\/$/, '')}/data`;
const ROOT = () =>
  (globalThis as { __ARISTOTLE_DATA_ROOT__?: string }).__ARISTOTLE_DATA_ROOT__ ?? DEFAULT_ROOT;
const searchBase = (work: string) => `${ROOT()}/${work}/search`;

// -- Data types -----------------------------------------------------------

export interface SegMeta {
  id: string;
  book: number;
  column: string;
  greek_head: string;
  english_head: string;
}

type GrkIndex = Record<string, [number, number][]>; // fold → [[seg_idx, pos], ...]
// word → [[seg_idx, word_pos], ...] since 2026-09-07; an older build carries
// bare seg_idxs, and the reader takes either (see englishPhraseHits).
type EngIndex = Record<string, number[] | [number, number][]>;

// The word-offset primitive: one running token number per work, in document
// order, with the structural coordinates beside it. Global offset of a posting
// is seg_base_offset[seg_idx] + token_pos.
export interface Offsets {
  token_count: number;
  seg_base_offset: number[];
  segments: { book: number; column: string; line_runs: [number, number][] }[];
  book_bounds: { book: number; start: number }[];
  // accuracy is 'exact' where the chapter start was matched against the Greek
  // text, 'line-snapped' where the source knew only the Bekker line.
  chapter_bounds: { book: number; chapter: string; start: number; accuracy: string }[];
}

// A morphological reading: category → the values it licenses. A reading with
// more than one value for a category is syncretic ("fem nom/voc sg"), which is
// as genuinely ambiguous as two separate analyses.
type Reading = Record<string, string[]>;

// Signature dictionary + packed column. sigs[id] is the distinct readings a
// token's analyses license; the column holds one id per token, by global offset.
export interface GrammarDict {
  token_count: number;
  width: number;               // bytes per column entry
  categories: string[];
  reserved: { unkeyed: number; unanalysed: number };
  sigs: Reading[][];
}

// A grammatical query: category → required value, e.g. { mood: 'opt' }.
export type GrammarQuery = Record<string, string>;

// Greek search can match by dictionary headword ('lemma', every inflected form)
// or by the exact surface form as written ('form').
// lemma: the reader typed a word; resolve it to every headword it can belong
//   to (a typed inflection finds its dictionary entry) and search the lemma
//   index. form: the exact inflected token. headword: the caller already holds
//   the exact lemma keys (the picker's ticks) and wants those and nothing
//   wider — the lemma index, without resolution.
export type MatchMode = 'lemma' | 'form' | 'headword';

// -- Per-work index loading (cached, lazy per file) -----------------------
//
// Each index file is fetched and cached on its own, and only when a query
// actually needs it (a Greek-only query never loads english.json, and only the
// lemma OR form index per its match mode). This keeps the request burst small:
// a Greek search over all works loads ~2 files/work, not 4 — which matters on
// Safari/WebKit, where a large simultaneous fetch burst can drop a request with
// "TypeError: Load failed" and (via Promise.all) sink the whole search.

// Each loader memoises through lib/memo.ts, which evicts a rejection so a
// transient drop can be retried — a rejected promise must NOT stay cached
// (that would poison every later search in the tab). One memo per loader,
// rather than the single `_fileCache` these shared before: the three key spaces
// never overlapped anyway, which is why the corpus-level one needed its "::"
// prefix (so a path could not collide with a work called "lemma-map") and now
// does not.

// A per-work index is keyed `<work>/<file>`, the same string the error message
// quotes; the search directory sits between the two in the URL.
const searchUrl = (key: string) => {
  const at = key.indexOf('/');
  return `${searchBase(key.slice(0, at))}/${key.slice(at + 1)}`;
};

const _index = memoAsyncBy<string, unknown>(key =>
  fetch(searchUrl(key)).then(r => {
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${key}`);
    return r.json();
  }));

function loadIndex<T>(work: string, file: string): Promise<T> {
  return _index(`${work}/${file}`) as Promise<T>;
}

// Corpus-level indexes live beside the per-work ones rather than inside them,
// so they are fetched from the root and memoised on their own path.
const _shared = memoAsyncBy<string, unknown>(path =>
  fetch(`${ROOT()}/${path}`).then(r => {
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${path}`);
    return r.json();
  }));

function loadShared<T>(path: string): Promise<T> {
  return _shared(path) as Promise<T>;
}

// The grammatical column is binary (one small int per token, indexed by global
// offset), so it needs arrayBuffer rather than json. Cached the same way, in
// its own memo — the one .bin file never shares a key with a JSON index.
const _binary = memoAsyncBy<string, ArrayBuffer>(key =>
  fetch(searchUrl(key)).then(r => {
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${key}`);
    return r.arrayBuffer();
  }));

function loadBinary(work: string, file: string): Promise<ArrayBuffer> {
  return _binary(`${work}/${file}`);
}

// Run `fn` over `items` with at most `limit` in flight at once (bounds the
// concurrent-fetch burst that can make Safari drop requests with "Load
// failed"). Rejections propagate; callers that want per-item tolerance pass an
// `fn` that catches. Shared with the components — one loop, not three copies.
export async function pool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

// -- Unicode Greek → Beta Code fold form ----------------------------------

const GREEK_BETA: Record<string, string> = {
  α:'a',β:'b',γ:'g',δ:'d',ε:'e',ζ:'z',η:'h',θ:'q',ι:'i',κ:'k',
  λ:'l',μ:'m',ν:'n',ξ:'c',ο:'o',π:'p',ρ:'r',σ:'s',ς:'s',τ:'t',
  υ:'u',φ:'f',χ:'x',ψ:'y',ω:'w',ϝ:'v',
};

export function greekFold(input: string): string {
  const out: string[] = [];
  for (const ch of input.normalize('NFD')) {
    const lower = ch.toLowerCase();
    const b = GREEK_BETA[lower];
    if (b) out.push(b);                          // Unicode Greek → fold letter
    else if (lower >= 'a' && lower <= 'z') out.push(lower); // Beta Code Latin input
    // Elision: the index keys δ' as d'. The page prints the mark as U+2019
    // (δ’), so a word copied from the text must fold to the same key as one
    // typed with a straight apostrophe.
    else if (ch === "'" || ch === '\u2019' || ch === '\u02bc') out.push("'");
    // skip combining marks, punctuation, Beta Code diacritics ) ( / \ = | +,
    // asterisk (handled by caller), and sigma-variant digits
  }
  return out.join('');
}

// Fold a pattern without losing its metacharacters. Folding one character at
// a time keeps * and ? out of greekFold(), where they are deliberately ignored
// with punctuation and diacritics.
function compilePattern(
  term: string,
  fold: (s: string) => string,
): { exact: string } | { test: (key: string) => boolean } | null {
  const input = term.replace(/^\*+/, '');
  let pattern = '';
  for (const ch of input) {
    pattern += ch === '*' || ch === '?' ? ch : fold(ch);
  }
  if (!pattern) return null;

  if (!pattern.includes('*') && !pattern.includes('?')) {
    return { exact: pattern };
  }

  // Preserve the common trailing-* fast path without compiling or scanning
  // with a regular expression.
  if (pattern.endsWith('*')
    && !pattern.slice(0, -1).includes('*')
    && !pattern.includes('?')) {
    const prefix = pattern.slice(0, -1);
    return { test: key => key.startsWith(prefix) };
  }

  // Index keys contain only fold letters and apostrophes. Build the expression
  // from known-safe pieces rather than interpolating user input.
  const pieces: string[] = [];
  for (const ch of pattern) {
    if (ch === '*') pieces.push("[a-z']*");
    else if (ch === '?') pieces.push("[a-z']");
    else pieces.push(ch);
  }
  const regex = new RegExp(`^${pieces.join('')}$`);
  return { test: key => regex.test(key) };
}

// The one statement of what an English word is, on the reader's side; stage6's
// english_words() is its mirror on the index side (pinned by a pipeline test).
// The page prints possession and elision with U+2019 (Aristotle’s) and quotes
// with U+2018/U+2019 (‘change’): both become a straight apostrophe, and an
// apostrophe at a word's edge is a quotation mark, not part of the word.
const ENGLISH_QUOTES = /[\u2018\u2019\u02bc]/g;
function englishFold(input: string): string {
  return input.toLowerCase().replace(ENGLISH_QUOTES, "'").replace(/[^a-z']/g, '');
}
function englishTerm(term: string): string {
  return term.replace(ENGLISH_QUOTES, "'").replace(/^'+|'+$/g, '');
}

// -- Posting-list helpers -------------------------------------------------

function grkPosting(idx: GrkIndex, term: string): Set<number> {
  const pattern = compilePattern(term, greekFold);
  if (!pattern) return new Set();
  if ('exact' in pattern) {
    return new Set((idx[pattern.exact] ?? []).map(([si]) => si));
  }
  const result = new Set<number>();
  for (const key of Object.keys(idx)) {
    if (pattern.test(key)) {
      for (const [si] of idx[key]) result.add(si);
    }
  }
  return result;
}

const engSeg = (p: number | [number, number]): number => (typeof p === 'number' ? p : p[0]);

function engPosting(idx: EngIndex, term: string): Set<number> {
  const result = new Set<number>();
  if (term === '*') {
    for (const ps of Object.values(idx)) for (const p of ps) result.add(engSeg(p));
    return result;
  }
  const pattern = compilePattern(englishTerm(term), englishFold);
  if (!pattern) return result;
  if ('exact' in pattern) {
    for (const p of idx[pattern.exact] ?? []) result.add(engSeg(p));
    return result;
  }
  for (const key of Object.keys(idx)) {
    if (pattern.test(key)) {
      for (const p of idx[key]) result.add(engSeg(p));
    }
  }
  return result;
}

// True when the index carries word positions (a build since 2026-09-07).
function engHasPositions(idx: EngIndex): idx is Record<string, [number, number][]> {
  for (const ps of Object.values(idx)) {
    if (ps.length) return typeof ps[0] !== 'number';
  }
  return false;
}

function intersect(a: Set<number>, b: Set<number>): Set<number> {
  return new Set([...a].filter(x => b.has(x)));
}

function union(a: Set<number>, b: Set<number>): Set<number> {
  return new Set([...a, ...b]);
}

// Phrase check, by posting adjacency: seg_idx → start positions of every run
// where the terms occupy consecutive token positions, in order.
//
// This works off the same postings the query already intersected, so it uses
// whichever index the match mode selected (surface forms for 'form', every
// analysis lemma for 'lemma'), and wildcard terms participate via their
// postings. Token positions count EVERY token, so an unanalysed word between
// two terms correctly breaks adjacency.
//
// Each term is a list of ALTERNATIVE keys, any of which may stand at that
// position: a lemma search resolves a typed inflection to every headword it can
// belong to, and a phrase typed as it stands on the page — κατὰ συμβεβηκός —
// must find its run under whichever of those headwords the token was analysed
// to. Taking only the first alternative found nothing for exactly the phrases
// a reader copies off the page.
function phraseStarts(
  idx: GrkIndex,
  terms: string[][],
  fold: (s: string) => string = greekFold,
): Map<number, number[]> {
  const out = new Map<number, number[]>();
  const perTerm = terms.map(alts => {
    if (alts.length === 1) return termPositions(idx, alts[0], fold);
    const merged = new Map<number, number[]>();
    for (const alt of alts) {
      for (const [si, ps] of termPositions(idx, alt, fold)) {
        const arr = merged.get(si);
        if (arr) arr.push(...ps);
        else merged.set(si, [...ps]);
      }
    }
    return merged;
  });
  const first = perTerm[0];
  if (!first) return out;
  for (const [si, firstPositions] of first) {
    const rest = perTerm.slice(1).map(m => new Set(m.get(si) ?? []));
    if (rest.some(s => s.size === 0)) continue;
    const starts = [...new Set(firstPositions)]
      .filter(p => rest.every((s, j) => s.has(p + j + 1)))
      .sort((a, b) => a - b);
    if (starts.length) out.set(si, starts);
  }
  return out;
}

// English phrase against a TEXT, for an index built before word positions
// were stored: do all terms appear in order, as whole words?
//
// Whole words, because the postings already guarantee every term occurs as a
// word somewhere in the segment, so a bare substring test only ADDS false
// positives: "the good" inside "breathe goodness". Whitespace between the
// words, any amount; punctuation between them means the phrase is not there.
// A typed straight apostrophe matches the text's curly one.
export function compileEnglishPhrase(terms: string[]): (text: string) => boolean {
  if (terms.length === 0) return () => true;
  // Keep the wildcards. Folding them away here would leave `hap* virtue` looking
  // for the literal string "hap virtue", so the postings would find the phrase
  // and this check would then throw it away. A leading * asks for any start
  // ("*ness" — happiness, goodness), so that term takes no boundary on its left.
  const parts = terms.map(t => {
    const raw = t.toLowerCase();
    const body = [...raw.replace(/^\*+/, '')]
      .filter(ch => /[a-z'*?]/.test(ch))
      .join('');
    return { open: raw.startsWith('*'), body };
  });
  if (parts.some(p => !p.body)) return () => false;
  const pattern = new RegExp(parts
    .map(p => {
      const body = [...p.body].map(ch =>
        ch === '*' ? "[a-z']*" : ch === '?' ? "[a-z']" : ch).join('');
      return `${p.open ? '' : "(?<![a-z'])"}${body}(?![a-z'])`;
    })
    .join('\\s+'));
  // A word wrapped in single quotes — ‘change’ — closes with the same U+2019
  // that Aristotle’s elides with, so after the fold the quote marks are
  // apostrophes glued to the word; the index (stage6 english_words) strips
  // them at a word's edge, and so must the boundary here.
  return text => pattern.test(
    text.toLowerCase()
      .replace(ENGLISH_QUOTES, "'")
      .replace(/(^|[^a-z'])'+|'+(?=[^a-z']|$)/g, '$1'),
  );
}
export function engPhraseMatches(text: string, terms: string[]): boolean {
  return compileEnglishPhrase(terms)(text);
}

// An English phrase is an adjacency test over the postings, exactly as a Greek
// one is, when the index carries word positions (builds since 2026-09-07).
//
// An older build's postings are bare seg_idxs, and the only text the reader
// holds then is meta.json's `english_head` — stage6's first 500 characters of
// the segment. A phrase that stands past that cut is missed on such a build;
// the alternative, fetching every candidate's whole book, was measured to pull
// most of the corpus for a phrase of common words, so the older shape keeps the
// older limit until the corpus is rebuilt.
export const ENGLISH_HEAD_LIMIT = 500;

function englishPhraseHits(
  idx: EngIndex,
  meta: SegMeta[],
  candidates: Set<number>,
  engTerms: string[],
): Set<number> {
  if (engHasPositions(idx)) {
    const starts = phraseStarts(idx, engTerms.map(t => [englishTerm(t)]), englishFold);
    return new Set([...starts.keys()].filter(si => candidates.has(si)));
  }
  const matches = compileEnglishPhrase(engTerms);
  return new Set([...candidates].filter(si => matches(meta[si].english_head)));
}

// -- Public search API ----------------------------------------------------

export type SearchMode = 'all' | 'any' | 'phrase';
export type LangOp = 'and' | 'or';

export interface SearchResult {
  work: string;           // which work this hit belongs to
  meta: SegMeta;
  grkMatch: boolean;
  engMatch: boolean;
  grkPositions: number[]; // token positions in the segment where a Greek term matched
  // Grammatical hits only, parallel to grkPositions: the values each position's
  // readings license for the queried categories, and whether every reading
  // agrees. `certain: false` must be shown as one-of-N, never asserted.
  grammar?: { values: Record<string, string[]>; certain: boolean }[];
}

// search() returns the hits PLUS any works whose index failed to load, so the
// UI can flag an incomplete result instead of presenting a partial search as
// exhaustive. `failedWorks` is empty on a fully successful search.
export interface SearchOutcome {
  results: SearchResult[];
  failedWorks: string[];  // work ids that could not be searched this run
  // Works whose chapter starts are known only to the Bekker line, reported ONLY
  // when the query actually leans on chapter geometry. The pipeline stamps each
  // bound exact or line-snapped; saying nothing here would let a chapter-scoped
  // result imply a precision the source does not have. Categories and De
  // Interpretatione declare chapters by Bekker line, so nearly every edge in
  // them is approximate.
  approximateChapters?: string[];
}

// Positions of a single term across segments: seg_idx → [token positions].
function termPositions(
  idx: GrkIndex,
  term: string,
  fold: (s: string) => string = greekFold,
): Map<number, number[]> {
  const m = new Map<number, number[]>();
  const add = (posts: [number, number][]) => {
    for (const [si, pos] of posts) {
      const arr = m.get(si);
      if (arr) arr.push(pos);
      else m.set(si, [pos]);
    }
  };
  const pattern = compilePattern(term, fold);
  if (!pattern) return m;
  if ('exact' in pattern) {
    add(idx[pattern.exact] ?? []);
  } else {
    for (const key of Object.keys(idx)) if (pattern.test(key)) add(idx[key]);
  }
  return m;
}

// For each segment in `hits`, the token positions to highlight in a KWIC snippet.
function greekPositions(
  idx: GrkIndex,
  terms: string[][],
  mode: SearchMode,
  hits: Set<number>,
): Map<number, number[]> {
  const out = new Map<number, number[]>();
  if (mode === 'phrase' && terms.length > 1) {
    for (const [si, starts] of phraseStarts(idx, terms)) {
      if (!hits.has(si)) continue;
      const ps: number[] = [];
      for (const s of starts) for (let j = 0; j < terms.length; j++) ps.push(s + j);
      out.set(si, ps);
    }
  } else {
    for (const t of terms.flat()) {
      for (const [si, ps] of termPositions(idx, t)) {
        if (!hits.has(si)) continue;
        const arr = out.get(si);
        if (arr) arr.push(...ps);
        else out.set(si, [...ps]);
      }
    }
  }
  for (const [si, ps] of out) out.set(si, [...new Set(ps)].sort((a, b) => a - b));
  return out;
}

// Search one work, returning hits tagged with that work.
async function searchWork(
  work: string,
  grkTerms: string[][],
  engTerms: string[],
  grkMode: SearchMode,
  engMode: SearchMode,
  langOp: LangOp,
  matchMode: MatchMode,
): Promise<SearchResult[]> {
  // Fetch only what this query needs: meta always; the lemma OR form Greek
  // index iff there are Greek terms; the English index iff there are English
  // terms. Kick them off together, then await.
  const metaP = loadIndex<SegMeta[]>(work, 'meta.json');
  const grkP: Promise<GrkIndex | null> = grkTerms.length
    ? loadIndex<GrkIndex>(work, matchMode === 'form' ? 'greek_form.json' : 'greek_lemma.json')
    : Promise.resolve(null);
  const engP: Promise<EngIndex | null> = engTerms.length
    ? loadIndex<EngIndex>(work, 'english.json')
    : Promise.resolve(null);
  const meta = await metaP;
  const grkIdx = await grkP;
  const engIdx = await engP;

  let grkHits: Set<number> | null = null;
  let engHits: Set<number> | null = null;

  if (grkTerms.length > 0 && grkIdx) {
    // Each term carries the keys it may match — one for a form search, the
    // headwords a typed inflection belongs to for a lemma one — so a term is
    // satisfied by ANY of its keys before the modes combine the terms.
    const postings = grkTerms.map(alts =>
      alts.map(t => grkPosting(grkIdx, t)).reduce(union));
    if (grkMode === 'any') {
      grkHits = postings.reduce(union);
    } else {
      grkHits = postings.reduce(intersect);
      if (grkMode === 'phrase' && grkTerms.length > 1) {
        // A phrase needs its words in order; each position may hold any of
        // the keys its term resolved to.
        grkHits = new Set(phraseStarts(grkIdx, grkTerms).keys());
      }
    }
  }

  if (engTerms.length > 0 && engIdx) {
    const postings = engTerms.map(t => engPosting(engIdx, t));
    if (engMode === 'any') {
      engHits = postings.reduce(union);
    } else {
      engHits = postings.reduce(intersect);
      if (engMode === 'phrase' && engTerms.length > 1) {
        engHits = englishPhraseHits(engIdx, meta, engHits, engTerms);
      }
    }
  }

  let combined: Set<number>;
  if (grkHits !== null && engHits !== null) {
    combined = langOp === 'and' ? intersect(grkHits, engHits) : union(grkHits, engHits);
  } else {
    combined = grkHits ?? engHits ?? new Set();
  }

  const grkPos = grkHits && grkIdx
    ? greekPositions(grkIdx, grkTerms, grkMode, grkHits)
    : new Map<number, number[]>();

  return [...combined]
    .sort((a, b) => a - b)
    .map(si => ({
      work,
      meta: meta[si],
      grkMatch: grkHits?.has(si) ?? false,
      engMatch: engHits?.has(si) ?? false,
      grkPositions: grkPos.get(si) ?? [],
    }));
}

// Turn a global offset into a citable position, using only offsets.json — the
// phrase browser shows hundreds of citations at once and must not have to fetch
// a whole book for each. line_runs exists for exactly this.
export interface OffsetRef { seg_idx: number; pos: number; book: number; column: string; line: number }

export function offsetRef(offsets: Offsets, global: number): OffsetRef | null {
  const base = offsets.seg_base_offset;
  if (!base.length || global < 0 || global >= offsets.token_count) return null;
  const [seg_idx, pos] = locate(base, global);
  const seg = offsets.segments[seg_idx];
  if (!seg) return null;
  let left = pos;
  for (const [line, count] of seg.line_runs) {
    if (left < count) return { seg_idx, pos, book: seg.book, column: seg.column, line };
    left -= count;
  }
  return null;
}

// -- Grammatical search ---------------------------------------------------
//
// A separate engine from the lexical one above, deliberately: it answers "which
// words are in the optative", not "where does this word occur". Combining the
// two in one query is combo search, which is a later piece of work.
//
// Honesty rules, applied here and rendered by the UI:
//   possible — at least one of a token's readings satisfies the query. That is
//              what a match means, and it is all a match ever claims.
//   certain  — every reading satisfies it AND each queried category has exactly
//              one licensed value. Anything else is one-of-N.
// A token whose sole analysis is "fem nom/voc sg" is NOT certain for case: one
// analysis record, two possible cases.

function readingSatisfies(reading: Reading, query: GrammarQuery): boolean {
  for (const category in query) {
    if (!reading[category]?.includes(query[category])) return false;
  }
  return true;
}

// Which signature ids satisfy the query, and how ambiguous each one is. The
// dictionary is small (a few thousand entries), so this is compiled once per
// work and the column scan then costs one lookup per token.
function compileQuery(dict: GrammarDict, query: GrammarQuery) {
  const matches = new Map<number, { values: Record<string, string[]>; certain: boolean }>();
  dict.sigs.forEach((readings, id) => {
    if (!readings.length || !readings.some(r => readingSatisfies(r, query))) return;
    const values: Record<string, string[]> = {};
    for (const category in query) {
      const licensed = new Set<string>();
      for (const reading of readings) for (const v of reading[category] ?? []) licensed.add(v);
      values[category] = [...licensed].sort();
    }
    const certain =
      readings.every(r => readingSatisfies(r, query)) &&
      Object.values(values).every(v => v.length === 1);
    matches.set(id, { values, certain });
  });
  return matches;
}

// Turn a global offset back into (seg_idx, token_pos).
function locate(base: number[], global: number): [number, number] {
  let lo = 0;
  let hi = base.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (base[mid] <= global) lo = mid;
    else hi = mid - 1;
  }
  return [lo, global - base[lo]];
}

async function grammarSearchWork(work: string, query: GrammarQuery): Promise<SearchResult[]> {
  const [meta, offsets, dict] = await Promise.all([
    loadIndex<SegMeta[]>(work, 'meta.json'),
    loadIndex<Offsets>(work, 'offsets.json'),
    loadIndex<GrammarDict>(work, 'grammar-dict.json'),
  ]);
  // The column is joined to the offsets by position alone, so a mismatched
  // token_count means the two files came from different builds — refuse rather
  // than silently report the wrong words.
  if (dict.token_count !== offsets.token_count) {
    throw new Error(`${work}: grammar/offsets built from different runs`);
  }
  const wanted = compileQuery(dict, query);
  if (!wanted.size) return [];

  const buffer = await loadBinary(work, 'grammar-col.bin');
  const column = dict.width === 4 ? new Uint32Array(buffer) : new Uint16Array(buffer);
  if (column.length !== offsets.token_count) {
    throw new Error(`${work}: grammar column length does not match token count`);
  }

  const bySeg = new Map<number, SearchResult>();
  for (let global = 0; global < column.length; global++) {
    const hit = wanted.get(column[global]);
    if (!hit) continue;
    const [si, pos] = locate(offsets.seg_base_offset, global);
    let result = bySeg.get(si);
    if (!result) {
      result = {
        work,
        meta: meta[si],
        grkMatch: true,
        engMatch: false,
        grkPositions: [],
        grammar: [],
      };
      bySeg.set(si, result);
    }
    result.grkPositions.push(pos);
    result.grammar!.push(hit);
  }
  return [...bySeg.keys()].sort((a, b) => a - b).map(si => bySeg.get(si)!);
}

// Grammatical search across one or more works. Same per-work failure tolerance
// as search(): a work whose index will not load is reported, not fatal.
export async function searchGrammar(
  query: GrammarQuery,
  works: string[],
): Promise<SearchOutcome> {
  if (!Object.keys(query).length || !works.length) {
    return { results: [], failedWorks: [] };
  }
  const failedWorks: string[] = [];
  const perWork = await pool(works, 8, async w => {
    try {
      return await grammarSearchWork(w, query);
    } catch (err) {
      console.warn(`searchGrammar: skipping ${w} —`, err);
      failedWorks.push(w);
      return [] as SearchResult[];
    }
  });
  if (failedWorks.length === works.length) {
    throw new Error('Could not load the grammar index — check your connection and try again.');
  }
  return { results: perWork.flat(), failedWorks };
}

// -- Inflected variants of a typed phrase ---------------------------------
//
// A reader who types τὸ τί ἦν εἶναι gets the places where those exact words
// stand. The same formula also appears as τῷ τί ἦν εἶναι and τοῦ τί ἦν εἶναι,
// which an exact phrase cannot reach — the surface string differs. Finding
// those means knowing that τό, τῷ and τοῦ all lemmatise to ὁ, which is exactly
// the knowledge a reader should not need. So widen it for them.
//
// Widening is a FAN-OUT, not a lookup: `hn` alone belongs to five headwords
// (ἐάν, εἰμί, ἠμί, ἤν, ὅς), so a four-word phrase can have several readings.
// Every reading is tried and their OFFSETS ARE UNIONED, never summed — in the
// Metaphysics the εἰμί and ἠμί readings hit exactly the same 67 tokens, being
// one passage under two parses, and adding them would report 135 results for
// 68 places.

// Above this many readings the fan-out is truncated rather than run, and the
// caller is told. A phrase of common ambiguous words could otherwise multiply
// out to thousands of index scans for nothing.
export const VARIANT_READING_CAP = 64;

export interface VariantOutcome extends SearchOutcome {
  readings: string[][];        // the lemma readings actually tried
  productive: string[][];      // those that matched anything
  cappedFrom: number;          // 0 unless the fan-out was truncated
}

/** The headwords each folded word can belong to, one list per word.
 *
 * `null` means the corpus map itself could not be loaded: there is nothing to
 * widen with, and a caller should fall back to matching what was typed rather
 * than report an empty corpus. A word the map does not record yields an empty
 * list, which callers read differently — the phrase search takes it as nothing
 * to widen, the phrase index falls back to that one word as typed.
 */
export async function lemmaOptions(folds: string[]): Promise<string[][] | null> {
  const perTerm: string[][] = [];
  for (const fold of folds) {
    const letter = /^[a-z]/.test(fold) ? fold[0] : '_';
    try {
      const shard = await loadShared<Record<string, string[]>>(`lemma-map/${letter}.json`);
      perTerm.push(shard[fold] ?? []);
    } catch {
      return null;
    }
  }
  return perTerm;
}

// The cartesian product of each term's headwords, in the order typed.
export function lemmaReadings(perTerm: string[][], cap: number): { readings: string[][]; total: number } {
  let total = 1;
  for (const options of perTerm) total *= Math.max(options.length, 1);
  let readings: string[][] = [[]];
  for (const options of perTerm) {
    const next: string[][] = [];
    for (const so_far of readings) {
      for (const option of options) {
        if (next.length >= cap) break;
        next.push([...so_far, option]);
      }
    }
    readings = next;
  }
  return { readings, total };
}

// Every place the phrase stands under ANY reading of its words.
export async function searchPhraseVariants(
  grkQuery: string,
  works: string[],
): Promise<VariantOutcome> {
  const terms = grkQuery.trim().split(/\s+/).filter(Boolean).map(t => t.replace(/^\*+/, ''));
  const empty: VariantOutcome = {
    results: [], failedWorks: [], readings: [], productive: [], cappedFrom: 0,
  };
  if (terms.length < 2 || !works.length) return empty;

  // Resolve each typed word to the headwords it can belong to.
  const folds = terms.map(t => greekFold(t));
  if (folds.some(f => !f)) return empty;
  const perTerm = await lemmaOptions(folds);
  if (!perTerm) return empty;   // without the map there is nothing to widen with
  if (perTerm.some(options => !options.length)) return empty;

  const { readings, total } = lemmaReadings(perTerm, VARIANT_READING_CAP);
  const cappedFrom = total > readings.length ? total : 0;

  const failedWorks: string[] = [];
  const productiveKeys = new Set<string>();
  const perWork = await pool(works, 8, async work => {
    try {
      const [meta, idx] = await Promise.all([
        loadIndex<SegMeta[]>(work, 'meta.json'),
        loadIndex<GrkIndex>(work, 'greek_lemma.json'),
      ]);
      // seg_idx -> the token positions any reading matched. A Set because two
      // readings routinely land on the same token.
      const bySeg = new Map<number, Set<number>>();
      for (const reading of readings) {
        const starts = phraseStarts(idx, reading.map(t => [t]));
        if (starts.size) productiveKeys.add(reading.join(' '));
        for (const [si, positions] of starts) {
          let seen = bySeg.get(si);
          if (!seen) { seen = new Set(); bySeg.set(si, seen); }
          for (const start of positions) {
            for (let k = 0; k < reading.length; k++) seen.add(start + k);
          }
        }
      }
      return [...bySeg.keys()].sort((a, b) => a - b).map(si => ({
        work,
        meta: meta[si],
        grkMatch: true,
        engMatch: false,
        grkPositions: [...bySeg.get(si)!].sort((a, b) => a - b),
      } as SearchResult));
    } catch (err) {
      console.warn(`searchPhraseVariants: skipping ${work} —`, err);
      failedWorks.push(work);
      return [] as SearchResult[];
    }
  });
  if (failedWorks.length === works.length) {
    throw new Error('Could not load the search index — check your connection and try again.');
  }
  return {
    results: perWork.flat(),
    failedWorks,
    readings,
    productive: readings.filter(r => productiveKeys.has(r.join(' '))),
    cappedFrom,
  };
}

// -- Combo search ---------------------------------------------------------
//
// Query-time, over the global offset. A query is a list of slots, each naming
// its own match type; a hit is a place where every slot lands within one
// proximity window. Distinct from the precomputed n-gram engine: combo answers
// "these terms, near each other", n-grams answer "what phrases recur".
//
// Boundary rule (shared with n-grams, not forked): a window NEVER spans a book
// edge. Chapters are a toggle, default keep — chapter divisions are editorial
// and an argument routinely runs across one.

export type SlotKind = 'phrase' | 'form' | 'lemma' | 'grammatical';

// Where a slot must fall relative to the FIRST slot — not to the slot before
// it. "before"/"after" answer the question a reader actually asks ("does the
// qualification come before the term or after it?"); chaining each slot to its
// predecessor instead is the whole-query `ordered` lock.
export type SlotRelation = 'near' | 'before' | 'after';

export interface ComboSlot {
  kind: SlotKind;
  // phrase: the token run, whitespace-separated. form: one surface token.
  // lemma: the fold keys the user ticked in the picker, unioned.
  terms?: string[];
  // grammatical only.
  query?: GrammarQuery;
  // Ignored on the first slot, which is what the others are placed against.
  relation?: SlotRelation;
}

export type WindowUnit = 'words' | 'line' | 'chapter';

export interface ComboOptions {
  window: number;          // words; ignored for the line/chapter units
  unit: WindowUnit;
  ordered: boolean;        // slots must appear in the order given
  crossChapter: boolean;   // default true — keep hits that straddle a chapter
}

// A slot's hits in one work, as global offsets. `span` is how many tokens the
// slot occupies (a phrase covers more than one), so an ordered query can
// require the next slot to start after this one ends.
interface SlotHit { start: number; span: number; certain: boolean; values?: Record<string, string[]> }

// The proximity default: 5 words, which is roughly half a Bekker line (the
// corpus averages 9.5 tokens per line). Capped at 50 — about five lines — since
// past that "near" stops meaning anything.
export const COMBO_WINDOW_DEFAULT = 5;
export const COMBO_WINDOW_MAX = 50;

function slotHits(
  slot: ComboSlot,
  base: number[],
  lemmaIdx: GrkIndex | null,
  formIdx: GrkIndex | null,
  dict: GrammarDict | null,
  column: Uint16Array | Uint32Array | null,
): SlotHit[] {
  const out: SlotHit[] = [];
  if (slot.kind === 'grammatical') {
    if (!dict || !column || !slot.query) return out;
    const wanted = compileQuery(dict, slot.query);
    if (!wanted.size) return out;
    for (let g = 0; g < column.length; g++) {
      const hit = wanted.get(column[g]);
      if (hit) out.push({ start: g, span: 1, certain: hit.certain, values: hit.values });
    }
    return out;
  }

  const terms = slot.terms ?? [];
  if (!terms.length) return out;
  // A lemma slot carries the exact heads the user ticked, so its terms are
  // unioned; a form or phrase slot is a single sequence.
  const idx = slot.kind === 'lemma' ? lemmaIdx : formIdx;
  if (!idx) return out;

  if (slot.kind === 'phrase' && terms.length > 1) {
    for (const [si, starts] of phraseStarts(idx, terms.map(t => [t]))) {
      for (const p of starts) out.push({ start: base[si] + p, span: terms.length, certain: true });
    }
    return out;
  }
  for (const term of terms) {
    for (const [si, positions] of termPositions(idx, term)) {
      for (const p of positions) out.push({ start: base[si] + p, span: 1, certain: true });
    }
  }
  return out;
}

// The structural unit an offset falls in, as a half-open [start, end) range of
// global offsets. Bounds are sorted, so this is a binary search over a short
// array. Used for the line/chapter window units and the book-edge rule.
function unitRange(starts: number[], global: number, total: number): [number, number] {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= global) lo = mid;
    else hi = mid - 1;
  }
  return [starts[lo], lo + 1 < starts.length ? starts[lo + 1] : total];
}

// First index in a sorted hit list whose start is >= target.
function lowerBound(hits: SlotHit[], target: number): number {
  let lo = 0;
  let hi = hits.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (hits[mid].start < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// Flatten the per-segment line runs into one array of line-start offsets, so a
// same-line window is the same kind of lookup as same-chapter.
function lineStarts(offsets: Offsets): number[] {
  const out: number[] = [];
  offsets.segments.forEach((seg, i) => {
    let at = offsets.seg_base_offset[i];
    for (const [, count] of seg.line_runs) { out.push(at); at += count; }
  });
  return out;
}

export interface ComboHit {
  work: string;
  seg_idx: number;
  pos: number;             // token position of the leftmost slot, within its segment
  global: number;
  positions: number[];     // every matched token position in that segment
  certain: boolean;        // false if ANY slot rested on an ambiguous parse
  values?: Record<string, string[]>;
}

// Given each slot's hits, find every window where all slots co-occur.
//
// Anchors on the FIRST slot's hits and, for each, asks whether every other slot
// has a hit in range. That is O(hits) with a sorted scan per slot rather than a
// cross-product, and it makes the ordered case a simple forward walk.
export function comboWindows(
  perSlot: SlotHit[][],
  opts: ComboOptions,
  offsets: Offsets,
  relations: SlotRelation[] = [],
  // Two slots sharing an identity are the same query asked twice, so they may
  // not both be satisfied by one token. Empty string means "no constraint".
  identities: string[] = [],
): { start: number; end: number; hits: SlotHit[] }[] {
  if (!perSlot.length || perSlot.some(h => !h.length)) return [];
  const sorted = perSlot.map(h => [...h].sort((a, b) => a.start - b.start));
  const total = offsets.token_count;
  const bookStarts = offsets.book_bounds.map(b => b.start);
  const chapStarts = offsets.chapter_bounds.map(c => c.start);
  const lines = opts.unit === 'line' ? lineStarts(offsets) : null;

  // The offsets an anchor's partners may occupy: the structural unit the anchor
  // sits in, intersected with the word window. Computed once per anchor, so each
  // slot is then a binary search rather than a scan — which would be quadratic
  // on a grammatical slot holding tens of thousands of hits.
  //
  // The word window is measured over the WHOLE match, not outward from the
  // anchor. Measuring from the anchor would make an unordered query depend on
  // which slot happened to be listed first (with W=5 and hits at 0, 5 and 10,
  // anchoring on 0 rejects and anchoring on 5 accepts) and would quietly admit
  // a span of 2W. A window of W now means every slot lands within W tokens of
  // every other, whatever order the slots were typed in.
  const structural = (at: number): [number, number] => {
    let lo = 0;
    let hi = total;
    const clamp = ([s, e]: [number, number]) => { if (s > lo) lo = s; if (e < hi) hi = e; };
    clamp(unitRange(bookStarts, at, total));                       // never cross a book
    if (!opts.crossChapter && chapStarts.length) clamp(unitRange(chapStarts, at, total));
    if (opts.unit === 'line' && lines) clamp(unitRange(lines, at, total));
    if (opts.unit === 'chapter' && chapStarts.length) clamp(unitRange(chapStarts, at, total));
    return [lo, hi];
  };

  const out: { start: number; end: number; hits: SlotHit[] }[] = [];
  for (const anchor of sorted[0]) {
    const [unitLo, unitHi] = structural(anchor.start);
    if (anchor.start + anchor.span > unitHi) continue;   // the anchor's own run must fit

    // Everything each slot could contribute for THIS anchor: inside the unit,
    // inside the word window, and on the side its relation requires.
    const reach = opts.unit === 'words' ? opts.window : total;
    const lo = Math.max(unitLo, anchor.start - reach);
    const hi = Math.min(unitHi, anchor.start + reach + 1);
    const feasible: SlotHit[][] = [[anchor]];
    let possible = true;
    for (let s = 1; s < sorted.length && possible; s++) {
      const relation = relations[s] ?? 'near';
      const from = relation === 'after' ? Math.max(lo, anchor.start + anchor.span) : lo;
      const to = relation === 'before' ? Math.min(hi, anchor.start + 1) : hi;
      const picks: SlotHit[] = [];
      for (let i = lowerBound(sorted[s], from); i < sorted[s].length; i++) {
        const h = sorted[s][i];
        if (h.start >= to) break;
        if (h.start + h.span > unitHi) continue;
        // "before" is measured by the END of the run, so a phrase only counts
        // as preceding when the whole run finishes first.
        if (relation === 'before' && h.start + h.span > anchor.start) continue;
        picks.push(h);
      }
      if (!picks.length) possible = false;
      else feasible.push(picks);
    }
    if (!possible) continue;

    // A window of W means every slot lands within W of every other, so the
    // group must fit in some span [s, s+W] that contains the anchor. Taking the
    // earliest feasible hit per slot is NOT sufficient: choosing an early
    // partner can push the far end out of reach when a later one would have
    // fitted. So try each candidate start rather than committing greedily.
    const starts = new Set<number>([anchor.start]);
    for (const picks of feasible) for (const h of picks) {
      if (h.start <= anchor.start) starts.add(h.start);
    }
    let chosen: SlotHit[] | null = null;
    for (const s0 of [...starts].sort((a, b) => a - b)) {
      if (opts.unit === 'words' && anchor.start - s0 > opts.window) continue;
      const limit = opts.unit === 'words' ? s0 + opts.window : unitHi;
      const take: SlotHit[] = [anchor];
      let cursor = anchor.start + anchor.span;   // for the whole-query order lock
      let ok = true;
      // One token may satisfy two DIFFERENT slots — "λόγος in the nominative"
      // is a lemma slot and a grammatical slot landing on the same word, and is
      // the most useful combo query there is. But two IDENTICAL slots asking
      // the same thing want two occurrences, not one word counted twice.
      const used = new Map<string, Set<number>>();
      const claim = (s: number, at: number): boolean => {
        const id = identities[s];
        if (!id) return true;
        let taken = used.get(id);
        if (!taken) { taken = new Set(); used.set(id, taken); }
        if (taken.has(at)) return false;
        taken.add(at);
        return true;
      };
      claim(0, anchor.start);
      for (let s = 1; s < feasible.length; s++) {
        const relation = relations[s] ?? 'near';
        const from = opts.ordered ? Math.max(s0, cursor) : s0;
        // "before" wants the nearest preceding run; everything else the
        // earliest, which also chains correctly when the order lock is on.
        const window = feasible[s].filter(h => h.start >= from && h.start <= limit);
        const ordered = relation === 'before' ? [...window].reverse() : window;
        const pick = ordered.find(h => claim(s, h.start));
        if (!pick) { ok = false; break; }
        take.push(pick);
        cursor = pick.start + pick.span;
      }
      if (ok) { chosen = take; break; }
    }
    if (!chosen) continue;
    out.push({
      start: Math.min(...chosen.map(h => h.start)),
      end: Math.max(...chosen.map(h => h.start + h.span - 1)),
      hits: chosen,
    });
  }
  return out;
}

async function comboSearchWork(
  work: string,
  slots: ComboSlot[],
  opts: ComboOptions,
): Promise<SearchResult[]> {
  const needLemma = slots.some(s => s.kind === 'lemma');
  const needForm = slots.some(s => s.kind === 'form' || s.kind === 'phrase');
  const needGrammar = slots.some(s => s.kind === 'grammatical');

  const [meta, offsets, lemmaIdx, formIdx, dict] = await Promise.all([
    loadIndex<SegMeta[]>(work, 'meta.json'),
    loadIndex<Offsets>(work, 'offsets.json'),
    needLemma ? loadIndex<GrkIndex>(work, 'greek_lemma.json') : Promise.resolve(null),
    needForm ? loadIndex<GrkIndex>(work, 'greek_form.json') : Promise.resolve(null),
    needGrammar ? loadIndex<GrammarDict>(work, 'grammar-dict.json') : Promise.resolve(null),
  ]);
  let column: Uint16Array | Uint32Array | null = null;
  if (dict) {
    if (dict.token_count !== offsets.token_count) {
      throw new Error(`${work}: grammar/offsets built from different runs`);
    }
    const buffer = await loadBinary(work, 'grammar-col.bin');
    column = dict.width === 4 ? new Uint32Array(buffer) : new Uint16Array(buffer);
    // A short column would silently drop every grammatical hit past its end and
    // still report a complete result, so check it here as well as in
    // grammarSearchWork.
    if (column.length !== offsets.token_count) {
      throw new Error(`${work}: grammar column length does not match token count`);
    }
  }

  const base = offsets.seg_base_offset;
  const perSlot = slots.map(s => slotHits(s, base, lemmaIdx, formIdx, dict, column));
  // Two slots are the same slot when they ask the same thing, whatever order
  // the reader ticked or typed it in: a lemma slot's heads are unioned, so
  // their order carries nothing; a phrase is a run, so its order is the
  // question. A grammatical query's categories are a set.
  const slotIds = slots.map(s => JSON.stringify([
    s.kind,
    s.terms ? (s.kind === 'phrase' ? s.terms : [...s.terms].sort()) : null,
    s.query ? Object.fromEntries(Object.entries(s.query).sort(([a], [b]) => a.localeCompare(b))) : null,
  ]));
  const duplicated = new Set(slotIds.filter((id, i) => slotIds.indexOf(id) !== i));
  const windows = comboWindows(
    perSlot, opts, offsets,
    slots.map(s => s.relation ?? 'near'),
    slotIds.map(id => (duplicated.has(id) ? id : '')),
  );

  const bySeg = new Map<number, SearchResult>();
  const seenBySeg = new Map<number, Set<number>>();
  const resultFor = (si: number): SearchResult => {
    let r = bySeg.get(si);
    if (!r) {
      r = { work, meta: meta[si], grkMatch: true, engMatch: false, grkPositions: [], grammar: [] };
      bySeg.set(si, r);
      seenBySeg.set(si, new Set());
    }
    return r;
  };
  for (const w of windows) {
    // Report every matched token so the KWIC marks all of them. Ambiguity is
    // recorded PER SLOT, not per window: a lexically matched word is certain
    // whatever its neighbour's parse allows, and labelling it with the other
    // slot's alternatives would attribute morphology to the wrong word. Merging
    // the two slots' values would be worse still — a second grammatical slot
    // would overwrite the first's alternatives and hide the very ambiguity that
    // made the hit uncertain.
    for (const h of w.hits) {
      for (let k = 0; k < h.span; k++) {
        const [hs, hp] = locate(base, h.start + k);
        // A window can straddle a column boundary — segments are keyed
        // (book, column), and a book edge is the only thing a window may not
        // cross. Mark the token in whichever segment it actually falls in, so
        // both halves of the passage are shown; dropping the far half used to
        // leave the reader looking at a hit with a term missing.
        const result = resultFor(hs);
        const seen = seenBySeg.get(hs)!;
        if (seen.has(hp)) continue;
        seen.add(hp);
        result.grkPositions.push(hp);
        result.grammar!.push({ values: h.values ?? {}, certain: h.certain });
      }
    }
  }
  for (const r of bySeg.values()) {
    const order = r.grkPositions.map((p, i) => [p, i] as const).sort((a, b) => a[0] - b[0]);
    r.grkPositions = order.map(([p]) => p);
    r.grammar = order.map(([, i]) => r.grammar![i]);
  }
  return [...bySeg.keys()].sort((a, b) => a - b).map(si => bySeg.get(si)!);
}

// Combo search across one or more works.
export async function searchCombo(
  slots: ComboSlot[],
  opts: ComboOptions,
  works: string[],
): Promise<SearchOutcome> {
  const usable = slots.filter(s =>
    s.kind === 'grammatical' ? Object.keys(s.query ?? {}).length : (s.terms ?? []).length);
  if (usable.length < 2 || !works.length) return { results: [], failedWorks: [] };

  const bounded: ComboOptions = {
    ...opts,
    window: Math.max(1, Math.min(opts.window || COMBO_WINDOW_DEFAULT, COMBO_WINDOW_MAX)),
  };
  const failedWorks: string[] = [];
  const perWork = await pool(works, 8, async w => {
    try {
      return await comboSearchWork(w, usable, bounded);
    } catch (err) {
      console.warn(`searchCombo: skipping ${w} —`, err);
      failedWorks.push(w);
      return [] as SearchResult[];
    }
  });
  if (failedWorks.length === works.length) {
    throw new Error('Could not load the search index — check your connection and try again.');
  }

  // Only worth saying when the answer depends on where a chapter begins.
  const approximateChapters: string[] = [];
  if (bounded.unit === 'chapter' || !bounded.crossChapter) {
    for (const w of works) {
      if (failedWorks.includes(w)) continue;
      try {
        const offsets = await loadIndex<Offsets>(w, 'offsets.json');   // already cached
        if (offsets.chapter_bounds.some(c => c.accuracy !== 'exact' && c.start !== 0)) {
          approximateChapters.push(w);
        }
      } catch { /* a work that failed to load is already reported */ }
    }
  }
  return { results: perWork.flat(), failedWorks, approximateChapters };
}

/** The headwords each typed word can belong to, for a lemma search.
 *
 * A lemma index is keyed on dictionary forms, so matching the typed word
 * against it directly only works when the reader already typed the dictionary
 * form — the one form the text in front of them is least likely to show. Typing
 * lo/gou found nothing while lo/gos found 2,269 of the same word. The corpus
 * lemma map turns the inflection into its headwords, so the reader can type
 * what stands on the page.
 *
 * The typed fold is kept alongside the headwords: a reader who does know the
 * dictionary form must never come off worse, and a word absent from the map
 * still searches as itself. Wildcards are left alone — they are patterns over
 * index keys, not surface words to resolve.
 */
async function resolveHeadwords(terms: string[]): Promise<string[][]> {
  return Promise.all(terms.map(async term => {
    if (/[*?]/.test(term)) return [term];
    const fold = greekFold(term);
    if (!fold) return [term];
    const letter = /^[a-z]/.test(fold) ? fold[0] : '_';
    try {
      const shard = await loadShared<Record<string, string[]>>(`lemma-map/${letter}.json`);
      const heads = shard[fold];
      return heads?.length ? [...new Set([fold, ...heads])] : [term];
    } catch {
      return [term];   // without the map, behave exactly as before
    }
  }));
}

// Unified search across one or more works. `matchMode` chooses the Greek index
// (lemma = all forms of a headword, form = the exact inflected token).
export async function search(
  grkQuery: string,
  engQuery: string,
  grkMode: SearchMode,
  engMode: SearchMode,
  langOp: LangOp,
  works: string[],
  matchMode: MatchMode = 'lemma',
): Promise<SearchOutcome> {
  if (!grkQuery.trim() && !engQuery.trim()) return { results: [], failedWorks: [] };
  if (!works.length) return { results: [], failedWorks: [] };

  const typedGrk = grkQuery.trim().split(/\s+/).filter(Boolean);
  const grkTerms = matchMode === 'lemma'
    ? await resolveHeadwords(typedGrk)
    : typedGrk.map(t => [t]);
  const engTerms = engQuery.trim().split(/\s+/).filter(Boolean);

  // Bound how many works load at once, and let a single work's failed index
  // load drop just that work (logged + reported) instead of rejecting the whole
  // search.
  const failedWorks: string[] = [];
  const perWork = await pool(works, 8, async w => {
    try {
      return await searchWork(w, grkTerms, engTerms, grkMode, engMode, langOp, matchMode);
    } catch (err) {
      console.warn(`search: skipping ${w} —`, err);
      failedWorks.push(w);
      return [] as SearchResult[];
    }
  });
  // If EVERY work failed to load (e.g. offline, or a transient window mid-deploy
  // when the index JSONs are briefly unavailable), surface it as an error to
  // retry — not as an empty result that reads as a misleading "No passages
  // found." A partial failure returns what loaded PLUS the list of works that
  // didn't, so the caller can tell the user the results are incomplete rather
  // than presenting them as exhaustive.
  if (failedWorks.length === works.length) {
    throw new Error('Could not load the search index — check your connection and try again.');
  }
  return { results: perWork.flat(), failedWorks };
}
