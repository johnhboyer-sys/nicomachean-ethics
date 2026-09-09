// The dictionary is loaded once and cached. A load that fails must not be
// cached as the answer forever — ImportDialog treats a rejected dehyphenate()
// as "dictionary unavailable" and skips hyphen review for the whole import,
// so a single transient failure would silently disable the feature for the
// rest of the session.

import { describe, expect, it, vi } from 'vitest';

const nspellMock = vi.hoisted(() => vi.fn());
vi.mock('nspell', () => ({ default: nspellMock }));
vi.mock('../assets/dict-en/index.aff?raw', () => ({ default: '' }));
vi.mock('../assets/dict-en/index.dic?raw', () => ({ default: '' }));

describe('dehyphenate dictionary cache', () => {
  it('retries the dictionary load after a failure instead of keeping the rejection', async () => {
    const { dehyphenate } = await import('../lib/dehyphenate');
    nspellMock
      .mockImplementationOnce(() => { throw new Error('dictionary load failed'); })
      .mockImplementation(() => ({ correct: (w: string) => w.toLowerCase() === 'understanding' }));

    await expect(dehyphenate('under-\nstanding')).rejects.toThrow('dictionary load failed');
    const second = await dehyphenate('under-\nstanding');
    expect(second.text).toBe('understanding');
    expect(nspellMock).toHaveBeenCalledTimes(2);
  });
});
