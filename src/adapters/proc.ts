// Process runner shared by the adapters. Only files in src/adapters/ may import this.
import { spawn } from "node:child_process";
import { statSync } from "node:fs";

export interface RunResult {
  code: number;
  stdout: Buffer;
  stderr: string;
  ms: number;
}

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  input?: Buffer | string;
  /** Tools like kritarunner can linger after finishing. When this file exists and is non-empty, kill the process after graceMs. */
  doneFile?: string;
  graceMs?: number;
}

export class ToolError extends Error {
  tool: string;
  code: number;
  tail: string;
  constructor(tool: string, code: number, tail: string, message?: string) {
    super(message ?? `${tool} exited with code ${code}: ${lastLine(tail)}`);
    this.tool = tool;
    this.code = code;
    this.tail = tail;
  }
}

export function lastLine(s: string): string {
  const lines = s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.at(-1) ?? "";
}

export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const t0 = performance.now();
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    let err = "";
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => {
      err += d.toString("utf8");
      if (err.length > 200_000) err = err.slice(-100_000);
    });
    let timer: NodeJS.Timeout | undefined;
    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        child.kill();
        reject(new ToolError(cmd, -1, err, `${cmd} timed out after ${opts.timeoutMs} ms`));
      }, opts.timeoutMs);
    }
    let poll: NodeJS.Timeout | undefined;
    let finishedAt: number | undefined;
    if (opts.doneFile) {
      const doneFile = opts.doneFile;
      poll = setInterval(() => {
        try {
          if (statSync(doneFile).size > 0) {
            finishedAt ??= Date.now();
            if (Date.now() - finishedAt >= (opts.graceMs ?? 10_000)) child.kill();
          }
        } catch { /* not there yet */ }
      }, 500);
    }
    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      if (poll) clearInterval(poll);
      reject(new ToolError(cmd, -1, "", `could not start ${cmd}: ${e.message}`));
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (poll) clearInterval(poll);
      resolvePromise({ code: code ?? -1, stdout: Buffer.concat(out), stderr: err, ms: performance.now() - t0 });
    });
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

/** Run and throw ToolError on a non-zero exit. */
export async function runOk(tool: string, cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const r = await run(cmd, args, opts);
  if (r.code !== 0) throw new ToolError(tool, r.code, r.stderr + "\n" + r.stdout.toString("utf8").slice(-4000));
  return r;
}
