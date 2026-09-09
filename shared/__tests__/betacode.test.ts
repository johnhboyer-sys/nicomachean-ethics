import { describe, expect, it } from 'vitest';
import { betaToGreek } from '../lib/betacode';

describe('betaToGreek', () => {
  it.each([
    ['plain letters', 'logos', 'λογος'],
    ['acute accent', 'lo/gos', 'λόγος'],
    ['grave accent', 'a\\nqrwpos', 'ὰνθρωπος'],
    ['circumflex', 'a=ra', 'ἆρα'.replace('ἆ', 'ᾶ')],
    ['smooth breathing', 'a)reth/', 'ἀρετή'],
    ['rough breathing', 'a(/gios', 'ἅγιος'],
    ['iota subscript', 'a)/|dhs', 'ᾄδης'],
    ['diaeresis', 'i+sxu/s', 'ϊσχύς'],
    ['final sigma before punctuation', 'logos, logos.', 'λογος, λογος.'],
    ['medial sigma', 'swma', 'σωμα'],
    ['capital marker', '*aristote/lhs', 'Αριστοτέλης'],
    ['capital with breathing', '*)/anqrwpos', 'Ἄνθρωπος'],
    ['capital lemma example', '*eu)rw/phs', 'Εὐρώπης'],
    ['drops trailing homograph digit', 'le/gw1', 'λέγω'],
    ['passes punctuation through', 'peri\\ yuxh=s', 'περὶ ψυχῆς'],
    ['leaves ! prefix while converting following Beta Code', '!*)agaqo/s', '!Ἀγαθός'],
  ])('%s', (_label, input, expected) => {
    expect(betaToGreek(input)).toBe(expected);
  });

  // Every letter, both cases, in one table: the LETTER map and the "*" path.
  const LETTERS: [string, string][] = [
    ['a', 'α'], ['b', 'β'], ['g', 'γ'], ['d', 'δ'], ['e', 'ε'], ['z', 'ζ'], ['h', 'η'],
    ['q', 'θ'], ['i', 'ι'], ['k', 'κ'], ['l', 'λ'], ['m', 'μ'], ['n', 'ν'], ['c', 'ξ'],
    ['o', 'ο'], ['p', 'π'], ['r', 'ρ'], ['s', 'σ'], ['t', 'τ'], ['u', 'υ'], ['f', 'φ'],
    ['x', 'χ'], ['y', 'ψ'], ['w', 'ω'], ['v', 'ϝ'],
  ];
  it.each(LETTERS)('maps %s to %s in both cases', (beta, greek) => {
    // Medial position, so a sigma stays σ.
    expect(betaToGreek(`${beta}a`)).toBe(`${greek}α`);
    expect(betaToGreek(`*${beta}a`)).toBe(`${greek.toUpperCase()}α`);
  });

  it('writes the final sigma at a word end and nowhere else', () => {
    expect(betaToGreek('sofo/s')).toBe('σοφός');
    expect(betaToGreek('sofo/s sofo/s')).toBe('σοφός σοφός');
    expect(betaToGreek('sofo/s1')).toBe('σοφός');
    expect(betaToGreek("a)ll'")).toBe('ἀλλ\u2019'.replace('\u2019', "'"));
    expect(betaToGreek('*s')).toBe('Σ');
    expect(betaToGreek('ss')).toBe('σς');
  });

  // Breathing, accent and iota subscript in every combination, on a lowercase
  // and a capital alpha. The expected forms are built from combining marks in
  // NFD order and composed, so the test says nothing about which code point
  // Unicode chose — only that the output IS the composed form (every
  // lowercase combination has a single precomposed code point; a capital with
  // an accent but no breathing does not, and composes as far as it can) and
  // that the capital keeps its subscript as a subscript rather than expanding
  // it into a separate capital iota.
  const BREATHS: [string, string][] = [['', ''], [')', '\u0313'], ['(', '\u0314']];
  const ACCENTS: [string, string][] = [['', ''], ['/', '\u0301'], ['\\', '\u0300'], ['=', '\u0342']];
  const SUBS: [string, string][] = [['', ''], ['|', '\u0345']];
  const COMBOS = BREATHS.flatMap(([b, bm]) => ACCENTS.flatMap(([a, am]) => SUBS.map(([s, sm]) =>
    [b + a + s, bm + am + sm] as [string, string])));
  it.each(COMBOS)('composes a%s in either order of marks and as a capital', (beta, marks) => {
    const lower = ('α' + marks).normalize('NFC');
    const upper = ('Α' + marks).normalize('NFC');
    expect(betaToGreek(`a${beta}`)).toBe(lower);
    expect(betaToGreek(`*${beta}a`)).toBe(upper);
    expect([...lower].length).toBe(1);
    expect(upper).not.toContain('Ι');
    expect(upper).not.toContain('|');
  });

  it('keeps a capital with iota subscript as one letter', () => {
    // String#toUpperCase on the composed form expands ᾅ to "ἍΙ" — a capital
    // iota in the middle of the word.
    expect(betaToGreek('*(/|adhs')).toBe('ᾍδης');
    expect(betaToGreek('*)/|adhs')).toBe('ᾌδης');
    expect(betaToGreek('*|a')).toBe('ᾼ');
  });

  it('composes diaeresis with an accent', () => {
    expect(betaToGreek('i+/')).toBe('ΐ');
    expect(betaToGreek('u+\\')).toBe('ῢ');
  });

  it('leaves strings without Beta Code letters untouched', () => {
    expect(betaToGreek('λόγος 123 !?')).toBe('λόγος 123 !?');
  });
});
