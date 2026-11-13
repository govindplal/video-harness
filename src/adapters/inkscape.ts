// Inkscape adapter: the only code that starts Inkscape. Uses the console launcher (inkscape.com on Windows).
import { toolExe } from "../paths.ts";
import { runOk } from "./proc.ts";

export async function version(): Promise<string> {
  const r = await runOk("inkscape", toolExe("inkscape"), ["--version"], { timeoutMs: 120_000 });
  return /Inkscape (\d+\.\d+(\.\d+)?)/.exec(r.stdout.toString() + r.stderr)?.[1] ?? "unknown";
}

export async function svgToPng(svg: string, png: string, width?: number): Promise<void> {
  const args = ["--export-type=png", `--export-filename=${png}`];
  if (width) args.push(`--export-width=${width}`);
  args.push(svg);
  await runOk("inkscape", toolExe("inkscape"), args, { timeoutMs: 5 * 60_000 });
}
