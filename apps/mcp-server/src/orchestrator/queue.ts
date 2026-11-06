/** Per-key serial execution: tasks with the same key run one after another, other keys run concurrently. */
export type QueueMap<K> = { get(key: K): Promise<unknown> | undefined; set(key: K, value: Promise<unknown>): unknown };

/**
 * Runs `task` after every task queued earlier under `key` has settled (fulfilled or rejected). Used for the
 * audit trail (so HCS `seq` matches the local store) and for signer nonces (one transaction in flight per key).
 */
export function enqueue<K, T>(queues: QueueMap<K>, key: K, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous.then(task, task);
  queues.set(
    key,
    next.catch(() => undefined),
  );
  return next;
}
