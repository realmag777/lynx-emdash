import type { EntryFilter } from "@realmag777/lynx-engine";

import { columnKind } from "./columns.ts";
import type { FieldInfo } from "./api.ts";

// The filter builder of the grid: quick search, status, field conditions and taxonomy
// conditions, turned into the core's find filter (the same grammar agents use, so a filter
// built here is exactly what find_entries would run).

export type FilterOp = "eq" | "ne" | "in" | "not_in" | "gt" | "gte" | "lt" | "lte" | "contains" | "not_contains" | "starts_with" | "ends_with" | "empty" | "not_empty";

export interface FieldCondition {
	id: string;
	field: string;
	op: FilterOp;
	value: string;
}

export interface TermsCondition {
	id: string;
	taxonomy: string;
	mode: "any" | "all" | "none";
	ids: string[];
}

export interface FilterState {
	search: string;
	status: "any" | "published" | "draft";
	conditions: FieldCondition[];
	terms: TermsCondition[];
}

export const emptyFilter = (): FilterState => ({ search: "", status: "any", conditions: [], terms: [] });

export const OP_LABEL: Record<FilterOp, string> = {
	eq: "is",
	ne: "is not",
	in: "is any of",
	not_in: "is none of",
	gt: "greater than",
	gte: "at least",
	lt: "less than",
	lte: "at most",
	contains: "contains",
	not_contains: "does not contain",
	starts_with: "starts with",
	ends_with: "ends with",
	empty: "is empty",
	not_empty: "is not empty",
};

/** Conditions that make sense for a field type (the engine refuses the rest with a reason). */
export function opsFor(f: FieldInfo): FilterOp[] {
	switch (f.type) {
		case "number":
		case "integer":
		case "datetime":
			return ["eq", "ne", "gt", "gte", "lt", "lte", "empty", "not_empty"];
		case "boolean":
			return ["eq"];
		case "select":
			return ["eq", "ne", "in", "not_in", "empty", "not_empty"];
		case "multiSelect":
			return ["contains", "not_contains", "empty", "not_empty"];
		case "portableText":
			return ["contains", "not_contains", "empty", "not_empty"];
		case "image":
		case "file":
			return ["empty", "not_empty"];
		default:
			return ["contains", "not_contains", "eq", "ne", "starts_with", "ends_with", "empty", "not_empty"];
	}
}

export const needsValue = (op: FilterOp) => op !== "empty" && op !== "not_empty";

/** Filterable fields: system fields and indexed fields; taxonomies have their own rows (2026-10-02). */
export function filterFields(fields: FieldInfo[]): FieldInfo[] {
	return fields.filter((f) => f.filter !== "none" && f.filter !== "terms" && !f.key.startsWith("terms:") && f.key !== "status" && f.key !== "entry" && f.key !== "id" && (columnKind(f.key) !== "field" || f.filter === "host"));
}

/** Fields that could be filtered once indexed (the filter panel names them). */
export function unindexedFields(fields: FieldInfo[]): FieldInfo[] {
	return fields.filter((f) => columnKind(f.key) === "field" && f.filter === "scan");
}

function operand(f: FieldInfo | undefined, op: FilterOp, raw: string): unknown {
	if (op === "in" || op === "not_in") return raw.split(",").map((x) => x.trim()).filter(Boolean);
	if (f?.type === "boolean") return raw === "true";
	return raw.trim();
}

/** The core filter for a builder state. `searchKey` is the field the quick search looks in. */
export function toEntryFilter(state: FilterState, fields: FieldInfo[], searchKey: string | undefined): EntryFilter {
	const out: EntryFilter = {};
	if (state.status !== "any") out.status = state.status;
	const where: Record<string, Record<string, unknown>> = {};
	const put = (key: string, op: string, value: unknown) => {
		where[key] = { ...(where[key] ?? {}), [op]: value };
	};
	if (state.search.trim() && searchKey) put(searchKey, "contains", state.search.trim());
	const byKey = new Map(fields.map((f) => [f.key, f]));
	for (const c of state.conditions) {
		if (!c.field) continue;
		if (c.op === "empty" || c.op === "not_empty") {
			put(c.field, "empty", c.op === "empty");
			continue;
		}
		const f = byKey.get(c.field);
		if (!c.value.trim() && f?.type !== "boolean") continue;
		// A yes/no condition shows "Yes" until changed, so an empty value means true.
		put(c.field, c.op, operand(f, c.op, c.value || "true"));
	}
	if (Object.keys(where).length) out.where = where;
	const terms: NonNullable<EntryFilter["terms"]> = {};
	for (const t of state.terms) {
		if (!t.taxonomy || !t.ids.length) continue;
		terms[t.taxonomy] = { ...(terms[t.taxonomy] ?? {}), [t.mode]: t.ids };
	}
	if (Object.keys(terms).length) out.terms = terms;
	return out;
}

/** Number of active parts, shown on the Filter button. */
export function activeFilterCount(state: FilterState): number {
	return (state.status !== "any" ? 1 : 0) + state.conditions.filter((c) => c.field && (!needsValue(c.op) || c.value.trim())).length + state.terms.filter((t) => t.ids.length).length;
}
