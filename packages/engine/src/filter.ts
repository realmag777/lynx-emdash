import { EngineError } from "./errors.ts";
import { resolveTerms } from "./operations.ts";
import { toPlainText } from "./portable-text.ts";
import { TERMS_PREFIX, type Column } from "./schema.ts";
import type { Entry, TermDef } from "./types.ts";
import { coerceValue, fromStored, isEmptyValue, parseDatetime, parseNumber, valuesEqual } from "./values.ts";

// Filter grammar for find_entries. Every unknown key or wrong shape is refused
// with the reason, and nothing runs half-applied (BEAR, docs/bear-mcp-study.md §3.2):
// a dropped condition would silently widen the selection to the whole collection.
//
// {
//   "status": "published" | ["published","draft"],
//   "locale": "en",
//   "ids": ["01H…", …],
//   "where": { "<field>": <value> | { eq, ne, in, not_in, gt, gte, lt, lte, contains, not_contains, starts_with, ends_with, empty } },
//   "terms": { "<taxonomy>": { any | all | none: [slug|id…], exists: bool } }
// }

export const MAX_HOST_FILTERS = 20;
export const MAX_HOST_IN = 50;

export type ConditionOp = "eq" | "ne" | "in" | "not_in" | "gt" | "gte" | "lt" | "lte" | "contains" | "not_contains" | "starts_with" | "ends_with" | "empty";

export interface Condition {
	field: string;
	op: ConditionOp;
	value: unknown;
}

export interface TermCondition {
	taxonomy: string;
	any?: string[];
	all?: string[];
	none?: string[];
	exists?: boolean;
}

export interface EntryFilter {
	status?: string | string[];
	locale?: string;
	ids?: string[];
	where?: Record<string, unknown>;
	terms?: Record<string, { any?: unknown; all?: unknown; none?: unknown; exists?: unknown }>;
}

export type HostFieldFilter = unknown | { in: unknown[] } | { gt?: unknown; gte?: unknown; lt?: unknown; lte?: unknown };

export interface CompiledFilter {
	/** Pushed down to the host list query (indexed fields, status, locale). */
	host: { status?: string; locale?: string; fieldFilters: Record<string, HostFieldFilter> };
	/** Evaluated by LYNX on loaded entries. */
	scan: Condition[];
	terms: TermCondition[];
	ids?: string[];
	/** True when entries must be loaded and tested one by one (scan or terms conditions). */
	needsScan: boolean;
	needsTerms: boolean;
	/** True when the filter narrows nothing. */
	empty: boolean;
	/** Human-readable summary, e.g. for the selection snapshot. */
	summary: string;
}

const OP_TEXT: Partial<Record<ConditionOp, string>> = { eq: "=", ne: "≠", gt: ">", gte: "≥", lt: "<", lte: "≤", in: "in", not_in: "not in", contains: "contains", not_contains: "does not contain", starts_with: "starts with", ends_with: "ends with" };
const show = (v: unknown): string => (Array.isArray(v) ? v.map(show).join(", ") : typeof v === "string" ? JSON.stringify(v) : String(v));

/** Readable condition for summaries and history ("price ≥ 10000 and < 20000"). */
function describeCondition(key: string, raw: unknown): string {
	// key is the column label here
	if (!isPlainObject(raw)) return `${key} = ${show(raw)}`;
	const parts = Object.entries(raw).map(([op, v]) => (op === "empty" ? (v === false ? "is not empty" : "is empty") : `${OP_TEXT[op as ConditionOp] ?? op} ${show(v)}`));
	return `${key} ${parts.join(" and ")}`;
}

/** Readable taxonomy condition ("Fuel: Hybrid or Diesel", "Make: not BMW"). */
function describeTerms(label: string, raw: Record<string, unknown>, termLabel: (x: string) => string): string {
	const names = (v: unknown) => (Array.isArray(v) ? v : [v]).map((x) => termLabel(String(x)));
	const parts = Object.entries(raw).map(([k, v]) => (k === "exists" ? (v ? "any term" : "no term") : k === "any" ? names(v).join(" or ") : k === "all" ? names(v).join(" and ") : `not ${names(v).join(" or ")}`));
	return `${label}: ${parts.join(" and ")}`;
}

const OPS: ConditionOp[] = ["eq", "ne", "in", "not_in", "gt", "gte", "lt", "lte", "contains", "not_contains", "starts_with", "ends_with", "empty"];
const TEXT_OPS: ConditionOp[] = ["contains", "not_contains", "starts_with", "ends_with"];
const RANGE_OPS: ConditionOp[] = ["gt", "gte", "lt", "lte"];
const TOP_KEYS = ["status", "locale", "ids", "where", "terms"];

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function comparable(col: Column): "number" | "date" | "text" | null {
	if (col.numeric) return "number";
	if (col.type === "datetime") return "date";
	if (col.type === "string" || col.type === "text" || col.type === "slug" || col.type === "url" || col.type === "select") return "text";
	return null;
}

export function compileFilter(raw: unknown, columns: Map<string, Column>, terms?: Record<string, TermDef[]>): CompiledFilter {
	const problems: string[] = [];
	const filter: EntryFilter = raw === undefined || raw === null ? {} : (raw as EntryFilter);
	if (!isPlainObject(filter)) throw new EngineError("BAD_FILTER", 'The filter must be an object, e.g. {"where":{"price":{"lt":20000}}}. Nothing was selected.');
	for (const k of Object.keys(filter)) {
		if (!TOP_KEYS.includes(k)) {
			const hint = columns.has(k) ? ` Put field conditions under where: {"where":{"${k}": …}}.` : "";
			problems.push(`${k}: not a filter key (use status, locale, ids, where, terms).${hint}`);
		}
	}

	const host: CompiledFilter["host"] = { fieldFilters: {} };
	const scan: Condition[] = [];
	const termConds: TermCondition[] = [];
	const summary: string[] = [];

	// status / locale
	if (filter.status !== undefined) {
		const list = Array.isArray(filter.status) ? filter.status : [filter.status];
		if (!list.length || !list.every((s) => typeof s === "string" && s)) problems.push('status: a status name or a list, e.g. "published" or ["draft","published"].');
		else if (list.length === 1) host.status = list[0] as string;
		else scan.push({ field: "status", op: "in", value: list });
		summary.push(list.join(" or "));
	}
	if (filter.locale !== undefined) {
		if (typeof filter.locale !== "string" || !filter.locale) problems.push('locale: a locale code such as "en".');
		else {
			host.locale = filter.locale;
			summary.push(`locale ${filter.locale}`);
		}
	}
	let ids: string[] | undefined;
	if (filter.ids !== undefined) {
		if (!Array.isArray(filter.ids) || !filter.ids.every((x) => typeof x === "string" && x)) problems.push("ids: a list of entry ids.");
		else {
			ids = [...new Set(filter.ids as string[])];
			summary.push("selected entries");
		}
	}

	// where
	if (filter.where !== undefined && !isPlainObject(filter.where)) problems.push('where: an object of field conditions, e.g. {"price":{"gte":10000}}.');
	let hostCount = 0;
	let operandBudget = 50;
	for (const [key, rawCond] of Object.entries(isPlainObject(filter.where) ? filter.where : {})) {
		const col = columns.get(key);
		if (!col) {
			problems.push(`${key}: unknown field. Field keys come from list_fields.`);
			continue;
		}
		if (col.kind === "terms" || key.startsWith(TERMS_PREFIX)) {
			problems.push(`${key}: taxonomies go under terms: {"terms":{"${col.taxonomy?.name ?? key.slice(TERMS_PREFIX.length)}":{"any":["slug"]}}}.`);
			continue;
		}
		if (col.filter === "none") {
			problems.push(`${key}: this field cannot be filtered.`);
			continue;
		}
		const conds: Condition[] = [];
		if (!isPlainObject(rawCond)) conds.push({ field: key, op: "eq", value: rawCond });
		else {
			for (const [op, v] of Object.entries(rawCond)) {
				if (!OPS.includes(op as ConditionOp)) {
					problems.push(`${key}: unknown condition "${op}" (use ${OPS.join(", ")}).`);
					continue;
				}
				conds.push({ field: key, op: op as ConditionOp, value: v });
			}
			if (Object.keys(rawCond).length === 0) problems.push(`${key}: empty condition object.`);
		}
		const hostPart: Record<string, unknown> = {};
		for (const c of conds) {
			const kind = comparable(col);
			// Validate and coerce operands.
			if (c.op === "empty") {
				if (typeof c.value !== "boolean") problems.push(`${key}: empty takes true or false.`);
				scan.push(c);
				continue;
			}
			if (TEXT_OPS.includes(c.op)) {
				if (typeof c.value !== "string" || !c.value) problems.push(`${key}: ${c.op} takes non-empty text.`);
				else if (!(kind === "text" || col.type === "portableText" || col.type === "multiSelect")) problems.push(`${key}: ${c.op} works on text fields only.`);
				scan.push(c);
				continue;
			}
			if (RANGE_OPS.includes(c.op)) {
				if (kind !== "number" && kind !== "date") {
					problems.push(`${key}: ${c.op} works on number and date fields only.`);
					continue;
				}
				const v = kind === "number" ? parseNumber(c.value) : parseDatetime(c.value);
				if (v === null) {
					problems.push(`${key}: ${c.op} takes a ${kind === "number" ? "number" : "date such as 2026-01-31"}, not ${JSON.stringify(c.value)}.`);
					continue;
				}
				c.value = v;
				if (col.filter === "host" && !("eq" in hostPart) && !("in" in hostPart)) hostPart[c.op] = v;
				else scan.push(c);
				continue;
			}
			// eq / ne / in / not_in
			const list = c.op === "in" || c.op === "not_in";
			if (list && (!Array.isArray(c.value) || c.value.length === 0)) {
				problems.push(`${key}: ${c.op} takes a non-empty list.`);
				continue;
			}
			const values = list ? (c.value as unknown[]) : [c.value];
			const coerced: unknown[] = [];
			for (const v of values) {
				if (col.kind === "system") {
					coerced.push(v);
					continue;
				}
				const r = col.field ? coerceValue(col.field.type === "multiSelect" ? { ...col.field, type: "select" } : col.field, v) : { ok: true as const, value: v };
				if (!r.ok) problems.push(`${key}: ${r.reason}.`);
				else coerced.push(r.value);
			}
			c.value = list ? coerced : coerced[0];
			const pushable = col.filter === "host" && (c.op === "eq" || (c.op === "in" && coerced.length <= MAX_HOST_IN && coerced.length <= operandBudget));
			if (pushable && Object.keys(hostPart).length === 0) {
				if (c.op === "eq") hostPart.eq = c.value;
				else hostPart.in = c.value;
			} else scan.push(c);
		}
		if (Object.keys(hostPart).length) {
			// eq/in never share hostPart with a range (see above), so no operand is ever dropped here.
			const operands = "in" in hostPart ? (hostPart.in as unknown[]).length : Object.keys(hostPart).length;
			if (hostCount < MAX_HOST_FILTERS && operands <= operandBudget) {
				host.fieldFilters[key] = "eq" in hostPart ? hostPart.eq : "in" in hostPart ? { in: hostPart.in } : hostPart;
				hostCount++;
				operandBudget -= operands;
			} else {
				for (const [op, v] of Object.entries(hostPart)) scan.push({ field: key, op: op as ConditionOp, value: v });
			}
		}
		summary.push(describeCondition(col.label, rawCond));
	}

	// terms
	if (filter.terms !== undefined && !isPlainObject(filter.terms)) problems.push('terms: an object keyed by taxonomy, e.g. {"make":{"any":["bmw"]}}.');
	for (const [tax, rawCond] of Object.entries(isPlainObject(filter.terms) ? filter.terms : {})) {
		const col = columns.get(`${TERMS_PREFIX}${tax}`);
		if (!col) {
			problems.push(`terms.${tax}: this collection has no taxonomy "${tax}".`);
			continue;
		}
		if (!isPlainObject(rawCond)) {
			problems.push(`terms.${tax}: an object {any|all|none: [slugs], exists: true|false}.`);
			continue;
		}
		const tc: TermCondition = { taxonomy: tax };
		for (const [k, v] of Object.entries(rawCond)) {
			if (k === "exists") {
				if (typeof v !== "boolean") problems.push(`terms.${tax}.exists takes true or false.`);
				else tc.exists = v;
				continue;
			}
			if (k !== "any" && k !== "all" && k !== "none") {
				problems.push(`terms.${tax}: unknown key "${k}" (use any, all, none, exists).`);
				continue;
			}
			const r = resolveTerms(tax, v, terms?.[tax]);
			if (!Array.isArray(v) || v.length === 0) problems.push(`terms.${tax}.${k} takes a non-empty list of term slugs or ids.`);
			else if (r.unknown.length) problems.push(`terms.${tax}.${k}: unknown terms ${r.unknown.join(", ")} (list them with list_terms).`);
			else tc[k] = r.ids;
		}
		termConds.push(tc);
		const defs = terms?.[tax] ?? [];
		summary.push(describeTerms(col.label, rawCond, (x) => defs.find((t) => t.id === x || t.slug === x)?.label ?? x));
	}

	if (problems.length) {
		throw new EngineError("BAD_FILTER", `The filter was not run, nothing was selected. ${problems.join(" ")}`, { problems });
	}
	const empty = !host.status && !host.locale && Object.keys(host.fieldFilters).length === 0 && scan.length === 0 && termConds.length === 0 && !ids;
	return {
		host,
		scan,
		terms: termConds,
		...(ids ? { ids } : {}),
		needsScan: scan.length > 0 || termConds.length > 0,
		needsTerms: termConds.length > 0,
		empty,
		summary: summary.join(", ") || "everything",
	};
}

function valueOf(entry: Entry, col: Column | undefined, key: string): unknown {
	switch (key) {
		case "status":
			return entry.status;
		case "locale":
			return entry.locale;
		case "slug":
			return entry.slug;
		case "id":
			return entry.id;
		case "created_at":
			return entry.createdAt;
		case "updated_at":
			return entry.updatedAt;
		case "published_at":
			return entry.publishedAt;
		case "scheduled_at":
			return entry.scheduledAt;
	}
	const v = entry.data[key];
	return col?.field ? fromStored(col.field, v) : v;
}

function asText(v: unknown): string {
	if (Array.isArray(v)) return v.every((x) => typeof x === "string") ? v.join(" ") : toPlainText(v);
	return v === null || v === undefined ? "" : String(v);
}

function compare(a: unknown, b: unknown): number {
	if (typeof a === "number" && typeof b === "number") return a - b;
	const da = typeof a === "string" ? parseDatetime(a) : null;
	const db = typeof b === "string" ? parseDatetime(b) : null;
	if (da && db) return Date.parse(da) - Date.parse(db);
	return String(a).localeCompare(String(b));
}

export function matchesCondition(entry: Entry, c: Condition, columns: Map<string, Column>): boolean {
	const col = columns.get(c.field);
	const v = valueOf(entry, col, c.field);
	const multi = Array.isArray(v) && col?.type === "multiSelect";
	switch (c.op) {
		case "empty":
			return isEmptyValue(v) === c.value;
		case "eq":
			return multi ? (v as unknown[]).includes(c.value) : valuesEqual(v, c.value);
		case "ne":
			return multi ? !(v as unknown[]).includes(c.value) : !valuesEqual(v, c.value);
		case "in":
			return (c.value as unknown[]).some((x) => (multi ? (v as unknown[]).includes(x) : valuesEqual(v, x)));
		case "not_in":
			return !(c.value as unknown[]).some((x) => (multi ? (v as unknown[]).includes(x) : valuesEqual(v, x)));
		case "gt":
			return !isEmptyValue(v) && compare(v, c.value) > 0;
		case "gte":
			return !isEmptyValue(v) && compare(v, c.value) >= 0;
		case "lt":
			return !isEmptyValue(v) && compare(v, c.value) < 0;
		case "lte":
			return !isEmptyValue(v) && compare(v, c.value) <= 0;
		case "contains":
			return asText(v).toLowerCase().includes(String(c.value).toLowerCase());
		case "not_contains":
			return !asText(v).toLowerCase().includes(String(c.value).toLowerCase());
		case "starts_with":
			return asText(v).toLowerCase().startsWith(String(c.value).toLowerCase());
		case "ends_with":
			return asText(v).toLowerCase().endsWith(String(c.value).toLowerCase());
	}
}

export function matchesTerms(entry: Entry, t: TermCondition): boolean {
	const have = entry.terms?.[t.taxonomy] ?? [];
	if (t.exists !== undefined && (have.length > 0) !== t.exists) return false;
	if (t.any && !t.any.some((id) => have.includes(id))) return false;
	if (t.all && !t.all.every((id) => have.includes(id))) return false;
	if (t.none && t.none.some((id) => have.includes(id))) return false;
	return true;
}

/** Test an entry loaded by the host query against the conditions the host could not apply. */
export function matchesFilter(entry: Entry, compiled: CompiledFilter, columns: Map<string, Column>): boolean {
	return compiled.scan.every((c) => matchesCondition(entry, c, columns)) && compiled.terms.every((t) => matchesTerms(entry, t));
}
