import { fetchChapters, type ChapterRef } from '@shared/lib/data';
import { WORKS } from '@shared/lib/works';
import { errorText } from './runtime';

export type PublisherPresetId = 'other' | 'clarendon' | 'peripatetic';
export type FootnotePlacement = 'page-bottom' | 'endnote';

export interface ImportSliceConfig {
  bodyStart: string;
  bodyStartNextLine?: string;
  trimBodyStartPreamble?: boolean;
  backMatterStart?: string;
}

/** Edition fields may replace publisher defaults without changing publisher. */
export interface ImportEditionConfig {
  chapterTitles?: boolean;
  runningHeadPlaceholder?: string | false;
  /** false is an explicit Edition override of a publisher slice default. */
  slice?: ImportSliceConfig | false;
  spacing?: boolean;
  footnotes?: boolean;
}

/** App import defaults. This type stays separate from the CLI CorpusConfig. */
export interface PublisherPreset {
  presetId?: Exclude<PublisherPresetId, 'other'>;
  /** Derive the skeleton stage's placeholder from the selected work. */
  runningHeadPlaceholder?: 'work-title';
  headingStyle?: {
    bookOrdinal?: 'greek-letter';
    chapterNumeral?: 'bare';
  };
  side?: 'verso' | 'recto' | 'alternating';
  endnotes?: { source: 'witness-commentary' };
  witnessStructure?: { format: 'genie-markdown' };
  footnotePlacement?: FootnotePlacement;
  strayNumeralStyle?: 'roman' | 'arabic';
  interiorRunningHeads?: { pattern?: string };
  spacing?: { enabled: true };
  footnotes?: { enabled: true };
  editionDefaults?: ImportEditionConfig;
}

export interface PublisherPresetOption {
  id: PublisherPresetId;
  label: string;
  preset: PublisherPreset;
}

/** Bundled registry. `other` is deliberately empty and remains the default. */
export const PUBLISHER_PRESETS: readonly PublisherPresetOption[] = [
  { id: 'other', label: 'Other / plain text', preset: {} },
  {
    id: 'clarendon',
    label: 'Clarendon / OUP',
    preset: {
      presetId: 'clarendon',
      runningHeadPlaceholder: 'work-title',
      footnotePlacement: 'page-bottom',
      strayNumeralStyle: 'roman',
      spacing: { enabled: true },
      footnotes: { enabled: true },
      editionDefaults: {
        chapterTitles: false,
        slice: {
          bodyStart: '^\\s{5,}BOOK\\s+([A-Z]+|\\d{1,2})\\s*$',
          bodyStartNextLine: '^\\s{2,}CHAPTER\\s+\\S{1,4}\\s*$',
          trimBodyStartPreamble: true,
          backMatterStart: '^\\s*COMMENTARY\\s*$',
        },
      },
    },
  },
  {
    id: 'peripatetic',
    label: 'Peripatetic Press',
    preset: {
      presetId: 'peripatetic',
      runningHeadPlaceholder: 'work-title',
      headingStyle: { bookOrdinal: 'greek-letter', chapterNumeral: 'bare' },
      side: 'verso',
      endnotes: { source: 'witness-commentary' },
      witnessStructure: { format: 'genie-markdown' },
      footnotePlacement: 'endnote',
      strayNumeralStyle: 'arabic',
      spacing: { enabled: true },
      footnotes: { enabled: true },
      // Unvalidated against a corpus: the held-out Apostle backbone has not
      // been sliced through the app. A wrong boundary fails on Edition.
      editionDefaults: {
        chapterTitles: false,
        slice: {
          bodyStart: '^\\s{5,}BOOK\\s+\\S{1,2}\\s*$',
          backMatterStart: '^\\s*COMMENTARIES(?:\\s+ON\\b.*)?\\s*$',
        },
      },
    },
  },
] as const;

export const DEFAULT_PUBLISHER_PRESET_ID: PublisherPresetId = 'other';

export function getPublisherPreset(id: PublisherPresetId): PublisherPreset {
  const option = PUBLISHER_PRESETS.find(item => item.id === id);
  if (!option) throw new Error(`Unknown publisher preset: ${id}`);
  return option.preset;
}

export interface ResolvedWorkStructure {
  workId: string;
  workTitle: string;
  runningHeadPlaceholder: string;
  books: number;
  bookLabels: string[];
  chaptersPerBook: number[];
  chapterKeysByBook: Record<number, number[]>;
  bekkerStart: string;
  bekkerEnd: string;
}

/** Complete browser-safe config for the imported layout stages. */
export interface ResolvedLayoutImportConfig extends Omit<
  ImportEditionConfig,
  'slice' | 'runningHeadPlaceholder' | 'spacing' | 'footnotes'
> {
  presetId?: Exclude<PublisherPresetId, 'other'>;
  headingStyle?: PublisherPreset['headingStyle'];
  side?: PublisherPreset['side'];
  footnotePlacement?: FootnotePlacement;
  workId: string;
  workTitle: string;
  runningHeadPlaceholder?: string;
  books: number;
  chaptersPerBook: number[];
  bekkerStart: string;
  bekkerEnd: string;
  slice?: ImportSliceConfig;
  spacing?: { enabled: true };
  footnotes?: { enabled: true };
}

/** Merge publisher defaults, Edition values, and the work registry in that order. */
export function resolveLayoutImportConfig(
  preset: PublisherPreset,
  edition: ImportEditionConfig,
  work: ResolvedWorkStructure,
): ResolvedLayoutImportConfig {
  const defaults = preset.editionDefaults ?? {};
  const defaultSlice = defaults.slice;
  const editionSlice = edition.slice;
  const slice = editionSlice
    ? { ...editionSlice }
    : editionSlice === false
      ? undefined
      : defaultSlice
      ? { ...defaultSlice }
      : undefined;
  const runningHeadPlaceholder = edition.runningHeadPlaceholder === false
    ? undefined
    : typeof edition.runningHeadPlaceholder === 'string'
      ? edition.runningHeadPlaceholder
      : preset.runningHeadPlaceholder === 'work-title'
        ? work.runningHeadPlaceholder
        : undefined;
  const spacing = edition.spacing === false
    ? undefined
    : edition.spacing === true || preset.spacing
      ? { enabled: true as const }
      : undefined;
  const footnotes = edition.footnotes === false
    ? undefined
    : edition.footnotes === true || preset.footnotes
      ? { enabled: true as const }
      : undefined;
  const {
    slice: _editionSlice,
    runningHeadPlaceholder: _editionRunningHead,
    spacing: _editionSpacing,
    footnotes: _editionFootnotes,
    ...editionFields
  } = edition;
  return {
    ...(preset.presetId ? { presetId: preset.presetId } : {}),
    ...(preset.headingStyle ? { headingStyle: { ...preset.headingStyle } } : {}),
    ...(preset.side ? { side: preset.side } : {}),
    ...(preset.footnotePlacement ? { footnotePlacement: preset.footnotePlacement } : {}),
    ...(defaults.chapterTitles !== undefined ? { chapterTitles: defaults.chapterTitles } : {}),
    ...(slice ? { slice } : {}),
    ...(runningHeadPlaceholder ? { runningHeadPlaceholder } : {}),
    ...(spacing ? { spacing } : {}),
    ...(footnotes ? { footnotes } : {}),
    ...editionFields,
    workId: work.workId,
    workTitle: work.workTitle,
    books: work.books,
    chaptersPerBook: [...work.chaptersPerBook],
    bekkerStart: work.bekkerStart,
    bekkerEnd: work.bekkerEnd,
  };
}

function fail(workId: string, detail: string): never {
  throw new Error(`Cannot load import structure for ${workId}: ${detail}`);
}

function refsInBook(
  workId: string,
  chapters: Record<string, ChapterRef[]>,
  book: number,
): ChapterRef[] {
  const refs = chapters[String(book)];
  if (!Array.isArray(refs) || refs.length === 0) {
    fail(workId, `chapters.json has no chapters for book ${book}.`);
  }
  return refs;
}

function chapterKeys(workId: string, book: number, refs: ChapterRef[]): number[] {
  const keys = refs.map(ref => Number(ref.chapter));
  if (keys.some(key => !Number.isInteger(key) || key < 1)) {
    fail(workId, `chapters.json has a non-numeric chapter key in book ${book}.`);
  }
  for (let i = 0; i < keys.length; i += 1) {
    if (keys[i] !== i + 1) {
      fail(workId, `chapters.json has an incomplete or unordered chapter sequence in book ${book}.`);
    }
  }
  return keys;
}

function firstBekkerColumn(workId: string, ref: ChapterRef): string {
  const match = /\d{1,4}[ab]/u.exec(ref.bekker || ref.column);
  if (!match) fail(workId, 'chapters.json has no readable starting Bekker column.');
  return match[0];
}

function lastBekkerColumn(workId: string, ref: ChapterRef): string {
  const matches = [...(ref.bekker || ref.column).matchAll(/\d{1,4}[ab]/gu)];
  if (!matches.length) fail(workId, 'chapters.json has no readable ending Bekker column.');
  return matches.at(-1)![0];
}

/** Resolve and validate the runtime work data used by Edition and R6. */
export async function resolveWorkStructure(
  workId: string,
  loadedChapters?: Record<string, ChapterRef[]>,
): Promise<ResolvedWorkStructure> {
  const work = WORKS.find(item => item.id === workId);
  if (!work) fail(workId, 'the work is not present in WORKS.');

  let chapters = loadedChapters;
  if (!chapters) {
    try {
      chapters = await fetchChapters(workId);
    } catch (error) {
      const message = errorText(error);
      fail(workId, `chapters.json could not be loaded (${message}).`);
    }
  }
  if (!chapters || typeof chapters !== 'object') {
    fail(workId, 'chapters.json is missing or invalid.');
  }

  const numericBooks = Object.keys(chapters)
    .map(Number)
    .filter(Number.isInteger)
    .sort((a, b) => a - b);
  const expectedBooks = Array.from({ length: work.books }, (_, index) => index + 1);
  if (numericBooks.length !== expectedBooks.length
      || numericBooks.some((book, index) => book !== expectedBooks[index])) {
    fail(
      workId,
      `WORKS declares ${work.books} book${work.books === 1 ? '' : 's'}, but chapters.json covers ${numericBooks.length}.`,
    );
  }

  const chapterKeysByBook: Record<number, number[]> = {};
  const chaptersPerBook = expectedBooks.map(book => {
    const keys = chapterKeys(workId, book, refsInBook(workId, chapters, book));
    chapterKeysByBook[book] = keys;
    return keys.length;
  });
  const firstRef = refsInBook(workId, chapters, 1)[0];
  const finalRefs = refsInBook(workId, chapters, work.books);
  const finalRef = finalRefs.at(-1)!;

  return {
    workId,
    workTitle: work.title,
    runningHeadPlaceholder: work.title,
    books: work.books,
    bookLabels: [...work.bookLabels],
    chaptersPerBook,
    chapterKeysByBook,
    bekkerStart: firstBekkerColumn(workId, firstRef),
    bekkerEnd: lastBekkerColumn(workId, finalRef),
  };
}
