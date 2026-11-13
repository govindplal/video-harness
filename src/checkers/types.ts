// Checker types and config. Each checker returns pass/fail with a one-line reason a model can act on.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../paths.ts";
import type { Project, Shot } from "../spec/schema.ts";
import type { ShotKeys, RenderMeta, EncodeMeta } from "../pipeline/shot.ts";

export interface CheckResult {
  check: string;
  shot: string;
  pass: boolean;
  /** One line: what was measured against what threshold. On failure also names the spec field to change, if one applies. */
  reason: string;
  /** Spec field that caused a failure, e.g. shots[0].duration. */
  field?: string;
  measured?: unknown;
}

/** Everything a checker may look at for one rendered shot. All paths are absolute. */
export interface ShotArtifacts {
  shotIndex: number;
  shot: Shot;
  keys: ShotKeys;
  framesDir: string;
  render: RenderMeta;
  videoFile: string;
  encode: EncodeMeta;
  animateBlend: string;
}

export interface CheckContext {
  project: Project;
  art: ShotArtifacts;
  config: ChecksConfig;
  preview: boolean;
}

export interface ChecksConfig {
  shotLength: Record<string, never>;
  frameNotEmpty: {
    sampleEvery: number; analysisWidth: number; analysisHeight: number; minStdDev: number;
    voidColor: [number, number, number]; missingTextureColor: [number, number, number];
    colorTolerance: number; maxBadPixelFraction: number;
  };
  repeatable: { frame: "mid" | number };
  [other: string]: unknown;
}

let cached: ChecksConfig | undefined;
export function loadConfig(): ChecksConfig {
  cached ??= JSON.parse(readFileSync(join(ROOT, "config", "checks.json"), "utf8")) as ChecksConfig;
  return cached;
}

export type Checker = (ctx: CheckContext) => Promise<CheckResult>;
