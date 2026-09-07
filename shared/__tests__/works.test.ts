import { describe, expect, it, vi } from 'vitest';
import { WORKS, bookLabel, furtherReading, getWork, inPrintHref, isBookless, visibleTranslations, workLanding, workPath } from '../lib/works';

describe('works registry helpers', () => {
  it('looks up works and normalizes book labels and paths', () => {
    const en = getWork('EN');
    expect(en?.title).toBe('Nicomachean Ethics');
    expect(en && bookLabel(en, 1)).toBe('I');
    expect(en && bookLabel(en, 99)).toBe('99');
    expect(workPath('EN', 99)).toBe('/EN/book/10');
    expect(workPath('EN', -3)).toBe('/EN/book/1');
    expect(workLanding('EN')).toBe('/EN');
  });

  it('reports bookless works and visible translations', () => {
    const cat = getWork('Cat');
    expect(cat && isBookless(cat)).toBe(true);
    expect(cat && visibleTranslations(cat).every((t) => !t.private)).toBe(true);
    expect(WORKS.length).toBeGreaterThan(10);
  });

  it('adds runtime extra translations without mutating the registry entry', () => {
    const en = getWork('EN')!;
    (globalThis as { __ARISTOTLE_EXTRA_TRANSLATIONS__?: unknown }).__ARISTOTLE_EXTRA_TRANSLATIONS__ = {
      EN: [{ id: 'mine', name: 'Local Import', short: 'Local', slot: 'overlay' }],
    };
    expect(visibleTranslations(en).map((t) => t.id)).toContain('mine');
    delete (globalThis as { __ARISTOTLE_EXTRA_TRANSLATIONS__?: unknown }).__ARISTOTLE_EXTRA_TRANSLATIONS__;
  });

  // The leak invariant. The public deploy is built with PUBLIC_SHOW_PRIVATE
  // unset, and the registry is what every picker, citation strip and search
  // index is driven from: a gated id present here would name a translation
  // the site cannot host. The test environment leaves the flag unset too, so
  // this is the registry the site ships.
  it('carries no copyright-gated translation when PUBLIC_SHOW_PRIVATE is unset', () => {
    expect(import.meta.env.PUBLIC_SHOW_PRIVATE).not.toBe('1');
    const GATED = new Set(['ackrill', 'tredennick', 'irwin']);
    for (const w of WORKS) {
      const ids = w.translations.map((t) => t.id);
      for (const id of ids) expect(GATED.has(id), `${w.id} carries ${id}`).toBe(false);
      for (const t of w.translations) expect(t.private, `${w.id}/${t.id} is private`).toBeFalsy();
      // Rackham is public domain for the NE (Loeb 1926) but not for the EE
      // (1935) or the Politics.
      if (w.id === 'EE' || w.id === 'Pol') expect(ids).not.toContain('rackham');
      expect(visibleTranslations(w).every((t) => !t.private)).toBe(true);
    }
  });

  it('carries the gated translations only when a build opts in', async () => {
    // A fresh module instance (the query string defeats the module cache —
    // never vi.resetModules, see CLAUDE.md) evaluated with the flag set.
    vi.stubEnv('PUBLIC_SHOW_PRIVATE', '1');
    try {
      const spec = '../lib/works?show-private';
      const gated = (await import(/* @vite-ignore */ spec)) as typeof import('../lib/works');
      const ids = (id: string) => gated.getWork(id)!.translations.map((t) => t.id);
      expect(ids('Cat')).toContain('ackrill');
      expect(ids('Int')).toContain('ackrill');
      expect(ids('EE')).toContain('rackham');
      expect(gated.getWork('EE')!.translations.find((t) => t.id === 'rackham')!.private).toBe(true);
      expect(gated.visibleTranslations(gated.getWork('EE')!).map((t) => t.id)).toContain('rackham');
    } finally {
      vi.unstubAllEnvs();
    }
    // The registry this file imported is untouched.
    expect(getWork('EE')!.translations.map((t) => t.id)).not.toContain('rackham');
  });

  it('routes a bookless work to book 1 whatever book is asked for', () => {
    const int = getWork('Int')!;
    expect(isBookless(int)).toBe(true);
    expect(workPath('Int')).toBe('/Int/book/1');
    expect(workPath('Int', 3)).toBe('/Int/book/1');
    expect(workPath('Int', 0)).toBe('/Int/book/1');
    expect(workPath('Int', NaN)).toBe('/Int/book/1');
    expect(workLanding('Int')).toBe('/Int');
    // An unknown work is passed through rather than thrown on.
    expect(getWork('Nope')).toBeUndefined();
    expect(workPath('Nope', 2)).toBe('/Nope/book/2');
  });

  it('creates stable in-print links from curated metadata', () => {
    const item = furtherReading('EN')[0];
    expect(item.cite).toContain('Nicomachean Ethics');
    expect(inPrintHref({ kind: 'translation', cite: 'A <em>Book</em> & commentary' })).toBe(
      'https://www.google.com/search?tbm=bks&q=A%20Book%20%26%20commentary',
    );
  });
});
