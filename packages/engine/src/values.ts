import { fromPlainText, isPortableText, toPlainText } from "./portable-text.ts";
import type { FieldDef, FieldType } from "./types.ts";

/** Stable JSON: object keys sorted, so equal values serialise identically. */
export function stableStringify(value: unknown): string {
	if (value === undefined) return "undefined";
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	const keys = Object.keys(value as Record<string, unknown>)
		.filter((k) => (value as Record<string, unknown>)[k] !== undefined)
		.sort();
	return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(",")}}`;
}

export function valuesEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (isEmptyValue(a) && isEmptyValue(b)) return true;
	return stableStringify(a) === stableStringify(b);
}

/** null, undefined, "", [] and Portable Text without any text count as empty. */
export function isEmptyValue(value: unknown): boolean {
	if (value === null || value === undefined) return true;
	if (typeof value === "string") return value.length === 0;
	if (Array.isArray(value)) {
		if (value.length === 0) return true;
		if (isPortableText(value) && value.every((b) => b._type === "block")) return toPlainText(value).trim().length === 0;
	}
	return false;
}

const NUMERIC_TYPES: ReadonlySet<FieldType> = new Set(["number", "integer"]);
const TEXT_TYPES: ReadonlySet<FieldType> = new Set(["string", "text", "url", "slug"]);

export function isNumericType(type: FieldType): boolean {
	return NUMERIC_TYPES.has(type);
}

export function isTextType(type: FieldType): boolean {
	return TEXT_TYPES.has(type);
}

/** Normalise a value as the host stores it (booleans come back as 0/1). */
export function fromStored(field: Pick<FieldDef, "type">, value: unknown): unknown {
	if (field.type === "boolean" && (value === 0 || value === 1)) return value === 1;
	return value;
}

export type Coerced = { ok: true; value: unknown } | { ok: false; reason: string };

const ok = (value: unknown): Coerced => ({ ok: true, value });
const fail = (reason: string): Coerced => ({ ok: false, reason });

function describe(raw: unknown): string {
	if (typeof raw === "string") return `the text "${raw.length > 40 ? `${raw.slice(0, 40)}…` : raw}"`;
	if (typeof raw === "number") return `the number ${raw}`;
	if (typeof raw === "boolean") return String(raw);
	if (raw === null) return "null";
	if (Array.isArray(raw)) return "a list";
	return typeof raw;
}

/** Parse a number without guessing: "12.5" and 12.5 pass, "1,234" is ambiguous and refused. */
export function parseNumber(raw: unknown): number | null {
	if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
	if (typeof raw !== "string") return null;
	const s = raw.trim();
	if (/^[+-]?\d+,\d+$/.test(s) && !/^[+-]?\d{1,3},\d{3}$/.test(s)) return Number(s.replace(",", "."));
	if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s)) return null;
	const n = Number(s);
	return Number.isFinite(n) ? n : null;
}

const TRUE_WORDS = new Set(["true", "1", "yes", "on"]);
const FALSE_WORDS = new Set(["false", "0", "no", "off"]);

/** ISO datetime with offset as EmDash stores it. Date-only and offset-less input is read as UTC. */
export function parseDatetime(raw: unknown): string | null {
	if (typeof raw !== "string" && typeof raw !== "number") return null;
	let s = String(raw).trim();
	if (typeof raw === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s)) s = `${s}T00:00:00Z`;
	else if (typeof raw === "string" && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s)) s = `${s.replace(" ", "T")}Z`;
	else if (typeof raw === "string" && !/^\d{4}-\d{2}-\d{2}T/.test(s)) return null;
	const d = new Date(typeof raw === "number" ? raw : s);
	return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isValidUrl(s: string): boolean {
	if (s.startsWith("/") || s.startsWith("#")) return true;
	try {
		const u = new URL(s);
		return ["http:", "https:", "mailto:", "tel:"].includes(u.protocol);
	} catch {
		return false;
	}
}

/**
 * Convert a value supplied by a person or an agent into the stored shape of `field`.
 * Only lossless conversions are made; anything ambiguous is refused with a reason.
 */
export function coerceValue(field: FieldDef, raw: unknown): Coerced {
	if (raw === null || raw === undefined) return ok(null);
	const options = field.validation?.options;
	switch (field.type) {
		case "string":
		case "text":
			if (typeof raw === "string") return ok(raw);
			if (typeof raw === "number" || typeof raw === "boolean") return ok(String(raw));
			return fail(`${field.slug} takes text, not ${describe(raw)}`);
		case "url":
			if (typeof raw !== "string") return fail(`${field.slug} takes a URL as text, not ${describe(raw)}`);
			if (raw !== "" && !isValidUrl(raw.trim())) return fail(`${field.slug} takes an http(s) URL or a path starting with "/", not ${describe(raw)}`);
			return ok(raw.trim());
		case "slug":
			if (typeof raw !== "string") return fail(`${field.slug} takes a slug as text, not ${describe(raw)}`);
			if (raw !== "" && !SLUG_RE.test(raw)) return fail(`${field.slug} takes lowercase letters, digits and single hyphens (e.g. "bmw-320d-touring"), not ${describe(raw)}; use the slugify behavior to convert text`);
			return ok(raw);
		case "number": {
			const n = parseNumber(raw);
			return n === null ? fail(`${field.slug} takes a number, not ${describe(raw)}`) : ok(n);
		}
		case "integer": {
			const n = parseNumber(raw);
			if (n === null) return fail(`${field.slug} takes a whole number, not ${describe(raw)}`);
			if (!Number.isInteger(n)) return fail(`${field.slug} takes a whole number, not ${n}`);
			return ok(n);
		}
		case "boolean": {
			if (typeof raw === "boolean") return ok(raw);
			if (raw === 0 || raw === 1) return ok(raw === 1);
			const w = typeof raw === "string" ? raw.trim().toLowerCase() : "";
			if (TRUE_WORDS.has(w)) return ok(true);
			if (FALSE_WORDS.has(w)) return ok(false);
			return fail(`${field.slug} takes true or false, not ${describe(raw)}`);
		}
		case "datetime": {
			const d = parseDatetime(raw);
			return d === null ? fail(`${field.slug} takes a date as 2026-01-31 or 2026-01-31T14:30:00Z, not ${describe(raw)}`) : ok(d);
		}
		case "select": {
			if (typeof raw !== "string" && typeof raw !== "number") return fail(`${field.slug} takes one option as text, not ${describe(raw)}`);
			const s = String(raw);
			if (!options || options.length === 0) return ok(s);
			if (options.includes(s)) return ok(s);
			const ci = options.filter((o) => o.toLowerCase() === s.trim().toLowerCase());
			if (ci.length === 1) return ok(ci[0]);
			return fail(`${field.slug} takes one of: ${options.join(", ")}; not ${describe(raw)}`);
		}
		case "multiSelect": {
			const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",").map((s) => s.trim()).filter(Boolean) : null;
			if (!list) return fail(`${field.slug} takes a list of options, not ${describe(raw)}`);
			const out: string[] = [];
			for (const item of list) {
				const one = coerceValue({ ...field, type: "select" }, item);
				if (!one.ok) return fail(one.reason);
				if (!out.includes(one.value as string)) out.push(one.value as string);
			}
			return ok(out);
		}
		case "portableText":
			if (typeof raw === "string") return ok(fromPlainText(raw));
			if (isPortableText(raw)) return ok(raw);
			return fail(`${field.slug} takes Portable Text blocks or plain text, not ${describe(raw)}`);
		case "image":
		case "file":
			if (typeof raw === "string" && raw.trim()) return ok({ id: raw.trim() });
			if (typeof raw === "object" && !Array.isArray(raw) && typeof (raw as { id?: unknown }).id === "string") return ok(raw);
			return fail(`${field.slug} takes a media id or an object with id, not ${describe(raw)}`);
		case "reference":
			if (typeof raw === "string" && raw.trim()) return ok(raw.trim());
			return fail(`${field.slug} takes the id of the referenced entry, not ${describe(raw)}`);
		case "repeater":
			if (Array.isArray(raw) && raw.every((r) => typeof r === "object" && r !== null && !Array.isArray(r))) return ok(raw);
			return fail(`${field.slug} takes a list of rows (objects), not ${describe(raw)}`);
		case "blocks":
			if (Array.isArray(raw)) return ok(raw);
			return fail(`${field.slug} takes a list of blocks, not ${describe(raw)}`);
		case "json":
			try {
				JSON.stringify(raw);
				return ok(raw);
			} catch {
				return fail(`${field.slug} takes a JSON value`);
			}
	}
}

/** Short human-readable rendering for previews and tables. */
export function displayValue(field: Pick<FieldDef, "type">, value: unknown, maxLength = 120): string {
	if (value === null || value === undefined) return "";
	let s: string;
	switch (field.type) {
		case "portableText":
			s = toPlainText(value).replace(/\n{2,}/g, " ¶ ");
			break;
		case "image":
		case "file": {
			const v = value as { alt?: string; filename?: string; id?: string };
			s = v.filename ?? v.alt ?? v.id ?? "";
			break;
		}
		case "multiSelect":
			s = Array.isArray(value) ? value.join(", ") : String(value);
			break;
		case "boolean":
			s = value === true || value === 1 ? "yes" : "no";
			break;
		default:
			s = typeof value === "object" ? JSON.stringify(value) : String(value);
	}
	return s.length > maxLength ? `${s.slice(0, maxLength - 1)}…` : s;
}
