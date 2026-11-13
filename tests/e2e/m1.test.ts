// M1 acceptance: a hand-written spec produces a 5 s, 1080p clip of exactly 120 frames with visible parallax;
// the shot-length, frame-not-empty and repeatable checks pass.
// Stages come from the cache when present, so a warm run takes seconds; a cold run takes ~15 minutes
// (Krita paint ~1 min, Blender shader compile ~1.5 min, 120 frames at ~4 s, plus the repeatable check).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT, projectDir } from "../../src/paths.ts";
import * as ff from "../../src/adapters/ffmpeg.ts";
import { loadProject } from "../../src/spec/validate.ts";
import { shotKeys } from "../../src/pipeline/shot.ts";
import { stageDir } from "../../src/planner/cache.ts";

const PROJECT = "m1-rooftops";

function harness(...args: string[]): { status: number | null; json: any } {
  const r = spawnSync(process.execPath, ["src/cli/main.ts", ...args, "--json"], { cwd: ROOT, encoding: "utf8", maxBuffer: 50_000_000 });
  let json: any;
  try { json = JSON.parse(r.stdout); } catch { json = { ok: false, summary: `unparseable output: ${r.stdout.slice(0, 200)} ${r.stderr.slice(0, 200)}` }; }
  return { status: r.status, json };
}

/** Mean luminance per column over rows [y0, y1). */
function columnProfile(rgb: Buffer, w: number, y0: number, y1: number): Float64Array {
  const p = new Float64Array(w);
  for (let y = y0; y < y1; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      p[x] += 0.299 * rgb[i] + 0.587 * rgb[i + 1] + 0.114 * rgb[i + 2];
    }
  }
  for (let x = 0; x < w; x++) p[x] /= y1 - y0;
  return p;
}

/** Horizontal shift s (in pixels) such that b[x + s] best matches a[x]. */
function bestShift(a: Float64Array, b: Float64Array, maxShift: number): number {
  let best = 0;
  let bestErr = Infinity;
  for (let s = -maxShift; s <= maxShift; s++) {
    let err = 0;
    let n = 0;
    for (let x = maxShift; x < a.length - maxShift; x++) { err += Math.abs(a[x] - b[x + s]); n++; }
    err /= n;
    if (err < bestErr) { bestErr = err; best = s; }
  }
  return best;
}

test("M1: spec validates", () => {
  const r = harness("validate", PROJECT);
  assert.equal(r.json.ok, true, r.json.summary);
});

test("M1: render produces exactly 120 frames at 1920x1080", { timeout: 90 * 60_000 }, async () => {
  const r = harness("render", PROJECT);
  assert.equal(r.json.ok, true, r.json.summary);
  const file = join(projectDir(PROJECT), "out", "shots", "rooftops-01.mp4");
  assert.ok(existsSync(file), `missing ${file}`);
  const p = await ff.probe(file, true);
  assert.equal(p.frames, 120, `expected exactly 120 frames, got ${p.frames}`);
  assert.equal(p.width, 1920);
  assert.equal(p.height, 1080);
  assert.ok(Math.abs((p.fps ?? 0) - 24) < 1e-6, `fps ${p.fps}`);
  assert.ok(Math.abs(p.duration - 5) < 0.05, `duration ${p.duration}`);
});

test("M1: shot-length, frame-not-empty and repeatable checks pass, and a contact sheet exists", { timeout: 60 * 60_000 }, () => {
  const r = harness("check", PROJECT);
  assert.equal(r.json.ok, true, r.json.summary);
  const names = r.json.data.shots[0].checks.map((c: any) => c.check).sort();
  assert.deepEqual(names, ["frame-not-empty", "repeatable", "shot-length"]);
  for (const c of r.json.data.shots[0].checks) assert.equal(c.pass, true, `${c.check}: ${c.reason}`);
  assert.ok(existsSync(join(projectDir(PROJECT), "out", "contact.png")), "contact.png missing");
  assert.ok(existsSync(join(projectDir(PROJECT), "out", "report.json")), "report.json missing");
});

test("M1: parallax is visible: layers shift in proportion to 1/depth, nearest the most", async () => {
  const p = loadProject(PROJECT).project!;
  const framesDir = join(stageDir("render", shotKeys(p, p.shots[0]).render), "frames");
  assert.equal(readdirSync(framesDir).filter((f) => f.endsWith(".png")).length, 120);
  const W = 1920;
  const H = 1080;
  const first = await ff.decodeRgb(join(framesDir, "frame_0001.png"), W, H);
  const last = await ff.decodeRgb(join(framesDir, "frame_0120.png"), W, H);
  // Bands chosen where only one layer is visible. Geometry predicts (camera moves 1.2 m/s x 4.96 s = 5.95 m, lens 50):
  //   clouds (700 m) ~17 px, far city (220 m) ~55 px, mid houses (90 m) ~136 px, near houses (35 m) ~350 px.
  const shift = (y0: number, y1: number): number => Math.abs(bestShift(columnProfile(first, W, y0, y1), columnProfile(last, W, y0, y1), 520));
  const clouds = shift(300, 460);
  const far = shift(640, 700);
  const mid = shift(760, 860);
  const near = shift(1000, 1070);
  assert.ok(clouds < far && far < mid && mid < near, `layers must shift more the nearer they are: clouds ${clouds}, far ${far}, mid ${mid}, near ${near} px`);
  assert.ok(near >= 250, `near houses shifted only ${near} px (expected ~350)`);
  assert.ok(clouds <= 40, `clouds shifted ${clouds} px (expected ~17)`);
  assert.ok(near >= 8 * Math.max(clouds, 5), `parallax too weak: near ${near} px vs clouds ${clouds} px`);
});

test("M1: assemble joins the shot into a 120-frame final video", { timeout: 30 * 60_000 }, async () => {
  const r = harness("assemble", PROJECT);
  assert.equal(r.json.ok, true, r.json.summary);
  const file = join(projectDir(PROJECT), "out", `${PROJECT}.mp4`);
  const p = await ff.probe(file, true);
  assert.equal(p.frames, 120);
  assert.equal(p.width, 1920);
  assert.equal(p.height, 1080);
});
