// Frame not empty: catches flat frames, missing textures (Blender's magenta) and the "void" colour that
// shows wherever the world is visible because a layer or surface is missing or too small.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { decodeRgb } from "../adapters/ffmpeg.ts";
import type { Checker } from "./types.ts";

interface FrameStats { stdDev: number; badFraction: number; voidFraction: number; missingFraction: number }

export function analyse(rgb: Buffer, void_: number[], missing: number[], tol: number): FrameStats {
  const n = rgb.length / 3;
  let sum = 0;
  let sumSq = 0;
  let voidCount = 0;
  let missingCount = 0;
  const near = (r: number, g: number, b: number, c: number[]): boolean =>
    Math.abs(r - c[0]) <= tol && Math.abs(g - c[1]) <= tol && Math.abs(b - c[2]) <= tol;
  for (let i = 0; i < rgb.length; i += 3) {
    const r = rgb[i];
    const g = rgb[i + 1];
    const b = rgb[i + 2];
    const y = 0.299 * r + 0.587 * g + 0.114 * b;
    sum += y;
    sumSq += y * y;
    if (near(r, g, b, void_)) voidCount++;
    else if (near(r, g, b, missing)) missingCount++;
  }
  const mean = sum / n;
  const variance = Math.max(0, sumSq / n - mean * mean);
  return { stdDev: Math.sqrt(variance), badFraction: (voidCount + missingCount) / n, voidFraction: voidCount / n, missingFraction: missingCount / n };
}

export const frameNotEmpty: Checker = async ({ art, config }) => {
  const c = config.frameNotEmpty;
  const base = { check: "frame-not-empty", shot: art.shot.id };
  const files = readdirSync(art.framesDir).filter((f) => /^frame_\d+\.png$/.test(f)).sort();
  if (files.length === 0) return { ...base, pass: false, reason: "no rendered frames found", field: `shots[${art.shotIndex}]` };
  const picks = new Set<number>([0, files.length - 1]);
  for (let i = 0; i < files.length; i += c.sampleEvery) picks.add(i);

  let worstStd = Infinity;
  let worstStdFrame = "";
  let worstBad = 0;
  let worstBadFrame = "";
  let worstBadKind = "";
  for (const i of [...picks].sort((a, b) => a - b)) {
    const rgb = await decodeRgb(join(art.framesDir, files[i]), c.analysisWidth, c.analysisHeight);
    const s = analyse(rgb, c.voidColor, c.missingTextureColor, c.colorTolerance);
    if (s.stdDev < worstStd) { worstStd = s.stdDev; worstStdFrame = files[i]; }
    if (s.badFraction > worstBad) { worstBad = s.badFraction; worstBadFrame = files[i]; worstBadKind = s.voidFraction >= s.missingFraction ? "void colour (a layer or surface is missing or too small)" : "missing-texture magenta"; }
  }
  const measured = { sampled: picks.size, minStdDev: Number(worstStd.toFixed(2)), maxBadFraction: Number(worstBad.toFixed(5)) };
  if (worstStd < c.minStdDev) {
    return { ...base, pass: false, field: `shots[${art.shotIndex}]`, reason: `${worstStdFrame} is nearly flat (std dev ${worstStd.toFixed(2)} < ${c.minStdDev})`, measured };
  }
  if (worstBad > c.maxBadPixelFraction) {
    return { ...base, pass: false, field: `shots[${art.shotIndex}].camera`, reason: `${worstBadFrame} shows ${(worstBad * 100).toFixed(2)}% ${worstBadKind} (limit ${(c.maxBadPixelFraction * 100).toFixed(2)}%)`, measured };
  }
  return { ...base, pass: true, reason: `${picks.size} frames sampled: min std dev ${worstStd.toFixed(1)} (>= ${c.minStdDev}), worst void/missing-texture ${(worstBad * 100).toFixed(3)}% (<= ${(c.maxBadPixelFraction * 100).toFixed(2)}%)`, measured };
};
