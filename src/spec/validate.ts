// Validator: schema check (types, defaults, ranges) plus cross-field and asset-library checks.
// Rejects everything out of range before any tool starts.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { check, type SpecError } from "./fields.ts";
import { projectField, SPEED_CAPS, type Project, type Shot } from "./schema.ts";
import * as assets from "./assets.ts";
import { ASSETS_DIR, projectDir } from "../paths.ts";

export const MUSIC_BEDS = ["none", "drive-pulse"] as const;

export interface Validated {
  ok: boolean;
  errors: SpecError[];
  project?: Project;
}

export function validateSpec(raw: unknown): Validated {
  const errors: SpecError[] = [];
  const project = check(raw, projectField, "", errors) as Project;
  if (errors.length) return { ok: false, errors };
  semantic(project, errors);
  return errors.length ? { ok: false, errors } : { ok: true, errors, project };
}

export function loadProject(name: string): Validated {
  const file = join(projectDir(name), "project.json");
  if (!existsSync(file)) return { ok: false, errors: [{ field: "project.json", message: `not found at projects/${name}/project.json` }] };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    return { ok: false, errors: [{ field: "project.json", message: `invalid JSON: ${(e as Error).message}` }] };
  }
  return validateSpec(raw);
}

export function totalDuration(p: Project): number {
  return p.shots.reduce((s, sh) => s + sh.duration, 0);
}

function semantic(p: Project, errs: SpecError[]): void {
  if (!assets.hasStyle(p.style)) errs.push({ field: "style", message: `style "${p.style}" not found in assets/styles (have: ${assets.list("styles").join(", ") || "none"})` });

  if (!(MUSIC_BEDS as readonly string[]).includes(p.music) && !existsSync(join(ASSETS_DIR, "sounds", p.music))) {
    errs.push({ field: "music", message: `"${p.music}" is neither a named bed (${MUSIC_BEDS.join(", ")}) nor a file in assets/sounds` });
  }

  const total = totalDuration(p);
  p.subtitles.forEach((s, i) => {
    if (s.end <= s.start) errs.push({ field: `subtitles[${i}].end`, message: `must be after start (${s.start})` });
    if (s.end > total + 1e-6) errs.push({ field: `subtitles[${i}].end`, message: `is past the end of the video (${total.toFixed(2)} s)` });
  });

  const ids = new Set<string>();
  p.shots.forEach((shot, i) => {
    const at = `shots[${i}]`;
    if (ids.has(shot.id)) errs.push({ field: `${at}.id`, message: `duplicate shot id "${shot.id}"` });
    ids.add(shot.id);
    const frames = Math.round(shot.duration * p.fps);
    if (Math.abs(frames - shot.duration * p.fps) > 1e-6) errs.push({ field: `${at}.duration`, message: `${shot.duration} s is not a whole number of frames at ${p.fps} fps` });
    checkShot(shot, at, errs);
  });
}

const rad = (d: number): number => (d * Math.PI) / 180;

export interface Coverage { depth: number; left: number; right: number; up: number; down: number }

/**
 * How far (metres) the camera may move in each direction, or how much its frame may grow, before it shows past the
 * painted edge of the nearest layer. Positive = room to spare; negative = the frame already shows past the paint.
 * Painted layers are placed 1:1 with the frame for `referenceFov` (see toolscripts/blender/build_set.py).
 */
export function paintedMargins(loc: assets.Location, lens: number, roll: number): Coverage {
  const depth = Math.min(...loc.paint.layers.map((l) => l.depth));
  const s = loc.paint.width / 1920;
  const aspect = loc.paint.height / loc.paint.width;
  const a = Math.tan(rad(loc.frame?.referenceFov ?? 50) / 2) * s; // plane half width per metre of depth
  const planeH = 2 * a * aspect;
  const hz = loc.paint.horizon;
  const fh = loc.frame?.horizon ?? 0.5;
  // Frame half extents per metre of depth, enlarged to the bounding box of the rolled frame.
  const hw = Math.tan(rad(lens) / 2);
  const hh = hw * (9 / 16);
  const r = Math.abs(rad(roll));
  const bw = hw * Math.cos(r) + hh * Math.sin(r);
  const bh = hw * Math.sin(r) + hh * Math.cos(r);
  // Frame extent above/below the horizon row (the build step uses lens shift to put the horizon `fh` of the way down).
  return {
    depth,
    left: depth * (a - bw),
    right: depth * (a - bw),
    up: depth * (planeH * hz - 2 * bh * fh),
    down: depth * (planeH * (1 - hz) - 2 * bh * (1 - fh)),
  };
}

function paintedCoverage(shot: Shot, at: string, loc: assets.Location, errs: SpecError[]): void {
  const c = shot.camera;
  const cat = `${at}.camera`;
  if (!loc.frame) {
    errs.push({ field: `${at}.location.name`, message: `painted location "${shot.location.name}" has no "frame" settings in its manifest` });
    return;
  }
  const m = paintedMargins(loc, c.lens, c.roll);
  const allow = 0.1 * c.shake; // shake moves the camera by up to ~0.03 m rms; keep a safety margin
  if (m.left - allow < 0) {
    errs.push({ field: `${cat}.lens`, message: `lens ${c.lens} deg with roll ${c.roll} deg shows past the painted edge of "${shot.location.name}" (nearest layer at ${m.depth} m); use a narrower lens or less roll` });
    return;
  }
  if (c.move === "static" || c.move === "drift") {
    const travel = c.move === "drift" ? c.speed * shot.duration : 0;
    const room: Record<string, number> = { right: m.right, left: m.left, up: m.up, down: m.down, forward: Infinity, back: Infinity };
    const dir = c.direction;
    const limit = (room[dir] ?? 0) - allow;
    if (travel > limit) {
      errs.push({ field: `${cat}.speed`, message: `drifting ${dir} ${travel.toFixed(1)} m (${c.speed} m/s x ${shot.duration} s) passes the painted edge; this location allows at most ${Math.max(0, limit).toFixed(1)} m at lens ${c.lens} (nearest layer ${m.depth} m)` });
    }
    if (dir === "back") {
      const d = c.speed * shot.duration;
      const a = Math.tan(rad(loc.frame.referenceFov) / 2) * (loc.paint.width / 1920);
      if ((m.depth + d) * Math.tan(rad(c.lens) / 2) > m.depth * a) {
        errs.push({ field: `${cat}.speed`, message: `pulling back ${d.toFixed(1)} m widens the view past the painted edge` });
      }
    }
  }
  if (m.up - allow < 0 || m.down - allow < 0) {
    errs.push({ field: `${cat}.lens`, message: `lens ${c.lens} deg shows past the top or bottom of the painted layers of "${shot.location.name}"` });
  }
}

function checkShot(shot: Shot, at: string, errs: SpecError[]): void {
  const locName = shot.location.name;
  if (!assets.hasLocation(locName)) {
    errs.push({ field: `${at}.location.name`, message: `location "${locName}" not found in assets/locations (have: ${assets.list("locations").join(", ") || "none"})` });
    return;
  }
  const loc = assets.loadLocation(locName);
  if (!loc.times.includes(shot.location.time)) errs.push({ field: `${at}.location.time`, message: `"${shot.location.time}" not available for ${locName} (have: ${loc.times.join(", ")})` });

  // Actors
  const names = new Set<string>();
  shot.actors.forEach((a, j) => {
    const aat = `${at}.actors[${j}]`;
    if (names.has(a.name)) errs.push({ field: `${aat}.name`, message: `duplicate actor name "${a.name}"` });
    names.add(a.name);
    if (!assets.hasVehicle(a.asset)) errs.push({ field: `${aat}.asset`, message: `vehicle "${a.asset}" not found in assets/vehicles (have: ${assets.list("vehicles").join(", ") || "none"})` });
    if (typeof a.path === "string") {
      const np = loc.paths[a.path];
      if (!np) {
        errs.push({ field: `${aat}.path`, message: `path "${a.path}" not in ${locName} (have: ${Object.keys(loc.paths).join(", ")})` });
        return;
      }
      if (!np.drivable) errs.push({ field: `${aat}.path`, message: `path "${a.path}" is not drivable` });
      const len = assets.pathLength(np.points);
      const travel = a.start + (a.action === "idle" ? 0 : a.speed * shot.duration);
      if (travel > len + 1e-6) {
        errs.push({ field: `${aat}.speed`, message: `start ${a.start} m + ${a.speed} m/s x ${shot.duration} s = ${travel.toFixed(1)} m runs off the end of "${a.path}" (${len.toFixed(1)} m)` });
      }
      for (let d = a.start; d <= Math.min(travel, len); d += 1) {
        if (!assets.onDrivable(loc, assets.pointAt(np.points, d))) {
          errs.push({ field: `${aat}.path`, message: `"${a.path}" leaves drivable ground ${d.toFixed(0)} m along` });
          break;
        }
      }
    } else {
      const pts = a.path;
      for (let k = 1; k < pts.length; k++) {
        if (pts[k].at <= pts[k - 1].at) errs.push({ field: `${aat}.path[${k}].at`, message: "times must increase" });
      }
      if (pts[pts.length - 1].at > shot.duration + 1e-6) errs.push({ field: `${aat}.path[${pts.length - 1}].at`, message: `is after the shot ends (${shot.duration} s)` });
      pts.forEach((pt, k) => {
        if (!assets.onDrivable(loc, [pt.x, pt.y])) errs.push({ field: `${aat}.path[${k}]`, message: `(${pt.x}, ${pt.y}) is not on drivable ground in ${locName}` });
      });
    }
  });

  // Camera
  const c = shot.camera;
  const cat = `${at}.camera`;
  if (typeof c.from === "string" && !loc.marks[c.from]) errs.push({ field: `${cat}.from`, message: `mark "${c.from}" not in ${locName} (have: ${Object.keys(loc.marks).join(", ")})` });
  if ((c.move === "static" || c.move === "drift") && c.from === undefined) errs.push({ field: `${cat}.from`, message: `is required for move "${c.move}"` });
  if (["track", "chase", "orbit"].includes(c.move) && !c.follow) errs.push({ field: `${cat}.follow`, message: `is required for move "${c.move}"` });
  if (c.follow && !names.has(c.follow)) errs.push({ field: `${cat}.follow`, message: `no actor named "${c.follow}" in this shot` });
  if (c.move === "top-down" && c.height < 8) errs.push({ field: `${cat}.height`, message: `top-down needs height >= 8 m, got ${c.height}` });
  if (c.move === "top-down" && !c.follow && c.from === undefined) errs.push({ field: `${cat}.from`, message: "top-down needs follow or from" });
  const cap = SPEED_CAPS[c.move];
  if (cap !== undefined && c.speed > cap) errs.push({ field: `${cat}.speed`, message: `${c.speed} exceeds the ${c.move} cap of ${cap}` });

  if (loc.kind === "painted") paintedCoverage(shot, at, loc, errs);

  // Sound
  shot.sound.forEach((s, k) => {
    if (s.at >= shot.duration) errs.push({ field: `${at}.sound[${k}].at`, message: `starts at ${s.at} s, after the shot ends (${shot.duration} s)` });
  });
}
