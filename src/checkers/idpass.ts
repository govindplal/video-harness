// ID-pass checkers: subject-visible and ground-present. The ID pass is a flat-colour render of the same animation:
// actor k = pure red/green/yellow/cyan, ground = pure blue, everything else black (see toolscripts/blender/id_pass.py).
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { decodeRgb } from "../adapters/ffmpeg.ts";
import type { CheckResult, Checker } from "./types.ts";

const ACTOR_RGB: [number, number, number][] = [[255, 0, 0], [0, 255, 0], [255, 255, 0], [0, 255, 255]];
const GROUND_RGB: [number, number, number] = [0, 0, 255];
const near = (r: number, g: number, b: number, c: [number, number, number]): boolean => Math.abs(r - c[0]) < 60 && Math.abs(g - c[1]) < 60 && Math.abs(b - c[2]) < 60;

interface ActorFrame { pixels: number; x0: number; x1: number; y1: number; groundBelow: number; stripRows: number }

/** Per frame, per actor: pixel count, bounding box bottom and ground pixels in the strip just below it. */
async function scan(idsDir: string, size: [number, number], nActors: number): Promise<{ frames: number; actors: ActorFrame[][] }> {
  const [w, h] = size;
  const files = readdirSync(idsDir).filter((f) => /^id_\d+\.png$/.test(f)).sort();
  const actors: ActorFrame[][] = Array.from({ length: nActors }, () => []);
  for (const f of files) {
    const rgb = await decodeRgb(join(idsDir, f), w, h);
    for (let k = 0; k < nActors; k++) {
      let n = 0, x0 = w, x1 = -1, y1 = -1;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 3;
        if (near(rgb[i], rgb[i + 1], rgb[i + 2], ACTOR_RGB[k])) { n++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y > y1) y1 = y; }
      }
      let ground = 0, rows = 0;
      if (n > 0) {
        const hgt = Math.max(3, Math.round((y1 - 0) * 0.04));
        rows = Math.max(0, Math.min(hgt, h - 1 - y1));
        for (let y = y1 + 1; y <= y1 + rows; y++) for (let x = x0; x <= x1; x++) {
          const i = (y * w + x) * 3;
          if (near(rgb[i], rgb[i + 1], rgb[i + 2], GROUND_RGB)) ground++;
        }
      }
      actors[k].push({ pixels: n, x0, x1, y1, groundBelow: ground, stripRows: rows });
    }
  }
  return { frames: files.length, actors };
}

const cache = new Map<string, Awaited<ReturnType<typeof scan>>>();
async function scanned(dir: string, size: [number, number], n: number): Promise<Awaited<ReturnType<typeof scan>>> {
  const k = `${dir}|${n}`;
  if (!cache.has(k)) cache.set(k, await scan(dir, size, n));
  return cache.get(k)!;
}

export const subjectVisible: Checker = async ({ art, config }) => {
  const base = { check: "subject-visible", shot: art.shot.id };
  if (art.shot.actors.length === 0) return { ...base, pass: true, reason: "no actors in this shot" };
  if (!art.idsDir || !art.idSize) return { ...base, pass: false, reason: "no ID pass was rendered for this shot", field: `shots[${art.shotIndex}].actors` };
  const c = config.subjectVisible as { minFrameFraction: number; maxHiddenShotFraction: number };
  const s = await scanned(art.idsDir, art.idSize, art.shot.actors.length);
  const total = art.idSize[0] * art.idSize[1];
  const results: string[] = [];
  for (let k = 0; k < art.shot.actors.length; k++) {
    const hidden = s.actors[k].filter((f) => f.pixels / total < c.minFrameFraction).length;
    const frac = hidden / s.frames;
    const best = Math.max(...s.actors[k].map((f) => f.pixels / total));
    const name = art.shot.actors[k].name;
    if (frac > c.maxHiddenShotFraction) {
      return { ...base, pass: false, field: `shots[${art.shotIndex}].camera`, reason: `actor "${name}" covers under ${(c.minFrameFraction * 100).toFixed(1)}% of the frame in ${hidden}/${s.frames} frames (limit ${(c.maxHiddenShotFraction * 100).toFixed(0)}% of the shot); largest ${(best * 100).toFixed(2)}%`, measured: { hidden, frames: s.frames, best } };
    }
    results.push(`"${name}" visible in ${s.frames - hidden}/${s.frames} frames, largest ${(best * 100).toFixed(1)}%`);
  }
  return { ...base, pass: true, reason: `${results.join("; ")} (needs >= ${(c.minFrameFraction * 100).toFixed(1)}% for over half the shot)` };
};

export const groundPresent: Checker = async ({ art, config }) => {
  const base = { check: "ground-present", shot: art.shot.id };
  if (art.shot.actors.length === 0) return { ...base, pass: true, reason: "no actors in this shot" };
  if (!art.idsDir || !art.idSize) return { ...base, pass: false, reason: "no ID pass was rendered for this shot", field: `shots[${art.shotIndex}].actors` };
  const min = (config.groundPresent as { minGroundPixels: number }).minGroundPixels;
  const s = await scanned(art.idsDir, art.idSize, art.shot.actors.length);
  const out: string[] = [];
  for (let k = 0; k < art.shot.actors.length; k++) {
    const judged = s.actors[k].filter((f) => f.pixels > 0 && f.stripRows > 0);
    const bad = judged.findIndex((f) => f.groundBelow < min);
    const name = art.shot.actors[k].name;
    if (judged.length === 0) { out.push(`"${name}": no frame where the ground strip could be judged`); continue; }
    if (bad >= 0) {
      return { ...base, pass: false, field: `shots[${art.shotIndex}].actors[${k}].path`, reason: `no ground pixels beneath actor "${name}" in a visible frame (id frame ${bad + 1}); the road may be missing or the actor floats`, measured: { frame: bad + 1 } };
    }
    out.push(`"${name}": ground beneath in all ${judged.length} judged frames`);
  }
  return { ...base, pass: true, reason: out.join("; ") } as CheckResult;
};
