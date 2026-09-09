import {
  resolveLayoutImportConfig,
  type ImportEditionConfig,
  type PublisherPreset,
  type ResolvedLayoutImportConfig,
  type ResolvedWorkStructure,
} from './import-presets';
import {
  convertLayoutExtraction,
  type ConvertOptions,
  type ConvertResult,
} from './pdf-import';
import type { ChangeRecord } from './ocr-repair/changelist';
import type { CorpusConfig } from './ocr-repair/corpus-config';
import { normalizeFootnotes } from './ocr-repair/footnote-repair';
import { repairSkeleton } from './ocr-repair/skeleton';
import { slicePages } from './ocr-repair/slice';
import { normalizeSpacing } from './ocr-repair/spacing';
import { errorText } from './runtime';

export type LayoutImportStage = 'slice' | 'skeleton' | 'spacing' | 'footnotes';

export interface LayoutStageReport {
  stagesRun: LayoutImportStage[];
  sliceChanges: number;
  headInsertions: number;
  folioRepairs: number;
  headingNormalizations: number;
  spacingNormalizations: number;
  footnoteHeadRepairs: number;
  detachedFootnoteMarkers: number;
  unconfirmedFootnoteMarkers: number;
  sliceBoundaries: { field: 'slice.bodyStart' | 'slice.backMatterStart'; text: string }[];
}

export interface LayoutStageOutcome {
  text: string;
  report: LayoutStageReport;
}

interface TextOutcome {
  text: string;
  changes: ChangeRecord[];
}

export interface LayoutPipelineDependencies {
  slice: (text: string, config: CorpusConfig) => TextOutcome;
  skeleton: (text: string, config: CorpusConfig) => TextOutcome;
  spacing: (text: string, config: CorpusConfig) => TextOutcome;
  footnotes: (text: string, config: CorpusConfig, witnessText: string) => TextOutcome;
  convert: (text: string, options?: ConvertOptions) => ConvertResult;
}

const DEFAULT_DEPENDENCIES: LayoutPipelineDependencies = {
  slice: slicePages,
  // No decided-file data enters the app. In particular, this leaves PAD and
  // SEAT-chapter inactive.
  skeleton: (text, config) => repairSkeleton(text, config, undefined),
  // No preserveDisplayLines coordinates enter the app. Stage 4 protects
  // display-shaped lines from their shape alone.
  spacing: normalizeSpacing,
  // An empty witness makes marker-glue candidates tier-2 flags. It cannot
  // confirm or apply a marker repair.
  footnotes: (text, config, witnessText) => normalizeFootnotes(text, config, witnessText),
  convert: convertLayoutExtraction,
};

function emptyReport(): LayoutStageReport {
  return {
    stagesRun: [],
    sliceChanges: 0,
    headInsertions: 0,
    folioRepairs: 0,
    headingNormalizations: 0,
    spacingNormalizations: 0,
    footnoteHeadRepairs: 0,
    detachedFootnoteMarkers: 0,
    unconfirmedFootnoteMarkers: 0,
    sliceBoundaries: [],
  };
}

function bekkerRef(value: string, field: 'bekkerStart' | 'bekkerEnd') {
  const match = /^(\d{1,4})([ab])$/u.exec(value.trim());
  if (!match) {
    throw new Error(`Layout import config field ${field} must look like 639a.`);
  }
  return { page: Number(match[1]), col: match[2] as 'a' | 'b' };
}

/** Build only FORMAT fields. No damage-layer field exists on this object. */
function stageConfig(config: ResolvedLayoutImportConfig): CorpusConfig {
  return {
    id: config.presetId ?? 'other-layout-import',
    workTitle: config.workTitle,
    runningHeadPlaceholder: config.runningHeadPlaceholder ?? config.workTitle,
    bekkerStart: bekkerRef(config.bekkerStart, 'bekkerStart'),
    bekkerEnd: bekkerRef(config.bekkerEnd, 'bekkerEnd'),
    divisions: {
      books: config.books,
      chaptersPerBook: [...config.chaptersPerBook],
    },
    ...(config.side ? { side: config.side } : {}),
    ...(config.headingStyle ? { headingStyle: { ...config.headingStyle } } : {}),
    ...(config.chapterTitles !== undefined ? { chapterTitles: config.chapterTitles } : {}),
    ...(config.slice ? { slice: { ...config.slice } } : {}),
    // The reused stage type requires CLI paths, but the pure app stages never
    // read them. Empty values avoid inventing app-side file access.
    backbonePath: '',
    witnessPath: '',
    outDir: '',
  };
}

function publisherName(config: ResolvedLayoutImportConfig): string {
  if (config.presetId === 'clarendon') return 'Clarendon / OUP';
  if (config.presetId === 'peripatetic') return 'Peripatetic Press';
  return 'Other / plain text';
}

function userDetail(error: unknown, config: ResolvedLayoutImportConfig): string {
  const detail = errorText(error);
  const boundary = /slice boundary not found for corpus "[^"]+" using pattern "([\s\S]+)"$/u.exec(detail);
  if (boundary) {
    return `${publisherName(config)} boundary pattern “${boundary[1]}” was not found.`;
  }
  return detail;
}

function failure(
  stage: string,
  field: string | undefined,
  error: unknown,
  config: ResolvedLayoutImportConfig,
): never {
  const fieldText = field ? ` at config field ${field}` : '';
  throw new Error(`Layout import ${stage} failed${fieldText}: ${userDetail(error, config)}`);
}

function runStage(
  stage: string,
  field: string | undefined,
  run: () => TextOutcome,
  config: ResolvedLayoutImportConfig,
): TextOutcome {
  try {
    return run();
  } catch (error) {
    failure(stage, field, error, config);
  }
}

function changeKind(change: ChangeRecord): string {
  return String(change.evidence?.kind ?? '');
}

function sliceFailureField(config: ResolvedLayoutImportConfig, error: unknown): string {
  const detail = errorText(error);
  if (config.slice?.backMatterStart && detail.includes(config.slice.backMatterStart)) {
    return 'slice.backMatterStart';
  }
  return config.slice?.bodyStartNextLine
    ? 'slice.bodyStart / slice.bodyStartNextLine'
    : 'slice.bodyStart';
}

function matchingLine(
  pages: string[],
  pattern: string,
  startPage: number,
  nextLinePattern?: string,
): { page: number; text: string } | null {
  const re = new RegExp(pattern);
  const nextRe = nextLinePattern ? new RegExp(nextLinePattern) : undefined;
  for (let page = startPage; page < pages.length; page += 1) {
    const lines = pages[page].split('\n').map(line => line.endsWith('\r') ? line.slice(0, -1) : line);
    for (let line = 0; line < lines.length; line += 1) {
      if (!re.test(lines[line])) continue;
      if (nextRe) {
        let next = line + 1;
        while (next < lines.length && lines[next].trim() === '') next += 1;
        if (next >= lines.length || !nextRe.test(lines[next])) continue;
      }
      return { page, text: lines[line].trim() };
    }
  }
  return null;
}

function matchedSliceBoundaries(
  raw: string,
  slice: NonNullable<ResolvedLayoutImportConfig['slice']>,
): LayoutStageReport['sliceBoundaries'] {
  const pages = raw.split('\f');
  const body = matchingLine(pages, slice.bodyStart, 0, slice.bodyStartNextLine);
  const back = slice.backMatterStart && body
    ? matchingLine(pages, slice.backMatterStart, body.page + 1)
    : null;
  return [
    ...(body ? [{ field: 'slice.bodyStart' as const, text: body.text }] : []),
    ...(back ? [{ field: 'slice.backMatterStart' as const, text: back.text }] : []),
  ];
}

/** Apply stages 1, 2 (FORMAT subset), 4, and 6 (empty-witness subset). */
export function runConfiguredLayoutStages(
  raw: string,
  config: ResolvedLayoutImportConfig,
  dependencies: LayoutPipelineDependencies = DEFAULT_DEPENDENCIES,
): LayoutStageOutcome {
  const report = emptyReport();
  let text = raw;

  if (config.slice) {
    const sliceInput = text;
    let outcome: TextOutcome;
    try {
      outcome = dependencies.slice(text, stageConfig(config));
    } catch (error) {
      failure('stage 1 (slice)', sliceFailureField(config, error), error, config);
    }
    text = outcome.text;
    report.stagesRun.push('slice');
    report.sliceChanges = outcome.changes.length;
    report.sliceBoundaries = matchedSliceBoundaries(sliceInput, config.slice);
  }

  if (config.headingStyle || config.runningHeadPlaceholder) {
    const skeleton = runStage(
      'stage 2 (skeleton)',
      'runningHeadPlaceholder / headingStyle / divisions',
      () => dependencies.skeleton(text, stageConfig(config)),
      config,
    );
    text = skeleton.text;
    report.stagesRun.push('skeleton');
    report.headInsertions = skeleton.changes.filter(change => change.rule === 'head-insert').length;
    report.folioRepairs = skeleton.changes.filter(change => change.rule === 'folio-repair' && change.tier === 1).length;
    report.headingNormalizations = skeleton.changes.filter(change => change.rule === 'heading-normalize' && change.tier === 1).length;
  }

  if (config.spacing?.enabled) {
    const spacing = runStage(
      'stage 4 (spacing)',
      'spacing.enabled',
      () => dependencies.spacing(text, stageConfig(config)),
      config,
    );
    text = spacing.text;
    report.stagesRun.push('spacing');
    report.spacingNormalizations = spacing.changes.filter(
      change => change.rule === 'spacing-collapse' && change.tier === 1,
    ).length;
  }

  if (config.footnotes?.enabled) {
    const footnotes = runStage(
      'stage 6 (footnotes)',
      undefined,
      () => dependencies.footnotes(text, stageConfig(config), ''),
      config,
    );
    text = footnotes.text;
    report.stagesRun.push('footnotes');
    report.footnoteHeadRepairs = footnotes.changes.filter(
      change => change.rule === 'footnote-head' && change.tier === 1,
    ).length;
    report.detachedFootnoteMarkers = footnotes.changes.filter(
      change => changeKind(change) === 'footnote-marker-detached',
    ).length;
    report.unconfirmedFootnoteMarkers = footnotes.changes.filter(
      change => changeKind(change) === 'footnote-marker-unconfirmed',
    ).length;
  }

  return { text, report };
}

export interface PreparedLayoutImport {
  config: ResolvedLayoutImportConfig;
  staged: LayoutStageOutcome;
  conversion: ConvertResult;
}

/** Edition resolution and configured stages always finish before conversion. */
export function prepareLayoutImport(
  raw: string,
  preset: PublisherPreset,
  edition: ImportEditionConfig,
  work: ResolvedWorkStructure,
  options: ConvertOptions = {},
  dependencies: LayoutPipelineDependencies = DEFAULT_DEPENDENCIES,
): PreparedLayoutImport {
  const config = resolveLayoutImportConfig(preset, edition, work);
  const staged = runConfiguredLayoutStages(raw, config, dependencies);
  let conversion: ConvertResult;
  try {
    conversion = dependencies.convert(staged.text, options);
  } catch (error) {
    failure('conversion', 'configured layout output', error, config);
  }
  return { config, staged, conversion };
}
