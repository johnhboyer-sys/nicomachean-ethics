// flush() must never resolve while an edit is still unsaved with nothing
// scheduled to save it. The edit that lands in the instant a write settles
// (after the loop's last dirty check, before the controller has let go of the
// in-flight promise) is exactly the keystroke a blur/chapter-switch flush is
// there to catch.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAutosave, AUTOSAVE_DEBOUNCE_MS } from '../autosave';
import { MemStorage } from './memStorage';

/** Every write parks on a promise the test resolves by hand. */
class HandStorage extends MemStorage {
  resolvers: Array<() => void> = [];
  override write(workId: string, file: string, content: string): Promise<void> {
    return new Promise<void>((resolve) => {
      this.resolvers.push(() => {
        void super.write(workId, file, content);
        resolve();
      });
    });
  }
}

describe('autosave flush vs a write that is just settling', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('an edit + flush landing as the write resolves is written, not stranded', async () => {
    const storage = new HandStorage();
    let content = 'v1';
    const auto = createAutosave({ workId: 'w', fileName: 'race.md', storage, snapshot: () => content });

    auto.markDirty();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    expect(storage.resolvers).toHaveLength(1);

    // Resolve the write, then act in the very next microtask — after the loop
    // has seen dirty === false and returned, before its cleanup has run.
    storage.resolvers.shift()!();
    await Promise.resolve();
    content = 'v2';
    auto.markDirty();
    const flushed = auto.flush();

    await vi.advanceTimersByTimeAsync(0);
    for (const r of storage.resolvers.splice(0)) r();
    await flushed;
    await vi.advanceTimersByTimeAsync(0);

    expect(storage.files.get('w/race.md')).toBe('v2');
    expect(auto.state).toBe('saved');

    await vi.advanceTimersByTimeAsync(10_000);
    expect(storage.writes).toBe(2);
  });
});
