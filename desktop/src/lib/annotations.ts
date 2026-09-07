// Annotations: highlights and notes, modelled on the W3C Web Annotation Data
// Model — ONE underlying type (a highlight is an annotation with an empty
// body), filterable in the UI, never two systems.
//
// Anchor rules (deliberate design, not implementation detail):
//   - GREEK targets anchor to the Bekker citation (column + line + word index
//     within the line) — the stable spine every translation maps onto.
//   - ENGLISH targets anchor to character offsets within ONE specific
//     translation's prose for one column segment — never to a Bekker estimate.
//     This decouples annotation stability from alignment accuracy: refining a
//     translation's alignment later cannot move an English-side annotation.
//   - `layer` says where the annotation lives: 'greek' | 'translation:<id>' |
//     'both'. The panel always shows greek/both; annotations on a translation
//     other than the active one are DIMMED, not hidden.
//
// Storage: one plain JSON file per work ($APPDATA/annotations/<work>.json;
// localStorage in the browser harness) — inspectable, backupable files.
//
// Rendering uses the CSS Custom Highlight API: anchors are resolved to Ranges
// after the Reader renders and registered under ::highlight() names — the
// Reader's DOM is never mutated.

export interface GreekTarget {
  kind: 'greek';
  book: number;
  start: { column: string; line: number; word: number };  // word = .tok index in line
  end: { column: string; line: number; word: number };    // inclusive
}

export interface EnglishTarget {
  kind: 'english';
  book: number;
  translation: string;   // translation id whose wording was annotated
  column: string;        // segment column the selection lived in
  start: number;         // char offsets into the column's prose textContent
  end: number;           //   (concatenated .bk-seg text — Bekker numerals excluded)
}

export type AnnStyle = 'highlight' | 'underline';
export type AnnColor = 'yellow' | 'green' | 'pink' | 'blue' | 'purple' | 'orange';

export interface Annotation {
  id: string;
  work: string;
  created: string;       // ISO 8601
  body: string;          // '' = highlight/underline mark; text = note
  layer: 'greek' | `translation:${string}` | 'both';
  target: GreekTarget | EnglishTarget;
  exact: string;         // the selected text, quoted verbatim at creation time
  style?: AnnStyle;      // default 'highlight' at read time (see annStyle())
  color?: AnnColor;      // default 'yellow' at read time (see annColor())
}

// Read-time defaulting: old annotations (pre-dating style/color) paint as a
// plain yellow highlight — identical to the single-wash behavior they were
// created under. No file rewrite/migration needed.
export const annStyle = (a: Annotation): AnnStyle => a.style ?? 'highlight';
export const annColor = (a: Annotation): AnnColor => a.color ?? 'yellow';
export const PALETTE: AnnColor[] = ['yellow', 'green', 'pink', 'blue', 'purple', 'orange'];

// ── storage ──────────────────────────────────────────────────────────────────

import { isTauri, errorText, lazy, atomicWriteText } from './runtime';

interface AnnRead {
  anns: Annotation[];
  /** Set when the stored file exists but cannot be read as a list of
   *  annotations — the work is then read-only until it is repaired. */
  problem?: string;
}

interface AnnStore {
  read(work: string): Promise<AnnRead>;
  write(work: string, anns: Annotation[]): Promise<void>;
}

function parseAnnotations(raw: string): Annotation[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('not a list of annotations');
  return parsed as Annotation[];
}

// An unreadable file used to read as an empty list — and the next highlight
// then wrote that one-item list over the top of every annotation the user
// had for the work. Now the file is left exactly as it is, hidden, and
// writes for that work are refused with this sentence.
function readProblem(where: string, e: unknown): string {
  return `The annotations file for this work could not be read (${errorText(e)}). Its highlights and notes are hidden `
    + `and new ones cannot be saved until it is repaired or moved: ${where}.`;
}

const browserStore: AnnStore = {
  async read(work) {
    const key = `annotations:${work}`;
    const raw = localStorage.getItem(key);
    if (raw === null) return { anns: [] };
    try { return { anns: parseAnnotations(raw) }; }
    catch (e) { return { anns: [], problem: readProblem(`localStorage key ${key}`, e) }; }
  },
  async write(work, anns) {
    localStorage.setItem(`annotations:${work}`, JSON.stringify(anns));
  },
};

async function tauriStore(): Promise<AnnStore> {
  const { appDataDir, join } = await import('@tauri-apps/api/path');
  const fs = await import('@tauri-apps/plugin-fs');
  const dir = await join(await appDataDir(), 'annotations');
  return {
    async read(work) {
      const path = await join(dir, `${work}.json`);
      if (!(await fs.exists(path))) return { anns: [] };
      try { return { anns: parseAnnotations(await fs.readTextFile(path)) }; }
      catch (e) { return { anns: [], problem: readProblem(path, e) }; }
    },
    // Write-then-rename, so a crash mid-write can never leave a truncated
    // file where the user's annotations were.
    async write(work, anns) {
      await fs.mkdir(dir, { recursive: true });
      await atomicWriteText(fs, await join(dir, `${work}.json`), JSON.stringify(anns, null, 1));
    },
  };
}

// A failed handle is never cached (see lazy()).
const store = lazy<AnnStore>(() => (isTauri() ? tauriStore() : Promise.resolve(browserStore)));

const _cache = new Map<string, AnnRead>();

async function entryFor(work: string): Promise<AnnRead> {
  if (!_cache.has(work)) _cache.set(work, await (await store()).read(work));
  return _cache.get(work)!;
}

export async function listAnnotations(work: string): Promise<Annotation[]> {
  return (await entryFor(work)).anns;
}

/** Why this work's annotations are read-only (its file could not be read),
 *  or null. Meaningful once listAnnotations(work) has run. */
export function annotationsProblem(work: string): string | null {
  return _cache.get(work)?.problem ?? null;
}

/** Persist the list `mutate` derives from the work's current one; a mutator
 *  returning null declines (nothing written). A work whose file could not be
 *  read refuses every write. The in-memory list changes only after the write
 *  succeeded, so a failed save is never shown as saved. */
async function commit(work: string, mutate: (anns: Annotation[]) => Annotation[] | null): Promise<void> {
  const entry = await entryFor(work);
  if (entry.problem) throw new Error(entry.problem);
  const next = mutate(entry.anns);
  if (!next) return;
  await (await store()).write(work, next);
  entry.anns = next;
}

export async function addAnnotation(a: Annotation): Promise<void> {
  await commit(a.work, anns => [...anns, a]);
}

/** Unknown ids are a silent no-op. */
export async function updateAnnotation(work: string, id: string, body: string): Promise<void> {
  await commit(work, anns => (anns.some(x => x.id === id) ? anns.map(x => (x.id === id ? { ...x, body } : x)) : null));
}

/** Unknown ids are a silent no-op. */
export async function deleteAnnotation(work: string, id: string): Promise<void> {
  await commit(work, anns => (anns.some(x => x.id === id) ? anns.filter(x => x.id !== id) : null));
}

export function newId(): string {
  return `ann-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── capture: DOM selection → target ─────────────────────────────────────────

const lineIdOf = (el: Element | null): { column: string; line: number } | null => {
  const host = el?.closest?.('.greek-line[id], tr[id^="L"]');
  const m = host?.id.match(/^L(.+?)-(\d+)(?:-c)?$/);
  return m ? { column: m[1], line: Number(m[2]) } : null;
};

const nodeEl = (n: Node): Element | null =>
  n.nodeType === Node.ELEMENT_NODE ? (n as Element) : n.parentElement;

// ── copy: plain text + citation formatting ──────────────────────────────────
// The desktop app has no selection-anchored popup for copying (that lives in
// the right-click context menu now — see App.svelte). These helpers format
// the clipboard payload; App.svelte wires them to the menu actions AND to a
// capture-phase `document` 'copy' listener that intercepts plain ⌘C / native
// copy so the same clean-text formatting applies there too (the site's own
// on:copy handler on .reader-body only strips nothing — raw selection.toString()
// — which is what left hard line breaks / footnote digits in normal copies;
// see App.svelte's onDocumentCopy).

// L1094a-3 → 1094a3; L1094a-3-c → 1094a3 (mirrors Reader.svelte's idToBekker
// for Greek lines — same id shape, `L<column>-<line>[-c]`).
const idToBekker = (id: string) => id.slice(1).replace(/-(\d+)(-c)?$/, '$1');

/** Greek-line citation for a Range, e.g. "(NE 1094a3)" or "(NE 1094a3–1094a5)".
 * Returns null off a Greek line (English/mixed selection). */
export function greekCiteForRange(range: Range, abbr: string): string | null {
  const startLine = nodeEl(range.startContainer)?.closest('.greek-line[id]') ?? null;
  const endLine = nodeEl(range.endContainer)?.closest('.greek-line[id]') ?? null;
  if (!startLine && !endLine) return null;
  const s = startLine ? idToBekker(startLine.id) : null;
  const f = endLine ? idToBekker(endLine.id) : null;
  return s && f && s !== f ? `(${abbr} ${s}–${f})` : `(${abbr} ${s ?? f})`;
}

/** Column-granularity citation for an English selection, e.g. "(NE 1097a)" or
 * "(NE 1097a–1097b)" when the selection spans segments. English is
 * Bekker-anchored at column granularity site-wide (see EnglishTarget above);
 * a line-level citation would be an alignment estimate the data model
 * deliberately refuses. Falls back to null (→ plain text) if no enclosing
 * segment resolves on either boundary. */
export function segCiteForRange(range: Range, abbr: string): string | null {
  const startSeg = nodeEl(range.startContainer)?.closest('.segment[id^="col-"]') ?? null;
  const endSeg = nodeEl(range.endContainer)?.closest('.segment[id^="col-"]') ?? null;
  if (!startSeg && !endSeg) return null;
  const colOf = (seg: Element) => seg.id.replace(/^col-/, '');
  const s = startSeg ? colOf(startSeg) : null;
  const f = endSeg ? colOf(endSeg) : null;
  return s && f && s !== f ? `(${abbr} ${s}–${f})` : `(${abbr} ${s ?? f})`;
}

/** Write text to the OS clipboard: Tauri's plugin in the packaged app
 * (WKWebView can deny navigator.clipboard), the web API in the browser
 * harness. Returns whether the write succeeded. */
export async function writeClipboard(text: string): Promise<boolean> {
  try {
    if ('__TAURI_INTERNALS__' in window) {
      const { writeText } = await import('@tauri-apps/plugin-clipboard-manager');
      await writeText(text);
    } else {
      await navigator.clipboard.writeText(text);
    }
    return true;
  } catch {
    return false;
  }
}

// Elements whose text must never land in a copied selection, even though
// they sit inside the prose/line flow selection.toString() would otherwise
// walk straight through:
//   .bk-num     — the Bekker gutter number floated into the English margin
//   .line-num   — the Greek gutter's own line-number span
//   .col-label  — the compare-view translation-name header above a column
//   .fn-marker  — Ostwald's inline `[^N]` footnote reference button
//                 (rendered as a clickable superscript digit, see
//                 Reader.svelte's renderThird/.fn-marker)
//   .overlay-chapter-title — an imported translation's own converter-derived
//                 chapter title (Reader.svelte's importChapterTitle):
//                 editorial paratext rendered inside that import's column,
//                 not part of the reference text
//   .eng-table  — kept for parity with the existing offset walker below,
//                 though its own text is usually outside any prose selection
const COPY_EXCLUDE_SELECTOR = '.bk-num, .line-num, .col-label, .fn-marker, .overlay-chapter-title, .eng-table';

/**
 * Extract a Range's text the way a "clean copy" should read: skips gutter
 * numbers, column labels, and footnote-reference markers (see
 * COPY_EXCLUDE_SELECTOR), then collapses every run of whitespace — including
 * the newlines `selection.toString()` inserts between separately-rendered
 * `.greek-line` elements (one rendered line per Bekker line; see
 * Reader.svelte's `.greek-line` markup) — into a single space and trims the
 * ends. Greek line boundaries are always between complete words (each line's
 * `.tok` tokens come from a word-bounded `tokens` array with no cross-line
 * hyphenation in the data or renderer), so a plain space-join is correct —
 * no hyphen-rejoin logic is needed.
 *
 * Exported: App.svelte's document-level `copy` listener (the plain ⌘C /
 * native-copy path, distinct from the right-click menu's Copy actions below)
 * reuses this directly so both copy paths produce identical clean text.
 */
export function extractCleanText(range: Range): string {
  const frag = range.cloneContents();
  frag.querySelectorAll(COPY_EXCLUDE_SELECTOR).forEach((el) => el.remove());
  const raw = frag.textContent ?? '';
  return raw.replace(/\s+/g, ' ').trim();
}

/** Copy the current selection's text only, no citation. */
export async function copySelectionPlain(): Promise<boolean> {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return false;
  const text = extractCleanText(sel.getRangeAt(0));
  if (!text) return false;
  return writeClipboard(text);
}

/** Copy the current selection's text plus a citation: Greek lines cite at
 * line granularity (byte-identical to the site's own floating copy button);
 * English selections cite at column granularity via segCiteForRange; falls
 * back to plain text if neither resolves. */
export async function copySelectionWithCitation(abbr: string): Promise<boolean> {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return false;
  const range = sel.getRangeAt(0);
  const text = extractCleanText(range);
  if (!text) return false;
  const cite = greekCiteForRange(range, abbr) ?? segCiteForRange(range, abbr);
  return writeClipboard(cite ? `${text}\n${cite}` : text);
}

/** Index of the .tok containing (or nearest before) a range boundary, within its line. */
function wordIndexAt(container: Node, lineHost: Element): number {
  const toks = [...lineHost.querySelectorAll('.tok')];
  const el = nodeEl(container)?.closest('.tok');
  if (el) return Math.max(0, toks.indexOf(el));
  // Boundary sits between tokens: count toks that end before it.
  let idx = 0;
  for (const t of toks) {
    const cmp = t.compareDocumentPosition(container);
    if (cmp & Node.DOCUMENT_POSITION_FOLLOWING) idx += 1;
    else break;
  }
  return Math.max(0, Math.min(idx, toks.length - 1));
}

/** Char offset of a range boundary within a column's prose (.bk-seg text only). */
function proseOffsetAt(col: Element, container: Node, offset: number): number {
  // Scope to the prose subtree: in compare view .english-col/.overlay-col carry a
  // leading .col-label (translation name) before .overlay-prose — walking from
  // `col` itself would count that label text into the offset, shifting every
  // compare-captured offset relative to the same selection made in mono view.
  const root = col.querySelector('.overlay-prose') ?? col;
  let acc = 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) =>
      nodeEl(n)?.closest('.bk-num, .eng-table, .fn-marker') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n === container) return acc + offset;
    const cmp = n.compareDocumentPosition(container);
    if (cmp & Node.DOCUMENT_POSITION_FOLLOWING) acc += n.textContent!.length;
    else break; // container precedes this text node
  }
  return acc;
}

export interface CaptureResult {
  target: GreekTarget | EnglishTarget;
  exact: string;
  layer: Annotation['layer'];
}

/** Returned instead of a CaptureResult when a selection spans two distinct
 * columns (e.g. Greek → English, or left → right in compare) — anchorable to
 * neither, but worth telling the user about (unlike plain unanchorable null). */
export const CROSS_COLUMN = 'cross-column' as const;

/** Which of the three column kinds (if any) a node lives in, for the
 * cross-column check below. */
function columnOf(el: Element | null): Element | null {
  return el?.closest('.greek-col, .english-col, .overlay-col') ?? null;
}

/**
 * Turn the current selection into an anchor. `activeTranslation` is used only
 * as a fallback when the resolved column carries no `data-trans` (should not
 * happen post-Reader-change, but keeps this resilient) — the column's own
 * `data-trans` attribute is the primary source of the translation id, so this
 * works correctly in both mono and compare view.
 */
export function captureSelection(book: number, activeTranslation: string): CaptureResult | null | typeof CROSS_COLUMN {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  const exact = sel.toString().trim();
  if (!exact) return null;

  const startLine = lineIdOf(nodeEl(range.startContainer));
  const endLine = lineIdOf(nodeEl(range.endContainer));
  if (startLine && endLine) {
    const startHost = nodeEl(range.startContainer)!.closest('.greek-line, tr[id^="L"]')!;
    const endHost = nodeEl(range.endContainer)!.closest('.greek-line, tr[id^="L"]')!;
    return {
      exact,
      layer: 'greek',
      target: {
        kind: 'greek',
        book,
        start: { ...startLine, word: wordIndexAt(range.startContainer, startHost) },
        end: { ...endLine, word: wordIndexAt(range.endContainer, endHost) },
      },
    };
  }

  const startCol = columnOf(nodeEl(range.startContainer));
  const endCol = columnOf(nodeEl(range.endContainer));
  if (startCol && endCol && startCol !== endCol) return CROSS_COLUMN;

  const col = nodeEl(range.startContainer)?.closest('.english-col, .overlay-col');
  const seg = nodeEl(range.startContainer)?.closest('.segment');
  const colId = seg?.id.match(/^col-(.+)$/)?.[1];
  if (col && colId && col.contains(range.endContainer)) {
    const translation = col.getAttribute('data-trans') ?? activeTranslation;
    const start = proseOffsetAt(col, range.startContainer, range.startOffset);
    const end = proseOffsetAt(col, range.endContainer, range.endOffset);
    if (end > start) {
      return {
        exact,
        layer: `translation:${translation}`,
        target: {
          kind: 'english', book, translation,
          column: colId, start, end,
        },
      };
    }
  }
  return null; // mixed/unanchorable selection (spans columns, chrome, …)
}

// ── resolve: target → Range, and paint via CSS Custom Highlights ───────────

export function greekRange(t: GreekTarget): Range[] {
  const hostOf = (column: string, line: number): Element | null =>
    document.getElementById(`L${column}-${line}`) ?? document.getElementById(`L${column}-${line}-c`);
  const sh = hostOf(t.start.column, t.start.line);
  const eh = hostOf(t.end.column, t.end.line);
  if (!sh || !eh) return [];

  // One sub-range PER LINE, each spanning only that line's `.tok` run. Painting
  // a multi-line highlight as a single range (first tok → last tok) would cross
  // `.greek-line` boundaries and swallow every wrapped line's `.line-num` gutter
  // — and the CSS Custom Highlight API ignores `user-select`, so those numerals
  // would be painted. A per-line range stays inside `.line-text` (the gutter is
  // a preceding sibling), so the gutter is never touched.
  let hosts: Element[];
  if (sh === eh) {
    hosts = [sh];
  } else {
    const all = [...document.querySelectorAll('.greek-line[id], tr[id^="L"]')];
    const si = all.indexOf(sh);
    const ei = all.indexOf(eh);
    if (si < 0 || ei < 0 || si > ei) return [];
    hosts = all.slice(si, ei + 1);
  }

  const ranges: Range[] = [];
  for (const host of hosts) {
    const toks = [...host.querySelectorAll('.tok')];
    if (!toks.length) continue; // e.g. an empty continuation line
    const from = host === sh ? Math.min(t.start.word, toks.length - 1) : 0;
    const to = host === eh ? Math.min(t.end.word, toks.length - 1) : toks.length - 1;
    if (to < from) continue;
    const r = new Range();
    r.setStartBefore(toks[from]);
    r.setEndAfter(toks[to]);
    ranges.push(r);
  }
  return ranges;
}

export function englishRange(t: EnglishTarget, shown: string[]): Range[] {
  // Only resolvable when the annotated translation is one of the ones on
  // screen (mono: a single id; compare: the left+right pair).
  if (!shown.includes(t.translation)) return [];
  const seg = document.getElementById(`col-${t.column}`);
  if (!seg) return [];
  // Locate the specific column element carrying this translation. Compare
  // view can have both an .english-col and a .overlay-col under the same
  // segment, each tagged with its own data-trans; mono view has only
  // .english-col and (pre-existing markup) may carry no data-trans at all,
  // so fall back to the old unconditional .english-col lookup in that case.
  const candidates = [...seg.querySelectorAll('.english-col, .overlay-col')];
  const col = candidates.find(c => c.getAttribute('data-trans') === t.translation)
    ?? seg.querySelector('.english-col');
  if (!col) return [];
  // Scope to the prose subtree — mirrors the capture-side offset walk so a
  // compare column's leading .col-label text is never counted.
  const root = col.querySelector('.overlay-prose') ?? col;
  const locate = (target: number): [Node, number] | null => {
    let acc = 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) =>
        nodeEl(n)?.closest('.bk-num, .eng-table, .fn-marker') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const len = n.textContent!.length;
      if (acc + len >= target) return [n, target - acc];
      acc += len;
    }
    return null;
  };
  const s = locate(t.start);
  const e = locate(t.end);
  if (!s || !e) return [];
  // Split into per-text-node sub-ranges that skip .bk-num / .eng-table /
  // .fn-marker. One range from s to e would tree-span the absolutely-
  // positioned .bk-num gutter numerals and the `.fn-marker` footnote-button
  // text (locate omits both from the OFFSET count — same exclusion as
  // proseOffsetAt's capture-side walker, so capture and paint agree — but
  // they still sit inside the range in document order) and the CSS Custom
  // Highlight would paint them. Emitting one sub-range per accepted prose
  // text node never includes a gutter numeral or a footnote-marker button;
  // adjacent nodes tile seamlessly in the inline flow, so the highlight
  // still reads as one continuous band.
  const out: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let inRange = false;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const isStart = n === s[0];
    if (isStart) inRange = true;
    const isEnd = n === e[0];
    if (inRange && !nodeEl(n)?.closest('.bk-num, .eng-table, .fn-marker')) {
      const from = isStart ? s[1] : 0;
      const to = isEnd ? e[1] : n.textContent!.length;
      if (to > from) {
        const sub = new Range();
        sub.setStart(n, from);
        sub.setEnd(n, to);
        out.push(sub);
      }
    }
    if (isEnd) break;
  }
  return out;
}

/**
 * Re-resolve every annotation for the current view and register the ranges
 * under one Highlight per (style,color) — ::highlight(ann-hl-<color>) for
 * fills, ::highlight(ann-ul-<color>) for underlines — plus a shared
 * ::highlight(ann-note-cue) for the "has a comment" dotted affordance. Safe
 * to call repeatedly (idempotent): every known name is (re)registered every
 * call, including empties, so a name that lost all its ranges is cleared
 * rather than left stale. No-op where the API is unsupported.
 */
export function paintAnnotations(anns: Annotation[], shown: string[]): void {
  const css = (globalThis as { CSS?: { highlights?: Map<string, unknown> } }).CSS;
  if (!css?.highlights || typeof Highlight === 'undefined') return;
  const buckets = new Map<string, Range[]>();
  const push = (name: string, r: Range) => {
    const b = buckets.get(name);
    if (b) b.push(r);
    else buckets.set(name, [r]);
  };
  const noteCue: Range[] = [];
  for (const a of anns) {
    const ranges = a.target.kind === 'greek'
      ? greekRange(a.target)
      : englishRange(a.target, shown);
    if (!ranges.length) continue;
    const name = `ann-${annStyle(a) === 'underline' ? 'ul' : 'hl'}-${annColor(a)}`;
    for (const r of ranges) {
      push(name, r);
      if (a.body) noteCue.push(r.cloneRange()); // a note also gets the dotted cue
    }
  }
  // Register fills, then underlines, then the note cue — later registrations
  // paint on top, so the note cue's dotted decoration sits above the rest.
  for (const color of PALETTE) {
    const name = `ann-hl-${color}`;
    css.highlights.set(name, new Highlight(...(buckets.get(name) ?? [])));
  }
  for (const color of PALETTE) {
    const name = `ann-ul-${color}`;
    css.highlights.set(name, new Highlight(...(buckets.get(name) ?? [])));
  }
  const cue = new Highlight(...noteCue);
  cue.priority = 1;
  css.highlights.set('ann-note-cue', cue);
}

/**
 * Paint a PROVISIONAL range while the note editor is open — otherwise
 * focusing the textarea clears the DOM selection and the user loses sight of
 * what the note is about. Registered under its own name ('ann-pending') so
 * paintAnnotations' full re-registration of the 13 real (style,color) names
 * every call can never clobber it (see paintAnnotations above — it only ever
 * `.set()`s its own known names). The active palette color is communicated to
 * CSS via a `data-ann-pending-color` attribute on <html> (desktop.css keys
 * six `[data-ann-pending-color="…"] ::highlight(ann-pending)` rules off it,
 * mirroring the existing `[data-theme='dark']` selector-attribute pattern
 * already used for every other highlight color) — simpler than computing an
 * rgba() in JS and pushing it through a CSS custom property, and it stays
 * themeable for free the same way the real fills are.
 */
export function paintPending(ranges: Range[], color: AnnColor): void {
  const css = (globalThis as { CSS?: { highlights?: Map<string, unknown> } }).CSS;
  if (!css?.highlights || typeof Highlight === 'undefined') return;
  document.documentElement.setAttribute('data-ann-pending-color', color);
  css.highlights.set('ann-pending', new Highlight(...ranges));
}

/** Clear the provisional pending highlight (save/cancel/Esc). */
export function clearPending(): void {
  const css = (globalThis as { CSS?: { highlights?: Map<string, unknown> } }).CSS;
  if (!css?.highlights) return;
  css.highlights.delete('ann-pending');
}

/** A short citation label for the panel, e.g. "1097a15–1097b2" or "1097a (Ostwald)". */
export function annotationLabel(a: Annotation): string {
  if (a.target.kind === 'greek') {
    const s = `${a.target.start.column}${a.target.start.line}`;
    const e = `${a.target.end.column}${a.target.end.line}`;
    return s === e ? s : `${s}–${e}`;
  }
  return `${a.target.column} (${a.target.translation})`;
}
