// The parts of the lemma page (components/LemmaPage.astro) that are arithmetic
// and string-building rather than markup. Extracted so they can be tested:
// Astro components cannot be rendered under vitest here (the corpus data the
// page reads at build time is machine-local), but a wrong Bekker deep-link or a
// bar that renders at 0% width is a real, silent regression.
import { getWork, bookLabel, isBookless, workPath } from '@shared/lib/works';

export type Instance = [col: string, line: number, surface: string];
export interface ChapterInstances { chapter: string; bekker: string; instances: Instance[]; }
export interface BookInstances { book: number; chapters: ChapterInstances[]; }
export interface WorkInstances {
  work: string; title: string; count: number; shown: number; books: BookInstances[];
}

export interface WorkBookView {
  book: number;
  label: string;
  bookCount: number;
  chapters: ChapterInstances[];
}
export interface WorkView extends WorkInstances {
  bookless: boolean;
  flat: boolean;
  capped: boolean;
  barPct: number;
  books: WorkBookView[];
}

// Small entries render fully expanded rather than as a stack of closed books.
export const FLAT_INSTANCES = 30;

// Deep-link an instance back into the reader: scroll to the Bekker line and
// highlight the Greek word (the same ?hlg=&loc= mechanism search uses). The
// surface form is a Greek word, so it MUST be percent-encoded — an unencoded
// one breaks the query string the reader parses.
export const instanceHref = (
  base: string,
  work: string,
  book: number,
  [col, line, surface]: Instance,
): string =>
  `${base}${workPath(work, book)}?hlg=${encodeURIComponent(surface)}&loc=${col}:${line}`;

// Scale each work's count against the most-frequent work so the bars are
// directly comparable at a glance. The floor of 2% keeps a single occurrence
// visible as a bar rather than as nothing at all.
export const freqBarPct = (count: number, maxWork: number): number =>
  Math.max(2, (count / maxWork) * 100);

// Precompute the per-work view (book labels, per-book counts, flat-vs-drilldown).
// Comparison operators like `<=` inside inline Astro template expressions confuse
// its JSX parser, so no logic lives in the page's markup.
export function buildWorksView(instancesByWork: WorkInstances[], maxWork: number): WorkView[] {
  return instancesByWork.map((w) => {
    const ww = getWork(w.work);
    const bookless = ww ? isBookless(ww) : false;
    return {
      ...w,
      bookless,
      flat: w.shown <= FLAT_INSTANCES,   // small entries render fully expanded
      capped: w.shown < w.count,         // per-lemma INSTANCE_CAP truncated this work
      barPct: freqBarPct(w.count, maxWork),
      books: w.books.map((bk) => ({
        book: bk.book,
        label: ww ? bookLabel(ww, bk.book) : String(bk.book),
        bookCount: bk.chapters.reduce((n, c) => n + c.instances.length, 0),
        chapters: bk.chapters,
      })),
    };
  });
}
