// The lemma page's arithmetic and link-building (src/lib/lemma-view.ts,
// extracted from components/LemmaPage.astro). Every one of these numbers ends
// up in markup the page cannot be rendered to check here, and a wrong one is
// silent: a bar of zero width, a book heading that says "1" instead of "Α", a
// deep link that lands at the top of the book instead of on the line.
import { describe, expect, it } from 'vitest';
import { buildWorksView, freqBarPct, instanceHref, type WorkInstances } from '../lib/lemma-view';

const chapter = (n: number) => ({
  chapter: '1',
  bekker: '1094a1–1094b1',
  instances: Array.from({ length: n }, (_, i) => ['1094a', i + 1, 'ἀρετή'] as [string, number, string]),
});

const work = (over: Partial<WorkInstances> = {}): WorkInstances => ({
  work: 'EN', title: 'Nicomachean Ethics', count: 10, shown: 10,
  books: [{ book: 1, chapters: [chapter(10)] }],
  ...over,
});

describe('instanceHref', () => {
  it('deep-links to the Bekker line and highlights the surface form', () => {
    expect(instanceHref('/aristotle-reader', 'EN', 2, ['1103a', 17, 'aretes']))
      .toBe('/aristotle-reader/EN/book/2?hlg=aretes&loc=1103a:17');
  });

  // The surface form is polytonic Greek. Unencoded it would be raw non-ASCII in
  // a query string, and any surface containing & or # would truncate the link.
  it('percent-encodes the Greek surface form', () => {
    const href = instanceHref('', 'EN', 1, ['1094a', 5, 'ἀρετή']);

    expect(href).toBe('/EN/book/1?hlg=%E1%BC%80%CF%81%CE%B5%CF%84%CE%AE&loc=1094a:5');
    expect(href).not.toContain('ἀρετή');
  });

  it('survives a base path of "" (the dev server) unchanged', () => {
    expect(instanceHref('', 'Cat', 1, ['1a', 1, 'x'])).toBe('/Cat/book/1?hlg=x&loc=1a:1');
  });

  // workPath clamps to the work's real book range, so a stale book number for a
  // now-bookless work cannot produce a 404 link.
  it('clamps an out-of-range book to one the work actually has', () => {
    expect(instanceHref('', 'Cat', 99, ['1a', 1, 'x'])).toBe('/Cat/book/1?hlg=x&loc=1a:1');
  });
});

describe('freqBarPct', () => {
  it('scales against the most-frequent work', () => {
    expect(freqBarPct(100, 100)).toBe(100);
    expect(freqBarPct(50, 100)).toBe(50);
  });

  // A work with a single occurrence must still show a sliver of bar; at 0.2% it
  // rounds to nothing and the row reads as if the count were zero.
  it('floors a tiny share at 2% so one occurrence is still visible', () => {
    expect(freqBarPct(1, 5000)).toBe(2);
    expect(freqBarPct(0, 5000)).toBe(2);
  });
});

describe('buildWorksView', () => {
  it('labels books with the work\'s own numbering, not the raw index', () => {
    // EN's books are cited by Roman numeral; a regression here prints "Book 2".
    const [w] = buildWorksView([work({ books: [{ book: 2, chapters: [chapter(3)] }] })], 10);

    expect(w.books[0].label).toBe('II');
    expect(w.books[0].book).toBe(2);
  });

  it('counts the instances in each book across its chapters', () => {
    const [w] = buildWorksView(
      [work({ books: [{ book: 1, chapters: [chapter(3), chapter(4)] }] })], 10,
    );

    expect(w.books[0].bookCount).toBe(7);
  });

  it('renders a small entry flat and a large one collapsed', () => {
    const [small] = buildWorksView([work({ shown: 30 })], 100);
    const [big] = buildWorksView([work({ shown: 31 })], 100);

    expect(small.flat).toBe(true);
    expect(big.flat).toBe(false);
  });

  it('flags a work whose instance list the per-lemma cap truncated', () => {
    const [capped] = buildWorksView([work({ count: 900, shown: 200 })], 900);
    const [whole] = buildWorksView([work({ count: 200, shown: 200 })], 900);

    expect(capped.capped).toBe(true);
    expect(whole.capped).toBe(false);
  });

  // Categories and the Poetics are one treatise of chapters with no book level;
  // the page drops all book chrome for them.
  it('marks a bookless work as bookless and a multi-book work as not', () => {
    expect(buildWorksView([work({ work: 'Cat' })], 10)[0].bookless).toBe(true);
    expect(buildWorksView([work({ work: 'EN' })], 10)[0].bookless).toBe(false);
  });

  // A lemma's concordance can name a work the registry has since dropped. The
  // row must still render rather than throwing at build time.
  it('falls back to the raw book number for a work the registry does not know', () => {
    const [w] = buildWorksView([work({ work: 'NotAWork' })], 10);

    expect(w.books[0].label).toBe('1');
    expect(w.bookless).toBe(false);
  });

  it('carries the underlying work, title, count and chapters through untouched', () => {
    const input = work();
    const [w] = buildWorksView([input], 10);

    expect(w.work).toBe('EN');
    expect(w.title).toBe('Nicomachean Ethics');
    expect(w.count).toBe(10);
    expect(w.books[0].chapters).toBe(input.books[0].chapters);
  });
});
