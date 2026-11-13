// Rhubarb Lip Sync adapter: the only code that starts Rhubarb. First real use is milestone 5.
import { toolExe } from "../paths.ts";
import { runOk } from "./proc.ts";

export async function version(): Promise<string> {
  const r = await runOk("rhubarb", toolExe("rhubarb"), ["--version"]);
  return /(\d+\.\d+\.\d+)/.exec(r.stdout.toString() + r.stderr)?.[1] ?? "unknown";
}

export interface MouthCue { start: number; end: number; value: string }

/** Mouth cues for a WAV. The phonetic recognizer works for any language and needs no dialog text. */
export async function mouthCues(wav: string): Promise<MouthCue[]> {
  // No --quiet: in Rhubarb 1.14.0 it also suppresses the JSON on stdout. Progress goes to stderr, which run() keeps apart.
  const r = await runOk("rhubarb", toolExe("rhubarb"), ["-r", "phonetic", "-f", "json", wav], { timeoutMs: 5 * 60_000 });
  const text = r.stdout.toString();
  if (!text.trim()) throw new Error(`rhubarb produced no output for ${wav}: ${r.stderr.split(/\r?\n/).filter(Boolean).at(-1) ?? "no stderr"}`);
  const j = JSON.parse(text) as { mouthCues: MouthCue[] };
  return j.mouthCues;
}
