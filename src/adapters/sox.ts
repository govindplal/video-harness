// SoX adapter: the only code that starts SoX.
import { toolExe } from "../paths.ts";
import { runOk } from "./proc.ts";

export async function version(): Promise<string> {
  const r = await runOk("sox", toolExe("sox"), ["--version"]);
  const text = r.stdout.toString() + r.stderr;
  return /v(\d+\.\d+\.\d+)/.exec(text)?.[1] ?? "unknown";
}

/** Run sox with arbitrary args. */
export async function sox(args: string[], timeoutMs = 5 * 60_000): Promise<void> {
  await runOk("sox", toolExe("sox"), args, { timeoutMs });
}
