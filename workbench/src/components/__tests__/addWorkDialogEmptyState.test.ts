// The Add work… dialog's empty state is not a dead end. When every corpus
// work is already on this Mac it offers "Import a text…" — the same action as
// the library rail's button — instead of stopping at "Every available work is
// already here." Source-scan style, like railWorkListWiring.test.ts: the
// dialog is a Svelte component with no headless DOM here, so what is checked
// mechanically is the wiring — the prop exists, the empty state renders the
// button, the button closes this dialog and opens the import, and App passes
// the same opener the rail gets.
import { beforeAll, describe, expect, it } from 'vitest';

let dialogSource = '';
let appSource = '';

beforeAll(async () => {
  const fs = (await import(/* @vite-ignore */ 'node' + ':fs')) as unknown as {
    readFileSync(path: string, encoding: 'utf-8'): string;
  };
  const nodeUrl = (await import(/* @vite-ignore */ 'node' + ':url')) as unknown as {
    fileURLToPath(url: URL): string;
  };
  const read = (rel: string) =>
    fs.readFileSync(nodeUrl.fileURLToPath(new URL(rel, import.meta.url)), 'utf-8');
  dialogSource = read('../AddWorkDialog.svelte');
  appSource = read('../../App.svelte');
});

describe('Add work… with nothing left to add', () => {
  it('declares the optional onImportSource prop', () => {
    expect(dialogSource).toContain('onImportSource?: () => void;');
  });

  it('offers Import a text… in one plain sentence plus one button', () => {
    expect(dialogSource).toContain(
      '<p class="line">Every available work is already here — to bring in another text, import it.</p>',
    );
    expect(dialogSource).toContain(
      '<button class="folder-btn" onclick={importInstead}>Import a text…</button>',
    );
  });

  it('the button closes this dialog and opens the import', () => {
    expect(dialogSource).toContain('function importInstead() {\n    onClose();\n    onImportSource?.();\n  }');
  });

  it('keeps the bare sentence when no opener is passed', () => {
    expect(dialogSource).toContain('{#if onImportSource}');
    expect(dialogSource).toContain('<p class="line">Every available work is already here.</p>');
  });

  it('App hands the dialog the same opener the rail button gets', () => {
    expect(appSource).toContain('onImportSource={isTauri() ? () => (sourceImportOpen = true) : undefined}');
    const dialogMount = appSource.slice(appSource.indexOf('<AddWorkDialog'));
    expect(dialogMount.slice(0, dialogMount.indexOf('/>'))).toContain(
      'onImportSource={() => (sourceImportOpen = true)}',
    );
  });
});
