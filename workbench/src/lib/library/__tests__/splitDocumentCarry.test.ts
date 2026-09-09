// splitDocument re-bases a document into parts for the compile export. What
// it does not carry, the export cannot print: a heading title override or an
// import's row_refs dropped here vanish from the Word file with no notice.
import { describe, expect, it } from 'vitest';
import { splitDocument } from '../splitDocument';
import { parseChapterFile, serializeChapterFile } from '../../chapterfile';
import type { ChapterFile } from '../../chapterfile';
import { DEFAULT_PROFILE } from '../../works/profile';
import type { WorkProfile } from '../../works/profile';
import { documentCompileInput } from '../../export/documentExport';
import { compileWorkMarkdown } from '../../export/compile';
import type { WorkManifest } from '../../works/manifest';

const PROFILE: WorkProfile = {
  levels: [
    { name: 'Part', navRole: 'book', depth: 0 },
    { name: 'Question', navRole: 'chapter', depth: 1 },
    { name: 'Article', navRole: 'heading', depth: 2 },
  ],
};

function paragraphDoc(): ChapterFile {
  return {
    meta: {
      schemaVersion: 1,
      work: 'summa',
      book: 1,
      chapter: 1,
      citationScheme: 'paragraph',
      spanStart: '¶1',
      spanEnd: '¶4',
      headers: [
        { row: 1, level: 2 },
        { row: 2, level: 3 },
        { row: 3, level: 2 },
        { row: 4, level: 3 },
      ],
    },
    greekLines: ['Quaestio 1', 'Articulus 1', 'Quaestio 2', 'Articulus 2'],
    englishLines: ['Question 1', 'Article 1', 'Question 2', 'Article 2'],
    headingTitleLines: ['', 'Objection 1', '', 'On usury'],
    footnotes: [],
  };
}

describe('splitDocument carries every per-row section and the import refs', () => {
  it('heading title overrides ride into the part that owns their row', () => {
    const parts = splitDocument(paragraphDoc(), PROFILE);
    expect(parts).toHaveLength(2);
    expect(parts[0].file.headingTitleLines).toEqual(['', 'Objection 1']);
    expect(parts[1].file.headingTitleLines).toEqual(['', 'On usury']);
    for (const p of parts) expect(parseChapterFile(serializeChapterFile(p.file), 'part')).toEqual(p.file);
  });

  it('a part with no override in it carries no [HEADING_TITLES] (round-trips)', () => {
    const file = paragraphDoc();
    file.headingTitleLines = ['', 'Objection 1', '', ''];
    const parts = splitDocument(file, PROFILE);
    expect(parts[1].file.headingTitleLines).toBeUndefined();
    expect(parseChapterFile(serializeChapterFile(parts[1].file), 'part')).toEqual(parts[1].file);
  });

  it('an import keeps its row_refs, spans and line splits through the single-part split', () => {
    const refs = ['184a.t', '184a.10', '184a.11', '205a.25,29'];
    const file: ChapterFile = {
      meta: {
        schemaVersion: 1,
        work: 'physics',
        book: 1,
        chapter: 1,
        citationScheme: 'source-ref',
        spanStart: refs[0],
        spanEnd: refs[3],
        rowRefs: refs,
        lineSplits: [{ ref: '205a.25,29', offset: 3 }],
        headers: [{ row: 1, level: 1 }],
      },
      greekLines: ['Α', 'Ἐπειδὴ τὸ εἰδέναι', 'συμβαίνει', 'ὧν εἰσὶν'],
      englishLines: ['', 'Since knowing', 'comes about', 'of¶which'],
      footnotes: [],
    };
    const parts = splitDocument(file, DEFAULT_PROFILE);
    expect(parts).toHaveLength(1);
    expect(parts[0].file.meta.rowRefs).toEqual(refs);
    expect(parts[0].file.meta.spanStart).toBe('184a.t');
    expect(parts[0].file.meta.spanEnd).toBe('205a.25,29');
    expect(parts[0].file.meta.lineSplits).toEqual([{ ref: '205a.25,29', offset: 3 }]);
    expect(parseChapterFile(serializeChapterFile(parts[0].file), 'part')).toEqual(parts[0].file);
  });

  it('an import cut into chapters keeps each part’s own refs and drops the others’ splits', () => {
    const refs = ['1.1', '1.2', '2.1', '2.2'];
    const file: ChapterFile = {
      meta: {
        schemaVersion: 1,
        work: 'w',
        book: 1,
        chapter: 1,
        citationScheme: 'source-ref',
        spanStart: '1.1',
        spanEnd: '2.2',
        rowRefs: refs,
        lineSplits: [{ ref: '1.2', offset: 2 }, { ref: '2.2', offset: 2 }],
        headers: [{ row: 1, level: 2 }, { row: 3, level: 2 }],
      },
      greekLines: ['Α', 'β γ', 'Β', 'δ ε'],
      englishLines: ['', 'b¶c', '', 'd¶e'],
      footnotes: [],
    };
    const parts = splitDocument(file, PROFILE);
    expect(parts.map((p) => p.file.meta.rowRefs)).toEqual([['1.1', '1.2'], ['2.1', '2.2']]);
    expect(parts.map((p) => [p.file.meta.spanStart, p.file.meta.spanEnd])).toEqual([['1.1', '1.2'], ['2.1', '2.2']]);
    expect(parts.map((p) => p.file.meta.lineSplits)).toEqual([[{ ref: '1.2', offset: 2 }], [{ ref: '2.2', offset: 2 }]]);
  });
});

describe('the compiled export sees what the file carries', () => {
  it('prints the heading title override, not the translation, in a marked document', () => {
    const work: WorkManifest = {
      id: 'summa', title: 'Summa', author: '', scheme: 'paragraph', books: [{ n: 1, label: '' }], profile: PROFILE,
    };
    const { chapters, work: out } = documentCompileInput(paragraphDoc(), work);
    const md = compileWorkMarkdown(chapters, out).markdown;
    expect(md).toContain('#### Objection 1');
    expect(md).toContain('#### On usury');
    expect(md).not.toContain('#### Article 1');
  });

  it('stamps an imported work’s references in the compiled English', () => {
    const refs = ['184a.10', '184a.11', '184b.1'];
    const file: ChapterFile = {
      meta: {
        schemaVersion: 1, work: 'physics', book: 1, chapter: 1, citationScheme: 'source-ref',
        spanStart: refs[0], spanEnd: refs[2], rowRefs: refs,
      },
      greekLines: ['α', 'β', 'γ'],
      englishLines: ['Since knowing', 'comes about', 'in every inquiry'],
      footnotes: [],
    };
    const work: WorkManifest = { id: 'physics', title: 'Physics', author: 'Aristotle', scheme: 'source-ref', books: [] };
    const { chapters, work: out } = documentCompileInput(file, work);
    const md = compileWorkMarkdown(chapters, out).markdown;
    expect(md).toContain('[184b] in every inquiry');
  });
});
