// The grid's cached reads in columns (2026-10-02: "the grid keeps the minimum"). One store
// per collection holds every entry a read has met: one array of ids and one array per indexed
// field, numbers (and dates, as epoch milliseconds) in a Float64Array, text as codes into a
// dictionary of its distinct values (colour, gearbox), or as plain strings when nearly every value
// differs (VIN, title: a dictionary would only add its lookup). A read of a filter keeps only the
// positions of its entries in the store, so filters and sorts share one copy of the values.
//
// Per entry that is the id (~48 bytes), its place in the id lookup (~30 bytes), 8 bytes per number
// column, 4 per repeating text column (each distinct text once) and the text itself for the
// others, and 4 bytes per read that holds it. Measured on 50,000 demo-like cars with 13 indexed
// fields: ~200 bytes per entry once, against ~625 per entry and per read for the object-per-entry
// cache it replaces (tools: playground/demo/tools/measure-scale.mjs on the real site).

/** Text values longer than this are cut (they only order rows). */
const TEXT_MAX = 300;
const NUMERIC = new Set(["number", "integer", "boolean", "datetime"]);

type Column = { kind: "num"; date: boolean; values: Float64Array } | { kind: "text"; codes: Int32Array; dict: Map<string, number>; words: string[] } | { kind: "str"; values: Array<string | undefined> };

/** A text column turns into plain strings once it has this many distinct values and they are over half its entries. */
const DICT_LIMIT = 2048;

export interface Store {
	/** The collection's newest update when the store began: a store never outlives it. */
	stamp: string;
	/** The indexed fields it holds columns for ("key:type,…"). */
	keys: string;
	ids: string[];
	pos: Map<string, number>;
	cols: Map<string, Column>;
	capacity: number;
}

export function newStore(stamp: string, fields: Array<{ key: string; type: string }>, capacity = 1024): Store {
	const cols = new Map<string, Column>();
	for (const f of fields) cols.set(f.key, NUMERIC.has(f.type) ? { kind: "num", date: f.type === "datetime", values: new Float64Array(capacity).fill(Number.NaN) } : { kind: "text", codes: new Int32Array(capacity).fill(-1), dict: new Map(), words: [] });
	return { stamp, keys: storeKeys(fields), ids: [], pos: new Map(), cols, capacity };
}

export const storeKeys = (fields: Array<{ key: string; type: string }>) => fields.map((f) => `${f.key}:${f.type}`).join(",");

function grow(store: Store): void {
	const cap = store.capacity * 2;
	for (const col of store.cols.values()) {
		if (col.kind === "num") {
			const next = new Float64Array(cap).fill(Number.NaN);
			next.set(col.values);
			col.values = next;
		} else if (col.kind === "text") {
			const next = new Int32Array(cap).fill(-1);
			next.set(col.codes);
			col.codes = next;
		}
	}
	store.capacity = cap;
}

function numberOf(v: unknown, date: boolean): number {
	if (typeof v === "number") return v;
	if (typeof v === "boolean") return v ? 1 : 0;
	if (typeof v === "string" && v.trim() !== "") return date ? Date.parse(v) : Number(v);
	return Number.NaN;
}

/** Puts an entry's indexed values in the store (new or updated) and answers its position. */
export function putEntry(store: Store, id: string, data: Record<string, unknown> | undefined): number {
	let at = store.pos.get(id);
	if (at === undefined) {
		at = store.ids.length;
		if (at >= store.capacity) grow(store);
		store.ids.push(id);
		store.pos.set(id, at);
	}
	for (const [key, col] of store.cols) {
		const v = data?.[key];
		if (col.kind === "num") {
			col.values[at] = numberOf(v, col.date);
			continue;
		}
		const s = typeof v === "string" ? (v.length > TEXT_MAX ? v.slice(0, TEXT_MAX) : v) : typeof v === "number" || typeof v === "boolean" ? String(v) : "";
		if (col.kind === "str") col.values[at] = s === "" ? undefined : s;
		else if (s === "") col.codes[at] = -1;
		else {
			let code = col.dict.get(s);
			if (code === undefined) {
				code = col.words.length;
				col.words.push(s);
				col.dict.set(s, code);
			}
			col.codes[at] = code;
			if (col.words.length > DICT_LIMIT && col.words.length * 2 > store.ids.length) store.cols.set(key, plain(col, store.ids.length));
		}
	}
	return at;
}

/** A dictionary column as plain strings by position. */
function plain(col: Extract<Column, { kind: "text" }>, n: number): Column {
	const values: Array<string | undefined> = new Array(n);
	for (let i = 0; i < n; i++) {
		const c = col.codes[i]!;
		values[i] = c >= 0 ? col.words[c] : undefined;
	}
	return { kind: "str", values };
}

/** A growing list of store positions (what a read of one filter keeps). */
export class Positions {
	at = new Int32Array(256);
	length = 0;
	push(p: number): void {
		if (this.length === this.at.length) {
			const next = new Int32Array(this.at.length * 2);
			next.set(this.at);
			this.at = next;
		}
		this.at[this.length++] = p;
	}
	slice(from: number, to: number): Int32Array {
		return this.at.subarray(Math.max(0, from), Math.min(this.length, to));
	}
}

const collator = new Intl.Collator(undefined, { numeric: true });

/**
 * The positions in the order of an indexed field: empty values last in both directions, ties in
 * the read's own order. Numbers numerically, text as people read it (2 before 10).
 */
export function sortPositions(store: Store, list: Positions, key: string, dir: "asc" | "desc"): Int32Array {
	const col = store.cols.get(key);
	const n = list.length;
	const at = list.at;
	const order = new Int32Array(n);
	for (let i = 0; i < n; i++) order[i] = i;
	if (!col) return list.slice(0, n).slice();
	const sign = dir === "asc" ? 1 : -1;
	let value: Float64Array;
	if (col.kind === "num") value = col.values;
	else if (col.kind === "str") {
		// Rank the read's own texts (equal texts share a rank); rows then compare as numbers.
		const withText: number[] = [];
		for (let i = 0; i < n; i++) if (col.values[at[i]!] !== undefined) withText.push(at[i]!);
		withText.sort((a, b) => collator.compare(col.values[a]!, col.values[b]!));
		value = new Float64Array(store.capacity).fill(Number.NaN);
		let r = 0;
		withText.forEach((p, i) => {
			if (i > 0 && collator.compare(col.values[withText[i - 1]!]!, col.values[p]!) !== 0) r = i;
			value[p] = r;
		});
	} else {
		// The rank of each distinct text, once per sort; rows then compare as numbers.
		const byText = col.words.map((_, i) => i).sort((a, b) => collator.compare(col.words[a]!, col.words[b]!));
		const rank = new Float64Array(col.words.length);
		byText.forEach((code, r) => (rank[code] = r));
		value = new Float64Array(store.capacity).fill(Number.NaN);
		for (let i = 0; i < n; i++) {
			const c = col.codes[at[i]!]!;
			if (c >= 0) value[at[i]!] = rank[c]!;
		}
	}
	order.sort((a, b) => {
		const x = value[at[a]!]!;
		const y = value[at[b]!]!;
		const ex = x !== x;
		const ey = y !== y;
		if (ex || ey) return ex === ey ? a - b : ex ? 1 : -1;
		return (x - y) * sign || a - b;
	});
	const out = new Int32Array(n);
	for (let i = 0; i < n; i++) out[i] = at[order[i]!]!;
	return out;
}

/** Roughly what a store and the reads on it hold, in bytes (for the cache route and the docs). */
export function storeBytes(store: Store): number {
	let b = store.ids.length * (8 + 48 + 32);
	for (const col of store.cols.values()) b += col.kind === "num" ? col.values.byteLength : col.kind === "str" ? col.values.reduce((s, w) => s + 8 + (w ? 24 + w.length : 0), 0) : col.codes.byteLength + col.words.reduce((s, w) => s + 24 + w.length + 32, 0);
	return b;
}
