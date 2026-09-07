/**
 * Parser + serializer for the chapter save format (the app's canonical user
 * data). See workbench-design/d2-citation-schemes.md "Chapter-file
 * frontmatter" and the format block in the build spec.
 *
 * Format:
 * ---
 * schema_version: 1
 * work: metaphysics
 * book: 7
 * chapter: 17
 * citation_scheme: bekker-metaphysics
 * span_start: "1041a6"
 * span_end: "1041b33"
 * column_starts: "1041a6@1,1041b1@29"
 * line_splits: "1041b8@14,1041b8@31"
 * paragraph_starts: "1,5,12"
 * ---
 * [GREEK]
 * <one line per Bekker line>
 * <structural blank line>
 * [ENGLISH]
 * <one line per Bekker line — RAW markup strings>
 * <structural blank line, only when [FOOTNOTES] follows>
 * [ENGLISH.PARA]
 * <optional one line per row — paragraph-granularity RAW markup strings>
 * <structural blank line, only when [FOOTNOTES] follows>
 * [FOOTNOTES]
 * 1: footnote body text…
 * 2: another note…
 *
 * Frontmatter is flat scalars only, parsed with js-yaml. [FOOTNOTES] is
 * optional. A footnote entry starts at /^\d+: /; every other line appends
 * (with a newline) to the current entry's body — this is how multi-line
 * footnote bodies are represented.
 *
 * `column_starts` is OPTIONAL (older files lack it; consumers must handle
 * absence): comma-separated `<columnRef>@<rowIndex>` pairs, 1-based row
 * indexes. The FIRST pair's ref is the full span_start address (it carries
 * the chapter's starting line); each later pair is the full address of the
 * first row of a new column — usually line 1, but the actual line number is
 * always carried, never assumed. Within a segment, line numbers increment by
 * 1 per row (see `rowAddress`).
 *
 * `line_splits` is OPTIONAL (design doc D6; unsplit files lack it):
 * comma-separated `<address>@<offset>` pairs marking user paragraph splits
 * inside a Bekker line. The address is the split row's raw address (opaque —
 * validated only via scheme.parseAddress); the offset is a CODE-UNIT index
 * into that row's [GREEK] line (see isValidSplitOffset). Multiple pairs may
 * share an address (several splits in one line); their offsets must be
 * strictly ascending. LAYERING: this module validates line_splits STRUCTURE
 * only and round-trips the pairs byte-stably; whether an offset actually
 * lands in range and at a word boundary of its row's Greek is the HYDRATION
 * step's job (library/autosave.ts) — a well-formed but drifted split must
 * degrade to an unsplit line with a notice, never a parse refusal. The
 * matching English segmentation is a `¶` token in the [ENGLISH] row markup
 * (editor/serialize.ts parseRowSegments/serializeRowSegments).
 *
 * Structural blanks: the serializer emits exactly one blank line after each
 * section's content when another section follows (at EOF the file's final
 * newline plays that role), and the parser drops exactly one trailing blank
 * line per section. This makes an EMPTY final content row (the common case —
 * an untranslated [ENGLISH] row) unambiguous: it serializes as an empty line
 * PLUS the structural blank, so parse(serialize(x)) round-trips by
 * construction. Files without the structural blanks (older serializer
 * output) still parse.
 */

import yaml from 'js-yaml';
import type { SchemeId } from '../citation/types';
import { getScheme, isKnownScheme } from '../citation/registry';
import type { ChapterFile, ChapterFileMeta, ColumnStart, Footnote, HeaderMark, LineSplit, RowHeaderLevel } from './types';
import { ChapterFileError } from './types';

/**
 * Highest schema_version this build can open. schema_version stays 1 for the
 * line_splits addition (it is additive-optional, exactly like column_starts —
 * d6 divergence C); this guard exists so that when a FUTURE format change
 * does bump the version, today's build refuses the file with one plain
 * sentence instead of misreading it.
 */
const SUPPORTED_SCHEMA_VERSION = 1;

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const FOOTNOTE_ENTRY_RE = /^(\d+):[ \t](.*)$/;

/**
 * A footnote body's continuation lines are written verbatim, which leaves one
 * ambiguity: a line the body itself starts with "N: " reads back as a NEW
 * entry — footnote 1's "See below.\n2: not a note" became two footnotes, and
 * when a real footnote 2 followed, a duplicate id that refused the whole file.
 * Such a line (and, so the escape itself stays unambiguous, one that begins
 * with a backslash) is written with a leading backslash; the parser strips
 * exactly one from every continuation line that carries it. Files written
 * before this carry no leading backslash unless the body really began with
 * one, which no footnote in the library does.
 */
function escapeFootnoteContinuation(line: string): string {
  return FOOTNOTE_ENTRY_RE.test(line) || line.startsWith('\\') ? `\\${line}` : line;
}

function unescapeFootnoteContinuation(line: string): string {
  return line.startsWith('\\') ? line.slice(1) : line;
}
const SECTION_HEADERS = ['[GREEK]', '[ENGLISH]', '[ENGLISH.PARA]', '[HEADING_TITLES]', '[FOOTNOTES]'] as const;
type SectionHeader = (typeof SECTION_HEADERS)[number];

function normalizeLineEndings(raw: string): string {
  // A byte-order mark is not content: an editor that writes one (Notepad,
  // some Windows tools on a shared folder) must not make the file unopenable.
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/**
 * Fold Unicode U+2028 LINE SEPARATOR / U+2029 PARAGRAPH SEPARATOR to a real
 * paragraph break ("\n\n") in a footnote body. A hand-authored/pasted body can
 * carry these instead of "\n"; left in place they're invisible but dangerous,
 * because the parser's `FOOTNOTE_ENTRY_RE` (`^`/`.`/`$`) treats U+2028/U+2029
 * AS line terminators even though `String.prototype.split('\n')` does NOT —
 * so a footnote body containing one fails to match on reparse (or silently
 * truncates its captured text) even though `split('\n')` kept it on one
 * physical line. A footnote body has a native multi-paragraph shape (see the
 * format doc above and `parseFootnotes`'s continuation-line handling), so
 * folding to "\n\n" (rather than a bare space) matches the Stage 0
 * Scrivener-import policy for the same characters (normalizeFootnoteBody in
 * ../import/scrivenerMd.ts): it turns an unrepresentable separator into the
 * closest well-formed thing the format already represents (a paragraph
 * break), so the round trip is lossless-by-construction rather than merely
 * non-crashing.
 *
 * Scoped to footnote bodies only — NOT [GREEK]/[ENGLISH] rows. A row is a
 * single line by format design with no regex-based matching applied to its
 * content in this module, so a stray U+2028/U+2029 there doesn't exhibit this
 * bug; folding it would instead risk turning one row into extra physical
 * lines on serialize (breaking the [GREEK]/[ENGLISH] 1:1 row-count invariant)
 * for real hand-authored/imported prose that already carries one mid-sentence
 * (measured against real fixture data) — worse than leaving it as an inert
 * (if invisible) character.
 */
function normalizeFootnoteSeparators(body: string): string {
  return body.replace(/[\u2028\u2029]/g, '\n\n');
}

// ── raw-address splitting (presentation-level, not citation math) ───────────

// Trailing digits = line number, prefix = column. This is textual slicing of
// the same shape every module already relies on ("1041a6" = column "1041a",
// line 6); citation/'s parsed structs stay private to citation/.
const RAW_SPLIT_RE = /^(.*\D)(\d+)$/;

function splitRawAddress(raw: string): { column: string; line: number } | null {
  const m = RAW_SPLIT_RE.exec(raw);
  if (!m) return null;
  return { column: m[1], line: Number(m[2]) };
}

// ── frontmatter ─────────────────────────────────────────────────────────────

const COLUMN_STARTS_PAIR_RE = /^([^@]+)@(\d+)$/;

/** 1-based file line number of a frontmatter key (line 1 is the opening "---"). */
function frontmatterKeyLine(yamlText: string, key: string): number {
  const lines = yamlText.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (new RegExp(`^${key}\\s*:`).test(lines[i])) return i + 2;
  }
  return 0;
}

function parseColumnStarts(
  val: unknown,
  spanStart: string,
  scheme: ReturnType<typeof getScheme>,
  lineNo: number,
  source: string,
): ColumnStart[] {
  const at = lineNo > 0 ? `line ${lineNo}: ` : '';
  if (typeof val !== 'string' || val.length === 0) {
    throw new ChapterFileError(
      `${source}: ${at}frontmatter field "column_starts", when present, must be a non-empty string of <columnRef>@<rowIndex> pairs`,
    );
  }
  const out: ColumnStart[] = [];
  const pairs = val.split(',');
  for (let i = 0; i < pairs.length; i++) {
    const pairRaw = pairs[i].trim();
    const m = COLUMN_STARTS_PAIR_RE.exec(pairRaw);
    if (!m) {
      throw new ChapterFileError(
        `${source}: ${at}column_starts pair ${i + 1} (${JSON.stringify(pairRaw)}) is not of the form <columnRef>@<rowIndex>`,
      );
    }
    const ref = decodeListRef(m[1]);
    const rowIndex = Number(m[2]);
    if (splitRawAddress(ref) === null) {
      throw new ChapterFileError(
        `${source}: ${at}column_starts pair ${i + 1}: ref ${JSON.stringify(ref)} does not end in a line number (expected e.g. "1041b1")`,
      );
    }
    try {
      scheme.parseAddress(ref);
    } catch (err) {
      throw new ChapterFileError(
        `${source}: ${at}column_starts pair ${i + 1}: ref ${JSON.stringify(ref)} does not parse under scheme "${scheme.id}": ${(err as Error).message}`,
      );
    }
    out.push({ ref, rowIndex });
  }

  if (out[0].ref !== spanStart) {
    throw new ChapterFileError(
      `${source}: ${at}column_starts first pair's ref (${JSON.stringify(out[0].ref)}) must equal span_start (${JSON.stringify(spanStart)})`,
    );
  }
  if (out[0].rowIndex !== 1) {
    throw new ChapterFileError(
      `${source}: ${at}column_starts first pair must have row index 1 (got ${out[0].rowIndex}) — rows before the first segment would have no address`,
    );
  }
  for (let i = 1; i < out.length; i++) {
    if (out[i].rowIndex <= out[i - 1].rowIndex) {
      throw new ChapterFileError(
        `${source}: ${at}column_starts row indexes must be strictly increasing (pair ${i + 1} has ${out[i].rowIndex}, after ${out[i - 1].rowIndex})`,
      );
    }
  }
  return out;
}

/**
 * Addresses inside a comma-joined frontmatter list (row_refs, column_starts,
 * line_splits).
 *
 * A source's own line number can itself contain a comma: the TLG prints
 * "205a.25,29" for a line its edition numbers twice, and 78 of Aristotle's
 * 122,429 lines are of that kind. Joined raw, such an address splits into two
 * on the way back in — the list outnumbers the rows, the 1:1 check refuses the
 * file, and a work that imported cleanly cannot be reopened. Percent-escaping
 * is the smallest fix that keeps these fields one comma-separated list: no
 * address any scheme accepts contains a '%', so decoding is a no-op for every
 * file written before this.
 */
function encodeListRef(ref: string): string {
  return ref.replace(/%/g, '%25').replace(/,/g, '%2C');
}

function decodeListRef(ref: string): string {
  return ref.replace(/%2C/g, ',').replace(/%25/g, '%');
}

/**
 * Repair for a file written before addresses were escaped (see encodeListRef).
 *
 * A raw "205a.25,29" came back in as "205a.25" and a stray "29", so the list
 * runs longer than the chapter's rows by exactly the number of pieces that
 * broke off, and every such file — every imported work whose edition numbers a
 * line twice — refuses to open. Rejoining each bare-number entry onto the
 * address before it is accepted ONLY when it lands the count exactly on the
 * row count; any other total is a real mismatch and still refuses, so this
 * cannot paper over a genuinely broken file.
 */
function rejoinLegacyPairRefs(refs: string[], rowCount: number): string[] | null {
  if (refs.length <= rowCount) return null;
  const out: string[] = [];
  for (const ref of refs) {
    if (out.length > 0 && /^\d+$/.test(ref)) out[out.length - 1] = `${out[out.length - 1]},${ref}`;
    else out.push(ref);
  }
  return out.length === rowCount ? out : null;
}

/**
 * Structural validation of the frontmatter `row_refs` field: a comma-joined
 * list of one address per row, each parseable under the file's scheme. STRICT
 * like column_starts rather than lenient like paragraph_starts, because these
 * are citations, not display metadata — a garbled ref would silently mis-cite
 * the text. The count-vs-row-count check needs the row count and so lives with
 * the other cross-section checks below.
 */
function parseRowRefs(
  val: unknown,
  scheme: ReturnType<typeof getScheme>,
  lineNo: number,
  source: string,
): string[] {
  const at = lineNo > 0 ? `line ${lineNo}: ` : '';
  if (typeof val !== 'string' || val.length === 0) {
    throw new ChapterFileError(
      `${source}: ${at}frontmatter field "row_refs", when present, must be a non-empty comma-separated list of addresses`,
    );
  }
  const refs = val.split(',').map((r) => decodeListRef(r.trim()));
  for (let i = 0; i < refs.length; i++) {
    try {
      scheme.parseAddress(refs[i]);
    } catch (err) {
      throw new ChapterFileError(
        `${source}: ${at}row_refs entry ${i + 1} (${JSON.stringify(refs[i])}) does not parse under scheme "${scheme.id}": ${(err as Error).message}`,
      );
    }
  }
  return refs;
}

const LINE_SPLITS_PAIR_RE = /^([^@]+)@(\d+)$/;

/**
 * Structural validation of the frontmatter `line_splits` field (see the
 * format doc above for the layering: semantic offset validation lives in
 * hydration, not here). Mirrors parseColumnStarts' error style.
 */
function parseLineSplits(
  val: unknown,
  scheme: ReturnType<typeof getScheme>,
  lineNo: number,
  source: string,
): LineSplit[] {
  const at = lineNo > 0 ? `line ${lineNo}: ` : '';
  if (typeof val !== 'string' || val.length === 0) {
    throw new ChapterFileError(
      `${source}: ${at}frontmatter field "line_splits", when present, must be a non-empty string of <address>@<offset> pairs`,
    );
  }
  const out: LineSplit[] = [];
  const lastOffsetByRef = new Map<string, number>();
  const pairs = val.split(',');
  for (let i = 0; i < pairs.length; i++) {
    const pairRaw = pairs[i].trim();
    const m = LINE_SPLITS_PAIR_RE.exec(pairRaw);
    if (!m) {
      throw new ChapterFileError(
        `${source}: ${at}line_splits pair ${i + 1} (${JSON.stringify(pairRaw)}) is not of the form <address>@<offset>`,
      );
    }
    const ref = decodeListRef(m[1]);
    const offset = Number(m[2]);
    try {
      scheme.parseAddress(ref);
    } catch (err) {
      throw new ChapterFileError(
        `${source}: ${at}line_splits pair ${i + 1}: address ${JSON.stringify(ref)} does not parse under scheme "${scheme.id}": ${(err as Error).message}`,
      );
    }
    if (!Number.isSafeInteger(offset) || offset <= 0) {
      throw new ChapterFileError(
        `${source}: ${at}line_splits pair ${i + 1}: offset must be a positive integer (got ${JSON.stringify(m[2])})`,
      );
    }
    const prev = lastOffsetByRef.get(ref);
    if (prev !== undefined && offset <= prev) {
      throw new ChapterFileError(
        `${source}: ${at}line_splits offsets for address ${JSON.stringify(ref)} must be strictly ascending (pair ${i + 1} has ${offset}, after ${prev})`,
      );
    }
    lastOffsetByRef.set(ref, offset);
    out.push({ ref, offset });
  }
  return out;
}

/**
 * LENIENT sanitize of the frontmatter `paragraph_starts` field — deliberately
 * NOT the strict throw-on-malformed style of parseColumnStarts/parseLineSplits
 * above. Those two fields carry ADDRESSING; a wrong value mis-addresses user
 * prose, so refusing loudly is right. paragraph_starts is optional visual
 * GROUPING metadata (D8 §5 — pure display; D1/D3 consumers treat row 1 as an
 * implicit start and just Set-test the ordinals), so a malformed value must
 * DEGRADE per the D6 drift convention, never make the document unopenable:
 * junk tokens, zero/negative ordinals and duplicates are dropped, ordering is
 * repaired (sorted ascending), and `modified` reports whether anything was
 * lost/changed so hydration can surface the one-line notice. A leading 1 is
 * neither required nor coerced (row 1 always opens the first group anyway).
 * Out-of-range ordinals need the row count and are filtered in
 * parseChapterFile. Serialization stays strict/canonical (see
 * serializeFrontmatter) — this leniency is parse-side only.
 */
export function sanitizeParagraphStarts(val: unknown): { starts: number[] | undefined; modified: boolean } {
  // Canonical files carry a quoted string; a bare YAML scalar (number) is
  // salvageable by stringifying. Anything else (mapping, list, null…) has no
  // token shape to salvage — treat as fully invalid.
  const text = typeof val === 'string' ? val : typeof val === 'number' ? String(val) : undefined;
  if (text === undefined) return { starts: undefined, modified: true };

  const tokens = text.split(',').map((t) => t.trim());
  const seen = new Set<number>();
  let modified = false;
  for (const token of tokens) {
    const n = /^\d+$/.test(token) ? Number(token) : NaN;
    if (!Number.isSafeInteger(n) || n <= 0 || seen.has(n)) {
      modified = true;
      continue;
    }
    seen.add(n);
  }
  const out = [...seen].sort((a, b) => a - b);
  // Repaired ordering (e.g. "3,1") keeps every entry but is still a change
  // worth the notice — the saved bytes weren't canonical.
  if (!modified) modified = out.some((n, i) => n !== Number(tokens[i]));
  if (out.length === 0) return { starts: undefined, modified: true };
  return { starts: out, modified };
}

/**
 * LENIENT sanitize of the frontmatter `headers` field — same degrade-don't-
 * refuse policy as sanitizeParagraphStarts (headings are pure display metadata,
 * D8 heading tools). Tokens are `<row>:<level>` pairs; a token that is not that
 * shape, a non-positive/duplicate row, or a level below 1 is dropped.
 * A row appears at most once (one level per row); output is sorted by row.
 * Out-of-range rows need the row count and are filtered in parseChapterFile.
 * Returns undefined when nothing survives (so the meta key stays absent).
 */
export function sanitizeHeaders(val: unknown): HeaderMark[] | undefined {
  const text = typeof val === 'string' ? val : typeof val === 'number' ? String(val) : undefined;
  if (text === undefined) return undefined;

  const seen = new Set<number>();
  const marks: HeaderMark[] = [];
  for (const token of text.split(',').map((t) => t.trim())) {
    const parsed = /^(\d+):(\d+)$/.exec(token);
    if (!parsed) continue;
    const row = Number(parsed[1]);
    const level = Number(parsed[2]);
    if (!Number.isSafeInteger(row) || row <= 0 || seen.has(row)) continue;
    if (!Number.isSafeInteger(level) || level < 1) continue;
    seen.add(row);
    marks.push({ row, level: level as RowHeaderLevel });
  }
  marks.sort((a, b) => a.row - b.row);
  return marks.length > 0 ? marks : undefined;
}

/**
 * Semantic validity of one paragraph-split offset against its row's OWN
 * [GREEK] line (the canonical Greek that travels with the file — never the
 * live corpus). Used by hydration's drift policy (d6 divergence E): an
 * invalid offset never refuses the file; the line just loads unsplit with a
 * notice.
 *
 * OFFSET BASIS — JS CODE UNITS, deliberately (d6 divergence A). The offset
 * indexes the Greek string with the same `.length`/`.slice` basis every other
 * offset in this file format uses. Do NOT "fix" this to code points or
 * graphemes: the Greek the offset indexes is in the same file, so code units
 * are exact, and combining-mark safety comes from the word-boundary rule
 * below, not from grapheme segmentation.
 *
 * WORD-BOUNDARY RULE: a split must sit in a word gap — the character
 * immediately before the offset must not be a letter or combining mark
 * (whitespace, punctuation, and the ano teleia `·` are all fine). This is
 * what makes a mid-grapheme (base letter + combining mark) split impossible
 * without any environment-dependent segmenter machinery.
 */
export function isValidSplitOffset(greek: string, offset: number): boolean {
  if (!Number.isInteger(offset) || offset <= 0 || offset >= greek.length) return false;
  return !/[\p{L}\p{M}]/u.test(greek[offset - 1]);
}

function parseFrontmatter(
  normalized: string,
  source: string,
): { meta: ChapterFileMeta; rest: string; columnStartsLine: number; rowRefsLine: number; paragraphStartsSanitized: boolean } {
  const m = FRONTMATTER_RE.exec(normalized);
  if (!m) {
    throw new ChapterFileError(`${source}: missing YAML frontmatter (expected a leading "---" block)`);
  }
  const rest = normalized.slice(m[0].length);
  let parsed: unknown;
  try {
    parsed = yaml.load(m[1]);
  } catch (err) {
    throw new ChapterFileError(`${source}: frontmatter is not valid YAML (${(err as Error).message})`);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new ChapterFileError(`${source}: frontmatter must be a YAML mapping of flat scalars`);
  }
  const v = parsed as Record<string, unknown>;

  const requireString = (key: string): string => {
    const val = v[key];
    if (typeof val !== 'string' || val.length === 0) {
      throw new ChapterFileError(`${source}: frontmatter field "${key}" is required and must be a non-empty string`);
    }
    return val;
  };
  const requireInt = (key: string): number => {
    const val = v[key];
    if (typeof val !== 'number' || !Number.isInteger(val)) {
      throw new ChapterFileError(`${source}: frontmatter field "${key}" is required and must be an integer`);
    }
    return val;
  };

  const schemaVersion = requireInt('schema_version');
  if (schemaVersion > SUPPORTED_SCHEMA_VERSION) {
    // Version discipline (d6 divergence C): refuse a future format with one
    // plain sentence rather than misread it.
    throw new ChapterFileError(
      `${source}: This chapter was saved by a newer version of the app — update the app to open it.`,
    );
  }
  // A file written before `work` was quoted carries a bare slug; an all-digit
  // slug came back from YAML as a number. Its digits ARE the id.
  if (typeof v['work'] === 'number' && Number.isInteger(v['work'])) v['work'] = String(v['work']);
  const work = requireString('work');
  const book = requireInt('book');
  const chapter = requireInt('chapter');
  const citationSchemeRaw = requireString('citation_scheme');
  const spanStart = requireString('span_start');
  const spanEnd = requireString('span_end');

  if (!isKnownScheme(citationSchemeRaw)) {
    throw new ChapterFileError(`${source}: frontmatter field "citation_scheme" is unknown: ${JSON.stringify(citationSchemeRaw)}`);
  }
  const citationScheme: SchemeId = citationSchemeRaw;

  // span_start/span_end must parse under the declared scheme.
  const scheme = getScheme(citationScheme);
  try {
    scheme.parseAddress(spanStart);
  } catch (err) {
    throw new ChapterFileError(`${source}: frontmatter field "span_start" (${JSON.stringify(spanStart)}) does not parse under scheme "${citationScheme}": ${(err as Error).message}`);
  }
  try {
    scheme.parseAddress(spanEnd);
  } catch (err) {
    throw new ChapterFileError(`${source}: frontmatter field "span_end" (${JSON.stringify(spanEnd)}) does not parse under scheme "${citationScheme}": ${(err as Error).message}`);
  }

  // Optional column_starts (older files lack it).
  let columnStarts: ColumnStart[] | undefined;
  let columnStartsLine = 0;
  if ('column_starts' in v) {
    columnStartsLine = frontmatterKeyLine(m[1], 'column_starts');
    columnStarts = parseColumnStarts(v['column_starts'], spanStart, scheme, columnStartsLine, source);
  }

  // Optional row_refs (only source imports carry it).
  let rowRefs: string[] | undefined;
  let rowRefsLine = 0;
  if ('row_refs' in v) {
    rowRefsLine = frontmatterKeyLine(m[1], 'row_refs');
    rowRefs = parseRowRefs(v['row_refs'], scheme, rowRefsLine, source);
  }

  // Optional line_splits (unsplit files lack it). Structure only — see the
  // layering note in the format doc above.
  let lineSplits: LineSplit[] | undefined;
  if ('line_splits' in v) {
    const lineSplitsLine = frontmatterKeyLine(m[1], 'line_splits');
    lineSplits = parseLineSplits(v['line_splits'], scheme, lineSplitsLine, source);
  }

  let paragraphStarts: number[] | undefined;
  let paragraphStartsSanitized = false;
  if ('paragraph_starts' in v) {
    const sanitized = sanitizeParagraphStarts(v['paragraph_starts']);
    paragraphStarts = sanitized.starts;
    paragraphStartsSanitized = sanitized.modified;
  }

  let headers: HeaderMark[] | undefined;
  if ('headers' in v) {
    headers = sanitizeHeaders(v['headers']);
  }

  const meta: ChapterFileMeta = {
    schemaVersion,
    work,
    book,
    chapter,
    citationScheme,
    spanStart,
    spanEnd,
    ...(columnStarts ? { columnStarts } : {}),
    ...(rowRefs ? { rowRefs } : {}),
    ...(lineSplits ? { lineSplits } : {}),
    ...(paragraphStarts ? { paragraphStarts } : {}),
    ...(headers ? { headers } : {}),
  };
  return { meta, rest, columnStartsLine, rowRefsLine, paragraphStartsSanitized };
}

// ── body sections ────────────────────────────────────────────────────────────

function isSectionHeader(line: string): line is SectionHeader {
  return (SECTION_HEADERS as readonly string[]).includes(line);
}

/** Split the post-frontmatter body into raw line arrays per section header. */
function splitSections(body: string, source: string): Map<SectionHeader, { lines: string[]; startLine: number }> {
  const lines = body.split('\n');
  const sections = new Map<SectionHeader, { lines: string[]; startLine: number }>();
  let current: SectionHeader | null = null;
  let currentLines: string[] = [];
  let currentStart = 0;

  // Frontmatter occupies the lines before `body`; callers pass 1-based line
  // numbers that already account for that offset via `lineOffset` below.
  const flush = () => {
    if (current) {
      if (sections.has(current)) {
        throw new ChapterFileError(`${source}: duplicate section header ${current}`);
      }
      sections.set(current, { lines: currentLines, startLine: currentStart });
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isSectionHeader(line)) {
      flush();
      current = line;
      currentLines = [];
      currentStart = i + 1;
    } else if (current === null) {
      if (line.trim() !== '') {
        throw new ChapterFileError(`${source}: unexpected content before a section header: ${JSON.stringify(line)}`);
      }
      // blank line(s) between frontmatter and first section header: ignore
    } else {
      currentLines.push(line);
    }
  }
  flush();

  if (!sections.has('[GREEK]')) {
    throw new ChapterFileError(`${source}: missing required [GREEK] section`);
  }
  if (!sections.has('[ENGLISH]')) {
    throw new ChapterFileError(`${source}: missing required [ENGLISH] section`);
  }
  return sections;
}

/**
 * A section's raw lines end with one trailing empty line representing the
 * newline before the next header (or EOF). Drop exactly one trailing blank
 * line — that's serialization structure, not content.
 */
function trimTrailingBlank(lines: string[]): string[] {
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    return lines.slice(0, -1);
  }
  return lines;
}

function parseFootnotes(lines: string[], sectionStartLine: number, source: string): Footnote[] {
  const content = trimTrailingBlank(lines);
  const footnotes: Footnote[] = [];
  let current: Footnote | null = null;

  for (let i = 0; i < content.length; i++) {
    const lineNo = sectionStartLine + i + 1; // +1 for the [FOOTNOTES] header line itself
    // Fold U+2028/U+2029 to a paragraph break BEFORE matching FOOTNOTE_ENTRY_RE
    // (see normalizeFootnoteSeparators): its `^`/`.`/`$` treat those characters
    // as line terminators even though split('\n') (above) did not, so a stray
    // separator on this physical line would otherwise make a well-formed
    // "N: text" entry fail to match, or silently truncate its captured body.
    const line = normalizeFootnoteSeparators(content[i]);
    const m = FOOTNOTE_ENTRY_RE.exec(line);
    if (m) {
      const id = Number(m[1]);
      current = { id, body: m[2] };
      footnotes.push(current);
    } else {
      if (current === null) {
        throw new ChapterFileError(
          `${source}: line ${lineNo}: footnote continuation line before any "N: " entry: ${JSON.stringify(line)}`
        );
      }
      current.body += `\n${unescapeFootnoteContinuation(line)}`;
    }
  }

  const seen = new Set<number>();
  for (const fn of footnotes) {
    if (!Number.isInteger(fn.id) || fn.id <= 0) {
      throw new ChapterFileError(`${source}: footnote id ${fn.id} must be a positive integer`);
    }
    if (seen.has(fn.id)) {
      throw new ChapterFileError(`${source}: duplicate footnote id ${fn.id}`);
    }
    seen.add(fn.id);
  }

  return footnotes;
}

// ── entry points ─────────────────────────────────────────────────────────────

export function parseChapterFile(raw: string, source = '<chapterfile>'): ChapterFile {
  const normalized = normalizeLineEndings(raw);
  const { meta, rest, columnStartsLine, rowRefsLine, paragraphStartsSanitized } = parseFrontmatter(normalized, source);
  const sections = splitSections(rest, source);

  const greekLines = trimTrailingBlank(sections.get('[GREEK]')!.lines);
  const englishLines = trimTrailingBlank(sections.get('[ENGLISH]')!.lines);
  const englishParaSection = sections.get('[ENGLISH.PARA]');
  const englishParaLines = englishParaSection ? trimTrailingBlank(englishParaSection.lines) : undefined;
  const headingTitlesSection = sections.get('[HEADING_TITLES]');
  const headingTitleLines = headingTitlesSection ? trimTrailingBlank(headingTitlesSection.lines) : undefined;
  const footnotesSection = sections.get('[FOOTNOTES]');
  const footnotes = footnotesSection ? parseFootnotes(footnotesSection.lines, footnotesSection.startLine, source) : [];

  if (greekLines.length !== englishLines.length) {
    throw new ChapterFileError(
      `${source}: [GREEK] has ${greekLines.length} line(s) but [ENGLISH] has ${englishLines.length} line(s) — they must match 1:1`
    );
  }

  if (englishParaLines !== undefined && greekLines.length !== englishParaLines.length) {
    throw new ChapterFileError(
      `${source}: [GREEK] has ${greekLines.length} line(s) but [ENGLISH.PARA] has ${englishParaLines.length} line(s) — they must match 1:1`
    );
  }

  if (headingTitleLines !== undefined && greekLines.length !== headingTitleLines.length) {
    throw new ChapterFileError(
      `${source}: [GREEK] has ${greekLines.length} line(s) but [HEADING_TITLES] has ${headingTitleLines.length} line(s) — they must match 1:1`
    );
  }

  if (meta.rowRefs && meta.rowRefs.length !== greekLines.length) {
    const rejoined = rejoinLegacyPairRefs(meta.rowRefs, greekLines.length);
    if (rejoined) meta.rowRefs = rejoined;
  }

  if (meta.rowRefs && meta.rowRefs.length !== greekLines.length) {
    const at = rowRefsLine > 0 ? `line ${rowRefsLine}: ` : '';
    throw new ChapterFileError(
      `${source}: ${at}row_refs has ${meta.rowRefs.length} address(es) but the chapter has ${greekLines.length} row(s) — they must match 1:1`,
    );
  }

  if (meta.columnStarts) {
    const at = columnStartsLine > 0 ? `line ${columnStartsLine}: ` : '';
    const last = meta.columnStarts[meta.columnStarts.length - 1];
    if (last.rowIndex > greekLines.length) {
      throw new ChapterFileError(
        `${source}: ${at}column_starts row index ${last.rowIndex} is out of range — the chapter has ${greekLines.length} row(s)`,
      );
    }
  }

  // Out-of-range paragraph_starts ordinals need the row count, so this last
  // sanitize step lives here rather than in sanitizeParagraphStarts. Same
  // lenient policy (grouping is display metadata — degrade, never refuse):
  // drop them and flag it. `paragraphStarts` is the last meta key, so the
  // repair keeps the key order parseFrontmatter established (the autosave
  // round-trip self-check compares JSON shapes).
  let psSanitized = paragraphStartsSanitized;
  if (meta.paragraphStarts) {
    const inRange = meta.paragraphStarts.filter((n) => n <= greekLines.length);
    if (inRange.length !== meta.paragraphStarts.length) {
      psSanitized = true;
      if (inRange.length > 0) meta.paragraphStarts = inRange;
      else delete meta.paragraphStarts;
    }
  }

  // Same out-of-range repair for `headers` (the last meta key). Heading roles
  // are the most cosmetic of the display-metadata fields, so a dropped entry
  // degrades silently — no separate load notice.
  if (meta.headers) {
    const inRange = meta.headers.filter((h) => h.row <= greekLines.length);
    if (inRange.length !== meta.headers.length) {
      if (inRange.length > 0) meta.headers = inRange;
      else delete meta.headers;
    }
  }

  return {
    meta,
    greekLines,
    englishLines,
    ...(englishParaLines !== undefined ? { englishParaLines } : {}),
    ...(headingTitleLines !== undefined ? { headingTitleLines } : {}),
    footnotes,
    ...(psSanitized ? { paragraphStartsSanitized: true } : {}),
  };
}

/**
 * The raw address of row `rowIndex` (1-BASED, matching the file format),
 * derived from `meta.columnStarts`. Pure arithmetic within a column segment:
 * the segment ref's line + (rowIndex - segment's start index). Exact for any
 * number of column transitions. Throws ChapterFileError when the meta has no
 * column_starts (older files — callers must handle absence BEFORE calling)
 * or when rowIndex is not a positive integer. The upper bound (the chapter's
 * row count) is not known to the meta and is the caller's responsibility.
 */
export function rowAddress(meta: ChapterFileMeta, rowIndex: number): string {
  const starts = meta.columnStarts;
  if (!starts || starts.length === 0) {
    throw new ChapterFileError('rowAddress: this chapter file has no column_starts — derive addresses another way');
  }
  if (!Number.isInteger(rowIndex) || rowIndex < starts[0].rowIndex) {
    throw new ChapterFileError(
      `rowAddress: row index ${rowIndex} is out of range (column_starts begins at row ${starts[0].rowIndex})`,
    );
  }
  let segment = starts[0];
  for (const s of starts) {
    if (s.rowIndex <= rowIndex) segment = s;
    else break;
  }
  const split = splitRawAddress(segment.ref);
  if (split === null) {
    // Unreachable for parser-produced metas (refs are validated); guards hand-built ones.
    throw new ChapterFileError(`rowAddress: column_starts ref ${JSON.stringify(segment.ref)} does not end in a line number`);
  }
  return `${split.column}${split.line + (rowIndex - segment.rowIndex)}`;
}

/**
 * A work id is written bare when YAML reads it back as the same string, and
 * double-quoted otherwise. A slug that happens to be all digits ("1984") or a
 * YAML word ("true", "null") would come back as a number or a boolean, fail
 * the string check, and leave a file that cannot open; every other id keeps
 * the bare form existing files carry, so nothing is rewritten for its sake.
 */
function yamlPlainOrQuoted(value: string): string {
  try {
    if (yaml.load(value) === value) return value;
  } catch {
    // fall through to the quoted form
  }
  return JSON.stringify(value);
}

function serializeFrontmatter(meta: ChapterFileMeta): string {
  const lines = [
    '---',
    `schema_version: ${meta.schemaVersion}`,
    `work: ${yamlPlainOrQuoted(meta.work)}`,
    `book: ${meta.book}`,
    `chapter: ${meta.chapter}`,
    `citation_scheme: ${meta.citationScheme}`,
    `span_start: "${meta.spanStart}"`,
    `span_end: "${meta.spanEnd}"`,
  ];
  if (meta.columnStarts !== undefined) {
    if (meta.columnStarts.length === 0) {
      // An empty list would serialize to nothing and silently round-trip to
      // "absent" — refuse loudly instead of writing a lossy file.
      throw new ChapterFileError('serializeChapterFile: column_starts, when present, must contain at least one <columnRef>@<rowIndex> pair');
    }
    lines.push(`column_starts: "${meta.columnStarts.map((s) => `${encodeListRef(s.ref)}@${s.rowIndex}`).join(',')}"`);
  }
  if (meta.rowRefs !== undefined) {
    if (meta.rowRefs.length === 0) {
      // Same anti-lossy policy as column_starts: an empty list would
      // round-trip to "absent" — refuse loudly instead.
      throw new ChapterFileError('serializeChapterFile: row_refs, when present, must contain at least one address');
    }
    lines.push(`row_refs: "${meta.rowRefs.map(encodeListRef).join(',')}"`);
  }
  if (meta.lineSplits !== undefined) {
    if (meta.lineSplits.length === 0) {
      // Same policy as column_starts: an empty list would silently round-trip
      // to "absent" — refuse loudly instead of writing a lossy file.
      throw new ChapterFileError('serializeChapterFile: line_splits, when present, must contain at least one <address>@<offset> pair');
    }
    lines.push(`line_splits: "${meta.lineSplits.map((s) => `${encodeListRef(s.ref)}@${s.offset}`).join(',')}"`);
  }
  if (meta.paragraphStarts !== undefined) {
    if (meta.paragraphStarts.length === 0) {
      throw new ChapterFileError('serializeChapterFile: paragraph_starts, when present, must contain at least one row ordinal');
    }
    lines.push(`paragraph_starts: "${meta.paragraphStarts.join(',')}"`);
  }
  if (meta.headers !== undefined) {
    if (meta.headers.length === 0) {
      // Same anti-lossy policy as the other optional lists: an empty array
      // would round-trip to "absent" — refuse loudly instead.
      throw new ChapterFileError('serializeChapterFile: headers, when present, must contain at least one <row>:<level> pair');
    }
    lines.push(`headers: "${meta.headers.map((h) => `${h.row}:${h.level}`).join(',')}"`);
  }
  lines.push('---');
  return lines.join('\n');
}

/**
 * Serialize in the exact shape parseChapterFile expects back: one structural
 * blank line after each section's content when another section follows; the
 * file's single trailing newline is the structural terminator for the last
 * section. The parser drops exactly one trailing blank per section, so a
 * genuinely EMPTY final content row (trailing untranslated [ENGLISH] rows,
 * empty sections, footnote bodies ending in newlines) survives the round
 * trip by construction.
 *
 * `doc` may come straight from `parseChapterFile` (already normalized) OR be
 * hand-built in memory by the editor — e.g. a footnote body the collaborator
 * just typed/pasted, never round-tripped through parse. Either way, footnote
 * bodies get the U+2028/U+2029 → paragraph-break fold (`normalizeFootnoteSeparators`)
 * applied before assembly, so a raw separator never reaches disk. [GREEK]/
 * [ENGLISH] rows are NOT folded here: a row is one physical line by format
 * design, and folding U+2028/U+2029 in row content would itself risk turning
 * one row into extra physical lines on disk, corrupting the 1:1 GREEK/ENGLISH
 * row-count invariant — worse than leaving an inert stray separator in place.
 */
export function serializeChapterFile(doc: ChapterFile): string {
  const parts: string[] = [serializeFrontmatter(doc.meta)];

  parts.push('[GREEK]');
  parts.push(...doc.greekLines);
  parts.push(''); // structural blank before the next header

  parts.push('[ENGLISH]');
  parts.push(...doc.englishLines);

  if (doc.englishParaLines !== undefined && doc.englishParaLines.some((line) => line.length > 0)) {
    parts.push(''); // structural blank before the next header
    parts.push('[ENGLISH.PARA]');
    parts.push(...doc.englishParaLines);
  }

  if (doc.headingTitleLines !== undefined && doc.headingTitleLines.some((line) => line.length > 0)) {
    parts.push(''); // structural blank before the next header
    parts.push('[HEADING_TITLES]');
    parts.push(...doc.headingTitleLines);
  }

  if (doc.footnotes.length > 0) {
    parts.push(''); // structural blank before the next header
    parts.push('[FOOTNOTES]');
    for (const fn of doc.footnotes) {
      const bodyLines = normalizeFootnoteSeparators(fn.body).split('\n');
      parts.push(`${fn.id}: ${bodyLines[0]}`);
      parts.push(...bodyLines.slice(1).map(escapeFootnoteContinuation));
    }
  }

  return parts.join('\n') + '\n';
}
