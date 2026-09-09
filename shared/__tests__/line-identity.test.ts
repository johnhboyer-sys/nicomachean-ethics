// A lettered Bekker line (GA 775a prints 11a, 11b, 11c and no bare 11) is its
// own line. Two places kept addressing such a line by its bare number and so
// named a line that does not exist: search built its citation and its jump URL
// from `line.n` alone, and the reader's nearest-line fallback matched only ids
// ending in a digit, so it skipped every lettered anchor in the column.
import { describe, expect, it } from 'vitest';
import { lineAtPosition, nearestLineAnchor } from '../lib/data';
import type { GreekLine, Segment, Token } from '../lib/data';

const tok = (t: string, o = 0): Token => ({ t, o, k: '' });
const line = (n: number, sub: string | undefined, count: number): GreekLine =>
  ({ n, ...(sub ? { sub } : {}), text: 'x', tokens: Array.from({ length: count }, () => tok('x')) });

// GA 775a as the corpus really holds it: 10, then 11a/11b/11c, then 12.
const seg = {
  id: '4:775a', column: '775a', english: null,
  greek: [line(10, undefined, 2), line(11, 'a', 3), line(11, 'b', 2), line(11, 'c', 1), line(12, undefined, 2)],
} as unknown as Segment;

describe('lineAtPosition', () => {
  it('returns the letter of the line the token sits on', () => {
    expect(lineAtPosition(seg, 0)).toEqual({ n: 10, sub: undefined });   // first line
    expect(lineAtPosition(seg, 2)).toEqual({ n: 11, sub: 'a' });
    expect(lineAtPosition(seg, 5)).toEqual({ n: 11, sub: 'b' });
    expect(lineAtPosition(seg, 7)).toEqual({ n: 11, sub: 'c' });
    expect(lineAtPosition(seg, 8)).toEqual({ n: 12, sub: undefined });
  });

  it('falls back to the last line when the position runs past the segment', () => {
    expect(lineAtPosition(seg, 999)).toEqual({ n: 12, sub: undefined });
  });
});

describe('nearestLineAnchor', () => {
  const ids = ['L775a-10', 'L775a-11a', 'L775a-11b', 'L775a-11c', 'L775a-12'];

  it('resolves a bare citation of a lettered-only line to its first sub-line', () => {
    // The whole point: "775a11" is a real citation (LSJ, a printed reference, a
    // typed jump), and the edition has no bare 11. Landing on line 10 is wrong.
    expect(nearestLineAnchor(ids, '775a', 11)).toBe('L775a-11a');
  });

  it('prefers an exact unlettered line over any lettered neighbour', () => {
    expect(nearestLineAnchor(ids, '775a', 10)).toBe('L775a-10');
    expect(nearestLineAnchor(ids, '775a', 12)).toBe('L775a-12');
  });

  it('picks the closest line when the cited one is absent entirely', () => {
    expect(nearestLineAnchor(['L775a-10', 'L775a-20'], '775a', 18)).toBe('L775a-20');
  });

  it('ignores ids from another column', () => {
    expect(nearestLineAnchor(['L774b-11', 'L775a-30'], '775a', 11)).toBe('L775a-30');
  });

  it('returns null when the column has no lines at all', () => {
    expect(nearestLineAnchor(['L774b-11'], '775a', 11)).toBe(null);
  });
});

describe('nearestLineAnchor — tie-breaking', () => {
  it('prefers the unlettered line over a lettered one at the same distance', () => {
    // Not reachable through the reader (an exact id short-circuits the
    // fallback), but the ranking has to mean what its comment says.
    expect(nearestLineAnchor(['L2b-6a', 'L2b-6'], '2b', 6)).toBe('L2b-6');
  });

  it('picks the earliest letter regardless of the order the ids arrive in', () => {
    expect(nearestLineAnchor(['L775a-11c', 'L775a-11b', 'L775a-11a'], '775a', 11)).toBe('L775a-11a');
    expect(nearestLineAnchor(['L775a-11a', 'L775a-11b', 'L775a-11c'], '775a', 11)).toBe('L775a-11a');
  });

  it('ignores an id that is not a line anchor', () => {
    expect(nearestLineAnchor(['L775a-11a-c', 'col-775a', 'L775a-12'], '775a', 11)).toBe('L775a-12');
  });
});
