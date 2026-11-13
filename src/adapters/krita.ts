// Krita adapter: the only code that starts Krita.
// Headless scripting uses kritarunner (ships next to krita.exe): `kritarunner -s <module> -f <function>`.
// The module must be on Krita's Python path, so we keep a fixed shim (toolscripts/krita/harness_runner.py)
// in the install's share/krita/pykrita folder. The shim reads the job path from HARNESS_KRITA_JOB and runs
// toolscripts/krita/<script>.py's main(job). Krita swallows print(), so results go through a JSON file.
import { mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { CACHE_DIR, TOOLSCRIPTS_DIR, toolExe } from "../paths.ts";
import { run, runOk, ToolError, lastLine } from "./proc.ts";

function kritaRoot(): string {
  return dirname(dirname(toolExe("krita"))); // .../krita-x64-<ver>
}
function runnerExe(): string {
  return join(dirname(toolExe("krita")), "kritarunner.exe");
}

function ensureShim(): void {
  const src = join(TOOLSCRIPTS_DIR, "krita", "harness_runner.py");
  const dst = join(kritaRoot(), "share", "krita", "pykrita", "harness_runner.py");
  mkdirSync(dirname(dst), { recursive: true });
  if (!existsSync(dst) || readFileSync(dst, "utf8") !== readFileSync(src, "utf8")) copyFileSync(src, dst);
}

export async function version(): Promise<string> {
  const r = await runOk("krita", toolExe("krita"), ["--version"], { timeoutMs: 120_000 });
  return /(\d+\.\d+\.\d+(\.\d+)?)/.exec(r.stdout.toString() + r.stderr)?.[1] ?? "unknown";
}

export async function runScript<T = Record<string, unknown>>(
  script: string,
  job: Record<string, unknown>,
  opts: { timeoutMs?: number } = {},
): Promise<{ result: T; ms: number }> {
  ensureShim();
  const jobsDir = join(CACHE_DIR, "jobs");
  mkdirSync(jobsDir, { recursive: true });
  const body = JSON.stringify(job);
  const id = createHash("sha256").update(script + body).digest("hex").slice(0, 16);
  const jobPath = join(jobsDir, `krita-${script}-${id}.json`);
  const resultPath = join(jobsDir, `krita-${script}-${id}.result.json`);
  const scriptPath = join(TOOLSCRIPTS_DIR, "krita", `${script}.py`);
  writeFileSync(jobPath, JSON.stringify({ ...job, script: scriptPath, resultPath }, null, 2));
  rmSync(resultPath, { force: true });

  // Do NOT set QT_QPA_PLATFORM: an empty value hangs Krita at startup (measured, doctor run 2026-11-13) and
  // "offscreen" segfaults (exit 139). Plain Windows platform plugin works without showing a window.
  const r = await run(runnerExe(), ["-s", "harness_runner", "-f", "main"], {
    env: { HARNESS_KRITA_JOB: jobPath },
    timeoutMs: opts.timeoutMs ?? 20 * 60_000,
    doneFile: resultPath,
    graceMs: 10_000,
  });
  const log = r.stdout.toString("utf8") + r.stderr;
  const text = existsSync(resultPath) ? readFileSync(resultPath, "utf8") : "";
  if (!text) throw new ToolError("krita", r.code, log, `krita ${script} wrote no result (exit ${r.code}): ${lastLine(log)}`);
  const parsed = JSON.parse(text) as { ok: boolean; error?: string; result?: T };
  if (!parsed.ok) throw new ToolError("krita", r.code, parsed.error ?? "", `krita ${script} failed: ${lastLine(parsed.error ?? "")}`);
  return { result: parsed.result as T, ms: r.ms };
}

export function scriptHash(script: string): string {
  return createHash("sha256").update(readFileSync(join(TOOLSCRIPTS_DIR, "krita", `${script}.py`))).digest("hex");
}
