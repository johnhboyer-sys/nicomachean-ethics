// Two degraded states that told the user nothing. House rule (John is not a
// programmer): every failure is ONE plain sentence in the dialog, and the
// technical detail goes to the console.
//
// 1. Export whole work… reads every saved chapter file of the work. A file it
//    cannot parse — a conflicted copy from Drive, a half-written file, a hand
//    edit — was skipped with a console.error and NOTHING else. The gap summary
//    counted the rest as complete, the export ran, and the Word document came
//    out silently missing a chapter.
//
// 2. Import a text… → "Choose a TEI file…" awaited the native picker and the
//    file read with no catch at all. When either rejected (a file outside the
//    app's allowed fs scope is the ordinary case) the rejection went nowhere:
//    the button appeared to do nothing and the dialog went on saying "Choose a
//    TEI file first." Same for "Choose your TLG folder…".
//
// Source-scan style: both are Tauri-only paths that can't run headless.
import { beforeAll, describe, expect, it } from 'vitest';

let compileSource = '';
let importSource = '';

beforeAll(async () => {
  const fs = (await import(/* @vite-ignore */ 'node' + ':fs')) as unknown as {
    readFileSync(path: string, encoding: 'utf-8'): string;
  };
  const nodeUrl = (await import(/* @vite-ignore */ 'node' + ':url')) as unknown as {
    fileURLToPath(url: URL): string;
  };
  const read = (rel: string) =>
    fs.readFileSync(nodeUrl.fileURLToPath(new URL(rel, import.meta.url)), 'utf-8');
  compileSource = read('../CompileDialog.svelte');
  importSource = read('../SourceImportDialog.svelte');
});

function fnBody(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  expect(start, `function ${name} exists`).toBeGreaterThan(-1);
  const end = source.indexOf('\n  }', start);
  return source.slice(start, end);
}

describe('Export whole work…: a chapter that could not be read is named, not just skipped', () => {
  it('collects the skipped files instead of only logging them', () => {
    const body = fnBody(compileSource, 'loadChapters');
    expect(body).toContain('const skipped: string[] = [];');
    expect(body).toContain('skipped.push(file);');
    expect(body).toContain('console.error(`[compile] skipping unreadable chapter file ${file}`, err);');
  });

  it('says so in the dialog, in one plain sentence, before the export runs', () => {
    const body = fnBody(compileSource, 'loadChapters');
    expect(body).toContain('One chapter file couldn’t be read');
    expect(body).toContain('chapter files couldn’t be read');
    expect(body).toContain('will be left out');
    // No filenames-only jargon dump: the singular case names the one file, the
    // plural case gives a count.
    expect(body).toContain('skipped.length === 0');
  });

  it('the note is rendered where the user is deciding', () => {
    expect(compileSource).toContain('{#if note}\n            <p class="line note">{note}</p>');
  });
});

describe('Import a text…: a picker or a read that fails says so', () => {
  it('the TEI file button handles its own rejections', () => {
    const body = fnBody(importSource, 'pickTeiFile');
    expect(body).toContain('try {');
    expect(body).toContain('catch (err)');
    expect(body).toContain("messageOf(err, 'That file could not be read.')");
    // Both awaits are inside the guard, not just the read.
    expect(body.indexOf('try {')).toBeLessThan(body.indexOf("import('@tauri-apps/plugin-dialog')"));
  });

  it('the disc-folder button handles its own rejections', () => {
    const body = fnBody(importSource, 'chooseDisc');
    expect(body).toContain('catch (err)');
    expect(body).toContain("messageOf(err, 'That folder could not be opened.')");
    // A cancelled picker is still not a failure.
    expect(body).toContain('if (picked === null) return;');
  });

  it('every message goes through messageOf, which keeps one sentence', () => {
    expect(importSource).toContain("function messageOf(err: unknown, fallback: string): string");
    for (const [, fallback] of importSource.matchAll(/messageOf\(err, '([^']+)'\)/g)) {
      expect(fallback.endsWith('.')).toBe(true);
    }
  });
});
