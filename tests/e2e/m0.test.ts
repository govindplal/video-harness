// M0 acceptance: `harness doctor` passes all six smoke tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { ROOT } from "../../src/paths.ts";

test("M0: harness doctor passes all six smoke tests", { timeout: 15 * 60_000 }, () => {
  const r = spawnSync(process.execPath, ["src/cli/main.ts", "doctor", "--json"], { cwd: ROOT, encoding: "utf8", maxBuffer: 10_000_000 });
  const out = JSON.parse(r.stdout) as { ok: boolean; summary: string; data: { results: { tool: string; pass: boolean; detail: string }[] } };
  const tools = out.data.results.map((x) => x.tool).sort();
  assert.deepEqual(tools, ["blender", "ffmpeg", "inkscape", "krita", "rhubarb", "sox"]);
  for (const t of out.data.results) assert.ok(t.pass, `${t.tool} failed: ${t.detail}`);
  assert.equal(out.ok, true, out.summary);
  assert.equal(r.status, 0);
});
