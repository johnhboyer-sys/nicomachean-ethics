// One statement of the memoise-and-evict-on-failure idiom.
//
// Every data fetcher in this directory wants the same three things: the first
// call starts the work, concurrent and later callers share that one promise,
// and a REJECTION is dropped so the next call retries instead of replaying the
// failure for the rest of the session. Hand-rolled twenty times over, that last
// clause is what goes wrong — a cached rejection poisons a work for the session,
// and a helper that resolves `{}` on a 404 never reaches its eviction at all.
// Written once here, every fetcher gets it by construction.
//
// The eviction uses an identity check (`if (cache.get(key) === p)`) rather than
// a bare delete: by the time a rejection settles the slot may already hold a
// newer promise from a retry, and that one must not be thrown away.
//
// NB desktop/src/lib/runtime.ts has `lazy()`, which is `memoAsync` below minus
// the identity check — its catch clears the slot unconditionally, so a retry
// installed while the old rejection is still settling is thrown away. The
// desktop already imports from this directory (`@shared/lib/data`), so nothing
// stops it importing `memoAsync` from here and deleting its own copy; that is a
// desktop-side edit and deliberately not made here. Converge on this one the
// next time runtime.ts is touched.

/** A keyed memo. Callable as the fetcher; the eviction hooks hang off it. */
export interface KeyedMemo<K, T> {
  (key: K): Promise<T>;
  /** Drop one key's promise (in flight or settled) so the next call re-runs. */
  evict(key: K): void;
  /** Drop every cached key matching `pred`. */
  evictWhere(pred: (key: K) => boolean): void;
}

/**
 * Memoise a promise-returning factory in a single slot. The first call starts
 * `make()`; every later call shares that promise — except after a rejection,
 * which is evicted so the next call retries. Callers still receive the original
 * rejection, so a helper built on this throws exactly what `make` throws.
 */
export function memoAsync<T>(make: () => Promise<T>): () => Promise<T> {
  let slot: Promise<T> | null = null;
  return () => {
    if (slot) return slot;
    const p = make();
    p.catch(() => { if (slot === p) slot = null; });
    slot = p;
    return p;
  };
}

/**
 * `memoAsync` with one slot per key: `make(key)` runs once per distinct key
 * (Map identity, so string keys — compose one where a fetcher takes several
 * arguments), a rejection evicts only that key, and every other key is
 * untouched. `evict`/`evictWhere` expose the cache to an invalidation entry
 * point (see data.ts's invalidateBookCache).
 */
export function memoAsyncBy<K, T>(make: (key: K) => Promise<T>): KeyedMemo<K, T> {
  const cache = new Map<K, Promise<T>>();
  const get = (key: K): Promise<T> => {
    const cached = cache.get(key);
    if (cached) return cached;
    const p = make(key);
    p.catch(() => { if (cache.get(key) === p) cache.delete(key); });
    cache.set(key, p);
    return p;
  };
  return Object.assign(get, {
    evict: (key: K) => { cache.delete(key); },
    evictWhere: (pred: (key: K) => boolean) => {
      for (const key of [...cache.keys()]) if (pred(key)) cache.delete(key);
    },
  });
}
