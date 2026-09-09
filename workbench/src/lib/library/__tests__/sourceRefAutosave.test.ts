// A source import's rows carry the source's own citations (`row_refs`). Every
// save must carry them forward — they are what the outline, the export stamps
// and every citation are built from, and nothing can re-derive them.
import { describe, expect, it } from 'vitest';
import { parseChapterFile, serializeChapterFile } from '../../chapterfile';
import { createSourceImport } from '../../import/createSourceImport';
import { buildRowDoc } from '../../editor/serialize';
import type { ChapterModel } from '../../editor/model';
import { chapterFileFromModel, hydrateFromFile, serializeModel } from '../autosave';
import type { HydrationResult } from '../autosave';

const ROWS = [
  { ref: '184a.t', text: 'ΦΥΣΙΚΗΣ ΑΚΡΟΑΣΕΩΣ Α' },
  { ref: '184a.10', text: 'Ἐπειδὴ τὸ εἰδέναι καὶ τὸ ἐπίστασθαι' },
  { ref: '184a.11', text: 'συμβαίνει περὶ πάσας τὰς μεθόδους' },
  { ref: '205a.25,29', text: 'ὧν εἰσὶν ἀρχαὶ ἢ αἴτια ἢ στοιχεῖα' },
];

function importedModel(): { model: ChapterModel; h: HydrationResult } {
  const { work, file } = createSourceImport({ title: 'Physics', rows: ROWS });
  const parsed = parseChapterFile(serializeChapterFile(file), 'import');
  const h = hydrateFromFile(parsed, [], work.scheme);
  const model = {
    workId: work.id,
    workTitle: work.title,
    scheme: work.scheme,
    book: 1,
    bookLabel: '',
    chapter: 1,
    bekkerRange: '',
    rows: h.rows,
    footnotes: h.footnotes,
    dirty: false,
  } as unknown as ChapterModel;
  return { model, h };
}

describe('autosave of a source-ref import', () => {
  it('keeps row_refs, the source spans and the title-row heading across a save', () => {
    const { model, h } = importedModel();
    expect(h.rows.map((r) => r.address.raw)).toEqual(ROWS.map((r) => r.ref));

    const content = serializeModel(model, h.spans);
    const back = parseChapterFile(content, 'saved');
    expect(back.meta.rowRefs).toEqual(ROWS.map((r) => r.ref));
    expect(back.meta.spanStart).toBe('184a.t');
    expect(back.meta.spanEnd).toBe('205a.25,29');
    expect(back.meta.headers).toEqual([{ row: 1, level: 1 }]);

    const again = hydrateFromFile(back, [], 'source-ref');
    expect(again.rows.map((r) => r.address.raw)).toEqual(ROWS.map((r) => r.ref));
    expect(again.notice).toBeNull();
  });

  it('a paragraph split inside an imported line survives the save (its ref is the row address)', () => {
    const { model, h } = importedModel();
    const row = model.rows[3];
    row.splitOffsets = [3]; // after "ὧν "
    row.english = buildRowDoc([{ kind: 'text', text: 'of which', marks: {} }]).toJSON();
    row.english2 = [buildRowDoc([{ kind: 'text', text: 'there are principles', marks: {} }]).toJSON()];

    const back = parseChapterFile(serializeModel(model, h.spans), 'split');
    expect(back.meta.lineSplits).toEqual([{ ref: "205a.25,29", offset: 3 }]);
    const again = hydrateFromFile(back, [], 'source-ref');
    expect(again.notice).toBeNull();
    expect(again.rows[3].splitOffsets).toEqual([3]);
    expect(again.rows[3].english2).toHaveLength(1);
  });

  it('a document whose addresses ARE its ordinals still writes no row_refs (old files stay byte-identical)', () => {
    const { work, file } = createSourceImport({ title: 'Lines', rows: [{ ref: '1', text: 'a' }, { ref: '2', text: 'b' }] });
    const h = hydrateFromFile(file, [], work.scheme);
    const model = {
      workId: work.id, workTitle: work.title, scheme: work.scheme, book: 1, bookLabel: '', chapter: 1,
      bekkerRange: '', rows: h.rows, footnotes: h.footnotes, dirty: false,
    } as unknown as ChapterModel;
    const doc = chapterFileFromModel(model, h.spans);
    expect(doc.meta.rowRefs).toBeUndefined();
    expect(hydrateFromFile(parseChapterFile(serializeModel(model), 'ord'), [], 'source-ref').rows.map((r) => r.address.raw)).toEqual(['1', '2']);
  });
});
