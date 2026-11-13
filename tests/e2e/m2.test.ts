// M2 acceptance: a 3-shot spec (chase, side drift, top-down) produces one video with sound;
// subject-visible and ground-present pass on all three shots.
// Warm cache: seconds. Cold: roughly an hour (3 Blender compiles, ~13 s/frame, ID passes, repeatable checks).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT, projectDir } from "../../src/paths.ts";
import * as ff from "../../src/adapters/ffmpeg.ts";

const PROJECT = "m2-street";

function harness(...args: string[]): { json: any } {
  const r = spawnSync(process.execPath, ["src/cli/main.ts", ...args, "--json"], { cwd: ROOT, encoding: "utf8", maxBuffer: 100_000_000 });
  try { return { json: JSON.parse(r.stdout) }; } catch { return { json: { ok: false, summary: `unparseable: ${r.stdout.slice(0, 200)} ${r.stderr.slice(0, 200)}` } }; }
}

test("M2: spec validates and has chase, track (side) and top-down shots", () => {
  const r = harness("validate", PROJECT);
  assert.equal(r.json.ok, true, r.json.summary);
});

test("M2: render all three shots", { timeout: 4 * 60 * 60_000 }, () => {
  const r = harness("render", PROJECT);
  assert.equal(r.json.ok, true, r.json.summary);
});

test("M2: subject-visible and ground-present pass on all three shots, plus the other checks", { timeout: 2 * 60 * 60_000 }, () => {
  const r = harness("check", PROJECT);
  assert.equal(r.json.ok, true, r.json.summary);
  const shots = r.json.data.shots as { id: string; checks: { check: string; pass: boolean; reason: string }[] }[];
  assert.equal(shots.length, 3);
  for (const s of shots) {
    for (const name of ["subject-visible", "ground-present"]) {
      const c = s.checks.find((x) => x.check === name);
      assert.ok(c?.pass, `${s.id} ${name}: ${c?.reason}`);
    }
  }
});

test("M2: assemble gives one video with sound at the right length and loudness", { timeout: 30 * 60_000 }, async () => {
  const r = harness("assemble", PROJECT);
  assert.equal(r.json.ok, true, r.json.summary);
  const file = join(projectDir(PROJECT), "out", `${PROJECT}.mp4`);
  assert.ok(existsSync(file));
  const p = await ff.probe(file, true);
  assert.equal(p.frames, 156);
  assert.equal(p.hasAudio, true);
  assert.equal(p.width, 1920);
  const l = await ff.loudness(file);
  assert.ok(Math.abs(l.integrated - -14) <= 1, `loudness ${l.integrated} LUFS`);
  assert.ok(l.truePeak <= -1, `true peak ${l.truePeak} dB`);
});
