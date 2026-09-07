// jsonLdSafe feeds `<script type="application/ld+json" set:html={...}>` on the
// home page, every work landing, every reading page and every lemma page. The
// values interpolated into it are corpus data — work titles, translator names,
// LSJ glosses — so an escape that stops working is an XSS on every page at once.
// Two properties matter and are tested here as properties, not as spellings:
//   (a) the emitted string can never close, or open, a script element;
//   (b) it is still JSON, so what a crawler parses is what we meant.
import { describe, expect, it } from 'vitest';
import { jsonLdSafe } from '../lib/jsonld';

const roundTrip = (value: unknown) => JSON.parse(jsonLdSafe(value));

describe('jsonLdSafe', () => {
  it('cannot close the script element it is written into', () => {
    const title = 'On the Heavens</script><script>alert(1)</script>';
    const out = jsonLdSafe({ name: title });

    expect(out).not.toContain('</script>');
    expect(out).not.toContain('<script');
    expect(out).not.toContain('<');
    expect(out).not.toContain('>');
    expect(roundTrip({ name: title }).name).toBe(title);
  });

  it('escapes < and > wherever they occur, not only in a </script>', () => {
    const out = jsonLdSafe({ blurb: 'a < b > c <b>bold</b>' });

    expect(out).toContain('\\u003C');
    expect(out).toContain('\\u003E');
    expect(out).not.toMatch(/[<>]/);
    expect(roundTrip({ blurb: 'a < b > c <b>bold</b>' }).blurb).toBe('a < b > c <b>bold</b>');
  });

  // U+2028/U+2029 are valid in a JSON string but terminate a line in a
  // JavaScript source text, so an unescaped one inside an inline <script> is a
  // syntax error that takes the whole structured-data block down silently.
  it('escapes U+2028 and U+2029, which are legal JSON but illegal in a script', () => {
    const value = 'line\u2028break\u2029here';
    const out = jsonLdSafe({ description: value });

    expect(out).toContain('\\u2028');
    expect(out).toContain('\\u2029');
    expect(out).not.toContain('\u2028');
    expect(out).not.toContain('\u2029');
    expect(roundTrip({ description: value }).description).toBe(value);
  });

  // Ampersands and quotes are the everyday case: "Greek & English" is in the
  // site name, and translator entries carry quotes and apostrophes.
  it('escapes an ampersand and keeps quotes parseable', () => {
    const value = 'Greek & English — Ross\'s "Metaphysics"';
    const out = jsonLdSafe({ name: value });

    expect(out).toContain('\\u0026');
    expect(out).not.toContain('&');
    expect(roundTrip({ name: value }).name).toBe(value);
  });

  it('round-trips a whole nested Book record unchanged', () => {
    const record = {
      '@context': 'https://schema.org',
      '@type': 'Book',
      name: 'Περὶ ψυχῆς </script>',
      author: { '@type': 'Person', name: 'Aristotle' },
      translator: [{ '@type': 'Person', name: 'W. S. Hett' }],
      inLanguage: ['grc', 'en'],
      numberOfPages: 30,
    };

    expect(roundTrip(record)).toEqual(record);
    expect(jsonLdSafe(record)).not.toMatch(/[<>&]/);
  });

  it('leaves the JSON structure itself intact — no key or bracket is mangled', () => {
    expect(jsonLdSafe({ a: [1, 2], b: null })).toBe('{"a":[1,2],"b":null}');
  });
});
