// node --test scripts/__tests__/
// Exercises the pure functions of scripts/deploy-gh-pages.mjs. No clone, no
// dist, no network: importing the script does not run its main().
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  KNOWN_BENIGN,
  LEAK_NAMES,
  auditDataDeletions,
  categorize,
  commitMessage,
  findDanglingReferences,
  formatCategoryReport,
  groupByCategory,
  parseArgs,
  parseDataPrefixes,
  parseNameStatus,
  parseRsyncItemized,
  scanForLeaks,
  verificationTargets,
  verifyLive,
} from '../deploy-gh-pages.mjs';

// -- rsync itemized output --------------------------------------------------

const RSYNC_DRY_RUN = [
  '.d..t...... ./',
  '>f.st...... index.html',
  '>f+++++++++ data/lsj-heads.json',
  'cd+++++++++ lemma/korse/',
  '>f+++++++++ lemma/korse/index.html',
  '>f.st...... _astro/Reader.DEnkf2zT.js',
  '.f..t...... sw.js',
  '*deleting   _astro/Reader.DZMUvdM2.js',
  '*deleting   data/reports/quality_EN.json',
  '*deleting   data/reports/quality_Meta.json',
  '*deleting   data/Meta/quotations.json',
  '*deleting   lemma/syzeo/index.html',
  '*deleting   lemma/syzeo/',
  '*deleting   data/APo/third-titles.json',
  '',
].join('\n');

test('parseRsyncItemized separates deletions, additions and modifications', () => {
  const r = parseRsyncItemized(RSYNC_DRY_RUN);
  assert.deepEqual(r.added, ['data/lsj-heads.json', 'lemma/korse/index.html']);
  assert.deepEqual(r.modified, ['index.html', '_astro/Reader.DEnkf2zT.js']);
  assert.deepEqual(r.other, ['sw.js']);
  assert.deepEqual(r.deleted, [
    '_astro/Reader.DZMUvdM2.js',
    'data/reports/quality_EN.json',
    'data/reports/quality_Meta.json',
    'data/Meta/quotations.json',
    'lemma/syzeo/index.html',
    'lemma/syzeo',
    'data/APo/third-titles.json',
  ]);
});

// -- deletion categorisation -------------------------------------------------

test('categorize files each path under the category DEPLOY-STATUS.md reads them by', () => {
  assert.equal(categorize('_astro/global.CzLKCRk8.css'), '_astro');
  assert.equal(categorize('data/reports/quality_EN.json'), 'data/reports');
  assert.equal(categorize('data/Meta/quotations.json'), 'data/Meta');
  assert.equal(categorize('data/EN/book-01.json'), 'data/EN');
  assert.equal(categorize('data/lsj/e.json'), 'data/lsj');
  assert.equal(categorize('data/ngrams/lemma/occ/o-4.json'), 'data/ngrams');
  assert.equal(categorize('data/lsj-heads.json'), 'data (top-level files)');
  assert.equal(categorize('data/.DS_Store'), 'data (top-level files)');
  assert.equal(categorize('lemma/syzeo/index.html'), 'pages/lemma');
  assert.equal(categorize('EN/book/1/index.html'), 'pages/EN');
  assert.equal(categorize('index.html'), 'pages (root)');
  assert.equal(categorize('sw.js'), '(root files)');
  assert.equal(categorize('game/game.js'), 'game/');
  assert.equal(categorize('lemma/syzeo/'), 'lemma/');
});

test('groupByCategory reports counts per category, never a bare total', () => {
  const groups = groupByCategory(parseRsyncItemized(RSYNC_DRY_RUN).deleted);
  assert.deepEqual([...groups.keys()], ['_astro', 'data/APo', 'data/Meta', 'data/reports', 'lemma/', 'pages/lemma']);
  assert.deepEqual(groups.get('data/reports'), ['data/reports/quality_EN.json', 'data/reports/quality_Meta.json']);
  const lines = formatCategoryReport(groups, { limit: 1, indent: '' });
  assert.ok(lines.includes('data/reports: 2'));
  assert.ok(lines.includes('+1 more'));
  assert.ok(lines.includes('data/Meta: 1'));
});

// -- data/ deletion audit ----------------------------------------------------

// Files at gh-pages HEAD, as one `git ls-tree -r --name-only` would list them:
// files only, so the deleted directory lemma/syzeo is not in it.
const LIVE_FILES = new Set([
  'data/reports/quality_EN.json',
  'data/reports/quality_Meta.json',
  'data/Meta/quotations.json',
  'data/APo/third-titles.json',
  '_astro/Reader.DZMUvdM2.js',
  'lemma/syzeo/index.html',
]);

test('auditDataDeletions restores every live file under data/ by default and ignores the rest', () => {
  const audit = auditDataDeletions(parseRsyncItemized(RSYNC_DRY_RUN).deleted, LIVE_FILES);
  assert.deepEqual(audit.restore, [
    'data/reports/quality_EN.json',
    'data/reports/quality_Meta.json',
    'data/Meta/quotations.json',
    'data/APo/third-titles.json',
  ]);
  assert.deepEqual(audit.delete, []);
});

test('auditDataDeletions lets a deletion through only under an allowed prefix', () => {
  const deleted = parseRsyncItemized(RSYNC_DRY_RUN).deleted;
  const audit = auditDataDeletions(deleted, LIVE_FILES, ['data/APo', 'data/Meta/quotations.json']);
  assert.deepEqual(audit.restore, ['data/reports/quality_EN.json', 'data/reports/quality_Meta.json']);
  assert.deepEqual(audit.delete, ['data/Meta/quotations.json', 'data/APo/third-titles.json']);
  const all = auditDataDeletions(deleted, LIVE_FILES, ['data']);
  assert.deepEqual(all.restore, []);
  assert.equal(all.delete.length, 4);
});

test('auditDataDeletions matches allowed prefixes on whole path segments, not string prefixes', () => {
  const live = new Set(['data/reports-old/x.json', 'data/reports/y.json', 'data/Meta/quotations.json.bak']);
  const audit = auditDataDeletions([...live], live, ['data/reports', 'data/Meta/quotations.json']);
  assert.deepEqual(audit.delete, ['data/reports/y.json']);
  assert.deepEqual(audit.restore, ['data/reports-old/x.json', 'data/Meta/quotations.json.bak']);
});

test('a data/ deletion that is not a file at HEAD (a directory, or never live) is neither restored nor reported', () => {
  const audit = auditDataDeletions(['data/reports', 'data/reports/', 'data/new/never-live.json'], new Set(['data/reports/x.json']));
  assert.deepEqual(audit, { restore: [], delete: [] });
});

test('a bundle rehash and a dropped lemma page are not data deletions', () => {
  const audit = auditDataDeletions(['_astro/global.old.css', 'lemma/syzeo/index.html'], new Set(['_astro/global.old.css', 'lemma/syzeo/index.html']));
  assert.deepEqual(audit, { restore: [], delete: [] });
});

test('parseDataPrefixes accepts prefixes under data/ and rejects anything else', () => {
  assert.deepEqual(parseDataPrefixes('data/APo, data/Meta/quotations.json/'), ['data/APo', 'data/Meta/quotations.json']);
  assert.deepEqual(parseDataPrefixes('data'), ['data']);
  assert.throws(() => parseDataPrefixes('reports'), /must be data or lie under data\//);
  assert.throws(() => parseDataPrefixes('database/x'), /must be data or lie under data\//);
  assert.throws(() => parseDataPrefixes(''), /at least one prefix/);
});

// -- leak scan ---------------------------------------------------------------

const BASELINE = [
  { path: 'data/EN/manifest.json', text: '{"english_translation":"H. Rackham (Loeb, 1926)","author":"Aristotle"}' },
  { path: 'data/EN/footnotes.json', text: '["Rackham reads ...", "so Rackham, Bywater", "Aristotle says"]' },
  { path: 'data/Meta/book-07.json', text: '{"work":"Metaphysics","author":"Aristotle"}' },
  { path: 'data/lsj/a.json', text: '{"a)gaqo/s":{"html":"Arist. EN 1094a"}}' },
];

test('scanForLeaks passes the documented baseline (Rackham manifest ×1, footnotes ×2)', () => {
  const report = scanForLeaks(BASELINE);
  assert.equal(report.ok, true, report.problems.join('\n'));
  assert.equal(report.filesScanned, 4);
  assert.equal(report.control.files, 3);
  assert.equal(report.names.Rackham.files, 2);
  assert.equal(report.names.Rackham.occurrences, 3);
  for (const name of ['Ackrill', 'Tredennick', 'Irwin']) assert.equal(report.names[name].files, 0);
});

test('scanForLeaks scans all four gated names', () => {
  assert.deepEqual(LEAK_NAMES, ['Ackrill', 'Tredennick', 'Irwin', 'Rackham']);
  assert.ok(KNOWN_BENIGN.every((b) => LEAK_NAMES.includes(b.name)));
});

test('scanForLeaks fails on a gated name in a file that is not known benign', () => {
  const report = scanForLeaks([
    ...BASELINE,
    { path: 'data/Cat/book-01.json', text: '{"translator":"J. L. Ackrill","text":"Aristotle"}' },
  ]);
  assert.equal(report.ok, false);
  assert.equal(report.problems.length, 1);
  assert.match(report.problems[0], /Ackrill in data\/Cat\/book-01\.json/);
});

test('scanForLeaks fails when a benign file grows more occurrences than allowed', () => {
  const grown = BASELINE.map((f) => (f.path === 'data/EN/footnotes.json'
    ? { ...f, text: f.text + ' Rackham translates this passage as: ...' }
    : f));
  const report = scanForLeaks(grown);
  assert.equal(report.ok, false);
  assert.match(report.problems[0], /data\/EN\/footnotes\.json: 3 occurrences, KNOWN_BENIGN allows 2/);
});

test('scanForLeaks aborts when the positive control "Aristotle" is absent', () => {
  const report = scanForLeaks(BASELINE.map((f) => ({ ...f, text: f.text.replaceAll('Aristotle', 'Plato') })));
  assert.equal(report.ok, false);
  assert.equal(report.control.files, 0);
  assert.match(report.problems[0], /positive control failed/);
});

test('scanForLeaks with zero files is a failed control, not a clean run', () => {
  const report = scanForLeaks([]);
  assert.equal(report.ok, false);
  assert.match(report.problems[0], /found in 0 of 0 files/);
});

// -- dangling bundle references ---------------------------------------------

test('findDanglingReferences is clean when only new hashes are referenced', () => {
  const pages = [
    { path: 'index.html', text: '<link href="/aristotle-reader/_astro/global.jhbSq3zm.css">' },
    { path: 'EN/book/1/index.html', text: '<script src="/aristotle-reader/_astro/Reader.DEnkf2zT.js">' },
  ];
  const r = findDanglingReferences(pages, ['_astro/global.CzLKCRk8.css', '_astro/Reader.DZMUvdM2.js'], ['_astro/global.jhbSq3zm.css', '_astro/Reader.DEnkf2zT.js']);
  assert.equal(r.ok, true, r.problems.join('\n'));
  assert.deepEqual(r.controlSeen.sort(), ['Reader.DEnkf2zT.js', 'global.jhbSq3zm.css']);
});

test('findDanglingReferences reports a page still loading a removed hash, and a dead control', () => {
  const pages = [{ path: 'index.html', text: '<link href="/aristotle-reader/_astro/global.CzLKCRk8.css">' }];
  const stale = findDanglingReferences(pages, ['_astro/global.CzLKCRk8.css'], ['_astro/global.jhbSq3zm.css']);
  assert.equal(stale.ok, false);
  assert.match(stale.problems.at(-1), /global\.CzLKCRk8\.css is still referenced by 1 page/);
  assert.match(stale.problems[0], /positive control failed/);
});

// -- verification targets, commit message, arguments -------------------------

test('verificationTargets lists the live-verified pattern with /bonitz/ as 404', () => {
  const targets = verificationTargets({ lemmaSlug: 'arithmos', assets: ['global.a.css'], removedAssets: ['_astro/Reader.old.js'] });
  const byPath = Object.fromEntries(targets.map((t) => [t.path, t.expect]));
  assert.equal(byPath['/'], 200);
  assert.equal(byPath['/EN/book/1/'], 200);
  assert.equal(byPath['/lemma/arithmos/'], 200);
  assert.equal(byPath['/data/lsj-heads.json'], 200);
  assert.equal(byPath['/data/Meta/quotations.json'], 200);
  assert.equal(byPath['/data/reports/quality_EN.json'], 200);
  assert.equal(byPath['/_astro/global.a.css'], 200);
  assert.equal(byPath['/_astro/Reader.old.js'], 404);
  assert.equal(byPath['/bonitz/'], 404);
  assert.ok(targets.every((t) => t.url.startsWith('https://johnhboyer-sys.github.io/aristotle-reader/')));
});

test('verifyLive polls until every target answers as expected', async () => {
  const targets = verificationTargets({ assets: [], removedAssets: [] });
  let calls = 0;
  const fetchImpl = async (url) => {
    calls++;
    const bonitz = url.endsWith('/bonitz/');
    // First round: the push has not propagated yet; everything but /bonitz/ 404s.
    if (calls <= targets.length && !bonitz) return { status: 404 };
    return { status: bonitz ? 404 : 200 };
  };
  const outcome = await verifyLive(targets, { attempts: 3, delayMs: 0, fetchImpl, log: () => {} });
  assert.equal(outcome.ok, true);
  const never = await verifyLive(targets, { attempts: 2, delayMs: 0, fetchImpl: async () => ({ status: 500 }), log: () => {} });
  assert.equal(never.ok, false);
  assert.equal(never.pending.length, targets.length);
});

test('commitMessage names the source commit', () => {
  const msg = commitMessage({ sourceSha: '52fad397b5abcdef0123', sourceBranch: 'main', summary: '6,441 files' });
  assert.match(msg, /^Deploy 52fad397b5 \(main\)/);
  assert.match(msg, /Source: 52fad397b5abcdef0123 on main/);
  assert.match(msg, /6,441 files/);
});

test('parseNameStatus reads git diff --cached --name-status', () => {
  const r = parseNameStatus('A\t_astro/new.js\nM\tindex.html\nD\t_astro/old.js\nR100\ta.html\tb.html\n');
  assert.deepEqual(r, { A: ['_astro/new.js'], M: ['index.html'], D: ['_astro/old.js'], R: ['a.html -> b.html'] });
});

test('parseArgs accepts the documented flags and rejects anything else', () => {
  const o = parseArgs(['--dry-run', '--remote=git@github.com:x/y.git', '--dist=/tmp/site', '--allow-data-deletions', '--verify']);
  assert.deepEqual(o, { dryRun: true, remote: 'git@github.com:x/y.git', dist: '/tmp/site', allowDataDeletions: ['data'], verify: true, skipLinkCheck: false, help: false });
  assert.deepEqual(parseArgs([]).allowDataDeletions, []);
  assert.deepEqual(parseArgs(['--allow-data-deletions=data/APo,data/reports']).allowDataDeletions, ['data/APo', 'data/reports']);
  assert.throws(() => parseArgs(['--allow-data-deletions=lemma']), /must be data or lie under data\//);
  assert.throws(() => parseArgs(['--force']), /Unknown option: --force/);
});
