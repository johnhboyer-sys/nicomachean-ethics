// Corpus audit for buildFormsBlock — the gate every forms-block change on the
// LSJ track is measured against (HANDOFF-LSJ §3, §6).
//
// Renders every entry in an LSJ shard directory (build/dist/lsj/*.json, each a
// Record<key, { key, head, html }>) through renderLsjEntry twice: once from
// the WORKING TREE's shared/lib/html.ts and once from the same file at a git
// ref, both transpiled with esbuild. Reports, for both:
//
//   changed          entries whose rendered html differs between the two
//   head-in-label    entries whose FIRST form label contains the headword
//   non-ws chars     total non-whitespace characters of rendered text
//                    (tags stripped) — must never go down for any entry
//   unbalanced       entries whose rendered html has an open/close mismatch
//                    for some tag name
//   tables / rows    entries that render a forms block, and rows in total
//
// and lists any entry that lost non-whitespace characters, which is the one
// result that fails the gate outright.
//
// Usage:  node shared/scripts/audit-forms-block.mjs <git-ref> <path-to-lsj-dir>
//         node shared/scripts/audit-forms-block.mjs HEAD build/dist/lsj
//
// Run from anywhere: paths are resolved from this file's location. Needs
// shared/node_modules/esbuild (installed with shared's devDependencies).

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { transformSync } from 'esbuild';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const SOURCE = 'shared/lib/html.ts';
// Reach the internals as the handoff describes, for anyone extending this.
const EXPORT_INTERNALS = '\nexport { plainLabel, splitOnSeparators, LABELISH };\n';

function usage(code) {
  console.error('usage: node shared/scripts/audit-forms-block.mjs <git-ref> <path-to-lsj-dir>');
  console.error('       e.g. node shared/scripts/audit-forms-block.mjs HEAD build/dist/lsj');
  process.exit(code);
}

const [ref, dirArg] = process.argv.slice(2);
if (!ref || !dirArg) usage(2);
const dir = resolve(dirArg);
if (!existsSync(dir) || !statSync(dir).isDirectory()) {
  console.error(`audit-forms-block: no such directory: ${dir}`);
  usage(2);
}
const shards = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
if (!shards.length) {
  console.error(`audit-forms-block: no *.json shards in ${dir}`);
  usage(2);
}

// ── the two renderers ───────────────────────────────────────────────────────
const work = mkdtempSync(join(tmpdir(), 'audit-forms-block-'));
async function load(name, source) {
  const { code } = transformSync(source + EXPORT_INTERNALS, { loader: 'ts', format: 'esm', target: 'node20' });
  const file = join(work, `${name}.mjs`);
  writeFileSync(file, code);
  return import(pathToFileURL(file).href);
}
const treeSource = readFileSync(join(REPO, SOURCE), 'utf8');
let refSource;
try {
  refSource = execFileSync('git', ['show', `${ref}:${SOURCE}`], { cwd: REPO, encoding: 'utf8', maxBuffer: 64 << 20 });
} catch (err) {
  console.error(`audit-forms-block: git show ${ref}:${SOURCE} failed: ${err.message.split('\n')[0]}`);
  process.exit(2);
}
const before = await load('before', refSource);
const after = await load('after', treeSource);

// ── measures ────────────────────────────────────────────────────────────────
const text = (html) => html.replace(/<[^>]*>/g, ' ');
const nonWs = (html) => text(html).replace(/\s/g, '').length;
const decode = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const firstLabel = (html) => {
  const m = /class="lsj-form-label">([^<]*)</.exec(html);
  return m ? decode(m[1]) : null;
};
const headOf = (html, entry) => {
  const m = /<b class="lsj-head">([\s\S]*?)<\/b>/.exec(html);
  return (m ? text(m[1]).replace(/\s+/g, ' ').trim() : '') || entry.head || '';
};
const headInLabel = (html, entry) => {
  const label = firstLabel(html);
  const head = headOf(html, entry);
  return label !== null && head !== '' && label.includes(head);
};
const rowsOf = (html) => (html.match(/<div class="lsj-form">/g) ?? []).length;
const unbalanced = (html) => {
  const depth = new Map();
  const re = /<(\/?)([a-z][\w-]*)[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[2].toLowerCase();
    if (tag === 'br') continue;
    depth.set(tag, (depth.get(tag) ?? 0) + (m[1] ? -1 : 1));
  }
  return [...depth.values()].some((n) => n !== 0);
};

const tally = () => ({ entries: 0, headInLabel: 0, nonWs: 0, unbalanced: 0, tables: 0, rows: 0 });
const b = tally();
const a = tally();
let changed = 0;
const changedKeys = [];
const lost = [];
const tablesLost = [];
const tablesGained = [];
const measure = (t, html, entry) => {
  t.entries += 1;
  if (headInLabel(html, entry)) t.headInLabel += 1;
  t.nonWs += nonWs(html);
  if (unbalanced(html)) t.unbalanced += 1;
  const rows = rowsOf(html);
  if (rows) { t.tables += 1; t.rows += rows; }
  return rows;
};

for (const f of shards) {
  const shard = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  for (const [key, value] of Object.entries(shard)) {
    const entry = typeof value === 'string' ? { key, html: value } : { key, ...value };
    if (typeof entry.html !== 'string') continue;
    const oldHtml = before.renderLsjEntry(entry.html);
    const newHtml = after.renderLsjEntry(entry.html);
    const oldRows = measure(b, oldHtml, entry);
    const newRows = measure(a, newHtml, entry);
    if (oldHtml !== newHtml) {
      changed += 1;
      if (changedKeys.length < 20) changedKeys.push(key);
      if (oldRows && !newRows) tablesLost.push(key);
      if (!oldRows && newRows) tablesGained.push(key);
    }
    const delta = nonWs(newHtml) - nonWs(oldHtml);
    if (delta < 0) lost.push({ key, delta });
  }
}
rmSync(work, { recursive: true, force: true });

// ── report ──────────────────────────────────────────────────────────────────
const pad = (s, n) => String(s).padStart(n);
console.log(`audit-forms-block: ${b.entries} entries in ${shards.length} shard(s) from ${dir}`);
console.log(`  ${pad('', 16)}${pad(ref, 12)}${pad('working tree', 14)}`);
const line = (label, x, y) => console.log(`  ${label.padEnd(16)}${pad(x, 12)}${pad(y, 14)}`);
line('head-in-label', b.headInLabel, a.headInLabel);
line('non-ws chars', b.nonWs, a.nonWs);
line('unbalanced', b.unbalanced, a.unbalanced);
line('tables', b.tables, a.tables);
line('rows', b.rows, a.rows);
console.log(`  changed          ${changed}` + (changedKeys.length ? `  (${changedKeys.join(', ')}${changed > changedKeys.length ? ', …' : ''})` : ''));
console.log(`  tables lost      ${tablesLost.length}` + (tablesLost.length ? `  (${tablesLost.slice(0, 20).join(', ')}${tablesLost.length > 20 ? ', …' : ''})` : ''));
console.log(`  tables gained    ${tablesGained.length}` + (tablesGained.length ? `  (${tablesGained.slice(0, 20).join(', ')}${tablesGained.length > 20 ? ', …' : ''})` : ''));
if (lost.length) {
  console.log(`  LOST CHARACTERS  ${lost.length} entries — the gate FAILS:`);
  for (const { key, delta } of lost.slice(0, 50)) console.log(`    ${key} ${delta}`);
  process.exit(1);
}
console.log('  lost characters  0');
