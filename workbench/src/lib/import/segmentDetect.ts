/**
 * Detect how freshly pasted/imported free text should be segmented into rows
 * — 'lines' (verse, one-unit-per-line) or 'paragraphs' (flowing prose,
 * blank-line-separated blocks) — plus the two pure splitters that turn text
 * into rows once a unit is chosen. See workbench-design/d8-view-modes.md §3
 * ("Document segmentation type chosen at import") and §6 ("Import").
 *
 * This module is a HEURISTIC PRE-SELECTION only: the import dialog always
 * lets the user override the guess (d8 §3), so false positives just cost a
 * click, not data — when in doubt we lean toward whichever guess is cheaper
 * to override, not toward being "clever."
 */

import { normalizeText } from '../chapterfile/text';

// ── heuristic thresholds (named, tuned for prose-vs-verse, not exact science) ─

/**
 * A non-blank line at or above this many characters reads as a wrapped or
 * unwrapped prose line rather than a verse line. Ordinary prose sentences
 * wrapped by an editor or exported from a word processor commonly run
 * 60-100+ columns; short poetic lines are usually well under this.
 */
const LONG_LINE_CHARS = 60;

/**
 * A non-blank line at or below this many characters reads as a short,
 * deliberately-broken verse/one-unit line rather than wrapped prose.
 */
const SHORT_LINE_CHARS = 40;

/**
 * Fraction of non-blank lines that must be "short" (<= SHORT_LINE_CHARS) for
 * the whole text to be classified as line-based (verse-like). Chosen well
 * above half so a few short prose lines (e.g. a salutation, a heading) don't
 * flip a mostly-prose text into 'lines'.
 */
const SHORT_LINE_FRACTION = 0.6;

/**
 * Guess the row unit for a block of free text.
 *
 * - Empty (or whitespace-only) text, and a single short non-blank line, both
 *   default to 'lines' (the degenerate/too-little-signal case — nothing here
 *   looks like flowing prose, and 'lines' is the smaller, easier-to-fix unit
 *   for a one-liner).
 * - Otherwise: if most non-blank lines are short (>= SHORT_LINE_FRACTION at
 *   or under SHORT_LINE_CHARS), it reads as verse ⇒ 'lines'.
 * - A single long block with no blank-line breaks at all (one giant
 *   paragraph, or hard-wrapped prose with no blank separators) ⇒
 *   'paragraphs' once it has more than one line and isn't short-line-heavy.
 * - Default otherwise ⇒ 'paragraphs' (blank-line-separated prose blocks,
 *   wrapped or not, is the common case this heuristic targets).
 */
export function detectUnit(text: string): 'lines' | 'paragraphs' {
  const normalized = normalizeText(text).trim();
  if (normalized.length === 0) return 'lines';

  const allLines = normalized.split('\n');
  const nonBlank = allLines.map((l) => l.trim()).filter((l) => l.length > 0);
  if (nonBlank.length === 0) return 'lines';
  if (nonBlank.length === 1) {
    return nonBlank[0].length >= LONG_LINE_CHARS ? 'paragraphs' : 'lines';
  }

  const shortCount = nonBlank.filter((l) => l.length <= SHORT_LINE_CHARS).length;
  if (shortCount / nonBlank.length >= SHORT_LINE_FRACTION) return 'lines';

  return 'paragraphs';
}

/**
 * Split text into paragraph rows: blocks separated by one-or-more blank
 * lines. Within a block, hard-wrapped lines are unwrapped by joining with a
 * single space; each row is whitespace-trimmed; empty blocks are dropped.
 */
export function splitIntoParagraphRows(text: string): string[] {
  const normalized = normalizeText(text);
  const blocks = normalized.split(/\n\s*\n+/);
  const out: string[] = [];
  for (const block of blocks) {
    const joined = block
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .join(' ')
      .trim();
    if (joined.length > 0) out.push(joined);
  }
  return out;
}

export interface LineRowsResult {
  /** Non-blank lines in order, trailing whitespace trimmed. */
  lines: string[];
  /** 1-based indices into `lines` where a new blank-line-separated group starts. */
  paragraphStarts: number[];
}

/**
 * Split text into line rows, tracking blank-line-separated groups. Blank
 * lines are dropped from `lines` but recorded as group boundaries in
 * `paragraphStarts` (1-based, first line is always a start). No blank lines
 * anywhere in the text ⇒ `paragraphStarts` is just `[1]`.
 */
export function splitIntoLineRows(text: string): LineRowsResult {
  const normalized = normalizeText(text);
  const rawLines = normalized.split('\n');

  const lines: string[] = [];
  const paragraphStarts: number[] = [];
  let atGroupStart = true;

  for (const raw of rawLines) {
    if (raw.trim().length === 0) {
      atGroupStart = true;
      continue;
    }
    lines.push(raw.replace(/\s+$/, ''));
    if (atGroupStart) paragraphStarts.push(lines.length);
    atGroupStart = false;
  }

  return { lines, paragraphStarts };
}
