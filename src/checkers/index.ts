// Runs the checkers over rendered shots and writes out/contact.png and out/report.json.
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { contactSheet } from "../adapters/ffmpeg.ts";
import { CACHE_DIR, projectDir } from "../paths.ts";
import { readMeta, stageDir } from "../planner/cache.ts";
import { shotKeys, type EncodeMeta, type RenderMeta, type SceneMeta } from "../pipeline/shot.ts";
import type { Project } from "../spec/schema.ts";
import { frameNotEmpty } from "./frameNotEmpty.ts";
import { repeatable } from "./repeatable.ts";
import { shotLength } from "./shotLength.ts";
import { loadConfig, type CheckResult, type Checker, type ShotArtifacts } from "./types.ts";

export type { CheckResult } from "./types.ts";

/** Checkers in report order. Milestone 2/3 add subject-visible, ground-present, camera-clear, motion-speed, loudness. */
export const CHECKERS: { name: string; run: Checker }[] = [
  { name: "shot-length", run: shotLength },
  { name: "frame-not-empty", run: frameNotEmpty },
  { name: "repeatable", run: repeatable },
];

/** Cached render artifacts for one shot, or undefined if the shot has not been rendered at this quality. */
export function shotArtifacts(project: Project, shotId: string, preview: boolean): ShotArtifacts | undefined {
  const shotIndex = project.shots.findIndex((s) => s.id === shotId);
  if (shotIndex < 0) return undefined;
  const shot = project.shots[shotIndex];
  const keys = shotKeys(project, shot, preview);
  const render = readMeta<RenderMeta>("render", keys.render);
  const encode = readMeta<EncodeMeta>("encode", keys.encode);
  const animate = readMeta<SceneMeta>("animate", keys.animate);
  if (!render || !encode || !animate) return undefined;
  return {
    shotIndex, shot, keys, render, encode,
    framesDir: join(stageDir("render", keys.render), render.framesDir),
    videoFile: join(stageDir("encode", keys.encode), encode.file),
    animateBlend: join(stageDir("animate", keys.animate), animate.blend),
  };
}

export interface Report {
  project: string;
  ok: boolean;
  preview: boolean;
  shots: { id: string; ok: boolean; checks: CheckResult[] }[];
  contactSheet: string | null;
}

export async function runChecks(project: Project, name: string, shotIds: string[], preview: boolean): Promise<Report> {
  const config = loadConfig();
  const out = join(projectDir(name), "out");
  mkdirSync(out, { recursive: true });
  const shots: Report["shots"] = [];
  const sheetItems: { image: string; label: string }[] = [];

  for (const id of shotIds) {
    const art = shotArtifacts(project, id, preview);
    if (!art) {
      shots.push({ id, ok: false, checks: [{ check: "rendered", shot: id, pass: false, field: `shots[${project.shots.findIndex((s) => s.id === id)}]`, reason: `shot has no ${preview ? "preview" : "full-quality"} render in the cache; run harness ${preview ? "preview" : "render"} ${name} ${id}` }] });
      continue;
    }
    const checks: CheckResult[] = [];
    for (const c of CHECKERS) checks.push(await c.run({ project, art, config, preview }));
    shots.push({ id, ok: checks.every((c) => c.pass), checks });
    const files = readdirSync(art.framesDir).filter((f) => /^frame_\d+\.png$/.test(f)).sort();
    sheetItems.push({ image: join(art.framesDir, files[Math.floor(files.length / 2)]), label: id });
  }

  let sheet: string | null = null;
  if (sheetItems.length > 0) {
    sheet = join(out, preview ? "contact-preview.png" : "contact.png");
    await contactSheet(sheetItems, sheet, join(CACHE_DIR, "contact", name));
  }
  const report: Report = { project: name, ok: shots.length > 0 && shots.every((s) => s.ok), preview, shots, contactSheet: sheet };
  writeFileSync(join(out, preview ? "report-preview.json" : "report.json"), JSON.stringify(report, null, 2));
  return report;
}
