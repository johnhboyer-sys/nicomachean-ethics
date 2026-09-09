import { describe, expect, it } from 'vitest';
import { parseRouteHref } from '../lib/route-href';

describe('parseRouteHref', () => {
  it('maps a lemma href, including a trailing slash', () => {
    expect(parseRouteHref('/lemma/logos/')).toEqual({ kind: 'lemma', slug: 'logos' });
    expect(parseRouteHref('/lemma/%CE%BB%CE%BF%CE%B3%CE%BF%CF%82')).toEqual({
      kind: 'lemma',
      slug: 'λογος',
    });
  });

  it('maps a reader href with loc / highlight / hash', () => {
    expect(parseRouteHref('/EN/book/2?loc=1103a:14')).toEqual({
      kind: 'reader',
      work: 'EN',
      book: 2,
      params: { loc: '1103a:14' },
    });
    expect(parseRouteHref('/EN/book/2#1103a')).toEqual({
      kind: 'reader',
      work: 'EN',
      book: 2,
      params: { hash: '1103a' },
    });
    expect(parseRouteHref('/Cat/book/1?hlg=ousia&hle=substance#1a')).toEqual({
      kind: 'reader',
      work: 'Cat',
      book: 1,
      params: { hlg: 'ousia', hle: 'substance', hash: '1a' },
    });
  });

  it('maps a search href to its query string', () => {
    expect(parseRouteHref('/search?g=%E1%BC%80%CF%81%CE%B5%CF%84%CE%AE')).toEqual({
      kind: 'search',
      query: 'g=%E1%BC%80%CF%81%CE%B5%CF%84%CE%AE',
    });
    expect(parseRouteHref('/search?e=happiness')).toEqual({
      kind: 'search',
      query: 'e=happiness',
    });
    expect(parseRouteHref('/search')).toEqual({ kind: 'search', query: '' });
  });

  it('rewrites /advanced to the live site, keeping the hash', () => {
    expect(parseRouteHref('/advanced#phrases')).toEqual({
      kind: 'external',
      url: 'https://johnhboyer-sys.github.io/aristotle-reader/advanced#phrases',
    });
    expect(parseRouteHref('/advanced')).toEqual({
      kind: 'external',
      url: 'https://johnhboyer-sys.github.io/aristotle-reader/advanced',
    });
  });

  it('leaves in-page hashes and blob/data URLs alone', () => {
    expect(parseRouteHref('#1103a')).toEqual({ kind: 'passthrough' });
    expect(parseRouteHref('blob:https://desktop.local/abc')).toEqual({ kind: 'passthrough' });
    expect(parseRouteHref('data:text/csv,foo')).toEqual({ kind: 'passthrough' });
  });

  it('treats http(s) as an external URL and other relative paths as swallow', () => {
    expect(parseRouteHref('https://example.com/x')).toEqual({
      kind: 'external',
      url: 'https://example.com/x',
    });
    expect(parseRouteHref('http://example.com/x')).toEqual({
      kind: 'external',
      url: 'http://example.com/x',
    });
    expect(parseRouteHref('/glossary')).toEqual({ kind: 'swallow' });
    expect(parseRouteHref('')).toEqual({ kind: 'swallow' });
  });

  it('never throws on a malformed percent-escape — a throw here lets the webview follow the link natively', () => {
    expect(() => parseRouteHref('/lemma/%E0%A4')).not.toThrow();
    expect(parseRouteHref('/lemma/%E0%A4')).toEqual({ kind: 'lemma', slug: '%E0%A4' });
    expect(() => parseRouteHref('/EN/book/2#%E0')).not.toThrow();
    expect(parseRouteHref('/EN/book/2#%E0')).toEqual({ kind: 'reader', work: 'EN', book: 2, params: { hash: '%E0' } });
  });
});
