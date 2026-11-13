// Asset library manifests: styles, locations, vehicles. Each asset is a folder with a manifest.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ASSETS_DIR } from "../paths.ts";
import type { Vec3 } from "./schema.ts";

export interface Style {
  palette: Record<string, string | string[]>;
  outlineWidth: number;
  shadingSteps: number;
  grain: number;
  saturation?: number;
}

export interface PaintLayer {
  name: string;
  type: string;
  /** Distance from the camera rig in metres when placed in Blender (painted locations). */
  depth: number;
  /** Free parameters for the paint script (counts, heights, colours by palette key). */
  params?: Record<string, unknown>;
}

export interface Mark { position: Vec3; target: Vec3; lens?: number }
export interface NamedPath { points: [number, number][]; drivable: boolean }

export interface Location {
  kind: "painted" | "set";
  description?: string;
  times: string[];
  paint: { width: number; height: number; layers: PaintLayer[] };
  set?: { builder: string; params?: Record<string, unknown> };
  marks: Record<string, Mark>;
  paths: Record<string, NamedPath>;
  /** Drivable ground as polygons of [x, y] points. */
  drivable: [number, number][][];
}

export interface Vehicle {
  model: string;
  scale: number;
  /** Length in metres after scaling, used for smoke/tyre placement. */
  length: number;
  /** Axis the model's nose points along in its own file: "+X", "-X", "+Y", "-Y". */
  forward: string;
  wheels: { front: string[]; rear: string[] };
  colourSlots: Record<string, string>;
  colors: Record<string, string>;
}

function readJson<T>(p: string): T {
  return JSON.parse(readFileSync(p, "utf8")) as T;
}

export const styleDir = (n: string): string => join(ASSETS_DIR, "styles", n);
export const locationDir = (n: string): string => join(ASSETS_DIR, "locations", n);
export const vehicleDir = (n: string): string => join(ASSETS_DIR, "vehicles", n);

export function hasStyle(n: string): boolean { return existsSync(join(styleDir(n), "style.json")); }
export function hasLocation(n: string): boolean { return existsSync(join(locationDir(n), "location.json")); }
export function hasVehicle(n: string): boolean { return existsSync(join(vehicleDir(n), "vehicle.json")); }

export function loadStyle(n: string): Style { return readJson(join(styleDir(n), "style.json")); }
export function loadLocation(n: string): Location { return readJson(join(locationDir(n), "location.json")); }
export function loadVehicle(n: string): Vehicle { return readJson(join(vehicleDir(n), "vehicle.json")); }

export function list(kind: "styles" | "locations" | "vehicles"): string[] {
  const d = join(ASSETS_DIR, kind);
  return existsSync(d) ? readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : [];
}

export function pathLength(pts: [number, number][]): number {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return L;
}

/** Point at distance d along a polyline (clamped). */
export function pointAt(pts: [number, number][], d: number): [number, number] {
  let rem = Math.max(0, d);
  for (let i = 1; i < pts.length; i++) {
    const seg = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    if (rem <= seg) {
      const t = seg === 0 ? 0 : rem / seg;
      return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t];
    }
    rem -= seg;
  }
  return pts[pts.length - 1];
}

export function insidePolygon(p: [number, number], poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function onDrivable(loc: Location, p: [number, number]): boolean {
  return loc.drivable.some((poly) => insidePolygon(p, poly));
}
