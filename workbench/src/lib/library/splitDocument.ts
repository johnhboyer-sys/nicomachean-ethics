/**
 * splitDocument — partition a single DOCUMENT-SPINE ChapterFile into multiple
 * standalone chapter/book files at the Book/Chapter boundaries its heading
 * markers define (D8 heading tools → navigable parts). PURE: no I/O; returns
 * the parts, each a fully re-based ChapterFile a caller can serialize + write.
 *
 * Boundary rule (from the work's organization profile, via navRoleOf):
 *   - a row whose heading tier maps to navRole 'book' opens a NEW BOOK
 *     (book++, chapter→1);
 *   - navRole 'chapter' opens a NEW CHAPTER (chapter++);
 *   - the boundary row is the FIRST row of the part it opens;
 *   - 'heading' rows and unmarked rows stay in the current chapter;
 *   - rows before ANY boundary are book 1 / chapter 1 (a leading preface part);
 *   - a boundary on the very FIRST row just labels the first part (no bump).
 *
 * Re-basing per part: row ordinals (headers, paragraph_starts, line_splits
 * refs) become 1-based within the part; span_start/span_end re-derive from the
 * part's row count; footnotes are scoped to the part whose [ENGLISH] rows carry
 * their marker (a footnote anchored in two parts is kept in each). Ids are NOT
 * renumbered — they are stable keys and display numbers recompute, so keeping
 * them keeps every marker resolving. citation_scheme is unchanged; document
 * works carry no column_starts. Each returned file round-trips through
 * serializeChapterFile / parseChapterFile.
 *
 * Only valid for document-spine files (documentOrdinalAddress throws otherwise).
 */

import type { CitationScheme } from '../citation/types';
import { getScheme } from '../citation/registry';
import type { ChapterFile, ChapterFileMeta, Footnote, HeaderMark } from '../chapterfile';
import type { NavRole, WorkProfile } from '../works/profile';
import { navRoleOf } from '../works/profile';
/** One chapter of a document's derived structure — a label, nothing more. */
export interface ChapterSlot {
  label: string;
}

/** One Book of a document's derived structure: a label and its chapters. */
export interface BookStructure {
  label: string;
  chapters: ChapterSlot[];
}
import { documentOrdinalAddress } from './autosave';

export interface DocumentPart {
  book: number;
  chapter: number;
  file: ChapterFile;
}

/** `{^<id>:` footnote-marker opener in a raw [ENGLISH] row string. */
const MARKER_RE = /\{\^(\d+):/g;

/** Footnote ids whose markers appear in the given [ENGLISH] row strings. */
function markerIdsInLines(lines: string[]): Set<number> {
  const ids = new Set<number>();
  for (const line of lines) {
    for (const m of line.matchAll(MARKER_RE)) ids.add(Number(m[1]));
  }
  return ids;
}

/** Trailing integer of an ordinal raw address ("¶5" / "5" → 5); null if none. */
function ordinalOf(raw: string): number | null {
  const m = /(\d+)$/.exec(raw);
  return m ? Number(m[1]) : null;
}

/** One contiguous [start, end) row range and the (book, chapter) it becomes. */
interface Segment {
  book: number;
  chapter: number;
  start: number; // inclusive, 0-based
  end: number; // exclusive, 0-based
}

function segment(file: ChapterFile, profile: WorkProfile): Segment[] {
  const rowCount = file.greekLines.length;
  const levelByRow = new Map<number, number>();
  for (const h of file.meta.headers ?? []) levelByRow.set(h.row, h.level);

  // Only 'book'/'chapter' open a part; 'heading' and 'subtitle' stay in-chapter.
  const navAt = (ordinal: number): NavRole | null => {
    const level = levelByRow.get(ordinal);
    return level === undefined ? null : navRoleOf(profile, level);
  };

  const segs: Segment[] = [];
  let book = 1;
  let chapter = 1;
  let start = 0;
  // Row 0 (ordinal 1) never splits — a boundary there just labels the first
  // part. Every later row that is a book/chapter boundary closes the run.
  for (let i = 1; i < rowCount; i++) {
    const nav = navAt(i + 1);
    if (nav === 'book' || nav === 'chapter') {
      segs.push({ book, chapter, start, end: i });
      if (nav === 'book') {
        book += 1;
        chapter = 1;
      } else {
        chapter += 1;
      }
      start = i;
    }
  }
  segs.push({ book, chapter, start, end: rowCount });
  return segs;
}

function rebase(file: ChapterFile, scheme: CitationScheme, seg: Segment): ChapterFile {
  const { book, chapter, start, end } = seg;
  const n = end - start;

  const greekLines = file.greekLines.slice(start, end);
  const englishLines = file.englishLines.slice(start, end);
  const paraSlice = file.englishParaLines?.slice(start, end);
  // serializeChapterFile omits an all-empty [ENGLISH.PARA]; only carry the
  // section when some row has paragraph text (matches autosave's own rule, so
  // the part round-trips without a phantom section).
  const englishParaLines = paraSlice?.some((l) => l.length > 0) ? paraSlice : undefined;

  const headers: HeaderMark[] = (file.meta.headers ?? [])
    .filter((h) => h.row >= start + 1 && h.row <= end)
    .map((h) => ({ row: h.row - start, level: h.level }));

  const paragraphStarts = file.meta.paragraphStarts
    ?.filter((p) => p >= start + 1 && p <= end)
    .map((p) => p - start);

  // A source import's rows carry the source's own citations; a part keeps its
  // slice of them, and its spans and split refs are those addresses rather
  // than re-based ordinals (they are what hydration labels the rows with).
  const rowRefs = file.meta.rowRefs?.slice(start, end);
  const refRow = (ref: string): number | null => {
    if (!file.meta.rowRefs) return null;
    const at = file.meta.rowRefs.indexOf(ref);
    return at >= 0 ? at + 1 : null;
  };

  const lineSplits = file.meta.lineSplits
    ?.map((ls) => {
      const g = rowRefs ? refRow(ls.ref) : ordinalOf(ls.ref);
      if (g === null || g < start + 1 || g > end) return null;
      return { ref: rowRefs ? ls.ref : documentOrdinalAddress(scheme, g - start).raw, offset: ls.offset };
    })
    .filter((x): x is { ref: string; offset: number } => x !== null);

  // Heading title overrides are per row like the other sections; dropping
  // them printed the translation where the rail shows "Objection 2".
  const titleSlice = file.headingTitleLines?.slice(start, end);
  const headingTitleLines = titleSlice?.some((t) => t.length > 0) ? titleSlice : undefined;

  const ids = markerIdsInLines(englishLines);
  const footnotes: Footnote[] = file.footnotes.filter((f) => ids.has(f.id));

  const meta: ChapterFileMeta = {
    schemaVersion: file.meta.schemaVersion,
    work: file.meta.work,
    book,
    chapter,
    citationScheme: file.meta.citationScheme,
    spanStart: n > 0 ? (rowRefs ? rowRefs[0] : documentOrdinalAddress(scheme, 1).raw) : '',
    spanEnd: n > 0 ? (rowRefs ? rowRefs[n - 1] : documentOrdinalAddress(scheme, n).raw) : '',
    // document works carry no column_starts; key order below mirrors
    // parseChapterFile's meta construction (round-trip self-check compares JSON).
    ...(rowRefs && rowRefs.length > 0 ? { rowRefs } : {}),
    ...(lineSplits && lineSplits.length > 0 ? { lineSplits } : {}),
    ...(paragraphStarts && paragraphStarts.length > 0 ? { paragraphStarts } : {}),
    ...(headers.length > 0 ? { headers } : {}),
  };

  return {
    meta,
    greekLines,
    englishLines,
    ...(englishParaLines ? { englishParaLines } : {}),
    ...(headingTitleLines ? { headingTitleLines } : {}),
    footnotes,
  };
}

/**
 * Split a document-spine ChapterFile into its Book/Chapter parts. With no
 * book/chapter markers the result is a single part {book:1, chapter:1} whose
 * content mirrors the input. An empty file yields one empty book-1/chapter-1
 * part (defensive — a well-formed document file has ≥1 row).
 */
export function splitDocument(file: ChapterFile, profile: WorkProfile): DocumentPart[] {
  const scheme = getScheme(file.meta.citationScheme);
  if (file.greekLines.length === 0) {
    return [{ book: 1, chapter: 1, file: rebase(file, scheme, { book: 1, chapter: 1, start: 0, end: 0 }) }];
  }
  return segment(file, profile).map((seg) => ({
    book: seg.book,
    chapter: seg.chapter,
    file: rebase(file, scheme, seg),
  }));
}

/**
 * The explicit Book/Chapter container structure a document's markers imply —
 * the registry counterpart of splitDocument (the SAME segment() boundary walk,
 * so the labels line up 1:1 with the files it produces). `labelOf(rowIndex)`
 * supplies a boundary row's display text (the caller passes the outline label:
 * heading title override → translation → original). A Book takes its label from
 * the 'book' row that opens it; a Chapter from the 'chapter' row that opens it;
 * anything unlabeled (a leading preface, a book's first chapter opened only by
 * the book row) falls back to "Book N" / "Chapter N".
 */
export function documentBookStructure(
  file: ChapterFile,
  profile: WorkProfile,
  labelOf: (rowIndex: number) => string,
): BookStructure[] {
  const levelByRow = new Map<number, number>();
  for (const h of file.meta.headers ?? []) levelByRow.set(h.row, h.level);
  const navAtRow = (row0: number): NavRole | null => {
    const level = levelByRow.get(row0 + 1);
    return level === undefined ? null : navRoleOf(profile, level);
  };

  const books: BookStructure[] = [];
  for (const seg of segment(file, profile)) {
    while (books.length < seg.book) books.push({ label: '', chapters: [] });
    const book = books[seg.book - 1];
    const role = navAtRow(seg.start);
    if (role === 'book' && book.label.length === 0) book.label = labelOf(seg.start).trim();
    book.chapters.push({ label: role === 'chapter' ? labelOf(seg.start).trim() : '' });
  }
  books.forEach((b, bi) => {
    if (b.label.length === 0) b.label = `Book ${bi + 1}`;
    b.chapters.forEach((c, ci) => {
      if (c.label.length === 0) c.label = `Chapter ${ci + 1}`;
    });
  });
  return books;
}
