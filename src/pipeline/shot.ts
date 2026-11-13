// The per-shot stage graph: paint -> build -> place -> animate -> render -> encode.
// shotKeys() computes every stage's cache key without running anything (used by status and by the runners).
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CACHE_DIR, lock } from "../paths.ts";
import { hashFile, hashObj, isCached, runStage, type StageRun } from "../planner/cache.ts";
import * as blender from "../adapters/blender.ts";
import * as ff from "../adapters/ffmpeg.ts";
import * as assets from "../spec/assets.ts";
import type { Project, Shot } from "../spec/schema.ts";
import { HarnessError } from "../cli/result.ts";
import { paintKey, paintLocation, type PaintMeta } from "./paint.ts";

export const STAGES = ["paint", "build", "place", "animate", "render", "encode"] as const;
export type StageName = (typeof STAGES)[number];

export interface SceneMeta { blend: string }
/** Animate stage output: the keyed scene plus the per-frame world states the checkers need. */
export interface AnimateMeta extends SceneMeta {
  /** Camera position per frame [x, y, z]. */
  camera: number[][];
  /** Per actor, per frame: [x, y, z, heading, slip, speed]. */
  actors: Record<string, number[][]>;
  effects: Record<string, number>;
}
export interface BuildMeta extends SceneMeta { layers: unknown[]; stats?: unknown }
export interface RenderMeta {
  framesDir: string; frames: number; size: [number, number]; seconds: number; engine: string;
  /** Flat-colour ID pass frames (only for shots with actors) and its size. */
  idsDir?: string; idSize?: [number, number];
}
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

/** Resolve an actor's path (a named path from the location manifest, or explicit timed points) into the form the Blender scripts read. */
export function trajectorySpec(loc: assets.Location, a: Shot["actors"][number]): Record<string, unknown> {
  if (typeof a.path === "string") {
    const np = loc.paths[a.path];
    return { kind: "named", points: np.points, speed: a.speed, start: a.start, action: a.action };
  }
  return { kind: "timed", points: a.path };
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
    stage: "build", paint, kind: loc.kind, geometry: loc.paint, frame: loc.frame, set: loc.set, ground: loc.ground,
    style: { outlineWidth: style.outlineWidth, shadingSteps: style.shadingSteps, palette: style.palette[shot.location.time] },
    time: shot.location.time, seed: project.seed, size: [w, h], tool,
    scripts: [blender.scriptHash("build_set"), hj, ...(loc.set ? ["toon", "geo", `sets/${loc.set.builder}`].map(blender.scriptHash) : [])],
  });
  const actorInputs = shot.actors.map((a) => {
    const v = assets.loadVehicle(a.asset);
    return { actor: a, vehicle: v, model: hashFile(join(assets.vehicleDir(a.asset), v.model)), path: typeof a.path === "string" ? loc.paths[a.path] : a.path };
  });
  const common = ["motion", "toon", "geo"].map(blender.scriptHash);
  const place = hashObj({
    stage: "place", build, actors: actorInputs, ground: loc.ground, duration: shot.duration,
    palette: style.palette[shot.location.time], steps: style.shadingSteps, tool, scripts: [blender.scriptHash("place_assets"), hj, ...common],
  });
  const animate = hashObj({
    stage: "animate", place, camera: shot.camera, duration: shot.duration, fps: project.fps, effects: shot.effects,
    marks: loc.marks, ground: loc.ground, frameHorizon: loc.frame?.horizon ?? null, seed: project.seed,
    palette: style.palette[shot.location.time], steps: style.shadingSteps, tool, scripts: [blender.scriptHash("animate"), hj, ...common],
  });
  const render = hashObj({
    stage: "render", animate, size: [w, h], engine: resolveEngine(project), samples: project.render.samples,
    scale: preview ? project.render.previewScale : 1, tool, scripts: [blender.scriptHash("render"), blender.scriptHash("id_pass"), hj],
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
    const style = assets.loadStyle(project.style);
    const { result } = await blender.runScript<{ layers?: unknown[]; stats?: unknown }>("build_set", {
      out: join(dir, "scene.blend"), size: [w, h], location: loc, time: shot.location.time, seed: project.seed,
      style: { outlineWidth: style.outlineWidth, shadingSteps: style.shadingSteps }, palette: style.palette[shot.location.time],
      layersDir: paint?.dir ?? null, layers: paint?.meta.layers ?? [],
    });
    return { blend: "scene.blend", layers: result.layers ?? [], stats: result.stats };
  });

  const style = assets.loadStyle(project.style);
  const palette = style.palette[shot.location.time];
  const actorJobs = shot.actors.map((a, index) => {
    const vehicle = assets.loadVehicle(a.asset);
    return { name: a.name, index, modelPath: join(assets.vehicleDir(a.asset), vehicle.model), vehicle, path: trajectorySpec(loc, a), drift: a.drift, action: a.action };
  });

  const place = await runStage<SceneMeta>("place", keys.place, async (dir) => {
    if (shot.actors.length === 0) {
      copyFileSync(join(build.dir, "scene.blend"), join(dir, "scene.blend"));
      return { blend: "scene.blend" };
    }
    await blender.runScript("place_assets", {
      blend: join(build.dir, "scene.blend"), out: join(dir, "scene.blend"), duration: shot.duration,
      palette, steps: style.shadingSteps, ground: loc.ground ?? null, actors: actorJobs,
    });
    return { blend: "scene.blend" };
  });

  const animate = await runStage<AnimateMeta>("animate", keys.animate, async (dir) => {
    const { result } = await blender.runScript<Omit<AnimateMeta, "blend">>("animate", {
      blend: join(place.dir, "scene.blend"), out: join(dir, "scene.blend"), fps: project.fps, duration: shot.duration,
      camera: shot.camera, marks: loc.marks, frameHorizon: loc.frame?.horizon ?? null, effects: shot.effects, seed: project.seed,
      ground: loc.ground ?? null, actors: actorJobs, palette, steps: style.shadingSteps,
    });
    return { blend: "scene.blend", camera: result.camera, actors: result.actors, effects: result.effects };
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
    const meta: RenderMeta = { framesDir: "frames", frames: result.frames, size: result.size, seconds: result.seconds, engine: result.engine };
    if (shot.actors.length > 0) {
      // Flat-colour pass of the same animation, for the subject-visible and ground-present checks.
      const ids = await blender.runScript<{ size: [number, number] }>("id_pass", {
        blend: join(built.animate.dir, "scene.blend"), outDir: join(dir, "ids"), scale: 0.5, frames: null,
      }, { timeoutMs: 60 * 60_000 });
      meta.idsDir = "ids";
      meta.idSize = ids.result.size;
    }
    return meta;
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
