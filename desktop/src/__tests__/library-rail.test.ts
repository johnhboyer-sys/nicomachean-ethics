// The rail's live chapter highlight for works on 1–2-digit Bekker pages
// (Categories 1a–15b, De Interpretatione 16a–24b): a cite like "17a3" must
// resolve to the last chapter starting at or before it, exactly as "1097a15"
// does for the Ethics.

import { render, waitFor } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import LibraryRail from '../components/LibraryRail.svelte';

vi.mock('@shared/lib/data', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shared/lib/data')>();
  return {
    ...actual,
    fetchChapters: vi.fn(async () => ({
      '1': [
        { chapter: '1', column: '16a', line: '1', bekker: '16a1' },
        { chapter: '2', column: '16a', line: '19', bekker: '16a19' },
        { chapter: '3', column: '16b', line: '26', bekker: '16b26' },
        { chapter: '4', column: '16b', line: '33', bekker: '16b33' },
        { chapter: '5', column: '17a', line: '8', bekker: '17a8' },
        { chapter: '6', column: '17a', line: '25', bekker: '17a25' },
      ],
    })),
  };
});

async function activeChapterFor(cite: string): Promise<string | null> {
  const { container, unmount } = render(LibraryRail, {
    props: { currentWork: 'Int', currentBook: 1, currentCite: cite, onOpenWork: vi.fn(), onOpenChapter: vi.fn() },
  });
  await waitFor(() => expect(container.querySelectorAll('.rail-chapter').length).toBe(6));
  const active = container.querySelector('.rail-chapter.active');
  const text = active?.textContent?.trim() ?? null;
  unmount();
  return text;
}

describe('LibraryRail chapter highlight on short Bekker pages', () => {
  it('a lined cite on a two-digit page highlights the chapter that contains it', async () => {
    expect(await activeChapterFor('17a10')).toMatch(/^Ch\. 5\b/);
    expect(await activeChapterFor('16b30')).toMatch(/^Ch\. 3\b/);
  });

  it('a bare two-digit column cite highlights the last chapter starting at or before its line 1', async () => {
    expect(await activeChapterFor('17a')).toMatch(/^Ch\. 4\b/);
  });
});
