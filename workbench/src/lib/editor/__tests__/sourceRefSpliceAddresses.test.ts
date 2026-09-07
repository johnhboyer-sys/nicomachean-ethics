// A document whose addresses came FROM ITS SOURCE must keep them across a row
// split, a merge, and the renumber that follows every splice.
//
// The rule ChapterEditor's reassignDocumentAddresses used to apply was
// "spineSource === 'document' ⇒ the addresses ARE the ordinals". That is true
// of the paragraph and plain-line schemes, and false of source-ref: an
// imported work's rows carry the citations the edition printed ("184a.10",
// "205a.25,29", "1.327a"). Renumbering those 1, 2, 3… is not a display
// problem — autosave's sourceRowRefs keeps `row_refs` only while the
// addresses are NOT the ordinals, so the first save after a splice would drop
// the work's citations, the outline's chapter divisions and the export's
// reference stamps. (The gate in rowStructure's canEditRowStructure means no
// splice reaches a source-ref work today; this pins the rule so opening that
// gate cannot be the thing that loses them.)
//
// The two decision functions are pure and exported from ChapterEditor's
// module context, so they are exercised for real here rather than scanned;
// the plumbing that can only run in a mounted editor is source-scanned, in
// the style of structureEditingWiring.test.ts.
import { beforeAll, describe, expect, it } from 'vitest';

import { getScheme } from '../../citation/registry';
import { documentOrdinalAddress, chapterFileFromModel } from '../../library/autosave';
import { emptyRowDocJSON } from '../schema';
import type { Address, CitationScheme } from '../../citation/types';

// ChapterEditor's module context, loaded through a cast: tsc types every
// `*.svelte` import as default-only, so a named import of these would not
// compile even though the compiled module exports them.
interface ChapterEditorModule {
  documentAddressesAreSource(
    scheme: CitationScheme,
    addresses: readonly string[],
    ordinalOf: (rowIndex: number) => string,
  ): boolean;
  inheritedSpliceAddress(
    before: readonly Address[],
    index: number,
    removeCount: number,
    k: number,
  ): Address | null;
}
let documentAddressesAreSource: ChapterEditorModule['documentAddressesAreSource'];
let inheritedSpliceAddress: ChapterEditorModule['inheritedSpliceAddress'];

beforeAll(async () => {
  const mod = (await import('../ChapterEditor.svelte')) as unknown as ChapterEditorModule;
  documentAddressesAreSource = mod.documentAddressesAreSource;
  inheritedSpliceAddress = mod.inheritedSpliceAddress;
});

const sourceRef = getScheme('source-ref');
const plainLine = getScheme('plain-line');
const paragraph = getScheme('paragraph');

const ordinalOf = (scheme: CitationScheme) => (n: number) => documentOrdinalAddress(scheme, n).raw;
const addr = (raw: string): Address => ({ scheme: 'source-ref', raw });

describe('documentAddressesAreSource — is this document carrying the source’s citations?', () => {
  it('says yes for an import whose rows carry the edition’s own line numbers', () => {
    expect(
      documentAddressesAreSource(sourceRef, ['184a.10', '184a.11', '205a.25,29'], ordinalOf(sourceRef)),
    ).toBe(true);
  });

  it('says no when every address is already the ordinal (a plain-line document)', () => {
    expect(documentAddressesAreSource(plainLine, ['1', '2', '3'], ordinalOf(plainLine))).toBe(false);
    expect(documentAddressesAreSource(paragraph, ['¶1', '¶2'], ordinalOf(paragraph))).toBe(false);
  });

  it('says no for an import whose source happened to number its lines 1, 2, 3', () => {
    // Nothing to preserve — and the file on disk keeps no row_refs for it
    // either (autosave's sourceRowRefs makes the same call).
    expect(documentAddressesAreSource(sourceRef, ['1', '2', '3'], ordinalOf(sourceRef))).toBe(false);
  });

  it('says no when any address is empty or unusable — mirroring what the save would keep', () => {
    expect(documentAddressesAreSource(sourceRef, ['184a.10', ''], ordinalOf(sourceRef))).toBe(false);
    expect(
      documentAddressesAreSource(sourceRef, ['184a.10', 'urn:cts:greekLit'], ordinalOf(sourceRef)),
    ).toBe(false);
    expect(documentAddressesAreSource(sourceRef, [], ordinalOf(sourceRef))).toBe(false);
  });
});

describe('inheritedSpliceAddress — what a spliced-in row is called', () => {
  const before = [addr('184a.10'), addr('184a.11'), addr('184a.12')];

  it('a SPLIT gives both halves the split line’s own citation', () => {
    // One printed line becomes two rows; both are that line.
    expect(inheritedSpliceAddress(before, 1, 1, 0)).toEqual(addr('184a.11'));
    expect(inheritedSpliceAddress(before, 1, 1, 1)).toEqual(addr('184a.11'));
  });

  it('a MERGE keeps the first of the rows it replaced', () => {
    expect(inheritedSpliceAddress(before, 0, 2, 0)).toEqual(addr('184a.10'));
  });

  it('an INSERT takes the address of the row it displaced', () => {
    expect(inheritedSpliceAddress(before, 2, 0, 0)).toEqual(addr('184a.12'));
  });

  it('an insert at the END takes the last row’s address, not nothing', () => {
    expect(inheritedSpliceAddress(before, 3, 0, 0)).toEqual(addr('184a.12'));
  });

  it('an empty model has nothing to inherit', () => {
    expect(inheritedSpliceAddress([], 0, 0, 0)).toBeNull();
  });
});

describe('the consequence: row_refs survive a splice', () => {
  /** Minimal document-spine model of the shape chapterFileFromModel reads. */
  function modelOf(raws: string[]) {
    return {
      workId: 'physica-2',
      workTitle: 'Physics',
      book: 1,
      bookLabel: 'Α',
      chapter: 1,
      scheme: 'source-ref' as const,
      dirty: false,
      footnotes: [],
      rows: raws.map((raw) => ({
        address: addr(raw),
        greek: 'τῶν',
        english: emptyRowDocJSON(),
      })),
    };
  }

  it('a split that renumbered the rows would drop them; carrying the citations keeps them', () => {
    const source = ['184a.10', '184a.11', '184a.12'];

    // What the old rule produced after splitting row 2 in two: four ordinals.
    const renumbered = chapterFileFromModel(modelOf(['1', '2', '3', '4']) as never);
    expect(renumbered.meta.rowRefs).toBeUndefined();
    expect(renumbered.meta.spanStart).toBe('1');

    // What the rule here produces: the split line's citation on both halves.
    const carried = chapterFileFromModel(
      modelOf([source[0], source[1], source[1], source[2]]) as never,
    );
    expect(carried.meta.rowRefs).toEqual(['184a.10', '184a.11', '184a.11', '184a.12']);
    expect(carried.meta.spanStart).toBe('184a.10');
    expect(carried.meta.spanEnd).toBe('184a.12');
  });
});

describe('ChapterEditor wiring (source-scan — needs a mounted editor to run)', () => {
  let chapterSource = '';

  beforeAll(async () => {
    const fs = (await import(/* @vite-ignore */ 'node' + ':fs')) as unknown as {
      readFileSync(path: string, encoding: 'utf-8'): string;
    };
    const nodeUrl = (await import(/* @vite-ignore */ 'node' + ':url')) as unknown as {
      fileURLToPath(url: URL): string;
    };
    chapterSource = fs.readFileSync(
      nodeUrl.fileURLToPath(new URL('../ChapterEditor.svelte', import.meta.url)),
      'utf-8',
    );
  });

  function fnBody(name: string): string {
    const start = chapterSource.indexOf(`function ${name}(`);
    expect(start, `function ${name} exists`).toBeGreaterThan(-1);
    const end = chapterSource.indexOf('\n  }', start);
    return chapterSource.slice(start, end);
  }

  it('the renumber refuses to run over source citations', () => {
    expect(fnBody('reassignDocumentAddresses')).toContain('if (sourceAddressed) return;');
  });

  it('the question is asked of the model BEFORE the splice, and the new rows inherit', () => {
    const body = fnBody('spliceRows');
    // Before model.rows.splice — afterwards the new rows carry a placeholder.
    expect(body.indexOf('documentAddressesAreSource(')).toBeLessThan(
      body.indexOf('model.rows.splice('),
    );
    expect(body).toContain('inheritedSpliceAddress(before, index, removeCount, k)');
    expect(body).toContain("if (newRows[k].address.raw !== '') continue;");
  });

  it('structural undo/redo restores each snapshotted row’s own address', () => {
    expect(chapterSource).toContain('snapshotAddresses.set(snap, row.address);');
    expect(fnBody('rowModelFromStructSnapshot')).toContain('snapshotAddresses.get(s)');
  });
});
