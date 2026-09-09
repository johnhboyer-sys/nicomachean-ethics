import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchBook: vi.fn(),
  fetchChapters: vi.fn(),
  getWork: vi.fn(),
  buildChapterInputs: vi.fn(),
  alignImportedChapter: vi.fn(),
  emitOverlayPieces: vi.fn(),
}));

vi.mock('@shared/lib/data', () => ({
  fetchBook: mocks.fetchBook,
  fetchChapters: mocks.fetchChapters,
}));

vi.mock('@shared/lib/works', () => ({
  WORKS: [
    { id: 'ethics', title: 'Synthetic Ethics', books: 1, bookLabels: ['I'] },
    { id: 'politics', title: 'Synthetic Politics', books: 1, bookLabels: ['I'] },
    { id: 'partial', title: 'Synthetic Two-Book Work', books: 2, bookLabels: ['I', 'II'] },
  ],
  getWork: mocks.getWork,
}));

vi.mock('../lib/aligner/reference', () => ({
  buildChapterInputs: mocks.buildChapterInputs,
}));

vi.mock('../lib/aligner/import-align', () => ({
  alignImportedChapter: mocks.alignImportedChapter,
  emitOverlayPieces: mocks.emitOverlayPieces,
}));

describe('imports', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    mocks.getWork.mockReturnValue({ id: 'ethics', title: 'Synthetic Ethics', books: 1, bookLabels: ['I'] });
    mocks.fetchChapters.mockResolvedValue({ '1': [{ chapter: 1, column: '1094a', line: '1' }] });
    mocks.fetchBook.mockResolvedValue({ book: 1, segments: [] });
    mocks.buildChapterInputs.mockReturnValue([
      { book: 1, chapter: '1', citation: '1094a1', targetText: 'Happiness.', refText: '', refAnchors: [], greekLines: [] },
    ]);
    mocks.alignImportedChapter.mockReturnValue({
      book: 1,
      chapter: '1',
      text: 'Happiness.',
      anchors: [],
      stats: { tagged: 1, placed: 0, interpolated: 0 },
    });
    mocks.emitOverlayPieces.mockReturnValue({
      pieces: { seg1: [{ chapter: '1', text: 'Happiness.', cont: false }] },
      emphasis: {},
    });
  });

  it('imports tagged translation content, writes browser storage, and formats runtime citation metadata', async () => {
    const { runImport, loadImports } = await import('../lib/imports');
    const progress: string[] = [];

    const summary = await runImport({
      raw: '{1.1}Happiness. {1094a}Column.',
      work: 'ethics',
      translator: 'Jane Doe',
      license: 'public-domain',
      year: 1901,
    }, msg => progress.push(msg));

    expect(summary).toMatchObject({
      density: 'five-line-or-column',
      chapters: 1,
      tagged: 1,
      placed: 0,
      interpolated: 0,
      replaced: false,
    });
    expect(summary.meta).toMatchObject({
      id: 'jane-doe-ethics',
      work: 'ethics',
      translator: 'Jane Doe',
      year: 1901,
      language: 'en',
    });
    expect(progress).toEqual(['Scanning tags…', 'Aligning Book 1 of 1…', 'Writing library files…']);
    expect(mocks.fetchChapters).toHaveBeenCalledTimes(1);
    expect(JSON.parse(localStorage.getItem('import-map:ethics/jane-doe-ethics')!)).toMatchObject({
      meta: { translator: 'Jane Doe' },
      overlaysByBook: { '1': { seg1: [{ text: 'Happiness.' }] } },
    });

    await loadImports();
    expect((globalThis as { __ARISTOTLE_EXTRA_TRANSLATIONS__?: Record<string, unknown[]> })
      .__ARISTOTLE_EXTRA_TRANSLATIONS__?.ethics[0]).toMatchObject({
      id: 'jane-doe-ethics',
      name: 'Jane Doe (1901) ⓘ',
      short: 'Jane Doe',
      slot: 'overlay',
    });
  });

  it('rejects malformed imports and collisions without replacing stored maps', async () => {
    const { ImportCollision, runImport } = await import('../lib/imports');

    await expect(runImport({
      raw: 'No tags here.',
      work: 'ethics',
      translator: 'Jane Doe',
      license: 'user-supplied',
    })).rejects.toThrow('No {book.chapter} tags found');

    await runImport({
      raw: '{1.1}Happiness.',
      work: 'ethics',
      translator: 'Jane Doe',
      license: 'user-supplied',
    });
    await expect(runImport({
      raw: '{1.1}Second copy.',
      work: 'ethics',
      translator: 'Jane Doe',
      license: 'user-supplied',
    })).rejects.toBeInstanceOf(ImportCollision);
  });

  it('rejects an R6 gap inside coverage, then records the exact one-click waiver', async () => {
    const refs = [1, 2, 3].map(chapter => ({
      chapter: String(chapter), column: `100${chapter}a`, line: '1', bekker: `100${chapter}a1–100${chapter}b20`,
    }));
    mocks.fetchChapters.mockResolvedValue({ '1': refs });
    const { DivisionGapError, runImport } = await import('../lib/imports');
    const request = {
      raw: '{1.1} First.\n{1.3} Third.',
      work: 'ethics',
      translator: 'Incomplete Copy',
      license: 'user-supplied' as const,
      booksCovered: [1],
    };

    await expect(runImport(request)).rejects.toBeInstanceOf(DivisionGapError);
    expect(localStorage.getItem('import-map:ethics/incomplete-copy-ethics')).toBeNull();

    const summary = await runImport({ ...request, waiveDivisionGaps: true });
    expect(summary.divisionAudit).toMatchObject({ chaptersFound: 2, chaptersExpected: 3 });
    expect(summary.waivedDivisionGaps).toEqual([{ book: 1, chapter: 2 }]);
    expect(JSON.parse(localStorage.getItem('import-map:ethics/incomplete-copy-ethics')!))
      .toMatchObject({ waivedDivisionGaps: [{ book: 1, chapter: 2 }] });
  });

  it('does not expect books outside a partial declaration', async () => {
    mocks.getWork.mockReturnValue({
      id: 'partial', title: 'Synthetic Two-Book Work', books: 2, bookLabels: ['I', 'II'],
    });
    mocks.fetchChapters.mockResolvedValue({
      '1': [{ chapter: '1', column: '100a', line: '1', bekker: '100a1–100b20' }],
      '2': [
        { chapter: '1', column: '101a', line: '1', bekker: '101a1–101a20' },
        { chapter: '2', column: '101b', line: '1', bekker: '101b1–101b20' },
      ],
    });
    const { runImport } = await import('../lib/imports');

    const summary = await runImport({
      raw: '{1.1} Covered.\n{2.2} Present but outside the declaration.',
      work: 'partial',
      translator: 'Partial Copy',
      license: 'user-supplied',
      booksCovered: [1],
    });
    expect(summary.divisionAudit).toMatchObject({
      booksCovered: [1], chaptersFound: 1, chaptersExpected: 1, gaps: [],
    });
  });

  it('never lets the R6 waiver bypass R4 duplicate rejection', async () => {
    const { runImport } = await import('../lib/imports');
    await expect(runImport({
      raw: '{1.1} First.\n{1.1} Duplicate.',
      work: 'ethics',
      translator: 'Duplicate Copy',
      license: 'user-supplied',
      booksCovered: [1],
      waiveDivisionGaps: true,
    })).rejects.toThrow('Duplicate chapter key {1.1}');
  });

  it('applies note placement in override, explicit file, then preset-default order', async () => {
    const { runImport } = await import('../lib/imports');
    await runImport({
      raw: '{1.1} Text.[^1]\n\n<!-- footnotes scope=continuous render=endnote -->\n[^1]: Note.',
      work: 'ethics',
      translator: 'Explicit End Notes',
      license: 'user-supplied',
      footnotePlacement: 'page-bottom',
    });
    const explicitRecord = JSON.parse(localStorage.getItem('import-map:ethics/explicit-end-notes-ethics')!);
    expect(explicitRecord.noteRender).toBe('endnote');

    await runImport({
      raw: '{1.1} Text with no note-render sentinel.',
      work: 'ethics',
      translator: 'Preset End Notes',
      license: 'user-supplied',
      footnotePlacement: 'endnote',
    });
    const presetRecord = JSON.parse(localStorage.getItem('import-map:ethics/preset-end-notes-ethics')!);
    expect(presetRecord.noteRender).toBe('endnote');

    await runImport({
      raw: '{1.1} Text.[^1]\n\n<!-- footnotes scope=continuous render=endnote -->\n[^1]: Note.',
      work: 'ethics',
      translator: 'Override Page Notes',
      license: 'user-supplied',
      footnotePlacement: 'endnote',
      footnotePlacementOverride: 'page-bottom',
    });
    const overrideRecord = JSON.parse(localStorage.getItem('import-map:ethics/override-page-notes-ethics')!);
    expect(overrideRecord.noteRender).toBeUndefined();
  });
  it('says which book could not be loaded, in one sentence, and imports nothing', async () => {
    const { runImport } = await import('../lib/imports');
    mocks.fetchBook.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(runImport({
      raw: '{1.1}Happiness.',
      work: 'ethics',
      translator: 'Offline Copy',
      license: 'user-supplied',
    })).rejects.toThrow(/Could not load Book 1 of Synthetic Ethics.*Failed to fetch.*Nothing was imported/);
    expect(localStorage.getItem('import-map:ethics/offline-copy-ethics')).toBeNull();
  });

  it('loadImports registers what it can read and reports the record it could not', async () => {
    const { loadImports, importLoadProblems } = await import('../lib/imports');
    localStorage.setItem('import-map:ethics/bad', '{"meta": {"id": "bad"');
    localStorage.setItem('import-map:ethics/good', JSON.stringify({
      meta: { formatVersion: 1, work: 'ethics', translator: 'Good', license: 'user-supplied', language: 'en', id: 'good' },
      density: 'chapter-only', warnings: [], stats: { tagged: 0, placed: 0, interpolated: 0, chapters: 1 },
      overlaysByBook: {}, alignment: {},
    }));
    await expect(loadImports()).resolves.toBeGreaterThanOrEqual(1);
    expect(importLoadProblems()).toEqual([expect.stringMatching(/ethics\/bad.*could not be read/i)]);
    const g = globalThis as { __ARISTOTLE_EXTRA_TRANSLATIONS__?: Record<string, { id: string }[]> };
    expect(g.__ARISTOTLE_EXTRA_TRANSLATIONS__?.ethics.map(t => t.id)).toContain('good');
    expect(g.__ARISTOTLE_EXTRA_TRANSLATIONS__?.ethics.map(t => t.id)).not.toContain('bad');
  });
});

describe('exportLibrary', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  it('builds a clean browser export summary with annotations and imported maps', async () => {
    const { exportLibrary } = await import('../lib/export');
    const clicks: string[] = [];
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:library');
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function clickAnchor(this: HTMLAnchorElement) {
      clicks.push(this.download);
    });

    localStorage.setItem('annotations:ethics', JSON.stringify([
      { id: 'ann-1', work: 'ethics', created: '2026-01-01T00:00:00.000Z', body: '', layer: 'greek', exact: 'logos', target: { kind: 'greek', book: 1, start: { column: '1094a', line: 1, word: 0 }, end: { column: '1094a', line: 1, word: 0 } } },
    ]));
    localStorage.setItem('import-map:ethics/custom', JSON.stringify({ meta: { id: 'custom' }, stats: { tagged: 1 } }));

    await expect(exportLibrary()).resolves.toBe('1 annotation, 1 imported translation');
    expect(clicks[0]).toMatch(/^aristotle-reader-library-\d{4}-\d{2}-\d{2}\.json$/);
    expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:library');

    click.mockRestore();
    createObjectURL.mockRestore();
    revokeObjectURL.mockRestore();
  });
});
