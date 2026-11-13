// Shot length: frame count must equal duration x fps, both for the rendered frames and for the encoded video.
import { readdirSync } from "node:fs";
import { frameCount } from "../pipeline/shot.ts";
import type { Checker } from "./types.ts";

export const shotLength: Checker = async ({ project, art }) => {
  const expected = frameCount(project, art.shot);
  const rendered = readdirSync(art.framesDir).filter((f) => /^frame_\d+\.png$/.test(f)).length;
  const encoded = art.encode.frames;
  const field = `shots[${art.shotIndex}].duration`;
  const base = { check: "shot-length", shot: art.shot.id };
  if (rendered !== expected) {
    return { ...base, pass: false, field, reason: `rendered ${rendered} frames, expected ${expected} (${art.shot.duration} s x ${project.fps} fps)`, measured: { rendered, encoded, expected } };
  }
  if (encoded !== expected) {
    return { ...base, pass: false, field, reason: `encoded video has ${encoded} frames, expected ${expected}`, measured: { rendered, encoded, expected } };
  }
  return { ...base, pass: true, reason: `${expected} frames rendered and encoded (${art.shot.duration} s x ${project.fps} fps)`, measured: { rendered, encoded, expected } };
};
