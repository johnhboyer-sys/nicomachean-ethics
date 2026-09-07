// Imported-translation manager: storage, startup registration, and the two
// runtime hooks that make an import visible to the untouched site components —
// __ARISTOTLE_EXTRA_TRANSLATIONS__ (the Reader's picker, via works.ts) and
// __ARISTOTLE_BOOK_HOOK__ (overlay pieces merged into fetched book data).
//
// Storage is plain files in the app-data directory (no database, by design):
//   translations/<workId>/<id>.md         frontmatter + tagged content
//   translations/<workId>/<id>.map.json   alignment map + emitted overlay pieces
//   translations/<workId>/<id>.original   the untouched raw upload (safety net)
// A user's data folder is just files — backupable, movable, inspectable.
//
// In the browser dev harness (no Tauri), the same records live in
// localStorage so the whole flow is testable in a plain browser.

import { fetchBook, fetchChapters, type BookData, type ChapterRef, type OverlayPiece } from '@shared/lib/data';
import type { TranslationRef } from '@shared/lib/works';
import { getWork } from '@shared/lib/works';
import { isTauri, errorText, lazy, atomicWriteText } from './runtime';
import {
  parseTranslationFile, serializeFrontmatter, splitChapters, splitFrontmatter, slugId, composeCitation, auditChapterKeys,
  type ParsedTranslation, type TranslationMeta, type FootnoteScope,
} from './translation-file';
import { buildChapterInputs } from './aligner/reference';
import { alignImportedChapter, emitOverlayPieces, type ChapterAlignment, type PieceEmphasis } from './aligner/import-align';
import { resolveWorkStructure, type FootnotePlacement } from './import-presets';
import {
  auditDivisionCoverage,
  divisionGapLabel,
  type DivisionAuditResult,
  type DivisionGap,
} from './division-audit';

export interface ImportRecord {
  meta: TranslationMeta;
  density: string;
  warnings: string[];
  stats: { tagged: number; placed: number; interpolated: number; chapters: number };
  /** book number → segment id → overlay pieces (precomputed at import time). */
  overlaysByBook: Record<string, Record<string, OverlayPiece[]>>;
  /**
   * book number → Bekker COLUMN (not segment id — matches the rendered DOM's
   * `#col-{column}` element directly) → that column's overlay pieces'
   * emphasis spans (precomputed at import time, PARALLEL to overlaysByBook —
   * never stored on OverlayPiece itself; see import-align.ts's emitOverlayPieces
   * doc comment for why). Optional so records written before this field
   * existed still load — paintEmphasis (annotations.ts) just has nothing to
   * paint for them.
   */
  emphasisByBook?: Record<string, Record<string, PieceEmphasis[]>>;
  /** per-chapter anchor maps, kept for future refinement/re-tagging. */
  alignment: Record<string, ChapterAlignment>;
  /**
   * label -> note text (§B3), from the file's sentinel-delimited footnote
   * definitions block. Both fields optional so records written before Phase
   * 3 still load unchanged — getImportFootnote just has nothing to resolve
   * for them, mirroring emphasisByBook's read-time-optional precedent.
   */
  footnotes?: Record<string, string>;
  footnoteScope?: FootnoteScope;
  /** 'endnote' opens notes in the slide-in sidebar instead of the popover
   * (from the sentinel's render= attribute — commentary-class editions). */
  noteRender?: 'endnote';
  /** R6 result for the books this file declared that it covers. */
  divisionAudit?: DivisionAuditResult;
  /** Missing divisions accepted through R6's per-import incomplete-copy waiver. */
  waivedDivisionGaps?: DivisionGap[];
  /**
   * 'b.c' -> chapter title, verbatim, from the PDF converter's title map
   * (Phase 4A's `ConvertResult.titles`; §Phase-4B task 2, rendering revised
   * 2026-07-06 — see getImportTitle). Optional so records from a hand-
   * authored/plain import (no converter involved) or written before this
   * field existed still load unchanged — getImportTitle just has nothing to
   * resolve for them.
   */
  titles?: Record<string, string>;
}

export interface ImportSummary {
  meta: TranslationMeta;
  density: string;
  warnings: string[];
  chapters: number;
  tagged: number;
  placed: number;
  interpolated: number;
  replaced: boolean;
  /** e.g. "Detected continuous work-level numbering — 222 footnotes." Undefined when the file has no footnotes block. */
  footnoteSummary?: string;
  /** Tagged-path strip results. Present even when both rules found zero. */
  stripCounts?: { folioParagraphs: number; strayHeadingNumerals: number };
  divisionAudit: DivisionAuditResult;
  waivedDivisionGaps?: DivisionGap[];
}

// ── storage backends ─────────────────────────────────────────────────────────

interface Store {
  /** Every stored record; `problems` names the places it could not list. */
  list(): Promise<{ records: { work: string; id: string }[]; problems: string[] }>;
  /** Throws when the record is missing or unreadable — the caller decides how to say so. */
  readMap(work: string, id: string): Promise<ImportRecord>;
  write(work: string, id: string, content: string, original: string, record: ImportRecord): Promise<void>;
  exists(work: string, id: string): Promise<boolean>;
}

const LS_PREFIX = 'import-map:';

function parseRecord(raw: string, where: string): ImportRecord {
  const rec = JSON.parse(raw) as ImportRecord;
  if (!rec || typeof rec !== 'object' || typeof rec.meta?.id !== 'string' || !rec.overlaysByBook) {
    throw new Error(`${where} is not an import record`);
  }
  return rec;
}

const browserStore: Store = {
  async list() {
    const records: { work: string; id: string }[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)!;
      if (k.startsWith(LS_PREFIX)) {
        const [work, id] = k.slice(LS_PREFIX.length).split('/');
        records.push({ work, id });
      }
    }
    return { records, problems: [] };
  },
  async readMap(work, id) {
    const key = `${LS_PREFIX}${work}/${id}`;
    const raw = localStorage.getItem(key);
    if (raw === null) throw new Error(`${key} is missing`);
    return parseRecord(raw, key);
  },
  async write(work, id, _content, _original, record) {
    // Browser harness keeps only the map (localStorage is too small for full
    // texts alongside); the packaged app persists all three files.
    localStorage.setItem(`${LS_PREFIX}${work}/${id}`, JSON.stringify(record));
  },
  async exists(work, id) {
    return localStorage.getItem(`${LS_PREFIX}${work}/${id}`) !== null;
  },
};

async function tauriStore(): Promise<Store> {
  const { appDataDir, join } = await import('@tauri-apps/api/path');
  const fs = await import('@tauri-apps/plugin-fs');
  const root = await join(await appDataDir(), 'translations');
  const dirOf = (work: string) => join(root, work);
  return {
    async list() {
      const records: { work: string; id: string }[] = [];
      const problems: string[] = [];
      if (!(await fs.exists(root))) return { records, problems };
      for (const workDir of await fs.readDir(root)) {
        if (!workDir.isDirectory) continue;
        let entries: Awaited<ReturnType<typeof fs.readDir>>;
        try {
          entries = await fs.readDir(await join(root, workDir.name));
        } catch (e) {
          problems.push(`The imported translations under translations/${workDir.name}/ could not be listed (${errorText(e)}) and are not in the picker; the files are untouched.`);
          continue;
        }
        for (const e of entries) {
          if (e.name.endsWith('.map.json')) {
            records.push({ work: workDir.name, id: e.name.replace(/\.map\.json$/, '') });
          }
        }
      }
      return { records, problems };
    },
    async readMap(work, id) {
      const p = await join(await dirOf(work), `${id}.map.json`);
      return parseRecord(await fs.readTextFile(p), p);
    },
    // Write-then-rename (atomicWriteText), the map last — `list()` keys on
    // `.map.json`, so a crash mid-write leaves stray `.tmp` files, never a
    // registered translation whose text or map is truncated.
    async write(work, id, content, original, record) {
      const dir = await dirOf(work);
      await fs.mkdir(dir, { recursive: true });
      for (const [name, body] of [
        [`${id}.md`, content],
        [`${id}.original`, original],
        [`${id}.map.json`, JSON.stringify(record)],
      ] as const) {
        await atomicWriteText(fs, await join(dir, name), body);
      }
    },
    async exists(work, id) {
      return fs.exists(await join(await dirOf(work), `${id}.map.json`));
    },
  };
}

// A failed handle (app-data dir not resolvable yet) must not be the cached
// answer for the rest of the session — lazy() retries on the next call.
const store = lazy<Store>(() => (isTauri() ? tauriStore() : Promise.resolve(browserStore)));

// ── runtime registration ─────────────────────────────────────────────────────

type G = typeof globalThis & {
  __ARISTOTLE_EXTRA_TRANSLATIONS__?: Record<string, TranslationRef[]>;
  __ARISTOTLE_BOOK_HOOK__?: (work: string, n: number, data: BookData) => BookData;
  /**
   * §B4.4: FootnotePopup.svelte (shared/, used by the static site build too,
   * which has no imports.ts and must not import desktop code) resolves an
   * imported translation's footnote text through this window-level hook
   * instead of a direct import — the same pattern __ARISTOTLE_BOOK_HOOK__ and
   * __ARISTOTLE_EXTRA_TRANSLATIONS__ already use above. Site build: hook is
   * never installed, so the shared lib’s lazy `globalThis.__ARISTOTLE_...` read is
   * always undefined there — inert, byte-identical rendering.
   */
  __ARISTOTLE_IMPORT_FOOTNOTE_HOOK__?: (work: string, id: string, label: string) => string | null;
  /**
   * Companion to the hook above: lets FootnotePopup tell "this transId is a
   * registered import with no note for this label" apart from "this transId
   * isn't an import at all — fall back to the site's fetchFootnotes(work)".
   * Without this, a registered import's unmatched label would silently fall
   * through to the WORK's built-in footnotes.json and could show a foreign
   * translation's note text if the label happened to collide (both use plain
   * digit labels under continuous scope) — see implementation-notes.md.
   */
  __ARISTOTLE_IMPORT_HAS_TRANS__?: (work: string, id: string) => boolean;
  /**
   * §Phase-4B-revised: an imported translation's converter-derived chapter
   * title, resolved for ONE registered import's own overlay column — NOT
   * merged into the shared chapterTitles heading map every translation
   * shares (that's work-level chrome; an imported title is this edition's
   * own editorial paratext, John's call 2026-07-06). Reader.svelte (shared/,
   * site-shared) reads this the same lazy-global way FootnotePopup reads
   * __ARISTOTLE_IMPORT_FOOTNOTE_HOOK__ above — never installed on the site
   * build, so the read is always undefined there — inert, byte-identical.
   */
  __ARISTOTLE_IMPORT_TITLE_HOOK__?: (work: string, id: string, book: number, chapter: string) => string | null;
  /** 'endnote' when the import's notes are commentary-class (sentinel
   * render=endnote) — the shared Reader opens the endnote sidebar instead of
   * the footnote popover. Same lazy-global pattern as the hooks above. */
  __ARISTOTLE_IMPORT_NOTE_RENDER__?: (work: string, id: string) => 'endnote' | null;
};

const registered = new Map<string, ImportRecord>(); // "work/id" → record

// The built-in corpus overlays only ever surface interpolated (estimate)
// Bekker ticks at the 5-line apparatus stops plus the column-start line
// (n=1) — verified against build/dist/**/book-*.json, where every real:false
// tick has n%5===0 or n===1. Real (user/model-placed) ticks always render;
// interpolated ones are noise between those printed stops. The importer's
// engine.interpolate() fills EVERY untagged line, so without this filter an
// imported five-line-tagged file renders a tick on every single line instead
// of the sparse gutter the built-in translations show. Filtering here (at
// the overlay-merge hook, which re-reads the stored map on every book fetch)
// means already-imported translations are fixed retroactively — no re-import
// needed — since nothing is mutated in the stored record itself.
function sparseTicks(
  ticks: { n: number; offset: number; real: boolean }[],
): { n: number; offset: number; real: boolean }[] {
  const filtered = ticks.filter(t => t.real || t.n % 5 === 0 || t.n === 1);
  return filtered.length === ticks.length ? ticks : filtered;
}

function sparsifyPieces(pieces: OverlayPiece[]): OverlayPiece[] {
  return pieces.map(p => {
    if (!p.bekker) return p;
    const bekker = sparseTicks(p.bekker);
    return bekker === p.bekker ? p : { ...p, bekker };
  });
}

// Display name shown in the picker: "Translator (Year)" plus a subtle
// muted-info marker so an imported translation is distinguishable from a
// built-in one at a glance — but "imported" itself never appears in the
// name. It stays only in the stored record's metadata (greppable/debuggable
// via the map.json / localStorage entry), never in display strings, exported
// citations, or copied citations. There's no tooltip here (the picker is
// rendered by untouched site code as a plain <option> string), so the marker
// has to be minimal and self-explanatory rather than relying on a title attr.
function displayName(meta: TranslationMeta): string {
  return `${meta.translator}${meta.year ? ` (${meta.year})` : ''} ⓘ`;
}

function installHooks(): void {
  const g = globalThis as G;
  const extras: Record<string, TranslationRef[]> = {};
  for (const [key, rec] of registered) {
    const work = key.split('/')[0];
    (extras[work] ??= []).push({
      id: rec.meta.id,
      name: displayName(rec.meta),
      short: rec.meta.translator,
      slot: 'overlay',
      // §B4.2: marks this overlay for Reader.svelte's footnote-marker
      // transform (the same TranslationRef.footnotes flag a built-in like
      // Owen already sets) — only when the file actually carried a
      // footnotes block, so an import with none renders exactly as before.
      ...(rec.footnotes && Object.keys(rec.footnotes).length > 0 ? { footnotes: true } : {}),
    });
  }
  g.__ARISTOTLE_EXTRA_TRANSLATIONS__ = extras;
  g.__ARISTOTLE_BOOK_HOOK__ = (work, n, data) => {
    let touched = false;
    for (const [key, rec] of registered) {
      if (key.split('/')[0] !== work) continue;
      const perSeg = rec.overlaysByBook[String(n)];
      if (!perSeg) continue;
      for (const seg of data.segments) {
        const pieces = perSeg[seg.id];
        if (pieces) {
          seg.overlays = { ...(seg.overlays ?? {}), [rec.meta.id]: sparsifyPieces(pieces) };
          touched = true;
        }
      }
    }
    return touched ? data : data;
  };
  // §B4.4: window-level footnote-resolution hooks for FootnotePopup.svelte
  // (site-shared; see the G type's doc comment above for why these exist as
  // hooks rather than a direct import).
  g.__ARISTOTLE_IMPORT_HAS_TRANS__ = (work, id) => registered.has(`${work}/${id}`);
  g.__ARISTOTLE_IMPORT_FOOTNOTE_HOOK__ = (work, id, label) => getImportFootnote(work, id, label);
  g.__ARISTOTLE_IMPORT_TITLE_HOOK__ = (work, id, book, chapter) => getImportTitle(work, id, book, chapter);
  g.__ARISTOTLE_IMPORT_NOTE_RENDER__ = (work, id) => registered.get(`${work}/${id}`)?.noteRender ?? null;
}

const loadProblems: string[] = [];

/**
 * One plain sentence per stored translation the last loadImports() could not
 * read (a truncated or hand-edited map.json, an unlistable work directory).
 * The record is skipped — never deleted, never overwritten — and the app
 * shows these at startup rather than letting a translation vanish from the
 * picker with no explanation.
 */
export function importLoadProblems(): string[] {
  return [...loadProblems];
}

/** Load every stored import and register it — call once at startup, before mount. */
export async function loadImports(): Promise<number> {
  loadProblems.length = 0;
  const s = await store();
  const { records, problems } = await s.list();
  loadProblems.push(...problems);
  for (const { work, id } of records) {
    try {
      registered.set(`${work}/${id}`, await s.readMap(work, id));
    } catch (e) {
      loadProblems.push(
        `The imported translation ${work}/${id} could not be read (${errorText(e)}) and is not in the picker; `
        + `its files are untouched (translations/${work}/${id}.map.json).`,
      );
    }
  }
  installHooks();
  return registered.size;
}

/**
 * Emphasis spans for one imported translation's rendered Bekker column
 * (matches the DOM's `#col-{column}` element directly) — each entry carries
 * its own piece's full text (PieceEmphasis.pieceText) so the caller can match
 * it against the right `.overlay-prose` block by CONTENT (a column can render
 * several chapter-blocks' worth of `.overlay-prose`; see import-align.ts's
 * PieceEmphasis doc comment for why content-matching, not a lookup key, is
 * the robust join). Returns [] (never throws) when `id` isn't a registered
 * import, the book/column carries no emphasis, or the record predates this
 * field.
 */
export function getImportEmphasis(work: string, id: string, book: number, column: string): PieceEmphasis[] {
  const rec = registered.get(`${work}/${id}`);
  return rec?.emphasisByBook?.[String(book)]?.[column] ?? [];
}

/**
 * Pure core of getImportFootnote — resolves `label` (the full scope-qualified
 * identity: plain digits under continuous scope, "book.chapter.N" under
 * per-chapter, or a "*"/"†" work-level glyph — see phase3-final-spec.md §B5)
 * against one already-fetched record's footnotes map. Split out from the
 * `registered`-Map lookup below so it's unit-testable with a plain object
 * literal, no storage/registration pipeline required.
 */
export function resolveImportFootnote(rec: ImportRecord | undefined, label: string): string | null {
  return rec?.footnotes?.[label] ?? null;
}

/**
 * §B4 (Phase 4 wires this into FootnotePopup): the note text for one label
 * on one imported translation, reading `registered.get(...).footnotes?.[label]`
 * — mirrors getImportEmphasis. Returns null (never throws) when `work`/`id`
 * isn't a registered import, the label has no definition, or the record
 * predates the footnotes field.
 */
export function getImportFootnote(work: string, id: string, label: string): string | null {
  return resolveImportFootnote(registered.get(`${work}/${id}`), label);
}

/**
 * Pure core of getImportTitle — resolves 'book.chapter' against one already-
 * fetched record's `titles` map. Split out from the `registered`-Map lookup
 * below so it's unit-testable with a plain object literal, mirroring
 * resolveImportFootnote just above.
 */
export function resolveImportTitle(rec: ImportRecord | undefined, book: number, chapter: string): string | null {
  return rec?.titles?.[`${book}.${chapter}`] ?? null;
}

/**
 * §Phase-4B-revised (John's call 2026-07-06): the converter-derived chapter
 * title for ONE registered import, at ONE chapter — this edition's own
 * editorial paratext, rendered as a small unaligned heading inside that
 * import's own overlay column (Reader.svelte's transFlow), never merged into
 * the shared chapterTitles heading map every translation sees. Returns null
 * (never throws) when `work`/`id` isn't a registered import, the chapter has
 * no captured title, or the record predates the titles field. Mirrors
 * getImportFootnote/getImportEmphasis.
 */
export function getImportTitle(work: string, id: string, book: number, chapter: string): string | null {
  return resolveImportTitle(registered.get(`${work}/${id}`), book, chapter);
}

/**
 * The citation string for an imported translation, for Copy Citation:
 * the stored `citation` verbatim, or the translator/year/source fallback
 * when a record predates the citation field (or the form was left blank).
 * Read-time defaulting — no migration needed for records already on disk.
 * Returns null when `id` isn't a registered import (i.e. it's a built-in
 * translation, which the caller cites from the site registry instead).
 */
export function getImportCitation(work: string, id: string): string | null {
  const rec = registered.get(`${work}/${id}`);
  if (!rec) return null;
  return rec.meta.citation || composeCitation(rec.meta);
}

// ── the import operation ─────────────────────────────────────────────────────

export interface ImportRequest {
  raw: string;                 // reviewed working text, still carrying emphasis markers
                                // that parseTranslationFile classifies
  /**
   * The pristine upload, when it differs from `raw` — e.g. ImportDialog's
   * PDF-conversion pre-stage sets `raw` to the CONVERTER'S tagged output
   * (what actually gets parsed/aligned/canonicalized) but wants the
   * `.original` safety-net file to hold the exact upload, not cleaned or
   * converted working text. Falls back to `raw` for callers outside the
   * dialog that do not supply a separate original.
   */
  original?: string;
  work: string;                // corpus slug (from the dropdown — never free text)
  translator: string;
  license: TranslationMeta['license'];
  year?: number;
  source?: string;
  citation?: string;           // full bibliographic citation; falls back to
                                // composeCitation(translator/year/source) if omitted
  replace?: boolean;           // collision resolution: true = replace existing
  idOverride?: string;         // collision resolution: "keep both" imports under a new id
  /**
   * Emphasis review decisions ImportDialog's interactive queue already
   * collected (marker-review index → 'keep'/'remove'), replayed verbatim by
   * parseTranslationFile instead of its own pattern-based defaults —
   * scanEmphasis is pure, so re-scanning this same `raw` text reproduces the
   * identical review-item indices the dialog saw. Omit for a caller (tests,
   * a non-interactive re-import) that wants the defaults applied instead.
   */
  emphasisChoices?: Map<number, 'keep' | 'remove'>;
  /**
   * 'b.c' -> chapter title map from the PDF converter (Phase 4A's
   * ConvertResult.titles), passed through unchanged by ImportDialog when the
   * source file was a layout extraction. Stored on the ImportRecord verbatim
   * (§getImportTitle); omitted for a plain/hand-tagged import, which has no
   * titles to offer.
   */
  titles?: Record<string, string>;
  /**
   * Bekker citations the aligner must not extrapolate as estimate ticks
   * (seating-pass §2 NOTICK). ImportDialog reads these from the layout file's
   * `noTicks` frontmatter header BEFORE conversion (the frozen converter would
   * fold the header into body text); falls back to the file's own frontmatter
   * when omitted, so a plain hand-tagged import carrying the header still works.
   */
  noTicks?: string[];
  /** Results from ImportDialog's tagged-body review, added to the Done report. */
  preClean?: {
    warnings: string[];
    stripCounts: { folioParagraphs: number; strayHeadingNumerals: number };
  };
  /** Per-import declaration from the Edition step; defaults to every work book. */
  booksCovered?: number[];
  /** One-click R6 waiver. R4 runs first and cannot be waived. */
  waiveDivisionGaps?: boolean;
  /** Publisher preset default. A file's explicit render declaration wins over it. */
  footnotePlacement?: FootnotePlacement;
  /** Absolute per-import Edition override; wins over the file and preset. */
  footnotePlacementOverride?: FootnotePlacement;
}

/** Exact bytes supplied to the `.original` storage slot. */
export function originalForStorage(req: Pick<ImportRequest, 'raw' | 'original'>): string {
  return req.original ?? req.raw;
}

/**
 * Book index → its last chapter number, read off `chapters.json`. Feeds the
 * chapter-key audit: `{1.99}` on a fourteen-chapter book is as unimportable as
 * a book number past the end of the work.
 */
export function lastChapterPerBook(
  chaptersIndex: Record<string, ChapterRef[]>,
): Map<number, number> {
  const out = new Map<number, number>();
  for (const [book, refs] of Object.entries(chaptersIndex)) {
    const bookNum = Number(book);
    if (!Number.isInteger(bookNum) || !refs?.length) continue;
    const numbered = refs.map(ref => Number(ref.chapter)).filter(n => Number.isInteger(n));
    if (numbered.length !== refs.length) continue;   // non-numeric divisions: no bound to give
    out.set(bookNum, Math.max(...numbered));
  }
  return out;
}

// §B3 import summary: "Detected continuous work-level numbering — 222
// footnotes." Undefined (no line at all) when the file carries no footnote
// definitions — most imports don't have a footnotes block, and a summary
// with "0 footnotes" would read as an error rather than simply "not present".
const SCOPE_PHRASE: Record<FootnoteScope, string> = {
  continuous: 'Detected continuous work-level numbering',
  'per-book': 'Detected per-book numbering',
  'per-chapter': 'Detected per-chapter numbering',
};

function footnoteSummaryLine(scope: FootnoteScope, footnotes: Record<string, string>): string | undefined {
  const count = Object.keys(footnotes).length;
  if (count === 0) return undefined;
  return `${SCOPE_PHRASE[scope]} — ${count} footnote${count === 1 ? '' : 's'}.`;
}

export class ImportCollision extends Error {
  constructor(public work: string, public id: string) {
    super(`translation ${id} already exists for ${work}`);
  }
}

export class DivisionGapError extends Error {
  constructor(public audit: DivisionAuditResult) {
    const keys = audit.gaps.map(gap => divisionGapLabel(gap, audit)).join(', ');
    super(
      `The division audit found ${audit.gaps.length} missing chapter`
      + `${audit.gaps.length === 1 ? '' : 's'} inside the declared coverage: ${keys}. `
      + 'Nothing was imported. Check the tags, or use the incomplete-copy waiver.',
    );
  }
}

export async function runImport(
  req: ImportRequest,
  onProgress: (msg: string) => void = () => {},
): Promise<ImportSummary> {
  const workMeta = getWork(req.work);
  if (!workMeta) throw new Error(`unknown work: ${req.work}`);

  onProgress('Scanning tags…');
  const parsed: ParsedTranslation = parseTranslationFile(req.raw, req.emphasisChoices);
  const meta: TranslationMeta = {
    formatVersion: 1,
    work: req.work,
    translator: req.translator,
    license: req.license,
    ...(req.year !== undefined ? { year: req.year } : (parsed.meta.year !== undefined ? { year: parsed.meta.year } : {})),
    ...(req.source ? { source: req.source } : (parsed.meta.source ? { source: parsed.meta.source } : {})),
    language: parsed.meta.language ?? 'en',
    id: req.idOverride ?? parsed.meta.id ?? slugId(req.translator, req.work),
    ...(req.citation ? { citation: req.citation } : (parsed.meta.citation ? { citation: parsed.meta.citation } : {})),
    ...(req.noTicks ?? parsed.meta.noTicks ? { noTicks: req.noTicks ?? parsed.meta.noTicks } : {}),
  };
  // Citations the aligner must not extrapolate (NOTICK) — from the request
  // (ImportDialog peeled the layout header pre-conversion) or, for a plain
  // tagged import, the file's own frontmatter.
  const noTickSet = new Set(req.noTicks ?? parsed.meta.noTicks ?? []);

  if (parsed.density === 'none') {
    throw new Error(
      'No {book.chapter} tags found. The importer needs at least chapter tags '
      + '(e.g. {1.7} before the first word of Book 1 chapter 7) to know where '
      + 'chapters begin — it will not guess chapter boundaries.',
    );
  }

  const { chapters } = splitChapters(parsed);
  if (!chapters.length) throw new Error('No chapters found after the tag scan.');

  // Load chapters once. The resolver validates this same index and supplies
  // both R4's bounds and R6's expected keys.
  const chaptersIndex = await fetchChapters(req.work);
  const structure = await resolveWorkStructure(req.work, chaptersIndex);
  auditChapterKeys(parsed.tags, workMeta.books, {
    bookLabels: workMeta.bookLabels,
    chaptersPerBook: new Map(
      Object.entries(structure.chapterKeysByBook)
        .map(([book, keys]) => [Number(book), keys.length]),
    ),
  });
  const divisionAudit = auditDivisionCoverage(
    parsed.tags,
    structure,
    req.booksCovered ?? Array.from({ length: structure.books }, (_, index) => index + 1),
  );
  if (divisionAudit.gaps.length > 0 && !req.waiveDivisionGaps) {
    throw new DivisionGapError(divisionAudit);
  }
  const waivedDivisionGaps = req.waiveDivisionGaps && divisionAudit.gaps.length
    ? divisionAudit.gaps
    : undefined;

  const s = await store();
  const already = await s.exists(req.work, meta.id);
  if (already && !req.replace) throw new ImportCollision(req.work, meta.id);
  const books = [...new Set(chapters.map(c => c.book))].sort((a, b) => a - b);
  const aligned: ChapterAlignment[] = [];
  const alignment: Record<string, ChapterAlignment> = {};
  const overlaysByBook: Record<string, Record<string, OverlayPiece[]>> = {};
  const emphasisByBook: Record<string, Record<string, PieceEmphasis[]>> = {};
  for (const b of books) {
    onProgress(`Aligning Book ${b} of ${workMeta.books}…`);
    let bookData: BookData;
    try {
      bookData = await fetchBook(req.work, b);
    } catch (e) {
      throw new Error(
        `Could not load Book ${b} of ${workMeta.title} from the corpus (${errorText(e)}). Nothing was imported.`,
      );
    }
    const prose = new Map(
      chapters.filter(c => c.book === b).map(c => [`${c.book}:${c.chapter}`, c.text]),
    );
    const inputs = buildChapterInputs(bookData, chaptersIndex, prose);
    const perBook: ChapterAlignment[] = [];
    for (const input of inputs) {
      const ch = chapters.find(c => c.book === b && String(c.chapter) === input.chapter);
      const ca = alignImportedChapter(input, ch?.tags ?? [], parsed.density, ch?.emphasis ?? [], ch?.footnoteMarkers ?? [], noTickSet);
      perBook.push(ca);
      aligned.push(ca);
      alignment[`${ca.book}:${ca.chapter}`] = ca;
    }
    const emitted = emitOverlayPieces(bookData, perBook);
    overlaysByBook[String(b)] = emitted.pieces;
    emphasisByBook[String(b)] = emitted.emphasis;
  }

  onProgress('Writing library files…');
  const effectiveFootnotePlacement = req.footnotePlacementOverride
    ?? (parsed.noteRender === 'endnote' ? 'endnote' : req.footnotePlacement);
  const effectiveNoteRender = effectiveFootnotePlacement === 'endnote' ? 'endnote' : undefined;
  const record: ImportRecord = {
    meta,
    density: parsed.density,
    warnings: [...parsed.warnings, ...(req.preClean?.warnings ?? [])],
    stats: {
      tagged: aligned.reduce((n, c) => n + c.stats.tagged, 0),
      placed: aligned.reduce((n, c) => n + c.stats.placed, 0),
      interpolated: aligned.reduce((n, c) => n + c.stats.interpolated, 0),
      chapters: aligned.length,
    },
    overlaysByBook,
    emphasisByBook,
    alignment,
    footnotes: parsed.footnotes,
    footnoteScope: parsed.footnoteScope,
    ...(effectiveNoteRender ? { noteRender: effectiveNoteRender } : {}),
    divisionAudit,
    ...(waivedDivisionGaps ? { waivedDivisionGaps } : {}),
    ...(req.titles ? { titles: req.titles } : {}),
  };
  // The canonical file carries the metadata this import actually used — the
  // form's translator/license, a "keep both" id override — never the header
  // the upload happened to arrive with: that header could name another id
  // than the file it is stored under, and a re-import of the exported file
  // would then collide with or masquerade as the original.
  const canonical = serializeFrontmatter(meta) + splitFrontmatter(req.raw).body;
  try {
    await s.write(req.work, meta.id, canonical, originalForStorage(req), record);
  } catch (e) {
    throw new Error(
      `Could not write the library files for “${meta.id}” (${errorText(e)}). Nothing was imported`
      + (already ? '; the previous copy may be partly replaced — import it again to repair it.' : '.'),
    );
  }
  registered.set(`${req.work}/${meta.id}`, record);
  installHooks();

  return {
    meta,
    density: parsed.density,
    footnoteSummary: footnoteSummaryLine(parsed.footnoteScope, parsed.footnotes),
    warnings: record.warnings,
    chapters: record.stats.chapters,
    tagged: record.stats.tagged,
    placed: record.stats.placed,
    interpolated: record.stats.interpolated,
    replaced: already,
    divisionAudit,
    ...(waivedDivisionGaps ? { waivedDivisionGaps } : {}),
    ...(req.preClean ? { stripCounts: req.preClean.stripCounts } : {}),
  };
}
