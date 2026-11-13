// ffmpeg/ffprobe adapter: the only code that starts ffmpeg.
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
