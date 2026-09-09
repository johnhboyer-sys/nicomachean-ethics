// node --test scripts/__tests__/
// app/scripts/build-lsj-heads.mjs walks public/data relative to its cwd and
// writes public/data/lsj-heads.json, so it is exercised by spawning it inside a
// fixture tree. The manifest is what the word popup reads INSTEAD of a 6.7 MB
// letter shard, so what is pinned here is: which keys it collects (only those
// an analysis names), where the homograph letter comes from (LSJ's own "(A)",
// never the key's trailing digit), and its two refusals — a manifest with holes
// and a manifest built from no works are both worse than no manifest at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../../app/scripts/build-lsj-heads.mjs', import.meta.url));

// analyses: { work: { tokenId: [{ lsj: [key, …] }, …] } }
// shards:   { 'e.json': { key: { head, html } } }
function fixture({ analyses = {}, shards = {}, extra = {} } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'lsj-heads-'));
  const data = path.join(root, 'public', 'data');
  mkdirSync(path.join(data, 'lsj'), { recursive: true });
  for (const [work, byToken] of Object.entries(analyses)) {
    mkdirSync(path.join(data, work), { recursive: true });
    writeFileSync(path.join(data, work, 'analyses.json'), JSON.stringify(byToken));
  }
  for (const [name, entries] of Object.entries(shards)) {
    writeFileSync(path.join(data, 'lsj', name), JSON.stringify(entries));
  }
  for (const [rel, text] of Object.entries(extra)) {
    mkdirSync(path.dirname(path.join(data, rel)), { recursive: true });
    writeFileSync(path.join(data, rel), text);
  }
  return { root, data };
}

const run = (root) => spawnSync(process.execPath, [SCRIPT], { cwd: root, encoding: 'utf8' });
const readHeads = (data) => JSON.parse(readFileSync(path.join(data, 'lsj-heads.json'), 'utf8'));

test('emits head and homograph letter for every key an analysis names', () => {
  const { root, data } = fixture({
    analyses: { EN: { t1: [{ lsj: ['ei)mi/', 'de/w1'] }] } },
    shards: {
      'e.json': { 'ei)mi/': { head: 'εἰμί', html: '<div>εἰμί, to be</div>' } },
      'd.json': { 'de/w1': { head: 'δέω', html: '<div>δέω (A), to bind</div>' } },
    },
  });
  try {
    const r = run(root);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(readHeads(data), {
      'ei)mi/': { head: 'εἰμί' },
      'de/w1': { head: 'δέω', hom: 'A' },
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// The manifest is keyed on what the reader can actually ask for: an entry no
// analysis points at can never surface in a card, and shipping it would put the
// whole dictionary back into the download this file exists to remove.
test('drops shard entries no analysis names, however many the shard holds', () => {
  const { root, data } = fixture({
    analyses: { EN: { t1: [{ lsj: ['lo/gos' ] }] } },
    shards: {
      'l.json': {
        'lo/gos': { head: 'λόγος', html: '<div>λόγος</div>' },
        'lupe/w': { head: 'λυπέω', html: '<div>λυπέω</div>' },
        'lu/w': { head: 'λύω', html: '<div>λύω</div>' },
      },
    },
  });
  try {
    const r = run(root);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(Object.keys(readHeads(data)), ['lo/gos']);
    assert.match(r.stdout, /1 entries from 1 works/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Every shard letter is read, not just the first, and a non-JSON file sitting
// in the shard directory is skipped rather than crashing the build.
test('reads every letter shard and ignores non-JSON files beside them', () => {
  const { root, data } = fixture({
    analyses: { EN: { t1: [{ lsj: ['a)rxh/'] }, { lsj: ['w)/n'] }] } },
    shards: {
      'a.json': { 'a)rxh/': { head: 'ἀρχή', html: '<div>ἀρχή</div>' } },
      'w.json': { 'w)/n': { head: 'ὤν', html: '<div>ὤν</div>' } },
    },
    extra: { 'lsj/README.txt': 'not a shard' },
  });
  try {
    const r = run(root);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(Object.keys(readHeads(data)).sort(), ['a)rxh/', 'w)/n']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// LSJ marks its own homographs in the entry text. The letter is read from
// there — never derived from the key's trailing digit, which disagrees on six
// entries (ka/r2 is LSJ's (A)) and is absent on a third of numbered keys.
test('takes the homograph letter from the entry, not from the key\'s digit', () => {
  const { root, data } = fixture({
    analyses: { EN: { t1: [{ lsj: ['ka/r2', 'ne/w1', 'ti/s'] }] } },
    shards: {
      'k.json': { 'ka/r2': { head: 'κάρ', html: '<p><b>κάρ</b> (A), hair</p>' } },
      'n.json': { 'ne/w1': { head: 'νέω', html: '<p>νέω (B), to swim</p>' } },
      't.json': { 'ti/s': { head: 'τίς', html: '<p>τίς, who?</p>' } },
    },
  });
  try {
    assert.equal(run(root).status, 0);
    const out = readHeads(data);
    assert.equal(out['ka/r2'].hom, 'A', 'the key says 2; LSJ says (A)');
    assert.equal(out['ne/w1'].hom, 'B', 'the key says 1; LSJ says (B)');
    assert.equal('hom' in out['ti/s'], false, 'invented a homograph letter');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// The letter is matched against the entry with its markup stripped, so it is
// found whether or not the headword is wrapped in a tag — and a "(A)" further
// down the entry (a cross-reference) is not mistaken for the entry's own.
test('reads the letter through markup, and only at the head of the entry', () => {
  const { root, data } = fixture({
    analyses: { EN: { t1: [{ lsj: ['tagged', 'later'] }] } },
    shards: {
      'x.json': {
        tagged: { head: 'x', html: '<div class="lsj-entry"><b>δέω</b> (A), to bind</div>' },
        later: { head: 'y', html: '<div>φέρω, to bear; cf. δέω (A)</div>' },
      },
    },
  });
  try {
    assert.equal(run(root).status, 0);
    const out = readHeads(data);
    assert.equal(out.tagged.hom, 'A');
    assert.equal('hom' in out.later, false, 'picked up a cross-reference\'s letter');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('collects keys from every work and every analysis of a token', () => {
  const { root, data } = fixture({
    analyses: {
      EN: { t1: [{ lsj: ['a'] }, { lsj: ['b'] }], t2: [{ lsj: ['a', 'c'] }] },
      Cat: { t1: [{ lsj: ['d'] }, { /* no lsj key at all */ }] },
    },
    shards: {
      'x.json': Object.fromEntries(['a', 'b', 'c', 'd'].map((k) =>
        [k, { head: k.toUpperCase(), html: `<div>${k}</div>` }])),
    },
  });
  try {
    const r = run(root);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(Object.keys(readHeads(data)).sort(), ['a', 'b', 'c', 'd']);
    assert.match(r.stdout, /from 2 works/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// A key with no shard entry means the popup silently falls back to
// transliterating the lemma for that word, which looks like a headword bug
// somewhere else entirely. An app-only build never runs verify_shared_lsj, so
// exiting 0 with a hole is how the gap would ship.
test('refuses to write a manifest with holes, and leaves the old one alone', () => {
  const { root, data } = fixture({
    analyses: { EN: { t1: [{ lsj: ['present', 'absent'] }] } },
    shards: { 'p.json': { present: { head: 'π', html: '<div>π</div>' } } },
  });
  writeFileSync(path.join(data, 'lsj-heads.json'), '{"keep":1}');
  try {
    const r = run(root);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /1 of 2 keys had no shard entry/);
    assert.match(r.stderr, /refusing/);
    assert.doesNotMatch(r.stderr, /TypeError/);
    assert.equal(readFileSync(path.join(data, 'lsj-heads.json'), 'utf8'), '{"keep":1}');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('refuses to run at all on a data tree with no built work', () => {
  const { root, data } = fixture({ shards: { 'e.json': { 'ei)mi/': { head: 'εἰμί', html: '' } } } });
  try {
    const r = run(root);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /no analyses\.json found/);
    assert.doesNotMatch(r.stderr, /TypeError/);
    assert.equal(existsSync(path.join(data, 'lsj-heads.json')), false, 'wrote a manifest anyway');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
