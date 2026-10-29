import { expect, test } from "vite-plus/test";
import { mapInBatches } from "../../src/lib/batches.mjs";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Usefulness: verifies the results keep the item order and at most `size` calls are in flight
// (issue #1187), so a caller gains concurrency with no change to its output and no EMFILE.
test("mapInBatches keeps item order and never runs more than the batch size at once", async () => {
  let flying = 0;
  let max = 0;
  const items = Array.from({ length: 10 }, (_, i) => i);
  const results = await mapInBatches(items, 4, async (item) => {
    flying += 1;
    max = Math.max(max, flying);
    await pause(10 - item);
    flying -= 1;
    return item * 2;
  });
  expect(results).toEqual(items.map((item) => item * 2));
  expect(max).toBe(4);
});

// Usefulness: verifies the first failure in item order throws, whichever call failed first in time,
// as sequential calls would, and that the other calls of the batch settle before the throw.
test("mapInBatches throws the first failure in item order after the batch settles", async () => {
  const settled = [];
  const failure = await mapInBatches([0, 1, 2], 3, async (item) => {
    await pause(item === 0 ? 30 : 1);
    settled.push(item);
    if (item !== 2) throw new Error(`failed ${item}`);
  }).catch((err) => err);
  expect(failure.message).toBe("failed 0");
  expect(settled).toEqual([1, 2, 0]);
});

// Usefulness: verifies a failure in one batch starts no later batch.
test("mapInBatches starts no later batch after a failure", async () => {
  const started = [];
  await mapInBatches([0, 1, 2, 3], 2, async (item) => {
    started.push(item);
    if (item === 1) throw new Error("failed");
  }).catch(() => {});
  expect(started).toEqual([0, 1]);
});
