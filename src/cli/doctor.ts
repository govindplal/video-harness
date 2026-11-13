// harness doctor: runs every smoke test from spec section 3 and prints tool versions.
import { mkdirSync, existsSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CACHE_DIR, lock, toolInstalled, type ToolName } from "../paths.ts";
import * as blender from "../adapters/blender.ts";
import * as krita from "../adapters/krita.ts";
import * as inkscape from "../adapters/inkscape.ts";
import * as ff from "../adapters/ffmpeg.ts";
import * as sox from "../adapters/sox.ts";
import * as rhubarb from "../adapters/rhubarb.ts";
import { ok, fail, type CommandResult } from "./result.ts";

interface Smoke {
  tool: ToolName;
  pinned: string;
  version?: string;
  pass: boolean;
  detail: string;
  seconds: number;
}

const DIR = join(CACHE_DIR, "doctor");

function nonEmpty(p: string): boolean {
  return existsSync(p) && statSync(p).size > 0;
}

async function timed(tool: ToolName, fn: () => Promise<{ version: string; detail: string; pass: boolean }>): Promise<Smoke> {
  const pinned = lock().tools[tool].version;
  const t0 = performance.now();
  if (!toolInstalled(tool)) {
    return { tool, pinned, pass: false, detail: "not installed (run bash scripts/install-tools.sh)", seconds: 0 };
  }
  try {
    const r = await fn();
    const versionOk = r.version.startsWith(pinned) || pinned.startsWith(r.version);
    return {
      tool, pinned, version: r.version,
      pass: r.pass && versionOk,
      detail: versionOk ? r.detail : `version ${r.version} does not match pinned ${pinned}; ${r.detail}`,
      seconds: (performance.now() - t0) / 1000,
    };
  } catch (e) {
    return { tool, pinned, pass: false, detail: (e as Error).message.split("\n")[0], seconds: (performance.now() - t0) / 1000 };
  }
}

export interface BlenderEngineReport { engine: string; gpu: string | null; seconds: number }

async function smokeBlender(): Promise<{ version: string; detail: string; pass: boolean }> {
  const version = await blender.version();
  const tried: string[] = [];
  for (const engine of ["eevee", "cycles"] as const) {
    const out = join(DIR, `blender-cube-${engine}.png`);
    try {
      const { result } = await blender.runScript<BlenderEngineReport>("smoke_cube", { out, engine, width: 1920, height: 1080, samples: engine === "cycles" ? 8 : 16 }, { timeoutMs: 10 * 60_000 });
      const dims = await ff.probe(out);
      if (dims.width === 1920 && dims.height === 1080) {
        writeFileSync(join(DIR, "blender-engine.json"), JSON.stringify({ ...result, engine, identifier: result.engine }, null, 2));
        return { version, pass: true, detail: `1920x1080 cube via ${result.engine} in ${result.seconds}s (${result.gpu ?? "no gpu info"})${tried.length ? "; fell back after: " + tried.join("; ") : ""}` };
      }
      tried.push(`${engine}: wrong size ${dims.width}x${dims.height}`);
    } catch (e) {
      tried.push(`${engine}: ${(e as Error).message.split("\n")[0]}`);
    }
  }
  return { version, pass: false, detail: tried.join("; ") };
}

async function smokeKrita(): Promise<{ version: string; detail: string; pass: boolean }> {
  const version = await krita.version();
  const outPng = join(DIR, "krita-smoke.png");
  const outKra = join(DIR, "krita-smoke.kra");
  const { result } = await krita.runScript<{ png: boolean; kra: boolean; layers: string[] }>("smoke", { outPng, outKra }, { timeoutMs: 2 * 60_000 });
  const pass = result.png && result.kra && nonEmpty(outPng) && nonEmpty(outKra) && result.layers.length === 2;
  return { version, pass, detail: `layers [${result.layers.join(", ")}], png ${nonEmpty(outPng)}, kra ${nonEmpty(outKra)}` };
}

async function smokeInkscape(): Promise<{ version: string; detail: string; pass: boolean }> {
  const version = await inkscape.version();
  const svg = join(DIR, "inkscape-smoke.svg");
  const png = join(DIR, "inkscape-smoke.png");
  writeFileSync(svg, `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="80"><rect width="200" height="80" fill="#1d3557"/><text x="20" y="52" font-size="36" fill="#f1faee" font-family="sans-serif">TITLE</text></svg>`);
  await inkscape.svgToPng(svg, png);
  const p = await ff.probe(png);
  return { version, pass: p.width === 200 && p.height === 80, detail: `svg -> png ${p.width}x${p.height}` };
}

async function smokeFfmpeg(): Promise<{ version: string; detail: string; pass: boolean }> {
  const version = await ff.version();
  const out = join(DIR, "ffmpeg-smoke.mp4");
  await ff.ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24:duration=1", "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", out]);
  const p = await ff.probe(out, true);
  return { version, pass: p.hasAudio && p.hasVideo && p.frames === 24, detail: `1 s clip: ${p.frames} frames, audio ${p.hasAudio}` };
}

async function smokeSox(): Promise<{ version: string; detail: string; pass: boolean }> {
  const version = await sox.version();
  const out = join(DIR, "sox-tone.wav");
  await sox.sox(["-n", "-r", "48000", "-c", "1", "-b", "16", out, "synth", "1", "sine", "440", "vol", "0.5"]);
  const p = await ff.probe(out);
  return { version, pass: Math.abs(p.duration - 1) < 0.01, detail: `tone ${p.duration.toFixed(3)} s` };
}

async function smokeRhubarb(): Promise<{ version: string; detail: string; pass: boolean }> {
  const version = await rhubarb.version();
  const wav = join(DIR, "rhubarb-in.wav");
  // A short voiced-like signal: two vowel-ish formant bursts separated by silence.
  await sox.sox(["-n", "-r", "16000", "-c", "1", "-b", "16", wav, "synth", "0.4", "sine", "220", "sine", "880", "remix", "1",
    "pad", "0.2", "0.3", "repeat", "1"]);
  const cues = await rhubarb.mouthCues(wav);
  return { version, pass: cues.length > 0, detail: `${cues.length} mouth cues (${cues.map((c) => c.value).join("")})` };
}

export async function doctor(): Promise<CommandResult> {
  mkdirSync(DIR, { recursive: true });
  const results: Smoke[] = [];
  // Sequential: Blender and Krita both want the GPU and lots of RAM.
  results.push(await timed("ffmpeg", smokeFfmpeg));
  results.push(await timed("sox", smokeSox));
  results.push(await timed("rhubarb", smokeRhubarb));
  results.push(await timed("inkscape", smokeInkscape));
  results.push(await timed("blender", smokeBlender));
  results.push(await timed("krita", smokeKrita));

  const lines = results.map((r) =>
    `${r.pass ? "PASS" : "FAIL"}  ${r.tool.padEnd(9)} ${(r.version ?? "-").padEnd(10)} pinned ${r.pinned.padEnd(9)} ${r.seconds.toFixed(1).padStart(6)}s  ${r.detail}`);
  const engineFile = join(DIR, "blender-engine.json");
  const engine = existsSync(engineFile) ? (JSON.parse(readFileSync(engineFile, "utf8")) as { engine: string }).engine : null;
  const failed = results.filter((r) => !r.pass);
  const data = { results, blenderEngine: engine };
  if (failed.length) return { ...fail("doctor", `${failed.length} smoke test(s) failed: ${failed.map((f) => `${f.tool} (${f.detail})`).join("; ")}`, undefined, data), lines };
  return ok("doctor", `all ${results.length} smoke tests passed; Blender renders with ${engine}`, data, lines);
}
