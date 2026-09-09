// Accessibility invariants on Astro markup the site build cannot check here
// (the corpus is machine-local, so `astro build` does not run in CI). These
// read the component source: cheap, and they fail the moment the rule is
// undone. The reader is vision-impaired and reads on a phone in landscape,
// so nothing that carries a work title may truncate, nothing in the reading
// column may shrink below 1rem, every icon-only control must say what it is,
// and keyboard focus must never land in a drawer that is closed and aria-hidden.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// vitest runs from app/ (see package.json); under happy-dom import.meta.url is
// an http URL, so resolve from the project root rather than from this file.
const src = (rel: string) => readFileSync(path.resolve('src/components', rel), 'utf8');
const read = (rel: string) => readFileSync(path.resolve(rel), 'utf8');

// The CSS declarations of one rule in a component's <style>.
function rule(css: string, selector: string): string {
  const i = css.indexOf(`${selector} {`);
  expect(i, `rule ${selector}`).toBeGreaterThanOrEqual(0);
  return css.slice(i, css.indexOf('}', i));
}

// Every flat CSS rule in a file, as [selectorList, declarations]. Rules nested
// in @media come out too (the wrapper itself has no declarations of its own and
// is skipped), which is the point: a truncation rule hidden in a phone-only
// media query is exactly the regression these tests exist to catch.
function cssRules(source: string): [string, string][] {
  return [...source.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map((m) => [m[1].trim(), m[2]] as [string, string])
    .filter(([sel]) => !sel.startsWith('@'));
}

// ── 1. Nothing that carries a name may be cut off ──────────────────────────
// Ellipsis truncation costs this reader the end of the word, and the end of a
// Greek word is where its grammar is. A work title cut to "De Generatione et…"
// is unidentifiable; a headword cut to "ἀρετ…" is a different word.
describe('titles, headwords and reading text never truncate', () => {
  // class → the file whose <style> owns it. Listed by hand so that renaming a
  // class without revisiting this rule fails loudly rather than passing vacuously.
  const NAMED: [string, string][] = [
    ['work-name', 'src/pages/index.astro'],        // a work title on the home grid
    ['fb-name', 'src/components/LemmaPage.astro'], // a work title in frequency-by-work
    ['lx-head-gk', 'src/components/LemmaPage.astro'], // the lemma headword
    ['lxi-gk', 'src/pages/lemma/index.astro'],     // a headword in the lexicon grid
    ['lp-title', 'src/components/Landing.astro'],  // the work title on its landing page
  ];

  for (const [cls, file] of NAMED) {
    it(`.${cls} (${path.basename(file)}) is never clipped or held to one line`, () => {
      const rules = cssRules(read(file)).filter(([sel]) =>
        new RegExp(`\\.${cls}(?![\\w-])`).test(sel));

      expect(rules.length, `no rule styles .${cls} — was it renamed?`).toBeGreaterThan(0);
      for (const [sel, decls] of rules) {
        expect(decls, sel).not.toMatch(/text-overflow/);
        expect(decls, sel).not.toMatch(/white-space:\s*nowrap/);
      }
    });
  }

  it('never truncates a work title with an ellipsis (frequency-by-work rows)', () => {
    const fbName = rule(src('LemmaPage.astro'), '.fb-name');
    // "De Generatione et Corruptione" is wider than the 12rem name column on a
    // phone; nowrap + hidden + ellipsis cut it to "De Generatione et…".
    expect(fbName).not.toMatch(/text-overflow/);
    expect(fbName).not.toMatch(/white-space:\s*nowrap/);
    // The row is a grid, so a two-line title just makes its row taller.
    expect(fbName).toMatch(/overflow-wrap:\s*anywhere/);
  });
});

// ── 2. The reading column's type size ──────────────────────────────────────
describe('the reading text keeps its size', () => {
  const globalCss = read('../shared/styles/global.css');

  // The Greek and English columns size off two custom properties. Wherever
  // those are (re)declared — including the ≤680px phone block, which trades a
  // notch of size for two columns at 390px — they must not fall below 1rem.
  it('never declares --fs-greek or --fs-english below 1rem', () => {
    const declarations = [...globalCss.matchAll(/--fs-(greek|english):\s*([\d.]+)rem/g)];

    expect(declarations.length, 'the reader type tokens went missing').toBeGreaterThanOrEqual(2);
    for (const [, which, size] of declarations) {
      expect(Number(size), `--fs-${which}: ${size}rem`).toBeGreaterThanOrEqual(1);
    }
  });

  // A landscape phone has 932px of width and no column squeeze, so the block
  // that strips the reader's furniture there deliberately leaves type alone.
  it('the landscape-phone block strips furniture, never type size', () => {
    const start = globalCss.indexOf('@media (orientation: landscape) and (max-height: 500px)');
    expect(start).toBeGreaterThan(0);
    const block = globalCss.slice(start, globalCss.indexOf('\n}\n', start));

    expect(block).not.toMatch(/--fs-(greek|english)\s*:/);
    expect(block).not.toMatch(/\.(greek|english)-col[^{}]*\{[^{}]*font-size/);
  });
});

// ── 3. Every icon-only control says what it is ─────────────────────────────
const SOURCE_FILES = [
  'src/components/Landing.astro', 'src/components/LemmaPage.astro',
  'src/components/ReaderShell.astro', 'src/components/ThemeToggle.astro',
  'src/components/HelpButton.svelte', 'src/components/WorkSwitcher.svelte',
  'src/pages/index.astro', 'src/pages/advanced.astro', 'src/pages/search.astro',
  'src/pages/phrases.astro', 'src/pages/support.astro', 'src/pages/attribution.astro',
  'src/pages/desktop.astro', 'src/pages/404.astro', 'src/pages/lemma/index.astro',
  'src/pages/EN/glossary.astro',
];

// What a sighted reader can see in an element: icons are aria-hidden or <svg>,
// and everything else that is left after stripping tags is visible text.
const visibleText = (html: string) =>
  html
    .replace(/<svg[\s\S]*?<\/svg>/g, '')
    .replace(/<(\w+)[^>]*aria-hidden=["']true["'][^>]*>[\s\S]*?<\/\1>/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/&\w+;/g, 'x')
    .trim();

describe('icon-only controls carry an accessible name', () => {
  for (const file of SOURCE_FILES) {
    const source = read(file);
    const buttons = [...source.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].map((m) => m[0]);
    if (!buttons.length) continue;

    it(`every icon-only <button> in ${path.basename(file)} has an aria-label`, () => {
      for (const button of buttons) {
        if (visibleText(button.replace(/^<button\b[^>]*>/, '').replace(/<\/button>$/, ''))) continue;
        expect(button, 'icon-only button with no accessible name')
          .toMatch(/aria-label=/);
      }
    });
  }

  it('the work switcher, whose only label is its own selected option, is labelled', () => {
    expect(src('WorkSwitcher.svelte')).toMatch(/<select[^>]*aria-label=/);
  });
});

// A control whose accessible name comes only from a text span that CSS hides on
// a phone has NO name on a phone. global.css sets `display: none` on each of
// these in the ≤680px block and again in the landscape block, so the element
// that carries one must name itself with aria-label.
describe('controls whose label text is hidden on a phone name themselves', () => {
  const HIDDEN_ON_PHONE = ['toc-toggle-text', 'hs-text', 'hsup-text', 'settings-text'];
  const globalCss = read('../shared/styles/global.css');

  it('those label spans really are hidden on a phone (the premise of this rule)', () => {
    const phone = globalCss.slice(globalCss.indexOf('@media (max-width: 680px)'));
    for (const cls of HIDDEN_ON_PHONE) {
      expect(phone, cls).toMatch(new RegExp(`\\.${cls}[^{}]*\\{[^{}]*display:\\s*none`));
    }
  });

  it('every control carrying one of them has an aria-label', () => {
    const shell = src('ReaderShell.astro');
    const elements = [...shell.matchAll(/<(button|a)\b[^>]*>[\s\S]*?<\/\1>/g)].map((m) => m[0]);
    const carriers = elements.filter((el) =>
      HIDDEN_ON_PHONE.some((cls) => el.includes(`class="${cls}"`)));

    // Every one of them is still on a control (.hs-text is on two: Search and
    // Lexicon), so a class dropped from the markup fails here rather than
    // quietly making this rule vacuous.
    for (const cls of HIDDEN_ON_PHONE) {
      expect(carriers.filter((el) => el.includes(`class="${cls}"`)).length, cls)
        .toBeGreaterThan(0);
    }
    for (const el of carriers) {
      expect(el.slice(0, el.indexOf('>')), 'label text is hidden on a phone and no aria-label')
        .toMatch(/aria-label=/);
    }
  });
});

// ── 4. Bypass blocks ───────────────────────────────────────────────────────
describe('the reader page can be skipped into', () => {
  const shell = src('ReaderShell.astro');

  it('offers a skip link before anything else focusable', () => {
    const body = shell.slice(shell.indexOf('<body'));
    const skip = body.match(/<a class="skip-to-text" href="#([\w-]+)">([^<]+)<\/a>/);

    expect(skip, 'no skip link in the reader shell').not.toBeNull();
    expect(skip![2].trim()).toBeTruthy();
    // Nothing focusable may precede it: it is the first tab stop or it is useless.
    const before = body.slice(0, body.indexOf(skip![0]));
    expect(before).not.toMatch(/<(a|button|input|select|textarea)\b/);
  });

  it('points at a target that exists on the page', () => {
    const target = shell.match(/<a class="skip-to-text" href="#([\w-]+)">/)![1];

    expect(shell).toMatch(new RegExp(`id="${target}"`));
    // Not a natural tab stop, but focusable as a link target so the next Tab
    // continues from the text rather than from the top of the document.
    expect(shell).toMatch(new RegExp(`id="${target}"[^>]*tabindex="-1"`));
  });

  it('keeps the skip link visible once focused', () => {
    // `.sr-only` clips its element unconditionally, so a skip link built on it
    // is announced but never seen — no use to a sighted keyboard user.
    expect(shell).not.toMatch(/class="skip-to-text[^"]*sr-only/);
    expect(shell).toMatch(/\.skip-to-text:focus\s*\{[^}]*top:/);
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
