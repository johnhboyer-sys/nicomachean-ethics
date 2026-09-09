// node --test scripts/__tests__/
// app/scripts/build-lemmata.mjs walks public/data relative to its cwd, so it
// is exercised by spawning it inside a fixture tree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../../app/scripts/build-lemmata.mjs', import.meta.url));

// A data tree with no work that qualifies (only the LSJ shard directory) but
// with a previous run's outputs still on disk — the state an app-only build
// meets when build/dist is present but the pipeline has not produced a work.
test('refuses to run on a data tree with no works and leaves the previous outputs alone', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'build-lemmata-'));
  const data = path.join(root, 'public', 'data');
  mkdirSync(path.join(data, 'lsj'), { recursive: true });
  mkdirSync(path.join(data, 'lemmata'), { recursive: true });
  writeFileSync(path.join(data, 'lemmata.json'), '{"keep":1}');
  writeFileSync(path.join(data, 'lemmata', 'keep.json'), '{}');
  try {
    const r = spawnSync(process.execPath, [SCRIPT], { cwd: root, encoding: 'utf8' });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /refusing/);
    assert.doesNotMatch(r.stderr, /TypeError/);
    assert.equal(readFileSync(path.join(data, 'lemmata.json'), 'utf8'), '{"keep":1}');
    assert.ok(existsSync(path.join(data, 'lemmata', 'keep.json')), 'previous lemma pages were not wiped');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
