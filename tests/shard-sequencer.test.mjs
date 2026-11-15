import { relative, resolve, sep } from "node:path";
import { expect, test } from "vite-plus/test";
import { ShardSequencer, testFileDurations } from "./shard-sequencer.mjs";

const root = resolve(import.meta.dirname, "..");
const specs = Object.keys(testFileDurations).map((name) => ({ moduleId: resolve(root, name) }));
const names = new Map(
  specs.map((spec) => [spec.moduleId, relative(root, spec.moduleId).split(sep).join("/")]),
);
const sequencer = (index, count) =>
  new ShardSequencer({ config: { root, shard: { index, count } } });

/** Returns one shard's specs. */
async function shard(index, count, files = specs) {
  return sequencer(index, count).shard([...files]);
}

// Usefulness: a file that no shard selects runs in no CI shard, and one that two select runs twice.
test("every test file lands in exactly one shard for every supported shard count", async () => {
  for (const count of [2, 5, 6]) {
    const selected = [];
    for (let index = 1; index <= count; index++) selected.push(...(await shard(index, count)));
    expect(selected).toHaveLength(specs.length);
    expect(new Set(selected).size).toBe(specs.length);
  }
});

// Usefulness: the measured balance is the point of the sequencer; a path or size order leaves one shard heavy.
test("each of five shards holds close to a fifth of the measured duration", async () => {
  const sums = [];
  for (let index = 1; index <= 5; index++) {
    const files = await shard(index, 5);
    sums.push(
      files.reduce((total, spec) => total + testFileDurations[names.get(spec.moduleId)], 0),
    );
  }
  const mean = sums.reduce((total, sum) => total + sum, 0) / sums.length;
  expect(Math.max(...sums)).toBeLessThanOrEqual(mean * 1.05);
});

// Usefulness: a file added after the last measurement has no entry, and must still reach exactly one shard.
test("an unmeasured test file still runs in exactly one shard", async () => {
  const unmeasured = resolve(root, "tests/shard-sequencer.test.mjs");
  expect(Object.keys(testFileDurations)).not.toContain("tests/shard-sequencer.test.mjs");
  const found = [];
  for (let index = 1; index <= 5; index++) {
    const files = await shard(index, 5, [...specs, { moduleId: unmeasured }]);
    if (files.some((spec) => spec.moduleId === unmeasured)) found.push(index);
  }
  expect(found).toHaveLength(1);
});

// Usefulness: a rerun of the same shard must select the same files, so a failure stays reproducible.
test("shard selection is deterministic across calls", async () => {
  expect((await shard(3, 5)).map((spec) => spec.moduleId)).toEqual(
    (await shard(3, 5)).map((spec) => spec.moduleId),
  );
});
