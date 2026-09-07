// app/src/lib/html.ts is a one-line re-export: the site's ~10 `../lib/html`
// importers get the sanitizer from shared/. shared/__tests__/sanitizer.test.ts
// owns the implementation; these pin the APP's seam — that the re-export still
// points at a real sanitizer and was not, say, quietly replaced by an identity
// function or a `.raw` variant during a refactor of shared/.
import { describe, expect, it } from 'vitest';
import * as appHtml from '../lib/html';
import { sanitizeHtml } from '../lib/html';
import { sanitizeHtml as sharedSanitizeHtml } from '@shared/lib/html';

describe('the app entry point for HTML sanitising', () => {
  it('is the shared sanitizer itself, not a copy that can drift', () => {
    expect(sanitizeHtml).toBe(sharedSanitizeHtml);
  });

  // The module deliberately exports the sanitizer and nothing else: since
  // 2026-09-03 the /lemma pages mount grammata's T8 entry at runtime rather
  // than rendering the LSJ shards, so no other helper should reappear here
  // without a decision.
  it('exports the sanitizer and nothing else', () => {
    expect(Object.keys(appHtml)).toEqual(['sanitizeHtml']);
  });

  it('strips a javascript: href, keeping the link text', () => {
    expect(sanitizeHtml('<a href="javascript:alert(1)">click</a>')).toBe('<a>click</a>');
  });

  it('strips a javascript: href however it is spelled or padded', () => {
    for (const href of ['JavaScript:alert(1)', '  javascript:alert(1)', 'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==']) {
      expect(sanitizeHtml(`<a href="${href}">click</a>`), href).toBe('<a>click</a>');
    }
  });

  it('keeps a safe relative href — the footnote back-links depend on it', () => {
    expect(sanitizeHtml('<a href="/EN/book/1?loc=1094a:5">EN 1094a5</a>'))
      .toBe('<a href="/EN/book/1?loc=1094a:5">EN 1094a5</a>');
  });

  // An OCR'd footnote can end mid-tag. The `<` must come back escaped: left
  // raw it would swallow the rest of the popup as attribute soup, and a
  // sanitizer that "fixes" it by completing the tag would be inventing an
  // element — here, one that fetches a script. The URL survives, but only as
  // the inert text it always was.
  it('escapes an unterminated tag instead of completing it', () => {
    const out = sanitizeHtml('Aristotle says a <script src="http://evil.test/x.js"');

    expect(out).toBe('Aristotle says a &lt;script src="http://evil.test/x.js"');
    expect(out).not.toContain('<script');
    expect(out).not.toMatch(/<[a-z]/i);   // no element at all came out of it
  });

  it('escapes a bare stray < in prose', () => {
    expect(sanitizeHtml('a < b')).toBe('a &lt; b');
  });
});
