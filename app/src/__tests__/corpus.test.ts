// The home page IS the corpus table of contents. Its grouping lives in
// src/lib/corpus.ts (extracted from pages/index.astro) because a work that
// silently drops out of it — or a taxonomy entry that quietly turns into a card
// linking to a page that was never built — is invisible in a diff of a
// 700-line page and invisible on the built site until someone looks for that
// work and cannot find it.
import { describe, expect, it } from 'vitest';
import { CATEGORIES, WORKS, getWork, type Category } from '@shared/lib/works';
import { buildDivisions, builtWorkCards, toCards } from '../lib/corpus';

describe('toCards', () => {
  it('turns a registered id into a work card', () => {
    const [card] = toCards([{ id: 'EN' }]);

    expect(card.kind).toBe('work');
    expect(card.kind === 'work' && card.work.id).toBe('EN');
  });

  it('turns a bare title into a "coming soon" placeholder', () => {
    expect(toCards([{ title: 'On Colours' }])).toEqual([{ kind: 'soon', title: 'On Colours' }]);
  });

  // A taxonomy entry naming a work the registry does not have would otherwise
  // render a card linking to a page the build never emitted.
  it('drops an id the registry does not know rather than linking to a 404', () => {
    expect(toCards([{ id: 'NoSuchWork' }])).toEqual([]);
  });

  // The registry is filtered at compile time (private/gated editions), so an
  // entry can carry BOTH a known id and a fallback title. The work wins.
  it('prefers the real work when an entry carries both an id and a title', () => {
    const [card] = toCards([{ id: 'EN', title: 'Nicomachean Ethics (planned)' }]);

    expect(card.kind).toBe('work');
  });

  it('keeps taxonomy order', () => {
    expect(toCards([{ id: 'Cat' }, { title: 'Soon' }, { id: 'Int' }]).map((c) =>
      c.kind === 'work' ? c.work.id : c.title)).toEqual(['Cat', 'Soon', 'Int']);
  });
});

describe('buildDivisions', () => {
  const fixture: Category[] = [
    { numeral: 'I', title: 'Logic', works: [{ id: 'Cat' }, { title: 'Soon' }] },
    {
      numeral: 'II', title: 'Nature',
      subcategories: [
        { ref: 'II.a', label: 'Major Works', works: [{ id: 'Phys' }] },
        { ref: 'II.b', label: 'Minor Works', works: [{ id: 'NoSuchWork' }, { title: 'Later' }] },
      ],
    },
    { numeral: '', title: 'Doubtful', appendix: true, works: [{ title: 'Pseudo' }] },
  ];

  it('gives a flat division a single unlabelled group', () => {
    const [logic] = buildDivisions(fixture);

    expect(logic.groups).toHaveLength(1);
    expect(logic.groups[0].label).toBeUndefined();
    expect(logic.count).toBe(2);
  });

  it('keeps a sub-divided division\'s labels and refs', () => {
    const nature = buildDivisions(fixture)[1];

    expect(nature.groups.map((g) => [g.ref, g.label]))
      .toEqual([['II.a', 'Major Works'], ['II.b', 'Minor Works']]);
  });

  // The count is the "· N works" line under each division heading, and it must
  // count what is actually rendered — placeholders included, dropped ids not.
  it('counts the cards it actually renders, across sub-groups', () => {
    const nature = buildDivisions(fixture)[1];

    expect(nature.count).toBe(2);   // Phys + "Later"; NoSuchWork was dropped
  });

  it('marks the appendix and leaves it without a numeral', () => {
    const divisions = buildDivisions(fixture);

    expect(divisions.map((d) => d.appendix)).toEqual([false, false, true]);
    expect(divisions.at(-1)!.numeral).toBe('');
  });

  it('handles a category with neither works nor subcategories', () => {
    expect(buildDivisions([{ numeral: 'X', title: 'Empty' }])[0])
      .toEqual({ numeral: 'X', title: 'Empty', appendix: false, count: 0, groups: [{ cards: [] }] });
  });
});

describe('builtWorkCards', () => {
  it('flattens every work card across divisions and groups, in order', () => {
    const cards = builtWorkCards(buildDivisions([
      { numeral: 'I', title: 'A', works: [{ id: 'Cat' }, { title: 'Soon' }] },
      { numeral: 'II', title: 'B', subcategories: [{ ref: 'II.a', label: 'x', works: [{ id: 'Phys' }] }] },
    ]));

    expect(cards.map((c) => c.work.id)).toEqual(['Cat', 'Phys']);
  });
});

// Guards on the real taxonomy, not on a fixture: these are the invariants the
// home page's own structured data (an ItemList of every built work) depends on.
describe('the real corpus taxonomy', () => {
  const divisions = buildDivisions(CATEGORIES);
  const built = builtWorkCards(divisions);

  // Porphyry's Isagoge is intentionally NOT a home division (works.ts, at
  // CATEGORIES): it reaches readers through the Categories it introduces, and
  // stays routable at /Isa and searchable. It is the ONLY such exception — any
  // other work missing here is a work no reader can find from the home page.
  it('places every registered work on the home page, bar the documented exception', () => {
    const placed = new Set(built.map((c) => c.work.id));
    const missing = WORKS.map((w) => w.id).filter((id) => !placed.has(id));

    expect(missing, 'works in the registry that no division lists').toEqual(['Isa']);
  });

  it('lists no work twice', () => {
    const ids = built.map((c) => c.work.id);

    expect(ids).toEqual([...new Set(ids)]);
  });

  it('names only works the registry can resolve, so no card links to a 404', () => {
    for (const c of built) expect(getWork(c.work.id)).toBeDefined();
  });

  it('gives every division a title and a non-empty body', () => {
    for (const d of divisions) {
      expect(d.title, JSON.stringify(d.numeral)).toBeTruthy();
      expect(d.count, d.title).toBeGreaterThan(0);
    }
  });

  it('numbers every division except the appendix', () => {
    for (const d of divisions) {
      if (d.appendix) expect(d.numeral, d.title).toBe('');
      else expect(d.numeral, d.title).toMatch(/^[IVX]+$/);
    }
  });
});
