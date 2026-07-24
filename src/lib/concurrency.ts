/**
 * Bounded-concurrency map.
 *
 * Dependency-tree walks fan out over many packages; running them all at once
 * would be rude to the registry and can trip rate limits. Six in flight keeps
 * things fast without being a bad citizen.
 */

export const DEFAULT_CONCURRENCY = 6;

/**
 * Like `Promise.all(items.map(fn))`, but with at most `limit` calls in flight.
 * Results keep input order. Rejections propagate, as with `Promise.all`.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const width = Math.max(1, Math.min(limit, items.length));
  const results = new Array<R>(items.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index] as T, index);
    }
  }

  await Promise.all(Array.from({ length: width }, () => worker()));
  return results;
}
