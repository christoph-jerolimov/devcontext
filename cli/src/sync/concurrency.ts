/**
 * The one concurrency primitive the sync uses: a bounded worker pool over a
 * list of independent items.
 *
 * It exists for the per-item detail phases — the comments of issue A and the
 * reviews of pull request B have nothing to do with each other, and waiting
 * for one round trip before starting the next is where an hours-long sync
 * spends most of its wall clock. The pool starts up to `limit` items at once;
 * the rate limiter underneath still spaces out the individual requests, so
 * raising the limit hides latency without touching the request rate.
 *
 * Failure is fail-fast the way the serial loop was: the first error stops
 * new items from starting, the items already in flight finish (their writes
 * are per-item and safe to keep), and then that first error is thrown.
 */

export async function forEachConcurrent<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  const width = Math.max(1, Math.min(Math.floor(limit), items.length));

  let next = 0;
  // Boxed rather than a plain `let`: the workers assign it from inside their
  // closures, which the compiler's narrowing cannot see.
  const state: { failure: { error: unknown } | null } = { failure: null };

  const worker = async (): Promise<void> => {
    for (;;) {
      if (state.failure !== null) return;
      const index = next;
      next += 1;
      if (index >= items.length) return;
      try {
        await fn(items[index] as T, index);
      } catch (error) {
        // Only the first error is kept: the rest are usually the same
        // problem seen from other workers, and the first is the honest one.
        state.failure ??= { error };
        return;
      }
    }
  };

  await Promise.all(Array.from({ length: width }, () => worker()));
  if (state.failure !== null) throw state.failure.error;
}
