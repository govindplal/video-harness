// Command result protocol: every command returns a CommandResult. main.ts prints it
// (one line on failure naming what failed and which spec field), or JSON with --json.

export interface CommandResult {
  ok: boolean;
  command: string;
  /** One-line summary for humans. On failure: what failed and why. */
  summary: string;
  /** Spec field that caused a failure, as a JSON path like shots[2].camera.lens. */
  field?: string;
  data?: unknown;
  /** Extra human-readable lines printed before the summary (not in failure one-liners). */
  lines?: string[];
}

export class HarnessError extends Error {
  field?: string;
  constructor(message: string, field?: string) {
    super(message);
    this.field = field;
  }
}

export function ok(command: string, summary: string, data?: unknown, lines?: string[]): CommandResult {
  return { ok: true, command, summary, data, lines };
}

export function fail(command: string, summary: string, field?: string, data?: unknown): CommandResult {
  return { ok: false, command, summary, field, data };
}
