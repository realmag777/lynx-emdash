import { EngineError } from "./errors.ts";
import { addParagraphs, replaceInPortableText, toPlainText } from "./portable-text.ts";
import { COMPUTED_BEHAVIORS, taxonomyOfKey, type Behavior, type Column } from "./schema.ts";
import { buildMatcher, changeCase, normalizeWhitespace, PatternError, replaceText, slugify, type CaseMode } from "./text.ts";
import type { TermDef } from "./types.ts";
import { coerceValue, isEmptyValue, parseDatetime, parseNumber, valuesEqual } from "./values.ts";

export type DateUnit = "minutes" | "hours" | "days" | "weeks" | "months" | "years";
export type RoundDirection = "nearest" | "up" | "down";

/** One step of a bulk edit, as sent by the grid or an agent. */
export interface Operation {
	field: string;
	behavior: Behavior;
	value?: unknown;
	find?: string;
	replace?: string;
	regex?: boolean;
	caseSensitive?: boolean;
	wholeWord?: boolean;
	separator?: string;
	case?: CaseMode;
	step?: number;
	direction?: RoundDirection;
	ending?: number;
	source?: string;
	percent?: number;
	unit?: DateUnit;
	from?: unknown;
	withParents?: boolean;
}

/** An operation after validation: operands are coerced and resolved. */
export interface NormalizedOperation extends Operation {
	column: Column;
	sourceColumn?: Column;
	/** Resolved term ids for term behaviours. */
	termIds?: string[];
}

export interface OperationContext {
	columns: Map<string, Column>;
	/** Terms per taxonomy name, needed for term behaviours. */
	terms?: Record<string, TermDef[]>;
	now?: Date;
}

const DATE_UNITS: DateUnit[] = ["minutes", "hours", "days", "weeks", "months", "years"];
const CASES: CaseMode[] = ["upper", "lower", "title", "sentence"];
const DIRECTIONS: RoundDirection[] = ["nearest", "up", "down"];

export interface OperationProblem {
	index: number;
	field?: string;
	code: "UNKNOWN_FIELD" | "FIELD_READ_ONLY" | "BAD_BEHAVIOR" | "BAD_OPERATION" | "BAD_VALUE" | "INVALID_PATTERN";
	message: string;
}

/** Resolve term slugs or ids to term ids. Unknown terms are refused, never created. */
export function resolveTerms(taxonomy: string, raw: unknown, terms: TermDef[] | undefined): { ids: string[]; unknown: string[] } {
	const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",").map((s) => s.trim()).filter(Boolean) : [];
	const ids: string[] = [];
	const unknown: string[] = [];
	for (const item of list) {
		const s = String(item);
		const t = terms?.find((x) => x.taxonomy === taxonomy && (x.id === s || x.slug === s || x.translationGroup === s));
		if (!t) unknown.push(s);
		else if (!ids.includes(t.id)) ids.push(t.id);
	}
	return { ids, unknown };
}

/**
 * Validate and normalise operations. Every problem in every operation is collected,
 * so one refusal tells the caller everything that is wrong (BEAR's filter/operation rule).
 */
export function normalizeOperations(raw: unknown, ctx: OperationContext): NormalizedOperation[] {
	const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? [raw] : [];
	if (list.length === 0) {
		throw new EngineError(
			"NO_OPERATIONS",
			'No operations to run. Bulk editing takes a list, one entry per change: {"operations":[{"field":"price","behavior":"increase_percent","value":10}]}. Field keys and the behaviors each accepts come from list_fields.',
		);
	}
	const problems: OperationProblem[] = [];
	const out: NormalizedOperation[] = [];

	list.forEach((item, index) => {
		const p = (code: OperationProblem["code"], message: string, field?: string) => problems.push({ index, code, message, ...(field ? { field } : {}) });
		if (!item || typeof item !== "object" || Array.isArray(item)) {
			p("BAD_OPERATION", 'Each operation is an object {"field", "behavior", "value"}.');
			return;
		}
		const op = item as Operation;
		if (typeof op.field !== "string" || !op.field) {
			p("BAD_OPERATION", 'Each operation needs field, behavior and value: {"field":"price","behavior":"set","value":25}. One of them came without a field.');
			return;
		}
		const column = ctx.columns.get(op.field);
		if (!column) {
			p("UNKNOWN_FIELD", `Unknown field key: ${op.field}. Call list_fields and use its keys verbatim.`, op.field);
			return;
		}
		if (!column.editable || !column.bulk) {
			p("FIELD_READ_ONLY", `The field ${op.field} cannot be written through LYNX${column.closed ? ` (${column.closed})` : ""}.`, op.field);
			return;
		}
		const behavior = (op.behavior ?? "set") as Behavior;
		if (!column.behaviors.includes(behavior)) {
			p("BAD_BEHAVIOR", `Behavior ${String(op.behavior)} is not allowed for ${op.field}. Allowed: ${column.behaviors.join(", ")}.`, op.field);
			return;
		}
		const norm: NormalizedOperation = { ...op, behavior, column };
		const field = column.field;
		const numberParam = (name: "value" | "step" | "ending" | "percent", v: unknown, { positive = false, required = true } = {}): number | undefined => {
			if (v === undefined || v === null || v === "") {
				if (required) p("BAD_VALUE", `${behavior} on ${op.field} needs ${name} as a number.`, op.field);
				return undefined;
			}
			const n = parseNumber(v);
			if (n === null) {
				p("BAD_VALUE", `${behavior} on ${op.field}: ${name} must be a number, not ${JSON.stringify(v)}.`, op.field);
				return undefined;
			}
			if (positive && n <= 0) p("BAD_VALUE", `${behavior} on ${op.field}: ${name} must be greater than 0.`, op.field);
			return n;
		};

		switch (behavior) {
			case "set": {
				if (column.kind === "system" && column.key === "slug") {
					if (typeof op.value !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(op.value)) p("BAD_VALUE", "slug takes lowercase letters, digits and single hyphens.", op.field);
					norm.value = op.value;
					break;
				}
				if (!field) break;
				const c = coerceValue(field, op.value);
				if (!c.ok) p("BAD_VALUE", c.reason, op.field);
				else if (c.value === null && field.required) p("BAD_VALUE", `${field.label} is required; use a value, not an empty one.`, op.field);
				else norm.value = c.value;
				break;
			}
			case "clear":
				if (column.required) p("BAD_VALUE", `${column.label} is required and cannot be cleared.`, op.field);
				break;
			case "append":
			case "prepend":
				if (typeof op.value !== "string" || op.value.length === 0) p("BAD_VALUE", `${behavior} on ${op.field} needs value as non-empty text.`, op.field);
				if (op.separator !== undefined && typeof op.separator !== "string") p("BAD_VALUE", "separator must be text.", op.field);
				break;
			case "replace":
				if (typeof op.find !== "string" || op.find.length === 0) p("BAD_VALUE", `replace on ${op.field} needs find as non-empty text.`, op.field);
				else if (op.replace !== undefined && typeof op.replace !== "string") p("BAD_VALUE", "replace must be text (an empty text deletes the match).", op.field);
				else {
					try {
						buildMatcher({ find: op.find, regex: op.regex === true, caseSensitive: op.caseSensitive === true, wholeWord: op.wholeWord === true });
					} catch (err) {
						p(err instanceof PatternError ? "INVALID_PATTERN" : "BAD_VALUE", (err as Error).message, op.field);
					}
				}
				norm.replace = op.replace ?? "";
				break;
			case "change_case":
				if (!CASES.includes(op.case as CaseMode)) p("BAD_VALUE", `change_case needs case: ${CASES.join(", ")}.`, op.field);
				break;
			case "trim":
				break;
			case "slugify":
				if (op.source !== undefined) {
					const src = ctx.columns.get(op.source);
					if (!src) p("UNKNOWN_FIELD", `Unknown source field: ${op.source}.`, op.field);
					else norm.sourceColumn = src;
				}
				break;
			case "increase_by":
			case "decrease_by":
				norm.value = numberParam("value", op.value, { positive: true });
				break;
			case "increase_percent":
				norm.value = numberParam("value", op.value, { positive: true });
				break;
			case "decrease_percent": {
				const n = numberParam("value", op.value, { positive: true });
				if (n !== undefined && n > 100) p("BAD_VALUE", `decrease_percent above 100 would make values negative (got ${n}).`, op.field);
				norm.value = n;
				break;
			}
			case "multiply":
				norm.value = numberParam("value", op.value);
				break;
			case "round": {
				const step = op.step === undefined ? 1 : numberParam("step", op.step, { positive: true });
				norm.step = step;
				if (op.direction !== undefined && !DIRECTIONS.includes(op.direction)) p("BAD_VALUE", `round direction is ${DIRECTIONS.join(", ")}.`, op.field);
				if (op.ending !== undefined) {
					const e = numberParam("ending", op.ending);
					if (e !== undefined && step !== undefined && (e < 0 || e >= step)) p("BAD_VALUE", `round ending must be at least 0 and below step ${step} (e.g. step 1, ending 0.99).`, op.field);
					norm.ending = e;
				}
				break;
			}
			case "copy_from": {
				const src = op.source ? ctx.columns.get(op.source) : undefined;
				if (!op.source) p("BAD_VALUE", `copy_from on ${op.field} needs source, the key of the field to copy.`, op.field);
				else if (!src) p("UNKNOWN_FIELD", `Unknown source field: ${op.source}. Call list_fields for the keys.`, op.field);
				else if (src.kind === "terms") p("BAD_VALUE", "copy_from cannot read taxonomy terms.", op.field);
				else norm.sourceColumn = src;
				if (op.percent !== undefined) {
					if (!column.numeric) p("BAD_VALUE", "percent on copy_from applies to number fields only.", op.field);
					norm.percent = numberParam("percent", op.percent);
				}
				break;
			}
			case "toggle":
				break;
			case "add_values":
			case "remove_values":
			case "replace_value": {
				if (!field) break;
				const selectField = { ...field, type: "select" as const };
				if (behavior === "replace_value") {
					const from = coerceValue(selectField, op.from);
					const to = coerceValue(selectField, op.value);
					if (op.from === undefined || !from.ok) p("BAD_VALUE", from.ok ? "replace_value needs from, the option to replace." : from.reason, op.field);
					else norm.from = from.value;
					if (op.value === undefined || !to.ok) p("BAD_VALUE", to.ok ? "replace_value needs value, the new option." : to.reason, op.field);
					else norm.value = to.value;
				} else {
					const c = coerceValue({ ...field, type: "multiSelect" }, op.value);
					if (!c.ok || !Array.isArray(c.value) || c.value.length === 0) p("BAD_VALUE", c.ok ? `${behavior} needs value, a non-empty list of options.` : c.reason, op.field);
					else norm.value = c.value;
				}
				break;
			}
			case "shift_date": {
				const n = numberParam("value", op.value);
				if (n !== undefined && !Number.isInteger(n)) p("BAD_VALUE", "shift_date value must be a whole number of units.", op.field);
				if (!DATE_UNITS.includes(op.unit as DateUnit)) p("BAD_VALUE", `shift_date needs unit: ${DATE_UNITS.join(", ")}.`, op.field);
				norm.value = n;
				break;
			}
			case "add_terms":
			case "remove_terms":
			case "set_terms": {
				const tax = taxonomyOfKey(column.key)!;
				if (behavior !== "set_terms" && (op.value === undefined || (Array.isArray(op.value) && op.value.length === 0))) {
					p("BAD_VALUE", `${behavior} needs value, a list of term slugs or ids.`, op.field);
					break;
				}
				const { ids, unknown } = resolveTerms(tax, op.value ?? [], ctx.terms?.[tax]);
				if (unknown.length) p("BAD_VALUE", `Unknown terms in ${tax}: ${unknown.join(", ")}. Terms are never created by a bulk edit; list them with list_terms or create them first.`, op.field);
				if (column.taxonomy?.single && behavior === "set_terms" && ids.length > 1) p("BAD_VALUE", `${column.label} takes one term per entry; got ${ids.length}.`, op.field);
				norm.termIds = ids;
				norm.withParents = op.withParents !== false;
				break;
			}
			case "schedule": {
				const d = parseDatetime(op.value);
				const now = ctx.now ?? new Date();
				if (!d) p("BAD_VALUE", "schedule needs value, the publication date (e.g. 2026-10-01T09:00:00Z).", op.field);
				else if (new Date(d).getTime() <= now.getTime()) p("BAD_VALUE", `schedule needs a future date; ${d} has passed. Use publish to publish now.`, op.field);
				else norm.value = d;
				break;
			}
			case "publish":
			case "unpublish":
			case "unschedule":
			case "duplicate":
			case "trash":
				break;
		}
		out.push(norm);
	});

	// Whole-entry operations: trash stands alone; duplicate comes first and the rest shape the copy.
	const entryOps = out.map((o, i) => ({ o, i })).filter((x) => x.o.column.key === "entry");
	for (const { o, i } of entryOps) {
		if (o.behavior === "trash" && list.length > 1) problems.push({ index: i, code: "BAD_OPERATION", field: "entry", message: "trash must be the only operation of a job: moving entries to the trash does not combine with other changes." });
		if (o.behavior === "duplicate" && i !== 0) problems.push({ index: i, code: "BAD_OPERATION", field: "entry", message: "duplicate must be the first operation; the operations after it change the copies." });
		if (o.behavior === "duplicate" && entryOps.length > 1) problems.push({ index: i, code: "BAD_OPERATION", field: "entry", message: "Only one whole-entry operation per job." });
	}
	if (out[0]?.behavior === "duplicate") {
		out.forEach((o, i) => {
			if (o.column.key === "status" || o.column.key === "slug") problems.push({ index: i, code: "BAD_OPERATION", field: o.column.key, message: `Copies are created as drafts with a slug made by EmDash; ${o.column.key} cannot be changed in the same job. Publish or rename the copies in a second job.` });
		});
	}

	if (problems.length) {
		const first = problems[0]!;
		throw new EngineError(
			problems.every((x) => x.code === first.code) ? first.code : "BAD_OPERATION",
			`The operations were not run, nothing was changed. ${problems.map((x) => `#${x.index + 1}${x.field ? ` (${x.field})` : ""}: ${x.message}`).join(" ")}`,
			{ problems },
		);
	}
	return out;
}

// ---------------------------------------------------------------------------
// Applying one operation to one value

export type SkipReason = "empty_value" | "source_empty" | "no_match";

export type OpNote = "integer_rounded" | "marks_crossed";

export type OpOutcome = { kind: "value"; value: unknown; notes?: OpNote[]; matches?: number } | { kind: "skip"; reason: SkipReason };

/** Clean binary float noise (0.1 + 0.2) without changing meaningful precision. */
export function cleanNumber(n: number): number {
	return Number(n.toPrecision(12));
}

export function roundTo(value: number, step: number, direction: RoundDirection = "nearest", ending?: number): number {
	const fn = direction === "up" ? Math.ceil : direction === "down" ? Math.floor : Math.round;
	if (ending === undefined) return cleanNumber(fn(cleanNumber(value / step)) * step);
	// Price ending: the result is k*step + ending (e.g. step 1, ending 0.99 → 18.99).
	const shifted = cleanNumber((value - ending) / step);
	return cleanNumber(fn(shifted) * step + ending);
}

export function shiftDate(iso: string, amount: number, unit: DateUnit): string {
	const d = new Date(iso);
	switch (unit) {
		case "minutes":
			d.setUTCMinutes(d.getUTCMinutes() + amount);
			break;
		case "hours":
			d.setUTCHours(d.getUTCHours() + amount);
			break;
		case "days":
			d.setUTCDate(d.getUTCDate() + amount);
			break;
		case "weeks":
			d.setUTCDate(d.getUTCDate() + amount * 7);
			break;
		case "months":
		case "years": {
			const months = unit === "years" ? amount * 12 : amount;
			const day = d.getUTCDate();
			d.setUTCDate(1);
			d.setUTCMonth(d.getUTCMonth() + months);
			const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
			d.setUTCDate(Math.min(day, lastDay));
			break;
		}
	}
	return d.toISOString();
}

function asText(value: unknown): string {
	if (value === null || value === undefined) return "";
	if (Array.isArray(value)) return toPlainText(value);
	return typeof value === "object" ? JSON.stringify(value) : String(value);
}

/** Terms of a hierarchical taxonomy plus all their ancestors. */
export function withAncestors(ids: string[], terms: TermDef[]): string[] {
	const out = [...ids];
	for (const id of ids) {
		let t = terms.find((x) => x.id === id);
		let guard = 0;
		while (t?.parentId && guard++ < 20) {
			const parentRef: string = t.parentId;
			const parent = terms.find((x) => x.translationGroup === parentRef || x.id === parentRef);
			if (!parent) break;
			if (!out.includes(parent.id)) out.push(parent.id);
			t = parent;
		}
	}
	return out;
}

/**
 * Apply one normalised operation to the current value of a data field (or slug).
 * `sourceValue` is the current value of `op.source` for copy_from/slugify.
 */
export function applyToValue(op: NormalizedOperation, current: unknown, sourceValue?: unknown): OpOutcome {
	const col = op.column;
	const type = col.type;
	const done = (value: unknown, notes?: OpNote[], matches?: number): OpOutcome => ({ kind: "value", value, ...(notes?.length ? { notes } : {}), ...(matches !== undefined ? { matches } : {}) });
	const intFix = (n: number): OpOutcome => {
		if (type === "integer" && !Number.isInteger(n)) return done(Math.round(n), ["integer_rounded"]);
		return done(cleanNumber(n));
	};

	if (COMPUTED_BEHAVIORS.has(op.behavior) && (isEmptyValue(current) || typeof current !== "number")) {
		return { kind: "skip", reason: "empty_value" };
	}

	switch (op.behavior) {
		case "set":
			return done(op.value ?? null);
		case "clear":
			return done(type === "multiSelect" || type === "repeater" || type === "blocks" ? [] : null);
		case "append":
		case "prepend": {
			const add = String(op.value);
			if (type === "portableText") return done(addParagraphs(current, add, op.behavior));
			const cur = asText(current);
			if (!cur) return done(add);
			const sep = op.separator ?? "";
			return done(op.behavior === "append" ? `${cur}${sep}${add}` : `${add}${sep}${cur}`);
		}
		case "replace": {
			const opts = { find: op.find!, replace: op.replace ?? "", regex: op.regex === true, caseSensitive: op.caseSensitive === true, wholeWord: op.wholeWord === true };
			if (type === "portableText") {
				const res = replaceInPortableText(current, opts);
				if (res.count === 0) return { kind: "skip", reason: "no_match" };
				return done(res.value, res.crossedMarks ? ["marks_crossed"] : undefined, res.count);
			}
			if (isEmptyValue(current)) return { kind: "skip", reason: "no_match" };
			const res = replaceText(asText(current), opts);
			if (res.count === 0) return { kind: "skip", reason: "no_match" };
			return done(res.text, undefined, res.count);
		}
		case "change_case":
			if (isEmptyValue(current)) return { kind: "skip", reason: "empty_value" };
			return done(changeCase(asText(current), op.case!));
		case "trim":
			if (isEmptyValue(current)) return { kind: "skip", reason: "empty_value" };
			return done(normalizeWhitespace(asText(current)));
		case "slugify": {
			const base = op.sourceColumn ? sourceValue : current;
			const s = slugify(asText(base));
			if (!s) return { kind: "skip", reason: op.sourceColumn ? "source_empty" : "empty_value" };
			return done(s);
		}
		case "increase_by":
			return intFix((current as number) + (op.value as number));
		case "decrease_by":
			return intFix((current as number) - (op.value as number));
		case "increase_percent":
			return intFix((current as number) * (1 + (op.value as number) / 100));
		case "decrease_percent":
			return intFix((current as number) * (1 - (op.value as number) / 100));
		case "multiply":
			return intFix((current as number) * (op.value as number));
		case "round": {
			const r = roundTo(current as number, op.step ?? 1, op.direction ?? "nearest", op.ending);
			return type === "integer" ? intFix(r) : done(r);
		}
		case "copy_from": {
			if (isEmptyValue(sourceValue)) return { kind: "skip", reason: "source_empty" };
			const field = col.field;
			let v: unknown = sourceValue;
			if (col.numeric && op.percent !== undefined) {
				const n = parseNumber(sourceValue);
				if (n === null) return { kind: "skip", reason: "source_empty" };
				v = n * (1 + op.percent / 100);
				return intFix(v as number);
			}
			if (field) {
				const src = op.sourceColumn?.field;
				// Portable Text → text field copies plain text.
				if (src?.type === "portableText" && field.type !== "portableText") v = toPlainText(sourceValue);
				const c = coerceValue(field, v);
				return c.ok ? done(c.value) : done(v);
			}
			return done(v);
		}
		case "toggle":
			return done(!(current === true || current === 1));
		case "add_values": {
			const cur = Array.isArray(current) ? current.map(String) : [];
			const next = [...cur];
			for (const v of op.value as string[]) if (!next.includes(v)) next.push(v);
			return done(next);
		}
		case "remove_values": {
			const cur = Array.isArray(current) ? current.map(String) : [];
			return done(cur.filter((v) => !(op.value as string[]).includes(v)));
		}
		case "replace_value": {
			if (type === "multiSelect") {
				const cur = Array.isArray(current) ? current.map(String) : [];
				if (!cur.includes(String(op.from))) return { kind: "skip", reason: "no_match" };
				const next: string[] = [];
				for (const v of cur) {
					const r = v === op.from ? String(op.value) : v;
					if (!next.includes(r)) next.push(r);
				}
				return done(next);
			}
			if (!valuesEqual(current, op.from)) return { kind: "skip", reason: "no_match" };
			return done(op.value);
		}
		case "shift_date": {
			if (isEmptyValue(current)) return { kind: "skip", reason: "empty_value" };
			const iso = parseDatetime(current);
			if (!iso) return { kind: "skip", reason: "empty_value" };
			return done(shiftDate(iso, op.value as number, op.unit!));
		}
		default:
			// Term and status behaviours are handled by the planner.
			return done(current);
	}
}
