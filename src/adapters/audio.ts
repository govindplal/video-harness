// Audio helpers: SoX synthesis and ffmpeg mixing. Adapter file: the only place besides sox.ts/ffmpeg.ts that starts these tools.
import { toolExe } from "../paths.ts";
import { runOk, run } from "./proc.ts";
import { lock } from "../paths.ts";

const FF = (): string => lock().tools.ffmpeg.exe;
const SOX = (): string => toolExe("sox");
const sox = (args: string[]): Promise<unknown> => runOk("sox", SOX(), args, { timeoutMs: 120_000 });
const ffm = (args: string[]): Promise<unknown> => runOk("ffmpeg", FF(), ["-hide_banner", "-y", "-loglevel", "error", ...args], { timeoutMs: 600_000 });

export const CUE_LENGTH: Record<string, number> = { engine: 0, screech: 1.0, whoosh: 0.9, thump: 0.45, click: 0.06 };
export const LEVEL_DB: Record<string, number> = { low: -18, mid: -12, high: -6 };

/** Synthesise one cue as 48 kHz mono 16-bit WAV. `length` in seconds. */
export async function synthCue(cue: string, length: number, out: string): Promise<void> {
  const base = ["-n", "-r", "48000", "-c", "1", "-b", "16", out];
  const L = length.toFixed(3);
  switch (cue) {
    case "engine":
      await sox([...base, "synth", L, "sine", "62", "sine", "124", "sine", "186", "tremolo", "26", "60", "lowpass", "700", "gain", "-3"]);
      break;
    case "screech":
      await sox([...base, "synth", L, "whitenoise", "bandpass", "2600", "700", "tremolo", "9", "70", "fade", "q", "0.05", L, "0.35", "gain", "-2"]);
      break;
    case "whoosh":
      await sox([...base, "synth", L, "pinknoise", "lowpass", "2200", "fade", "h", (length * 0.45).toFixed(3), L, (length * 0.45).toFixed(3), "gain", "-2"]);
      break;
    case "thump":
      await sox([...base, "synth", L, "sine", "58", "fade", "q", "0.005", L, (length * 0.9).toFixed(3), "gain", "-1"]);
      break;
    case "click":
      await sox([...base, "synth", L, "square", "1800", "fade", "q", "0.001", L, "0.04"]);
      break;
    default:
      throw new Error(`unknown cue ${cue}`);
  }
}

/** A looping synthesized bed of `length` seconds. */
export async function synthBed(name: string, length: number, out: string): Promise<void> {
  if (name !== "drive-pulse") throw new Error(`unknown music bed ${name}`);
  const L = length.toFixed(3);
  await sox(["-n", "-r", "48000", "-c", "1", "-b", "16", out, "synth", L, "square", "55", "tremolo", "4", "100", "lowpass", "180", "synth", "sin", "mix", "110", "gain", "-4"]);
}

export interface MixItem { file: string; at: number; db: number }

/** Mix items at their start times into one stereo WAV of exactly `duration` seconds. */
export async function mixAt(items: MixItem[], duration: number, out: string): Promise<void> {
  if (items.length === 0) {
    await ffm(["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-t", duration.toFixed(4), "-c:a", "pcm_s16le", out]);
    return;
  }
  const inputs = items.flatMap((i) => ["-i", i.file]);
  const chains = items.map((it, k) => `[${k}:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=${it.db}dB,adelay=${Math.round(it.at * 1000)}:all=1[a${k}]`);
  const mix = `${items.map((_, k) => `[a${k}]`).join("")}amix=inputs=${items.length}:normalize=0:duration=longest,apad,atrim=0:${duration.toFixed(4)}[m]`;
  await ffm([...inputs, "-filter_complex", [...chains, mix].join(";"), "-map", "[m]", "-c:a", "pcm_s16le", "-ar", "48000", out]);
}

/** Concatenate WAVs end to end. */
export async function concatWav(files: string[], out: string): Promise<void> {
  const inputs = files.flatMap((f) => ["-i", f]);
  await ffm([...inputs, "-filter_complex", `${files.map((_, k) => `[${k}:a]`).join("")}concat=n=${files.length}:v=0:a=1[o]`, "-map", "[o]", "-c:a", "pcm_s16le", out]);
}

/** Two-pass loudness normalisation to the target (integrated LUFS, true peak dB). */
export async function normalise(inFile: string, out: string, lufs: number, tp: number): Promise<void> {
  const r = await run(FF(), ["-hide_banner", "-nostats", "-i", inFile, "-af", `loudnorm=I=${lufs}:TP=${tp}:LRA=11:print_format=json`, "-f", "null", "-"]);
  const m = /\{[\s\S]*?"input_i"[\s\S]*?\}/.exec(r.stderr);
  if (!m) throw new Error("loudnorm analysis produced no output");
  const j = JSON.parse(m[0]) as Record<string, string>;
  const af = `loudnorm=I=${lufs}:TP=${tp}:LRA=11:measured_I=${j.input_i}:measured_TP=${j.input_tp}:measured_LRA=${j.input_lra}:measured_thresh=${j.input_thresh}:offset=${j.target_offset}:linear=true`;
  await ffm(["-i", inFile, "-af", af, "-ar", "48000", "-c:a", "pcm_s16le", out]);
}

/** Mux video + audio, optionally burning an SRT. Re-encodes video only when subtitles are burned. */
export async function mux(video: string, audio: string, out: string, srt?: string): Promise<void> {
  if (srt) {
    const s = srt.replaceAll("\\", "/").replace(":", "\\:");
    await ffm(["-i", video, "-i", audio, "-vf", `subtitles='${s}':force_style='FontName=Arial,FontSize=22,Outline=2,MarginV=40'`, "-c:v", "libx264", "-preset", "medium", "-crf", "16", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", out]);
  } else {
    await ffm(["-i", video, "-i", audio, "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", out]);
  }
}
