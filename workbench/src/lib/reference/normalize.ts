// Stage-0-style text shaping for imported reference-translation OCR (design
// doc D5, S5). This is the TEXT-SHAPING half of Stage 0 only -- line endings,
// soft hyphens, hyphenation rejoin, paragraph collapse. It deliberately does
// NOT apply the Greek diacritic `norm` (see corpus norm.ts): reference text
// is English prose and diacritic folding has no business here.
//
// The line-ending/soft-hyphen/hyphen-rejoin logic mirrors (does not import)
// the equivalent handling in chapterfile/text.ts's normalizeText() and
// import/scrivenerMd.ts's hyphen-rejoin pass --
// duplicated here per this module's scope boundary (reference/** owns its
// own normalization; it does not reach into import/**).

export interface NormalizedReferenceText {
  /** Hard-wrapped OCR lines collapsed into reflowable paragraphs. For display. */
  display: string;
  /** Pre-collapse text (line-ending/soft-hyphen normalized only). For a future aligner. */
  rawKept: string;
}

/** U+00AD SOFT HYPHEN -- an invisible OCR line-wrap artifact. */
const SOFT_HYPHEN_RE = /\u00AD/g;
/** U+2028 LINE SEPARATOR / U+2029 PARAGRAPH SEPARATOR -- fold to a real LF. */
const UNICODE_SEPARATORS_RE = /[\u2028\u2029]/g;

/** CRLF/CR -> LF, fold U+2028/U+2029 to LF, strip soft hyphens, rejoin end-of-line hyphenation. */
function shapeLineEndingsAndHyphens(raw: string): string {
  let text = raw
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(UNICODE_SEPARATORS_RE, '\n')
    .replace(SOFT_HYPHEN_RE, '');

  // Rejoin end-of-line hyphenation: `word-\nbreak` -> `wordbreak`. Only when
  // both sides look like plain letters (conservative: avoids eating a
  // legitimate em/en-dash-adjacent line break or a hyphenated compound that
  // was never split for line-wrap reasons).
  text = text.replace(/([A-Za-z])-\n([a-z])/g, '$1$2');

  return text;
}

/**
 * Collapse hard-wrapped OCR lines into paragraphs: a single `\n` inside a
 * paragraph becomes a space; a blank line marks a paragraph break (kept as
 * `\n\n`). Runs of 2+ blank lines collapse to exactly one paragraph break.
 */
function collapseToParagraphs(text: string): string {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((block) =>
      block
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .join(' ')
        .trim(),
    )
    .filter((block) => block.length > 0);
  return paragraphs.join('\n\n');
}

/**
 * Normalize raw OCR/pasted reference text for storage and display.
 *
 * - `display`: paragraph-collapsed prose (what the panel renders).
 * - `rawKept`: the pre-collapse text, still line-ending/soft-hyphen
 *   normalized, preserved for a future line-matching aligner (D5 S6) that
 *   wants the original token/line shape rather than reflowed prose.
 */
export function normalizeReferenceText(raw: string): NormalizedReferenceText {
  const rawKept = shapeLineEndingsAndHyphens(raw)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const display = collapseToParagraphs(rawKept);
  return { display, rawKept };
}
