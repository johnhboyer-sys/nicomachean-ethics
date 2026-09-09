import { describe, expect, it, vi } from 'vitest';
import { memoAsync, memoAsyncBy } from '../lib/memo';

/** A promise whose settlement this test controls. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Let every queued microtask (including the memo's own eviction) run. */
const flush = () => new Promise<void>(r => setTimeout(r, 0));

describe('memoAsync', () => {
  it('caches a success: two calls share one run', async () => {
    const make = vi.fn(async () => 'value');
    const memo = memoAsync(make);

    await expect(memo()).resolves.toBe('value');
    await expect(memo()).resolves.toBe('value');
    expect(make).toHaveBeenCalledTimes(1);
  });

  it('shares one run between concurrent callers', async () => {
    const d = deferred<string>();
    const make = vi.fn(() => d.promise);
    const memo = memoAsync(make);

    const a = memo();
    const b = memo();
    expect(a).toBe(b);                       // literally the same promise
    d.resolve('value');
    expect(await Promise.all([a, b])).toEqual(['value', 'value']);
    expect(make).toHaveBeenCalledTimes(1);
  });

  it('does not cache a rejection: the next call retries, and the caller sees the original error', async () => {
    const make = vi.fn()
      .mockImplementationOnce(() => Promise.reject(new Error('boom')))
      .mockImplementationOnce(() => Promise.resolve('value'));
    const memo = memoAsync(make);

    await expect(memo()).rejects.toThrow('boom');
    await expect(memo()).resolves.toBe('value');
    // …and the replacement is itself cached.
    await expect(memo()).resolves.toBe('value');
    expect(make).toHaveBeenCalledTimes(2);
  });
});

describe('memoAsyncBy', () => {
  it('runs make once per key and passes the key through', async () => {
    const make = vi.fn(async (key: string) => `v:${key}`);
    const memo = memoAsyncBy(make);

    await expect(memo('a')).resolves.toBe('v:a');
    await expect(memo('a')).resolves.toBe('v:a');
    await expect(memo('b')).resolves.toBe('v:b');
    expect(make).toHaveBeenCalledTimes(2);
    expect(make.mock.calls.map(c => c[0])).toEqual(['a', 'b']);
  });

  it('shares one run between concurrent callers of the same key', async () => {
    const d = deferred<string>();
    const make = vi.fn(() => d.promise);
    const memo = memoAsyncBy(make);

    const a = memo('k');
    const b = memo('k');
    expect(a).toBe(b);
    d.resolve('value');
    expect(await Promise.all([a, b])).toEqual(['value', 'value']);
    expect(make).toHaveBeenCalledTimes(1);
  });

  it('evicts only the rejected key; another key keeps its cached value', async () => {
    const make = vi.fn((key: string) =>
      key === 'bad' ? Promise.reject(new Error('boom')) : Promise.resolve(`v:${key}`));
    const memo = memoAsyncBy(make);

    await expect(memo('good')).resolves.toBe('v:good');
    await expect(memo('bad')).rejects.toThrow('boom');
    await expect(memo('bad')).rejects.toThrow('boom');   // retried, not replayed
    await expect(memo('good')).resolves.toBe('v:good');  // still cached
    expect(make.mock.calls.map(c => c[0])).toEqual(['good', 'bad', 'bad']);
  });

  it('evict drops one key and leaves the others alone', async () => {
    const make = vi.fn(async (key: string) => `v:${key}`);
    const memo = memoAsyncBy(make);

    await memo('a');
    await memo('b');
    memo.evict('a');
    await memo('a');
    await memo('b');
    expect(make.mock.calls.map(c => c[0])).toEqual(['a', 'b', 'a']);

    memo.evict('absent');            // evicting an uncached key is inert
    await memo('a');
    expect(make).toHaveBeenCalledTimes(3);
  });

  it('evictWhere drops every matching key and nothing else', async () => {
    const make = vi.fn(async (key: string) => `v:${key}`);
    const memo = memoAsyncBy(make);

    await Promise.all([memo('EN:1'), memo('EN:2'), memo('DA:1')]);
    memo.evictWhere(k => k.startsWith('EN:'));
    await Promise.all([memo('EN:1'), memo('EN:2'), memo('DA:1')]);
    expect(make.mock.calls.map(c => c[0]))
      .toEqual(['EN:1', 'EN:2', 'DA:1', 'EN:1', 'EN:2']);
  });

  it('a late rejection does not evict the retry that replaced it', async () => {
    // The identity check (`if (cache.get(key) === p)`) exists for this: by the
    // time a rejection settles, the slot may already hold a newer promise, and
    // that one must survive. Without the check the retry would be thrown away
    // and every later call would re-fetch.
    const first = deferred<string>();
    const second = deferred<string>();
    const make = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const memo = memoAsyncBy(make);

    const stale = memo('k');
    stale.catch(() => {});           // the caller's own rejection, handled
    memo.evict('k');                 // e.g. an invalidation while in flight
    const retry = memo('k');
    second.resolve('fresh');
    first.reject(new Error('boom')); // settles after the retry was installed
    await flush();

    await expect(retry).resolves.toBe('fresh');
    await expect(memo('k')).resolves.toBe('fresh');  // retry still cached
    expect(make).toHaveBeenCalledTimes(2);
  });
});
