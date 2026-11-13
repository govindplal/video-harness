// Cache tests: key stability, hit/miss, integrity (a damaged entry is a miss), and lock-serialised runs.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { canonical, hashObj, isCached, readMeta, runStage, stageDir } from "../../src/planner/cache.ts";
import { CACHE_DIR } from "../../src/paths.ts";

const STAGE = "unit-test";
after(() => rmSync(join(CACHE_DIR, "stages", STAGE), { recursive: true, force: true }));

test("hashObj ignores key order and undefined values but sees real changes", () => {
  assert.equal(hashObj({ a: 1, b: { c: 2, d: [1, 2] } }), hashObj({ b: { d: [1, 2], c: 2 }, a: 1, z: undefined }));
  assert.notEqual(hashObj({ a: 1 }), hashObj({ a: 2 }));
  assert.notEqual(hashObj({ a: [1, 2] }), hashObj({ a: [2, 1] }));
  assert.equal(canonical({ b: 1, a: 2 }), '{"a":2,"b":1}');
});

test("a stage runs once, then hits the cache", async () => {
  const key = hashObj({ t: "hit", n: Math.random() });
  let runs = 0;
  const work = async (dir: string): Promise<{ n: number }> => { runs++; writeFileSync(join(dir, "out.txt"), "hello"); return { n: 7 }; };
  const a = await runStage(STAGE, key, work);
  const b = await runStage(STAGE, key, work);
  assert.equal(runs, 1);
  assert.equal(a.cached, false);
  assert.equal(b.cached, true);
  assert.deepEqual(b.meta, { n: 7 });
  assert.equal(readFileSync(join(b.dir, "out.txt"), "utf8"), "hello");
  assert.ok(isCached(STAGE, key));
});

test("a different key is a miss", async () => {
  const k1 = hashObj({ t: "k1", n: Math.random() });
  const k2 = hashObj({ t: "k2", n: Math.random() });
  let runs = 0;
  const work = async (dir: string): Promise<null> => { runs++; writeFileSync(join(dir, "f"), "x"); return null; };
  await runStage(STAGE, k1, work);
  await runStage(STAGE, k2, work);
  assert.equal(runs, 2);
});

test("an entry whose file went missing is rejected and rebuilt (regression: raced runs once left done.json without the PNGs)", async () => {
  const key = hashObj({ t: "damaged", n: Math.random() });
  let runs = 0;
  const work = async (dir: string): Promise<null> => { runs++; mkdirSync(join(dir, "layers")); writeFileSync(join(dir, "layers", "a.png"), "12345"); return null; };
  const first = await runStage(STAGE, key, work);
  rmSync(join(first.dir, "layers"), { recursive: true });
  assert.equal(readMeta(STAGE, key), undefined, "damaged entry must not count as cached");
  const again = await runStage(STAGE, key, work);
  assert.equal(again.cached, false);
  assert.equal(runs, 2);
  assert.ok(existsSync(join(again.dir, "layers", "a.png")));
});

test("an entry whose file changed size is rejected", async () => {
  const key = hashObj({ t: "resized", n: Math.random() });
  const r = await runStage(STAGE, key, async (dir) => { writeFileSync(join(dir, "f.bin"), "abcdef"); return null; });
  writeFileSync(join(r.dir, "f.bin"), "abc");
  assert.equal(isCached(STAGE, key), false);
});

test("an old-format entry without a file manifest is not trusted", async () => {
  const key = hashObj({ t: "legacy", n: Math.random() });
  const dir = stageDir(STAGE, key);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "done.json"), JSON.stringify({ stage: STAGE, key, meta: {} }));
  assert.equal(isCached(STAGE, key), false);
});

test("a failing stage leaves no cache entry and no stray temp dir", async () => {
  const key = hashObj({ t: "fail", n: Math.random() });
  await assert.rejects(runStage(STAGE, key, async (dir) => { writeFileSync(join(dir, "partial"), "x"); throw new Error("boom"); }), /boom/);
  assert.equal(isCached(STAGE, key), false);
  assert.equal(existsSync(`${stageDir(STAGE, key)}.lock`), false, "lock must be released after a failure");
});

test("two concurrent runs of one key do the work once", async () => {
  const key = hashObj({ t: "race", n: Math.random() });
  let runs = 0;
  const work = async (dir: string): Promise<null> => {
    runs++;
    await new Promise((r) => setTimeout(r, 300));
    writeFileSync(join(dir, "f"), "x");
    return null;
  };
  const [a, b] = await Promise.all([runStage(STAGE, key, work), runStage(STAGE, key, work)]);
  assert.equal(runs, 1);
  assert.equal([a, b].filter((x) => x.cached).length, 1);
});
