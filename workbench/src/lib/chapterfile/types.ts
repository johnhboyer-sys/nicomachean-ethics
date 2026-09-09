/**
 * Types for the chapter save format — the app's canonical user data.
 * See workbench-design/d2-citation-schemes.md "Chapter-file frontmatter".
 */

import type { SchemeId } from '../citation/types';

/**
 * One `<columnRef>@<rowIndex>` pair from the frontmatter `column_starts`
 * field. `ref` is the FULL raw address (column + line) of the first row of a
 * column segment — the first pair's ref equals span_start (so it carries the
 * chapter's starting line); later pairs carry the actual first line of each
 * new column (usually 1, but never assumed). `rowIndex` is 1-based.
 */
export interface ColumnStart {
  ref: string;
  rowIndex: number;
}

/**
 * One `<address>@<offset>` pair from the frontmatter `line_splits` field
 * (design doc D6 — paragraph splits inside a Bekker line). `ref` is the
 * OPAQUE raw address of the split row — validated only via
 * `scheme.parseAddress`, never compared or ordered outside citation/.
 * `offset` is a Greek CODE-UNIT index into that row's [GREEK] line — the
 * same `.length`/`.slice` basis as everything else in this file format (see
 * `isValidSplitOffset` in parse.ts before "fixing" this to code points).
 */
export interface LineSplit {
  ref: string;
  offset: number;
}

export interface ChapterFileMeta {
  schemaVersion: number;
  work: string;
  book: number;
  chapter: number;
  citationScheme: SchemeId;
  spanStart: string;
  spanEnd: string;
  /**
   * OPTIONAL self-contained per-row addressing (frontmatter `column_starts`).
   * Absent in older files — every consumer must handle absence. When present:
   * rows `rowIndex..next.rowIndex-1` live in the segment's column, line
   * numbers incrementing by 1 per row from the segment ref's line (see
   * `rowAddress`).
   */
  columnStarts?: ColumnStart[];
  /**
   * OPTIONAL explicit per-row addresses (frontmatter `row_refs`), one entry
   * per row in row order. Written by source imports (TLG/PHI, Perseus),
   * where the addresses are the SOURCE's own citations and follow no
   * derivable pattern: "1.1, 1.2, 2.1" restarts, and "17a, 17b" ends in a
   * letter, so neither the ordinal derivation nor `column_starts`
   * run-length encoding (which requires a trailing line number) can express
   * them.
   *
   * Absent in every file that doesn't need it — including all older files —
   * so every consumer must handle absence. Length must equal the row count;
   * that is checked at parse, alongside the other cross-section checks.
   */
  rowRefs?: string[];
  /**
   * OPTIONAL paragraph-split points (frontmatter `line_splits`), design doc
   * D6. Absent in unsplit files — every consumer must handle absence. The
   * parser checks STRUCTURE only (pair shape, scheme-parseable refs, positive
   * strictly-ascending offsets per address) and keeps the pairs verbatim so
   * serialization is byte-stable; whether an offset actually lands inside —
   * and at a word boundary of — its row's Greek is validated at HYDRATION
   * (library/autosave.ts), where a drifted split degrades to an unsplit line
   * with a notice instead of refusing the file.
   */
  lineSplits?: LineSplit[];
  /**
   * OPTIONAL visual paragraph grouping for plain-line document-spine works
   * (frontmatter `paragraph_starts`): 1-based row ordinals that begin a
   * paragraph group. Meaningful only for line-segmented corpus-free imports.
   */
  paragraphStarts?: number[];
  /**
   * OPTIONAL heading roles for document-spine works (frontmatter `headers`,
   * D8 heading tools): the rows the user has marked as a heading/section title
   * and their level. Absent = no headings. Like `paragraphStarts` this is
   * lenient display metadata; out-of-range/duplicate/junk entries degrade at
   * parse (sanitizeHeaders) instead of refusing the file.
   */
  headers?: HeaderMark[];
}

/**
 * A row's heading LEVEL in a document-spine work (D8 heading tools): a 1-based
 * rank into the work's organization profile (works/profile.ts), level 1 being
 * the top tier. Absent = an ordinary content row. Headings stay TRANSLATABLE
 * (both columns keep their text); the level only changes how the row renders
 * (as a title, out of the flowing views), how deep it nests in the outline,
 * and — via the profile's navRole — whether it anchors a book/chapter boundary.
 */
export type RowHeaderLevel = number;

/**
 * One `<rowOrdinal>:<level>` pair from the frontmatter `headers` field: the
 * 1-based row ordinal that carries a heading and its 1-based level rank. Like
 * `paragraph_starts` this is OPTIONAL, LENIENT display metadata — a malformed
 * value degrades (see sanitizeHeaders) rather than refusing the file.
 */
export interface HeaderMark {
  row: number;
  level: RowHeaderLevel;
}

export interface Footnote {
  id: number;
  body: string;
}

export interface ChapterFile {
  meta: ChapterFileMeta;
  greekLines: string[];
  englishLines: string[];
  /** Optional paragraph-granularity translation layer, one physical line per row. */
  englishParaLines?: string[];
  /**
   * Optional per-row heading TITLE OVERRIDE (D8 heading tools, `[HEADING_TITLES]`
   * section): one physical line per row, blank when the row has no override.
   * When present it is what the rail outline shows for that heading instead of
   * its translation — lets a long marked paragraph carry a clean short title
   * ("Objection 2") without touching its content. Present only when at least
   * one row carries a title; 1:1 with the rows like englishParaLines.
   */
  headingTitleLines?: string[];
  footnotes: Footnote[];
  /**
   * True when frontmatter `paragraph_starts` carried entries the parser had
   * to drop or reorder (junk tokens, zero/negative, duplicates, out of
   * range). paragraph_starts is optional DISPLAY metadata, so a malformed
   * value degrades leniently instead of refusing the file (D6 drift
   * convention); hydration surfaces this flag as a one-line notice. Never
   * set by serialization-side construction — parse-only.
   */
  paragraphStartsSanitized?: boolean;
}

/**
 * How library/splitDocument.ts's rebase carries a field of a whole-document
 * file into each Book/Chapter part. EVERY field of ChapterFile and
 * ChapterFileMeta is classified here, and the `satisfies` clauses make tsc
 * refuse a new field until it is: rebase hand-listed its sections and twice
 * shipped without one (englishParaLines, then headingTitleLines and rowRefs),
 * each time printing the wrong text or refusing the part at round-trip.
 *
 *   'per-row'           an array with one entry per row, in row order, that a
 *                       file always carries; a part takes its slice
 *   'per-row-optional'  the same, but the section rides along only when some
 *                       row of the slice is non-empty (serializeChapterFile
 *                       omits an all-empty optional section, so carrying one
 *                       would give the part a phantom section at round-trip)
 *   'by-ordinal'        entries name rows by 1-based ordinal (or, for
 *                       line_splits, by address); rebase filters and re-bases
 *                       them BY NAME, because each has its own shape
 *   'whole'             not row-shaped: copied, set per part (book, chapter),
 *                       re-derived (spans), scoped by marker (footnotes), or
 *                       parse-only and never written
 *
 * rebase slices every 'per-row' / 'per-row-optional' field generically from
 * these tables, in this declaration order.
 */
export type RebaseRule = 'per-row' | 'per-row-optional' | 'by-ordinal' | 'whole';

export const CHAPTER_FILE_RULES = {
  meta: 'whole',
  greekLines: 'per-row',
  englishLines: 'per-row',
  englishParaLines: 'per-row-optional',
  headingTitleLines: 'per-row-optional',
  footnotes: 'whole',
  paragraphStartsSanitized: 'whole',
} as const satisfies Record<keyof ChapterFile, RebaseRule>;

export const CHAPTER_FILE_META_RULES = {
  schemaVersion: 'whole',
  work: 'whole',
  book: 'whole',
  chapter: 'whole',
  citationScheme: 'whole',
  spanStart: 'whole',
  spanEnd: 'whole',
  columnStarts: 'whole',
  rowRefs: 'per-row-optional',
  lineSplits: 'by-ordinal',
  paragraphStarts: 'by-ordinal',
  headers: 'by-ordinal',
} as const satisfies Record<keyof ChapterFileMeta, RebaseRule>;

export function isPerRowRule(rule: RebaseRule): boolean {
  return rule === 'per-row' || rule === 'per-row-optional';
}

/** The keys of T whose rule in R is one of the per-row kinds. */
export type PerRowKeys<T, R extends Record<keyof T, RebaseRule>> = {
  [K in keyof T]-?: R[K] extends 'per-row' | 'per-row-optional' ? K : never;
}[keyof T];

/** Thrown by parseChapterFile on any validation failure. Message is plain-language and line-numbered where applicable. */
export class ChapterFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChapterFileError';
  }
}
