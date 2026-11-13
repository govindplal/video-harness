#!/usr/bin/env node
// harness CLI: the ten commands from spec section 6. Exit 0 only on success.
import { doctor } from "./doctor.ts";
import { fail, HarnessError, type CommandResult } from "./result.ts";

type Handler = (args: string[], flags: Record<string, string | true>) => Promise<CommandResult>;

const commands: Record<string, { usage: string; run: Handler }> = {
  doctor: { usage: "doctor", run: () => doctor() },
};

export function register(name: string, usage: string, run: Handler): void {
  commands[name] = { usage, run };
}

function parse(argv: string[]): { cmd: string; args: string[]; flags: Record<string, string | true> } {
  const flags: Record<string, string | true> = {};
  const args: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2);
      flags[k] = v ?? true;
    } else args.push(a);
  }
  return { cmd: args.shift() ?? "help", args, flags };
}

function print(r: CommandResult, json: boolean): void {
  if (json) {
    process.stdout.write(JSON.stringify(r, null, 2) + "\n");
    return;
  }
  for (const l of r.lines ?? []) process.stdout.write(l + "\n");
  if (r.ok) process.stdout.write(`ok: ${r.summary}\n`);
  else process.stderr.write(`FAILED ${r.command}: ${r.summary}${r.field ? ` [field: ${r.field}]` : ""}\n`);
}

export async function main(argv: string[]): Promise<number> {
  await import("./commands.ts");
  const { cmd, args, flags } = parse(argv);
  const json = flags.json === true;
  if (cmd === "help" || !commands[cmd]) {
    const usage = Object.values(commands).map((c) => `  harness ${c.usage} [--json]`).join("\n");
    process.stdout.write(`usage:\n${usage}\n`);
    return cmd === "help" ? 0 : 2;
  }
  let r: CommandResult;
  try {
    r = await commands[cmd].run(args, flags);
  } catch (e) {
    const err = e as Error;
    r = fail(cmd, err.message.split("\n")[0], e instanceof HarnessError ? e.field : undefined);
    if (process.env.HARNESS_DEBUG) process.stderr.write((err.stack ?? "") + "\n");
  }
  print(r, json);
  return r.ok ? 0 : 1;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
