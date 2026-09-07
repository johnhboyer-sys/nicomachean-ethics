// LSJ entries are the one place in the corpus where the markup carries an
// ARGUMENT: LSJ's A → I → 1 → a hierarchy is how the lexicon divides a word's
// senses. Until 2026-08-19 the sanitizer dropped every <div>, so the hierarchy
// never reached the page — the stylesheet's .lsj-sense rules had nothing to
// match and entries rendered as one wall of prose. These lock the structure in.
import { describe, expect, it } from 'vitest';
import {
  buildFormsBlock,
  markEntryParts,
  outlineLsjSenses,
  stampSenseDepth,
  prefixLsjCitationHrefs,
  renderLsjEntry,
  sanitizeHtml,
} from '../lib/html';

// The shape stage5_lsj.py emits (nested senses, sense number in a leading <b>).
const ENTRY = [
  '<b class="lsj-head">λόγος</b>, <span class="lsj-gen">ὁ</span>, ',
  '<div class="lsj-sense" data-level="1"><b class="lsj-sense-n">A.</b> ',
  'computation, reckoning ',
  '<div class="lsj-sense" data-level="2"><b class="lsj-sense-n">I.</b> ',
  'account of money handled ',
  '<div class="lsj-sense" data-level="3"><b class="lsj-sense-n">2.</b> ',
  'generally, <i>account</i> ',
  '<a class="lsj-bibl" href="/EN/book/1?loc=1094a:5">1094a5</a>',
  '</div></div></div>',
  '<div class="lsj-sense" data-level="1"><b class="lsj-sense-n">B.</b> ',
  'relation, correspondence &amp; proportion</div>',
  '<div class="lsj-sense" data-level="1"><b class="lsj-sense-n">C.</b> ',
  'explanation</div>',
].join('');

describe('sanitizeHtml on LSJ sense structure', () => {
  it('keeps the sense divs and their depth', () => {
    const out = sanitizeHtml(ENTRY);
    // The sanitizer alone: data-depth is stamped later, by renderLsjEntry.
    expect(out).toContain('<div class="lsj-sense" data-level="1">');
    expect(out).toContain('<div class="lsj-sense" data-level="3">');
    // Nesting survives: three opens before the first close.
    expect(out.indexOf('data-level="3"')).toBeLessThan(out.indexOf('</div>'));
    expect(out.match(/<\/div>/g)).toHaveLength(5);
  });

  it('accepts data-level only as a small integer', () => {
    expect(sanitizeHtml('<div data-level="12">x</div>')).toBe('<div data-level="12">x</div>');
    for (const bad of ['foo', '', '123', '-1', '1 2', '1;background:red']) {
      expect(sanitizeHtml(`<div data-level="${bad}">x</div>`)).toBe('<div>x</div>');
    }
    // A quote closed early inside the value cannot smuggle a second attribute:
    // the parser sees data-level="1" and a separate onload, which is dropped.
    expect(sanitizeHtml('<div data-level="1"onload="steal()">x</div>'))
      .toBe('<div data-level="1">x</div>');
  });

  it('still refuses script, handlers and other data-* attributes', () => {
    expect(sanitizeHtml('<div onclick="steal()" data-href="/x">x</div>'))
      .toBe('<div>x</div>');
    expect(sanitizeHtml('<div><script>alert(1)</script>ok</div>'))
      .toBe('<div>ok</div>');
  });
});

describe('outlineLsjSenses', () => {
  const sanitized = sanitizeHtml(ENTRY);

  it('lists only the top-level senses, with their numbers', () => {
    const { senses } = outlineLsjSenses(sanitized);
    expect(senses.map((s) => s.n)).toEqual(['A', 'B', 'C']);
  });

  it('labels each sense with its own prose, not its sub-senses', () => {
    const { senses } = outlineLsjSenses(sanitized);
    expect(senses[0].label).toBe('computation, reckoning');
    // Entities are decoded for the plain-text label.
    expect(senses[1].label).toBe('relation, correspondence & proportion');
  });

  it('truncates a long label on a word boundary', () => {
    // Two sections, because one is not a division and gets no list at all.
    const long = sanitizeHtml(
      '<div class="lsj-sense" data-level="1"><b class="lsj-sense-n">A.</b> ' +
      'the word or outward form by which the inward thought is expressed' +
      '</div>' +
      '<div class="lsj-sense" data-level="1"><b class="lsj-sense-n">B.</b> second</div>',
    );
    const { senses } = outlineLsjSenses(long);
    expect(senses[0].label.length).toBeLessThanOrEqual(57);
    expect(senses[0].label).toMatch(/…$/);
    expect(senses[0].label).not.toMatch(/\s…$/);
    expect(long).toContain(senses[0].label.replace('…', '').trim());
  });

  it('stamps a unique anchor id on each top-level sense and nowhere else', () => {
    const { html, senses } = outlineLsjSenses(sanitized);
    expect(senses.map((s) => s.id)).toEqual(['lsj-sense-a', 'lsj-sense-b', 'lsj-sense-c']);
    for (const sense of senses) {
      expect(html).toContain(`<div id="${sense.id}" data-depth="1" class="lsj-sense" data-level="1">`);
    }
    expect(html.match(/ id="/g)).toHaveLength(3);
    // Everything else is byte-identical to the input.
    expect(
      html.replace(/ id="lsj-sense-[a-z0-9-]+"/g, '').replace(/ data-depth="\d"/g, ''),
    ).toBe(sanitized);
  });

  it('never collides ids when two different numbers share an anchor', () => {
    // "A." and "a." are different sections but reduce to the same slug; the
    // second takes a suffix. (A REPEATED number is a different matter: that
    // means the run is not one division, and the list is refused entirely.)
    const { html, senses } = outlineLsjSenses(sanitizeHtml(
      '<div class="lsj-sense" data-level="1"><b class="lsj-sense-n">A.</b> one</div>' +
      '<div class="lsj-sense" data-level="1"><b class="lsj-sense-n">a.</b> two</div>' +
      '<div class="lsj-sense" data-level="1">unnumbered</div>',
    ));
    expect(senses.map((s) => s.id)).toEqual(['lsj-sense-a', 'lsj-sense-a-2']);
    // The unnumbered div is not a section and is left out — δέκα otherwise
    // published eleven blank rows.
    expect(senses.every((sense) => /[A-Za-z0-9]/.test(sense.n))).toBe(true);
    expect(html.match(/ id="/g)).toHaveLength(2);
  });

  it('refuses a list whose numbers repeat', () => {
    const { senses } = outlineLsjSenses(sanitizeHtml(
      '<div class="lsj-sense" data-level="1"><b class="lsj-sense-n">II.</b> one</div>' +
      '<div class="lsj-sense" data-level="1"><b class="lsj-sense-n">II.</b> two</div>' +
      '<div class="lsj-sense" data-level="1"><b class="lsj-sense-n">III.</b> three</div>',
    ));
    expect(senses).toEqual([]);
  });

  it('refuses a list drawn from more than one parent', () => {
    // ἀναιρέω published "II, III, II, III" — two headings' subdivisions run
    // together and labelled the entry's main senses.
    const two = (n: string) =>
      `<div class="lsj-sense" data-level="2"><b class="lsj-sense-n">${n}.</b> t</div>`;
    const { senses } = outlineLsjSenses(sanitizeHtml(
      '<div class="lsj-sense" data-level="1">holder one</div>' + two('II') + two('III') +
      '<div class="lsj-sense" data-level="1">holder two</div>' + two('IV') + two('V'),
    ), 'lsj-sense', 3);
    expect(senses).toEqual([]);
  });

  it('keeps level 0 from displacing the real sections', () => {
    // ὅς and ποιέω open with a level-0 usage note; ranking it pushed their
    // A/B/C down a level and out of the list.
    const out = stampSenseDepth(sanitizeHtml(
      '<div class="lsj-sense" data-level="0"><b class="lsj-sense-n">•</b> usage note</div>' +
      '<div class="lsj-sense" data-level="1"><b class="lsj-sense-n">A.</b> first</div>' +
      '<div class="lsj-sense" data-level="2"><b class="lsj-sense-n">I.</b> under A</div>',
    ));
    expect(out).toContain('<div data-depth="1" class="lsj-sense" data-level="0">');
    expect(out).toContain('<div data-depth="1" class="lsj-sense" data-level="1">');
    expect(out).toContain('<div data-depth="2" class="lsj-sense" data-level="2">');
  });

  it('reads a flat sibling entry the same way as a nested one', () => {
    const { senses } = outlineLsjSenses(sanitizeHtml(
      '<div class="lsj-sense" data-level="1"><b class="lsj-sense-n">A.</b> first</div>' +
      '<div class="lsj-sense" data-level="2"><b class="lsj-sense-n">I.</b> under A</div>' +
      '<div class="lsj-sense" data-level="1"><b class="lsj-sense-n">B.</b> second</div>',
    ));
    expect(senses.map((s) => s.label)).toEqual(['first', 'second']);
  });

  it('returns an entry with no senses untouched', () => {
    const plain = sanitizeHtml('<b class="lsj-head">ἀγαθός</b>, good');
    expect(outlineLsjSenses(plain)).toEqual({ html: plain, senses: [] });
  });

  it('leaves the citation-link rewrite intact in either order', () => {
    const { html } = outlineLsjSenses(sanitized);
    expect(prefixLsjCitationHrefs(html, '/aristotle-reader'))
      .toContain('<a class="lsj-bibl" href="/aristotle-reader/EN/book/1?loc=1094a:5">');
  });
});

// renderLsjEntry is the whole contract a host implements — the site's lemma
// page and word popup, the desktop lexicon, and any sibling reader that copies
// shared/ call this one function and get identical typography. Everything it
// needs to know is in its arguments; nothing about Aristotle is.
describe('renderLsjEntry', () => {
  it('sanitizes, wraps, and keeps the sense hierarchy in one call', () => {
    const out = renderLsjEntry(`${ENTRY}<script>alert(1)</script>`);
    expect(out.startsWith('<div class="lsj-entry">')).toBe(true);
    expect(out.endsWith('</div>')).toBe(true);
    expect(out).toContain('<div data-depth="3" class="lsj-sense" data-level="3">');
    expect(out).not.toContain('alert(1)');
  });

  it('prefixes citation links with the host\'s deploy base', () => {
    expect(renderLsjEntry(ENTRY, { base: '/aristotle-reader' }))
      .toContain('href="/aristotle-reader/EN/book/1?loc=1094a:5"');
    // A host served at the root (the desktop app) passes no base and keeps the
    // shard's own hrefs.
    expect(renderLsjEntry(ENTRY)).toContain('href="/EN/book/1?loc=1094a:5"');
  });

  it('renders nothing at all for a missing or empty entry', () => {
    // The shard lookup for a lemma with no dictionary entry yields undefined;
    // the host's own `{#if}` keys off the empty string this returns.
    for (const empty of ['', '   ', '<script>x</script>', undefined as unknown as string]) {
      expect(renderLsjEntry(empty)).toBe('');
    }
  });

  it('adds the outline only when asked, and only when it earns its place', () => {
    expect(renderLsjEntry(ENTRY)).not.toContain('lsj-outline');
    const withOutline = renderLsjEntry(ENTRY, { outline: true });
    expect(withOutline).toContain('<p class="lsj-outline-label">3 main senses</p>');
    expect(withOutline).toContain('<a href="#lsj-sense-a">');
    // Two senses are a list, not an outline.
    const two = '<div class="lsj-sense" data-level="1"><b class="lsj-sense-n">A.</b> one</div>'
      + '<div class="lsj-sense" data-level="1"><b class="lsj-sense-n">B.</b> two</div>';
    expect(renderLsjEntry(two, { outline: true })).not.toContain('lsj-outline');
    expect(renderLsjEntry(two, { outline: true, outlineMin: 2 })).toContain('lsj-outline');
  });

  it('escapes sense text on its way into the outline', () => {
    const nasty = '<div class="lsj-sense" data-level="1"><b class="lsj-sense-n">A.</b> '
      + 'a &amp; b &lt;script&gt;alert(1)&lt;/script&gt;</div>'
      + '<div class="lsj-sense" data-level="1"><b class="lsj-sense-n">B.</b> two</div>'
      + '<div class="lsj-sense" data-level="1"><b class="lsj-sense-n">C.</b> three</div>';
    const out = renderLsjEntry(nasty, { outline: true });
    expect(out).toContain('a &amp; b &lt;script&gt;alert(1)&lt;/script&gt;');
    expect(out).not.toContain('<script>');
  });

  it('takes the page scale for a reference view and the popup scale by default', () => {
    expect(renderLsjEntry(ENTRY, { scale: 'page' }))
      .toContain('<div class="lsj-entry lsj-entry-page">');
    expect(renderLsjEntry(ENTRY)).toContain('<div class="lsj-entry">');
  });

  it('keeps anchor ids distinct when one view renders several entries', () => {
    const a = renderLsjEntry(ENTRY, { outline: true, idPrefix: 'e1' });
    const b = renderLsjEntry(ENTRY, { outline: true, idPrefix: 'e2' });
    expect(a).toContain('id="e1-a"');
    expect(b).toContain('id="e2-a"');
    expect(a).not.toContain('id="e2-a"');
  });
});

// The deployed shards are a FLAT sibling run and an entry does not have to
// start at level 1: 759 of 14,047 entries do not, λόγος among them. Keying the
// typography and the jump list off the absolute data-level set those entries'
// real sections in sub-sense type and published no jump list for them at all.
describe('an entry that does not start at level 1', () => {
  // λόγος as the shard actually holds it: no level-1 sense, I/II at level 2.
  const LOGOS = [
    '<b class="lsj-head">λόγος</b>, <span class="lsj-gen">ὁ</span>, ',
    '<div class="lsj-sense" data-level="2"><b class="lsj-sense-n">I.</b> computation</div>',
    '<div class="lsj-sense" data-level="3"><b class="lsj-sense-n">2.</b> a sub-sense</div>',
    '<div class="lsj-sense" data-level="4"><b class="lsj-sense-n">b.</b> a leaf</div>',
    '<div class="lsj-sense" data-level="2"><b class="lsj-sense-n">II.</b> relation</div>',
    '<div class="lsj-sense" data-level="2"><b class="lsj-sense-n">III.</b> explanation</div>',
  ].join('');

  it('makes the entry\'s own shallowest level its top level', () => {
    const html = stampSenseDepth(sanitizeHtml(LOGOS));
    // level 2 → depth 1, so I/II/III take the section accent, not sub-sense grey
    expect(html).toContain('<div data-depth="1" class="lsj-sense" data-level="2">');
    expect(html).toContain('<div data-depth="2" class="lsj-sense" data-level="3">');
    expect(html).toContain('<div data-depth="3" class="lsj-sense" data-level="4">');
    expect(html).not.toContain('data-depth="4"');
  });

  it('lists those sections in the jump list', () => {
    const { senses } = outlineLsjSenses(sanitizeHtml(LOGOS), 'lsj-sense', 3);
    expect(senses.map((sense) => sense.n)).toEqual(['I', 'II', 'III']);
  });

  it('renders the jump list through renderLsjEntry', () => {
    const out = renderLsjEntry(LOGOS, { outline: true, scale: 'page' });
    expect(out).toContain('<nav class="lsj-outline"');
    expect(out).toContain('3 main senses');
    // every anchor the list emits is stamped in the same pass
    for (const href of out.match(/href="#([^"]+)"/g) ?? []) {
      expect(out).toContain(`id="${href.slice(7, -1)}"`);
    }
  });

  it('stamps depth on the popup path too, which shows no jump list', () => {
    const out = renderLsjEntry(LOGOS, {});
    expect(out).toContain('data-depth="1"');
    expect(out).not.toContain('<nav class="lsj-outline"');
  });

  it('publishes no blank rows for an entry of unnumbered holders', () => {
    // δέκα: eleven level-1 divs, none of them numbered — eleven empty rows.
    const deka = Array.from({ length: 11 }, (_, i) =>
      `<div class="lsj-sense" data-level="1">compound ${i}</div>`).join('');
    const out = renderLsjEntry(deka, { outline: true });
    expect(out).not.toContain('lsj-outline');
    expect(out).not.toContain('main senses');
  });
});

// Levels skip a rank in 1,836 deployed entries — 1,621 of them run 1 → 3.
// Subtracting the shallowest level left those a step too deep, so this pins
// compression specifically: reverting to subtraction must fail here.
describe('an entry that skips a rank', () => {
  const skipped = (a: number, b: number) =>
    `<div class="lsj-sense" data-level="${a}"><b class="lsj-sense-n">A.</b> top</div>` +
    `<div class="lsj-sense" data-level="${b}"><b class="lsj-sense-n">1.</b> under it</div>`;

  it('gives the child the next depth, not the next level', () => {
    const out = stampSenseDepth(sanitizeHtml(skipped(1, 3)));
    expect(out).toContain('<div data-depth="1" class="lsj-sense" data-level="1">');
    expect(out).toContain('<div data-depth="2" class="lsj-sense" data-level="3">');
    expect(out).not.toContain('data-depth="3"');
  });

  it('compresses a run that starts deep AND skips', () => {
    const out = stampSenseDepth(sanitizeHtml(skipped(3, 5)));
    expect(out).toContain('<div data-depth="1" class="lsj-sense" data-level="3">');
    expect(out).toContain('<div data-depth="2" class="lsj-sense" data-level="5">');
  });

  it('never lets prose suppress stamping for the whole entry', () => {
    // The guard reads each sense tag, not the entry string, so a quotation
    // mentioning the attribute cannot switch depth off.
    const out = stampSenseDepth(sanitizeHtml(
      '<div class="lsj-sense" data-level="1"><b class="lsj-sense-n">A.</b> data-depth="1" as prose</div>' +
      '<div class="lsj-sense" data-level="2"><b class="lsj-sense-n">I.</b> under</div>',
    ));
    // Assert the TAG carries it — the prose contains that text either way, so
    // a bare substring check would pass even with the old whole-string guard.
    expect(out).toContain('<div data-depth="1" class="lsj-sense" data-level="1">');
    expect(out).toContain('<div data-depth="2" class="lsj-sense" data-level="2">');
  });
});

// A depth holding ONE numbered section is not a division. Listing the level
// below it side by side would mix sub-senses from different parents and call
// them the entry's main senses.
describe('choosing which depth the jump list indexes', () => {
  const numbered = (level: number, n: string) =>
    `<div class="lsj-sense" data-level="${level}"><b class="lsj-sense-n">${n}.</b> text</div>`;

  it('does not skip past a real division to list its children', () => {
    const html = numbered(1, 'A') + numbered(2, '1') + numbered(2, '2') +
      numbered(2, '3') + numbered(1, 'B') + numbered(2, '4') + numbered(2, '5');
    const out = renderLsjEntry(html, { outline: true, outlineMin: 3 });
    // A and B are a division but there are only two of them: no list, rather
    // than a list of 1,2,3,4,5 drawn from under both of them.
    expect(out).not.toContain('lsj-outline');
  });

  it('descends when the level above is a single section', () => {
    const html = numbered(1, 'A') + numbered(2, 'I') + numbered(2, 'II') + numbered(2, 'III');
    const { senses } = outlineLsjSenses(sanitizeHtml(html), 'lsj-sense', 3);
    expect(senses.map((sense) => sense.n)).toEqual(['I', 'II', 'III']);
  });
});

// Four rules the deployed dictionary forced, each with the entry that forced it.
describe('a list must be the entry\'s own division', () => {
  const sense = (level: number, n: string | null, text = 'x') =>
    `<div class="lsj-sense" data-level="${level}">` +
    (n === null ? '' : `<b class="lsj-sense-n">${n}.</b> `) + text + '</div>';

  it('refuses a deeper run that has no parent above it (ἄγω)', () => {
    // The level-2 run PRECEDES the only level-1 section, so it shares the root
    // with it. Listing it published I–VII and silently dropped B.
    const html = sense(2, 'I') + sense(2, 'II') + sense(2, 'III') + sense(1, 'B');
    const { senses } = outlineLsjSenses(sanitizeHtml(html), 'lsj-sense', 3);
    expect(senses).toEqual([]);
  });

  it('stops rather than descending when a populated depth fails (εὔσημος)', () => {
    // Depth 2 reads "II, II" — a repeat. Descending published one branch's
    // "2, 3, 4, 5" as the entry's four main senses.
    const html = sense(1, null, 'holder') + sense(2, 'II') +
      sense(3, '2') + sense(3, '3') + sense(3, '4') + sense(3, '5') + sense(2, 'II');
    const { senses } = outlineLsjSenses(sanitizeHtml(html), 'lsj-sense', 3);
    expect(senses).toEqual([]);
  });

  it('refuses a branch that leaves a section above it unlisted (ἆρα)', () => {
    // B is a real top section; a list drawn from under A alone is not the
    // entry's division.
    const html = sense(1, 'A') + sense(2, 'I') + sense(2, 'II') + sense(2, 'III') +
      sense(1, 'B');
    const { senses } = outlineLsjSenses(sanitizeHtml(html), 'lsj-sense', 3);
    expect(senses).toEqual([]);
  });

  it('still lists under a single heading, which IS the whole entry', () => {
    const html = sense(1, 'A') + sense(2, 'I') + sense(2, 'II') + sense(2, 'III');
    const { senses } = outlineLsjSenses(sanitizeHtml(html), 'lsj-sense', 3);
    expect(senses.map((x) => x.n)).toEqual(['I', 'II', 'III']);
  });

  it('counts a Greek capital as a section number (ἑαυτοῦ, ἐάω, ἔαρ)', () => {
    const html = sense(1, '\u0391') + sense(1, '\u0392') + sense(1, '\u0393');
    const { senses } = outlineLsjSenses(sanitizeHtml(html), 'lsj-sense', 3);
    expect(senses.map((x) => x.n)).toEqual(['\u0391', '\u0392', '\u0393']);
  });
});

// The block of forms before the senses is NOT a run of quotations. LSJ writes
// it label-then-form, so breaking before the form stranded every label at the
// end of the line above — worst on the most looked-up words (εἰμί and τίθημι
// carry 69 forms, οἶδα 39).
describe('the block of forms', () => {
  const LEGO =
    '<b class="lsj-head">λέγω</b> (B), <i>pick up,</i> etc.: tenses for signf. I and II, ' +
    '<span class="lsj-tns">fut.</span> <span class="lsj-cit"><span class="lsj-quote">λέξω</span> ' +
    '<span class="lsj-bibl">Od. 24.224</span></span>: <span class="lsj-tns">aor.</span> ' +
    '<span class="lsj-cit"><span class="lsj-quote">ἔλεξα</span> <span class="lsj-bibl">A. Pers. 292</span></span>' +
    '; Ep. <span class="lsj-cit"><span class="lsj-quote">ἐλέγμην</span> <span class="lsj-bibl">Od. 9.335</span></span>';

  const rowsOf = (html: string) =>
    [...html.matchAll(/class="lsj-form-label">([^<]*)<\/span><span class="lsj-form-body">([\s\S]*?)<\/span><\/div>/g)]
      .map((m) => [m[1], m[2].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()]);

  it('keeps a label with the form it introduces', () => {
    const { html, rows } = buildFormsBlock(sanitizeHtml(LEGO));
    expect(rows).toBe(3);
    expect(rowsOf(html)).toEqual([
      ['fut.', 'λέξω Od. 24.224'],
      ['aor.', 'ἔλεξα A. Pers. 292'],
      // "Ep." is bare text in the source, not a tagged label — the rows are cut
      // at the dictionary's own punctuation, which is why this one is caught.
      ['Ep.', 'ἐλέγμην Od. 9.335'],
    ]);
  });

  it('lifts the introducing sentence out of the first label', () => {
    const { html } = buildFormsBlock(sanitizeHtml(LEGO));
    expect(rowsOf(html)[0][0]).toBe('fut.');
    expect(html).toContain('tenses for signf. I and II');
  });

  it('never splits an HTML entity', () => {
    // LSJ marks an editorial supplement with angle brackets, which arrive as
    // &lt;…&gt; — and "&lt;" ends in the same semicolon that separates forms.
    const src = '<b class="lsj-head">φείδομαι</b>: fut. <span class="lsj-cit">' +
      '<span class="lsj-quote">φ&lt;ε&gt;ισθήσομαι</span> <span class="lsj-bibl">PUniv.Giss. 21.6</span></span>';
    const { html } = buildFormsBlock(sanitizeHtml(src));
    expect(html).toContain('φ&lt;ε&gt;ισθήσομαι');
    expect(html).not.toContain('&lt<');
  });

  it('aligns a column only when the labels are short enough to be one', () => {
    const short = (n: string, form: string) =>
      `<span class="lsj-tns">${n}</span> <span class="lsj-cit"><span class="lsj-quote">${form}</span>` +
      ' <span class="lsj-bibl">Il. 1.1</span></span>: ';
    const many = '<b class="lsj-head">x</b>: ' +
      short('fut.', 'α') + short('aor.', 'β') + short('pf.', 'γ') + short('plpf.', 'δ');
    expect(buildFormsBlock(sanitizeHtml(many)).html).toContain('lsj-forms-aligned');

    // Alignment is refused only when MOST of the labels are long — one long
    // label wraps inside the capped column and is not a reason to deny the
    // others their alignment.
    const long = '2 sg. εἶ, Ep. and Ion. εἰς, Aeol. ἔσσι';
    const wordy = '<b class="lsj-head">x</b>: ' + short('fut.', 'α') +
      short(long, 'β') + short(long, 'γ') + short(long, 'δ');
    // εἰμί's "labels" run to half a line; a column built on them is worse than
    // none, so those entries get rows without alignment.
    expect(buildFormsBlock(sanitizeHtml(wordy)).html).not.toContain('lsj-forms-aligned');
  });
});

describe('the definition, and quotations that were not tagged as quotations', () => {
  it('gives a sense its opening gloss as its own part', () => {
    const out = markEntryParts(sanitizeHtml(
      '<div class="lsj-sense" data-level="1"><b class="lsj-sense-n">I.</b> <i>gather, pick up,</i> rest'));
    expect(out).toContain('<span class="lsj-def"><i>gather, pick up,</i></span>');
  });

  it('treats Greek WITH a source as a quotation', () => {
    // 33,430 of these were rendered inline while the .lsj-cit form of the very
    // same thing took its own line — 17,991 senses contain both shapes.
    const out = markEntryParts(sanitizeHtml(
      '<div class="lsj-sense" data-level="1"><span class="lsj-greek">μὴ φῦναι</span> excels the whole ' +
      '<i>account,</i> <span class="lsj-bibl">S. OC 1225</span></div>'));
    expect(out).toContain('class="lsj-greek lsj-quoted"');
  });

  it('leaves Greek with NO source inline, as prose', () => {
    const out = markEntryParts(sanitizeHtml(
      '<div class="lsj-sense" data-level="1">as in <span class="lsj-greek">λόγος</span> and elsewhere</div>'));
    expect(out).not.toContain('lsj-quoted');
  });
});

describe('folding a forms block that has become the entry', () => {
  const bulk = (n: number) => '<b class="lsj-head">x</b>: ' + Array.from({ length: n }, (_, i) =>
    `<span class="lsj-tns">t${i}</span> <span class="lsj-cit"><span class="lsj-quote">φ${i}</span>` +
    ' <span class="lsj-bibl">Il. 1.1</span></span>: ').join('');

  it('folds a long run in the popup', () => {
    expect(renderLsjEntry(bulk(14), {})).toContain('lsj-forms-fold');
  });

  it('never folds on the lemma page, where the reader came for the whole entry', () => {
    expect(renderLsjEntry(bulk(14), { scale: 'page' })).not.toContain('lsj-forms-fold');
  });

  it('leaves a short run unfolded', () => {
    expect(renderLsjEntry(bulk(5), {})).not.toContain('lsj-forms-fold');
  });
});

describe('a headword quantity mark is not the first form', () => {
  const rowsOf = (html: string) =>
    [...html.matchAll(/class="lsj-form-label">([^<]*)<\/span><span class="lsj-form-body">([\s\S]*?)<\/span><\/div>/g)]
      .map((m) => [m[1], m[2].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()]);

  // LSJ writes the mark two ways and both used to open the table on the lemma.
  // Ported from homer-reader 396e159f0; aristotle is upstream for this file, so
  // leaving it unfixed here would revert the fix in homer and plato on the next
  // patch-forward.
  it('keeps the lemma out of the label when the bracket is outside the span', () => {
    // ἀγλαός: "[" + <span class="lsj-greek">ᾱγλᾰ-</span> + "]". The row read
    // label "ἀγλαός [" against body "ᾱγλᾰ-], ή, όν …" — the headword labelling
    // its own quantity. There is no inflected form here at all.
    const { html, rows } = buildFormsBlock(sanitizeHtml(
      '<b class="lsj-head">ἀγλαός</b> [<span class="lsj-greek">ᾱγλᾰ-</span>], ' +
      '<span class="lsj-itype">ή</span>, <span class="lsj-itype">όν</span>, also ' +
      '<span class="lsj-itype">ός</span>, <span class="lsj-itype">όν</span> ' +
      '<span class="lsj-bibl"><span class="lsj-author">Thgn.</span> 985</span>:—'));
    expect(rows).toBe(0);
    expect(html).not.toContain('lsj-form-label');
    // and the sense separator survives, instead of being eaten as label padding
    expect(html).toContain(':—');
  });

  it('opens the table on the first real form when the bracket is inside the span', () => {
    // ἀπατάω: <span class="lsj-greek">[ᾰπ</span>. The mark was the body of row
    // one; the table should start at "impf. ἠπάτων".
    const { html } = buildFormsBlock(sanitizeHtml(
      '<b class="lsj-head">ἀπατάω</b> <span class="lsj-greek">[ᾰπ</span>], late ' +
      '<span class="lsj-gramGrp"><span class="lsj-gram">Ion.</span></span> ' +
      '<b class="lsj-orth">ἀπατ-έω</b> <span class="lsj-bibl">Luc. Syr.D. 27</span>: ' +
      '<span class="lsj-tns">impf.</span> <span class="lsj-cit"><span class="lsj-quote">ἠπάτων</span> ' +
      '<span class="lsj-bibl">E. El. 938</span></span>'));
    const rows = rowsOf(html);
    expect(rows[0][0]).toBe('impf.');
    expect(rows[0][1]).toContain('ἠπάτων');
    expect(rows.some(([, body]) => body.startsWith('[ᾰπ'))).toBe(false);
  });

  it('still reads a parenthesis as the etymology it is', () => {
    // Ἀδράστεια's "(ἀ- priv., διδράσκω)" sits exactly where a quantity mark
    // sits, and skipping it cost entries like ἀδελφός their opening bracket.
    const { html } = buildFormsBlock(sanitizeHtml(
      '<b class="lsj-head">Ἀδράστεια</b>, <span class="lsj-gen">ἡ</span>, ' +
      '(<span class="lsj-greek">ἀ-</span> priv., <span class="lsj-greek">διδράσκω</span>) ' +
      'title of Nemesis, <span class="lsj-bibl">A. Pr. 936</span>'));
    expect(html).toContain('(');
  });

  it('still treats a short Greek form with a source as a form', () => {
    // The mark is known by its brackets, not by being short: ἦν is two letters
    // and is a form. No length test — ὕβρις marks quantity in forty characters.
    const { html } = buildFormsBlock(sanitizeHtml(
      '<b class="lsj-head">εἰμί</b>, <span class="lsj-tns">impf.</span> ' +
      '<span class="lsj-greek">ἦν</span> <span class="lsj-bibl">Il. 1.1</span>'));
    expect(rowsOf(html)[0][1]).toContain('ἦν');
  });
});

describe('the headword does not belong in a form label', () => {
  const rowsOf = (html: string) =>
    [...html.matchAll(/class="lsj-form-label">([^<]*)<\/span><span class="lsj-form-body">([\s\S]*?)<\/span><\/div>/g)]
      .map((m) => [m[1].trim(), m[2].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()]);

  it('cuts the headword out of the first label when a real label follows it', () => {
    // αἱρέω: the lead "αἱρέω, impf." is under the 22-character threshold that
    // decides whether to cut at all, so the headword stayed in the label and
    // the first row read "αἱρέω, impf." against ᾕρεον. 476 entries did this.
    const { html } = buildFormsBlock(sanitizeHtml(
      '<b class="lsj-head">αἱρέω</b>, <span class="lsj-tns">impf.</span> ' +
      '<span class="lsj-cit"><span class="lsj-quote">ᾕρεον</span> ' +
      '<span class="lsj-bibl">Il. 24.579</span></span>: ' +
      '<span class="lsj-tns">fut.</span> <span class="lsj-cit">' +
      '<span class="lsj-quote">αἱρήσω</span> <span class="lsj-bibl">Hdt. 1.1</span></span>'));
    const rows = rowsOf(html);
    expect(rows[0][0]).toBe('impf.');
    expect(rows[0][1]).toContain('ᾕρεον');
    // and the headword is still in the entry, above the table
    expect(html).toContain('αἱρέω');
    expect(rows.some(([label]) => label.includes('αἱρέω'))).toBe(false);
  });

  it('leaves prose alone rather than inventing a label for it', () => {
    // Ἀθήναια: "τά, older name of the Παναθήναια". The headword is followed by
    // PROSE, not a grammatical label, so the new cut must decline and leave the
    // old threshold to handle it — label "older name of the", not "τά, older
    // name of the", which is what cutting at the first comma would produce.
    //
    // This shape is deliberate. The obvious real-world case, ἀναγκαίη
    // ("Ep. and Ion, for ἀνάγκη"), carries no lsj-cit at all — its form is
    // lsj-greek + lsj-bibl — so `firstAt` is -1 and the whole lead-cut block
    // is skipped. A test built on it passed with the fix disabled AND with
    // LABELISH loosened to match anything: it never reached the code it
    // claimed to guard. Codex caught that. This one enters the block.
    const { html } = buildFormsBlock(sanitizeHtml(
      '<b class="lsj-head">Ἀθήναια</b>, <span class="lsj-gen">τά</span>, older name of the ' +
      '<span class="lsj-cit"><span class="lsj-quote">Παναθήναια</span> ' +
      '<span class="lsj-bibl">Th. 2.15</span></span>'));
    const rows = rowsOf(html);
    expect(rows.length).toBe(1);
    expect(rows[0][0]).toBe('older name of the');
    expect(rows[0][0]).not.toContain('τά');
  });

  // Codex's second finding on c0ed62325, recovered from its session log after
  // the run was cancelled: LABELISH tested the SHAPE of a label — short ASCII
  // ending in a period — not its vocabulary. So it accepted "cf.", which is
  // prose, and rejected "aor. 1", "impf. 3 sg." and "Pass., fut.", which are
  // labels. 19 entries in the corpus carried the second fault.
  const entry = (lead: string) => buildFormsBlock(sanitizeHtml(
    lead + ' <span class="lsj-cit"><span class="lsj-quote">ἔτυχον</span> ' +
    '<span class="lsj-bibl">Il. 1.1</span></span>: <span class="lsj-tns">fut.</span> ' +
    '<span class="lsj-cit"><span class="lsj-quote">τεύξομαι</span> ' +
    '<span class="lsj-bibl">Od. 1.1</span></span>')).html;

  it('knows a label by its vocabulary, not its shape', () => {
    // ἐκνήχομαι, aor. 1 — the aorist class number is part of the label
    expect(rowsOf(entry('<b class="lsj-head">ἐκνήχομαι</b>, <span class="lsj-tns">aor.</span> 1'))[0][0])
      .toBe('aor. 1');
    // ἀρκέω, impf. 3 sg. — tense then person-and-number
    expect(rowsOf(entry('<b class="lsj-head">ἀρκέω</b>, <span class="lsj-tns">impf.</span> 3 sg.'))[0][0])
      .toBe('impf. 3 sg.');
    // δράω (A), Aeol. 3 pl. — homograph letter stays with the head
    const rows = rowsOf(entry('<b class="lsj-head">δράω</b> (A), <span class="lsj-gram">Aeol.</span> 3 pl.'));
    expect(rows[0][0]).toBe('Aeol. 3 pl.');
    // ἄγνυμι, 3 dual — no abbreviation at all, and still a label
    expect(rowsOf(entry('<b class="lsj-head">ἄγνυμι</b>, 3 dual'))[0][0]).toBe('3 dual');
  });

  it('sends an article or gender up with the head, not into the label', () => {
    // δεσμός, ὁ, pl. δεσμά: the gender sits between the headword and the
    // label, so requiring the WHOLE run after the first comma to be
    // vocabulary left the headword in the label — "δεσμός, ὁ, pl." against
    // δεσμά. Only the last clause is the form's label; everything before it
    // describes the lemma. About nine entries; Grok found them.
    expect(rowsOf(entry('<b class="lsj-head">δεσμός</b>, <span class="lsj-gen">ὁ</span>, pl.'))[0][0])
      .toBe('pl.');
    // ἀριστεύς, έως, ὁ, dual: ending, then gender, then the label
    expect(rowsOf(entry('<b class="lsj-head">ἀριστεύς</b>, έως, <span class="lsj-gen">ὁ</span>, dual'))[0][0])
      .toBe('dual');
    // and prose still declines, wherever the run ends: ἅτε's last clause is
    // "neut. of", Ἀθήναια's is "older name of the" — neither is vocabulary.
    // (ἀναγκαίη's "for" was the example here until a lead ending in "for"
    // became a cross-reference outright, with no row at all — see "what does
    // not open a table" below.)
    // The lead here must stay under 22 characters: past that, the OLD
    // last-comma path cuts regardless of vocabulary (it always has — that is
    // the deferred 228-lead class), and this test is about the new branch.
    const hate = rowsOf(entry('<b class="lsj-head">ἅτε</b>, neut. of'));
    expect(hate[0][0]).not.toBe('neut. of');
    expect(hate[0][0]).toContain('ἅτε');
  });

  it('cuts the lead when the first form is Greek-with-reference, too', () => {
    // ἀπολείπω, aor. -έλιπον: the form is lsj-greek + lsj-bibl, no lsj-cit,
    // and the lead cut only ran for citation-shaped forms — so the row read
    // "ἀπολείπω, aor." against -έλιπον. 99 entries: the largest class left
    // after the article fix.
    const { html } = buildFormsBlock(sanitizeHtml(
      '<b class="lsj-head">ἀπολείπω</b>, <span class="lsj-tns">aor.</span> ' +
      '<span class="lsj-greek">-έλιπον</span> <span class="lsj-bibl">Il. 12.169</span>: ' +
      '<span class="lsj-tns">fut.</span> <span class="lsj-cit">' +
      '<span class="lsj-quote">-λείψω</span> <span class="lsj-bibl">Od. 1.1</span></span>'));
    const rows = rowsOf(html);
    expect(rows[0][0]).toBe('aor.');
    expect(rows[0][1]).toContain('-έλιπον');
    expect(rows.some(([label]) => label.includes('ἀπολείπω'))).toBe(false);
  });

  it('never gives a Greek-shaped cross-reference a label by length', () => {
    // ἀναγκαίη, ἡ, Ep. and Ion, for ἀνάγκη — the real entry, at last in a
    // shape that REACHES the code (its form is lsj-greek + lsj-bibl, so the
    // old firstAt was -1 and every earlier ἀναγκαίη test tested nothing;
    // Codex caught that). The lead is 29 characters, past the >22 threshold,
    // so the length path would cut at the last comma and label the row "for".
    // For Greek-shaped forms ONLY the vocabulary branch may cut.
    const { html } = buildFormsBlock(sanitizeHtml(
      '<b class="lsj-head">ἀναγκαίη</b>, <span class="lsj-gen">ἡ</span>, Ep. and Ion, for ' +
      '<span class="lsj-greek">ἀνάγκη,</span> <span class="lsj-bibl">Il. 6.85</span>'));
    const rows = rowsOf(html);
    if (rows.length) {
      expect(rows[0][0]).not.toBe('for');
      expect(rows[0][0]).toContain('ἀναγκαίη');
    }
  });

  it('gives the form only the last clause of a comma-separated run', () => {
    // προσερέσθαι, aor. 2 inf., fut. -ερήσομαι: "aor. 2 inf." describes the
    // lemma, "fut." labels the form. Cutting at the first comma would label
    // the future "aor. 2 inf., fut."; the old >22-character path already got
    // this right by cutting at the last, and the vocabulary guard must not
    // undo it. συλλογίζομαι's "Med., aor." is the same shape.
    const html = entry('<b class="lsj-head">προσερέσθαι</b>, <span class="lsj-tns">aor.</span> 2 ' +
      '<span class="lsj-mood">inf.</span>, <span class="lsj-tns">fut.</span>');
    expect(rowsOf(html)[0][0]).toBe('fut.');
    expect(html.indexOf('inf.')).toBeLessThan(html.indexOf('lsj-form-label'));
  });

  it('does not take a prose abbreviation for a label', () => {
    // "esp." is short, ASCII and ends in a period, and it is not a grammatical
    // label. The first LABELISH accepted any such shape — it took "cf." for a
    // label — and this is the guard against that: a lead short enough that
    // only the vocabulary branch can cut, so the cut must decline and leave
    // the headword where it was. ("cf." itself no longer reaches here: a
    // citation after "cf." is not a form at all, see the ἱδρόω test below.)
    const rows = rowsOf(entry('<b class="lsj-head">ἄγαλμα</b>, esp.'));
    expect(rows[0][0]).not.toBe('esp.');
    expect(rows[0][0]).toContain('ἄγαλμα');
  });

  it('does not open the table on a citation LSJ introduces with "cf."', () => {
    // ἱδρόω: "[ῐ by nature, cf. ἀφῐδρωσον Com.Adesp. 3 D.], v. sub fin.: fut.
    // -ώσω". The first citation is a comparison inside the quantity aside, not
    // a form of ἱδρόω at all; the first form is the future one segment later.
    // Taking the comparison for a form labelled the row "cf." — Grok's finding
    // on eca29f00b. A citation after "cf." is never a form: six entries in the
    // corpus, and in each the citation is a compound, a phrase, or another
    // verb's form.
    const { html } = buildFormsBlock(sanitizeHtml(
      '<b class="lsj-head">ἱδρόω</b> [<span class="lsj-pron">ῐ</span> by nature, cf. ' +
      '<span class="lsj-cit"><span class="lsj-quote">ἀφῐδρωσον</span> ' +
      '<i class="lsj-title">Com.Adesp.</i> 3</span> D.], v. sub fin.: ' +
      '<span class="lsj-tns">fut.</span> <span class="lsj-cit">' +
      '<span class="lsj-quote">-ώσω</span> <span class="lsj-bibl">Il. 2.388</span></span>: ' +
      '<span class="lsj-tns">aor.</span> <span class="lsj-cit">' +
      '<span class="lsj-quote">ἵδρωσα</span> <span class="lsj-bibl">4.27</span></span>'));
    const rows = rowsOf(html);
    expect(rows.map(([label]) => label)).toEqual(['fut.', 'aor.']);
    expect(rows[0][1]).toContain('-ώσω');
    // the comparison stays above the table, with the headword
    expect(html.indexOf('ἀφῐδρωσον')).toBeLessThan(html.indexOf('lsj-form-label'));
  });

  it('still cuts a long lead at its last comma', () => {
    // The pre-existing >22-character path: λέγω's "tenses for signf. I and II,
    // fut." keeps its introduction above and labels the row "fut." only.
    const { html } = buildFormsBlock(sanitizeHtml(
      '<b class="lsj-head">λέγω</b> (B), pick up, etc.: tenses for signf. I and II, ' +
      '<span class="lsj-tns">fut.</span> <span class="lsj-cit">' +
      '<span class="lsj-quote">λέξω</span> <span class="lsj-bibl">Od. 24.224</span></span>'));
    expect(rowsOf(html)[0][0]).toBe('fut.');
  });
});

describe('what does not open a table', () => {
  // The three residual classes HANDOFF-LSJ §0 records: a form inside an
  // unclosed "(", a lead that ends in "for", and a lone row with no label.
  // Every fixture carries an lsj-cit (or a Greek span WITH a reference) so
  // that formAt finds a form and the code under test is reached — an
  // lsj-greek + lsj-bibl pair that formAt declines makes firstAt -1 and skips
  // the block, and a test built on one passes whatever the rules say (§4).
  const rowsOf = (html: string) =>
    [...html.matchAll(/class="lsj-form-label">([^<]*)<\/span><span class="lsj-form-body">([\s\S]*?)<\/span><\/div>/g)]
      .map((m) => [m[1].trim(), m[2].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()]);
  const cit = (quote: string, bibl: string) =>
    `<span class="lsj-cit"><span class="lsj-quote">${quote}</span> <span class="lsj-bibl">${bibl}</span></span>`;
  const tns = (label: string) => `<span class="lsj-tns">${label}</span>`;

  it('does not open the table on a citation inside a parenthesis', () => {
    // ἀριθμός: "[ᾰ], (ἀ. τις Pl.), ὁ" — the citation sits inside LSJ's own
    // bracket, and the row read "ἀριθμός [ᾰ], (" against it. 83 entries opened
    // their table on a parenthetical. The table opens on the first form
    // OUTSIDE the bracket, and the bracket stays above it with the headword.
    const { html } = buildFormsBlock(sanitizeHtml(
      '<b class="lsj-head">ἀριθμός</b> [<span class="lsj-pron">ᾰ</span>], (' +
      cit('ἀ. τις', 'Pl. Phd. 104a') + '), <span class="lsj-gen">ὁ</span>: ' +
      tns('pl.') + ' ' + cit('ἀριθμοί', 'Il. 2.1')));
    expect(rowsOf(html)).toEqual([['pl.', 'ἀριθμοί Il. 2.1']]);
    expect(html.indexOf('ἀ. τις')).toBeLessThan(html.indexOf('lsj-form-label'));
  });

  it('renders the whole preamble as prose when the parenthetical is all there is', () => {
    // Ἀδράστεια, ἡ, (ἀ- priv., διδράσκω) title of Nemesis, A. Pr. 936: the
    // etymology is a Greek span with a reference behind it, so it passed for
    // a form and the entry opened a one-row table labelled "Ἀδράστεια, ἡ, (".
    // No form, no table — and not a character of the entry lost.
    const src = sanitizeHtml(
      '<b class="lsj-head">Ἀδράστεια</b>, <span class="lsj-gen">ἡ</span>, ' +
      '(<span class="lsj-greek">ἀ-</span> priv., <span class="lsj-greek">διδράσκω</span>) ' +
      'title of Nemesis, <span class="lsj-bibl">A. Pr. 936</span>');
    const { html, rows } = buildFormsBlock(src);
    expect(rows).toBe(0);
    expect(html).toBe(src);
  });

  it('carries the parenthesis across the dictionary\'s own separators', () => {
    // ἀντιτίθημι (pres. part. ἀντιτιθείς Pl.; aor. ἀντέθηκα Hdt.): fut.
    // ἀντιθήσω. The bracket holds two clauses; the second is no more a row
    // than the first, though its own segment has no "(" in it. Both stay
    // above, and the table opens on the future after the ")".
    const { html } = buildFormsBlock(sanitizeHtml(
      '<b class="lsj-head">ἀντιτίθημι</b> (' + tns('pres. part.') + ' ' +
      cit('ἀντιτιθείς', 'Pl. R. 1') + '; ' + tns('aor.') + ' ' + cit('ἀντέθηκα', 'Hdt. 1.1') +
      '): ' + tns('fut.') + ' ' + cit('ἀντιθήσω', 'Il. 1.1')));
    expect(rowsOf(html)).toEqual([['fut.', 'ἀντιθήσω Il. 1.1']]);
    expect(html).toContain('ἀντέθηκα');
    expect(html.indexOf('ἀντέθηκα')).toBeLessThan(html.indexOf('lsj-form-label'));
  });

  it('still opens the table after a closed parenthesis, or a stray close', () => {
    // A bracket that has closed is not an open one — "λέγω (B), fut." keeps
    // its row — and a ")" with no "(" before it counts for nothing.
    expect(rowsOf(buildFormsBlock(sanitizeHtml(
      '<b class="lsj-head">λέγω</b> (B), ' + tns('fut.') + ' ' + cit('λέξω', 'Od. 24.224'))).html)[0][0])
      .toBe('fut.');
    expect(rowsOf(buildFormsBlock(sanitizeHtml(
      '<b class="lsj-head">λέγω</b>), ' + tns('fut.') + ' ' + cit('λέξω', 'Od. 24.224'))).html)[0][0])
      .toBe('fut.');
  });

  it('renders a cross-reference — a lead ending in "for" — as prose', () => {
    // ἀναγκαίη, ἡ, Ep. and Ion, for ἀνάγκη: 29 characters of prose, and the
    // >22-character path cut at the last comma and labelled the row "for".
    // A lead ending in "for" is a cross-reference, not a paradigm: no table,
    // and the entry back whole. 38 entries; none has a form of its own.
    const anank = sanitizeHtml(
      '<b class="lsj-head">ἀναγκαίη</b>, <span class="lsj-gen">ἡ</span>, Ep. and Ion, for ' +
      cit('ἀνάγκη', 'Il. 6.85'));
    expect(buildFormsBlock(anank)).toEqual({ html: anank, rows: 0 });
    // διπλός, ή, όν, poet. for διπλοῦς — the same shape after an adjective
    const diplos = sanitizeHtml(
      '<b class="lsj-head">διπλός</b>, ή, όν, poet. for ' + cit('διπλοῦς', 'Il. 4.133'));
    expect(buildFormsBlock(diplos)).toEqual({ html: diplos, rows: 0 });
    // and the real ἀναγκαίη, whose form is lsj-greek + lsj-bibl: the row it
    // had was labelled with the whole lead, headword and all
    const greek = sanitizeHtml(
      '<b class="lsj-head">ἀναγκαίη</b>, <span class="lsj-gen">ἡ</span>, Ep. and Ion, for ' +
      '<span class="lsj-greek">ἀνάγκη,</span> <span class="lsj-bibl">Il. 6.85</span>');
    expect(buildFormsBlock(greek)).toEqual({ html: greek, rows: 0 });
  });

  it('keeps the cross-reference above a table that follows it', () => {
    // The cross-reference is the lead, not the entry: where forms follow it,
    // they are the table and the cross-reference is the prose above them.
    const { html } = buildFormsBlock(sanitizeHtml(
      '<b class="lsj-head">ἀναγκαίη</b>, <span class="lsj-gen">ἡ</span>, Ep. and Ion, for ' +
      cit('ἀνάγκη', 'Il. 6.85') + ': ' + tns('pl.') + ' ' + cit('ἀναγκαῖαι', 'Od. 1.1')));
    expect(rowsOf(html)).toEqual([['pl.', 'ἀναγκαῖαι Od. 1.1']]);
    expect(html.indexOf('ἀνάγκη')).toBeLessThan(html.indexOf('lsj-form-label'));
  });

  it('reads "for" as a cross-reference only at the end of the lead', () => {
    // "tenses for signf. I" is prose with "for" in the middle; the lead ends
    // in a label and the row keeps it. And a "for" that ends a LATER clause is
    // that row's label, not a reason to abandon the table.
    expect(rowsOf(buildFormsBlock(sanitizeHtml(
      '<b class="lsj-head">ἔχω</b>, tenses for signf. I, ' + tns('fut.') + ' ' + cit('ἕξω', 'Il. 1.1'))).html)[0][0])
      .toBe('fut.');
    const rows = rowsOf(buildFormsBlock(sanitizeHtml(
      '<b class="lsj-head">εἰμί</b>: ' + tns('impf.') + ' ' + cit('ἦν', 'Il. 1.1') +
      '; 3 pl. ἔασι, Ep. for ' + cit('εἰσί', 'Il. 2.2'))).html);
    expect(rows.length).toBe(2);
    expect(rows[1][1]).toContain('εἰσί');
  });

  it('does not make a table of one row with no label', () => {
    // διδάσκαλος, ὁ, cf. ξυμφορὴ γίνεται δ. Hdt.; διδάσκαλοι Pl.: the "cf."
    // rule took the first citation away as a comparison, and what was left
    // opened a table on a single row with nothing to label it (ὅλος did the
    // same). A table whose only row has no label is not a table.
    const src = sanitizeHtml(
      '<b class="lsj-head">διδάσκαλος</b>, <span class="lsj-gen">ὁ</span>, cf. ' +
      cit('ξυμφορὴ γίνεται δ.', 'Hdt. 7.213') + '; ' + cit('διδάσκαλοι', 'Pl. Prt. 1'));
    expect(buildFormsBlock(src)).toEqual({ html: src, rows: 0 });
  });

  it('keeps a table of two rows even when one of them is unlabelled', () => {
    // The rule is about a LONE row: with a second, labelled row the first is
    // a real, if unlabelled, member of the paradigm.
    const { html, rows } = buildFormsBlock(sanitizeHtml(
      '<b class="lsj-head">διδάσκαλος</b>, <span class="lsj-gen">ὁ</span>, cf. ' +
      cit('ξυμφορὴ γίνεται δ.', 'Hdt. 7.213') + '; ' + cit('διδάσκαλοι', 'Pl. Prt. 1') +
      '; ' + tns('pl.') + ' ' + cit('διδασκάλους', 'X. Mem. 1')));
    expect(rows).toBe(2);
    expect(rowsOf(html).map(([label]) => label)).toEqual(['', 'pl.']);
  });
});
