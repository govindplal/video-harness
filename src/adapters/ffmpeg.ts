// ffmpeg/ffprobe adapter: the only code that starts ffmpeg.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { lock } from "../paths.ts";
import { run, runOk } from "./proc.ts";

const FF = () => lock().tools.ffmpeg.exe;
const PROBE = () => lock().tools.ffmpeg.probe ?? "ffprobe";

export async function version(): Promise<string> {
  const r = await runOk("ffmpeg", FF(), ["-hide_banner", "-version"]);
  return /ffmpeg version (\S+)/.exec(r.stdout.toString())?.[1] ?? "unknown";
}

/** Run ffmpeg with arbitrary args (always -y, quiet). */
export async function ffmpeg(args: string[], timeoutMs = 20 * 60_000): Promise<string> {
  const r = await runOk("ffmpeg", FF(), ["-hide_banner", "-y", "-loglevel", "error", ...args], { timeoutMs });
  return r.stderr;
}

export interface ProbeInfo {
  duration: number;
  width?: number;
  height?: number;
  fps?: number;
  frames?: number;
  hasAudio: boolean;
  hasVideo: boolean;
}

export async function probe(file: string, countFrames = false): Promise<ProbeInfo> {
  const args = ["-v", "error", "-print_format", "json", "-show_format", "-show_streams"];
  if (countFrames) args.push("-count_frames");
  args.push(file);
  const r = await runOk("ffprobe", PROBE(), args);
  const j = JSON.parse(r.stdout.toString()) as {
    format: { duration?: string };
    streams: { codec_type: string; width?: number; height?: number; r_frame_rate?: string; nb_read_frames?: string; nb_frames?: string }[];
  };
  const v = j.streams.find((s) => s.codec_type === "video");
  const fpsParts = v?.r_frame_rate?.split("/").map(Number);
  return {
    duration: Number(j.format.duration ?? 0),
    width: v?.width,
    height: v?.height,
    fps: fpsParts && fpsParts[1] ? fpsParts[0] / fpsParts[1] : undefined,
    frames: v ? Number(v.nb_read_frames ?? v.nb_frames ?? NaN) : undefined,
    hasAudio: j.streams.some((s) => s.codec_type === "audio"),
    hasVideo: !!v,
  };
}

/** Decode one image (or frame N of a video) to raw RGB24 at w x h. */
export async function decodeRgb(file: string, w: number, h: number, frame = 0): Promise<Buffer> {
  const vf = frame > 0 ? `select=eq(n\\,${frame}),scale=${w}:${h}:flags=neighbor` : `scale=${w}:${h}:flags=neighbor`;
  const r = await runOk("ffmpeg", FF(), ["-hide_banner", "-loglevel", "error", "-i", file, "-vf", vf, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
  if (r.stdout.length !== w * h * 3) throw new Error(`decodeRgb ${file}: got ${r.stdout.length} bytes, expected ${w * h * 3}`);
  return r.stdout;
}

/** MD5 of the decoded pixels only (ignores file metadata), e.g. to tell a render difference from a metadata difference. */
export async function pixelHash(file: string): Promise<string> {
  const r = await runOk("ffmpeg", FF(), ["-hide_banner", "-loglevel", "error", "-i", file, "-map", "0:v:0", "-f", "md5", "-"]);
  return /MD5=([0-9a-f]+)/.exec(r.stdout.toString())?.[1] ?? "unknown";
}

/** Decode every frame of a sequence/video to raw RGB24 at w x h, returned as one buffer per frame. */
export async function decodeAllRgb(input: string[], w: number, h: number): Promise<Buffer[]> {
  const r = await runOk("ffmpeg", FF(), ["-hide_banner", "-loglevel", "error", ...input, "-vf", `scale=${w}:${h}:flags=area`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
  const size = w * h * 3;
  const out: Buffer[] = [];
  for (let o = 0; o + size <= r.stdout.length; o += size) out.push(r.stdout.subarray(o, o + size));
  return out;
}

export interface Loudness { integrated: number; truePeak: number; lra: number }

/** EBU R128 measurement via the loudnorm filter in analysis mode. */
export async function loudness(file: string): Promise<Loudness> {
  const r = await run(FF(), ["-hide_banner", "-nostats", "-i", file, "-af", "loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json", "-f", "null", "-"]);
  const m = /\{[\s\S]*?"input_i"[\s\S]*?\}/.exec(r.stderr);
  if (!m) throw new Error(`loudness: no loudnorm output for ${file}`);
  const j = JSON.parse(m[0]) as { input_i: string; input_tp: string; input_lra: string };
  return { integrated: Number(j.input_i), truePeak: Number(j.input_tp), lra: Number(j.input_lra) };
}

/** Encode a numbered PNG sequence (frame_0001.png ...) to H.264. `preview` trades quality for speed. */
export async function encodeFrames(framesDir: string, fps: number, out: string, preview: boolean): Promise<void> {
  const args = ["-framerate", String(fps), "-start_number", "1", "-i", `${framesDir.replaceAll("\\", "/")}/frame_%04d.png`,
    "-c:v", "libx264", "-preset", preview ? "veryfast" : "medium", "-crf", preview ? "24" : "16",
    "-pix_fmt", "yuv420p", "-r", String(fps), "-movflags", "+faststart", "-an", out];
  await ffmpeg(args);
}

/** Join encoded shots that share codec, size and frame rate without re-encoding. */
export async function concatCopy(files: string[], out: string, listPath: string): Promise<void> {
  writeFileSync(listPath, files.map((f) => `file '${f.replaceAll("\\", "/").replaceAll("'", "'\\''")}'`).join("\n") + "\n");
  await ffmpeg(["-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", "-movflags", "+faststart", out]);
}

const FONT_CANDIDATES = ["C:/Windows/Fonts/arial.ttf", "C:/Windows/Fonts/segoeui.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/System/Library/Fonts/Helvetica.ttc"];

/** One labelled thumbnail per item, tiled into a single PNG. Labels must be simple ids ([a-z0-9-]). */
export async function contactSheet(items: { image: string; label: string }[], out: string, workDir: string, cols = 3, thumbWidth = 640): Promise<void> {
  const font = FONT_CANDIDATES.find((f) => existsSync(f));
  if (!font) throw new Error("contact sheet: no font found for drawtext");
  mkdirSync(workDir, { recursive: true });
  const fontArg = font.replace(":", "\\:"); // drawtext needs the drive-letter colon escaped
  for (let i = 0; i < items.length; i++) {
    const label = items[i].label.replace(/[^a-zA-Z0-9_-]/g, "_");
    const vf = `scale=${thumbWidth}:-2,drawtext=fontfile='${fontArg}':text='${label}':x=12:y=10:fontsize=30:fontcolor=white:box=1:boxcolor=black@0.65:boxborderw=6`;
    await ffmpeg(["-i", items[i].image, "-vf", vf, "-frames:v", "1", `${workDir}/thumb_${String(i + 1).padStart(3, "0")}.png`]);
  }
  const c = Math.min(cols, items.length);
  const rows = Math.ceil(items.length / c);
  await ffmpeg(["-framerate", "1", "-i", `${workDir}/thumb_%03d.png`, "-vf", `tile=${c}x${rows}:padding=6:color=0x202020`, "-frames:v", "1", out]);
}
