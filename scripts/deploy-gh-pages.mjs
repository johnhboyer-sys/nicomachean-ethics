#!/usr/bin/env node
// Deploy app/dist to GitHub Pages the way DEPLOY-STATUS.md says it has to be
// done (dependency-free, Node 22+). Every step below is a trap a past deploy
// fell into; the history entries in DEPLOY-STATUS.md are the evidence.
//
//   npm run deploy         — clone, rsync, restore, leak-check, commit, push
//   npm run deploy:dry     — everything up to the commit; nothing leaves this machine
//
// Flags: --dry-run  --remote=<url>  --dist=<path>
//        --allow-data-deletions[=<prefix>[,<prefix>]]  --verify  --skip-link-check  --help
//
// The pure functions are exported so scripts/__tests__/deploy-gh-pages.test.mjs
// can exercise them without a clone, a dist or a network.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export const LIVE_BASE = 'https://johnhboyer-sys.github.io/aristotle-reader';
export const BRANCH = 'gh-pages';

// Deletions under data/. An app-only build does not emit everything the live
// site serves, so `rsync --delete` stages live-only files for deletion and a
// plain commit would remove a live feature. The first two cases, both found by
// reading the deletion list:
//   data/reports          — pipeline quality reports; untracked in git, only 12 of
//                           88 exist locally (caught 2026-08-19)
//   data/Meta/quotations.json — generated in a worktree on 2026-08-22 and never
//                           landed in the main checkout (caught 2026-08-30)
// The rule they taught, applied since 2026-09-07 without a hand-kept list: a
// deletion under data/ that is a file at gh-pages HEAD is a live-only file
// until proven otherwise. Every such path is restored from the clone's HEAD
// (`git checkout HEAD -- <path>`) after the rsync and reported; a deletion goes
// through only under a prefix named in --allow-data-deletions=<prefix>[,...]
// (a bare --allow-data-deletions allows all of data/). Restore is per deleted
// path, never a whole directory: a full corpus rebuild regenerates data/reports
// itself (2026-08-22), and a blanket checkout would overwrite the fresh reports
// with the stale live ones.

// Gated translations: their translators' names must not appear in served data.
export const LEAK_NAMES = ['Ackrill', 'Tredennick', 'Irwin', 'Rackham'];

// Known benign hits, read in context on every deploy since 2026-07-27. Anything
// beyond these — a new file, or more occurrences in one of these — fails the
// deploy until a human has read it in context and extended this list.
// ("Ackrill" in the Cat/Int landing-page HTML is an in-print citation; it is
// HTML, not data JSON, so this scan never sees it.)
export const KNOWN_BENIGN = [
  { name: 'Rackham', path: 'data/EN/manifest.json', maxOccurrences: 1, why: 'attribution field: H. Rackham (Loeb, 1926), US public domain' },
  { name: 'Rackham', path: 'data/EN/footnotes.json', maxOccurrences: 2, why: "two of Ostwald's own footnotes citing Rackham as an EDITOR of the Greek" },
];

// The leak grep once reported 0 for everything because the shell ate its glob
// (2026-09-01). A scan that cannot find "Aristotle" in the data is not running.
export const POSITIVE_CONTROL = 'Aristotle';

export const DELETION_EXAMPLES_PER_CATEGORY = 12;

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const options = {
    dryRun: false,
    remote: null,
    dist: null,
    allowDataDeletions: [],
    verify: false,
    skipLinkCheck: false,
    help: false,
  };
  for (const arg of argv) {
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--allow-data-deletions') options.allowDataDeletions = ['data'];
    else if (arg.startsWith('--allow-data-deletions=')) options.allowDataDeletions = parseDataPrefixes(arg.slice('--allow-data-deletions='.length));
    else if (arg === '--verify') options.verify = true;
    else if (arg === '--skip-link-check') options.skipLinkCheck = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg.startsWith('--remote=')) options.remote = arg.slice('--remote='.length);
    else if (arg.startsWith('--dist=')) options.dist = arg.slice('--dist='.length);
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

// The prefixes of `--allow-data-deletions=<prefix>[,<prefix>]`, each `data` or
// under `data/` (the audit only ever looks there, so anything else is a typo).
export function parseDataPrefixes(text) {
  const prefixes = text.split(',').map((p) => p.trim().replace(/\/+$/, '')).filter(Boolean);
  if (!prefixes.length) throw new Error('--allow-data-deletions= needs at least one prefix under data/');
  for (const p of prefixes) {
    if (!underPrefix(p, 'data')) throw new Error(`--allow-data-deletions prefix must be data or lie under data/: ${p}`);
  }
  return prefixes;
}

// One line of `rsync -i` output → { op, path } or null for noise.
//   *deleting   data/reports/quality_EN.json
//   >f+++++++++ data/lsj-heads.json          (new file)
//   >f.st...... index.html                   (changed file)
//   cd+++++++++ lemma/new/                   (new directory)
//   .d..t...... lemma/                       (directory attribute only)
export function parseRsyncItemized(text) {
  const result = { deleted: [], added: [], modified: [], other: [] };
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line) continue;
    const deleting = /^\*deleting\s+(.+)$/.exec(line);
    if (deleting) {
      result.deleted.push(deleting[1].replace(/\/$/, ''));
      continue;
    }
    const item = /^([<>ch.*])([fdLDS])(\S{9})\s(.+)$/.exec(line);
    if (!item) continue;
    const [, update, type, flags, itemPath] = item;
    if (type === 'd') continue; // directories carry no content of their own
    if (update === '.') { result.other.push(itemPath); continue; } // attributes only
    if (flags === '+++++++++') result.added.push(itemPath);
    else result.modified.push(itemPath);
  }
  return result;
}

// The category a deploy-diff path is reported under. Reading deletions by
// category, not by count, is what caught both restore cases.
export function categorize(relPath) {
  const p = relPath.replace(/^\.?\/+/, '').replace(/\/$/, '');
  const parts = p.split('/');
  if (parts[0] === '_astro') return '_astro';
  if (parts[0] === 'data') {
    if (parts.length <= 2) return 'data (top-level files)';
    return `data/${parts[1]}`;
  }
  if (p.endsWith('.html')) return parts.length === 1 ? 'pages (root)' : `pages/${parts[0]}`;
  return parts.length === 1 ? '(root files)' : `${parts[0]}/`;
}

// Map of category → sorted paths, categories sorted for stable output.
export function groupByCategory(paths) {
  const groups = new Map();
  for (const p of paths) {
    const category = categorize(p);
    if (!groups.has(category)) groups.set(category, []);
    groups.get(category).push(p);
  }
  const ordered = new Map();
  for (const key of [...groups.keys()].sort((a, b) => a.localeCompare(b))) {
    ordered.set(key, groups.get(key).sort((a, b) => a.localeCompare(b)));
  }
  return ordered;
}

export function formatCategoryReport(groups, { limit = DELETION_EXAMPLES_PER_CATEGORY, indent = '  ' } = {}) {
  const lines = [];
  for (const [category, paths] of groups) {
    lines.push(`${indent}${category}: ${paths.length}`);
    for (const p of paths.slice(0, limit)) lines.push(`${indent}${indent}${p}`);
    if (paths.length > limit) lines.push(`${indent}${indent}+${paths.length - limit} more`);
  }
  return lines;
}

function underPrefix(relPath, prefix) {
  return relPath === prefix || relPath.startsWith(`${prefix}/`);
}

// The fate of rsync's deletions under data/ (the policy at the top of this
// file). `deleted` is rsync's deletion list (files and directories, trailing
// slash already stripped); `liveFiles` the set of paths that are FILES at the
// clone's HEAD (one `git ls-tree -r --name-only` — directories are not in it,
// so a deleted directory is decided through its files); `allowedPrefixes` the
// --allow-data-deletions list, matched on whole path segments. A live file
// under data/ is restored unless an allowed prefix covers it, in which case it
// is deleted. Deletions outside data/ (bundle rehashes, dropped pages) are not
// this audit's business; the deploy diff reports them by category.
export function auditDataDeletions(deleted, liveFiles, allowedPrefixes = []) {
  const restore = [];
  const del = [];
  for (const raw of deleted) {
    const p = raw.replace(/\/$/, '');
    if (!underPrefix(p, 'data') || !liveFiles.has(p)) continue;
    if (allowedPrefixes.some((prefix) => underPrefix(p, prefix))) del.push(p);
    else restore.push(p);
  }
  return { restore, delete: del };
}

// `needle` is never empty (LEAK_NAMES and POSITIVE_CONTROL are literals).
function countOccurrences(text, needle) {
  return text.split(needle).length - 1;
}

// Scan `files` — an iterable of { path, text } (path relative to the site root,
// forward slashes) — for the gated translators' names. Returns a report; the
// caller decides what to do with `ok`. Counts are per FILE, as the grep -l in
// DEPLOY-STATUS.md counted them, with occurrences alongside.
export function scanForLeaks(files, {
  names = LEAK_NAMES,
  benign = KNOWN_BENIGN,
  positiveControl = POSITIVE_CONTROL,
} = {}) {
  const report = {
    ok: true,
    filesScanned: 0,
    control: { name: positiveControl, files: 0 },
    names: Object.fromEntries(names.map((name) => [name, { files: 0, occurrences: 0, hits: [] }])),
    problems: [],
  };
  for (const { path: filePath, text } of files) {
    report.filesScanned++;
    if (text.includes(positiveControl)) report.control.files++;
    for (const name of names) {
      const occurrences = countOccurrences(text, name);
      if (!occurrences) continue;
      const entry = report.names[name];
      entry.files++;
      entry.occurrences += occurrences;
      entry.hits.push({ path: filePath, occurrences });
      const allowed = benign.find((b) => b.name === name && b.path === filePath);
      if (!allowed) {
        report.problems.push(`${name} in ${filePath} (${occurrences} occurrence${occurrences === 1 ? '' : 's'}) — not in KNOWN_BENIGN; read it in context before deploying`);
      } else if (occurrences > allowed.maxOccurrences) {
        report.problems.push(`${name} in ${filePath}: ${occurrences} occurrences, KNOWN_BENIGN allows ${allowed.maxOccurrences} (${allowed.why})`);
      }
    }
  }
  if (report.control.files === 0) {
    report.problems.unshift(`positive control failed: "${positiveControl}" found in 0 of ${report.filesScanned} files — the leak check itself is not running`);
  }
  report.ok = report.problems.length === 0;
  return report;
}

// Removed _astro bundles must be referenced by no page (a dangling reference is
// a page that loads a 404). The added bundles serve as the positive control:
// if none of them is referenced either, the scan is not reading the pages.
export function findDanglingReferences(pages, removedAssets, addedAssets = []) {
  const removed = removedAssets.map((a) => path.posix.basename(a)).filter(Boolean);
  const added = addedAssets.map((a) => path.posix.basename(a)).filter(Boolean);
  const dangling = new Map();
  const controlSeen = new Set();
  let pagesScanned = 0;
  for (const { path: pagePath, text } of pages) {
    pagesScanned++;
    for (const name of removed) {
      if (!text.includes(name)) continue;
      if (!dangling.has(name)) dangling.set(name, []);
      dangling.get(name).push(pagePath);
    }
    for (const name of added) if (text.includes(name)) controlSeen.add(name);
  }
  const problems = [];
  for (const [name, refs] of dangling) {
    problems.push(`removed bundle ${name} is still referenced by ${refs.length} page${refs.length === 1 ? '' : 's'} (e.g. ${refs[0]})`);
  }
  if (added.length && controlSeen.size === 0 && pagesScanned) {
    problems.unshift(`positive control failed: none of the ${added.length} added bundles is referenced by any of ${pagesScanned} pages — the reference scan is not reading the pages`);
  }
  return { ok: problems.length === 0, pagesScanned, dangling, controlSeen: [...controlSeen], problems };
}

// The post-deploy checks every entry in DEPLOY-STATUS.md records.
export function verificationTargets({ lemmaSlug = 'logos', assets = [], removedAssets = [] } = {}, base = LIVE_BASE) {
  const targets = [
    { path: '/', expect: 200 },
    { path: '/EN/book/1/', expect: 200 },
    { path: `/lemma/${lemmaSlug}/`, expect: 200 },
    { path: '/data/lsj-heads.json', expect: 200 },
    { path: '/data/Meta/quotations.json', expect: 200 },
    { path: '/data/reports/quality_EN.json', expect: 200 },
  ];
  for (const a of assets) targets.push({ path: `/_astro/${path.posix.basename(a)}`, expect: 200 });
  for (const a of removedAssets) targets.push({ path: `/_astro/${path.posix.basename(a)}`, expect: 404 });
  targets.push({ path: '/bonitz/', expect: 404 });
  return targets.map((t) => ({ ...t, url: `${base}${t.path}` }));
}

export function commitMessage({ sourceSha, sourceBranch, summary }) {
  const short = sourceSha.slice(0, 10);
  const lines = [`Deploy ${short} (${sourceBranch})`, '', `Source: ${sourceSha} on ${sourceBranch}`, `Built by scripts/deploy-gh-pages.mjs`];
  if (summary) lines.push('', summary);
  return lines.join('\n');
}

// Parse `git diff --cached --name-status` into { A, M, D, R } → paths.
export function parseNameStatus(text) {
  const result = { A: [], M: [], D: [], R: [] };
  for (const line of text.split('\n')) {
    if (!line) continue;
    const [status, ...rest] = line.split('\t');
    const code = status[0];
    if (code === 'R') result.R.push(`${rest[0]} -> ${rest[1]}`);
    else if (code in result) result[code].push(rest[0]);
  }
  return result;
}

// ---------------------------------------------------------------------------
// IO helpers
// ---------------------------------------------------------------------------

function run(command, args, { cwd = ROOT, capture = false, env = {} } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error) throw new Error(`${command} ${args.join(' ')}: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = capture ? `\n${(result.stderr || '').trim()}` : '';
    throw new Error(`${command} ${args.join(' ')} failed with status ${result.status}${detail}`);
  }
  return capture ? result.stdout : '';
}

function git(args, options = {}) {
  return run('git', args, { capture: true, ...options }).trim();
}

// The paths that are files at the clone's HEAD under the data/ subtrees
// `deleted` touches — one ls-tree per deploy, where a `git cat-file -e` per
// restored path was ~90 spawns. NUL-separated so a non-ASCII name is not
// quoted. Without a pathspec ls-tree would list the whole tree, so no data/
// deletion means an empty set without a spawn.
function liveDataFiles(clone, deleted) {
  const prefixes = new Set();
  for (const raw of deleted) {
    const p = raw.replace(/\/$/, '');
    if (!underPrefix(p, 'data')) continue;
    const parts = p.split('/');
    prefixes.add(parts.length >= 2 ? `${parts[0]}/${parts[1]}` : parts[0]);
  }
  if (!prefixes.size) return new Set();
  const out = run('git', ['ls-tree', '-r', '-z', '--name-only', 'HEAD', '--', ...prefixes], { cwd: clone, capture: true });
  return new Set(out.split('\0').filter(Boolean));
}

function hasCommand(name) {
  const result = spawnSync(name, ['--version'], { stdio: 'ignore' });
  return !result.error;
}

function* walk(dir, filter, base = dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (entry.name === '.git') continue;
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(child, filter, base);
    else if (entry.isFile() && filter(entry.name)) {
      yield { path: path.relative(base, child).split(path.sep).join('/'), file: child };
    }
  }
}

function* readAll(entries) {
  for (const { path: relPath, file } of entries) {
    yield { path: relPath, text: readFileSync(file, 'utf8') };
  }
}

class Refusal extends Error {}

function fail(message) {
  throw new Refusal(message);
}

function heading(text) {
  console.log(`\n== ${text}`);
}

function usage() {
  console.log(`Usage: node scripts/deploy-gh-pages.mjs [--dry-run] [--remote=<url>] [--dist=<path>]
                                        [--allow-data-deletions[=<prefix>[,<prefix>]]] [--verify] [--skip-link-check]

  --dry-run               clone, rsync into the temp clone, restore, leak-check, report;
                          no commit, no push
  --remote=<url>          gh-pages remote (default: this repo's origin)
  --dist=<path>           built site (default: app/dist)
  --allow-data-deletions  let deletions under data/ through instead of restoring them from
                          gh-pages HEAD; =<prefix>[,<prefix>] limits that to those prefixes
                          (each data or under data/), bare means all of data/
  --verify                after pushing, poll the live URLs until they answer as expected
  --skip-link-check       do not run scripts/check-links.mjs on the dist first`);
}

export async function verifyLive(targets, { attempts = 12, delayMs = 15000, fetchImpl = globalThis.fetch, log = console.log } = {}) {
  let pending = targets;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const still = [];
    for (const target of pending) {
      let status;
      try {
        const response = await fetchImpl(target.url, { method: 'GET', cache: 'no-store', redirect: 'manual' });
        status = response.status;
      } catch (error) {
        status = `error: ${error.message}`;
      }
      if (status === target.expect) log(`  ${status} ${target.url}`);
      else still.push({ ...target, last: status });
    }
    pending = still;
    if (!pending.length) return { ok: true, pending: [] };
    log(`  attempt ${attempt}/${attempts}: ${pending.length} not yet as expected` + (attempt < attempts ? `, retrying in ${Math.round(delayMs / 1000)} s` : ''));
    for (const t of pending) log(`    got ${t.last}, want ${t.expect}: ${t.url}`);
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return { ok: false, pending };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  let options;
  try { options = parseArgs(process.argv.slice(2)); } catch (error) { console.error(error.message); usage(); process.exit(2); }
  if (options.help) { usage(); return; }

  const dist = path.resolve(options.dist ?? path.join(ROOT, 'app', 'dist'));
  const mode = options.dryRun ? 'DRY RUN' : 'DEPLOY';
  heading(`${mode}: ${dist} → ${BRANCH}`);

  // 1. Preconditions -------------------------------------------------------
  heading('Preconditions');
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor < 22) fail(`Node ${process.versions.node}; the build and this script need Node 22 (app/ engines reject 24 as well).`);
  if (!existsSync(dist) || !statSync(dist).isDirectory()) {
    fail(`${dist} does not exist. Build it first: cd app && PUBLIC_SHOW_PRIVATE=0 npm run build (Node 22).`);
  }
  if (!existsSync(path.join(dist, 'index.html'))) fail(`${dist} has no index.html — not a built site.`);
  if (existsSync(path.join(dist, 'bonitz'))) {
    fail(`${path.join(dist, 'bonitz')} exists. /bonitz/ must stay a 404 on live; the page was removed from app/ on 2026-09-03 — do not resurrect it.`);
  }
  const astroDir = path.join(dist, '_astro');
  const astroAssets = existsSync(astroDir) ? readdirSync(astroDir) : [];
  const bonitzAssets = astroAssets.filter((name) => name.startsWith('bonitz.'));
  if (bonitzAssets.length) fail(`${dist}/_astro carries ${bonitzAssets.join(', ')} — a build that emitted the bonitz page. Rebuild.`);
  const showPrivate = process.env.PUBLIC_SHOW_PRIVATE;
  if (showPrivate && showPrivate !== '0') {
    fail(`PUBLIC_SHOW_PRIVATE=${showPrivate} is set in this shell, so the dist was probably built with the private translations in. Rebuild with PUBLIC_SHOW_PRIVATE=0 and unset it here.`);
  }
  if (!hasCommand('git')) fail('git is not on PATH.');
  if (!hasCommand('rsync')) fail('rsync is not on PATH; the deploy is an rsync into a fresh gh-pages clone.');
  const sourceSha = git(['rev-parse', 'HEAD']);
  const sourceBranch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const dirty = git(['status', '--porcelain', '--untracked-files=no']);
  console.log(`  source: ${sourceSha} (${sourceBranch})${dirty ? ' — WORKING TREE HAS UNCOMMITTED CHANGES' : ''}`);
  if (sourceBranch !== 'main') console.log(`  note: deploying from ${sourceBranch}, not main — valid only if origin/main has not moved since the fork (see DEPLOY-STATUS.md 2026-09-01).`);
  const remote = options.remote ?? git(['remote', 'get-url', 'origin']);
  console.log(`  remote: ${remote}`);
  console.log(`  dist: ${dist} (${astroAssets.length} _astro assets)`);

  if (!options.skipLinkCheck) {
    heading('Link integrity (must be 0 broken)');
    try {
      run('node', [path.join(ROOT, 'scripts', 'check-links.mjs'), dist]);
    } catch (error) {
      fail(`link check did not pass: ${error.message}`);
    }
  } else {
    console.log('\n  link check SKIPPED (--skip-link-check); the gate is still 0 broken before pushing.');
  }

  // 2. Fresh shallow clone --------------------------------------------------
  heading(`Fresh shallow clone of ${BRANCH}`);
  const tmp = mkdtempSync(path.join(tmpdir(), 'aristotle-gh-pages-'));
  const clone = path.join(tmp, 'gh-pages');
  let keepTmp = true;
  try {
    run('git', ['clone', '--depth', '1', '--branch', BRANCH, remote, clone]);
    const liveSha = git(['rev-parse', '--short=8', 'HEAD'], { cwd: clone });
    console.log(`  ${BRANCH} at ${liveSha} in ${clone}`);

    // 3. rsync dry run, deletions by category ------------------------------
    heading('rsync dry run — deletions BY CATEGORY');
    const rsyncArgs = ['-a', '--delete', '--exclude=.git', '--exclude=.DS_Store', `${dist}${path.sep}`, `${clone}${path.sep}`];
    const itemized = parseRsyncItemized(run('rsync', ['-n', '-i', ...rsyncArgs], { capture: true }));
    console.log(`  rsync would add ${itemized.added.length}, change ${itemized.modified.length}, delete ${itemized.deleted.length}`);
    if (itemized.deleted.length) {
      for (const line of formatCategoryReport(groupByCategory(itemized.deleted))) console.log(line);
    } else {
      console.log('  (no deletions)');
    }
    const audit = auditDataDeletions(itemized.deleted, liveDataFiles(clone, itemized.deleted), options.allowDataDeletions);
    console.log(`  live files under data/ to restore after rsync (every one is a live-only file until proven otherwise): ${audit.restore.length}`);
    if (audit.delete.length) {
      console.log(`  live files under data/ let through by --allow-data-deletions=${options.allowDataDeletions.join(',')} — these WILL be deleted from live: ${audit.delete.length}`);
      for (const line of formatCategoryReport(groupByCategory(audit.delete))) console.log(line);
    }

    // 4. Real rsync + restore ----------------------------------------------
    heading('rsync into the clone');
    run('rsync', rsyncArgs);
    if (audit.restore.length) {
      for (let i = 0; i < audit.restore.length; i += 200) {
        run('git', ['checkout', 'HEAD', '--', ...audit.restore.slice(i, i + 200)], { cwd: clone, capture: true });
      }
      console.log(`  restored ${audit.restore.length} live file(s) from ${BRANCH} HEAD:`);
      for (const line of formatCategoryReport(groupByCategory(audit.restore), { indent: '    ' })) console.log(line);
    } else {
      console.log('  nothing to restore (no deletion under data/ is a file at HEAD)');
    }

    // 5. Leak check on the clone's data JSON -------------------------------
    heading('Leak check: data/**/*.json in the clone');
    const dataDir = path.join(clone, 'data');
    const dataFiles = readAll(walk(dataDir, (name) => name.toLowerCase().endsWith('.json'), clone));
    const leak = scanForLeaks(dataFiles);
    console.log(`  files scanned: ${leak.filesScanned}; positive control "${leak.control.name}": ${leak.control.files} files`);
    for (const [name, entry] of Object.entries(leak.names)) {
      const where = entry.hits.map((h) => `${h.path}×${h.occurrences}`).join(', ');
      console.log(`  ${name}: ${entry.files} file(s)${entry.files ? ` — ${where}` : ''}`);
    }
    if (!leak.ok) {
      for (const problem of leak.problems) console.log(`  !! ${problem}`);
      fail('leak check did not pass.');
    }

    // 6. Stage and read the deploy diff by category ------------------------
    heading('Deploy diff (after restore)');
    run('git', ['add', '-A'], { cwd: clone, capture: true });
    const diff = parseNameStatus(git(['diff', '--cached', '--name-status'], { cwd: clone }));
    const total = diff.A.length + diff.M.length + diff.D.length + diff.R.length;
    console.log(`  ${total} files — ${diff.A.length} A / ${diff.M.length} M / ${diff.D.length} D / ${diff.R.length} R`);
    for (const code of ['A', 'D', 'R']) {
      if (!diff[code].length) continue;
      console.log(`  ${code}:`);
      for (const line of formatCategoryReport(groupByCategory(diff[code].map((p) => p.split(' -> ').pop())), { indent: '    ' })) console.log(line);
    }
    if (diff.M.length) {
      console.log('  M by category:');
      for (const [category, paths] of groupByCategory(diff.M)) console.log(`      ${category}: ${paths.length}`);
    }

    const removedAssets = diff.D.filter((p) => p.startsWith('_astro/'));
    const addedAssets = diff.A.filter((p) => p.startsWith('_astro/'));
    if (removedAssets.length) {
      heading('Dangling references to removed bundles (must be 0)');
      const pages = readAll(walk(clone, (name) => name.toLowerCase().endsWith('.html'), clone));
      const refs = findDanglingReferences(pages, removedAssets, addedAssets);
      console.log(`  pages scanned: ${refs.pagesScanned}; removed bundles: ${removedAssets.length}; positive control: ${refs.controlSeen.length}/${addedAssets.length} added bundles referenced`);
      if (!refs.ok) {
        for (const problem of refs.problems) console.log(`  !! ${problem}`);
        fail('removed bundles are still referenced.');
      }
    }

    const lemmaDir = path.join(dist, 'lemma');
    const lemmaSlug = existsSync(path.join(lemmaDir, 'logos', 'index.html')) || !existsSync(lemmaDir)
      ? 'logos'
      : (readdirSync(lemmaDir, { withFileTypes: true }).find((e) => e.isDirectory())?.name ?? 'logos');
    const targets = verificationTargets({
      lemmaSlug,
      assets: astroAssets.filter((name) => /^(global\..*\.css|Reader\..*\.js)$/.test(name)),
      removedAssets,
    });

    if (total === 0) {
      heading('Nothing to deploy');
      console.log(`  the clone matches the dist after restore; ${BRANCH} stays at ${liveSha}.`);
      keepTmp = false;
      return;
    }

    if (options.dryRun) {
      heading('DRY RUN complete — no commit, no push');
      console.log(`  clone left at ${clone} for inspection (delete it when done).`);
      console.log('  post-deploy checks a real run would print:');
      for (const t of targets) console.log(`    ${t.expect} ${t.url}`);
      return;
    }

    // 7. Commit and push ---------------------------------------------------
    heading('Commit and push');
    const summary = `${total} files: ${diff.A.length} A / ${diff.M.length} M / ${diff.D.length} D / ${diff.R.length} R; restored ${audit.restore.length}`;
    run('git', ['commit', '--quiet', '-m', commitMessage({ sourceSha, sourceBranch, summary })], { cwd: clone, capture: true });
    run('git', ['push', 'origin', `HEAD:${BRANCH}`], { cwd: clone });
    const newSha = git(['rev-parse', '--short=8', 'HEAD'], { cwd: clone });
    console.log(`  ${BRANCH}: ${liveSha} → ${newSha}; source ${sourceSha.slice(0, 10)} (${sourceBranch})`);
    keepTmp = false;

    heading('Post-deploy verification (GitHub Pages publishes in ~70–90 s)');
    for (const t of targets) console.log(`  expect ${t.expect}: ${t.url}`);
    if (options.verify) {
      console.log('\n  --verify: polling');
      const outcome = await verifyLive(targets);
      if (!outcome.ok) {
        console.log(`  ${outcome.pending.length} URL(s) never answered as expected; check them by hand before recording the deploy.`);
        process.exitCode = 1;
      } else {
        console.log('  all live URLs answer as expected.');
      }
    } else {
      console.log('  (re-run with --verify to poll these, or check them by hand.)');
    }
    console.log(`\n  Record this deploy at the top of DEPLOY-STATUS.md: ${BRANCH} ${liveSha} → ${newSha}, source ${sourceSha.slice(0, 10)}, the diff above, and what you verified live.`);
  } finally {
    if (!keepTmp) rmSync(tmp, { recursive: true, force: true });
    else if (!options.dryRun) console.error(`  temp clone kept for inspection: ${clone}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    if (error instanceof Refusal) console.error(`\nDEPLOY REFUSED: ${error.message}`);
    else console.error(`\nDeploy failed: ${error.stack || error}`);
    process.exit(1);
  });
}
