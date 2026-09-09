// Resolve the corpus taxonomy (shared/lib/works CATEGORIES) into the per-division
// view model the home page renders. Extracted from pages/index.astro so the
// grouping can be tested: the home page IS the corpus table of contents, and a
// work silently dropped from it — or a planned work that quietly turns into a
// dead card — is invisible in a diff of a 700-line page.
import { getWork, type Category, type CategoryWork, type Work } from '@shared/lib/works';

// A card is an existing work (clickable → its landing page) or a "coming soon"
// placeholder (a work not yet added).
export type Card =
  | { kind: 'work'; work: Work }
  | { kind: 'soon'; title: string };

export interface DivisionGroup { ref?: string; label?: string; cards: Card[]; }

export interface Division {
  numeral: string;
  title: string;
  appendix: boolean;                              // spurious appendix — no numeral, set off by a rule
  count: number;                                  // total cards (works + soon)
  groups: DivisionGroup[];
}

// A taxonomy entry with an `id` that the registry knows becomes a work card; one
// with only a `title` becomes a placeholder. An entry whose `id` is unknown to
// the registry (a work named in the taxonomy but not yet built) is dropped
// entirely rather than rendered as a link to a page that does not exist.
export const toCards = (ws: CategoryWork[]): Card[] =>
  ws.flatMap((cw) => {
    const w = cw.id ? getWork(cw.id) : undefined;
    if (w) return [{ kind: 'work', work: w } as Card];
    if (cw.title) return [{ kind: 'soon', title: cw.title } as Card];
    return [];
  });

// Each division holds either a flat list of cards or labelled sub-groups
// (Natural Philosophy).
export function buildDivisions(categories: Category[]): Division[] {
  return categories.map((cat) => {
    const groups = cat.subcategories
      ? cat.subcategories.map((sub) => ({ ref: sub.ref, label: sub.label, cards: toCards(sub.works) }))
      : [{ cards: toCards(cat.works ?? []) }];
    const count = groups.reduce((n, g) => n + g.cards.length, 0);
    return { numeral: cat.numeral, title: cat.title, appendix: !!cat.appendix, count, groups };
  });
}

// Every built work in taxonomy order — what the home page's ItemList structured
// data enumerates and what the "Continue reading" card is keyed on.
export const builtWorkCards = (divisions: Division[]): Extract<Card, { kind: 'work' }>[] =>
  divisions.flatMap((d) =>
    d.groups.flatMap((g) => g.cards.filter((c): c is Extract<Card, { kind: 'work' }> => c.kind === 'work')),
  );
