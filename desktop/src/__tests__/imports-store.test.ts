// The packaged app's on-disk store for imported translations, driven through
// the mocked Tauri fs plugin: what bytes land in which file, in what order,
// and what happens when a file on disk cannot be read back.
//
// `__TAURI_INTERNALS__` is set BEFORE the first store() call so imports.ts
// and export.ts pick the Tauri backend (their store handle is cached per
// module instance — this file owns its own instance).

import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from '@tauri-apps/plugin-fs';
import * as dialog from '@tauri-apps/plugin-dialog';
import * as path from '@tauri-apps/api/path';

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
  WORKS: [{ id: 'ethics', title: 'Synthetic Ethics', books: 1, bookLabels: ['I'] }],
  getWork: mocks.getWork,
}));

vi.mock('../lib/aligner/reference', () => ({ buildChapterInputs: mocks.buildChapterInputs }));
vi.mock('../lib/aligner/import-align', () => ({
  alignImportedChapter: mocks.alignImportedChapter,
  emitOverlayPieces: mocks.emitOverlayPieces,
}));

(window as unknown as { __TAURI_INTERNALS__: object }).__TAURI_INTERNALS__ = {};

/** Replay every writeTextFile + rename into "final path → content". */
function filesOnDisk(): Map<string, string> {
  const disk = new Map<string, string>();
  const events: { at: number; run: () => void }[] = [];
  vi.mocked(fs.writeTextFile).mock.calls.forEach(([p, c], i) => {
    const order = vi.mocked(fs.writeTextFile).mock.invocationCallOrder[i];
    events.push({ at: order, run: () => disk.set(String(p), String(c)) });
  });
  vi.mocked(fs.rename).mock.calls.forEach(([from, to], i) => {
    const order = vi.mocked(fs.rename).mock.invocationCallOrder[i];
    events.push({ at: order, run: () => {
      const c = disk.get(String(from));
      if (c === undefined) throw new Error(`rename of a file never written: ${String(from)}`);
      disk.delete(String(from));
      disk.set(String(to), c);
    } });
  });
  events.sort((a, b) => a.at - b.at).forEach(e => e.run());
  return disk;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getWork.mockReturnValue({ id: 'ethics', title: 'Synthetic Ethics', books: 1, bookLabels: ['I'] });
  mocks.fetchChapters.mockResolvedValue({ '1': [{ chapter: '1', column: '1094a', line: '1', bekker: '1094a1' }] });
  mocks.fetchBook.mockResolvedValue({ book: 1, segments: [] });
  mocks.buildChapterInputs.mockReturnValue([
    { book: 1, chapter: '1', citation: '1094a1', targetText: 'Happiness.', refText: '', refAnchors: [], greekLines: [] },
  ]);
  mocks.alignImportedChapter.mockReturnValue({
    book: 1, chapter: '1', text: 'Happiness.', anchors: [], stats: { tagged: 1, placed: 0, interpolated: 0 },
  });
  mocks.emitOverlayPieces.mockReturnValue({ pieces: {}, emphasis: {} });
});

describe('imports on disk (Tauri store)', () => {
  it('writes the canonical .md with the metadata the import actually used, not the file’s stale header', async () => {
    const { runImport } = await import('../lib/imports');
    const raw = '---\nformatVersion: 1\nwork: ethics\ntranslator: Old Name\nlicense: cc-by\nlanguage: en\nid: old-id\n---\n{1.1}Happiness.';
    await runImport({
      raw, work: 'ethics', translator: 'New Name', license: 'user-supplied', year: 1901, idOverride: 'new-id',
    });
    const disk = filesOnDisk();
    const md = disk.get('/tmp/aristotle-reader/translations/ethics/new-id.md');
    expect(md).toBeDefined();
    expect(md).toContain('id: new-id');
    expect(md).toContain('translator: New Name');
    expect(md).toContain('license: user-supplied');
    expect(md).not.toContain('old-id');
    expect(md!.endsWith('---\n{1.1}Happiness.')).toBe(true);
    // The pristine upload is untouched.
    expect(disk.get('/tmp/aristotle-reader/translations/ethics/new-id.original')).toBe(raw);
  });

  it('never leaves a half-written library file: each file is written to a temp name and renamed, the map last', async () => {
    const { runImport } = await import('../lib/imports');
    await runImport({ raw: '{1.1}Happiness.', work: 'ethics', translator: 'Jane Doe', license: 'user-supplied' });
    const written = vi.mocked(fs.writeTextFile).mock.calls.map(([p]) => String(p));
    const finals = ['jane-doe-ethics.md', 'jane-doe-ethics.original', 'jane-doe-ethics.map.json']
      .map(n => `/tmp/aristotle-reader/translations/ethics/${n}`);
    for (const f of finals) expect(written).not.toContain(f);
    const renamedTo = vi.mocked(fs.rename).mock.calls.map(([, to]) => String(to));
    expect(renamedTo.slice().sort()).toEqual(finals.slice().sort());
    expect(renamedTo[renamedTo.length - 1]).toBe(finals[2]);
    expect([...filesOnDisk().keys()].sort()).toEqual(finals.slice().sort());
  });

  it('a write failure is reported in one plain sentence and the translation is not registered', async () => {
    const { runImport } = await import('../lib/imports');
    vi.mocked(fs.writeTextFile).mockRejectedValueOnce(new Error('No space left on device (os error 28)'));
    await expect(runImport({ raw: '{1.1}Happiness.', work: 'ethics', translator: 'Disk Full', license: 'user-supplied' }))
      .rejects.toThrow(/Could not write the library files.*No space left on device.*Nothing was imported/);
    const g = globalThis as { __ARISTOTLE_EXTRA_TRANSLATIONS__?: Record<string, { id: string }[]> };
    expect(g.__ARISTOTLE_EXTRA_TRANSLATIONS__?.ethics?.some(t => t.id === 'disk-full-ethics') ?? false).toBe(false);
  });

  it('loadImports reports a map file it could not read instead of silently dropping that translation', async () => {
    const { loadImports, importLoadProblems } = await import('../lib/imports');
    vi.mocked(fs.exists).mockResolvedValue(true);
    vi.mocked(fs.readDir).mockImplementation(async (p) =>
      String(p).endsWith('/translations')
        ? [{ name: 'ethics', isDirectory: true, isFile: false, isSymlink: false }]
        : [
          { name: 'good.map.json', isDirectory: false, isFile: true, isSymlink: false },
          { name: 'bad.map.json', isDirectory: false, isFile: true, isSymlink: false },
        ]);
    vi.mocked(fs.readTextFile).mockImplementation(async (p) =>
      String(p).endsWith('bad.map.json') ? '{"meta": {"id": "bad"' : JSON.stringify({
        meta: { formatVersion: 1, work: 'ethics', translator: 'Good', license: 'user-supplied', language: 'en', id: 'good' },
        density: 'chapter-only', warnings: [], stats: { tagged: 0, placed: 0, interpolated: 0, chapters: 1 },
        overlaysByBook: {}, alignment: {},
      }));
    await loadImports();
    const problems = importLoadProblems();
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/bad\.map\.json/);
    expect(problems[0]).toMatch(/could not be read/i);
    expect(problems[0]).not.toMatch(/\n\s+at /); // a sentence, not a stack trace
    const g = globalThis as { __ARISTOTLE_EXTRA_TRANSLATIONS__?: Record<string, { id: string }[]> };
    const ids = g.__ARISTOTLE_EXTRA_TRANSLATIONS__?.ethics?.map(t => t.id) ?? [];
    expect(ids).toContain('good');
    expect(ids).not.toContain('bad');
  });

  it('does not keep a failed store handle: a transient app-dir failure is retried on the next call', async () => {
    vi.resetModules();
    const { loadImports } = await import('../lib/imports');
    vi.mocked(path.appDataDir).mockRejectedValueOnce(new Error('app data dir unavailable'));
    await expect(loadImports()).rejects.toThrow('app data dir unavailable');
    vi.mocked(fs.exists).mockResolvedValue(false);
    await expect(loadImports()).resolves.toBe(0);
  });
});

describe('exportLibrary on disk (Tauri store)', () => {
  it('skips a translation whose map cannot be read and says so, instead of aborting the whole export', async () => {
    const { exportLibrary } = await import('../lib/export');
    // Only the translations tree exists; no annotations file for any work.
    vi.mocked(fs.exists).mockImplementation(async (p) => String(p).includes('/translations'));
    vi.mocked(fs.readDir).mockImplementation(async (p) =>
      String(p).endsWith('/translations')
        ? [{ name: 'ethics', isDirectory: true, isFile: false, isSymlink: false }]
        : [
          { name: 'bad.map.json', isDirectory: false, isFile: true, isSymlink: false },
          { name: 'good.map.json', isDirectory: false, isFile: true, isSymlink: false },
        ]);
    vi.mocked(fs.readTextFile).mockImplementation(async (p) => {
      const s = String(p);
      if (s.endsWith('bad.map.json')) return '{corrupt';
      if (s.endsWith('good.map.json')) return JSON.stringify({ meta: { id: 'good' } });
      if (s.endsWith('good.md')) return '---\nid: good\n---\n{1.1}x';
      throw new Error(`missing ${s}`);
    });
    vi.mocked(dialog.save).mockResolvedValue('/tmp/out.json');
    const summary = await exportLibrary();
    expect(summary).toMatch(/1 imported translation/);
    expect(summary).toMatch(/ethics\/bad/);
    const out = vi.mocked(fs.writeTextFile).mock.calls.find(([p]) => String(p) === '/tmp/out.json');
    expect(out).toBeDefined();
    const bundle = JSON.parse(String(out![1]));
    expect(bundle.translations).toEqual([{ work: 'ethics', id: 'good', content: '---\nid: good\n---\n{1.1}x', map: { meta: { id: 'good' } } }]);
    expect(bundle.skipped).toEqual([expect.objectContaining({ work: 'ethics', id: 'bad' })]);
  });
});
