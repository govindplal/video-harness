// Blender adapter: the only code that starts Blender.
// Invocation (Blender 5.2 manual, Command Line Arguments): arguments run in order;
// -b background, --factory-startup ignore user prefs, --python-exit-code N exit N on a Python exception,
// -P script, then "--" and our own args (read from sys.argv in the script).
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { CACHE_DIR, TOOLSCRIPTS_DIR, toolExe, lock } from "../paths.ts";
import { run, runOk, ToolError, lastLine } from "./proc.ts";

const PY_EXIT = 3;
const ACCESS_VIOLATION = 0xc0000005; // Windows exit code 3221225477

/** HARNESS_COMPILE_SUBPROCESSES overrides; 0 disables. Default: measured below in docs/Gotchas. */
function defaultCompileSubprocesses(): number {
  const e = process.env.HARNESS_COMPILE_SUBPROCESSES;
  return e === undefined ? 0 : Number(e);
}

export async function version(): Promise<string> {
  const r = await runOk("blender", toolExe("blender"), ["--factory-startup", "-b", "--version"], { timeoutMs: 120_000 });
  const m = /Blender\s+(\d+\.\d+\.\d+)/.exec(r.stdout.toString("utf8"));
  return m ? m[1] : "unknown";
}

export interface ScriptResult<T> {
  result: T;
  log: string;
  ms: number;
}

/**
 * Run toolscripts/blender/<script>.py with a job object. The script reads the job JSON,
 * does its work and writes a result JSON to job.resultPath.
 */
export async function runScript<T = Record<string, unknown>>(
  script: string,
  job: Record<string, unknown>,
  opts: { blendFile?: string; timeoutMs?: number; gpuBackend?: "opengl" | "vulkan"; compileSubprocesses?: number } = {},
): Promise<ScriptResult<T>> {
  const jobsDir = join(CACHE_DIR, "jobs");
  mkdirSync(jobsDir, { recursive: true });
  const body = JSON.stringify(job, null, 2);
  const id = createHash("sha256").update(script + body).digest("hex").slice(0, 16);
  const jobPath = join(jobsDir, `blender-${script}-${id}.json`);
  const resultPath = join(jobsDir, `blender-${script}-${id}.result.json`);
  writeFileSync(jobPath, JSON.stringify({ ...job, resultPath }, null, 2));

  const args = ["--factory-startup", "-b"];
  if (opts.blendFile) args.push(opts.blendFile);
  if (opts.gpuBackend) args.push("--gpu-backend", opts.gpuBackend);
  // Parallel shader compilation (OpenGL only). EEVEE compiles ~100 s of shaders on the first frame of every launch.
  const subs = opts.compileSubprocesses ?? defaultCompileSubprocesses();
  if (subs > 0) args.push("--gpu-compilation-subprocesses", String(subs));
  args.push("--python-exit-code", String(PY_EXIT), "-P", join(TOOLSCRIPTS_DIR, "blender", `${script}.py`), "--", jobPath);

  rmSync(resultPath, { force: true }); // a result left by an earlier run must never count for this one
  const r = await run(toolExe("blender"), args, { timeoutMs: opts.timeoutMs ?? 30 * 60_000 });
  const log = r.stdout.toString("utf8") + r.stderr;
  // The Intel OpenGL driver (ig9icd64.dll) sometimes crashes inside ExitProcess, after Blender has finished and said
  // "Blender quit". The work is complete and the result was written, so accept it, but say so in the log.
  const exitCrash = r.code === ACCESS_VIOLATION && existsSync(resultPath) && /Blender quit/.test(log);
  if (exitCrash) process.stderr.write(`warning: blender ${script} crashed in the GPU driver during shutdown, after writing its result; result kept\n`);
  if ((r.code !== 0 && !exitCrash) || !existsSync(resultPath)) {
    const pyErr = /(\w+Error: .*)/.exec(log)?.[1];
    throw new ToolError("blender", r.code, log, `blender ${script} failed (exit ${r.code}): ${pyErr ?? lastLine(log)}`);
  }
  const result = JSON.parse(readFileSync(resultPath, "utf8")) as T;
  return { result, log, ms: r.ms };
}

export function scriptHash(script: string): string {
  return createHash("sha256").update(readFileSync(join(TOOLSCRIPTS_DIR, "blender", `${script}.py`))).digest("hex");
}

export function pinnedVersion(): string {
  return lock().tools.blender.version;
}
