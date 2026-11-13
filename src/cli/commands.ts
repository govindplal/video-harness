// The ten commands of spec section 6 (doctor lives in doctor.ts). Each returns a CommandResult; main.ts prints it.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { register } from "./main.ts";
import { fail, HarnessError, ok, type CommandResult } from "./result.ts";
import { PROJECTS_DIR, CACHE_DIR, lock, projectDir } from "../paths.ts";
import * as assets from "../spec/assets.ts";
import type { Project, Shot } from "../spec/schema.ts";
import { loadProject, totalDuration } from "../spec/validate.ts";
import { paintFile, paintLocation } from "../pipeline/paint.ts";
import { buildShot, frameCount, publishShot, renderShot, shotCacheState, shotKeys, STAGES } from "../pipeline/shot.ts";
import { runChecks, type Report } from "../checkers/index.ts";
import { hashObj, runStage } from "../planner/cache.ts";
import * as ff from "../adapters/ffmpeg.ts";

// ----------------------------------------------------------------------------- helpers

function projectName(args: string[], cmd: string): string {
  const n = args[0];
  if (!n) throw new HarnessError(`usage: harness ${cmd} <project>`, "project");
  return n;
}

/** Load and validate; throws a one-line HarnessError naming the first offending field. */
function loadValid(name: string): Project {
  const v = loadProject(name);
  if (!v.ok || !v.project) {
    const e = v.errors[0];
    const more = v.errors.length > 1 ? ` (+${v.errors.length - 1} more; run harness validate ${name})` : "";
    throw new HarnessError(`invalid spec: ${e.message}${more}`, e.field);
  }
  return v.project;
}

function pickShots(project: Project, arg: string | undefined): Shot[] {
  if (!arg) return project.shots;
  const s = project.shots.find((x) => x.id === arg);
  if (!s) throw new HarnessError(`no shot "${arg}" (have: ${project.shots.map((x) => x.id).join(", ")})`, "shot");
  return [s];
}

const outDir = (name: string): string => join(projectDir(name), "out");

function stageLine(label: string, r: { cached: boolean; seconds: number }): string {
  return `${label.padEnd(8)} ${r.cached ? "cached" : `ran ${r.seconds.toFixed(1)}s`}`;
}

// ----------------------------------------------------------------------------- init / validate

const STARTER = {
  name: "Rooftops drift",
  size: "1920x1080",
  fps: 24,
  style: "anime-afternoon",
  seed: 1,
  subtitles: [],
  music: "none",
  shots: [
    {
      id: "rooftops-01",
      duration: 5,
      location: { name: "sf-rooftops", time: "afternoon" },
      camera: { move: "drift", from: "overlook", direction: "right", speed: 1.2, lens: 50 },
      effects: {},
    },
  ],
};

register("init", "init <project>", async (args) => {
  const name = projectName(args, "init");
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new HarnessError(`project name "${name}" must be lowercase letters, digits and dashes`, "project");
  const dir = projectDir(name);
  const file = join(dir, "project.json");
  if (existsSync(file)) throw new HarnessError(`projects/${name}/project.json already exists`, "project");
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(STARTER, null, 2) + "\n");
  return ok("init", `created projects/${name}/project.json (one 5 s drift shot over sf-rooftops)`, { file });
});

register("validate", "validate <project>", async (args) => {
  const name = projectName(args, "validate");
  const v = loadProject(name);
  if (!v.ok || !v.project) {
    const e = v.errors[0];
    return { ...fail("validate", `${e.message}${v.errors.length > 1 ? ` (+${v.errors.length - 1} more)` : ""}`, e.field, { errors: v.errors }), lines: v.errors.slice(1).map((x) => `  ${x.field}: ${x.message}`) };
  }
  const p = v.project;
  return ok("validate", `${p.shots.length} shot(s), ${totalDuration(p).toFixed(2)} s, ${p.size} @ ${p.fps} fps, style ${p.style}`, { shots: p.shots.length, seconds: totalDuration(p) });
});

// ----------------------------------------------------------------------------- paint / build

register("paint", "paint <location> [--time=afternoon] [--style=anime-afternoon] [--seed=1]", async (args, flags) => {
  const name = args[0];
  if (!name) throw new HarnessError("usage: harness paint <location>", "location");
  if (!assets.hasLocation(name)) throw new HarnessError(`location "${name}" not found (have: ${assets.list("locations").join(", ")})`, "location");
  const loc = assets.loadLocation(name);
  const time = typeof flags.time === "string" ? flags.time : loc.times[0];
  const style = typeof flags.style === "string" ? flags.style : (assets.list("styles")[0] ?? "");
  const seed = typeof flags.seed === "string" ? Number(flags.seed) : 1;
  const run = await paintLocation(name, time, style, seed);
  return ok("paint", `${name} (${time}, style ${style}): ${run.meta.layers.length} layers ${run.cached ? "from cache" : `painted in ${run.seconds.toFixed(1)}s`} -> ${run.dir}`,
    { ...run.meta, dir: run.dir, cached: run.cached, key: run.key, preview: paintFile(run, run.meta.preview) });
});

register("build", "build <project> [shot]", async (args) => {
  const name = projectName(args, "build");
  const project = loadValid(name);
  const lines: string[] = [];
  const data: Record<string, unknown> = {};
  for (const shot of pickShots(project, args[1])) {
    const b = await buildShot(project, shot);
    lines.push(`${shot.id}:`, ...[b.paint && stageLine("paint", b.paint), stageLine("build", b.build), stageLine("place", b.place), stageLine("animate", b.animate)].filter(Boolean).map((l) => `  ${l}`));
    data[shot.id] = { scene: join(b.animate.dir, "scene.blend"), keys: b.keys };
  }
  return ok("build", `built ${Object.keys(data).length} shot(s)`, data, lines);
});

// ----------------------------------------------------------------------------- preview / render

async function renderCommand(cmd: "preview" | "render", args: string[]): Promise<CommandResult> {
  const name = projectName(args, cmd);
  const project = loadValid(name); // render refuses to run if validate fails
  const preview = cmd === "preview";
  const lines: string[] = [];
  const data: Record<string, unknown> = {};
  for (const shot of pickShots(project, args[1])) {
    const r = await renderShot(project, shot, preview);
    const file = publishShot(outDir(name), shot, r);
    lines.push(`${shot.id}:`, ...[r.paint && stageLine("paint", r.paint), stageLine("build", r.build), stageLine("place", r.place), stageLine("animate", r.animate), stageLine("render", r.render), stageLine("encode", r.encode)].filter(Boolean).map((l) => `  ${l}`),
      `  -> ${file} (${r.encode.meta.frames} frames, ${r.encode.meta.width}x${r.encode.meta.height}, engine ${r.render.meta.engine})`);
    data[shot.id] = { file, frames: r.encode.meta.frames, width: r.encode.meta.width, height: r.encode.meta.height, renderSeconds: r.render.meta.seconds, cached: { render: r.render.cached, encode: r.encode.cached } };
  }
  return ok(cmd, `${cmd === "preview" ? "previewed" : "rendered"} ${Object.keys(data).length} shot(s) into ${outDir(name)}`, data, lines);
}

register("preview", "preview <project> [shot]", (args) => renderCommand("preview", args));
register("render", "render <project> [shot]", (args) => renderCommand("render", args));

// ----------------------------------------------------------------------------- check / status

function reportLines(report: Report): string[] {
  const lines: string[] = [];
  for (const s of report.shots) for (const c of s.checks) lines.push(`${c.pass ? "PASS" : "FAIL"}  ${c.check.padEnd(16)} ${s.id.padEnd(14)} ${c.reason}${!c.pass && c.field ? `  [field: ${c.field}]` : ""}`);
  if (report.contactSheet) lines.push(`contact sheet: ${report.contactSheet}`);
  return lines;
}

register("check", "check <project> [shot] [--preview]", async (args, flags) => {
  const name = projectName(args, "check");
  const project = loadValid(name);
  const shots = pickShots(project, args[1]).map((s) => s.id);
  const report = await runChecks(project, name, shots, flags.preview === true);
  const failed = report.shots.flatMap((s) => s.checks.filter((c) => !c.pass));
  const res: CommandResult = report.ok
    ? ok("check", `all checks passed on ${report.shots.length} shot(s)`, report)
    : fail("check", `${failed[0].check} failed on shot ${failed[0].shot}: ${failed[0].reason}${failed.length > 1 ? ` (+${failed.length - 1} more)` : ""}`, failed[0].field, report);
  return { ...res, lines: reportLines(report) };
});

register("status", "status <project>", async (args) => {
  const name = projectName(args, "status");
  const project = loadValid(name);
  const lines: string[] = [];
  const data: Record<string, unknown> = {};
  let reportByShot = new Map<string, boolean>();
  const rf = join(outDir(name), "report.json");
  if (existsSync(rf)) reportByShot = new Map((JSON.parse(readFileSync(rf, "utf8")) as Report).shots.map((s) => [s.id, s.ok]));
  lines.push(`${"shot".padEnd(16)}${STAGES.map((s) => s.padEnd(9)).join("")}checks`);
  for (const shot of project.shots) {
    const st = shotCacheState(project, shot);
    const chk = reportByShot.has(shot.id) ? (reportByShot.get(shot.id) ? "pass" : "FAIL") : "not run";
    lines.push(`${shot.id.padEnd(16)}${STAGES.map((s) => (st[s] ? "cached" : "-").padEnd(9)).join("")}${chk}`);
    data[shot.id] = { stages: st, checks: chk, frames: frameCount(project, shot) };
  }
  return ok("status", `${project.shots.length} shot(s), ${totalDuration(project).toFixed(2)} s`, data, lines);
});

// ----------------------------------------------------------------------------- assemble

register("assemble", "assemble <project>", async (args) => {
  const name = projectName(args, "assemble");
  const project = loadValid(name); // assemble refuses to run if validate fails
  if (project.subtitles.length > 0) throw new HarnessError("subtitles are not implemented yet (milestone 2)", "subtitles");
  if (project.music !== "none") throw new HarnessError("music is not implemented yet (milestone 2)", "music");
  if (project.shots.some((s) => s.sound.length > 0)) throw new HarnessError("sound cues are not implemented yet (milestone 2)", "shots[].sound");

  // No output is final until every check passes.
  const report = await runChecks(project, name, project.shots.map((s) => s.id), false);
  if (!report.ok) {
    const f = report.shots.flatMap((s) => s.checks.filter((c) => !c.pass))[0];
    return { ...fail("assemble", `refusing to assemble: ${f.check} failed on shot ${f.shot}: ${f.reason}`, f.field, report), lines: reportLines(report) };
  }

  const encodes = project.shots.map((s) => shotKeys(project, s).encode);
  const key = hashObj({ stage: "assemble", encodes, size: project.size, fps: project.fps, ffmpeg: lock().tools.ffmpeg.version });
  const run = await runStage<{ file: string; frames: number; seconds: number; width: number; height: number; fps: number }>("assemble", key, async (dir) => {
    const files = project.shots.map((s) => {
      const k = shotKeys(project, s).encode;
      return join(CACHE_DIR, "stages", "encode", k, "shot.mp4");
    });
    const out = join(dir, "final.mp4");
    await ff.concatCopy(files, out, join(dir, "list.txt"));
    const p = await ff.probe(out, true);
    return { file: "final.mp4", frames: p.frames ?? 0, seconds: p.duration, width: p.width ?? 0, height: p.height ?? 0, fps: p.fps ?? 0 };
  });
  mkdirSync(outDir(name), { recursive: true });
  const dest = join(outDir(name), `${name}.mp4`);
  copyFileSync(join(run.dir, run.meta.file), dest);
  const expected = project.shots.reduce((n, s) => n + frameCount(project, s), 0);
  if (run.meta.frames !== expected) return fail("assemble", `final video has ${run.meta.frames} frames, expected ${expected}`, "shots[].duration", run.meta);
  return { ...ok("assemble", `${dest}: ${run.meta.frames} frames, ${run.meta.seconds.toFixed(2)} s, ${run.meta.width}x${run.meta.height} @ ${run.meta.fps} fps ${run.cached ? "(from cache)" : ""}`, { ...run.meta, file: dest, report }), lines: reportLines(report) };
});

export const PROJECTS = PROJECTS_DIR;
