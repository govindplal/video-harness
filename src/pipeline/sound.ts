// Stage 6: sound. One audio file per shot from its cues, plus the project's music bed.
import { join } from "node:path";
import { hashObj, runStage, type StageRun } from "../planner/cache.ts";
import * as audio from "../adapters/audio.ts";
import { lock } from "../paths.ts";
import type { Project, Shot } from "../spec/schema.ts";

export interface SoundMeta { file: string }

export function soundKey(shot: Shot, fps: number): string {
  return hashObj({ stage: "sound", cues: shot.sound, duration: shot.duration, fps, sox: lock().tools.sox.version, v: 1 });
}

export async function shotSound(shot: Shot, fps: number): Promise<StageRun<SoundMeta>> {
  return runStage<SoundMeta>("sound", soundKey(shot, fps), async (dir) => {
    const items: audio.MixItem[] = [];
    for (let i = 0; i < shot.sound.length; i++) {
      const c = shot.sound[i];
      const len = c.length ?? (audio.CUE_LENGTH[c.cue] || shot.duration - c.at);
      const wav = join(dir, `cue${i}.wav`);
      await audio.synthCue(c.cue, Math.min(len, shot.duration - c.at), wav);
      items.push({ file: wav, at: c.at, db: audio.LEVEL_DB[c.level] });
    }
    await audio.mixAt(items, shot.duration, join(dir, "shot.wav"));
    return { file: "shot.wav" };
  });
}

export async function musicBed(project: Project, total: number): Promise<StageRun<SoundMeta> | undefined> {
  if (project.music === "none") return undefined;
  return runStage<SoundMeta>("music", hashObj({ stage: "music", name: project.music, total, v: 1 }), async (dir) => {
    await audio.synthBed(project.music, total, join(dir, "bed.wav"));
    return { file: "bed.wav" };
  });
}
