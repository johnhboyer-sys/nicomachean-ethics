// The shared translation-file format: YAML-ish frontmatter + inline {…} tags.
// One format for BOTH the official pre-tagged catalog downloads and personal
// uploads of copyrighted translations — only `license` and provenance differ.
//
// Tag syntax (tag, one space, then the word it precedes):
//   {1.7}    chapter anchor (book.chapter)
//   {1094a}  Bekker column anchor — resets the line-number context
//   {20}     literal Bekker line number, read as "line 20 of the current column"
// Tags are the TRUE printed numbers from the source edition, never a computed
// running count. Density is always DETECTED by scanning, never trusted from a
// self-reported field, and drives how much alignment fills the gaps.
//
// The frontmatter parser is deliberately tiny: the schema is flat scalars
// only (formatVersion, work, translator, license, year, source, language,
// id), written by the app's metadata form — users never hand-author YAML.
//
// Markdown emphasis (`_x_`, `*x*`, `**x**`) is classified and stripped BEFORE
// scanTags ever runs (see scanEmphasis in emphasis.ts) — the confident spans
// are auto-resolved here; ambiguous ones fall back to their pattern-based
// default UNLESS the caller already resolved them interactively. ImportDialog
// is the interactive path: it runs the same emphasis.ts review queue used
// here (mirroring the existing dehyphenation review step) BEFORE calling
// runImport, so by the time a fresh import reaches this module every marker
// is already gone from the text. parseTranslationFile still runs the pass
// itself (idempotent — no markers left, `scanEmphasis` is a no-op) so a
// re-import of a file that was never routed through the dialog (a hand-typed
// fixture, or a previously-exported file whose markers were never reviewed
// interactively the first time) still comes out clean rather than leaking
// literal `_`/`*` into stored text.
//
// Ordering matters: scanTags computes tag offsets by walking the body and
// stripping `{tag}` syntax as it goes, so emphasis markers MUST be gone
// before scanTags runs — otherwise every tag offset after a marker would be
// off by the marker syntax's length, and Bekker/annotation offsets would be
// computed against text that still had literal `_`/`*` in it. Emphasis
// ranges themselves are then rebased through scanTags's own tag-stripping
// pass (see scanTags) so they land in the SAME final offset space as tags.
//
// Phase 3 (footnotes) adds a fourth pass between emphasis and tags, and a
// zeroth pass before either: a translation file may carry a footnote
// DEFINITIONS block at the very end, sentinel-delimited (`<!-- footnotes -->`
// / `<!-- footnotes scope=... -->`), and inline `[^label]` markers glued into
// the body next to the word they annotate (same vocabulary the Reader
// already renders footnotes with). The full pass order is now:
//
//   0. splitFootnoteBlock(parseFrontmatter(raw)) — slice the sentinel-
//      delimited block off the END of the raw body FIRST, before anything
//      else touches the text. Note text is full of `_`/`*`-shaped
//      substrings and Bekker-shaped cross-references that must never reach
//      body scanning or the aligned clean text.
//   1. normalizeParagraphBreaks(body)
//   2. scanEmphasis(body) → emphText ({tag}s and [^label]s still present,
//      emphasis markers gone) + emphRanges (offsets into emphText)
//   3. scanFootnoteMarkers(emphText) → fnText ([^label] REMOVED) + markers
//      (offsets into fnText, measured as `clean.length` at each removal,
//      exactly like scanTags's own offset bookkeeping) + emphRanges2
//      (emphRanges rebased through the marker strip — ONE extra carry)
//   3b. collapseBlankRuns(fnText) — a line the two strips emptied out (a
//      `* * *` separator of stray markers, a marker alone on its line) is
//      a new blank run; collapse it HERE, carrying emphasis and marker
//      offsets through the same collapse, so scanTags never re-normalizes
//      text after offsets were measured in it. Also the last point at which
//      line endings matter: CRLF was already folded to LF in step 0.
//   4. scanTags(fnText) → { text, tags } + emphasis(final) = rebase
//      emphRanges2 through the tag strip (second carry) + markers(final) =
//      rebase markers through the tag strip (its only carry) — reusing the
//      SAME rebaseThroughTagStrip machinery for both, since both were
//      measured in fnText's coordinate system.
//
// No offset is ever rebased through a removal already applied to the text it
// was measured in (the double-shift double-shift this order is designed to
// avoid): emphasis picks up exactly two carries (marker strip, then tag
// strip); markers pick up exactly one (tag strip only — they were never
// measured in pre-emphasis or pre-marker-strip space to begin with). A file
// with no sentinel and no `[^label]` markers is unaffected by any of this —
// splitFootnoteBlock and scanFootnoteMarkers are no-ops on such a file, so
// parseTranslationFile's output is BYTE-IDENTICAL to a pre-Phase-3 parse.

import { scanEmphasis, resolveEmphasisReviews } from './emphasis';

export type License = 'public-domain' | 'cc-by' | 'cc-by-sa' | 'user-supplied';

export interface TranslationMeta {
  formatVersion: number;
  work: string;            // must match a corpus slug; the UI enforces via dropdown
  translator: string;
  license: License;        // unrecognised/omitted → 'user-supplied' (fail restrictive)
  year?: number;
  source?: string;
  language: string;        // default 'en'
  id: string;              // auto-slugged from translator+work if omitted
  // Free-text full bibliographic citation, e.g. "Aristotle. Parts of Animals
  // I–IV. Trans. James G. Lennox. Oxford: Clarendon Press, 2001." Optional —
  // when absent, callers compose a "translator (year), source" fallback
  // (see composeCitation below) rather than leaving Copy Citation empty.
  citation?: string;
  // Bekker citations the import aligner must NOT extrapolate as estimate ticks
  // (`noTicks: 81a40 87a40 …`) — a column whose print stops short of line 40
  // still has a 40 in the Greek reference, so the tail fill would invent one.
  // Whitespace-separated in the frontmatter; per-source ground truth.
  noTicks?: string[];
}

export interface InlineTag {
  kind: 'chapter' | 'column' | 'line';
  raw: string;             // tag text without braces, e.g. "1.7", "1094a", "20"
  offset: number;          // char offset into the CLEAN text where the tagged word begins
  book?: number;           // chapter tags
  chapter?: number;        // chapter tags
  column?: string;         // column tags, and line tags once resolved ("1094a")
  line?: number;           // line tags
  citation?: string;       // resolved Bekker citation ("1094a20") for column/line tags
}

export type TagDensity = 'exhaustive' | 'five-line-or-column' | 'chapter-only' | 'none';

// A run of confident (or user-approved) markdown emphasis, offsets into the
// SAME clean `text` as InlineTag.offset — see emphasis.ts for classification.
export interface EmphasisSpan {
  start: number;
  end: number;           // exclusive
  style: 'italic' | 'bold';
}

// A footnote marker's placement in the clean text — same offset space as
// InlineTag.offset / EmphasisSpan.start — plus its identity. `label` is the
// full stable identity (continuous: "222"; per-chapter: "2.3.1"; per-book:
// "2.1"; work-level: "*"/"†"); `display` is the trailing numeric/glyph
// component actually rendered ([^2.3.1] shows "1") — see §B5.
export interface FootnoteMarker {
  offset: number;
  label: string;
  display: string;
}

export type FootnoteScope = 'continuous' | 'per-book' | 'per-chapter';

export interface ParsedTranslation {
  meta: Partial<TranslationMeta>;   // {} when the file has no frontmatter yet
  hasFrontmatter: boolean;
  text: string;                     // body with all tags AND emphasis markers stripped
  tags: InlineTag[];                // in document order, offsets into `text`
  emphasis: EmphasisSpan[];         // in document order, offsets into `text`
  density: TagDensity;
  warnings: string[];               // suspect tag sequences — surfaced, never auto-fixed
  footnoteMarkers: FootnoteMarker[]; // in document order, offsets into `text`
  footnotes: Record<string, string>; // label -> note text (verbatim, from the definitions block)
  footnoteScope: FootnoteScope;      // recorded from the sentinel's scope= attribute (AM2); default continuous
  noteRender?: 'endnote';            // sentinel's render= attribute — endnotes open a sidebar, not the popover
}

const LICENSES: License[] = ['public-domain', 'cc-by', 'cc-by-sa', 'user-supplied'];

export function slugId(translator: string, work: string): string {
  return `${translator}-${work}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// ── frontmatter ─────────────────────────────────────────────────────────────

function parseFrontmatter(raw: string): { meta: Partial<TranslationMeta>; body: string; has: boolean } {
  // A UTF-8 byte-order mark (Windows Notepad, some OCR exports) sits before
  // the opening `---`; left in place it defeats the `^---` match and the whole
  // header is read as body prose.
  raw = raw.replace(/^\uFEFF/, '');
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { meta: {}, body: raw, has: false };
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (!kv) continue;
    // Frontmatter values are single physical lines; a multiline citation typed
    // into the form is stored with escaped `\n` (see serializeFrontmatter) and
    // unescaped back here.
    meta[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '').replace(/\\n/g, '\n');
  }
  const out: Partial<TranslationMeta> = {};
  if (meta.formatVersion) out.formatVersion = Number(meta.formatVersion);
  if (meta.work) out.work = meta.work;
  if (meta.translator) out.translator = meta.translator;
  // Fail toward the restrictive reading: anything unrecognised is user-supplied.
  out.license = LICENSES.includes(meta.license as License)
    ? (meta.license as License) : 'user-supplied';
  if (meta.year && !Number.isNaN(Number(meta.year))) out.year = Number(meta.year);
  if (meta.source) out.source = meta.source;
  out.language = meta.language || 'en';
  if (meta.id) out.id = meta.id;
  if (meta.citation) out.citation = meta.citation;
  if (meta.noTicks) {
    const refs = meta.noTicks.split(/[\s,]+/).filter(Boolean);
    if (refs.length) out.noTicks = refs;
  }
  return { meta: out, body: raw.slice(m[0].length), has: true };
}

/**
 * Peel a leading frontmatter header off a raw import (layout or tagged),
 * returning the parsed header metadata and the body with the block removed.
 * Layout imports carry a `noTicks` header the ImportDialog reads BEFORE running
 * the frozen converter (which would otherwise fold the header into body text).
 */
export function splitFrontmatter(raw: string): { meta: Partial<TranslationMeta>; body: string } {
  const { meta, body } = parseFrontmatter(raw);
  return { meta, body };
}

export function serializeFrontmatter(meta: TranslationMeta): string {
  const lines = [
    '---',
    `formatVersion: ${meta.formatVersion}`,
    `work: ${meta.work}`,
    `translator: ${meta.translator}`,
    `license: ${meta.license}`,
    ...(meta.year !== undefined ? [`year: ${meta.year}`] : []),
    ...(meta.source ? [`source: "${meta.source.replace(/"/g, "'")}"`] : []),
    `language: ${meta.language}`,
    `id: ${meta.id}`,
    ...(meta.citation ? [`citation: "${meta.citation.replace(/"/g, "'").replace(/\r?\n/g, '\\n')}"`] : []),
    ...(meta.noTicks && meta.noTicks.length ? [`noTicks: ${meta.noTicks.join(' ')}`] : []),
    '---',
    '',
  ];
  return lines.join('\n');
}

/**
 * The Copy Citation / picker fallback for an import that lacks a `citation`:
 * "Translator (Year), Source" with either piece dropped if absent. Shared by
 * the ImportDialog (to pre-fill the form) and imports.ts (read-time default
 * for records — including pre-existing ones — stored without a citation).
 */
export function composeCitation(meta: Pick<TranslationMeta, 'translator' | 'year' | 'source'>): string {
  const who = meta.year ? `${meta.translator} (${meta.year})` : meta.translator;
  return meta.source ? `${who}, ${meta.source}` : who;
}

// ── footnote definitions block (§B1) ────────────────────────────────────────

// AM2: `<!-- footnotes -->` or `<!-- footnotes scope=continuous -->` (also
// per-book / per-chapter). The parser records the attribute when present;
// absent ⇒ continuous (emission always writes the attribute — that's the
// emit side's job, not the parser's). The optional `render=endnote`
// attribute marks commentary-class ENDNOTES — the reader shows them in a
// slide-in sidebar instead of the footnote popover.
const FOOTNOTE_SENTINEL_RE = /^<!--\s*footnotes(?:\s+scope=(continuous|per-book|per-chapter))?(?:\s+render=(endnote))?\s*-->\s*$/;

// §B1 definition grammar: `[^label]: text`, optionally continued on
// following lines indented >=3 spaces (appended to the prior definition).
const FOOTNOTE_DEF_RE = /^\[\^([\w.*†]+)\]:[ \t]?(.*)$/;
const FOOTNOTE_DEF_CONT_RE = /^ {3,}(\S.*)$/;

function parseFootnoteDefs(lines: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  let current: string | null = null;
  for (const line of lines) {
    const def = FOOTNOTE_DEF_RE.exec(line);
    if (def) {
      current = def[1];
      out[current] = def[2];
      continue;
    }
    const cont = FOOTNOTE_DEF_CONT_RE.exec(line);
    if (cont && current !== null) {
      out[current] = `${out[current]} ${cont[1].trim()}`.trim();
      continue;
    }
    current = null; // blank line or unrecognised content ends the current definition
  }
  return out;
}

/**
 * §B1: split the sentinel-delimited footnote-definitions block off the END
 * of the raw body — BEFORE normalizeParagraphBreaks/scanEmphasis/scanTags
 * ever run, so note text (full of `_`/`*`-shaped substrings and Bekker-shaped
 * cross-references like "1103a3") never reaches body scanning or the
 * aligned clean text. Backward compatibility: no sentinel found ⇒ the whole
 * input is returned as `body` unchanged, `footnotes` = {}, `footnoteScope` =
 * 'continuous' — a suffix-only removal that never touches a legacy file.
 *
 * Fix 4 hardening: uses the LAST sentinel-shaped line in the file, not the
 * first — a translator's editorial comment mid-body could itself quote or
 * closely resemble `<!-- footnotes -->`, and taking the first match would
 * slice everything from THAT point to EOF into "the footnote block",
 * silently truncating however much genuine body prose follows. Having found
 * a candidate, the split is also validated: every non-blank line after it
 * must look like a definition (`[^label]: ...`) or a >=3-space continuation
 * of one. If it doesn't — the sentinel-shaped line was mid-body prose, not a
 * real block boundary — the split is abandoned, the whole input is returned
 * as `body` unchanged, and a warning is surfaced (never a silent truncation).
 */
export function splitFootnoteBlock(body: string): {
  body: string;
  footnotes: Record<string, string>;
  footnoteScope: FootnoteScope;
  noteRender?: 'endnote';
  warnings: string[];
  /**
   * Line index (input split on /\r?\n/) of the sentinel this split actually
   * used, present only when a split happened. The pre-cleaner needs the
   * boundary as a position in the ORIGINAL bytes and must not re-derive it
   * from a second, differently-spelled sentinel regex: two spellings disagree
   * on a line ending in a non-ASCII space, and the file then splits one way
   * here and another way there, leaving note definitions in the body.
   */
  sentinelLine?: number;
} {
  const lines = body.split(/\r?\n/);
  let sentinelIdx = -1;
  let scope: FootnoteScope = 'continuous';
  let noteRender: 'endnote' | undefined;
  for (let i = 0; i < lines.length; i++) {
    const m = FOOTNOTE_SENTINEL_RE.exec(lines[i]);
    if (m) {
      sentinelIdx = i; // keep scanning — the LAST match wins, not the first
      if (m[1]) scope = m[1] as FootnoteScope;
      noteRender = m[2] ? 'endnote' : undefined;
    }
  }
  if (sentinelIdx === -1) return { body, footnotes: {}, footnoteScope: 'continuous', warnings: [] };

  const tail = lines.slice(sentinelIdx + 1);
  const validTail = tail.every(line =>
    line.trim() === '' || FOOTNOTE_DEF_RE.test(line) || FOOTNOTE_DEF_CONT_RE.test(line));
  if (!validTail) {
    return {
      body,
      footnotes: {},
      footnoteScope: 'continuous',
      warnings: ['footnote block sentinel found but content is not definitions — treated as body'],
    };
  }

  return {
    body: lines.slice(0, sentinelIdx).join('\n'),
    footnotes: parseFootnoteDefs(tail),
    footnoteScope: scope,
    noteRender,
    warnings: [],
    sentinelLine: sentinelIdx,
  };
}

// ── inline tags ─────────────────────────────────────────────────────────────

// Phase-4A grammar extension (additive, backward compatible): a column tag
// is 1–4 page digits + a/b + an OPTIONAL 1–2-digit STARTING LINE. `{1181a25}`
// = column 1181a entered at line 25 (Magna Moralia opens mid-column); no
// trailing digits = line 1 exactly as before. Pages of 1–2 digits are now
// legal too (`{16a}` De Interpretatione, `{1a}` Categories).
//
// Ambiguity check: `{15}` (bare line tag) vs `{15a}` (column tag) are
// DISTINCT — the letter disambiguates; `{1.7}` chapter tags are unchanged.
// No legacy file changes meaning under the new grammar: legacy files contain
// only 3–4-digit columns without line suffixes and 1–2-digit bare lines,
// whose parses are byte-identical under the new regex (pinned by
// translation-file-tags.test.ts).
const TAG = /\{([0-9]+\.[0-9]+|[0-9]{1,4}[ab][0-9]{0,2}|[0-9]{1,2})\}[ \t]?/g;
const CHAPTER_TAG = /^[0-9]+\.[0-9]+$/;
const COLUMN_TAG = /^([0-9]{1,4})([ab])([0-9]{1,2})?$/;

// Markdown/plain-text sources mark a paragraph break with a blank line (one
// or more), i.e. two-or-more `\n` in the raw text. The Reader's flowing-prose
// renderer (Reader.svelte's flowParts/addText) instead expects exactly ONE
// `\n` per paragraph break — it splits on `\n` and turns every piece (including
// the empty string between two adjacent `\n`s) into a `<br class="para-br">`,
// so a source's blank-line convention would render as TWO breaks per
// paragraph, doubling the vertical rhythm vs. built-in translations (whose
// pipeline-emitted text already uses the single-`\n` convention). Collapsing
// here — before tag offsets are computed — also absorbs any stray double
// blank lines in the source (e.g. Gutenberg files sometimes have two blank
// lines before a section break) into the same single paragraph break, rather
// than emitting an extra blank line's worth of gap.
const BLANK_RUN = /[ \t]*\n(?:[ \t]*\n)+[ \t]*/g;

function normalizeParagraphBreaks(body: string): string {
  return body.replace(BLANK_RUN, '\n');
}

// CRLF (and bare CR) line endings become LF before any scanning: BLANK_RUN
// only knows `\n`, so a Windows-saved file otherwise keeps every blank line
// (double paragraph breaks in the reader) and carries a `\r` into the clean
// text of every line — where the aligner's word snapping treats it as a
// letter. Done in parseTranslationFile / emphasisScanInput, never in
// parseFrontmatter: import-preclean.ts measures its frontmatter prefix as a
// byte length of the raw upload, which must stay exact.
function normalizeLineEndings(body: string): string {
  return body.replace(/\r\n?/g, '\n');
}

/**
 * Collapse blank-line runs that an earlier removal pass opened up (a
 * Gutenberg `* * *` separator whose asterisks were stray emphasis markers
 * leaves a whitespace-only line behind) and carry a set of offsets measured
 * in `text` into the collapsed text's space. An offset inside a collapsed
 * run lands just after the one `\n` that survives it. scanTags used to
 * re-run normalizeParagraphBreaks on its own, silently shortening the text
 * AFTER emphasis ranges and footnote markers had been measured — every
 * offset after such a line then drifted by the characters removed.
 */
function collapseBlankRuns(text: string, offsets: number[]): { text: string; offsets: number[] } {
  const runs = [...text.matchAll(BLANK_RUN)];
  if (!runs.length) return { text, offsets };
  const rebased = offsets.map(off => {
    let shift = 0;
    for (const m of runs) {
      const start = m.index!;
      const end = start + m[0].length;
      if (off >= end) { shift += m[0].length - 1; continue; }
      if (off > start) return start - shift + 1;
      break;
    }
    return off - shift;
  });
  return { text: text.replace(BLANK_RUN, '\n'), offsets: rebased };
}

/** Walks text whose paragraph breaks are already normalized (one `\n` each). */
function scanTags(body: string): { text: string; tags: InlineTag[]; warnings: string[] } {
  const tags: InlineTag[] = [];
  const warnings: string[] = [];
  let clean = '';
  let last = 0;
  let column: string | null = null;
  let lastLine = 0;
  for (const m of body.matchAll(TAG)) {
    clean += body.slice(last, m.index!);
    last = m.index! + m[0].length;
    const raw = m[1];
    const offset = clean.length;
    if (CHAPTER_TAG.test(raw)) {
      const [b, c] = raw.split('.').map(Number);
      tags.push({ kind: 'chapter', raw, offset, book: b, chapter: c });
    } else if (COLUMN_TAG.test(raw)) {
      const cm = COLUMN_TAG.exec(raw)!;
      const col = `${cm[1]}${cm[2]}`;
      const startLine = cm[3] !== undefined ? Number(cm[3]) : null;
      if (column !== null && columnKey(col) <= columnKey(column)) {
        warnings.push(`column {${col}} does not advance from {${column}} — check the source tags`);
      }
      column = col;
      // Legacy identity: a suffix-less column tag leaves lastLine at 0 (so a
      // following {1} line tag doesn't warn), exactly as before. A suffixed
      // tag enters the column mid-way, so the suffix becomes the line context.
      lastLine = startLine ?? 0;
      const line = startLine ?? 1;
      tags.push({ kind: 'column', raw, offset, column: col, line, citation: `${col}${line}` });
    } else {
      const n = Number(raw);
      if (column === null) {
        warnings.push(`line tag {${raw}} before any column tag — ignored (no column context)`);
        continue;
      }
      if (n <= lastLine) {
        warnings.push(`line {${raw}} does not advance within ${column} (previous: ${lastLine})`);
      }
      lastLine = n;
      tags.push({ kind: 'line', raw, offset, column, line: n, citation: `${column}${n}` });
    }
  }
  clean += body.slice(last);
  return { text: clean, tags, warnings };
}

/**
 * Rebase offsets computed against `body` into the offset space of the text
 * produced by removing every match of `re` from `body` left-to-right —
 * replaying the identical removal and accumulating how much each one shifts
 * everything after it. Mirrors a scan-and-strip pass's own `clean += …`
 * accumulation exactly, so an offset that pass would place at clean-text
 * position P is rebased to that same P here. Shared by rebaseThroughTagStrip
 * ({tag} removal) and the footnote-marker strip ([^label] removal) — same
 * machinery, different regex, per Phase-3 §B2.
 */
function rebaseThroughRemoval(body: string, re: RegExp, offsets: number[]): number[] {
  const shifts: { at: number; amount: number }[] = [];
  let removed = 0;
  for (const m of body.matchAll(re)) {
    removed += m[0].length;
    shifts.push({ at: m.index! + m[0].length, amount: removed });
  }
  return offsets.map(off => {
    let shift = 0;
    for (const s of shifts) {
      if (s.at > off) break;
      shift = s.amount;
    }
    return off - shift;
  });
}

/**
 * Rebase offsets (e.g. emphasis ranges) computed against `body` — the SAME
 * pre-tag-stripped text scanTags(body) walks — into the post-strip text's
 * offset space, by replaying the identical left-to-right `{tag}` removal and
 * accumulating how much each removal shifts everything after it. Mirrors
 * scanTags' own `clean += …` accumulation exactly, so an offset that scanTags
 * would place at clean-text position P is rebased to that same P here.
 */
function rebaseThroughTagStrip(body: string, offsets: number[]): number[] {
  return rebaseThroughRemoval(body, TAG, offsets);
}

// ── footnote markers (§B2) ──────────────────────────────────────────────────

// `[^label]`, glued after the marked word/punctuation — reuses the Reader's
// existing `[^N]` vocabulary; `label` widens it to `[\w.*†]+` (continuous
// digits, dotted per-chapter/per-book identities, or the star/dagger glyphs).
const FOOTNOTE_MARKER = /\[\^([\w.*†]+)\]/g;

/** §B5: the trailing component actually rendered ([^2.3.1] shows "1"). */
function footnoteDisplay(label: string): string {
  if (label === '*' || label === '†') return label;
  const parts = label.split('.');
  return parts[parts.length - 1];
}

/**
 * New pass (§B2), run AFTER emphasis resolution and BEFORE scanTags: strip
 * `[^label]` markers out of `emphText`, recording each one's identity and
 * its offset in the CLEAN (marker-stripped) text — measured as `clean.length`
 * at the point of removal, exactly like scanTags' own tag-offset bookkeeping,
 * so the marker is already in fnText's coordinate system and needs only ONE
 * further carry (through the tag strip) to reach final text-space.
 */
function scanFootnoteMarkers(emphText: string): { text: string; markers: FootnoteMarker[] } {
  const markers: FootnoteMarker[] = [];
  let clean = '';
  let last = 0;
  for (const m of emphText.matchAll(FOOTNOTE_MARKER)) {
    clean += emphText.slice(last, m.index!);
    last = m.index! + m[0].length;
    const label = m[1];
    markers.push({ offset: clean.length, label, display: footnoteDisplay(label) });
  }
  clean += emphText.slice(last);
  return { text: clean, markers };
}

/**
 * Rebase emphasis ranges (measured in emphText-space, BEFORE footnote
 * markers are stripped) through the marker-strip removal — the ONE extra
 * carry emphasis needs relative to markers (see the file-header ordering
 * notes): an emphasis span can never straddle a marker (scanEmphasis and
 * scanFootnoteMarkers both work on non-overlapping, well-formed spans), so
 * this only ever shifts ranges that fall entirely after a removed marker.
 */
function rebaseThroughMarkerStrip(emphText: string, offsets: number[]): number[] {
  return rebaseThroughRemoval(emphText, FOOTNOTE_MARKER, offsets);
}

/** Bekker column sort key: 1a < 1b < … < 1094a < 1094b < 1095a … (pages of
 *  1–2 digits are legal since the Phase-4A grammar extension: Categories/De
 *  Int live on them). */
export function columnKey(col: string): number {
  const m = col.match(/^(\d{1,4})([ab])$/);
  return m ? Number(m[1]) * 2 + (m[2] === 'b' ? 1 : 0) : -1;
}

// ── density detection ───────────────────────────────────────────────────────

function detectDensity(tags: InlineTag[]): TagDensity {
  const lines = tags.filter(t => t.kind === 'line');
  const columns = tags.filter(t => t.kind === 'column');
  const chapters = tags.filter(t => t.kind === 'chapter');
  if (!lines.length && !columns.length) {
    return chapters.length ? 'chapter-only' : 'none';
  }
  if (!lines.length) return 'five-line-or-column';
  // Median gap between consecutive line numbers within a column: an
  // exhaustively-tagged source advances by 1–2, a five-line apparatus by ~5.
  // (A Phase-4A column tag with a line suffix, e.g. {1181a25}, counts exactly
  // like any column tag here — its `line` is the entered line, so the gap to
  // the column's next mark is measured from the true entry point.)
  const gaps: number[] = [];
  const byCol = new Map<string, number[]>();
  for (const t of [...columns, ...lines]) {
    const arr = byCol.get(t.column!) ?? [];
    arr.push(t.line!);
    byCol.set(t.column!, arr);
  }
  for (const ns of byCol.values()) {
    const sorted = [...ns].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) gaps.push(sorted[i] - sorted[i - 1]);
  }
  if (!gaps.length) return 'five-line-or-column';
  gaps.sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)];
  return median <= 2 ? 'exhaustive' : 'five-line-or-column';
}

// ── entry point ─────────────────────────────────────────────────────────────

/**
 * The exact text scanEmphasis will run over inside parseTranslationFile:
 * frontmatter stripped, paragraph breaks normalized. ImportDialog's review
 * queue calls this (rather than passing `file.text` straight to scanEmphasis)
 * so its review-item indices are guaranteed to match the indices
 * parseTranslationFile's OWN internal scanEmphasis call produces later —
 * scanEmphasis is a pure function, so identical input text is what makes the
 * dialog's collected choices replay correctly (see parseTranslationFile).
 */
export function emphasisScanInput(raw: string): string {
  // Must match parseTranslationFile's own input to scanEmphasis exactly
  // (including the §B1 footnote-block split, now run first there too), or a
  // file WITH a sentinel would hand the dialog different text than the
  // parser scans and the review-item indices would no longer line up.
  return normalizeParagraphBreaks(splitFootnoteBlock(normalizeLineEndings(parseFrontmatter(raw).body)).body);
}

/**
 * `emphasisChoices` (marker-review index → 'keep'/'remove') carries the
 * decisions ImportDialog's interactive emphasis review queue already
 * collected — scanEmphasis is a pure function of the input text, so re-
 * running it here on the SAME raw body reproduces the identical review-item
 * indices the dialog saw, and the user's choices replay exactly rather than
 * falling back to defaults. Omitted (undefined) for any caller that hands
 * this function text that never went through the dialog's review step (a
 * re-import of a file whose markers were never reviewed interactively, a test
 * fixture, or a hand-authored file) — suspicious spans then auto-resolve to
 * scanEmphasis's own pattern-based default rather than fail or leave literal
 * markers in stored text. This is what makes "re-import an existing
 * translation" safe without forcing a second review pass, at the
 * acknowledged cost that a file WITH markers that change classification
 * between versions could shift annotation offsets on that translation —
 * flagged in the import summary, not silently absorbed.
 */
export function parseTranslationFile(
  raw: string,
  emphasisChoices?: Map<number, 'keep' | 'remove'>,
): ParsedTranslation {
  const { meta, body: rawBody, has } = parseFrontmatter(raw);
  // §B1: slice the sentinel-delimited footnote block off the end FIRST — its
  // text never reaches normalizeParagraphBreaks/scanEmphasis/scanTags. A
  // legacy file with no sentinel passes rawBody through unchanged.
  const { body: bodyBeforeFootnotes, footnotes, footnoteScope, noteRender, warnings: footnoteWarnings } =
    splitFootnoteBlock(normalizeLineEndings(rawBody));
  const body = normalizeParagraphBreaks(bodyBeforeFootnotes);
  const emphResult = scanEmphasis(body);
  let emphText = emphResult.text;      // {tag} and [^label] syntax still present, emphasis markers gone
  let emphRanges = emphResult.ranges;  // offsets into emphText
  if (emphResult.reviewItems.length) {
    const choices = emphasisChoices ?? new Map<number, 'keep' | 'remove'>(
      emphResult.reviewItems.map(it => [it.index, it.defaultKeep ? 'keep' : 'remove']),
    );
    const resolved = resolveEmphasisReviews(emphText, emphRanges, choices);
    emphText = resolved.text;
    emphRanges = resolved.ranges;
  }
  // §B2: strip `[^label]` markers out of emphText BEFORE scanTags runs, so a
  // marker glued next to a tag never shifts the tag's own offset arithmetic.
  // Emphasis ranges pick up their SECOND carry here (marker strip); markers
  // themselves are already in fnText-space and need none yet.
  const { text: strippedText, markers: strippedMarkers } = scanFootnoteMarkers(emphText);
  const markerStripStarts = rebaseThroughMarkerStrip(emphText, emphRanges.map(r => r.start));
  const markerStripEnds = rebaseThroughMarkerStrip(emphText, emphRanges.map(r => r.end));
  emphRanges = emphRanges.map((r, i) => ({ ...r, start: markerStripStarts[i], end: markerStripEnds[i] }));
  // Both strips can leave a whitespace-only line behind (a `* * *` separator,
  // a marker alone on its line). Collapse those runs now, carrying every
  // emphasis and marker offset through the same collapse, so scanTags walks
  // final-shape text and no later offset drifts.
  const collapsed = collapseBlankRuns(strippedText, [
    ...emphRanges.map(r => r.start),
    ...emphRanges.map(r => r.end),
    ...strippedMarkers.map(m => m.offset),
  ]);
  const fnText = collapsed.text;
  const n = emphRanges.length;
  emphRanges = emphRanges.map((r, i) => ({ ...r, start: collapsed.offsets[i], end: collapsed.offsets[n + i] }));
  const rawMarkers = strippedMarkers.map((m, i) => ({ ...m, offset: collapsed.offsets[2 * n + i] }));
  // scanTags strips {tag} syntax out of fnText, shifting every offset after
  // each tag — rebase the emphasis ranges (now in fnText-space) AND the
  // footnote-marker offsets (already in fnText-space, their only carry)
  // through that same left-to-right removal, identically to how scanTags
  // places its own tag offsets.
  const { text, tags, warnings: tagWarnings } = scanTags(fnText);
  const warnings = [...footnoteWarnings, ...tagWarnings];
  const starts = rebaseThroughTagStrip(fnText, emphRanges.map(r => r.start));
  const ends = rebaseThroughTagStrip(fnText, emphRanges.map(r => r.end));
  const emphasis: EmphasisSpan[] = emphRanges.map((r, i) => ({ start: starts[i], end: ends[i], style: r.style }));
  const markerOffsets = rebaseThroughTagStrip(fnText, rawMarkers.map(m => m.offset));
  const footnoteMarkers: FootnoteMarker[] = rawMarkers.map((m, i) => ({ ...m, offset: markerOffsets[i] }));
  return {
    meta, hasFrontmatter: has, text, tags, emphasis, warnings, density: detectDensity(tags),
    footnoteMarkers, footnotes, footnoteScope, noteRender,
  };
}

/**
 * Split the parsed body into per-chapter prose keyed "book:chapter", with each
 * chapter's own tags AND emphasis spans rebased to chapter-local offsets — the
 * unit the aligner consumes. Text before the first chapter tag (translator's
 * preface etc.) is returned under `preamble` rather than silently dropped.
 *
 * Chapter-local offsets are relative to the slice BEFORE `.trim()` (matching
 * the existing tag-rebasing behaviour) — a chapter's leading whitespace is
 * never nonzero in practice since a tag always precedes the first WORD, and
 * emphasis spans/tags alike never fall in that leading gap.
 */
export function splitChapters(p: ParsedTranslation): {
  preamble: string;
  chapters: {
    book: number;
    chapter: number;
    text: string;
    tags: InlineTag[];
    emphasis: EmphasisSpan[];
    footnoteMarkers: FootnoteMarker[];
  }[];
} {
  const chapterTags = p.tags.filter(t => t.kind === 'chapter');
  if (!chapterTags.length) return { preamble: '', chapters: [] };
  const preamble = p.text.slice(0, chapterTags[0].offset).trim();
  const chapters = chapterTags.map((ct, i) => {
    const start = ct.offset;
    const end = i + 1 < chapterTags.length ? chapterTags[i + 1].offset : p.text.length;
    const slice = p.text.slice(start, end);
    // A chapter tag typed on its own line (`{1.1}\nEvery art…`) leaves a
    // leading `\n` the tag regex does not swallow; trimming it without
    // rebasing put every offset in that chapter one character early.
    const lead = slice.length - slice.trimStart().length;
    const text = slice.trim();
    const local = (offset: number) => Math.max(0, Math.min(offset - start - lead, text.length));
    return {
      book: ct.book!,
      chapter: ct.chapter!,
      text,
      tags: p.tags
        .filter(t => t.kind !== 'chapter' && t.offset >= start && t.offset < end)
        .map(t => ({ ...t, offset: local(t.offset) })),
      emphasis: p.emphasis
        .filter(e => e.start >= start && e.end <= end)
        .map(e => ({ ...e, start: local(e.start), end: local(e.end) })),
      // §B3: sliced per chapter like tags/emphasis, same chapter-local offset
      // convention — but with a boundary rule of its own (Fix 2): a marker
      // is glued right after the word it annotates, so a marker sitting
      // exactly at a chapter boundary is the LAST character of the chapter
      // it ENDS, never the first character of the chapter that follows —
      // `(start, end]`, not `[start, end)`. The old `[start, end)` rule
      // dropped a marker entirely when it landed on the very last chapter's
      // end (offset === end === p.text.length never satisfies `< end`) and,
      // for an interior boundary, would have handed it to the WRONG
      // (following) chapter instead. The one exception is offset 0 at the
      // very first chapter: with the new strict `>` lower bound that
      // position would otherwise never be claimed by any chapter (a
      // preamble has no footnoteMarkers slot of its own), so `i === 0`
      // admits it explicitly.
      footnoteMarkers: p.footnoteMarkers
        .filter(m => (m.offset > start && m.offset <= end) || (i === 0 && m.offset === 0))
        .map(m => ({ ...m, offset: local(m.offset) })),
    };
  });
  return { preamble, chapters };
}

export interface ChapterKeyAuditOptions {
  /**
   * The work's printed book labels (`WORKS[].bookLabels`). Storage indices are
   * contiguous, but the print numbering need not be — the Eudemian Ethics
   * stores five books labelled I, II, III, VII, VIII — so a refusal quoting
   * "books 1–5" would send the reader looking for a book IV that is not
   * missing from the file at all.
   */
  bookLabels?: string[];
  /**
   * Book index → the last chapter that book has, from `chapters.json`.
   * Supplying this map means "the chapter index was loaded": a book inside
   * the work's registry range that is then MISSING from the map has not been
   * audited, and the audit refuses rather than waving it through. A map is
   * an authority only over what it contains; silence in it is not a pass.
   * (Chapter *gaps* inside a book are R6's job, not this audit's.)
   */
  chaptersPerBook?: ReadonlyMap<number, number>;
}

function bookRange(maxBooks: number, bookLabels?: string[]): string {
  const range = `books 1–${maxBooks}`;
  return bookLabels && bookLabels.length === maxBooks
    ? `${range}, printed ${bookLabels.join('/')}`
    : range;
}

function bookName(book: number, bookLabels?: string[]): string {
  const label = bookLabels?.[book - 1];
  return label && label !== String(book) ? `book ${book} (printed ${label})` : `book ${book}`;
}

/**
 * Reject chapter keys that cannot safely feed the importer's per-key prose
 * map. The check uses tag order from the source and runs after the work is
 * known, so book bounds come from that work's registry entry and chapter
 * bounds from its `chapters.json`.
 */
export function auditChapterKeys(
  tags: InlineTag[],
  maxBooks: number,
  options: ChapterKeyAuditOptions = {},
): void {
  const { bookLabels, chaptersPerBook } = options;
  const chapters = tags.filter(tag => tag.kind === 'chapter');
  const seen = new Set<string>();
  let previous: InlineTag | null = null;
  for (const tag of chapters) {
    const key = `${tag.book}.${tag.chapter}`;
    if (!tag.book || !tag.chapter || tag.book > maxBooks) {
      throw new Error(
        `Chapter key {${key}} is out of range for the selected work (${bookRange(maxBooks, bookLabels)}).`,
      );
    }
    if (chaptersPerBook) {
      const lastChapter = chaptersPerBook.get(tag.book);
      if (lastChapter === undefined) {
        throw new Error(
          `Chapter key {${key}} cannot be checked: this work's chapter index has no `
          + `entry for ${bookName(tag.book, bookLabels)}, so the importer cannot tell `
          + 'a real chapter from a mis-read numeral. Nothing was imported.',
        );
      }
      if (tag.chapter > lastChapter) {
        throw new Error(
          `Chapter key {${key}} is out of range: ${bookName(tag.book, bookLabels)} `
          + `has ${lastChapter} chapter${lastChapter === 1 ? '' : 's'}.`,
        );
      }
    }
    if (previous) {
      const bookRestart = tag.book < previous.book!;
      const chapterRestart = tag.book === previous.book
        && tag.chapter === 1
        && previous.chapter! > 1;
      if (bookRestart || chapterRestart) {
        throw new Error(`Restarted chapter key {${key}} follows {${previous.book}.${previous.chapter}}.`);
      }
      if (tag.book === previous.book && tag.chapter! < previous.chapter!) {
        throw new Error(`Backward chapter key {${key}} follows {${previous.book}.${previous.chapter}}.`);
      }
    }
    if (seen.has(key)) {
      throw new Error(`Duplicate chapter key {${key}} would replace earlier prose.`);
    }
    seen.add(key);
    previous = tag;
  }
}
