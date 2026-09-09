// Pins for the on-disk chapter-file format: parse(serialize(doc)) must equal
// doc for every awkward input a real file can carry, and the parser must
// accept what the serializer writes. Each case is one concrete file shape.
import { describe, expect, it } from 'vitest';
import { parseChapterFile, serializeChapterFile } from '../index';
import type { ChapterFile, ChapterFileMeta } from '../types';

const META: ChapterFileMeta = {
  schemaVersion: 1,
  work: 'metaphysics',
  book: 7,
  chapter: 17,
  citationScheme: 'bekker-metaphysics',
  spanStart: '1041a6',
  spanEnd: '1041a8',
};

function doc(overrides: Partial<ChapterFile> = {}, meta: Partial<ChapterFileMeta> = {}): ChapterFile {
  return {
    meta: { ...META, ...meta },
    greekLines: ['α', 'β', 'γ'],
    englishLines: ['one', '', 'three'],
    footnotes: [],
    ...overrides,
  };
}

function roundTrip(d: ChapterFile): ChapterFile {
  return parseChapterFile(serializeChapterFile(d), 'pin');
}

describe('chapter-file format pins (parse ∘ serialize = id)', () => {
  it('a numeric-looking work id survives — YAML must not read "1984" as a number', () => {
    // slugForTitle("1984") is "1984": a title that is a number is a legal work.
    const d = doc({}, { work: '1984' });
    const back = roundTrip(d);
    expect(back.meta.work).toBe('1984');
    expect(back).toEqual(d);
  });

  it('a work id that YAML would read as a boolean or null stays a string', () => {
    for (const work of ['true', 'false', 'null', '1e3', '0x1f']) {
      expect(roundTrip(doc({}, { work })).meta.work).toBe(work);
    }
  });

  it('an older file whose numeric work id was written unquoted still opens', () => {
    const raw = serializeChapterFile(doc()).replace('work: metaphysics', 'work: 1984');
    expect(parseChapterFile(raw, 'legacy').meta.work).toBe('1984');
  });

  it('a UTF-8 BOM before the frontmatter is not "missing frontmatter"', () => {
    const raw = '﻿' + serializeChapterFile(doc());
    expect(parseChapterFile(raw, 'bom')).toEqual(doc());
  });

  it('CRLF everywhere parses to the same doc, and re-serializes with LF', () => {
    const lf = serializeChapterFile(doc({ footnotes: [{ id: 1, body: 'a\nb' }] }));
    const crlf = lf.replace(/\n/g, '\r\n');
    expect(parseChapterFile(crlf, 'crlf')).toEqual(parseChapterFile(lf, 'lf'));
    expect(serializeChapterFile(parseChapterFile(crlf, 'crlf'))).toBe(lf);
  });

  it('trailing whitespace on a row is content and round-trips byte-for-byte', () => {
    const d = doc({ greekLines: ['α ', 'β\t', 'γ'], englishLines: ['one  ', ' ', ''] });
    expect(roundTrip(d)).toEqual(d);
  });

  it('NFD Greek is never normalized on the way through', () => {
    const nfd = 'τὸ τί ἦν εἶναι'.normalize('NFD');
    expect(nfd).not.toBe(nfd.normalize('NFC'));
    const d = doc({ greekLines: [nfd, 'β', 'γ'], englishLines: [nfd, '', ''] });
    const back = roundTrip(d);
    expect(back.greekLines[0]).toBe(nfd);
    expect(back.englishLines[0]).toBe(nfd);
  });

  it('empty cells: every English row empty, the last Greek row empty', () => {
    const d = doc({ greekLines: ['α', 'β', ''], englishLines: ['', '', ''] });
    expect(roundTrip(d)).toEqual(d);
  });

  it('a lettered source line ("8t") and a comma-numbered line ("205a.25,29") survive in row_refs, column-free', () => {
    const refs = ['184a.t', '184a.10', '205a.25,29'];
    const d = doc(
      {},
      { citationScheme: 'source-ref', spanStart: refs[0], spanEnd: refs[2], rowRefs: refs },
    );
    expect(roundTrip(d)).toEqual(d);
  });

  it('a percent sign in a list ref is escaped, not mistaken for an escape', () => {
    // No shipped scheme accepts "%", so exercise the codec at the frontmatter
    // level: the encoder must make "%2C" (literal) and "," (escaped) distinct.
    const raw = serializeChapterFile(
      doc({}, { citationScheme: 'source-ref', spanStart: '1.1', spanEnd: '1.3', rowRefs: ['1.1', '1.2,3', '1.3'] }),
    );
    expect(raw).toContain('row_refs: "1.1,1.2%2C3,1.3"');
    expect(parseChapterFile(raw, 'pct').meta.rowRefs).toEqual(['1.1', '1.2,3', '1.3']);
  });

  it('line_splits on a comma-numbered address round-trips', () => {
    const refs = ['205a.25,29', '205a.30'];
    const d = doc(
      { greekLines: ['αβ γδ', 'ε'], englishLines: ['a¶b', ''] },
      {
        citationScheme: 'source-ref',
        spanStart: refs[0],
        spanEnd: refs[1],
        rowRefs: refs,
        lineSplits: [{ ref: '205a.25,29', offset: 3 }],
      },
    );
    expect(roundTrip(d)).toEqual(d);
  });

  it('[ENGLISH.PARA] carrying the structural ⏎ token and an escaped literal one', () => {
    const d = doc({ englishParaLines: ['first⏎second', 'a literal \\⏎ mark', ''] });
    expect(roundTrip(d)).toEqual(d);
  });

  it('heading marks and a title override on a document file', () => {
    const d = doc(
      { headingTitleLines: ['Objection 2', '', ''] },
      { citationScheme: 'plain-line', spanStart: '1', spanEnd: '3', headers: [{ row: 1, level: 1 }] },
    );
    expect(roundTrip(d)).toEqual(d);
  });

  it('a footnote body whose second line looks like a new entry ("2: …") stays one footnote', () => {
    const d = doc({ footnotes: [{ id: 1, body: 'See below.\n2: not a footnote' }, { id: 2, body: 'real' }] });
    expect(roundTrip(d)).toEqual(d);
  });

  it('a footnote body line that begins with a backslash is kept verbatim', () => {
    const d = doc({ footnotes: [{ id: 1, body: 'first\n\\second' }] });
    expect(roundTrip(d)).toEqual(d);
  });

  it('a footnote body ending in a blank line, and an empty body', () => {
    const d = doc({ footnotes: [{ id: 1, body: '' }, { id: 2, body: 'x\n' }, { id: 3, body: '\n' }] });
    expect(roundTrip(d)).toEqual(d);
  });

  it('serialize is idempotent over parse (a second save writes the same bytes)', () => {
    const d = doc(
      { englishParaLines: ['p⏎q', '', ''], footnotes: [{ id: 1, body: 'a\n\nb' }] },
      { citationScheme: 'plain-line', spanStart: '1', spanEnd: '3', paragraphStarts: [1, 3], headers: [{ row: 2, level: 2 }] },
    );
    const once = serializeChapterFile(d);
    expect(serializeChapterFile(parseChapterFile(once, 'once'))).toBe(once);
  });
});
