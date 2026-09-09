// node --test scripts/__tests__/
// app/scripts/build-bekker-index.mjs walks public/data relative to its cwd and
// writes public/data/bekker.json, so it is exercised by spawning it inside a
// fixture tree. What is worth pinning is the aggregation itself: which
// directories count as a work, the [work, book, lo, hi] tuple the ⌘K palette
// unpacks, and the refusal to write an empty index (a silent empty one leaves
// every citation falling through to search — the bug the file exists to fix).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../../app/scripts/build-bekker-index.mjs', import.meta.url));

// { work: {column: [{book, lo, hi}, …]} } → a data tree of columns.json files.
function fixture(works, extra = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'bekker-index-'));
  const data = path.join(root, 'public', 'data');
  mkdirSync(data, { recursive: true });
  for (const [work, columns] of Object.entries(works)) {
    mkdirSync(path.join(data, work), { recursive: true });
    writeFileSync(path.join(data, work, 'columns.json'), JSON.stringify(columns));
  }
  for (const [rel, text] of Object.entries(extra)) {
    mkdirSync(path.dirname(path.join(data, rel)), { recursive: true });
    writeFileSync(path.join(data, rel), text);
  }
  return { root, data };
}

const run = (root) => spawnSync(process.execPath, [SCRIPT], { cwd: root, encoding: 'utf8' });
const readIndex = (data) => JSON.parse(readFileSync(path.join(data, 'bekker.json'), 'utf8'));

test('packs every column into [work, book, lo, hi] tuples', () => {
  const { root, data } = fixture({
    EN: { '1094a': [{ book: 1, lo: 1, hi: 34 }], '1103a': [{ book: 2, lo: 14, hi: 33 }] },
  });
  try {
    const r = run(root);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(readIndex(data), {
      '1094a': [['EN', 1, 1, 34]],
      '1103a': [['EN', 2, 14, 33]],
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// A Bekker column can straddle a book boundary, and two works can share one
// (the palette disambiguates at query time). Both must survive as separate
// tuples under the same key — collapsing them loses a jump target.
test('keeps every claim on a shared column, across books and across works', () => {
  const { root, data } = fixture({
    EN: { '1094a': [{ book: 1, lo: 1, hi: 20 }, { book: 2, lo: 21, hi: 34 }] },
    EE: { '1094a': [{ book: 1, lo: 1, hi: 34 }] },
  });
  try {
    assert.equal(run(root).status, 0);
    assert.deepEqual(readIndex(data)['1094a'], [
      ['EE', 1, 1, 34],            // directories are walked in sorted order
      ['EN', 1, 1, 20],
      ['EN', 2, 21, 34],
    ]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Works are read in sorted directory order so the emitted JSON is byte-stable
// across rebuilds — an index that reshuffles makes every deploy diff noise.
test('is deterministic: works in sorted order, whatever the filesystem returns', () => {
  const a = fixture({ Zed: { '1a': [{ book: 1, lo: 1, hi: 2 }] }, Alpha: { '1a': [{ book: 1, lo: 1, hi: 2 }] } });
  const b = fixture({ Alpha: { '1a': [{ book: 1, lo: 1, hi: 2 }] }, Zed: { '1a': [{ book: 1, lo: 1, hi: 2 }] } });
  try {
    assert.equal(run(a.root).status, 0);
    assert.equal(run(b.root).status, 0);
    assert.equal(
      readFileSync(path.join(a.data, 'bekker.json'), 'utf8'),
      readFileSync(path.join(b.data, 'bekker.json'), 'utf8'),
    );
    assert.deepEqual(readIndex(a.data)['1a'], [['Alpha', 1, 1, 2], ['Zed', 1, 1, 2]]);
  } finally {
    rmSync(a.root, { recursive: true, force: true });
    rmSync(b.root, { recursive: true, force: true });
  }
});

// public/data also holds shard directories (lsj/) and loose files
// (lemmata.json). Only a directory carrying columns.json is a built work.
test('counts only directories that carry a columns.json', () => {
  const { root, data } = fixture(
    { EN: { '1094a': [{ book: 1, lo: 1, hi: 34 }] } },
    { 'lsj/e.json': '{}', 'lemmata.json': '{}', 'Poet/chapters.json': '{}' },
  );
  try {
    const r = run(root);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(Object.keys(readIndex(data)), ['1094a']);
    assert.match(r.stdout, /from 1 works/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('reports how many columns are shared by two books or two works', () => {
  const { root } = fixture({
    EN: { '1094a': [{ book: 1, lo: 1, hi: 20 }, { book: 2, lo: 21, hi: 34 }], '1095a': [{ book: 1, lo: 1, hi: 10 }] },
  });
  try {
    const r = run(root);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /2 columns from 1 works/);
    assert.match(r.stdout, /shared columns\s*:\s*1\b/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// The whole point of the gate: an empty index would leave every ⌘K citation
// falling through to search, silently.
test('refuses to write an empty index when no work has been built', () => {
  const { root, data } = fixture({}, { 'lsj/e.json': '{}' });
  try {
    const r = spawnSync(process.execPath, [SCRIPT], { cwd: root, encoding: 'utf8' });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /no columns\.json found/);
    assert.doesNotMatch(r.stderr, /TypeError/);
    assert.equal(existsSync(path.join(data, 'bekker.json')), false, 'wrote a bekker.json anyway');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
