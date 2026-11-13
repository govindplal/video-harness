// A small declarative schema language: every spec field has a type, a default and a range.
// validate() checks a value, applies defaults and returns errors with JSON paths.
// toJsonSchema() emits JSON Schema for schema-constrained model output (milestone 4).

export type Field =
  | { kind: "number"; min: number; max: number; default?: number; integer?: boolean; doc: string; optional?: boolean }
  | { kind: "string"; enum?: readonly string[]; pattern?: RegExp; maxLength?: number; default?: string; doc: string; optional?: boolean }
  | { kind: "bool"; default?: boolean; doc: string; optional?: boolean }
  | { kind: "vec3"; min: number; max: number; default?: [number, number, number]; doc: string; optional?: boolean }
  | { kind: "object"; fields: Record<string, Field>; doc: string; optional?: boolean }
  | { kind: "array"; items: Field; minItems: number; maxItems: number; doc: string; optional?: boolean; default?: unknown[] }
  | { kind: "oneOf"; options: readonly Field[]; doc: string; optional?: boolean; default?: unknown };

export interface SpecError {
  field: string;
  message: string;
}

function hasDefault(f: Field): boolean {
  return "default" in f && f.default !== undefined;
}

function cloneDefault(f: Field): unknown {
  return structuredClone((f as { default?: unknown }).default);
}

/** Validate `v` against `f`, returning the value with defaults filled in. Errors are pushed to `errs`. */
export function check(v: unknown, f: Field, path: string, errs: SpecError[]): unknown {
  if (v === undefined) {
    if (hasDefault(f)) return cloneDefault(f);
    if (f.kind === "object") return check({}, f, path, errs);
    if (f.optional) return undefined;
    errs.push({ field: path, message: "is required" });
    return undefined;
  }
  switch (f.kind) {
    case "number": {
      if (typeof v !== "number" || !Number.isFinite(v)) { errs.push({ field: path, message: `must be a number, got ${JSON.stringify(v)}` }); return v; }
      if (f.integer && !Number.isInteger(v)) errs.push({ field: path, message: `must be an integer, got ${v}` });
      if (v < f.min || v > f.max) errs.push({ field: path, message: `must be between ${f.min} and ${f.max}, got ${v}` });
      return v;
    }
    case "string": {
      if (typeof v !== "string") { errs.push({ field: path, message: `must be a string, got ${JSON.stringify(v)}` }); return v; }
      if (f.enum && !f.enum.includes(v)) errs.push({ field: path, message: `must be one of ${f.enum.join("|")}, got "${v}"` });
      if (f.pattern && !f.pattern.test(v)) errs.push({ field: path, message: `must match ${f.pattern}, got "${v}"` });
      if (f.maxLength && v.length > f.maxLength) errs.push({ field: path, message: `must be at most ${f.maxLength} characters` });
      return v;
    }
    case "bool": {
      if (typeof v !== "boolean") errs.push({ field: path, message: `must be true or false, got ${JSON.stringify(v)}` });
      return v;
    }
    case "vec3": {
      if (!Array.isArray(v) || v.length !== 3 || v.some((x) => typeof x !== "number" || !Number.isFinite(x))) {
        errs.push({ field: path, message: `must be [x, y, z] numbers, got ${JSON.stringify(v)}` });
        return v;
      }
      for (const x of v as number[]) if (x < f.min || x > f.max) { errs.push({ field: path, message: `components must be between ${f.min} and ${f.max}` }); break; }
      return v;
    }
    case "object": {
      if (typeof v !== "object" || v === null || Array.isArray(v)) { errs.push({ field: path, message: "must be an object" }); return v; }
      const out: Record<string, unknown> = {};
      const obj = v as Record<string, unknown>;
      for (const k of Object.keys(obj)) {
        if (!(k in f.fields)) errs.push({ field: path ? `${path}.${k}` : k, message: `unknown field (allowed: ${Object.keys(f.fields).join(", ")})` });
      }
      for (const [k, sub] of Object.entries(f.fields)) {
        const r = check(obj[k], sub, path ? `${path}.${k}` : k, errs);
        if (r !== undefined) out[k] = r;
      }
      return out;
    }
    case "array": {
      if (!Array.isArray(v)) { errs.push({ field: path, message: "must be a list" }); return v; }
      if (v.length < f.minItems || v.length > f.maxItems) errs.push({ field: path, message: `must have ${f.minItems} to ${f.maxItems} items, got ${v.length}` });
      return v.map((item, i) => check(item, f.items, `${path}[${i}]`, errs));
    }
    case "oneOf": {
      const tries: SpecError[][] = [];
      for (const opt of f.options) {
        const e: SpecError[] = [];
        const r = check(v, opt, path, e);
        if (!e.length) return r;
        tries.push(e);
      }
      // Report the option whose errors are fewest (closest match).
      tries.sort((a, b) => a.length - b.length);
      errs.push(...tries[0]);
      return v;
    }
  }
}

export function toJsonSchema(f: Field): Record<string, unknown> {
  const base: Record<string, unknown> = { description: f.doc };
  switch (f.kind) {
    case "number":
      return { ...base, type: f.integer ? "integer" : "number", minimum: f.min, maximum: f.max, ...(f.default !== undefined ? { default: f.default } : {}) };
    case "string":
      return { ...base, type: "string", ...(f.enum ? { enum: [...f.enum] } : {}), ...(f.pattern ? { pattern: f.pattern.source } : {}), ...(f.default !== undefined ? { default: f.default } : {}) };
    case "bool":
      return { ...base, type: "boolean", ...(f.default !== undefined ? { default: f.default } : {}) };
    case "vec3":
      return { ...base, type: "array", items: { type: "number", minimum: f.min, maximum: f.max }, minItems: 3, maxItems: 3 };
    case "object": {
      const required = Object.entries(f.fields).filter(([, s]) => !s.optional && !hasDefault(s) && s.kind !== "object").map(([k]) => k);
      return {
        ...base, type: "object", additionalProperties: false,
        properties: Object.fromEntries(Object.entries(f.fields).map(([k, s]) => [k, toJsonSchema(s)])),
        ...(required.length ? { required } : {}),
      };
    }
    case "array":
      return { ...base, type: "array", items: toJsonSchema(f.items), minItems: f.minItems, maxItems: f.maxItems };
    case "oneOf":
      return { ...base, anyOf: f.options.map(toJsonSchema) };
  }
}
