import { LynxError } from "./errors.ts";

// Argument checks for route input. MCP inputs are validated by the host against the
// tool's JSON Schema first; the grid and the Block Kit page are not, so routes check
// again. Lossless forms pass ("12" for an integer); booleans must be real booleans.

type Obj = Record<string, unknown>;

function describe(v: unknown): string {
	if (typeof v === "string") return `the text "${v.length > 30 ? `${v.slice(0, 30)}…` : v}"`;
	if (typeof v === "number") return `the number ${v}`;
	if (typeof v === "boolean") return String(v);
	if (v === null) return "null";
	if (Array.isArray(v)) return "a list";
	return typeof v;
}

function bad(key: string, want: string, got: unknown): never {
	throw new LynxError("BAD_ARGUMENT", `Wrong type of argument: ${key} must be ${want}, not ${describe(got)}. Nothing was done - call again with the types the tool schema declares.`);
}

export function obj(input: unknown): Obj {
	if (input === undefined || input === null) return {};
	if (typeof input !== "object" || Array.isArray(input)) bad("arguments", "an object", input);
	return input as Obj;
}

export function str(o: Obj, key: string, opts: { required?: boolean; max?: number; pattern?: RegExp } = {}): string | undefined {
	const v = o[key];
	if (v === undefined || v === null || v === "") {
		if (opts.required) throw new LynxError("BAD_ARGUMENT", `${key} is required. Nothing was done.`);
		return undefined;
	}
	if (typeof v !== "string") bad(key, "text", v);
	if (opts.max !== undefined && v.length > opts.max) bad(key, `text of at most ${opts.max} characters`, v);
	if (opts.pattern && !opts.pattern.test(v)) bad(key, `text matching ${opts.pattern.source}`, v);
	return v;
}

export function int(o: Obj, key: string, opts: { min?: number; max?: number; def?: number } = {}): number | undefined {
	const v = o[key];
	if (v === undefined || v === null || v === "") return opts.def;
	const n = typeof v === "number" ? v : typeof v === "string" && /^-?\d+$/.test(v.trim()) ? Number(v) : NaN;
	if (!Number.isInteger(n)) bad(key, "a whole number", v);
	if (opts.min !== undefined && n < opts.min) bad(key, `a whole number of at least ${opts.min}`, v);
	if (opts.max !== undefined && n > opts.max) bad(key, `a whole number of at most ${opts.max}`, v);
	return n;
}

export function bool(o: Obj, key: string, def = false): boolean {
	const v = o[key];
	if (v === undefined || v === null) return def;
	if (typeof v !== "boolean") bad(key, "true or false", v);
	return v;
}

export function oneOf<T extends string>(o: Obj, key: string, values: readonly T[], def?: T): T | undefined {
	const v = o[key];
	if (v === undefined || v === null || v === "") return def;
	if (typeof v !== "string" || !values.includes(v as T)) bad(key, `one of ${values.join(", ")}`, v);
	return v as T;
}

export function strList(o: Obj, key: string, opts: { max?: number } = {}): string[] | undefined {
	const v = o[key];
	if (v === undefined || v === null) return undefined;
	if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) bad(key, "a list of texts", v);
	if (opts.max !== undefined && v.length > opts.max) bad(key, `a list of at most ${opts.max} items`, v);
	return v as string[];
}

export function record(o: Obj, key: string): Obj | undefined {
	const v = o[key];
	if (v === undefined || v === null) return undefined;
	if (typeof v !== "object" || Array.isArray(v)) bad(key, "an object", v);
	return v as Obj;
}
