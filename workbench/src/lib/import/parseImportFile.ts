/**
 * Parse the canonical Scrivener-import file — frontmatter + a [GREEK] block and
 * an [ENGLISH] block, one physical line per Bekker line, matched by position.
 * See workbench-design/d3-scrivener-import.md §8 and
 * workbench/scripts/scrivener-import-guide.md for the format.
 *
 *   ---
 *   work: metaphysics
 *   book: 7
 *   chapter: 17
 *   bekker_start: 1041a6   # optional hint; NOT parsed here (§8: "No Bekker parsing")
 *   ---
 *   [GREEK]
 *   Τί δὲ χρὴ λέγειν …
 *   …
 *   [ENGLISH]
 *   What, then, should we say …
 *   …
 *
 * This module does the mechanical parse and the two PRE-ALIGNMENT guards from
 * d3 §7 — (d) [GREEK]/[ENGLISH] count mismatch, (e) an empty block — and NOTHING
 * else. `bekker_start` is carried through as an opaque raw string; only plan.ts
 * hands it to the scheme. Success/failure is a typed union (no throwing): the
 * caller renders `failure.message` verbatim (§7 sentences with real counts
 * interpolated) and logs `failure.detail` to the console.
 */

import yaml from 'js-yaml';
import {
  detectFormat,
  normalizeScrivenerPair,
  toParsedImportFile,
  type ImportFormat,
  type ScrivenerForm,
} from './scrivenerMd';

export { detectFormat };
export type { ImportFormat, ScrivenerForm };

/** Frontmatter of an import file — flat scalars, `bekker_start` optional. */
export interface ImportFrontmatter {
  work: string;
  /** May be absent — an unhinted file triggers the whole-work sweep (§4). */
  book?: number;
  chapter?: number;
  /** Opaque raw address string; parsed only by plan.ts via the scheme. */
  bekkerStart?: string;
}

export interface ParsedImportFile {
  frontmatter: ImportFrontmatter;
  greek: string[];
  english: string[];
  /**
   * Present ONLY for a scrivener-md import (Stage 0). Carries the marker
   * skeleton, the joined Greek flow, English segments, and footnotes that
   * plan.ts needs to run Greek re-lineation + marker-segment distribution
   * (d3a §3/§4). The canonical path never sets this; consumers that don't
   * understand it read `greek`/`english` and ignore it (additive, optional).
   * Typed as `unknown` here to avoid a parseImportFile → scrivenerMd import
   * cycle; plan.ts narrows it to `ScrivenerNormalized`.
   */
  scrivener?: unknown;
}

/** Which pre-alignment guard rejected the file (maps to d3 §7 rows d/e). */
export type ImportParseFailureKind =
  | 'no-frontmatter'
  | 'bad-frontmatter'
  | 'missing-section'
  | 'count-mismatch' // §7 (d)
  | 'empty-block'; // §7 (e)

export interface ImportParseFailure {
  ok: false;
  kind: ImportParseFailureKind;
  /** User-facing sentence — verbatim d3 §7 for (d)/(e), plain for the rest. */
  message: string;
  /** Console-only detail (never shown to the user). */
  detail: string;
}

export interface ImportParseSuccess {
  ok: true;
  value: ParsedImportFile;
}

export type ImportParseResult = ImportParseSuccess | ImportParseFailure;

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const SECTION_HEADERS = ['[GREEK]', '[ENGLISH]'] as const;
type SectionHeader = (typeof SECTION_HEADERS)[number];

function normalizeLineEndings(raw: string): string {
  // A byte-order mark (some Windows editors write one) is not content and
  // must not read as "the file has no header".
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function fail(kind: ImportParseFailureKind, message: string, detail: string): ImportParseFailure {
  return { ok: false, kind, message, detail };
}

function isSectionHeader(line: string): line is SectionHeader {
  return (SECTION_HEADERS as readonly string[]).includes(line);
}

/**
 * Split the post-frontmatter body into per-header line arrays. Anything before
 * the first header must be blank (the same discipline chapterfile/parse.ts uses).
 * Trailing/leading blank lines around a block are structure, not content, and
 * are trimmed so a stray final newline never inflates the line count.
 */
function splitSections(body: string): Map<SectionHeader, string[]> {
  const lines = body.split('\n');
  const sections = new Map<SectionHeader, string[]>();
  let current: SectionHeader | null = null;
  let buf: string[] = [];

  const flush = () => {
    if (current) sections.set(current, trimBlankEdges(buf));
  };

  for (const line of lines) {
    if (isSectionHeader(line)) {
      flush();
      current = line;
      buf = [];
    } else if (current !== null) {
      buf.push(line);
    }
    // lines before the first header (blank separators) are ignored
  }
  flush();
  return sections;
}

/** Drop leading and trailing all-blank lines (block boundary structure). */
function trimBlankEdges(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === '') start++;
  while (end > start && lines[end - 1].trim() === '') end--;
  return lines.slice(start, end);
}

export function parseImportFile(raw: string): ImportParseResult {
  const normalized = normalizeLineEndings(raw);

  const m = FRONTMATTER_RE.exec(normalized);
  if (!m) {
    return fail(
      'no-frontmatter',
      "This file is missing its header — it should start with a \"---\" block naming the work, book, and chapter.",
      'no leading --- frontmatter block',
    );
  }

  let parsed: unknown;
  try {
    parsed = yaml.load(m[1]);
  } catch (err) {
    return fail(
      'bad-frontmatter',
      "This file's header couldn't be read — check the lines between the \"---\" markers.",
      `frontmatter YAML error: ${(err as Error).message}`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return fail(
      'bad-frontmatter',
      "This file's header couldn't be read — check the lines between the \"---\" markers.",
      'frontmatter is not a YAML mapping',
    );
  }
  const v = parsed as Record<string, unknown>;

  const work = v['work'];
  if (typeof work !== 'string' || work.length === 0) {
    return fail(
      'bad-frontmatter',
      "This file's header doesn't name a work — add a \"work:\" line, e.g. work: metaphysics.",
      'frontmatter has no non-empty "work"',
    );
  }

  const frontmatter: ImportFrontmatter = { work };
  if (v['book'] !== undefined) {
    if (typeof v['book'] !== 'number' || !Number.isInteger(v['book'])) {
      return fail(
        'bad-frontmatter',
        "This file's header has a \"book:\" value that isn't a whole number.",
        `frontmatter "book" is not an integer: ${JSON.stringify(v['book'])}`,
      );
    }
    frontmatter.book = v['book'];
  }
  if (v['chapter'] !== undefined) {
    if (typeof v['chapter'] !== 'number' || !Number.isInteger(v['chapter'])) {
      return fail(
        'bad-frontmatter',
        "This file's header has a \"chapter:\" value that isn't a whole number.",
        `frontmatter "chapter" is not an integer: ${JSON.stringify(v['chapter'])}`,
      );
    }
    frontmatter.chapter = v['chapter'];
  }
  if (v['bekker_start'] !== undefined) {
    // Carried opaquely; the scheme parses it in plan.ts. A number in the YAML
    // (unquoted "1041a6" is a string, but a bare number is possible) is
    // stringified so downstream sees a raw address string uniformly.
    frontmatter.bekkerStart = String(v['bekker_start']).trim();
  }

  const sections = splitSections(normalized.slice(m[0].length));
  const greek = sections.get('[GREEK]');
  const english = sections.get('[ENGLISH]');
  if (greek === undefined) {
    return fail('missing-section', 'This file has no [GREEK] section.', 'missing [GREEK] header');
  }
  if (english === undefined) {
    return fail('missing-section', 'This file has no [ENGLISH] section.', 'missing [ENGLISH] header');
  }

  // Guard (e): empty block. d3 §7 sentence verbatim.
  if (greek.length === 0 || english.length === 0) {
    const which = greek.length === 0 ? '[GREEK]' : '[ENGLISH]';
    return fail(
      'empty-block',
      `This file's ${which} section is empty — there's nothing to import.`,
      `${which} block has zero content lines`,
    );
  }

  // Guard (d): count mismatch. d3 §7 sentence verbatim, real counts interpolated.
  if (greek.length !== english.length) {
    return fail(
      'count-mismatch',
      `This file has ${greek.length} Greek lines but ${english.length} English lines — they must match one-to-one; fix the file and try again.`,
      `[GREEK]=${greek.length} vs [ENGLISH]=${english.length}`,
    );
  }

  return { ok: true, value: { frontmatter, greek, english } };
}

/**
 * Format-detection dispatch (d3a §1). Classify a single file's format WITHOUT
 * parsing it — the dialog uses this to pick the canonical path (single file)
 * vs. the scrivener-md path (two files + a form). `canonical` → feed to
 * `parseImportFile`; `scrivener-md` → collect the pair and call
 * `parseScrivenerPair`; `unknown` → refuse with the §1 sentence.
 */
export function classifyImportFile(raw: string): ImportFormat {
  return detectFormat(raw);
}

/** The §1 refusal sentence for an unrecognized file. */
export const UNKNOWN_FORMAT_MESSAGE =
  "This file isn't a chapter export I recognize — it needs either the workbench's own saved format, or a Greek-and-English pair exported from Scrivener with Bekker line numbers.";

/**
 * Parse a scrivener-md Greek+English PAIR into a `ParsedImportFile` carrying the
 * `scrivener` side-channel plan.ts consumes (d3a §1/§8). Frontmatter comes from
 * the dialog `form` (the form UI arrives in a later task). This is the
 * scrivener-md analogue of `parseImportFile` for the canonical path; the two
 * converge on the same `ParsedImportFile` shape and the same preview UI.
 *
 * Detection is enforced defensively: if NEITHER file looks like scrivener-md
 * (no markers, no Greek), the pair is refused with the §1 sentence rather than
 * silently producing an empty plan.
 */
export function parseScrivenerPair(
  greekRaw: string,
  englishRaw: string,
  form: ScrivenerForm,
): ImportParseResult {
  const gFmt = detectFormat(greekRaw);
  const eFmt = detectFormat(englishRaw);
  if (gFmt !== 'scrivener-md' && eFmt !== 'scrivener-md') {
    return fail('missing-section', UNKNOWN_FORMAT_MESSAGE, `neither file is scrivener-md (greek=${gFmt}, english=${eFmt})`);
  }
  const normalized = normalizeScrivenerPair(greekRaw, englishRaw, form);
  return { ok: true, value: toParsedImportFile(normalized) };
}
