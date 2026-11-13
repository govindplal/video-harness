// Repo paths and the pinned tool table. No tool is started from here.
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const TOOLS_DIR = join(ROOT, ".tools");
export const CACHE_DIR = join(ROOT, ".cache");
export const ASSETS_DIR = join(ROOT, "assets");
export const PROJECTS_DIR = join(ROOT, "projects");
export const TOOLSCRIPTS_DIR = join(ROOT, "toolscripts");

export type ToolName = "blender" | "krita" | "inkscape" | "ffmpeg" | "sox" | "rhubarb";

export interface LockEntry {
  version: string;
  source: string;
  url: string | null;
  sha256: string | null;
  archive: "zip" | "msi" | "system";
  dir: string | null;
  exe: string;
  probe?: string;
}

interface Lock { platform: string; tools: Record<ToolName, LockEntry> }

let lockCache: Lock | undefined;
export function lock(): Lock {
  lockCache ??= JSON.parse(readFileSync(join(ROOT, "tools.lock.json"), "utf8")) as Lock;
  return lockCache;
}

/** Absolute path (or bare command for system tools) of a tool's executable. */
export function toolExe(name: ToolName): string {
  const e = lock().tools[name];
  return e.archive === "system" ? e.exe : join(TOOLS_DIR, e.exe);
}

export function toolInstalled(name: ToolName): boolean {
  const e = lock().tools[name];
  return e.archive === "system" ? true : existsSync(join(TOOLS_DIR, e.exe));
}

export function projectDir(name: string): string {
  return join(PROJECTS_DIR, name);
}
