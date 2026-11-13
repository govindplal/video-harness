// Validator tests: every spec field has a type, default and range, and each gets a test (CLAUDE.md rule).
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateSpec, paintedMargins } from "../../src/spec/validate.ts";
import { loadLocation } from "../../src/spec/assets.ts";
import { toJsonSchema } from "../../src/spec/fields.ts";
import { projectField } from "../../src/spec/schema.ts";

const good = (): Record<string, any> => ({
  style: "anime-afternoon",
  shots: [{
    id: "a-1", duration: 5,
    location: { name: "sf-rooftops", time: "afternoon" },
    camera: { move: "drift", from: "overlook", direction: "right", speed: 1.2, lens: 50 },
  }],
});

function errorsFor(mutate: (p: Record<string, any>) => void): { field: string; message: string }[] {
  const p = good();
  mutate(p);
  return validateSpec(p).errors;
}

test("a minimal spec is valid and gets every default", () => {
  const v = validateSpec(good());
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  const p = v.project!;
  assert.equal(p.size, "1920x1080");
  assert.equal(p.fps, 24);
  assert.equal(p.seed, 1);
  assert.equal(p.music, "none");
  assert.deepEqual(p.subtitles, []);
  assert.equal(p.render.engine, "auto");
  assert.equal(p.render.samples, 16);
  const s = p.shots[0];
  assert.deepEqual(s.actors, []);
  assert.deepEqual(s.sound, []);
  assert.deepEqual(s.effects, { smoke: 0, speedLines: 0, motionBlur: 0, tyreMarks: 0 });
  assert.equal(s.camera.roll, 0);
  assert.equal(s.camera.shake, 0);
  assert.equal(s.location.time, "afternoon");
});

test("size: only 1920x1080 or 1080x1920", () => {
  assert.ok(errorsFor((p) => { p.size = "1280x720"; }).some((e) => e.field === "size"));
  assert.equal(errorsFor((p) => { p.size = "1080x1920"; }).some((e) => e.field === "size"), false);
});

test("fps: 24 only", () => {
  assert.ok(errorsFor((p) => { p.fps = 30; }).some((e) => e.field === "fps"));
});

test("style must exist in assets/styles", () => {
  const e = errorsFor((p) => { p.style = "no-such-style"; });
  assert.ok(e.some((x) => x.field === "style" && /not found/.test(x.message)));
});

test("seed: integer in range", () => {
  assert.ok(errorsFor((p) => { p.seed = 1.5; }).some((e) => e.field === "seed"));
  assert.ok(errorsFor((p) => { p.seed = -1; }).some((e) => e.field === "seed"));
});

test("shots: 1 to 40", () => {
  assert.ok(errorsFor((p) => { p.shots = []; }).some((e) => e.field === "shots"));
  const many = errorsFor((p) => { p.shots = Array.from({ length: 41 }, (_, i) => ({ ...p.shots[0], id: `s-${i}` })); });
  assert.ok(many.some((e) => e.field === "shots" && /1 to 40/.test(e.message)));
});

test("shot duration: 0.3 to 12 s and a whole number of frames", () => {
  assert.ok(errorsFor((p) => { p.shots[0].duration = 0.2; }).some((e) => e.field === "shots[0].duration"));
  assert.ok(errorsFor((p) => { p.shots[0].duration = 12.5; }).some((e) => e.field === "shots[0].duration"));
  assert.ok(errorsFor((p) => { p.shots[0].duration = 2.51; }).some((e) => e.field === "shots[0].duration" && /whole number of frames/.test(e.message)));
});

test("shot ids are unique and well formed", () => {
  assert.ok(errorsFor((p) => { p.shots.push({ ...p.shots[0] }); }).some((e) => e.field === "shots[1].id" && /duplicate/.test(e.message)));
  assert.ok(errorsFor((p) => { p.shots[0].id = "Bad Id"; }).some((e) => e.field === "shots[0].id"));
});

test("location must exist and time must be offered by it", () => {
  assert.ok(errorsFor((p) => { p.shots[0].location.name = "nowhere"; }).some((e) => e.field === "shots[0].location.name"));
  assert.ok(errorsFor((p) => { p.shots[0].location.time = "night"; }).some((e) => e.field === "shots[0].location.time"));
});

test("camera lens: 15 to 80 degrees", () => {
  assert.ok(errorsFor((p) => { p.shots[0].camera.lens = 14; }).some((e) => e.field === "shots[0].camera.lens"));
  assert.ok(errorsFor((p) => { p.shots[0].camera.lens = 81; }).some((e) => e.field === "shots[0].camera.lens"));
});

test("camera roll, shake and move are range checked", () => {
  assert.ok(errorsFor((p) => { p.shots[0].camera.roll = 45; }).some((e) => e.field === "shots[0].camera.roll"));
  assert.ok(errorsFor((p) => { p.shots[0].camera.shake = 2; }).some((e) => e.field === "shots[0].camera.shake"));
  assert.ok(errorsFor((p) => { p.shots[0].camera.move = "fly"; }).some((e) => e.field === "shots[0].camera.move"));
});

test("static and drift need a start pose; chase needs a follow target", () => {
  assert.ok(errorsFor((p) => { delete p.shots[0].camera.from; }).some((e) => e.field === "shots[0].camera.from"));
  assert.ok(errorsFor((p) => { p.shots[0].camera = { move: "chase" }; }).some((e) => e.field === "shots[0].camera.follow"));
});

test("a named camera mark must exist in the location", () => {
  assert.ok(errorsFor((p) => { p.shots[0].camera.from = "nope"; }).some((e) => e.field === "shots[0].camera.from" && /mark/.test(e.message)));
});

test("effects: 0 to 1", () => {
  assert.ok(errorsFor((p) => { p.shots[0].effects = { smoke: 1.5 }; }).some((e) => e.field === "shots[0].effects.smoke"));
  assert.ok(errorsFor((p) => { p.shots[0].effects = { motionBlur: -0.1 }; }).some((e) => e.field === "shots[0].effects.motionBlur"));
});

test("sound cues come from the fixed list and start inside the shot", () => {
  assert.ok(errorsFor((p) => { p.shots[0].sound = [{ cue: "laser", at: 0 }]; }).some((e) => e.field === "shots[0].sound[0].cue"));
  assert.ok(errorsFor((p) => { p.shots[0].sound = [{ cue: "engine", at: 6 }]; }).some((e) => e.field === "shots[0].sound[0].at"));
});

test("actors need an existing vehicle asset", () => {
  const e = errorsFor((p) => { p.shots[0].actors = [{ asset: "no-car", name: "car", path: "lane" }]; });
  assert.ok(e.some((x) => x.field === "shots[0].actors[0].asset"));
});

test("subtitles must be inside the video and end after they start", () => {
  assert.ok(errorsFor((p) => { p.subtitles = [{ start: 1, end: 9, text: "x" }]; }).some((e) => e.field === "subtitles[0].end" && /past the end/.test(e.message)));
  assert.ok(errorsFor((p) => { p.subtitles = [{ start: 3, end: 2, text: "x" }]; }).some((e) => e.field === "subtitles[0].end"));
});

test("music must be a named bed or a sound asset", () => {
  assert.ok(errorsFor((p) => { p.music = "missing.wav"; }).some((e) => e.field === "music"));
  assert.equal(errorsFor((p) => { p.music = "drive-pulse"; }).some((e) => e.field === "music"), false);
});

test("unknown fields are rejected, with the allowed ones listed", () => {
  const e = errorsFor((p) => { p.shots[0].camera.zoom = 3; });
  assert.ok(e.some((x) => x.field === "shots[0].camera.zoom" && /unknown field/.test(x.message)));
});

test("painted coverage: margins match the hand calculation for sf-rooftops (nearest layer 35 m, lens 50)", () => {
  const m = paintedMargins(loadLocation("sf-rooftops"), 50, 0);
  assert.equal(m.depth, 35);
  assert.ok(Math.abs(m.right - 9.79) < 0.05, `right ${m.right}`);
  assert.ok(Math.abs(m.up - 6.18) < 0.05, `up ${m.up}`);
  assert.ok(Math.abs(m.down - 6.06) < 0.05, `down ${m.down}`);
});

test("painted coverage: a drift that would pass the painted edge is rejected, a smaller one accepted", () => {
  assert.ok(errorsFor((p) => { p.shots[0].camera.speed = 3.5; }).some((e) => e.field === "shots[0].camera.speed" && /painted edge/.test(e.message)));
  assert.equal(errorsFor((p) => { p.shots[0].camera.speed = 1.9; }).length, 0);
});

test("painted coverage: a lens wider than the painted layers can fill is rejected", () => {
  assert.ok(errorsFor((p) => { p.shots[0].camera.lens = 80; p.shots[0].camera.speed = 0; }).some((e) => e.field === "shots[0].camera.lens"));
});

test("painted coverage: roll eats into the margin", () => {
  const flat = paintedMargins(loadLocation("sf-rooftops"), 50, 0);
  const rolled = paintedMargins(loadLocation("sf-rooftops"), 50, 20);
  assert.ok(rolled.right < flat.right);
});

test("the JSON Schema for schema-constrained output (milestone 4) can be generated", () => {
  const s = toJsonSchema(projectField) as { properties: Record<string, unknown>; required?: string[] };
  assert.ok(s.properties.shots);
  assert.ok(s.required?.includes("style"));
});
