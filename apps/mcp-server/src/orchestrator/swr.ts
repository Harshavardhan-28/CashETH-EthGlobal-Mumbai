/**
 * A keyed stale-while-revalidate cache for slow chain-backed reads. A missing key is loaded once (concurrent callers
 * share the load); a fresh key is answered from memory; a stale key is answered with its last value at once while a
 * single background load replaces it. A failed background load keeps the last good value.
 */
export type SwrCache<T> = {
  get(key: string, load: () => Promise<T>): Promise<T>;
  /** Resolves once every background refresh in flight has finished (tests and graceful shutdown). */
  settled(): Promise<void>;
};

type Entry<T> = { value?: { v: T; at: number }; loading?: Promise<T> };

export function staleWhileRevalidate<T>(ttlMs: number, now: () => number = Date.now): SwrCache<T> {
  const entries = new Map<string, Entry<T>>();

  const refresh = (key: string, entry: Entry<T>, load: () => Promise<T>): Promise<T> => {
    const started = now();
    entry.loading ??= load()
      .then((v) => {
        entry.value = { v, at: started };
        return v;
      })
      .finally(() => {
        entry.loading = undefined;
        if (!entry.value) entries.delete(key);
      });
    return entry.loading;
  };

  return {
    async get(key, load) {
      let entry = entries.get(key);
      if (!entry) entries.set(key, (entry = {}));
      if (!entry.value) return refresh(key, entry, load);
      if (now() - entry.value.at >= ttlMs) refresh(key, entry, load).catch(() => undefined);
      return entry.value.v;
    },
    async settled() {
      await Promise.allSettled([...entries.values()].map((e) => e.loading));
    },
  };
}
