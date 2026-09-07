// Importing a chapter OVER the one you are reading must not leave the editor
// holding the old text.
//
// The sequence: open Metaphysics Α.1, type into it, then Import chapter… →
// Α.1 → "Replace". ImportDialog writes the new file and calls onImported,
// which selects Α.1 — the locus it is already on. The `{#key}` around
// ChapterEditor therefore doesn't change, the editor never remounts, and it
// still holds the pre-import model. Nothing else notices: the sync check that
// would spot the file changing runs on window focus, and no window focus
// happens inside the same app. So the import looks like it worked, the text
// on screen is the old text, and the next keystroke autosaves that back over
// the file just imported.
//
// The fix is the check the focus path already runs: it reloads the editor
// from disk, or asks first when there are unsaved edits (lib/library/sync.ts
// decideReload). Source-scan style — App's wiring can't run headless.
import { beforeAll, describe, expect, it } from 'vitest';

let appSource = '';

beforeAll(async () => {
  const fs = (await import(/* @vite-ignore */ 'node' + ':fs')) as unknown as {
    readFileSync(path: string, encoding: 'utf-8'): string;
  };
  const nodeUrl = (await import(/* @vite-ignore */ 'node' + ':url')) as unknown as {
    fileURLToPath(url: URL): string;
  };
  appSource = fs.readFileSync(
    nodeUrl.fileURLToPath(new URL('../../App.svelte', import.meta.url)),
    'utf-8',
  );
});

function fnBody(name: string): string {
  const start = appSource.indexOf(`function ${name}(`);
  expect(start, `function ${name} exists`).toBeGreaterThan(-1);
  const end = appSource.indexOf('\n  }', start);
  return appSource.slice(start, end);
}

describe('an import that replaces the open chapter', () => {
  it('re-checks the open chapter against the file the import just wrote', () => {
    const body = fnBody('handleImported');
    expect(body).toContain('syncCommands.checkExternalChange()');
  });

  it('does it after the selection has settled, so the editor is the one checked', () => {
    const body = fnBody('handleImported');
    expect(body.indexOf('select(workId, book, chapter)')).toBeLessThan(
      body.indexOf('checkExternalChange'),
    );
    expect(body).toContain('await tick();');
  });

  it('the editor is still keyed on the locus — which is exactly why the check is needed', () => {
    // If this key ever included something that changes on import, the remount
    // would reload the chapter by itself and the check above would be belt on
    // braces rather than the only thing standing there.
    expect(appSource).toContain(
      '{#key `${selection?.workId}:${selection?.book}.${selection?.chapter}`}',
    );
  });
});
