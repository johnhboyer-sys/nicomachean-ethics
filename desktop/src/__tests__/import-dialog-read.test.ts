// Picking a file the app cannot read (a Latin-1 OCR .txt is the common case:
// Tauri's readTextFile rejects anything that is not valid UTF-8) must tell
// the user in a sentence, not fail silently inside an un-awaited promise.

import { fireEvent, render, screen } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from '@tauri-apps/plugin-fs';
import * as dialog from '@tauri-apps/plugin-dialog';
import ImportDialog from '../components/ImportDialog.svelte';

vi.mock('../lib/imports', () => ({
  runImport: vi.fn(),
  ImportCollision: class extends Error {},
  DivisionGapError: class extends Error {},
}));

beforeEach(() => {
  (window as unknown as { __TAURI_INTERNALS__: object }).__TAURI_INTERNALS__ = {};
});

describe('ImportDialog file reading failures', () => {
  it('shows a plain sentence when the picked file is not UTF-8 text', async () => {
    vi.mocked(dialog.open).mockResolvedValue('/Users/me/Scans/rackham.txt');
    vi.mocked(fs.readTextFile).mockRejectedValue(new Error('stream did not contain valid UTF-8'));
    render(ImportDialog, { props: { file: null, presetWork: 'EN', onClose: vi.fn() } });

    await fireEvent.click(screen.getByRole('button', { name: /Drop a .txt or .md file here/ }));

    const msg = await screen.findByText(/rackham\.txt/);
    expect(msg.textContent).toMatch(/not UTF-8/i);
    expect(msg.textContent).toMatch(/save it as UTF-8/i);
    expect(msg.textContent).not.toMatch(/stream did not contain/);
  });

  it('shows the reason when the picked file cannot be opened at all', async () => {
    vi.mocked(dialog.open).mockResolvedValue('/Volumes/Gone/ethics.md');
    vi.mocked(fs.readTextFile).mockRejectedValue(new Error('No such file or directory (os error 2)'));
    render(ImportDialog, { props: { file: null, presetWork: 'EN', onClose: vi.fn() } });

    await fireEvent.click(screen.getByRole('button', { name: /Drop a .txt or .md file here/ }));

    const msg = await screen.findByText(/ethics\.md/);
    expect(msg.textContent).toMatch(/Could not read/);
    expect(msg.textContent).toMatch(/No such file or directory/);
  });
});
