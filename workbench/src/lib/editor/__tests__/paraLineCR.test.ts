// A paragraph-layer text can arrive with Windows line endings (a paste). The
// [ENGLISH.PARA] section is one physical line per row, so a raw CR in it is
// read back as a line break and the row counts no longer match — the file
// refuses to open. The encoder must fold CR/CRLF to the structural ⏎.
import { describe, expect, it } from 'vitest';
import { decodeParaLine, encodeParaLine } from '../serialize';
import { parseChapterFile, serializeChapterFile } from '../../chapterfile';

describe('encodeParaLine and carriage returns', () => {
  it('folds CRLF and a lone CR to the ⏎ token, so the row stays one physical line', () => {
    expect(encodeParaLine('a\r\nb\rc')).toBe('a⏎b⏎c');
    expect(decodeParaLine(encodeParaLine('a\r\nb'))).toBe('a\nb');
  });

  it('a chapter file written from such a row opens with the same row count', () => {
    const line = encodeParaLine('first\r\nsecond');
    const raw = serializeChapterFile({
      meta: { schemaVersion: 1, work: 'w', book: 1, chapter: 1, citationScheme: 'paragraph', spanStart: '¶1', spanEnd: '¶2' },
      greekLines: ['α', 'β'],
      englishLines: ['', ''],
      englishParaLines: [line, ''],
      footnotes: [],
    });
    expect(parseChapterFile(raw, 'cr').englishParaLines).toEqual([line, '']);
  });
});
