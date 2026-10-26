import { coerceValue, validateValue, valuesEqual, type Operation } from "@realmag777/lynx-engine";

import type { GridRow } from "./api.ts";
import type { GridColumn } from "./columns.ts";

// Cell values, dirty edits and the operations a save sends to the core (edits route). The grid
// keeps rows immutable; a draft value per (row, column) lives in the dirty map until it is saved
// (Botoscope wrote straight into its rows and saved blind; here a save is explicit and checked).

/**
 * The row with one cell replaced: how the page shows a value it has just saved, in place, without
 * reloading (so the rows keep their order and the table its scroll; 2026-10-01).
 */
export function withCellValue(row: GridRow, key: string, value: unknown): GridRow {
	if (key === "slug") return { ...row, slug: String(value ?? "") };
	if (key === "status") return { ...row, status: String(value ?? row.status) };
	if (key.startsWith("terms:")) return { ...row, terms: { ...(row.terms ?? {}), [key.slice(6)]: Array.isArray(value) ? (value as string[]) : [] } };
	if (["id", "locale", "updated_at", "published_at"].includes(key)) return row;
	return { ...row, data: { ...row.data, [key]: value } };
}

export function cellValue(row: GridRow, key: string): unknown {
	switch (key) {
		case "id":
			return row.id;
		case "slug":
			return row.slug;
		case "status":
			return row.status;
		case "locale":
			return row.locale;
		case "updated_at":
			return row.updated_at;
		case "published_at":
			return row.published_at;
	}
	if (key.startsWith("terms:")) return row.terms?.[key.slice(6)];
	return row.data[key];
}

/** rowId → column key → new value. */
export type Dirty = Map<string, Map<string, unknown>>;

export function setDirty(dirty: Dirty, row: GridRow, col: GridColumn, value: unknown): Dirty {
	const next = new Map(dirty);
	const cells = new Map(next.get(row.id) ?? []);
	const original = cellValue(row, col.key);
	const same = col.type === "boolean" ? Boolean(original) === Boolean(value) : valuesEqual(original, value);
	if (same) cells.delete(col.key);
	else cells.set(col.key, value);
	if (cells.size) next.set(row.id, cells);
	else next.delete(row.id);
	return next;
}

export function dirtyCount(dirty: Dirty): { cells: number; rows: number } {
	let cells = 0;
	for (const m of dirty.values()) cells += m.size;
	return { cells, rows: dirty.size };
}

/** Check a typed value like the engine will; returns the stored shape or a readable problem. */
export function checkValue(col: GridColumn, raw: unknown): { ok: true; value: unknown } | { ok: false; problem: string } {
	if (col.editor === "terms" || col.editor === "status" || !col.field) return { ok: true, value: raw };
	if ((raw === "" || raw === null || raw === undefined) && col.required) return { ok: false, problem: `${col.label} is required` };
	if (raw === "" || raw === null || raw === undefined) return { ok: true, value: null };
	const c = coerceValue(col.field, raw);
	if (!c.ok) return { ok: false, problem: c.reason };
	const problems = validateValue(col.field, c.value);
	return problems.length ? { ok: false, problem: problems[0]!.message } : { ok: true, value: c.value };
}

/** The core's per-entry operations for the dirty cells (the edits route of the core). */
export function toOperations(dirty: Dirty, cols: Map<string, GridColumn>): Record<string, Operation[]> {
	const out: Record<string, Operation[]> = {};
	for (const [id, cells] of dirty) {
		const ops: Operation[] = [];
		for (const [key, value] of cells) {
			const col = cols.get(key);
			if (!col) continue;
			if (col.editor === "terms") ops.push({ field: key, behavior: "set_terms", value: (value as string[] | null) ?? [] });
			else if (col.editor === "status") ops.push({ field: "status", behavior: value === "published" ? "publish" : "unpublish" });
			else if (value === null || value === "") ops.push({ field: key, behavior: "clear" });
			else ops.push({ field: key, behavior: "set", value });
		}
		if (ops.length) out[id] = ops;
	}
	return out;
}

/** Split a save into batches the core accepts in one job (it caps a single save at 100 entries). */
export function batches<T>(entries: Array<[string, T]>, size = 100): Array<Record<string, T>> {
	const out: Array<Record<string, T>> = [];
	for (let i = 0; i < entries.length; i += size) out.push(Object.fromEntries(entries.slice(i, i + size)));
	return out;
}
