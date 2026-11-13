// Stage 1: Paint (Krita). Reads the location's paint manifest and the style palette; writes layered backgrounds.
import { join, relative } from "node:path";
import { hashObj, runStage, type StageRun } from "../planner/cache.ts";
import * as krita from "../adapters/krita.ts";
import { lock } from "../paths.ts";
import * as assets from "../spec/assets.ts";
import { HarnessError } from "../cli/result.ts";

export interface PaintMeta {
  layers: { name: string; file: string; depth: number }[];
  kra: string;
  preview: string;
  width: number;
  height: number;
}

export function paintKey(locName: string, time: string, styleName: string, seed: number): string {
  const loc = assets.loadLocation(locName);
  const style = assets.loadStyle(styleName);
  return hashObj({
    stage: "paint",
    paint: loc.paint,
    palette: style.palette[time],
    grain: style.grain,
    seed,
    tool: lock().tools.krita.version,
    scripts: [krita.scriptHash("paint_background"), krita.scriptHash("harness_runner")],
  });
}

export async function paintLocation(locName: string, time: string, styleName: string, seed: number): Promise<StageRun<PaintMeta>> {
  if (!assets.hasLocation(locName)) throw new HarnessError(`location "${locName}" not found`, "location.name");
  const loc = assets.loadLocation(locName);
  if (loc.kind !== "painted") throw new HarnessError(`location "${locName}" is a ${loc.kind} location; only painted locations are painted`, "location.name");
  const style = assets.loadStyle(styleName);
  const palette = style.palette[time];
  if (!palette) throw new HarnessError(`style "${styleName}" has no palette for time "${time}" (have: ${Object.keys(style.palette).join(", ")})`, "style");

  return runStage<PaintMeta>("paint", paintKey(locName, time, styleName, seed), async (dir) => {
    const { result } = await krita.runScript<{ layers: { name: string; file: string; depth: number }[]; kra: string; preview: string }>(
      "paint_background",
      { outDir: dir, seed, time, paint: loc.paint, palette, grain: style.grain },
      { timeoutMs: 10 * 60_000 },
    );
    const rel = (p: string): string => relative(dir, p).replaceAll("\\", "/");
    return {
      layers: result.layers.map((l) => ({ name: l.name, file: rel(l.file), depth: l.depth })),
      kra: rel(result.kra),
      preview: rel(result.preview),
      width: loc.paint.width,
      height: loc.paint.height,
    };
  });
}

export function paintFile(run: StageRun<PaintMeta>, rel: string): string {
  return join(run.dir, rel);
}
