// Autosave — ChapterModel ⇄ chapter file (design docs D1 §Model + D2
// §Chapter-file frontmatter). This is user-data persistence: correctness over
// speed, and nothing the user typed may ever be silently lost.
//
// Save path:  ChapterModel → ChapterFile → chapter-file string, written via
// libraryStorage().write(workId, chapterFileName(book, chapter), content).
// Frontmatter carries schema_version 1 + work/book/chapter/citation_scheme +
// span_start/span_end (raw address strings) + column_starts (self-contained
// per-row addressing computed from the model's real row addresses; omitted
// when the addresses can't be represented exactly — see
// columnStartsFromModel) + line_splits (paragraph splits inside a Bekker
// line, design doc D6 — emitted from the rows' splitOffsets); [GREEK] is the
// model's greek lines verbatim; [ENGLISH] is serialize.ts row markup per row
// (a split row's segments joined by the structural `¶` token); [FOOTNOTES]
// is chapter-local `id: body-markup` entries (ALL footnotes, anchored or not
// — an unanchored body is recoverable user data, dropping it would be loss).
//
// Load path: on chapter open, read + parse the file if present; the FILE is
// canonical — its Greek wins over the corpus spine (quiet notice when they
// differ). English rows hydrate through the serialize.ts parser; footnote
// anchored-ness is derived from marker presence in the hydrated rows'
// SENTENCE layer only (footnotes are a sentence-layer feature — D8 v1 rule;
// [ENGLISH.PARA] marker markup is stripped on load, phrase text kept).
// line_splits SEMANTIC validation happens here (the parser checks structure
// only): a well-formed but drifted split — offset out of the row's Greek
// range, not at a word boundary, or an address no row carries — never blocks
// the load; that line hydrates UNSPLIT with its English segments rejoined by
// a single space and a one-sentence notice on the same channel as the
// Greek-drift notices (d6 divergence E). On any ¶-count vs offset-count
// skew, the ENGLISH count wins: segments are never dropped; offsets beyond
// the segments are.
//
// Scheduling: every model commit calls markDirty() (debounced ~1s); chapter
// switch / window blur / visibilitychange→hidden call flush(). Writes are
// single-flight per controller and registered in a module-level pending-write
// table so re-opening a chapter can await an in-flight write before reading
// (leave Ζ.17 → instantly reopen Ζ.17 must never read a stale file).

import type { Address, CitationScheme, SchemeId } from '../citation/types';
import { getScheme } from '../citation/registry';
import type { ChapterModel, Footnote as ModelFootnote, RowModel } from '../editor/model';
import { englishDocsOf, hasParagraphEnglish } from '../editor/model';
import { docFromJSON, markerIdsIn } from '../editor/schema';
import {
  serializeRow,
  serializeRowSegments,
  parseRow,
  parseRowSegments,
  joinRowDocs,
  stripFootnoteMarkup,
  encodeParaLine,
  decodeParaLine,
} from '../editor/serialize';
import { parseChapterFile, serializeChapterFile, rowAddress, isValidSplitOffset, ChapterFileError } from '../chapterfile';
import type { ChapterFile, ColumnStart, HeaderMark, LineSplit } from '../chapterfile';
import { libraryStorage } from './storage';
import type { LibraryStorage } from './storage';

// ── model → file ────────────────────────────────────────────────────────────

export interface ChapterSpans {
  start: string;
  end: string;
}

/** span_start/span_end from the model's row addresses (first/last row). */
export function spansFromModel(model: ChapterModel): ChapterSpans {
  const scheme = getScheme(model.scheme);
  if (scheme.spineSource === 'document') {
    if (model.rows.length === 0) return { start: '', end: '' };
    return {
      start: documentOrdinalAddress(scheme, 1).raw,
      end: documentOrdinalAddress(scheme, model.rows.length).raw,
    };
  }
  const first = model.rows[0]?.address.raw ?? '';
  const last = model.rows[model.rows.length - 1]?.address.raw ?? '';
  return { start: first, end: last };
}

/**
 * Ordinal-derived address for a DOCUMENT-SPINE row (D8 §1: `¶N` / `N` from
 * the 1-based row ordinal — never persisted). Exported for the editor's
 * structure-editing path (D8 §2): a row splice shifts every following
 * ordinal, so the model's addresses are re-derived through this after each
 * split/merge/undo — the same derivation every save and hydration uses.
 */
export function documentOrdinalAddress(scheme: CitationScheme, rowIndex: number): Address {
  if (!Number.isInteger(rowIndex) || rowIndex <= 0) {
    throw new ChapterFileError(`rowAddressSource: row index ${rowIndex} is out of range`);
  }
  let raw: string;
  switch (scheme.gutter.rowUnit) {
    case 'paragraph':
      raw = `¶${rowIndex}`;
      break;
    case 'plain-line':
      raw = String(rowIndex);
      break;
    default:
      throw new ChapterFileError(
        `rowAddressSource: document-spine scheme "${scheme.id}" cannot derive ordinal addresses for row unit "${scheme.gutter.rowUnit}"`,
      );
  }
  return scheme.parseAddress(raw);
}

export type RowAddressProvider = (rowIndex: number) => Address;

/**
 * Per-row address source for hydrated files, in precedence order:
 * column_starts exact reconstruction, corpus spine fallback, document-owned
 * synthetic ordinal addresses.
 */
export function rowAddressSource(
  meta: ChapterFile['meta'],
  spine: SpineRow[],
  scheme: CitationScheme,
): RowAddressProvider {
  // Explicit per-row addresses from a source import win outright: they ARE
  // the source's citations, and nothing can re-derive them.
  const refs = meta.rowRefs;
  if (refs) {
    return (rowIndex: number) => {
      const raw = refs[rowIndex - 1];
      if (raw === undefined) {
        throw new ChapterFileError(`rowAddressSource: row index ${rowIndex} is out of range for row_refs (${refs.length} row(s))`);
      }
      return scheme.parseAddress(raw);
    };
  }
  if (meta.columnStarts) {
    return (rowIndex: number) => scheme.parseAddress(rowAddress(meta, rowIndex));
  }
  if (scheme.spineSource === 'corpus') {
    return (rowIndex: number) => spine[rowIndex - 1]?.address ?? { scheme: scheme.id, raw: '' };
  }
  return (rowIndex: number) => documentOrdinalAddress(scheme, rowIndex);
}

/**
 * Presentation-level split of a raw address string: trailing digits = line,
 * prefix = column ("1041a6" → column "1041a", line 6). This is textual
 * slicing of the shape the whole app already treats raws as having — NOT
 * citation math (citation/'s parsed structs stay private to citation/).
 * Returns null for raws without a digit suffix (e.g. the '' addresses that
 * hydration assigns to rows beyond the corpus spine).
 */
export function splitRaw(raw: string): { column: string; line: number } | null {
  const m = /^(.*\D)(\d+)$/.exec(raw);
  if (m === null) return null;
  return { column: m[1], line: Number(m[2]) };
}

/**
 * frontmatter column_starts from the model's REAL row addresses: the first
 * row's full address @1, plus the full address of each row whose column part
 * differs from the previous row's. Returns undefined — save the file WITHOUT
 * column_starts, which every consumer must handle — whenever the pairs could
 * not reproduce every row address exactly:
 *   - no rows;
 *   - a row address that doesn't split (raw '' on spine-count drift);
 *   - rows[0] differing from the span actually written (span drift — the
 *     parser requires first ref === span_start);
 *   - line numbers not incrementing by 1 per row within a column segment.
 * When it does return pairs, rowAddress(meta, i+1) === rows[i].address.raw
 * for every row — checked here, so a written column_starts is exact by
 * construction.
 */
export function columnStartsFromModel(model: ChapterModel, spans: ChapterSpans = spansFromModel(model)): ColumnStart[] | undefined {
  if (model.rows.length === 0) return undefined;
  if (model.rows[0].address.raw !== spans.start) return undefined;

  const parts: { column: string; line: number }[] = [];
  for (const row of model.rows) {
    const split = splitRaw(row.address.raw);
    if (split === null) return undefined;
    parts.push(split);
  }

  const starts: ColumnStart[] = [{ ref: model.rows[0].address.raw, rowIndex: 1 }];
  for (let i = 1; i < parts.length; i++) {
    if (parts[i].column !== parts[i - 1].column) {
      starts.push({ ref: model.rows[i].address.raw, rowIndex: i + 1 });
    }
  }

  // Exactness check: segment arithmetic must reproduce every row address.
  let seg = 0;
  let segLine = parts[0].line;
  for (let i = 0; i < parts.length; i++) {
    if (seg + 1 < starts.length && starts[seg + 1].rowIndex === i + 1) {
      seg += 1;
      segLine = parts[i].line;
    }
    const expected = `${parts[starts[seg].rowIndex - 1].column}${segLine + (i + 1 - starts[seg].rowIndex)}`;
    if (expected !== model.rows[i].address.raw) return undefined;
  }
  return starts;
}

/**
 * The rows' own addresses, for a document-spine model whose addresses are NOT
 * its ordinals — a source import, whose rows carry the source's citations
 * ("184a.10", "205a.25,29", "1.327a"). Nothing can re-derive those: a save that
 * dropped them turned the Physics into lines 1…5520 on the next open, and with
 * them went the outline's chapter divisions and the export's reference stamps.
 * Undefined when every address is the ordinal (paragraph / plain-line
 * documents, or an import whose source numbered its lines 1, 2, 3 — those
 * files stay exactly as they were) or when any row has no usable address.
 */
function sourceRowRefs(model: ChapterModel, scheme: CitationScheme): string[] | undefined {
  if (scheme.spineSource !== 'document' || model.rows.length === 0) return undefined;
  let ordinal = true;
  const refs: string[] = [];
  for (let i = 0; i < model.rows.length; i++) {
    const raw = model.rows[i].address.raw;
    if (raw === '') return undefined;
    try {
      scheme.parseAddress(raw);
    } catch {
      return undefined;
    }
    if (ordinal && raw !== documentOrdinalAddress(scheme, i + 1).raw) ordinal = false;
    refs.push(raw);
  }
  return ordinal ? undefined : refs;
}

export function chapterFileFromModel(model: ChapterModel, spans: ChapterSpans = spansFromModel(model)): ChapterFile {
  const scheme = getScheme(model.scheme);
  const rowRefs = sourceRowRefs(model, scheme);
  const effectiveSpans =
    rowRefs !== undefined
      ? { start: rowRefs[0], end: rowRefs[rowRefs.length - 1] }
      : scheme.spineSource === 'document'
        ? spansFromModel(model)
        : spans;
  const footnotes = [...model.footnotes]
    .map((fn) => {
      const id = Number(fn.id);
      if (!Number.isInteger(id) || id <= 0) {
        // Should be unreachable (ids come from nextFootnoteId); fail loudly
        // rather than write a file the parser will reject.
        throw new Error(`autosave: footnote id ${JSON.stringify(fn.id)} is not a positive integer`);
      }
      return { id, body: fn.body };
    })
    .sort((a, b) => a.id - b.id);

  const columnStarts = scheme.spineSource === 'document' ? undefined : columnStartsFromModel(model, effectiveSpans);

  // line_splits from the rows' splitOffsets (design doc D6). A raw ''
  // address (hydration's spine-drift filler) can't carry a ref the parser
  // accepts; its offsets are skipped — the `¶` English segments still save,
  // so on reload the prose survives as anchorless segments with a notice
  // (English is never lost; only the Greek anchor is). Any OTHER
  // unrepresentable address fails the round-trip self-check loudly instead
  // of writing a corrupt file.
  const lineSplits: LineSplit[] = [];
  for (let i = 0; i < model.rows.length; i++) {
    const row = model.rows[i];
    if (!row.splitOffsets || row.splitOffsets.length === 0) continue;
    // A split's ref must be the label hydration will give the row: the
    // ordinal for a document spine without row_refs, the row's own address
    // otherwise (with row_refs, rowRefs[i] IS row.address.raw — see
    // sourceRowRefs; for a corpus spine the address is the label).
    const ref =
      scheme.spineSource === 'document' && rowRefs === undefined ? documentOrdinalAddress(scheme, i + 1).raw : row.address.raw;
    if (ref === '') continue;
    for (const offset of row.splitOffsets) {
      lineSplits.push({ ref, offset });
    }
  }

  // Footnotes are a sentence-layer feature (D8 v1 rule — see
  // editor/serialize.ts stripFootnoteRuns): a marker that reached the live
  // paragraph layer anyway (paste) is stripped here at the save boundary —
  // phrase text kept, decoration dropped — so [ENGLISH.PARA] on disk never
  // carries marker markup that hydration/export would have to ignore. The
  // section rides along only when a STRIPPED line is non-empty (a marker-only
  // para doc strips to nothing; serializeChapterFile would omit the all-empty
  // section, so including it here would fail the round-trip self-check).
  const strippedParaLines = model.rows.some(hasParagraphEnglish)
    ? model.rows.map((r) =>
        r.englishPara ? encodeParaLine(serializeRow(stripFootnoteMarkup(docFromJSON(r.englishPara)))) : '',
      )
    : undefined;
  const englishParaLines = strippedParaLines?.some((line) => line.length > 0) ? strippedParaLines : undefined;

  // Heading roles (D8 heading tools) → chapter-file `headers` (row:level).
  // Derived from the rows' role, so the round-trip mirrors hydration exactly.
  const headers: HeaderMark[] = [];
  model.rows.forEach((r, i) => {
    if (r.headingLevel) headers.push({ row: i + 1, level: r.headingLevel });
  });

  // Heading title overrides → chapter-file `[HEADING_TITLES]` (one line per row,
  // blank when none; newlines flattened so the 1-line-per-row invariant holds).
  // Only emitted when some row carries a title (serializeChapterFile drops an
  // all-empty section, so an unconditional array would fail the self-check).
  const headingTitles = model.rows.map((r) => (r.headingTitle ?? '').replace(/[\r\n]+/g, ' '));
  const headingTitleLines = headingTitles.some((t) => t.length > 0) ? headingTitles : undefined;

  return {
    meta: {
      schemaVersion: 1,
      work: model.workId,
      book: model.book,
      chapter: model.chapter,
      citationScheme: model.scheme,
      spanStart: effectiveSpans.start,
      spanEnd: effectiveSpans.end,
      // Key order and present/absent-ness must match parseChapterFile's meta
      // construction — the round-trip self-check compares JSON shapes.
      ...(columnStarts ? { columnStarts } : {}),
      ...(rowRefs !== undefined ? { rowRefs } : {}),
      ...(lineSplits.length > 0 ? { lineSplits } : {}),
      // paragraph_starts rides along verbatim (D8 §5 grouping metadata —
      // dropping it on the first autosave would silently lose the import's
      // blank-line grouping). Key order matches parseChapterFile's meta.
      ...(model.paragraphStarts && model.paragraphStarts.length > 0
        ? { paragraphStarts: model.paragraphStarts }
        : {}),
      // headers rides last, matching parseChapterFile's meta key order.
      ...(headers.length > 0 ? { headers } : {}),
    },
    greekLines: model.rows.map((r) => r.greek),
    englishLines: model.rows.map((r) => serializeRowSegments(englishDocsOf(r))),
    ...(englishParaLines ? { englishParaLines } : {}),
    ...(headingTitleLines ? { headingTitleLines } : {}),
    footnotes,
  };
}

/**
 * Serialize the model to the chapter-file string (the save payload), with a
 * round-trip self-check: the string is parsed back and compared before it is
 * ever handed to storage. On mismatch this THROWS — the autosave controller
 * keeps the model dirty and the last good file untouched, so a formatting
 * edge can delay a save but can never corrupt one.
 *
 * Emission goes through chapterfile's serializeChapterFile, which now emits
 * the structural blank line between sections in the exact shape
 * parseChapterFile expects (the former private emitter here existed only to
 * paper over that gap; trailing empty [ENGLISH] rows round-trip by
 * construction). The self-check stays regardless — it is the last line of
 * defense for user data.
 */
export function serializeModel(model: ChapterModel, spans?: ChapterSpans): string {
  const doc = chapterFileFromModel(model, spans);
  const content = serializeChapterFile(doc);
  const back = parseChapterFile(content, 'autosave-selfcheck');
  const shape = (d: ChapterFile) => JSON.stringify([d.meta, d.greekLines, d.englishLines, d.englishParaLines, d.footnotes]);
  if (shape(back) !== shape(doc)) {
    throw new Error('autosave: serialized chapter file does not round-trip through the parser — save aborted, nothing written');
  }
  return content;
}

/** Distinct anchored-marker count across the model's rows (index ride-along). */
export function anchoredFootnoteCount(model: ChapterModel): number {
  const ids = new Set<string>();
  for (const row of model.rows) {
    // Walk SENTENCE-layer segments in document order — a marker can live in a
    // continuation segment of a split row (design doc D6). The paragraph
    // layer is excluded: footnotes are sentence-layer-only (D8 v1 rule), so a
    // pasted para-layer marker must not bump the work-wide numbering base.
    for (const doc of englishDocsOf(row)) {
      for (const id of markerIdsIn(docFromJSON(doc))) ids.add(id);
    }
  }
  return ids.size;
}

// ── file → model (hydration) ────────────────────────────────────────────────

export interface SpineRow {
  address: Address;
  greek: string;
}

export interface HydrationResult {
  rows: RowModel[];
  footnotes: ModelFootnote[];
  /** Spans subsequent saves should carry (row addresses; file meta on row-count drift). */
  spans: ChapterSpans;
  /** paragraph_starts from the file, for the model to carry (D8 §5). */
  paragraphStarts?: number[];
  /**
   * Quiet notice when the file disagrees with the corpus spine and/or a
   * stored paragraph split drifted (one plain sentence per problem, joined by
   * spaces — the same single channel for all of them).
   */
  notice: string | null;
}

/** The d6 divergence-E drift sentence, verbatim. */
function splitDriftNotice(address: string): string {
  return `A paragraph split in line ${address} didn't line up with the Greek and was removed — re-split if you still want it.`;
}

/**
 * Hydrate a parsed chapter file against the incoming corpus spine. The file
 * is canonical: its Greek (and, on drift, even its row count) wins — the
 * corpus supplies row ADDRESSES where the counts line up.
 *
 * Paragraph splits (design doc D6): [ENGLISH] rows hydrate through
 * parseRowSegments (1..N segment docs per row) and line_splits offsets are
 * validated SEMANTICALLY here, against the file's OWN Greek — see the module
 * header for the drift policy this implements. Refs are mapped to rows via
 * the file's own addressing (column_starts arithmetic — it travels with the
 * file, exactly like the Greek the offsets index), falling back to the
 * corpus spine's addresses for older files without column_starts.
 */
export function hydrateFromFile(file: ChapterFile, spine: SpineRow[], scheme: SchemeId): HydrationResult {
  const schemeDef = getScheme(scheme);
  const fileCount = file.greekLines.length;
  const addressOfRow = rowAddressSource(file.meta, spine, schemeDef);

  // Per-row address labels for line_splits mapping and notices (file's own
  // addressing first, spine fallback; '' when neither can say).
  const rowLabels: string[] = [];
  const rowIndexByLabel = new Map<string, number>();
  for (let i = 0; i < fileCount; i++) {
    let label = '';
    try {
      label = addressOfRow(i + 1).raw;
    } catch {
      label = '';
    }
    rowLabels.push(label);
    if (label !== '' && !rowIndexByLabel.has(label)) rowIndexByLabel.set(label, i);
  }

  // Group line_splits offsets by row. A ref no row carries is drift — the
  // split is dropped with the notice (there is no line to split).
  const splitNotices: string[] = [];
  const noticedLabels = new Set<string>();
  const noteDrift = (label: string) => {
    if (noticedLabels.has(label)) return;
    noticedLabels.add(label);
    splitNotices.push(splitDriftNotice(label));
  };
  const offsetsByRow = new Map<number, number[]>();
  for (const split of file.meta.lineSplits ?? []) {
    const rowIdx = rowIndexByLabel.get(split.ref);
    if (rowIdx === undefined) {
      noteDrift(split.ref);
      continue;
    }
    const list = offsetsByRow.get(rowIdx);
    if (list) list.push(split.offset);
    else offsetsByRow.set(rowIdx, [split.offset]);
  }

  const rows: RowModel[] = [];
  for (let i = 0; i < fileCount; i++) {
    let address: Address;
    if (schemeDef.spineSource === 'document') {
      try {
        address = addressOfRow(i + 1);
      } catch {
        address = { scheme, raw: '' };
      }
    } else {
      address = i < spine.length ? spine[i].address : { scheme, raw: '' };
    }
    const greek = file.greekLines[i];
    const segments = parseRowSegments(file.englishLines[i]);
    // Paragraph-layer markers never become live footnotes (D8 v1 rule —
    // sentence layer only; see editor/serialize.ts stripFootnoteRuns): any
    // `{^id:phrase}` a paste or hand edit left in [ENGLISH.PARA] hydrates as
    // plain "phrase" — surrounding text lossless, decoration dropped — so the
    // panel/delete/renumber paths (sentence-layer scans) and this hydration
    // agree. A marker-only para line strips to an empty doc → no para layer.
    const englishParaLine = file.englishParaLines?.[i];
    const englishParaDoc =
      englishParaLine !== undefined && englishParaLine.length > 0
        ? stripFootnoteMarkup(parseRow(decodeParaLine(englishParaLine)))
        : undefined;
    const englishPara = englishParaDoc && englishParaDoc.content.size > 0 ? englishParaDoc.toJSON() : undefined;
    let offsets = offsetsByRow.get(i) ?? [];
    const label = rowLabels[i] !== '' ? rowLabels[i] : address.raw;

    // Drift policy (d6 divergence E): any offset out of the file's own Greek
    // range or off a word boundary un-splits the WHOLE line — segments are
    // rejoined with a single space (nothing lost), one plain sentence
    // surfaced on the notice channel.
    if (offsets.some((offset) => !isValidSplitOffset(greek, offset))) {
      rows.push({ address, greek, english: joinRowDocs(segments), ...(englishPara ? { englishPara } : {}) });
      noteDrift(label);
      continue;
    }

    // English-count-wins (¶-count vs offset-count skew, e.g. a hand edit):
    // the segments are the user's actual prose and are NEVER dropped; extra
    // segments simply carry no Greek anchor, extra offsets are dropped.
    if (offsets.length !== segments.length - 1) {
      noteDrift(label);
      offsets = offsets.slice(0, segments.length - 1);
    }

    rows.push({
      address,
      greek,
      english: segments[0],
      ...(englishPara ? { englishPara } : {}),
      ...(offsets.length > 0 ? { splitOffsets: offsets } : {}),
      ...(segments.length > 1 ? { english2: segments.slice(1) } : {}),
    });
  }

  // Heading roles (D8 heading tools): apply the chapter-file `headers`
  // (row:level, 1-based, already range-filtered at parse) onto the rows.
  // Document-spine only — a stray `headers:` line in a hand-edited CORPUS file
  // must never turn a Bekker row into a heading (flow/typography key off it).
  if (file.meta.headers && schemeDef.spineSource === 'document') {
    for (const h of file.meta.headers) {
      const row = rows[h.row - 1];
      if (row) row.headingLevel = h.level;
    }
  }

  // Heading title overrides (`[HEADING_TITLES]`, 1:1 with rows) — document-spine
  // only, same gate as headers. A blank line = no override.
  if (file.headingTitleLines && schemeDef.spineSource === 'document') {
    file.headingTitleLines.forEach((title, i) => {
      if (title.length > 0 && rows[i]) rows[i].headingTitle = title;
    });
  }

  // Anchored-ness is derived: a footnote is anchored iff its marker survives
  // somewhere in the hydrated rows' SENTENCE layer (segments walked in
  // document order). The paragraph layer never counts — its markers were
  // stripped above, and a footnote whose only marker sat there is correctly
  // UNANCHORED (body kept, recoverable), matching the editor's panel/delete
  // paths which scan the sentence layer only.
  const markerIds = new Set<string>();
  const markerOrder: string[] = [];
  for (const row of rows) {
    for (const doc of englishDocsOf(row)) {
      for (const id of markerIdsIn(docFromJSON(doc))) {
        if (!markerIds.has(id)) markerOrder.push(id);
        markerIds.add(id);
      }
    }
  }
  const footnotes: ModelFootnote[] = file.footnotes.map((fn) => ({
    id: String(fn.id),
    body: fn.body,
    anchored: markerIds.has(String(fn.id)),
  }));
  // Markers with no [FOOTNOTES] entry (hand-edited file): keep them working
  // with an empty body rather than dropping the anchor.
  const known = new Set(footnotes.map((f) => f.id));
  for (const id of markerOrder) {
    if (!known.has(id)) footnotes.push({ id, body: '', anchored: true });
  }

  const notices: string[] = [];
  if (schemeDef.spineSource === 'corpus' && fileCount !== spine.length) {
    notices.push(`Saved file has ${fileCount} lines but the corpus spine has ${spine.length} — using the saved file.`);
  } else if (schemeDef.spineSource === 'corpus' && rows.some((row, i) => row.greek !== spine[i].greek)) {
    notices.push('Saved Greek differs from the corpus text — using the saved file.');
  }
  notices.push(...splitNotices);
  // paragraph_starts drift (D8 §5 grouping metadata, D6 degrade convention):
  // the parser dropped invalid/out-of-range/duplicate entries rather than
  // refuse the file — one plain sentence on the same channel; the next save
  // writes the sanitized list back, so this self-heals.
  if (file.paragraphStartsSanitized) {
    notices.push(
      'Some of the saved paragraph grouping was invalid and was removed — regroup if you still want it.',
    );
  }
  const notice = notices.length > 0 ? notices.join(' ') : null;

  const spans: ChapterSpans =
    (schemeDef.spineSource === 'document' || fileCount === spine.length) && fileCount > 0
      ? { start: rows[0].address.raw, end: rows[fileCount - 1].address.raw }
      : { start: file.meta.spanStart, end: file.meta.spanEnd };

  return {
    rows,
    footnotes,
    spans,
    ...(file.meta.paragraphStarts ? { paragraphStarts: file.meta.paragraphStarts } : {}),
    notice,
  };
}

// ── pending-write registry (cross-controller read safety) ───────────────────

const pendingWrites = new Map<string, Promise<unknown>>();

function writeKey(workId: string, fileName: string): string {
  return `${workId}/${fileName}`;
}

/** Await any in-flight write for this file (errors are the writer's problem). */
export async function awaitPendingWrite(workId: string, fileName: string): Promise<void> {
  const pending = pendingWrites.get(writeKey(workId, fileName));
  if (pending) await pending.catch(() => undefined);
}

/**
 * Await every in-flight write for a work, whatever the file. Removing a work
 * calls this first, so a save already on its way to storage lands before the
 * folder goes rather than after it.
 */
export async function awaitPendingWrites(workId: string): Promise<void> {
  const prefix = `${workId}/`;
  const inFlight = [...pendingWrites.entries()]
    .filter(([key]) => key.startsWith(prefix))
    .map(([, promise]) => promise.catch(() => undefined));
  await Promise.all(inFlight);
}

// ── load ────────────────────────────────────────────────────────────────────

export interface LoadResult {
  /** Parsed file, or null when none exists (fresh chapter). */
  file: ChapterFile | null;
  /**
   * Non-null when a file EXISTS but could not be parsed. The caller must not
   * autosave over it — overwriting an unreadable file could destroy the very
   * data that made it unreadable.
   */
  error: string | null;
}

export async function loadChapterFile(
  storage: LibraryStorage,
  workId: string,
  fileName: string,
): Promise<LoadResult> {
  await awaitPendingWrite(workId, fileName);
  const raw = await storage.read(workId, fileName);
  if (raw === null) return { file: null, error: null };
  try {
    return { file: parseChapterFile(raw, fileName), error: null };
  } catch (err) {
    const message = err instanceof ChapterFileError ? err.message : String(err);
    return { file: null, error: message };
  }
}

// ── the debounced controller ────────────────────────────────────────────────

export const AUTOSAVE_DEBOUNCE_MS = 1000;

export type SaveState = 'idle' | 'saving' | 'saved' | 'error';

export interface AutosaveConfig {
  workId: string;
  fileName: string;
  /** Serialize the CURRENT model state; called at write time, never cached. */
  snapshot(): string;
  storage?: LibraryStorage;
  debounceMs?: number;
  onState?(state: SaveState): void;
  /** Fires after each successful write (footnote-index ride-along hooks here). */
  onSaved?(): void;
}

export interface AutosaveHandle {
  /** Schedule a debounced save (call on every model commit). */
  markDirty(): void;
  /** Save NOW if there are unsaved changes; resolves when storage settles. */
  flush(): Promise<void>;
  /** Flush and stop; further markDirty calls are ignored. */
  dispose(): Promise<void>;
  readonly state: SaveState;
}

export function createAutosave(config: AutosaveConfig): AutosaveHandle {
  const storage = config.storage ?? libraryStorage();
  const debounceMs = config.debounceMs ?? AUTOSAVE_DEBOUNCE_MS;
  const key = writeKey(config.workId, config.fileName);

  let dirty = false;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let state: SaveState = 'idle';
  let writing: Promise<void> | null = null;
  // True from the loop's first line to its last, synchronously: `writing` is
  // still set for one microtask after the loop has finished, and an edit +
  // flush landing in that instant must start a new loop, not wait on a
  // finished one and leave the edit unsaved with nothing scheduled.
  let looping = false;

  function setState(next: SaveState) {
    if (state === next) return;
    state = next;
    config.onState?.(next);
  }

  function clearTimer() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  async function writeLoop(): Promise<void> {
    looping = true;
    try {
      // Loop: if markDirty lands while a write is in flight, write again so the
      // final file always reflects the final model state.
      while (dirty) {
        dirty = false;
        let content: string;
        try {
          content = config.snapshot();
        } catch (err) {
          // Serialization failure: keep the dirty flag so nothing is dropped,
          // surface the error state, and leave the last good file untouched.
          dirty = true;
          setState('error');
          console.error(`autosave: snapshot failed for ${key}`, err);
          return;
        }
        setState('saving');
        try {
          await storage.write(config.workId, config.fileName, content);
        } catch (err) {
          dirty = true;
          setState('error');
          console.error(`autosave: write failed for ${key}`, err);
          return;
        }
        if (!dirty) {
          setState('saved');
          config.onSaved?.();
        }
      }
    } finally {
      looping = false;
    }
  }

  function startWrite(): Promise<void> {
    if (writing && looping) return writing;
    const run = writeLoop().finally(() => {
      if (writing === registered) writing = null;
      if (pendingWrites.get(key) === registered) pendingWrites.delete(key);
    });
    writing = run;
    const registered = run;
    pendingWrites.set(key, registered);
    return run;
  }

  return {
    get state() {
      return state;
    },
    markDirty() {
      if (disposed) return;
      dirty = true;
      clearTimer();
      timer = setTimeout(() => {
        timer = null;
        void startWrite();
      }, debounceMs);
    },
    async flush() {
      clearTimer();
      // Await the in-flight write too: its loop already picks up the latest
      // dirty flag, so when it settles the file is current.
      if (dirty || writing) await startWrite();
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      clearTimer();
      if (dirty || writing) await startWrite();
    },
  };
}
