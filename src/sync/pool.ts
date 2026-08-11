// Bounded-concurrency map, because a cold sync is ~400 serial archive fetches
// and each one costs a server-side render. Serial, that's ~45 minutes — past
// the workflow's timeout, so a cold sync could never converge.
//
// Results stay in input order regardless of completion order, so the caller's
// plan doesn't depend on how fast individual fetches happen to be.

/**
 * Run `fn` over `items` with at most `limit` in flight.
 *
 * On the first rejection no further work is started, but the in-flight calls are
 * awaited before that error is rethrown — abandoning them would surface as
 * unhandled rejections after the process has already decided to fail.
 */
export async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const workers = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));

  let next = 0;
  let failure: { error: unknown } | undefined;

  async function work(): Promise<void> {
    while (!failure) {
      const index = next++;
      if (index >= items.length) return;
      try {
        results[index] = await fn(items[index]!, index);
      } catch (error) {
        failure ??= { error };
        return;
      }
    }
  }

  await Promise.all(Array.from({ length: workers }, work));
  if (failure) throw failure.error;
  return results;
}
