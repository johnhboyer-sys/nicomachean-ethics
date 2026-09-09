// Link and label helpers shared by the reader shell and a work's landing page
// (src/lib/nav.ts). All three are one-liners whose failure modes are silent:
// a chapter link that turns from a hash into a full navigation reloads the page
// on every outline click; one that turns the other way makes every cross-book
// link in the drawer a no-op.
import { describe, expect, it } from 'vitest';
import { bookSpan, chapterHref, translatorName } from '../lib/nav';

describe('chapterHref', () => {
  it('is a bare hash for a chapter in the book already open', () => {
    expect(chapterHref('/aristotle-reader', 'EN', 3, 3, '7')).toBe('#ch-3-7');
  });

  it('navigates to the other book, landing on the same anchor', () => {
    expect(chapterHref('/aristotle-reader', 'EN', 3, 5, '2'))
      .toBe('/aristotle-reader/EN/book/5#ch-5-2');
  });

  it('prefixes the base path so the GitHub Pages sub-path is not lost', () => {
    expect(chapterHref('/aristotle-reader', 'Meta', 1, 2, '1'))
      .toBe('/aristotle-reader/Meta/book/2#ch-2-1');
    expect(chapterHref('', 'Meta', 1, 2, '1')).toBe('/Meta/book/2#ch-2-1');
  });

  // Chapter ids are strings: "7", but also "10a" and the like in works whose
  // chapters were subdivided. The anchor must be the id verbatim, since that is
  // what the reader stamps on the chapter head.
  it('uses the chapter id verbatim, not a number', () => {
    expect(chapterHref('', 'EN', 1, 1, '10a')).toBe('#ch-1-10a');
  });
});

describe('translatorName', () => {
  it('keeps the person and drops the publisher and year', () => {
    expect(translatorName('W. D. Ross (Oxford, 1908)')).toBe('W. D. Ross');
  });

  it('leaves a name with no parenthetical alone', () => {
    expect(translatorName('Benjamin Jowett')).toBe('Benjamin Jowett');
  });

  // A work with no translation at all: the meta description and JSON-LD both
  // branch on the empty string, so undefined must not become "undefined".
  it('is the empty string when there is no translation', () => {
    expect(translatorName(undefined)).toBe('');
  });

  // Splits on " (" — the space matters, so an initialism keeps its brackets.
  it('does not split a parenthesis that is part of the name', () => {
    expect(translatorName('J. A. Smith(rev.) (Oxford, 1931)')).toBe('J. A. Smith(rev.)');
  });
});

describe('bookSpan', () => {
  const ch = (bekker: string) => ({ bekker });

  it('reads "N chapters · first–last" across the book\'s Bekker range', () => {
    expect(bookSpan([ch('1094a1–1094b11'), ch('1094b12–1095a13'), ch('1095a14–1096a10')]))
      .toBe('3 chapters · 1094a1–1096a10');
  });

  it('says "1 chapter", singular', () => {
    expect(bookSpan([ch('1094a1–1094b11')])).toBe('1 chapter · 1094a1–1094b11');
  });

  // A work with no Bekker lines (the Isagoge's Busse pages are handled
  // elsewhere) must still get a readable count rather than " · –".
  it('drops the range when the chapters carry no Bekker span', () => {
    expect(bookSpan([ch(''), ch('')])).toBe('2 chapters');
  });

  it('handles a book whose chapter list is empty', () => {
    expect(bookSpan([])).toBe('0 chapters');
  });

  // A one-chapter book: first and last are the same entry, and the range must
  // still read across it rather than collapsing to a single number.
  it('spans a single chapter from its own start to its own end', () => {
    expect(bookSpan([ch('980a21–982a3')])).toBe('1 chapter · 980a21–982a3');
  });
});
