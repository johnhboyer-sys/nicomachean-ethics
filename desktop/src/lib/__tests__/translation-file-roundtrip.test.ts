// Round-trip contracts for the on-disk translation-file format. Every case
// here is an input a real user file can carry (Windows editors, Gutenberg
// separators, NFD Greek from macOS, tags typed on their own line) — and each
// one pins that serialize → parse → split gives back the same document with
// offsets that still point at the word they were measured against.

import { describe, expect, it } from 'vitest';
import {
  parseTranslationFile,
  serializeFrontmatter,
  splitChapters,
  type TranslationMeta,
} from '../translation-file';

const META: TranslationMeta = {
  formatVersion: 1,
  work: 'PA',
  translator: 'Lennox, J. G. (‘Jim’)',
  license: 'cc-by',
  year: 2001,
  source: 'Oxford: Clarendon Press',
  language: 'en',
  id: 'lennox-pa',
  citation: 'Aristotle. Parts of Animals I–IV.\nTrans. James G. Lennox.',
  noTicks: ['81a40', '87a40'],
};

describe('frontmatter round-trip', () => {
  it('parse(serialize(meta)) returns the same metadata, multi-line citation and NFD Greek included', () => {
    const greek = 'Ἀριστοτέλης'.normalize('NFD');
    const meta: TranslationMeta = { ...META, translator: greek, citation: `${META.citation}\n${greek}` };
    const parsed = parseTranslationFile(serializeFrontmatter(meta) + '{1.1}Alpha.');
    expect(parsed.hasFrontmatter).toBe(true);
    expect(parsed.meta).toEqual(meta);
    // Never re-normalised on the way through: the bytes the user typed.
    expect(parsed.meta.translator).toBe(greek);
    expect(parsed.meta.translator!.normalize('NFC')).not.toBe(greek);
  });

  it('a metadata-only file (empty translation) parses to no text, no tags, density none', () => {
    const parsed = parseTranslationFile(serializeFrontmatter(META));
    expect(parsed.hasFrontmatter).toBe(true);
    expect(parsed.meta.id).toBe('lennox-pa');
    expect(parsed.text).toBe('');
    expect(parsed.tags).toEqual([]);
    expect(parsed.density).toBe('none');
    expect(splitChapters(parsed)).toEqual({ preamble: '', chapters: [] });
  });

  it('a UTF-8 BOM (Windows Notepad) does not turn the frontmatter into body prose', () => {
    const raw = '﻿' + serializeFrontmatter(META) + '{1.1}Alpha.';
    const parsed = parseTranslationFile(raw);
    expect(parsed.hasFrontmatter).toBe(true);
    expect(parsed.meta.id).toBe('lennox-pa');
    expect(parsed.text).toBe('Alpha.');
    expect(parsed.text.includes('---')).toBe(false);
  });

  it('CRLF line endings: no \\r survives into the clean text and blank lines still collapse to one break', () => {
    const raw = serializeFrontmatter(META).replace(/\n/g, '\r\n')
      + '{1.1}Alpha\r\n\r\nBeta {1094a}gamma.\r\n';
    const parsed = parseTranslationFile(raw);
    expect(parsed.hasFrontmatter).toBe(true);
    expect(parsed.text).toBe('Alpha\nBeta gamma.\n');
    expect(parsed.tags[1]).toMatchObject({ citation: '1094a1', offset: 'Alpha\nBeta '.length });
  });

  it('noTicks accepts a comma-separated list, not only whitespace', () => {
    const raw = serializeFrontmatter(META).replace('noTicks: 81a40 87a40', 'noTicks: 81a40, 87a40,91b40') + '{1.1}x';
    expect(parseTranslationFile(raw).meta.noTicks).toEqual(['81a40', '87a40', '91b40']);
  });
});

describe('body round-trip', () => {
  it('Bekker references with dots and commas in prose (205a.25,29) are prose, never tags', () => {
    const p = parseTranslationFile('{1.1}See 205a.25,29 and {1094a}beta {20}gamma.');
    expect(p.text).toBe('See 205a.25,29 and beta gamma.');
    expect(p.tags.map(t => t.raw)).toEqual(['1.1', '1094a', '20']);
    expect(p.warnings).toEqual([]);
  });

  it('trailing whitespace and tab-only lines collapse without moving later tags', () => {
    const p = parseTranslationFile('{1.1}Alpha \t\n\t\n  Beta {1094a}gamma.  \n');
    expect(p.text).toBe('Alpha\nBeta gamma.  \n');
    expect(p.tags[1]).toMatchObject({ citation: '1094a1', offset: p.text.indexOf('gamma') });
  });

  it('NFD Greek body: tag offsets are measured in the same code units as the text they index', () => {
    const arete = 'ἀρετή'.normalize('NFD');
    const logos = 'λόγος'.normalize('NFD');
    const p = parseTranslationFile(`{1.1}${arete} {1094a}${logos}`);
    expect(p.text).toBe(`${arete} ${logos}`);
    expect(p.text.slice(p.tags[1].offset)).toBe(logos);
  });

  it('a chapter tag on its own line: chapter-local offsets still point at their words after the leading break is trimmed', () => {
    const p = parseTranslationFile('{1.1}\n_Alpha_ {1094a}beta.\n{1.2}\nGamma {1094b}delta.');
    const { chapters } = splitChapters(p);
    expect(chapters.map(c => c.text)).toEqual(['Alpha beta.', 'Gamma delta.']);
    expect(chapters[0].tags[0]).toMatchObject({ citation: '1094a1', offset: 6 });
    expect(chapters[0].emphasis).toEqual([{ start: 0, end: 5, style: 'italic' }]);
    expect(chapters[1].tags[0]).toMatchObject({ citation: '1094b1', offset: 6 });
  });

  it('a chapter tag on its own line: a footnote marker keeps its word after the trim too', () => {
    const p = parseTranslationFile('{1.1}\nAlpha,[^1] beta.\n\n<!-- footnotes -->\n[^1]: n\n');
    const { chapters } = splitChapters(p);
    expect(chapters[0].text).toBe('Alpha, beta.');
    expect(chapters[0].footnoteMarkers[0].offset).toBe('Alpha,'.length);
  });

  it('a separator line that empties out (* * *) does not shift every emphasis span and footnote marker after it', () => {
    const raw = '{1.1}Alpha\n* * *\n_beta_ gamma[^1]\n\n<!-- footnotes -->\n[^1]: n\n';
    const p = parseTranslationFile(raw);
    expect(p.text).toBe('Alpha\nbeta gamma\n');
    expect(p.emphasis).toEqual([{ start: 6, end: 10, style: 'italic' }]);
    expect(p.text.slice(p.emphasis[0].start, p.emphasis[0].end)).toBe('beta');
    expect(p.footnoteMarkers).toEqual([{ offset: 'Alpha\nbeta gamma'.length, label: '1', display: '1' }]);
  });

  it('emphasis markers never pair across a paragraph break', () => {
    const p = parseTranslationFile('{1.1}Alpha _beta\ngamma_ delta.');
    expect(p.text).toBe('Alpha beta\ngamma delta.');
    expect(p.emphasis).toEqual([]);
  });
});
