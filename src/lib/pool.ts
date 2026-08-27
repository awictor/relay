// Bounded-concurrency map (DEV-0140). Runs fn over items with at most `limit` in flight at once,
// returning results IN ITEM ORDER (like Promise.all, order-preserving). Used to cap fan-out that
// would otherwise stampede a shared resource — e.g. runDigest firing one anvil browser session per
// member (an unbounded Promise.all could open 10 sessions at once and exhaust the self-hosted pool).
// fn should do its OWN error handling if a rejection must not sink the batch; a throwing fn here
// rejects the whole mapPool (callers that need per-item isolation wrap fn in try/catch, as runDigest
// does). limit is clamped to >=1; limit>=items.length behaves exactly like Promise.all.
export async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const n = items.length;
  const results = new Array<R>(n);
  const cap = Math.max(1, Math.floor(limit) || 1);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < n) {
      const i = next++;
      results[i] = await fn(items[i]!, i);
    }
  }
  const workers = Array.from({ length: Math.min(cap, n) }, () => worker());
  await Promise.all(workers);
  return results;
}
