// OCR dehyphenation — audit-by-exception, ported from the Python prototype's
// decision logic. A word split by a line-end hyphen ("under-\nstanding") needs
// rejoining; a genuine compound ("self-\nrestraint") must not be merged.
//
// Dictionary check via hunspell's en_US data (nspell — local, no network):
//   - fragment starts with a capital → ALWAYS review (proper nouns are exactly
//     what a dictionary can't judge);
//   - only the closed form is a word → auto-join;
//   - only the hyphenated form plausible (both parts are words, closed isn't)
//     → auto-keep-hyphen;
//   - both plausible, or neither → review. "Neither" is the expected, correct
//     outcome for transliterated Greek (eudaimonia, phronesis) and OCR garbage.
// The permissive parts-based compound check reproduces hunspell's known
// behavior; the resulting over-flagging is the accepted v1 tradeoff — do not
// add heuristics to suppress it.
//
// Review sites get an explicit, greppable marker in the text:
//   [REVIEW: "understanding" or "under-standing"?]
// which the import dialog's review queue resolves choice by choice.

import { lazy } from './runtime';

export interface HyphenDecision {
  original: string;      // "under-\nstanding" as matched
  closed: string;        // "understanding"
  hyphenated: string;    // "under-standing"
  action: 'joined' | 'kept-hyphen' | 'review';
  context: string;       // ~40 chars around the site, for the review UI
}

export interface DehyphenationResult {
  text: string;          // auto-decisions applied inline; review sites marked
  decisions: HyphenDecision[];
  reviewCount: number;
  ran: boolean;          // false = no OCR-style line-end hyphens detected
}

export const REVIEW_MARKER = /\[REVIEW: "([^"]+)" or "([^"]+)"\?\]/g;

// Hyphen immediately before a line break — not a mid-line hyphen.
const SITE = /([A-Za-z]+)-\r?\n([A-Za-z]+)/g;

type Spell = { correct(word: string): boolean };

// Loaded once; a failed load is not the answer for the rest of the session
// (lazy() evicts a rejection): the dialog reads a rejection as "dictionary
// unavailable" and skips hyphen review, so caching it would silently switch
// the feature off.
const spellChecker = lazy<Spell>(async () => {
  // The hunspell en_US data is vendored under assets (dictionary-en is a
  // Node-only package — it reads its files with fs); ?raw hands the .aff/
  // .dic contents to nspell as strings, which works in browser and Tauri
  // alike. See src/assets/dict-en/license (SCOWL, permissive).
  const [{ default: nspell }, aff, dic] = await Promise.all([
    import('nspell'),
    import('../assets/dict-en/index.aff?raw'),
    import('../assets/dict-en/index.dic?raw'),
  ]);
  return nspell(aff.default, dic.default) as Spell;
});

export async function dehyphenate(text: string): Promise<DehyphenationResult> {
  const sites = [...text.matchAll(SITE)];
  if (!sites.length) return { text, decisions: [], reviewCount: 0, ran: false };
  const spell = await spellChecker();

  const decisions: HyphenDecision[] = [];
  let out = '';
  let last = 0;
  for (const m of sites) {
    const [whole, f1, f2] = m;
    const closed = f1 + f2;
    const hyphenated = `${f1}-${f2}`;
    const closedOk = spell.correct(closed) || spell.correct(closed.toLowerCase());
    const partsOk = (spell.correct(f1) || spell.correct(f1.toLowerCase()))
      && (spell.correct(f2) || spell.correct(f2.toLowerCase()));
    const capital = /^[A-Z]/.test(f1);

    let action: HyphenDecision['action'];
    if (capital) action = 'review';
    else if (closedOk && !partsOk) action = 'joined';
    else if (!closedOk && partsOk) action = 'kept-hyphen';
    else action = 'review';

    const ctx = text.slice(Math.max(0, m.index! - 20), m.index! + whole.length + 20)
      .replace(/\s+/g, ' ');
    decisions.push({ original: whole, closed, hyphenated, action, context: ctx });

    out += text.slice(last, m.index!);
    out += action === 'joined' ? closed
      : action === 'kept-hyphen' ? hyphenated
      : `[REVIEW: "${closed}" or "${hyphenated}"?]`;
    last = m.index! + whole.length;
  }
  out += text.slice(last);

  return {
    text: out,
    decisions,
    reviewCount: decisions.filter(d => d.action === 'review').length,
    ran: true,
  };
}

/** A pending review site as surfaced in the queue UI. */
export interface ReviewItem {
  index: number;         // marker index in document order
  closed: string;
  hyphenated: string;
  context: string;
}

export function listReviewItems(text: string): ReviewItem[] {
  return [...text.matchAll(REVIEW_MARKER)].map((m, i) => ({
    index: i,
    closed: m[1],
    hyphenated: m[2],
    context: text.slice(Math.max(0, m.index! - 30), m.index! + m[0].length + 30)
      .replace(/\s+/g, ' '),
  }));
}

/** Apply the user's choices (marker index → chosen form) to the text. The
 *  queue UI collects a choice for every marker before calling this; the
 *  closed-form fallback only covers a marker the UI never surfaced. */
export function resolveReviews(text: string, choices: Map<number, string>): string {
  let i = -1;
  return text.replace(REVIEW_MARKER, (_whole, closed: string) => {
    i += 1;
    return choices.get(i) ?? closed;
  });
}
