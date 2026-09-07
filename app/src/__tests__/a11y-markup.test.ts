// Accessibility invariants on Astro markup the site build cannot check here
// (the corpus is machine-local, so `astro build` does not run in CI). These
// read the component source: cheap, and they fail the moment the rule is
// undone. The reader is vision-impaired and reads on a phone in landscape,
// so nothing that carries a work title may truncate, and keyboard focus must
// never land in a drawer that is closed and aria-hidden.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// vitest runs from app/ (see package.json); under happy-dom import.meta.url is
// an http URL, so resolve from the project root rather than from this file.
const src = (rel: string) => readFileSync(path.resolve('src/components', rel), 'utf8');

// The CSS declarations of one rule in a component's <style>.
function rule(css: string, selector: string): string {
  const i = css.indexOf(`${selector} {`);
  expect(i, `rule ${selector}`).toBeGreaterThanOrEqual(0);
  return css.slice(i, css.indexOf('}', i));
}

describe('LemmaPage frequency-by-work rows', () => {
  it('never truncate a work title with an ellipsis', () => {
    const fbName = rule(src('LemmaPage.astro'), '.fb-name');
    // "De Generatione et Corruptione" is wider than the 12rem name column on a
    // phone; nowrap + hidden + ellipsis cut it to "De Generatione et…".
    expect(fbName).not.toMatch(/text-overflow/);
    expect(fbName).not.toMatch(/white-space:\s*nowrap/);
  });
});

describe('ReaderShell contents drawer', () => {
  const shell = src('ReaderShell.astro');

  it('is inert while closed, so its off-screen links are not tab stops', () => {
    const aside = shell.match(/<aside class="toc-sidebar"[^>]*>/)?.[0] ?? '';
    expect(aside).toContain('aria-hidden="true"');
    expect(aside).toMatch(/\binert\b/);
  });

  it('toggles inert together with aria-hidden when the drawer opens and closes', () => {
    const setToc = shell.slice(shell.indexOf('const setToc'), shell.indexOf('};', shell.indexOf('const setToc')));
    expect(setToc).toMatch(/inert = !open/);
  });
});
