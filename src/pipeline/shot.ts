// The per-shot stage graph: paint -> build -> place -> animate -> render -> encode.
// shotKeys() computes every stage's cache key without running anything (used by status and by the runners).
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CACHE_DIR, lock } from "../paths.ts";
import { hashObj, isCached, runStage, type StageRun } from "../planner/cache.ts";
import * as blender from "../adapters/blender.ts";
import * as ff from "../adapters/ffmpeg.ts";
import * as assets from "../spec/assets.ts";
import type { Project, Shot } from "../spec/schema.ts";
import { HarnessError } from "../cli/result.ts";
import { paintKey, paintLocation, type PaintMeta } from "./paint.ts";

export const STAGES = ["paint", "build", "place", "animate", "render", "encode"] as const;
export type StageName = (typeof STAGES)[number];

export interface SceneMeta { blend: string }
export interface BuildMeta extends SceneMeta { layers: unknown[] }
export interface RenderMeta { framesDir: string; frames: number; size: [number, number]; seconds: number; engine: string }
export interface EncodeMeta { file: string; frames: number; width: number; height: number }

export function frameSize(project: Project): [number, number] {
  const [w, h] = project.size.split("x").map(Number);
  return [w, h];
}

export function frameCount(project: Project, shot: Shot): number {
  return Math.round(shot.duration * project.fps);
}

/** "auto" resolves to the engine `harness doctor` found working headless (EEVEE if doctor has not run). */
export function resolveEngine(project: Project): "eevee" | "cycles" {
  if (project.render.engine !== "auto") return project.render.engine;
  const f = join(CACHE_DIR, "doctor", "blender-engine.json");
  if (existsSync(f)) {
    const e = (JSON.parse(readFileSync(f, "utf8")) as { engine?: string }).engine;
    if (e === "cycles" || e === "eevee") return e;
  }
  return "eevee";
}

export interface ShotKeys { paint: string; build: string; place: string; animate: string; render: string; encode: string }

export function shotKeys(project: Project, shot: Shot, preview = false): ShotKeys {
  const loc = assets.loadLocation(shot.location.name);
  const style = assets.loadStyle(project.style);
  const [w, h] = frameSize(project);
  const tool = lock().tools.blender.version;
  const hj = blender.scriptHash("hjob");
  const paint = loc.kind === "painted" ? paintKey(shot.location.name, shot.location.time, project.style, project.seed) : "none";
  const build = hashObj({
    stage: "build", paint, kind: loc.kind, geometry: loc.paint, frame: loc.frame, set: loc.set,
    style: { outlineWidth: style.outlineWidth, shadingSteps: style.shadingSteps }, time: shot.location.time,
    size: [w, h], tool, scripts: [blender.scriptHash("build_set"), hj],
  });
  const place = hashObj({ stage: "place", build, actors: shot.actors, tool });
  const animate = hashObj({
    stage: "animate", place, camera: shot.camera, duration: shot.duration, fps: project.fps, effects: shot.effects,
    marks: loc.marks, frameHorizon: loc.frame?.horizon ?? null, seed: project.seed, tool, scripts: [blender.scriptHash("animate"), hj],
  });
  const render = hashObj({
    stage: "render", animate, size: [w, h], engine: resolveEngine(project), samples: project.render.samples,
    scale: preview ? project.render.previewScale : 1, tool, scripts: [blender.scriptHash("render"), hj],
  });
  const encode = hashObj({ stage: "encode", render, fps: project.fps, preset: preview ? "preview" : "final", ffmpeg: lock().tools.ffmpeg.version });
  return { paint, build, place, animate, render, encode };
}

/** Which stages of a shot are in the cache right now (without running anything). */
export function shotCacheState(project: Project, shot: Shot, preview = false): Record<StageName, boolean> {
  const k = shotKeys(project, shot, preview);
  return {
    paint: k.paint === "none" ? true : isCached("paint", k.paint),
    build: isCached("build", k.build),
    place: isCached("place", k.place),
    animate: isCached("animate", k.animate),
    render: isCached("render", k.render),
    encode: isCached("encode", k.encode),
  };
}

export interface BuiltShot {
  keys: ShotKeys;
  paint?: StageRun<PaintMeta>;
  build: StageRun<BuildMeta>;
  place: StageRun<SceneMeta>;
  animate: StageRun<SceneMeta>;
}

/** Stages 1-4: everything Blender needs before rendering. */
export async function buildShot(project: Project, shot: Shot, preview = false): Promise<BuiltShot> {
  const keys = shotKeys(project, shot, preview);
  const loc = assets.loadLocation(shot.location.name);
  const [w, h] = frameSize(project);

  const paint = loc.kind === "painted" ? await paintLocation(shot.location.name, shot.location.time, project.style, project.seed) : undefined;

  const build = await runStage<BuildMeta>("build", keys.build, async (dir) => {
    if (!paint) throw new HarnessError("set locations arrive in milestone 2", "location.name");
    const { result } = await blender.runScript<{ layers: unknown[] }>("build_set", {
      out: join(dir, "scene.blend"), size: [w, h], location: loc, layersDir: paint.dir, layers: paint.meta.layers,
    });
    return { blend: "scene.blend", layers: result.layers };
  });

  const place = await runStage<SceneMeta>("place", keys.place, async (dir) => {
    if (shot.actors.length > 0) throw new HarnessError("actors arrive in milestone 2", "actors");
    copyFileSync(join(build.dir, "scene.blend"), join(dir, "scene.blend"));
    return { blend: "scene.blend" };
  });

  const animate = await runStage<SceneMeta>("animate", keys.animate, async (dir) => {
    await blender.runScript("animate", {
      blend: join(place.dir, "scene.blend"), out: join(dir, "scene.blend"), fps: project.fps, duration: shot.duration,
      camera: shot.camera, marks: loc.marks, frameHorizon: loc.frame?.horizon ?? null, effects: shot.effects, seed: project.seed,
    });
    return { blend: "scene.blend" };
  });

  return { keys, paint, build, place, animate };
}

export interface RenderedShot extends BuiltShot {
  render: StageRun<RenderMeta>;
  encode: StageRun<EncodeMeta>;
  preview: boolean;
}

/** Stages 1-6: build, render frames, encode the shot. */
export async function renderShot(project: Project, shot: Shot, preview = false): Promise<RenderedShot> {
  const built = await buildShot(project, shot, preview);
  const { keys } = built;
  const scale = preview ? project.render.previewScale : 1;

  const render = await runStage<RenderMeta>("render", keys.render, async (dir) => {
    const { result } = await blender.runScript<{ frames: number; seconds: number; engine: string; size: [number, number] }>("render", {
      blend: join(built.animate.dir, "scene.blend"), outDir: join(dir, "frames"), engine: resolveEngine(project),
      samples: project.render.samples, scale, frames: null,
    }, { timeoutMs: 4 * 60 * 60_000 });
    return { framesDir: "frames", frames: result.frames, size: result.size, seconds: result.seconds, engine: result.engine };
  });

  const encode = await runStage<EncodeMeta>("encode", keys.encode, async (dir) => {
    const out = join(dir, "shot.mp4");
    await ff.encodeFrames(join(render.dir, "frames"), project.fps, out, preview);
    const p = await ff.probe(out, true);
    return { file: "shot.mp4", frames: p.frames ?? 0, width: p.width ?? 0, height: p.height ?? 0 };
  });

  return { ...built, render, encode, preview };
}

/** Copy an encoded shot into the project's out/ folder and return its path. */
export function publishShot(outDir: string, shot: Shot, run: RenderedShot): string {
  const dest = join(outDir, run.preview ? "preview" : "shots");
  mkdirSync(dest, { recursive: true });
  const file = join(dest, `${shot.id}.mp4`);
  copyFileSync(join(run.encode.dir, run.encode.meta.file), file);
  return file;
}
