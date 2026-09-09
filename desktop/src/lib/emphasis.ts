// Markdown-emphasis classification for imported translations — audit-by-
// exception, same shape as dehyphenate.ts's decision/review pattern.
//
// Imported OCR/plain-text files (e.g. a Lennox Parts of Animals export) mix
// TWO uses of `_x_`/`*x*`/`**x**`:
//   - real markdown emphasis the source author intended (should RENDER italic
//     or bold in the reader)
//   - OCR noise / stray delimiters that happen to look like markdown (should
///    be CUT — the underscores/asterisks are not meaningful and must not leak
//     into the stored text or the reader)
// The parser can't always tell which is which, so ambiguous spans join a
// review queue in the import dialog, exactly like the dehyphenation step:
// approve/reject per item, with a sensible default pre-selected.
//
// Classification (per the design brief):
//   - well-formed span: balanced markers, 1–5 words inside, word-boundary
//     aligned (no space touching the marker on the inside, e.g. `_ x_` is
//     NOT well-formed) → CONFIDENT emphasis, auto-kept and rendered.
//   - malformed/unbalanced span, or a balanced span spanning MORE than ~8
//     words → SUSPICIOUS, review queue ("keep as italics" / "remove markers,
//     plain text"); default depends on the pattern (see chooseDefault).
//   - a stray single marker with no partner on the same line → SUSPICIOUS,
//     review, default "remove".
//
// Markers are stripped from the text at classification time (both confident
// AND suspicious-with-a-chosen-default get resolved before this module hands
// back), which is what lets translation-file.ts run this BEFORE scanTags:
// Bekker/annotation offsets are computed against the fully-clean text, never
// against text that still has literal `_`/`*` characters in it. (Phase 3
// inserts scanFootnoteMarkers between this pass and scanTags — see
// translation-file.ts's file header — but the relative order here is
// unchanged: emphasis is still resolved before either the footnote-marker
// strip or scanTags ever touch the text.)

export type EmphasisStyle = 'italic' | 'bold';

/** A confident (auto-rendered) emphasis span, offsets into the CLEAN
 *  (marker-stripped) text — i.e. already relative to the same text scanTags
 *  will run over. */
export interface EmphasisRange {
  start: number;
  end: number;          // exclusive
  style: EmphasisStyle;
}

export interface EmphasisReviewItem {
  index: number;         // marker index in document order (stable key for the UI)
  raw: string;           // the original marker-laden text, e.g. "_the good_"
  inner: string;         // the text between markers (or, for a stray marker, '')
  style: EmphasisStyle;
  reason: 'unbalanced' | 'too-long' | 'stray-marker' | 'mid-word';
  context: string;       // ~40 chars around the site, for the review UI
  defaultKeep: boolean;  // pre-selected default: true = "keep as italics/bold"
}

export interface EmphasisResult {
  text: string;          // confident spans stripped + rendered as ranges;
                          // suspicious spans still carry an inline REVIEW marker
  ranges: EmphasisRange[]; // confident spans only, offsets into `text`
  reviewItems: EmphasisReviewItem[];
  ran: boolean;          // false = no emphasis-shaped markers found at all
}

const MAX_CONFIDENT_WORDS = 5;
const MAX_PLAUSIBLE_WORDS = 8; // beyond this, always suspicious ("too-long")

function wordCount(s: string): number {
  return s.split(/\s+/).filter(Boolean).length;
}

// A marker touching a letter/digit on the wrong side (mid-word) — e.g.
// "hard_coded" or "self_documenting" — is OCR-noise-shaped (genuine markdown
// emphasis is never written mid-identifier in these sources) and should
// default to removal rather than italics.
function isMidWord(before: string, after: string): boolean {
  return /\w$/.test(before) || /^\w/.test(after);
}

// Inner text starting/ending with whitespace (e.g. `_ x_`/`_x _`) is the
// OCR-noise shape named in the design brief — never well-formed regardless
// of word count.
function hasInnerSpacing(inner: string): boolean {
  return inner.length === 0 || /^\s|\s$/.test(inner);
}

interface RawMatch {
  index: number;      // start of the marker run (the `_`/`*`/`**`)
  end: number;         // end of the CLOSING marker run (exclusive)
  whole: string;       // full matched text, markers included
  inner: string;       // text between the markers
  style: EmphasisStyle;
}

// One raw marker-run occurrence: `**` (bold), or a lone `_`/`*` not part of a
// `**` run (italic-shaped). Scanning marker RUNS first (rather than trying to
// regex-match whole balanced spans in one shot) is what lets an unpaired,
// mid-word, or otherwise malformed marker still be FOUND — a whole-span regex
// with strict boundary assertions silently skips exactly the malformed cases
// this module exists to catch.
interface MarkerRun { index: number; end: number; marker: '**' | '_' | '*'; }

const MARKER_RUN = /\*\*|_|\*/g;

// Fix 3: a single `*` that IS the entire label of a footnote-marker token
// `[^*]` (preceded by `[^`, followed by `]`) is not an emphasis candidate at
// all — it's the star/dagger work-level footnote vocabulary (§A3/§B5),
// scanned by the later scanFootnoteMarkers pass, not markdown emphasis. This
// module runs BEFORE scanFootnoteMarkers (locked pipeline order, §B2), so
// without this exclusion that `*` looks exactly like an ordinary stray
// asterisk and gets swallowed by the OCR-noise stray-marker cleanup below,
// corrupting `[^*]` before the footnote pass ever sees it. `**` runs are
// unambiguous (no footnote label is ever two stars) and are never checked
// here; only the single-`*` case is at risk.
function isFootnoteStarToken(text: string, index: number, end: number): boolean {
  return text.slice(Math.max(0, index - 2), index) === '[^' && text[end] === ']';
}

function findMarkerRuns(text: string): MarkerRun[] {
  const runs: MarkerRun[] = [];
  for (const m of text.matchAll(MARKER_RUN)) {
    const marker = m[0] as '**' | '_' | '*';
    const index = m.index!;
    const end = index + m[0].length;
    if (marker === '*' && isFootnoteStarToken(text, index, end)) continue;
    runs.push({ index, end, marker });
  }
  return runs;
}

/**
 * Pair adjacent same-marker runs within one paragraph (markers never pair
 * across a paragraph break — a genuine emphasis span is never written
 * spanning one). Unpaired runs (odd count in a paragraph) become strays.
 * `_` and `*` pair independently of each other (a `_..._` isn't closed by a
 * stray `*`).
 *
 * The text this sees has ALREADY been through normalizeParagraphBreaks
 * (translation-file.ts runs it before scanEmphasis, and emphasisScanInput
 * hands ImportDialog the same text), so every `\n` is a paragraph break.
 * Looking for a blank-line run here instead found none and let a stray `_`
 * at the end of one paragraph close against a stray at the start of the
 * next — a confident "emphasis span" across the break.
 */
function pairMarkers(text: string): { matches: RawMatch[]; strays: { index: number; end: number; style: EmphasisStyle }[] } {
  const matches: RawMatch[] = [];
  const strays: { index: number; end: number; style: EmphasisStyle }[] = [];

  const paraStarts = [0, ...[...text.matchAll(/\n/g)].map(m => m.index! + 1)];
  const paraEnds = [...paraStarts.slice(1).map((_, i) => paraStarts[i + 1]), text.length];

  // One scan of the whole text; runs never straddle a `\n`, so a forward
  // cursor partitions them by paragraph.
  const allRuns = findMarkerRuns(text);
  let ri = 0;
  for (let pi = 0; pi < paraStarts.length; pi++) {
    const pStart = paraStarts[pi], pEnd = paraEnds[pi];
    const runs: MarkerRun[] = [];
    while (ri < allRuns.length && allRuns[ri].end <= pEnd) {
      if (allRuns[ri].index >= pStart) runs.push(allRuns[ri]);
      ri += 1;
    }
    const pending: Record<'**' | '_' | '*', MarkerRun | null> = { '**': null, '_': null, '*': null };
    for (const run of runs) {
      const open = pending[run.marker];
      if (open) {
        const inner = text.slice(open.end, run.index);
        const style: EmphasisStyle = run.marker === '**' ? 'bold' : 'italic';
        matches.push({ index: open.index, end: run.end, whole: text.slice(open.index, run.end), inner, style });
        pending[run.marker] = null;
      } else {
        pending[run.marker] = run;
      }
    }
    for (const marker of ['**', '_', '*'] as const) {
      const leftover = pending[marker];
      if (leftover) strays.push({ index: leftover.index, end: leftover.end, style: marker === '**' ? 'bold' : 'italic' });
    }
  }
  matches.sort((a, b) => a.index - b.index);
  // A `**bold**` run also registers as two `*` marker-run boundaries once its
  // own `**` pairing consumes them — findMarkerRuns's regex tries `**` first
  // so `**` runs are never mis-split into two `*` runs to begin with; no
  // separate overlap resolution is needed.
  strays.sort((a, b) => a.index - b.index);
  return { matches, strays };
}

// Marker payload carries the style letter (i = italic, b = bold) so
// resolveEmphasisReviews doesn't need a caller-supplied style lookup.
export const EMPH_REVIEW_MARKER = /\[EREVIEW:(\d+):([ib])\]([\s\S]*?)\[\/EREVIEW\]/g;

/**
 * Scan raw body text for emphasis markers, classify each span, strip
 * confident ones straight into `ranges`, and wrap suspicious ones in an
 * inline review marker (same "resolve later" shape as dehyphenate.ts). Call
 * BEFORE scanTags — the returned `text` is what tag-scanning and alignment
 * should run over.
 */
export function scanEmphasis(raw: string): EmphasisResult {
  const { matches, strays } = pairMarkers(raw);

  if (!matches.length && !strays.length) {
    return { text: raw, ranges: [], reviewItems: [], ran: false };
  }

  type Site = { index: number; end: number; kind: 'span'; m: RawMatch } | { index: number; end: number; kind: 'stray'; style: EmphasisStyle };
  const sites: Site[] = [
    ...matches.map(m => ({ index: m.index, end: m.end, kind: 'span' as const, m })),
    ...strays.map(s => ({ index: s.index, end: s.end, kind: 'stray' as const, style: s.style })),
  ].sort((a, b) => a.index - b.index);

  const ranges: EmphasisRange[] = [];
  const reviewItems: EmphasisReviewItem[] = [];
  let out = '';
  let last = 0;
  let reviewIdx = 0;

  const ctxOf = (index: number, end: number) =>
    raw.slice(Math.max(0, index - 20), end + 20).replace(/\s+/g, ' ');

  for (const site of sites) {
    if (site.index < last) continue; // already consumed (shouldn't happen — pairMarkers produces non-overlapping sites)
    out += raw.slice(last, site.index);

    if (site.kind === 'stray') {
      reviewItems.push({
        index: reviewIdx,
        raw: raw.slice(site.index, site.end),
        inner: '',
        style: site.style,
        reason: 'stray-marker',
        context: ctxOf(site.index, site.end),
        defaultKeep: false, // default: remove
      });
      out += `[EREVIEW:${reviewIdx}:${site.style === 'bold' ? 'b' : 'i'}][/EREVIEW]`; // empty payload — resolve() just drops the marker chars
      reviewIdx += 1;
      last = site.end;
      continue;
    }

    const m = site.m;
    const words = wordCount(m.inner);
    const before = raw.slice(Math.max(0, m.index - 1), m.index);
    const after = raw.slice(m.end, m.end + 1);
    const midWord = isMidWord(before, after);
    const badSpacing = hasInnerSpacing(m.inner);

    const confident = !midWord && !badSpacing && words >= 1 && words <= MAX_CONFIDENT_WORDS;
    const reason: EmphasisReviewItem['reason'] | null = midWord ? 'mid-word'
      : words > MAX_CONFIDENT_WORDS ? 'too-long'
      : badSpacing ? 'unbalanced'
      : null;

    if (confident) {
      const startOff = out.length;
      out += m.inner;
      ranges.push({ start: startOff, end: startOff + m.inner.length, style: m.style });
    } else {
      // Suspicious: default depends on the pattern. Mid-word / very-long/
      // bad-spacing spans default to "remove markers, plain text" (OCR-noise-
      // shaped); a balanced, word-boundary-aligned span that's merely a bit
      // over the confident cap (6–8 words) defaults to "keep as italics" — it
      // still looks like deliberate emphasis, just long.
      const defaultKeep = reason === 'too-long' && words <= MAX_PLAUSIBLE_WORDS && !midWord;
      reviewItems.push({
        index: reviewIdx,
        raw: m.whole,
        inner: m.inner,
        style: m.style,
        reason: reason ?? 'unbalanced',
        context: ctxOf(m.index, m.end),
        defaultKeep,
      });
      out += `[EREVIEW:${reviewIdx}:${m.style === 'bold' ? 'b' : 'i'}]${m.inner}[/EREVIEW]`;
      reviewIdx += 1;
    }
    last = m.end;
  }
  out += raw.slice(last);

  return { text: out, ranges, reviewItems, ran: true };
}

/** Pending review sites as surfaced in the queue UI, walking the CURRENT
 *  (post-scanEmphasis) text — mirrors dehyphenate.ts's listReviewItems. */
export function listEmphasisReviewItems(text: string, seed: EmphasisReviewItem[]): (EmphasisReviewItem & { context: string; before: string; hit: string; after: string })[] {
  const bySeed = new Map(seed.map(s => [s.index, s]));
  const clean = (t: string) => t.replace(/\[EREVIEW:\d+:[ib]\]|\[\/EREVIEW\]/g, '').replace(/\s+/g, ' ');
  return [...text.matchAll(EMPH_REVIEW_MARKER)].map(m => {
    const idx = Number(m[1]);
    const s = bySeed.get(idx)!;
    const inner = m[3];
    const start = m.index!;
    const end = start + m[0].length;
    // Split the snippet into before / hit / after so the UI can spotlight exactly
    // what was flagged. `hit` is the emphasised span for a real span, or the orphan
    // marker glyph itself for a stray (whose payload is empty and would otherwise
    // collapse to nothing, leaving nothing to point at).
    const hit = clean(inner) || s.raw;
    const before = clean(text.slice(Math.max(0, start - 30), start));
    const after = clean(text.slice(end, end + 30));
    return { ...s, inner, before, hit, after, context: `${before}${hit}${after}` };
  });
}

/**
 * Apply the user's per-item choices ('keep' → strip markers and record an
 * EmphasisRange at its final offset in the resolved text; 'remove' → strip
 * markers, no range) and return the fully-clean text plus the confident
 * ranges found earlier, REMAPPED to the resolved text's offsets.
 *
 * `text` (scanEmphasis's output) still contains confident ranges as plain
 * stripped text — `priorRanges` are offsets into THIS text — interleaved with
 * `[EREVIEW:idx:i|b]inner[/EREVIEW]` wrappers for suspicious spans. Stripping a
 * wrapper shortens the text by the wrapper syntax's length, which shifts
 * every offset AFTER it — including any confident range that falls later in
 * the document — so prior offsets can't be reused verbatim; each is remapped
 * through the same cumulative shift computed while walking the markers here.
 */
export function resolveEmphasisReviews(
  text: string,
  priorRanges: EmphasisRange[],
  choices: Map<number, 'keep' | 'remove'>,
): { text: string; ranges: EmphasisRange[] } {
  const sortedPrior = [...priorRanges].sort((a, b) => a.start - b.start);
  const remapped: EmphasisRange[] = [];
  let priorPtr = 0;
  let shift = 0; // cumulative chars removed by wrapper syntax seen so far

  // Single left-to-right pass over the markers: build the resolved text AND
  // remap every confident range whose original offset falls before the
  // marker currently being processed, using the shift accumulated up to that
  // point (a confident range can never fall INSIDE a review marker's span —
  // scanEmphasis's sites are non-overlapping by construction).
  let out = '';
  let last = 0;
  for (const m of text.matchAll(EMPH_REVIEW_MARKER)) {
    out += text.slice(last, m.index!);
    while (priorPtr < sortedPrior.length && sortedPrior[priorPtr].start < m.index!) {
      const r = sortedPrior[priorPtr];
      remapped.push({ start: r.start - shift, end: r.end - shift, style: r.style });
      priorPtr += 1;
    }
    const idx = Number(m[1]);
    const style: EmphasisStyle = m[2] === 'b' ? 'bold' : 'italic';
    const inner = m[3];
    const choice = choices.get(idx) ?? 'remove';
    if (choice === 'keep') {
      const startOff = out.length;
      out += inner;
      remapped.push({ start: startOff, end: startOff + inner.length, style });
    } else {
      out += inner;
    }
    shift += m[0].length - inner.length; // wrapper syntax stripped, inner text kept
    last = m.index! + m[0].length;
  }
  out += text.slice(last);
  while (priorPtr < sortedPrior.length) {
    const r = sortedPrior[priorPtr];
    remapped.push({ start: r.start - shift, end: r.end - shift, style: r.style });
    priorPtr += 1;
  }
  remapped.sort((a, b) => a.start - b.start);
  return { text: out, ranges: remapped };
}
