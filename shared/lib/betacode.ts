// -- Beta Code → Unicode (polytonic) Greek --------------------------------
//
// Morphology lemmas (analyses.json) are stored in TLG Beta Code, e.g.
// "*eu)rw/phs" → "Εὐρώπης". The reader normally shows the pre-converted
// Unicode LSJ headword instead, but when a parse has no matching LSJ entry it
// must fall back to the raw lemma — which has to be converted here so it never
// surfaces as Beta Code.
//
// Conventions handled (Morpheus/TLG output):
//   *       capital marker — diacritics for a capital come BETWEEN * and the
//           letter (e.g. "*)a" = Ἀ); for lowercase they follow it ("a)" = ἀ).
//   )       smooth breathing      (       rough breathing
//   /       acute       \  grave       =  circumflex
//   |       iota subscript        +      diaeresis
//   s       sigma, rendered as final ς at word end, else σ
//   trailing 1-9  LSJ homograph/sense markers (e.g. "le/gw1") — dropped

const LETTER: Record<string, string> = {
  a:'α', b:'β', g:'γ', d:'δ', e:'ε', z:'ζ', h:'η', q:'θ', i:'ι', k:'κ',
  l:'λ', m:'μ', n:'ν', c:'ξ', o:'ο', p:'π', r:'ρ', s:'σ', t:'τ', u:'υ',
  f:'φ', x:'χ', y:'ψ', w:'ω', v:'ϝ',
};

// Beta diacritic → combining mark. Diaeresis and breathing share the same
// slot (a vowel never carries both); accent follows; iota subscript last —
// this order matches the NFD of precomposed forms so NFC recomposes cleanly.
const BREATH: Record<string, string> = { ')':'̓', '(':'̔', '+':'̈' };
const ACCENT: Record<string, string> = { '/':'́', '\\':'̀', '=':'͂' };
const SUBSCRIPT = 'ͅ';

const DIAC = ')(+/\\=|';

function isLetterEnd(s: string, i: number): boolean {
  // True if the char at i does not continue the current word (so a sigma here
  // is word-final). Diacritics keep the word going; letters do too.
  if (i >= s.length) return true;
  const c = s[i];
  return !(c.toLowerCase() in LETTER) && !DIAC.includes(c);
}

export function betaToGreek(input: string): string {
  // Nothing to do for strings without Beta Code markers.
  if (!/[a-zA-Z*]/.test(input)) return input;

  const out: string[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];

    if (ch === '*') {
      // Capital: optional leading diacritics, then the base letter.
      i++;
      let breath = '', accent = '', sub = '';
      while (i < input.length && DIAC.includes(input[i])) {
        const d = input[i];
        if (d in BREATH) breath = BREATH[d];
        else if (d in ACCENT) accent = ACCENT[d];
        else if (d === '|') sub = SUBSCRIPT;
        i++;
      }
      const base = LETTER[(input[i] ?? '').toLowerCase()];
      if (base) {
        i++;
        // Capital sigma is always Σ, so no final-form handling needed.
        // Uppercase the BASE letter, then compose. Uppercasing the composed
        // string instead put "*(/|a" (ᾍ) through String#toUpperCase, whose full
        // case mapping expands an iota subscript into a separate capital iota:
        // "ἍΙδης" for ᾍδης, a capital Ι in the middle of the word.
        out.push((base.toUpperCase() + breath + accent + sub).normalize('NFC'));
      }
      continue;
    }

    const base = LETTER[ch.toLowerCase()];
    if (base) {
      i++;
      let breath = '', accent = '', sub = '';
      while (i < input.length && DIAC.includes(input[i])) {
        const d = input[i];
        if (d in BREATH) breath = BREATH[d];
        else if (d in ACCENT) accent = ACCENT[d];
        else if (d === '|') sub = SUBSCRIPT;
        i++;
      }
      // Sigma takes its final form ς at word end (a trailing homograph digit
      // counts as the end), medial σ otherwise.
      const letter = base === 'σ' && isLetterEnd(input, i) ? 'ς' : base;
      out.push((letter + breath + accent + sub).normalize('NFC'));
      continue;
    }

    // Drop standalone homograph/sense digits ("le/gw1"); pass through the rest
    // (spaces, punctuation, etc.) unchanged.
    if (!/[1-9]/.test(ch)) out.push(ch);
    i++;
  }
  return out.join('');
}
