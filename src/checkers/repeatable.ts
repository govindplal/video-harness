// Repeatable: render one frame twice in separate Blender runs and compare file hashes. Identical input must give
// identical output (spec section 7, determinism). The result is cached by the render key.
import { join } from "node:path";
import * as blender from "../adapters/blender.ts";
import { pixelHash } from "../adapters/ffmpeg.ts";
import { hashFile, hashObj, runStage, stageDir } from "../planner/cache.ts";
import { resolveEngine } from "../pipeline/shot.ts";
import type { Checker } from "./types.ts";

interface RepeatMeta { frame: number; hashA: string; hashB: string; equal: boolean; storedMatches: boolean | null }

export const repeatable: Checker = async ({ project, art, config, preview }) => {
  const base = { check: "repeatable", shot: art.shot.id };
  const frame = config.repeatable.frame === "mid" ? Math.max(1, Math.round(art.render.frames / 2)) : Number(config.repeatable.frame);
  const name = `frame_${String(frame).padStart(4, "0")}.png`;
  const scale = preview ? project.render.previewScale : 1;
  const key = hashObj({ check: "repeatable", render: art.keys.render, frame, preview });

  const run = await runStage<RepeatMeta>("check-repeatable", key, async (dir) => {
    const job = (outDir: string): Record<string, unknown> => ({
      blend: art.animateBlend, outDir, engine: resolveEngine(project), samples: project.render.samples, scale, frames: [frame],
    });
    // Two separate Blender processes, in parallel: independent runs, half the wall time.
    await Promise.all([
      blender.runScript("render", job(join(dir, "a")), { timeoutMs: 30 * 60_000 }),
      blender.runScript("render", job(join(dir, "b")), { timeoutMs: 30 * 60_000 }),
    ]);
    const hashA = hashFile(join(dir, "a", name));
    const hashB = hashFile(join(dir, "b", name));
    let storedMatches: boolean | null = null;
    try { storedMatches = hashFile(join(art.framesDir, name)) === hashA; } catch { /* stored frame missing */ }
    return { frame, hashA, hashB, equal: hashA === hashB, storedMatches };
  });

  const m = run.meta;
  const note = m.storedMatches === null ? "" : m.storedMatches ? "; also matches the stored frame" : "; differs from the stored frame";
  if (!m.equal) {
    // Say whether the pixels or only the file bytes differ: the second means metadata (date, render time) leaked into the file.
    const dir = join(stageDir("check-repeatable", key));
    const [pa, pb] = await Promise.all([pixelHash(join(dir, "a", name)), pixelHash(join(dir, "b", name))]);
    const why = pa === pb ? "decoded pixels are identical, so only file metadata differs" : "decoded pixels differ too";
    return { ...base, pass: false, field: `shots[${art.shotIndex}]`, reason: `frame ${frame} rendered twice gives different files (${m.hashA.slice(0, 12)} vs ${m.hashB.slice(0, 12)}); ${why}`, measured: { ...m, pixelHashA: pa, pixelHashB: pb } };
  }
  return { ...base, pass: true, reason: `frame ${frame} rendered twice gives identical files (${m.hashA.slice(0, 12)})${note}`, measured: m };
};
