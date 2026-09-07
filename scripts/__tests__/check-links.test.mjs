// node --test scripts/__tests__/
// Exercises the link-integrity gate against a small fixture dist. Importing
// the script does not run its main(); the exit-code cases spawn it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { BASE, checkDist } from '../check-links.mjs';

const SCRIPT = fileURLToPath(new URL('../check-links.mjs', import.meta.url));

// A minimal site the way Astro emits it under base '/aristotle-reader': every
// internal href in the HTML carries the base; the LSJ shard's citation hrefs
// are base-less by contract (docs/spec-lsj-citations.md, decision 5) and the
// reader prefixes them at render time.
function writeFixture(files) {
  const dist = mkdtempSync(path.join(tmpdir(), 'check-links-'));
  const put = (rel, text) => {
    const file = path.join(dist, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  };
  put('index.html', `<a href="${BASE}/search">Search</a><a href="${BASE}/EN/book/1#ch-1-1">EN</a><a href="${BASE}/">Home</a><a href="#">resume</a><a href="https://example.test/x">ext</a>`);
  put('search/index.html', `<a href="${BASE}/">Home</a>`);
  put('EN/book/1/index.html', '<h2 id="ch-1-1">1</h2><div id="col-1094a"><span id="L1094a-1"></span><span id="L1094a-5"></span></div>');
  put('lemma/logos/index.html', `<a href="${BASE}/EN/book/1?hlg=x&amp;loc=1094a:5">1094a5</a>`);
  put('data/lemmata/_index.json', JSON.stringify([{ slug: 'logos', key: 'lo/gos' }]));
  put('data/lsj/e.json', JSON.stringify({
    // Line 3 is not on the page but the column is: the nearest-line contract.
    'ei)mi/': { head: 'εἰμί', html: '<a class="lsj-bibl" href="/EN/book/1?loc=1094a:3">EN 1094a3</a>' },
  }));
  for (const [rel, text] of Object.entries(files ?? {})) put(rel, text);
  return dist;
}

test('a clean fixture reports nothing broken', async () => {
  const dist = writeFixture();
  try {
    const r = await checkDist(dist);
    assert.deepEqual(r.broken, []);
    assert.equal(r.pages, 4);
    assert.ok(r.links >= 6);
    assert.ok(r.anchors >= 3);
  } finally { rmSync(dist, { recursive: true, force: true }); }
});

// The deploy trap: `/search` resolves against dist/ as root and passes, but on
// GitHub Pages it is johnhboyer-sys.github.io/search — a 404. Emitted HTML
// must carry the base on every root-relative link.
test('a root-relative href in emitted HTML that lacks the site base is broken', async () => {
  const dist = writeFixture({
    'bad/index.html': '<a href="/search">no base</a><a href="/">root</a><a href="/EN/book/1?loc=1094a:5">deep</a>',
  });
  try {
    const r = await checkDist(dist);
    const bad = r.broken.filter((b) => b.source === path.join('bad', 'index.html'));
    assert.deepEqual(bad.map((b) => b.href), ['/search', '/', '/EN/book/1?loc=1094a:5']);
    for (const b of bad) assert.match(b.reason, /lacks the site base/);
    assert.equal(r.broken.length, bad.length, 'the clean pages stay clean');
  } finally { rmSync(dist, { recursive: true, force: true }); }
});

test('LSJ shard citations stay base-less and keep the nearest-line contract only for .lsj-bibl', async () => {
  const dist = writeFixture({
    'data/lsj/l.json': JSON.stringify({
      // Same target, no .lsj-bibl class: the strict exact-line check applies.
      'lo/gos': { head: 'λόγος', html: '<a href="/EN/book/1?loc=1094a:3">EN 1094a3</a>' },
      // A base-prefixed shard href is tolerated (prefixing is idempotent).
      'le/gw': { head: 'λέγω', html: `<a class="lsj-bibl" href="${BASE}/EN/book/1?loc=1094a:5">EN 1094a5</a>` },
      // The column itself is missing: nearest-line does not rescue that.
      'lu/w': { head: 'λύω', html: '<a class="lsj-bibl" href="/EN/book/1?loc=1095b:3">EN 1095b3</a>' },
    }),
  });
  try {
    const r = await checkDist(dist);
    assert.deepEqual(
      r.broken.map((b) => [path.basename(b.source), b.href, b.reason]),
      [
        ['l.json', '/EN/book/1?loc=1094a:3', 'Bekker target L1094a-3 not found'],
        ['l.json', '/EN/book/1?loc=1095b:3', 'Bekker target L1095b-3 not found'],
      ],
    );
  } finally { rmSync(dist, { recursive: true, force: true }); }
});

test('an .lsj-bibl anchor in a page gets the nearest-line contract, but must carry the base', async () => {
  const dist = writeFixture({
    'cites/index.html':
      `<a class="lsj-bibl" href="${BASE}/EN/book/1?loc=1094a:3">ok</a>`
      + '<a class="lsj-bibl" href="/EN/book/1?loc=1094a:3">base-less</a>',
  });
  try {
    const r = await checkDist(dist);
    assert.deepEqual(r.broken.map((b) => b.href), ['/EN/book/1?loc=1094a:3']);
    assert.match(r.broken[0].reason, /lacks the site base/);
  } finally { rmSync(dist, { recursive: true, force: true }); }
});

test('fragments and ids are compared decoded', async () => {
  const dist = writeFixture({
    'frag/index.html': `<a href="${BASE}/EN/book/1#ch-1-1">ok</a><a href="#%CE%B1">here</a><span id="&#945;"></span><a href="${BASE}/EN/book/1#nope">bad</a>`,
  });
  try {
    const r = await checkDist(dist);
    assert.deepEqual(r.broken.map((b) => b.href), [`${BASE}/EN/book/1#nope`]);
  } finally { rmSync(dist, { recursive: true, force: true }); }
});

// The exit code is what the deploy script and build:public act on.
test('run as a script: 0 on clean, 1 on broken, 2 on an empty dist', () => {
  const clean = writeFixture();
  const broken = writeFixture({ 'bad/index.html': '<a href="/search">no base</a>' });
  const empty = mkdtempSync(path.join(tmpdir(), 'check-links-empty-'));
  try {
    const run = (dist) => spawnSync(process.execPath, [SCRIPT, dist], { encoding: 'utf8' });
    const ok = run(clean);
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, /broken: 0/);
    const bad = run(broken);
    assert.equal(bad.status, 1, bad.stdout + bad.stderr);
    assert.match(bad.stdout, /lacks the site base/);
    const none = run(empty);
    assert.equal(none.status, 2, none.stdout + none.stderr);
    assert.match(none.stderr, /No HTML pages found/);
  } finally {
    for (const d of [clean, broken, empty]) rmSync(d, { recursive: true, force: true });
  }
});
