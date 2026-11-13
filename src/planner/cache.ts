// Stage cache: every stage output lives in .cache/stages/<stage>/<key>/ where key is a hash of everything
// that could change it (spec fields, upstream keys or input file hashes, tool version, tool script hash).
//
// Integrity rules (learned the hard way: two racing runs once committed an entry whose files were gone):
//  - done.json records every output file with its size; a cache hit is valid only if all of them still match.
//  - each run works in its own temp dir (<key>.<pid>.tmp) and renames it into place on success.
//  - a <key>.lock file (holding the pid) serialises runs of the same stage key; a second run waits, then
//    re-checks the cache instead of redoing the work.
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { CACHE_DIR } from "../paths.ts";

/** JSON with sorted keys so equal objects hash equally. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

export function hashObj(v: unknown): string {
  return createHash("sha256").update(canonical(v)).digest("hex").slice(0, 24);
}

export function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export interface StageRun<M> {
  stage: string;
  key: string;
  dir: string;
  cached: boolean;
  seconds: number;
  meta: M;
}

interface Done<M> { stage: string; key: string; files: Record<string, number>; meta: M }

export function stageDir(stage: string, key: string): string {
  return join(CACHE_DIR, "stages", stage, key);
}

function listFiles(root: string): Record<string, number> {
  const out: Record<string, number> = {};
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name !== "done.json") out[relative(root, p).replaceAll("\\", "/")] = statSync(p).size;
    }
  };
  walk(root);
  return out;
}

/** Read a cache entry's metadata, or undefined if it is missing or damaged (any file gone or resized). */
export function readMeta<M>(stage: string, key: string): M | undefined {
  const dir = stageDir(stage, key);
  const f = join(dir, "done.json");
  if (!existsSync(f)) return undefined;
  let done: Done<M>;
  try {
    done = JSON.parse(readFileSync(f, "utf8")) as Done<M>;
  } catch {
    return undefined;
  }
  if (!done.files) return undefined; // entry from before integrity manifests: do not trust it
  for (const [rel, size] of Object.entries(done.files)) {
    try {
      if (statSync(join(dir, rel)).size !== size) return undefined;
    } catch {
      return undefined;
    }
  }
  return done.meta;
}

export function isCached(stage: string, key: string): boolean {
  return readMeta(stage, key) !== undefined;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Take the per-key lock, waiting while another live harness process holds it. Returns a release function. */
async function acquire(lockPath: string, timeoutMs: number): Promise<() => void> {
  const t0 = Date.now();
  for (;;) {
    try {
      const fd = openSync(lockPath, "wx");
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return () => rmSync(lockPath, { force: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let holder = NaN;
      try { holder = Number(readFileSync(lockPath, "utf8")); } catch { /* released meanwhile */ }
      if (!Number.isFinite(holder) || (holder !== process.pid && !pidAlive(holder))) {
        rmSync(lockPath, { force: true }); // stale lock from a dead process
        continue;
      }
      if (Date.now() - t0 > timeoutMs) throw new Error(`stage is locked by another harness process (pid ${holder}) for over ${Math.round(timeoutMs / 1000)} s: ${lockPath}`);
      await sleep(500);
    }
  }
}

/**
 * Run `work(tmpDir)` unless `key` is already cached. `work` writes its files into tmpDir and returns metadata
 * (JSON-serialisable; use paths relative to the stage dir). Set HARNESS_NO_CACHE=1 to force a re-run.
 */
export async function runStage<M>(stage: string, key: string, work: (dir: string) => Promise<M>): Promise<StageRun<M>> {
  const dir = stageDir(stage, key);
  mkdirSync(join(dir, ".."), { recursive: true });
  const useCache = process.env.HARNESS_NO_CACHE !== "1";
  const hit = (): StageRun<M> | undefined => {
    const meta = useCache ? readMeta<M>(stage, key) : undefined;
    return meta === undefined ? undefined : { stage, key, dir, cached: true, seconds: 0, meta };
  };

  const first = hit();
  if (first) return first;
  const release = await acquire(`${dir}.lock`, 30 * 60_000);
  try {
    const second = hit(); // another process may have finished it while we waited
    if (second) return second;
    const t0 = performance.now();
    // We hold this key's lock, so any <key>.<pid>.tmp left in the stage folder belongs to a dead run: sweep it.
    const parent = join(dir, "..");
    const base = `${key}.`;
    for (const e of readdirSync(parent)) if (e.startsWith(base) && e.endsWith(".tmp")) rmSync(join(parent, e), { recursive: true, force: true });
    const tmp = `${dir}.${process.pid}.tmp`;
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    const meta = await work(tmp);
    const done: Done<M> = { stage, key, files: listFiles(tmp), meta };
    writeFileSync(join(tmp, "done.json"), JSON.stringify(done, null, 2));
    rmSync(dir, { recursive: true, force: true });
    renameSync(tmp, dir);
    return { stage, key, dir, cached: false, seconds: (performance.now() - t0) / 1000, meta };
  } finally {
    release();
  }
}
