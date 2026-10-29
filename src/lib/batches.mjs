/**
 * Maps `items` through `fn`, `size` calls at a time, and returns the results in item order. The calls
 * of a batch settle together. The first failure in item order then throws, as sequential calls would,
 * and no later batch starts.
 * @template T, R
 * @param {T[]} items
 * @param {number} size most calls in flight at once
 * @param {(item: T, index: number) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
export async function mapInBatches(items, size, fn) {
  const results = [];
  for (let start = 0; start < items.length; start += size) {
    const batch = items.slice(start, start + size);
    const settled = await Promise.allSettled(batch.map((item, i) => fn(item, start + i)));
    for (const outcome of settled) {
      if (outcome.status === "rejected") throw outcome.reason;
      results.push(outcome.value);
    }
  }
  return results;
}
