// Link and label helpers the reader shell and a work's landing page share.
// Extracted from components/ReaderShell.astro and components/Landing.astro so
// they can be tested: an in-page chapter link that turns into a cross-page one
// (or the reverse) silently breaks either the outline's scroll-to behaviour or
// every cross-book link in the drawer, and neither shows up in a diff.
import { workPath } from '@shared/lib/works';

// A chapter link in the full-work outline. Chapters of the book that is already
// open are a bare hash (the drawer closes and the page scrolls); chapters of any
// other book navigate to that book's page and land on the same anchor.
export const chapterHref = (
  base: string,
  workId: string,
  currentBook: number,
  book: number,
  chapter: string,
): string =>
  book === currentBook
    ? `#ch-${book}-${chapter}`
    : `${base}${workPath(workId, book)}#ch-${book}-${chapter}`;

// Translator entries in the registry read "Name (Publisher, Year)". The page
// title, the meta description and the JSON-LD `translator` want just the person.
export const translatorName = (name: string | undefined): string =>
  name?.split(' (')[0] ?? '';

// "N chapters · <Bekker start>–<Bekker end>" for a book's row on the landing
// page. A book whose chapters carry no Bekker range gets the count alone.
export const bookSpan = (chapters: { bekker: string }[]): string => {
  const n = chapters.length;
  const first = chapters[0]?.bekker.split('–')[0] ?? '';
  const last = chapters.at(-1)?.bekker.split('–').at(-1) ?? '';
  const range = first && last ? ` · ${first}–${last}` : '';
  return `${n} chapter${n === 1 ? '' : 's'}${range}`;
};
