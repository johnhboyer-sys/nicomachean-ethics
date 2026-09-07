#!/usr/bin/env node
// Dependency-free link checker for the emitted Astro site (Node 22+).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BASE = '/aristotle-reader';
const MAX_ID_CACHE = 6000;
const MAX_REPORTS = 200;

function usage(message) {
  if (message) console.error(message);
  console.error('Usage: node scripts/check-links.mjs [DIST_DIR | --dist=DIST_DIR]');
  process.exit(2);
}

function getDist() {
  const args = process.argv.slice(2);
  let dist;
  for (const arg of args) {
    if (arg.startsWith('--dist=')) {
      if (dist) usage('Specify the dist directory only once.');
      dist = arg.slice(7);
    } else if (arg.startsWith('-')) {
      usage(`Unknown option: ${arg}`);
    } else if (!dist) {
      dist = arg;
    } else {
      usage('Specify the dist directory only once.');
    }
  }
  return path.resolve(dist || path.resolve(import.meta.dirname, '..', 'app', 'dist'));
}

function decodeEntities(value) {
  return value
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_, n) => String.fromCodePoint(n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : parseInt(n, 10)));
}

function decodePath(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}

function splitReference(reference) {
  const hash = reference.indexOf('#');
  const beforeHash = hash < 0 ? reference : reference.slice(0, hash);
  const fragment = hash < 0 ? null : decodePath(reference.slice(hash + 1));
  const question = beforeHash.indexOf('?');
  return {
    pathname: question < 0 ? beforeHash : beforeHash.slice(0, question),
    query: question < 0 ? '' : beforeHash.slice(question + 1),
    fragment,
  };
}

function isExternal(reference) {
  return /^(?:https?:|mailto:|tel:|\/\/)/i.test(reference);
}

async function existsFile(file) {
  try { return (await fs.stat(file)).isFile(); } catch { return false; }
}

async function* htmlFiles(dir) {
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* htmlFiles(child);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.html')) yield child;
  }
}

function virtualDirectory(dist, source) {
  const relative = path.relative(dist, source);
  return path.dirname(relative) === '.' ? '' : path.dirname(relative);
}

// Crawl a built site and return the tallies plus every broken reference.
// Pure with respect to the process: no argv, no exit — main() owns those, so
// the gate's decisions can be tested against a fixture dist.
export async function checkDist(dist) {
  let pages = 0;
  let links = 0;
  let anchors = 0;
  const broken = [];
  const idCache = new Map();
  const report = (source, href, reason) => broken.push({ source: path.relative(dist, source), href, reason });

  async function idsFor(file) {
    if (idCache.has(file)) {
      const ids = idCache.get(file);
      idCache.delete(file);
      idCache.set(file, ids);
      return ids;
    }
    let html;
    try { html = await fs.readFile(file, 'utf8'); } catch { return null; }
    const ids = new Set();
    for (const match of html.matchAll(/\bid\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi)) {
      ids.add(decodeEntities(match[1] ?? match[2] ?? match[3]));
    }
    idCache.set(file, ids);
    if (idCache.size > MAX_ID_CACHE) idCache.delete(idCache.keys().next().value);
    return ids;
  }

  async function resolve(source, pathname) {
    let relative;
    if (!pathname) return source;
    if (pathname.startsWith('/')) {
      let rooted = decodePath(pathname);
      if (rooted === BASE || rooted === `${BASE}/`) rooted = '/';
      else if (rooted.startsWith(`${BASE}/`)) rooted = rooted.slice(BASE.length);
      relative = rooted.replace(/^\/+/, '');
    } else {
      relative = path.join(virtualDirectory(dist, source), decodePath(pathname));
    }
    relative = path.normalize(relative);
    if (relative === '.') relative = '';
    if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
    const candidate = path.join(dist, relative);
    for (const file of [candidate, path.join(candidate, 'index.html'), `${candidate}.html`]) {
      if (await existsFile(file)) return file;
    }
    return null;
  }

  async function checkTarget(source, raw, href, { nearestLineOk = false, requireBase = false } = {}) {
    const parts = splitReference(href);
    // The site is served under BASE on GitHub Pages, so a root-relative href
    // in emitted HTML that lacks the prefix (`/search`, `/EN/book/1`) is a
    // 404 on live even though it resolves happily against dist/ as root.
    // LSJ shard HTML is exempt: the pipeline cannot know the base, so shards
    // carry base-less paths and every renderer prefixes them at render time
    // (docs/spec-lsj-citations.md, decision 5).
    if (requireBase && parts.pathname.startsWith('/')) {
      const rooted = decodePath(parts.pathname);
      if (rooted !== BASE && !rooted.startsWith(`${BASE}/`)) {
        report(source, raw, `root-relative link lacks the site base ${BASE}`);
        return;
      }
    }
    const target = await resolve(source, parts.pathname);
    if (!target) {
      report(source, raw, 'target does not exist');
      return;
    }
    if (parts.fragment) {
      anchors++;
      const ids = await idsFor(target);
      if (!ids?.has(parts.fragment)) report(source, raw, 'fragment id not found');
    }
    const loc = parts.query.match(/(?:^|&)loc=([^&]*)/i);
    if (loc) {
      anchors++;
      const value = decodePath(loc[1]);
      const match = value.match(/^([^:]+):(\d+)$/);
      if (match) {
        const ids = await idsFor(target);
        if (!ids?.has(`L${match[1]}-${match[2]}`) && !ids?.has(`L${match[1]}-${match[2]}-c`)) {
          // LSJ cites its own editions' lineation, which can differ from ours
          // by a line or two; the reader snaps a missing line to the nearest
          // line in the column. Mirror that contract: the column must exist,
          // the exact line need not.
          const colOk = nearestLineOk && ids
            && (ids.has(`col-${match[1]}`)
              || [...ids].some((id) => id.startsWith(`L${match[1]}-`)));
          if (!colOk) {
            report(source, raw, `Bekker target L${match[1]}-${match[2]} not found`);
          }
        }
      }
    }
  }

  async function checkReference(source, raw, kind, { nearestLineOk = false } = {}) {
    const href = decodeEntities(raw.trim());
    if (!href || href.startsWith('#')) {
      if (href.startsWith('#') && href.length > 1) {
        anchors++;
        const ids = await idsFor(source);
        if (!ids?.has(decodePath(href.slice(1)))) report(source, raw, 'fragment id not found');
      }
      return;
    }
    if (isExternal(href) || (kind !== 'a' && /^data:/i.test(href))) return;
    links++;
    // Emitted HTML always needs the site base; only the LSJ shard pass below,
    // which calls checkTarget directly, is exempt.
    await checkTarget(source, raw, href, { nearestLineOk, requireBase: true });
  }

  for await (const source of htmlFiles(dist)) {
    pages++;
    let html;
    try { html = await fs.readFile(source, 'utf8'); } catch { report(source, '', 'cannot read HTML'); continue; }
    const tags = html.matchAll(/<(a|img|link|script)\b[^>]*>/gi);
    for (const tagMatch of tags) {
      const kind = tagMatch[1].toLowerCase();
      const attribute = (kind === 'img' || kind === 'script') ? 'src' : 'href';
      const attr = new RegExp("\\b" + attribute + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s\"'=<>`]+))", 'i').exec(tagMatch[0]);
      // LSJ citation anchors get the reader's nearest-line contract (see
      // checkTarget); every other link keeps the strict exact-line check.
      const nearestLineOk = kind === 'a' && /\bclass="[^"]*\blsj-bibl\b/.test(tagMatch[0]);
      if (attr) await checkReference(source, attr[1] ?? attr[2] ?? attr[3], kind, { nearestLineOk });
    }
  }

  const lsjDir = path.join(dist, 'data', 'lsj');
  let lsjShards;
  try {
    lsjShards = await fs.readdir(lsjDir, { withFileTypes: true });
  } catch {
    // A dist with pages but no LSJ shards is a broken build, not a skippable
    // case — exiting 0 here would leave every popup citation link unchecked.
    report(lsjDir, '', 'LSJ shard directory missing or unreadable');
    lsjShards = [];
  }
  for (const entry of lsjShards) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.json')) continue;
    const source = path.join(lsjDir, entry.name);
    let shard;
    try {
      shard = JSON.parse(await fs.readFile(source, 'utf8'));
    } catch {
      report(source, '', 'cannot read LSJ shard');
      continue;
    }
    for (const value of Object.values(shard)) {
      if (typeof value?.html !== 'string') continue;
      for (const tagMatch of value.html.matchAll(/<a\b[^>]*>/gi)) {
        const attr = /\bhref="([^"]*)"/i.exec(tagMatch[0]);
        if (!attr) continue;
        const raw = attr[1];
        const href = decodeEntities(raw.trim());
        if (!href || href.startsWith('#') || isExternal(href)) continue;
        links++;
        // Same provenance rule as the HTML crawl: only .lsj-bibl anchors get
        // the reader's nearest-line contract.
        const nearestLineOk = /\bclass="[^"]*\blsj-bibl\b/.test(tagMatch[0]);
        await checkTarget(source, raw, href, { nearestLineOk });
      }
    }
  }

  const indexFile = path.join(dist, 'data', 'lemmata', '_index.json');
  try {
    const entries = JSON.parse(await fs.readFile(indexFile, 'utf8'));
    const indexed = new Set((Array.isArray(entries) ? entries : []).map(entry => typeof entry === 'string' ? entry : entry?.slug).filter(Boolean));
    for (const slug of indexed) {
      const file = path.join(dist, 'lemma', slug, 'index.html');
      if (!await existsFile(file)) report(indexFile, slug, 'lemma index entry has no page');
    }
    try {
      for (const entry of await fs.readdir(path.join(dist, 'lemma'), { withFileTypes: true })) {
        if (entry.isDirectory() && !indexed.has(entry.name)) report(path.join(dist, 'lemma'), entry.name, 'lemma page missing from index');
      }
    } catch { /* A missing lemma directory is covered by indexed entries, if any. */ }
  } catch (error) {
    if (error?.code === 'ENOENT') console.log('Note: data/lemmata/_index.json is absent; skipping lemma cross-check.');
    else report(indexFile, '', 'cannot read lemma index');
  }

  // Curated quotation citations: shape + column existence. A work with no
  // quotations.json is the normal case. Dead sibling URLs are a curation-time
  // responsibility — this gate only checks the row is well-formed.
  const dataDir = path.join(dist, 'data');
  let dataEntries = [];
  try { dataEntries = await fs.readdir(dataDir, { withFileTypes: true }); } catch { dataEntries = []; }
  for (const entry of dataEntries) {
    if (!entry.isDirectory()) continue;
    const workDir = path.join(dataDir, entry.name);
    const qPath = path.join(workDir, 'quotations.json');
    if (!await existsFile(qPath)) continue;
    let rows;
    try { rows = JSON.parse(await fs.readFile(qPath, 'utf8')); } catch {
      report(qPath, '', 'cannot read quotations.json');
      continue;
    }
    if (!Array.isArray(rows)) {
      report(qPath, '', 'quotations.json is not an array');
      continue;
    }
    let columns;
    try { columns = JSON.parse(await fs.readFile(path.join(workDir, 'columns.json'), 'utf8')); } catch {
      report(qPath, '', 'columns.json missing or unreadable');
      continue;
    }
    rows.forEach((row, i) => {
      const href = typeof row?.url === 'string' ? row.url : '';
      if (typeof row?.column !== 'string' || !(row.column in columns)) {
        report(qPath, href, `row ${i}: column not in columns.json`);
      }
      const lo = row?.lo;
      const hi = row?.hi;
      if (!(Number.isInteger(lo) && Number.isInteger(hi) && lo >= 1 && lo <= hi)) {
        report(qPath, href, `row ${i}: expected 1 <= lo <= hi`);
      }
      let absoluteHttps = false;
      if (typeof href === 'string' && /^https:\/\//i.test(href)) {
        try { absoluteHttps = new URL(href).protocol === 'https:'; } catch { absoluteHttps = false; }
      }
      if (!absoluteHttps) {
        report(qPath, href, `row ${i}: url is not an absolute https URL`);
      }
    });
  }

  return { pages, links, anchors, broken };
}

async function main() {
  const dist = getDist();
  let stat;
  try { stat = await fs.stat(dist); } catch { usage(`Dist directory does not exist: ${dist}`); }
  if (!stat.isDirectory()) usage(`Dist path is not a directory: ${dist}`);

  const { pages, links, anchors, broken } = await checkDist(dist);

  // A dist with no pages (or no homepage) is a failed build, not a clean one —
  // this gate must never bless an empty directory.
  if (pages === 0) usage(`No HTML pages found under ${dist} — not a built site.`);
  if (!(await existsFile(path.join(dist, 'index.html')))) {
    usage(`No index.html at the root of ${dist} — not a complete site build.`);
  }

  console.log(`Pages crawled: ${pages}; links checked: ${links}; anchors checked: ${anchors}; broken: ${broken.length}`);
  for (const failure of broken.slice(0, MAX_REPORTS)) console.log(`${failure.source} -> ${failure.href} (${failure.reason})`);
  if (broken.length > MAX_REPORTS) console.log(`+${broken.length - MAX_REPORTS} more`);
  process.exitCode = broken.length ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`Link checker failed: ${error.stack || error}`);
    process.exit(2);
  });
}
