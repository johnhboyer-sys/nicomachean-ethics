// Data-fetch helpers. All paths relative to /data (public symlink to
// build/dist/ne). Shards are cached in module-level Maps so a single
// click won't re-fetch the same shard twice in a session.
import { linkifyGlossaryRefs } from './glossary';

export interface Token {
  t: string;   // surface form (Unicode Greek)
  o: number;   // char offset in the line
  k: string;   // Beta Code key
}

export interface GreekLine {
  n: number;
  text: string;
  joined?: boolean;
  tokens: Token[];
  // Table row: present when the Greek line is part of an inline table (the TLG
  // ⎪ column divider, e.g. the De Int 22a modal square). Each cell carries its
  // own text + clickable tokens (offsets rebased to the cell).
  cells?: { text: string; tokens: Token[] }[];
}

export interface EnglishChunk {
  text: string;
  notes: { offset: number; text: string }[];
  markers: { kind: string; n: string; offset: number }[];
  // Bekker line ticks for the English gutter; `real` = a true TEI milestone
  // (column start / ~line 20), otherwise a proportional estimate.
  bekker?: { n: number; offset: number; real: boolean }[];
}

export interface ChapterStart {
  chapter: string;
  beforeLine: number;  // insert the heading before the Greek line with this n
  wordIndex: number;   // word index within that line where the chapter begins
                       // (>0 means the chapter starts mid-line → split the line)
  engOffset: number;   // char offset in the English chunk where the chapter begins
  bekker: string;      // Bekker span, e.g. "1097a–1098b" (single column if equal)
}

// A slice of an overlay translation paired to a chapter block in this column.
// `cont` = the tail of a chapter that began in an earlier column. An overlay is
// chapter-anchored (no per-line Bekker gutter), distributed across columns.
export interface OverlayPiece {
  chapter: string;
  text: string;
  cont: boolean;
  // Interpolated Bekker-line ticks down this slice (all estimates — an overlay
  // has no milestones of its own). Same shape as EnglishChunk.bekker.
  bekker?: { n: number; offset: number; real: boolean }[];
  // Structured diagram tables (e.g. Ackrill's squares of opposition), each
  // anchored to the Bekker line `n` of the segment it belongs to; rendered as a
  // grid after that segment's row.
  tables?: { n: number; rows: string[][] }[];
}

export interface Segment {
  id: string;
  column: string;
  greek: GreekLine[];
  english: EnglishChunk | null;
  chapterStarts?: ChapterStart[];
  // The secondary chapter-anchored translation. `ross` is the pre-rename
  // emitted name — stage7_emit still writes it, so both are declared until the
  // corpus is rebuilt; read via `secondary ?? ross`.
  secondary?: OverlayPiece[];
  /** @deprecated legacy emitted name for `secondary`; drop after a corpus rebuild. */
  ross?: OverlayPiece[];
  // Optional third translation (same overlay shape), e.g. Categories'
  // Ackrill beside Edghill + Taylor. Absent in works with fewer translations.
  third?: OverlayPiece[];
  // Any further overlay translations (the 4th onward), keyed by translation id.
  // Same overlay shape as secondary/third. Lets a work carry an unbounded number
  // of chapter-anchored translations beyond the fixed secondary/third slots.
  overlays?: Record<string, OverlayPiece[]>;
}

export interface ChapterRef {
  chapter: string;
  column: string;
  line: string;
  bekker: string;
}

export interface BookData {
  book: number;
  segments: Segment[];
}

export interface Analysis {
  lemma: string;   // Beta Code
  gloss: string;
  parse: string;
  lsj: string[];   // LSJ key(s)
}

export interface LsjEntry {
  key: string;
  head: string;    // Unicode Greek
  html: string;
}

// Honour Astro's base path so data fetches work under a project Pages site as
// well as at the root. BASE_URL may or may not carry a trailing slash, so strip
// it and join explicitly. Each work's data lives under /data/<work>/.
// A non-Astro host (the desktop app) can point the whole data layer somewhere
// else — e.g. a Tauri asset:// URL for an on-disk corpus directory — by setting
// globalThis.__ARISTOTLE_DATA_ROOT__ before any fetch helper runs. Read lazily
// so the override wins regardless of module-import order.
const DEFAULT_ROOT = `${import.meta.env.BASE_URL.replace(/\/$/, '')}/data`;
const ROOT = () =>
  (globalThis as { __ARISTOTLE_DATA_ROOT__?: string }).__ARISTOTLE_DATA_ROOT__ ?? DEFAULT_ROOT;
const workBase = (work: string) => `${ROOT()}/${work}`;

// All caches are keyed by work so two works loaded in one session (e.g. unified
// search) never collide.
const _analysesCache = new Map<string, Promise<Record<string, Analysis[]>>>();
const _lsjCache = new Map<string, Record<string, LsjEntry>>();
const _bookCache = new Map<string, Promise<BookData>>();
const _chaptersCache = new Map<string, Promise<Record<string, ChapterRef[]>>>();
const _columnsCache = new Map<string, Promise<Record<string, ColumnRef[]>>>();
const _footnotesCache = new Map<string, Promise<Record<string, string>>>();

export function fetchBook(work: string, n: number): Promise<BookData> {
  const key = `${work}:${n}`;
  const cached = _bookCache.get(key);
  if (cached) return cached;
  const p = fetch(`${workBase(work)}/book-${String(n).padStart(2, '0')}.json`).then(r => {
    if (!r.ok) throw new Error(`${work} book ${n}: ${r.status}`);
    return r.json();
  }).then((d: BookData) => {
    // A non-Astro host (the desktop app) can overlay runtime content — e.g.
    // user-imported translations merged into seg.overlays — via this hook.
    // The site never sets it; the fetched data passes through untouched.
    const hook = (globalThis as {
      __ARISTOTLE_BOOK_HOOK__?: (work: string, n: number, data: BookData) => BookData;
    }).__ARISTOTLE_BOOK_HOOK__;
    return hook ? hook(work, n, d) : d;
  });
  // Evict a rejected fetch so it can be retried (don't cache the failure).
  p.catch(() => { if (_bookCache.get(key) === p) _bookCache.delete(key); });
  _bookCache.set(key, p);
  return p;
}

/**
 * Drop cached book data so the next fetchBook re-fetches and re-runs
 * __ARISTOTLE_BOOK_HOOK__. The desktop app calls this after a translation
 * import (imports.ts's overlays are merged into the fetched BookData by the
 * hook, which only runs at fetch time — a book already loaded before the
 * import keeps its pre-import segments until its cached promise is dropped).
 * Pass a book number to evict one book, or omit to evict every book of the
 * work. Inert on the site build, which never imports it.
 */
export function invalidateBookCache(work: string, n?: number): void {
  if (n !== undefined) {
    _bookCache.delete(`${work}:${n}`);
    return;
  }
  for (const key of [..._bookCache.keys()]) {
    if (key.startsWith(`${work}:`)) _bookCache.delete(key);
  }
}

export function fetchChapters(work: string): Promise<Record<string, ChapterRef[]>> {
  const cached = _chaptersCache.get(work);
  if (cached) return cached;
  const p = fetch(`${workBase(work)}/chapters.json`).then(r => {
    if (!r.ok) throw new Error(`${work} chapters: ${r.status}`);
    return r.json();
  });
  // Evict a rejected fetch so it can be retried (don't cache the failure).
  p.catch(() => { if (_chaptersCache.get(work) === p) _chaptersCache.delete(work); });
  _chaptersCache.set(work, p);
  return p;
}

// Translator footnotes for a work: { footnote number -> pre-rendered HTML }.
// Present only for works whose translation carries notes (NE Ostwald). Loaded
// lazily the first time a `[^N]` marker is clicked, then cached for the session.
export function fetchFootnotes(work: string): Promise<Record<string, string>> {
  const cached = _footnotesCache.get(work);
  if (cached) return cached;
  const p = fetch(`${workBase(work)}/footnotes.json`).then(r => {
    if (!r.ok) throw new Error(`${work} footnotes: ${r.status}`);
    return r.json();
  }).then((map: Record<string, string>) =>
    // The NE (Ostwald) footnotes reference glossary entries ("see Glossary,
    // <term>"); turn those into links to the standalone glossary page.
    work === 'EN'
      ? Object.fromEntries(Object.entries(map).map(([k, v]) => [k, linkifyGlossaryRefs(v)]))
      : map
  );
  // Evict a rejected fetch so it can be retried (don't cache the failure).
  p.catch(() => { if (_footnotesCache.get(work) === p) _footnotesCache.delete(work); });
  _footnotesCache.set(work, p);
  return p;
}

// Analytical sidenotes for a work: { sidenote number -> text }. Present only for
// works whose translation carries marginal notes (the Isagoge's Owen). Loaded
// lazily and cached for the session.
const _sidenotesCache = new Map<string, Promise<Record<string, string>>>();
export function fetchSidenotes(work: string): Promise<Record<string, string>> {
  const cached = _sidenotesCache.get(work);
  if (cached) return cached;
  const p = fetch(`${workBase(work)}/sidenotes.json`).then(r => {
    if (!r.ok) throw new Error(`${work} sidenotes: ${r.status}`);
    return r.json();
  });
  p.catch(() => { if (_sidenotesCache.get(work) === p) _sidenotesCache.delete(work); });
  _sidenotesCache.set(work, p);
  return p;
}

// Diagrams for a work: { figure number -> pre-rendered HTML <figure> }. Present
// only for works that carry [[figN]] markers (the Isagoge's Tree of Porphyry).
const _figuresCache = new Map<string, Promise<Record<string, string>>>();
export function fetchFigures(work: string): Promise<Record<string, string>> {
  const cached = _figuresCache.get(work);
  if (cached) return cached;
  const p = fetch(`${workBase(work)}/figures.json`).then(r => {
    if (!r.ok) throw new Error(`${work} figures: ${r.status}`);
    return r.json();
  });
  p.catch(() => { if (_figuresCache.get(work) === p) _figuresCache.delete(work); });
  _figuresCache.set(work, p);
  return p;
}

// Bekker column -> owning book(s) with each book's line span in that column.
export interface ColumnRef { book: number; lo: number; hi: number; }

export function fetchColumns(work: string): Promise<Record<string, ColumnRef[]>> {
  const cached = _columnsCache.get(work);
  if (cached) return cached;
  const p = fetch(`${workBase(work)}/columns.json`).then(r => {
    if (!r.ok) throw new Error(`${work} columns: ${r.status}`);
    return r.json();
  });
  // Evict a failure so the next jump can retry, as every other fetcher here does.
  p.catch(() => { if (_columnsCache.get(work) === p) _columnsCache.delete(work); });
  _columnsCache.set(work, p);
  return p;
}

// One work's claim on a Bekker column, from the corpus-wide index.
export interface BekkerRef { work: string; book: number; lo: number; hi: number; }

// bekker.json is written as tuples — [work, book, lo, hi] — to keep the
// corpus-wide index small enough to fetch on the first keystroke that looks
// like a citation. Built by scripts/build-bekker-index.mjs.
type BekkerTuple = [string, number, number, number];

let _bekkerCache: Promise<Record<string, BekkerRef[]>> | null = null;

// Every Bekker column in the corpus → the works and books that carry it. Used
// by the ⌘K palette to jump to a citation from anywhere on the site.
export function fetchBekkerIndex(): Promise<Record<string, BekkerRef[]>> {
  if (_bekkerCache) return _bekkerCache;
  // Throw on a bad response rather than resolving to {}: resolving would make
  // a 404 look like an empty index, the catch below would never fire, and no
  // citation could be jumped to for the rest of the session (the same trap
  // fetchLsjHeads documents).
  const p = fetch(`${ROOT()}/bekker.json`)
    .then(r => {
      if (!r.ok) throw new Error(`bekker.json: ${r.status}`);
      return r.json();
    })
    .then((raw: Record<string, BekkerTuple[]>) => {
      const out: Record<string, BekkerRef[]> = {};
      for (const [column, entries] of Object.entries(raw)) {
        out[column] = entries.map(([work, book, lo, hi]) => ({ work, book, lo, hi }));
      }
      return out;
    });
  // A missing index just means no citation jumps — don't cache the failure.
  p.catch(() => { if (_bekkerCache === p) _bekkerCache = null; });
  _bekkerCache = p;
  return p;
}

// Parse a raw Bekker citation (e.g. "1097a15", "1097a 15", "1097a.15") into
// its column ("1097a") and line (15). Returns null if it isn't a citation.
// The page can be one digit: the Categories run 1a–15b and De Interpretatione
// 16a–24b, so "16a5" is a citation as much as "1097a15" is.
export function parseBekker(raw: string): { column: string; line: number } | null {
  const m = raw.trim().toLowerCase().replace(/\s+/g, '').match(/^(\d{1,4})([ab])\.?(\d+)$/);
  if (!m) return null;
  return { column: m[1] + m[2], line: Number(m[3]) };
}

// Resolve a parsed citation to the book that owns it. For a column shared by
// two books (a book that starts mid-column) the line picks the right one,
// snapping to the nearer book if the line falls in the gap between them.
export function resolveBekker(
  columns: Record<string, ColumnRef[]>,
  column: string,
  line: number,
): number | null {
  const entries = columns[column];
  if (!entries || entries.length === 0) return null;
  if (entries.length === 1) return entries[0].book;
  let best = entries[0];
  let bestDist = Infinity;
  for (const e of entries) {
    const d = line < e.lo ? e.lo - line : line > e.hi ? line - e.hi : 0;
    if (d < bestDist) { bestDist = d; best = e; }
  }
  return best.book;
}

export function fetchAnalyses(work: string): Promise<Record<string, Analysis[]>> {
  const cached = _analysesCache.get(work);
  if (cached) return cached;
  const p = fetch(`${workBase(work)}/analyses.json`).then(r => {
    if (!r.ok) throw new Error(`${work} analyses: ${r.status}`);
    return r.json();
  });
  // Evict a failure: a rejected promise left here would make every later word
  // tap in this work rethrow it for the whole session.
  p.catch(() => { if (_analysesCache.get(work) === p) _analysesCache.delete(work); });
  _analysesCache.set(work, p);
  return p;
}

// The lemma-page manifest: LSJ key -> { slug, head, count } for every lemma that
// has a /lemma/<slug> reference page (produced by scripts/build-lemmata.mjs).
// The word popup loads it once to decide whether to offer a "see all N
// occurrences" link, and only for lemmata that actually have a page.
export interface LemmaRef { slug: string; head: string; count: number; distinctiveness_label?: string; }
let _lemmataCache: Promise<Record<string, LemmaRef>> | null = null;
export function fetchLemmata(): Promise<Record<string, LemmaRef>> {
  if (_lemmataCache) return _lemmataCache;
  const p = fetch(`${ROOT()}/lemmata.json`).then(r => {
    if (!r.ok) throw new Error(`lemmata.json: ${r.status}`);
    return r.json();
  });
  // A missing/failed manifest just means no lemma links (every caller catches)
  // — don't cache the failure. It has to be a rejection for that to work: a
  // {} resolved on a 404 would be cached as an empty manifest for the session.
  p.catch(() => { if (_lemmataCache === p) _lemmataCache = null; });
  _lemmataCache = p;
  return p;
}

// Curated quotation citations for a work: [{ column, lo, hi, cite, author, url,
// attestation }, …]. Present only for works that have a quotations.json (the
// Metaphysics pilot today). Missing file → empty list, never a throw — works
// without the feature ship nothing. Pattern matches fetchLemmata, not
// fetchColumns/fetchFootnotes (those throw on a missing file).
export interface Quotation {
  column: string;
  lo: number;
  hi: number;
  cite: string;
  author: string;
  url: string;
  attestation: string;
}
const _quotationsCache = new Map<string, Promise<Quotation[]>>();
export function fetchQuotations(work: string): Promise<Quotation[]> {
  const cached = _quotationsCache.get(work);
  if (cached) return cached;
  const p = fetch(`${workBase(work)}/quotations.json`).then(r => (r.ok ? r.json() : []));
  p.catch(() => { if (_quotationsCache.get(work) === p) _quotationsCache.delete(work); });
  _quotationsCache.set(work, p);
  return p;
}

// The combo-search lemma picker: fold key -> the headwords a lemma slot can
// match, commonest first. Sharded by fold-initial letter like the LSJ, so
// typing into the picker fetches one small file rather than the whole
// vocabulary. Covers every key in greek_lemma.json by construction; the few
// with no resolvable headword arrive with an empty list and are shown under
// their fold key. `slug` is present only where the lemma has a reference page,
// which is where a gloss can be fetched from on demand.
export interface LemmaCandidate { h: string; k: string; s?: string; }
// `n` belongs to the fold key, not to any one headword: the index is
// accent-folded, so several headwords can share a key that no search can split,
// and the count a user is shown must be the one their search returns.
export interface LemmaChoice { n: number; c: LemmaCandidate[]; }
const _pickerCache = new Map<string, Promise<Record<string, LemmaChoice>>>();
export function fetchLemmaPickerShard(letter: string): Promise<Record<string, LemmaChoice>> {
  const cached = _pickerCache.get(letter);
  if (cached) return cached;
  // Reject rather than resolving empty on a failed fetch: an empty object would
  // be cached as a real (silent) answer, and the picker would report "no lemmas
  // start with that text" for the rest of the session with no way to retry.
  const p = fetch(`${ROOT()}/lemma-picker/${letter}.json`).then(async r => {
    if (!r.ok) throw new Error(`HTTP ${r.status} for lemma-picker/${letter}.json`);
    const shard = await r.json();
    // A shard built by an older script would have the wrong shape and render as
    // blank counts rather than failing, so check one entry and refuse it here.
    const first = Object.values(shard)[0] as LemmaChoice | undefined;
    if (first && !Array.isArray((first as LemmaChoice).c)) {
      throw new Error(`lemma-picker/${letter}.json is stale — rebuild the lemma data`);
    }
    return shard;
  });
  p.catch(() => { if (_pickerCache.get(letter) === p) _pickerCache.delete(letter); });
  _pickerCache.set(letter, p);
  return p;
}

// A lemma page's short glosses, fetched only when the picker needs to show one
// (the pages are ~4.7 KB each, so they are never loaded in bulk).
const _glossCache = new Map<string, Promise<string[]>>();
export function fetchLemmaGlosses(slug: string): Promise<string[]> {
  const cached = _glossCache.get(slug);
  if (cached) return cached;
  const p = fetch(`${ROOT()}/lemmata/${slug}.json`)
    .then(r => (r.ok ? r.json() : null))
    .then(d => (d?.glosses ?? []) as string[]);
  p.catch(() => { if (_glossCache.get(slug) === p) _glossCache.delete(slug); });
  _glossCache.set(slug, p);
  return p;
}

// Recurrent phrases (stage 8), sharded by the phrase's fold-initial letter.
//
// The browse list and the occurrences are separate fetches on purpose: browsing
// needs every phrase, but only an EXPANDED phrase needs its offsets, and one
// combined shard reached 10.4 MB. A row is positional to keep the list small —
// [length, corpus count, distinctiveness score, works, occurrences straddling a
// chapter?]. The score orders the list; it never removes anything from it.
export type NgramRow = [number, number, number, number, number?];
// 'english' indexes the translations. Same shape, same shards, different
// language — and its occurrences resolve through english-segments.json rather
// than a work's offsets.json, because the English is aligned per segment.
export type NgramStream = 'form' | 'lemma' | 'english';

export interface EnglishSegment {
  book: number;
  column: string;
  base: number;
  words: number;
}

let _englishSegments: Promise<Record<string, EnglishSegment[]>> | null = null;
export function fetchEnglishSegments(): Promise<Record<string, EnglishSegment[]>> {
  if (_englishSegments) return _englishSegments;
  const p = fetch(`${ROOT()}/ngrams/english-segments.json`).then(r => {
    if (!r.ok) throw new Error(`HTTP ${r.status} for ngrams/english-segments.json`);
    return r.json();
  });
  p.catch(() => { if (_englishSegments === p) _englishSegments = null; });
  _englishSegments = p;
  return p;
}

const _ngramCache = new Map<string, Promise<Record<string, NgramRow>>>();
export function fetchNgramShard(
  stream: NgramStream,
  letter: string,
): Promise<Record<string, NgramRow>> {
  const key = `${stream}/${letter}`;
  const cached = _ngramCache.get(key);
  if (cached) return cached;
  const p = fetch(`${ROOT()}/ngrams/${key}.json`).then(r => {
    if (!r.ok) throw new Error(`HTTP ${r.status} for ngrams/${key}.json`);
    return r.json();
  });
  p.catch(() => { if (_ngramCache.get(key) === p) _ngramCache.delete(key); });
  _ngramCache.set(key, p);
  return p;
}

// work -> global offsets, delta-encoded after the first.
const _occCache = new Map<string, Promise<Record<string, Record<string, number[]>>>>();
export function fetchNgramOccurrences(
  stream: NgramStream,
  letter: string,
  n: number,
): Promise<Record<string, Record<string, number[]>>> {
  const key = `${stream}/occ/${letter}-${n}`;
  const cached = _occCache.get(key);
  if (cached) return cached;
  const p = fetch(`${ROOT()}/ngrams/${key}.json`).then(r => {
    if (!r.ok) throw new Error(`HTTP ${r.status} for ngrams/${key}.json`);
    return r.json();
  });
  p.catch(() => { if (_occCache.get(key) === p) _occCache.delete(key); });
  _occCache.set(key, p);
  return p;
}

// Per-work token-offset index used by the phrase browser to turn a global
// occurrence offset into a Bekker citation. No module-level cache — Phrases
// keeps its own per-work map so a failed fetch can be retried there.
export async function fetchSearchOffsets(work: string): Promise<unknown> {
  const r = await fetch(`${ROOT()}/${work}/search/offsets.json`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// Undo the delta encoding: [first, +d, +d, ...] -> absolute global offsets.
export function decodeOffsets(deltas: number[]): number[] {
  const out: number[] = [];
  let at = 0;
  for (let i = 0; i < deltas.length; i++) {
    at = i === 0 ? deltas[0] : at + deltas[i];
    out.push(at);
  }
  return out;
}

// fold(surface) -> the headwords that surface can belong to. Lets a typed
// phrase be widened to its inflected variants without the reader knowing any
// dictionary forms. Sharded by fold-initial letter like everything else.
const _lemmaMapCache = new Map<string, Promise<Record<string, string[]>>>();
export function fetchLemmaMapShard(letter: string): Promise<Record<string, string[]>> {
  const cached = _lemmaMapCache.get(letter);
  if (cached) return cached;
  const p = fetch(`${ROOT()}/lemma-map/${letter}.json`).then(r => {
    if (!r.ok) throw new Error(`HTTP ${r.status} for lemma-map/${letter}.json`);
    return r.json();
  });
  p.catch(() => { if (_lemmaMapCache.get(letter) === p) _lemmaMapCache.delete(letter); });
  _lemmaMapCache.set(letter, p);
  return p;
}

export function lsjShard(key: string): string {
  for (const ch of key) {
    if (ch === '*') continue;
    if (/[a-z]/.test(ch)) return ch;
  }
  return '_';
}

// The LSJ dictionary is shared across the whole corpus — one copy at
// /data/lsj/<letter>.json (the union of every work's lemmas), not a per-work
// subset — so entries aren't duplicated ~30× across works. Keys are global
// betacode headwords, identical across works, so the same lookup resolves
// against the shared shard. Cached by letter (work-independent).
export async function fetchLsjShard(letter: string): Promise<Record<string, LsjEntry>> {
  if (_lsjCache.has(letter)) return _lsjCache.get(letter)!;
  const r = await fetch(`${ROOT()}/lsj/${letter}.json`);
  if (!r.ok) return {};
  const shard = await r.json();
  _lsjCache.set(letter, shard);
  return shard;
}

// LSJ key -> { head, hom }: the two things a popup card needs about an entry
// before anyone taps it — the Unicode headword, and LSJ's own homograph letter.
// 14,047 keys, 139 KB gzipped, fetched once. It exists so the website can stop
// pulling a whole letter shard per lookup (e.json is 1,144 KB gzipped) purely
// to read a headword out of it. Built by app/scripts/build-lsj-heads.mjs.
// Distinct from lemmata.json, which is the lemma-PAGE manifest and covers only
// the 6,214 keys that have a page.
export interface LsjHead { head: string; hom?: string; }
let _lsjHeadsCache: Promise<Record<string, LsjHead>> | null = null;
export function fetchLsjHeads(): Promise<Record<string, LsjHead>> {
  if (_lsjHeadsCache) return _lsjHeadsCache;
  // Throw on a bad response rather than resolving to {}: resolving would make
  // the failure look like an empty manifest, and the catch below would never
  // fire, so one 404 pinned every card to betaToGreek for the whole session.
  // `npm run dev` does not run build-lsj-heads.mjs, so a tree without a built
  // manifest hits exactly that path on the first popup.
  const p = fetch(`${ROOT()}/lsj-heads.json`).then(r => {
    if (!r.ok) throw new Error(`lsj-heads.json: ${r.status}`);
    return r.json();
  });
  // A missing manifest costs headwords, not the popup — don't cache the failure.
  p.catch(() => { if (_lsjHeadsCache === p) _lsjHeadsCache = null; });
  _lsjHeadsCache = p;
  return p;
}

export async function lookupWord(
  work: string,
  key: string,
  // The website renders no LSJ text of its own any more — grammata serves the
  // entry, keyed, when the reader taps a card — so it asks for analyses only
  // and never touches a shard. The desktop app bundles its corpus and renders
  // entries locally, so it keeps the default.
  opts: { withLsj?: boolean } = {}
): Promise<{ analyses: Analysis[]; lsj: LsjEntry[] }> {
  const { withLsj = true } = opts;
  const allAnalyses = await fetchAnalyses(work);
  const entries = allAnalyses[key] ?? [];
  const lsjEntries: LsjEntry[] = [];
  if (!withLsj) return { analyses: entries, lsj: lsjEntries };
  const seen = new Set<string>();
  for (const a of entries) {
    for (const lsjKey of a.lsj) {
      if (seen.has(lsjKey)) continue;
      seen.add(lsjKey);
      const letter = lsjShard(lsjKey);
      const shard = await fetchLsjShard(letter);
      if (shard[lsjKey]) lsjEntries.push(shard[lsjKey]);
    }
  }
  return { analyses: entries, lsj: lsjEntries };
}
