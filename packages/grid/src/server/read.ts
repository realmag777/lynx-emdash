import { columnMap, compileFilter, matchesFilter, valuesEqual, type CollectionDef, type Entry, type FieldDef, type TermDef } from "@realmag777/lynx-engine";
import type { PluginContext } from "emdash";

import { SCAN_SORT_TYPES } from "../model/columns.ts";
import { filterKey, lastCount, rememberCount } from "./counts.ts";
import { newStore, Positions, putEntry, sortPositions, storeBytes, storeKeys, type Store } from "./store.ts";

// Server-side reads of the grid (native plugin, runs in the site's process: no sandbox call
// budget). 2026-09-30: reads move out of the core; every WRITE still goes through the
// core so history and rollback stay in one place. The filter grammar and matching are the
// engine's, so a filter shows exactly the rows a core selection of the same filter holds.

type Ctx = PluginContext;

export class GridReadError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = "GridReadError";
		this.code = code;
	}
}

interface HostItem {
	id: string;
	slug: string | null;
	status: string;
	locale: string | null;
	data: Record<string, unknown>;
	createdAt?: string;
	updatedAt: string;
	publishedAt?: string | null;
	scheduledAt?: string | null;
	translationGroup?: string | null;
	draftRevisionId?: string | null;
	liveRevisionId?: string | null;
}

interface HostTerm {
	id: string;
	taxonomy: string;
	slug: string;
	label: string;
	parentId: string | null;
	translationGroup: string | null;
}

export interface GridRowOut {
	id: string;
	slug: string | null;
	status: string;
	locale: string | null;
	updated_at: string | null;
	published_at: string | null;
	draft: boolean;
	data: Record<string, unknown>;
	terms?: Record<string, string[]>;
	/** For cells the draft changes: the value the site shows now. */
	live?: Record<string, unknown>;
}

const HOST_PAGE = 100;
export const MAX_LIMIT = 200;

const SYSTEM_SORT: Record<string, string> = { created_at: "createdAt", updated_at: "updatedAt", published_at: "publishedAt", title: "title", slug: "slug", status: "status" };

function need<T>(v: T | undefined, what: string): T {
	if (!v) throw new GridReadError("FORBIDDEN", `LYNX Grid was installed without ${what} access.`);
	return v;
}

export async function loadCollection(ctx: Ctx, slug: string): Promise<CollectionDef> {
	const schema = need(ctx.schema, "schema");
	const [col, defs] = await Promise.all([schema.getCollection(slug), need(ctx.taxonomies, "taxonomy").getAll()]);
	if (!col) throw new GridReadError("UNKNOWN_COLLECTION", `There is no collection "${slug}" on this site.`);
	return {
		slug: col.slug,
		label: col.label,
		supports: col.supports,
		titleField: col.titleField ?? (col.fields.some((f) => f.slug === "title") ? "title" : null),
		dateField: col.dateField,
		fields: col.fields.map((f): FieldDef => ({ slug: f.slug, label: f.label, type: f.type as FieldDef["type"], required: f.required, unique: f.unique, indexed: f.indexed, searchable: f.searchable, translatable: f.translatable, validation: (f.validation as FieldDef["validation"]) ?? null })),
		taxonomies: defs.filter((d) => d.collections.includes(slug)).map((d) => ({ name: d.name, label: d.label, hierarchical: d.hierarchical, collections: d.collections })),
	};
}

export async function listTerms(ctx: Ctx, taxonomy: string): Promise<Array<{ id: string; slug: string; label: string; parent: string | null; group: string | null }>> {
	const rows = (await need(ctx.taxonomies, "taxonomy").getTerms(taxonomy)) as HostTerm[];
	return rows.map((t) => ({ id: t.id, slug: t.slug, label: t.label, parent: t.parentId, group: t.translationGroup }));
}

async function termsOf(ctx: Ctx, collection: string, id: string, only: string[]): Promise<Record<string, string[]>> {
	const rows = (await need(ctx.taxonomies, "taxonomy").getEntryTerms(collection, id)) as HostTerm[];
	const out: Record<string, string[]> = {};
	for (const name of only) out[name] = [];
	for (const t of rows) if (only.includes(t.taxonomy)) out[t.taxonomy]!.push(t.id);
	return out;
}

function toEntry(item: HostItem, terms?: Record<string, string[]>): Entry {
	return {
		id: item.id,
		slug: item.slug,
		status: item.status,
		locale: item.locale,
		translationGroup: item.translationGroup ?? null,
		data: item.data ?? {},
		...(terms ? { terms } : {}),
		draftRevisionId: item.draftRevisionId ?? null,
		...(item.createdAt ? { createdAt: item.createdAt } : {}),
		updatedAt: item.updatedAt,
		publishedAt: item.publishedAt ?? null,
		scheduledAt: item.scheduledAt ?? null,
	};
}

/** The draft revision's field values (the admin editor shows these), or null. */
async function draftData(ctx: Ctx, schema: CollectionDef, item: HostItem): Promise<Record<string, unknown> | null> {
	if (!item.draftRevisionId || item.draftRevisionId === item.liveRevisionId || !ctx.content?.getRevision) return null;
	const rev = await ctx.content.getRevision(schema.slug, item.id, item.draftRevisionId);
	if (!rev) return null;
	const out: Record<string, unknown> = {};
	for (const f of schema.fields) if (f.slug in rev.data) out[f.slug] = rev.data[f.slug];
	// A slug edited in a draft waits there as _slug until the draft is published.
	if (typeof rev.data._slug === "string") out._slug = rev.data._slug;
	return out;
}

export interface RowsInput {
	collection: string;
	filter?: unknown;
	sort?: { key: string; dir: "asc" | "desc" } | null;
	offset: number;
	limit: number;
	terms: string[];
	/** Drop any cached scan of this filter (the grid sends it after its own writes). */
	fresh?: boolean;
}

export interface RowsAnswer {
	/** Entries matching the filter, or null while the count is still running. */
	total: number | null;
	/** Matches found so far (equals total when counting is done). */
	counted: number;
	/** While counting: the count found last time, if any. */
	estimate?: number;
	offset: number;
	rows: GridRowOut[];
}

// Scale (2026-09-30: 5,000 entries). The host lists 100 entries per call, so counting
// a filter means scanning the collection. A scan runs in the background and keeps the ordered
// matching entries (their positions in the collection's column store, store.ts); a request waits
// only until its page is there (or ~350 ms), and later pages and the count come from the same
// scan; meanwhile the count found last time is shown (counts.ts). A scan is reused while the collection's newest update
// is unchanged and it is younger than a minute; the grid asks for a fresh one after its own
// writes.
const PAGE_WAIT_MS = 350;
const SCAN_TTL_MS = 60_000;
/** A sort EmDash cannot do (a field without an index) waits for the whole scan, at most this long. */
const SORT_WAIT_MS = 120_000;

type SortAfter = { key: string; dir: "asc" | "desc" };
const MAX_SCANS = 6;

/** A read of one filter: the positions of its entries in the collection's store (see store.ts). */
interface Scan {
	stamp: string;
	startedAt: number;
	store: Store;
	list: Positions;
	done: boolean;
	error?: unknown;
	listeners: Set<() => void>;
	/** Orders of the finished scan by a data field, made in memory on demand ("key:dir" -> positions). */
	sorted?: Map<string, Int32Array>;
	/** Replaced by a newer scan nobody waits for: stop reading. */
	cancelled?: boolean;
	/** For a taxonomy filter: who carries the terms, when the scan started (see termSignature). */
	termSig?: string;
	/** The count found last time (KV), shown as "≈" until this scan has counted. */
	estimate?: number | null;
}
const scans = new Map<string, Scan>();
/** Collection -> the store its current scans write into. */
const stores = new Map<string, Store>();

/** The store for a collection at a stamp: the current one, or a new one when either changed. */
function storeFor(slug: string, stamp: string, fields: Array<{ key: string; type: string }>): Store {
	const cur = stores.get(slug);
	if (cur && cur.stamp === stamp && cur.keys === storeKeys(fields)) return cur;
	const next = newStore(stamp, fields);
	stores.set(slug, next);
	return next;
}

const idsOf = (store: Store, at: Int32Array): string[] => Array.from(at, (p) => store.ids[p]!);

/**
 * Forget every cached read of a collection. The content hooks of the plugin call it after any
 * save, publish, unpublish, schedule, trash or restore in this process (2026-10-02: an
 * AI agent's change must show at once); reads also drop a scan whose collection changed since.
 */
export function invalidateCollection(slug: string): void {
	stores.delete(slug);
	for (const [k, sc] of scans) {
		if (!k.startsWith(`["${slug}",`)) continue;
		if (!sc.done && sc.listeners.size === 0) sc.cancelled = true;
		scans.delete(k);
	}
}

/**
 * Who carries the terms of a taxonomy filter, as a short signature. Assigning terms in the admin
 * neither calls a content hook nor touches updatedAt, so a cached scan of a term filter is checked
 * against this (EmDash answers these JOINs from its own cache while nothing changed). Without
 * EmDash's collection query (tests, tools) it changes every 5 seconds.
 */
async function termSignature(compiled: ReturnType<typeof compileFilter>, defs: Record<string, TermDef[]>, collection: string): Promise<string> {
	if (!compiled.terms.length) return "";
	const m = await termMembership(compiled.terms, defs, collection);
	if (!m) return `t${Math.floor(Date.now() / 5000)}`;
	const parts: string[] = [];
	for (const [tax, byTerm] of m)
		for (const [term, ids] of byTerm) {
			let h = 0;
			for (const id of ids) for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
			parts.push(`${tax}/${term}:${ids.size}:${h}`);
		}
	return parts.sort().join(",");
}

/** Changes whenever an entry of the collection is created or updated (cheap: one list call). */
async function collectionStamp(ctx: Ctx, collection: string): Promise<string> {
	const res = (await need(ctx.content, "content").list(collection, { limit: 1, orderBy: { updatedAt: "desc" } })) as unknown as { items: HostItem[] };
	const top = res.items[0];
	return top ? `${top.id}@${top.updatedAt}` : "empty";
}

/** Term ids of many entries: one getEntryTerms call each, run in parallel (in-process: ~1 ms each). */
async function termsOfMany(ctx: Ctx, collection: string, ids: string[], only: string[]): Promise<Map<string, Record<string, string[]>>> {
	const out = new Map<string, Record<string, string[]>>();
	if (!only.length) return out;
	for (let i = 0; i < ids.length; i += 200) {
		const part = ids.slice(i, i + 200);
		const got = await Promise.all(part.map((id) => termsOf(ctx, collection, id, only)));
		part.forEach((id, k) => out.set(id, got[k]!));
	}
	return out;
}

type CollectionQuery = (collection: string, options: unknown) => Promise<{ entries: Array<{ id: string; data: Record<string, unknown> }> }>;
let collectionQuery: CollectionQuery | null | undefined;
/** Statuses EmDash's collection query can filter by; entries in other states are tested one by one. */
const QUERY_STATUSES = ["published", "draft", "archived"] as const;

/**
 * For a taxonomy filter: which entries carry each named term, from EmDash's collection query
 * (one JOIN per term and status) instead of reading the terms of every entry. Returns null when
 * the site runtime does not offer it (tests, tools); the scan then reads terms per entry.
 */
async function termMembership(compiledTerms: ReturnType<typeof compileFilter>["terms"], defs: Record<string, TermDef[]>, collection: string): Promise<Map<string, Map<string, Set<string>>> | null> {
	if (collectionQuery === undefined) {
		try {
			collectionQuery = ((await import("emdash")) as unknown as { getEmDashCollection?: CollectionQuery }).getEmDashCollection ?? null;
		} catch {
			collectionQuery = null;
		}
	}
	if (!collectionQuery) return null;
	const query = collectionQuery;
	const out = new Map<string, Map<string, Set<string>>>(); // taxonomy → term id (or "*" = any term) → entry ids
	try {
		for (const c of compiledTerms) {
			const byTerm = new Map<string, Set<string>>();
			const wanted = [...new Set([...(c.any ?? []), ...(c.all ?? []), ...(c.none ?? [])])];
			const jobs: Array<[string, string[]]> = wanted.map((id) => [id, [defs[c.taxonomy]?.find((t) => t.id === id)?.slug ?? id]]);
			if (c.exists !== undefined) jobs.push(["*", (defs[c.taxonomy] ?? []).map((t) => t.slug)]);
			for (const [key, slugs] of jobs) {
				const set = new Set<string>();
				if (slugs.length) {
					const results = await Promise.all(QUERY_STATUSES.map((status) => query(collection, { status, where: { [c.taxonomy]: slugs.length === 1 ? slugs[0] : slugs }, limit: 1_000_000 })));
					for (const r of results) for (const e of r.entries) set.add(String((e.data as { id?: unknown }).id ?? e.id));
				}
				byTerm.set(key, set);
			}
			out.set(c.taxonomy, byTerm);
		}
	} catch {
		collectionQuery = null;
		return null;
	}
	return out;
}

/** The part of a filter EmDash applies itself while listing. */
function hostWhere(compiled: ReturnType<typeof compileFilter>) {
	const h = compiled.host;
	return { ...(h.status ? { status: h.status } : {}), ...(h.locale ? { locale: h.locale } : {}), ...(Object.keys(h.fieldFilters).length ? { fieldFilters: h.fieldFilters as never } : {}) };
}

/**
 * The first entries in the order of an indexed field, from the database (a few queries at most),
 * empty values left out as they come last. Null when that is not enough for the page.
 */
async function firstPageByIndex(ctx: Ctx, collection: string, compiled: ReturnType<typeof compileFilter>, by: SortAfter, want: number): Promise<HostItem[] | null> {
	const out: HostItem[] = [];
	let cursor: string | undefined;
	for (let n = 0; n < 5; n++) {
		const res = (await need(ctx.content, "content").list(collection, { limit: HOST_PAGE, orderBy: { [by.key]: by.dir }, where: hostWhere(compiled), ...(cursor ? { cursor } : {}) })) as unknown as { items: HostItem[]; cursor?: string; hasMore: boolean };
		for (const it of res.items) {
			const v = it.data?.[by.key];
			if (v !== null && v !== undefined && v !== "") out.push(it);
		}
		if (out.length >= want) return out;
		if (!res.hasMore || !res.cursor) return null;
		cursor = res.cursor;
	}
	return null;
}

/**
 * Conditions only on indexed fields (2026-10-02): the grid keeps no other values, and a
 * condition on any other field would read every entry. The quick search (the title) is let through.
 */
function assertIndexedFilter(filter: unknown, cols: ReturnType<typeof columnMap>, titleField?: string | null): void {
	const where = filter && typeof filter === "object" ? (filter as { where?: unknown }).where : undefined;
	if (!where || typeof where !== "object") return;
	const bad = Object.keys(where)
		.filter((k) => k !== titleField)
		.map((k) => cols.get(k))
		.filter((c): c is NonNullable<typeof c> => Boolean(c && c.kind === "field" && c.filter !== "host"));
	if (bad.length) throw new GridReadError("NEEDS_INDEX", `${bad.map((c) => c.label).join(", ")} ${bad.length === 1 ? "has" : "have"} no index: index the field to filter by it (the gear on its column, or Settings).`);
}

/** What the grid holds in memory now (checks measure with it; bytes are an estimate). */
export function cacheStats() {
	const mem = typeof process !== "undefined" && typeof process.memoryUsage === "function" ? process.memoryUsage() : null;
	return {
		stores: [...stores.entries()].map(([collection, st]) => ({ collection, entries: st.ids.length, columns: st.cols.size, bytes: storeBytes(st) })),
		scans: [...scans.entries()].map(([key, sc]) => ({ key, entries: sc.list.length, done: sc.done, seconds: Math.round((Date.now() - sc.startedAt) / 100) / 10 })),
		...(mem ? { memory: { heapUsedMB: Math.round(mem.heapUsed / 1048576), rssMB: Math.round(mem.rss / 1048576) } } : {}),
	};
}

/** The indexed fields a store holds columns for (what sorting runs on). */
function indexedFields(schema: CollectionDef): Array<{ key: string; type: string }> {
	return [...columnMap(schema).values()].filter((c) => c.kind === "field" && c.sortable && c.field).map((c) => ({ key: c.key, type: c.field!.type }));
}

function startScan(ctx: Ctx, schema: CollectionDef, compiled: ReturnType<typeof compileFilter>, termDefs: Record<string, TermDef[]>, orderBy: Record<string, "asc" | "desc"> | undefined, stamp: string, countKey?: string): Scan {
	const cols = columnMap(schema);
	const store = storeFor(schema.slug, stamp, indexedFields(schema));
	const scan: Scan = { stamp, startedAt: Date.now(), store, list: new Positions(), done: false, listeners: new Set() };
	const byTerms = compiled.terms.map((t) => t.taxonomy);
	const where = hostWhere(compiled);
	const notify = () => {
		for (const fn of [...scan.listeners]) fn();
	};
	void (async () => {
		try {
			// A taxonomy filter asks EmDash which entries carry the named terms (fast JOINs) while the
			// first chunk of 100 entries is tested term by term, so the first page does not wait.
			const membership = byTerms.length ? termMembership(compiled.terms, termDefs, schema.slug) : Promise.resolve(null);
			let cursor: string | undefined;
			let buffer: HostItem[] = [];
			let chunk = byTerms.length ? 100 : 0;
			let first = true;
			const flush = async () => {
				let terms: Map<string, Record<string, string[]>> | null = null;
				if (byTerms.length) {
					const sets = first ? null : await membership;
					first = false;
					if (sets) {
						terms = new Map();
						const slow: string[] = [];
						for (const item of buffer) {
							if (!(QUERY_STATUSES as readonly string[]).includes(item.status)) {
								slow.push(item.id);
								continue;
							}
							const rec: Record<string, string[]> = {};
							for (const [tax, byTerm] of sets) rec[tax] = [...byTerm].filter(([, ids]) => ids.has(item.id)).map(([term]) => (term === "*" ? "__any__" : term));
							terms.set(item.id, rec);
						}
						for (const [id, rec] of await termsOfMany(ctx, schema.slug, slow, byTerms)) terms.set(id, rec);
					} else terms = await termsOfMany(ctx, schema.slug, buffer.map((i) => i.id), byTerms);
				}
				for (const item of buffer) {
					if (compiled.needsScan || compiled.needsTerms) {
						const entry = toEntry(item, terms?.get(item.id));
						if (!matchesFilter(entry, compiled, cols)) continue;
					}
					scan.list.push(putEntry(store, item.id, item.data));
				}
				buffer = [];
				notify();
			};
			for (;;) {
				const res = (await need(ctx.content, "content").list(schema.slug, { limit: HOST_PAGE, ...(cursor ? { cursor } : {}), ...(orderBy ? { orderBy } : {}), where })) as unknown as { items: HostItem[]; cursor?: string; hasMore: boolean };
				buffer.push(...res.items);
				const last = !res.hasMore || !res.cursor;
				if (buffer.length >= chunk || last) {
					await flush();
					if (chunk) chunk = 500;
				}
				if (last || scan.cancelled) break;
				cursor = res.cursor;
			}
		} catch (err) {
			scan.error = err;
		}
		scan.done = true;
		notify();
		if (countKey !== undefined && !scan.error && !scan.cancelled) await rememberCount(ctx.kv, schema.slug, countKey, scan.list.length);
	})();
	return scan;
}

function waitFor(scan: Scan, count: number, ms: number): Promise<void> {
	return new Promise((resolve) => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finish = () => {
			if (timer) clearTimeout(timer);
			scan.listeners.delete(check);
			resolve();
		};
		const check = () => {
			if (scan.done || scan.error || scan.list.length >= count) finish();
		};
		timer = setTimeout(finish, ms);
		scan.listeners.add(check);
		check();
	});
}

/**
 * One page of rows for a filter and sort. Tests entries with the engine (the same filter a
 * core selection would freeze) and loads terms and draft values only for the rows of the page.
 */
export async function readRows(ctx: Ctx, input: RowsInput): Promise<RowsAnswer> {
	const content = need(ctx.content, "content");
	const schema = await loadCollection(ctx, input.collection);
	const cols = columnMap(schema);
	const filterTerms = collectTermNames(input.filter);
	const termDefs: Record<string, TermDef[]> = {};
	for (const name of filterTerms) termDefs[name] = (await listTerms(ctx, name)).map((t) => ({ id: t.id, taxonomy: name, slug: t.slug, label: t.label, parentId: t.parent, translationGroup: t.group }));
	let compiled;
	try {
		compiled = compileFilter(input.filter ?? {}, cols, termDefs);
	} catch (err) {
		throw new GridReadError("BAD_FILTER", (err as Error).message);
	}
	assertIndexedFilter(input.filter, cols, schema.titleField);
	const attached = new Set((schema.taxonomies ?? []).map((t) => t.name));
	const wantTerms = input.terms.filter((t) => attached.has(t));

	let page: HostItem[];
	let total: number | null;
	let counted: number;
	let estimate: number | null = null;
	if (compiled.ids) {
		const found: HostItem[] = [];
		for (const id of compiled.ids) {
			const item = (await content.get(schema.slug, id)) as unknown as HostItem | null;
			if (item) found.push(item);
		}
		page = found.slice(input.offset, input.offset + input.limit);
		total = counted = found.length;
	} else {
		const key = input.sort?.key && /^[a-z][a-z0-9_]*$/i.test(input.sort.key) ? input.sort.key : undefined;
		const dir = input.sort?.dir === "asc" ? ("asc" as const) : ("desc" as const);
		const col = key ? cols.get(key) : undefined;
		// System fields (dates, title, slug, status) sort in the database while the ids are read. An
		// indexed field is sorted here over the kept values of the plain read of the filter (EmDash
		// paging through an order of its own field runs one heavy query per 100 entries and holds the
		// site up), and gives the first page at once from one query while that read is not there yet.
		// A field without an index does not sort at all (2026-10-02).
		const memorySort = key && !SYSTEM_SORT[key] && col?.kind === "field" && col.field && SCAN_SORT_TYPES.has(col.field.type) ? { key, dir } : undefined;
		const orderBy = key && !memorySort && SYSTEM_SORT[key] ? { [SYSTEM_SORT[key]]: dir } : undefined;
		if (memorySort && !col?.sortable) throw new GridReadError("NEEDS_INDEX", `${col?.label ?? memorySort.key} has no index: index the field to sort by it (the gear on its column, or Settings).`);
		const [stamp, termSig] = await Promise.all([collectionStamp(ctx, schema.slug), termSignature(compiled, termDefs, schema.slug)]);
		/** The scan for a key: the cached one while it is valid, else a new one. */
		const ensure = (k: string, ob: typeof orderBy): Scan => {
			let sc = scans.get(k);
			if (!sc || input.fresh || sc.error || sc.stamp !== stamp || sc.termSig !== termSig || Date.now() - sc.startedAt > SCAN_TTL_MS) {
				// Unfinished scans of this collection nobody waits for (an older sort, a fresh request)
				// stop, so quick clicks on headers do not pile up full reads.
				for (const [ok, old] of scans) if (ok !== k && ok.startsWith(`["${schema.slug}",`) && !old.done && old.listeners.size === 0) (old.cancelled = true), scans.delete(ok);
				sc = startScan(ctx, schema, compiled, termDefs, ob, stamp, countKey);
				sc.termSig = termSig;
				scans.delete(k);
				scans.set(k, sc);
				while (scans.size > MAX_SCANS) {
					const first = scans.keys().next().value!;
					const old = scans.get(first)!;
					if (!old.done && old.listeners.size === 0) old.cancelled = true;
					scans.delete(first);
				}
			}
			return sc;
		};
		const countKey = filterKey(input.filter ?? {});
		const current = ensure(JSON.stringify([schema.slug, input.filter ?? {}, orderBy ?? null]), orderBy);
		let ids: Int32Array | null = null;
		total = null;
		counted = 0;
		if (memorySort) {
			const quick = !current.done && col?.sortable && !compiled.needsScan && !compiled.needsTerms && input.offset + input.limit <= HOST_PAGE ? await firstPageByIndex(ctx, schema.slug, compiled, memorySort, input.offset + input.limit) : null;
			if (quick) {
				page = quick.slice(input.offset, input.offset + input.limit);
				total = null;
				counted = Math.max(current.list.length, quick.length);
			} else {
				await waitFor(current, Number.POSITIVE_INFINITY, SORT_WAIT_MS);
				if (current.error) throw current.error;
				if (!current.done) throw new GridReadError("SORT_TIMEOUT", "Sorting by this field needs every entry read first, and that took too long. Narrow the filter, or index the field (the gear on its column).");
				const memo = `${memorySort.key}:${memorySort.dir}`;
				const sorted = (current.sorted ??= new Map()).get(memo) ?? sortPositions(current.store, current.list, memorySort.key, memorySort.dir);
				current.sorted.set(memo, sorted);
				ids = sorted;
			}
		} else {
			await waitFor(current, input.offset + input.limit, PAGE_WAIT_MS);
			if (current.error) throw current.error;
			ids = current.list.slice(0, current.list.length);
		}
		if (ids) {
			page = idsOf(current.store, ids.subarray(input.offset, input.offset + input.limit)).map((id) => ({ id }) as HostItem);
			total = current.done ? current.list.length : null;
			counted = current.list.length;
		}
		// Until the count is done, the count found last time ("≈" in the grid).
		if (total === null) {
			if (current.estimate === undefined) current.estimate = await lastCount(ctx.kv, schema.slug, countKey);
			estimate = current.estimate;
		}
		// The scan keeps order and membership; the shown entries are read again. A draft save does not
		// touch an entry's updatedAt (the scan's stamp), so a kept scan would point at an old draft
		// revision and show values from before the save (2026-10-01: "price and year not saved").
		// An entry gone since (trashed elsewhere) leaves the page and the cached reads.
		const fresh = await Promise.all(page!.map(async (it) => (await content.get(schema.slug, it.id)) as unknown as HostItem | null));
		if (fresh.some((x) => !x)) invalidateCollection(schema.slug);
		page = fresh.filter((x): x is HostItem => Boolean(x));
	}

	const pageTerms = wantTerms.length ? await termsOfMany(ctx, schema.slug, page.map((i) => i.id), wantTerms) : null;
	const rows = await Promise.all(
		page.map(async (item): Promise<GridRowOut> => {
			const draft = await draftData(ctx, schema, item);
			const terms = pageTerms?.get(item.id);
			// Values the draft changes, with what the site shows now (the grid marks those cells).
			const { _slug, ...fields } = draft ?? {};
			const live: Record<string, unknown> = {};
			// Only a published entry has a site version to compare with.
			if (item.status === "published") {
				for (const [k, v] of Object.entries(fields)) if (JSON.stringify(v ?? null) !== JSON.stringify(item.data?.[k] ?? null)) live[k] = item.data?.[k] ?? null;
				if (typeof _slug === "string" && _slug !== item.slug) live.slug = item.slug;
			}
			return {
				id: item.id,
				slug: typeof _slug === "string" ? _slug : item.slug,
				status: item.status,
				locale: item.locale,
				updated_at: item.updatedAt ?? null,
				published_at: item.publishedAt ?? null,
				draft: Boolean(item.draftRevisionId && item.draftRevisionId !== item.liveRevisionId),
				data: draft ? { ...item.data, ...fields } : (item.data ?? {}),
				...(Object.keys(live).length ? { live } : {}),
				...(terms ? { terms } : {}),
			};
		}),
	);
	return { total, counted, ...(total === null && estimate !== null ? { estimate } : {}), offset: input.offset, rows };
}

/** What a preview needs: the collection, the entries a filter (or id list) selects, and the count. */
export interface Matching {
	schema: CollectionDef;
	total: number;
	/** The first `cap` matching entries, with the terms of `withTerms` loaded. */
	entries: Entry[];
}

/**
 * Entries a filter selects, for a preview over all of them (up to `cap`). Uses the same scan as
 * the rows route (waits for it to finish, so the count is exact).
 */
export async function matchingEntries(ctx: Ctx, input: { collection: string; filter?: unknown; ids?: string[]; cap: number; withTerms: string[] }): Promise<Matching> {
	const content = need(ctx.content, "content");
	const schema = await loadCollection(ctx, input.collection);
	let items: HostItem[] = [];
	let total = 0;
	if (input.ids?.length) {
		const found = await Promise.all(input.ids.map((id) => content.get(schema.slug, id) as unknown as Promise<HostItem | null>));
		const all = found.filter((x): x is HostItem => Boolean(x));
		total = all.length;
		items = all.slice(0, input.cap);
	} else {
		const cols = columnMap(schema);
		const filterTerms = collectTermNames(input.filter);
		const termDefs: Record<string, TermDef[]> = {};
		for (const name of filterTerms) termDefs[name] = (await listTerms(ctx, name)).map((t) => ({ id: t.id, taxonomy: name, slug: t.slug, label: t.label, parentId: t.parent, translationGroup: t.group }));
		let compiled;
		try {
			compiled = compileFilter(input.filter ?? {}, cols, termDefs);
		} catch (err) {
			throw new GridReadError("BAD_FILTER", (err as Error).message);
		}
		assertIndexedFilter(input.filter, cols, schema.titleField);
		// A bulk-edit preview always reads afresh (2026-10-02): it must not be computed from
		// values someone changed meanwhile. The new read replaces the cached one of this filter.
		const cacheKey = JSON.stringify([schema.slug, input.filter ?? {}, null]);
		const [stamp, termSig] = await Promise.all([collectionStamp(ctx, schema.slug), termSignature(compiled, termDefs, schema.slug)]);
		const scan = startScan(ctx, schema, compiled, termDefs, undefined, stamp, filterKey(input.filter ?? {}));
		scan.termSig = termSig;
		scans.delete(cacheKey);
		scans.set(cacheKey, scan);
		while (scans.size > MAX_SCANS) scans.delete(scans.keys().next().value!);
		const current = scan;
		await waitFor(current, Number.MAX_SAFE_INTEGER, 60_000);
		if (current.error) throw current.error;
		total = current.list.length;
		// The scan keeps short values only: the preview plans on whole, current entries.
		items = (await Promise.all(idsOf(current.store, current.list.slice(0, input.cap)).map((id) => content.get(schema.slug, id) as unknown as Promise<HostItem | null>))).filter((x): x is HostItem => Boolean(x));
	}
	const attached = new Set((schema.taxonomies ?? []).map((t) => t.name));
	const want = input.withTerms.filter((t) => attached.has(t));
	const terms = want.length ? await termsOfMany(ctx, schema.slug, items.map((i) => i.id), want) : null;
	return { schema, total, entries: items.map((i) => toEntry(i, terms?.get(i.id))) };
}

/**
 * Entries whose pending draft holds exactly the published values (what a rollback of a
 * draft-mode job leaves behind). Such a draft changes nothing, yet publish-mode jobs hold the
 * entry back; the grid offers to discard these drafts through the admin REST API.
 */
export async function emptyDrafts(ctx: Ctx, collection: string, ids: string[]): Promise<string[]> {
	const content = need(ctx.content, "content");
	const schema = await loadCollection(ctx, collection);
	const empty: string[] = [];
	// Without ids: every entry of the collection that has a pending draft.
	const items: HostItem[] = [];
	if (ids.length) {
		for (const id of ids) {
			const item = (await content.get(schema.slug, id)) as unknown as HostItem | null;
			if (item) items.push(item);
		}
	} else {
		let cursor: string | undefined;
		for (;;) {
			const res = (await content.list(schema.slug, { limit: HOST_PAGE, ...(cursor ? { cursor } : {}) })) as unknown as { items: HostItem[]; cursor?: string; hasMore: boolean };
			items.push(...res.items.filter((x) => x.draftRevisionId && x.draftRevisionId !== x.liveRevisionId));
			if (!res.hasMore || !res.cursor) break;
			cursor = res.cursor;
		}
	}
	for (const item of items) {
		const id = item.id;
		if (!item.draftRevisionId || item.draftRevisionId === item.liveRevisionId || !content.getRevision) continue;
		const rev = await content.getRevision(schema.slug, id, item.draftRevisionId);
		if (!rev) continue;
		// Anything the draft carries besides field values (slug change, staged references…)
		// makes it a real draft: only plain field snapshots equal to the live values are empty.
		const extra = Object.keys(rev.data).filter((k) => k.startsWith("_") && !isNeutralMeta(k, rev.data[k], item));
		if (extra.length) continue;
		const same = schema.fields.every((f) => !(f.slug in rev.data) || valuesEqual(rev.data[f.slug] ?? null, item.data?.[f.slug] ?? null));
		if (same) empty.push(id);
	}
	return empty;
}

function isNeutralMeta(key: string, value: unknown, item: HostItem): boolean {
	if (key === "_slug") return value === item.slug;
	if (key === "_references") return !value || (typeof value === "object" && Object.keys(value as object).length === 0);
	return false;
}

function collectTermNames(filter: unknown): string[] {
	if (!filter || typeof filter !== "object") return [];
	const t = (filter as { terms?: unknown }).terms;
	return t && typeof t === "object" && !Array.isArray(t) ? Object.keys(t) : [];
}

/**
 * Repeater fields that are photo galleries: exactly one sub-field, of type image. The grid edits
 * those in its gallery panel (add, remove, reorder, then the whole list is written by the core);
 * other repeaters stay read-only in the grid. Answer: field key -> the image sub-field's key.
 */
export async function galleryFields(ctx: Ctx, collection: string): Promise<Record<string, string>> {
	const schema = await loadCollection(ctx, collection);
	const out: Record<string, string> = {};
	for (const f of schema.fields) {
		if (f.type !== "repeater") continue;
		const subs = ((f.validation as { subFields?: Array<{ slug: string; type: string }> } | null)?.subFields ?? []).filter(Boolean);
		if (subs.length === 1 && subs[0]!.type === "image") out[f.slug] = subs[0]!.slug;
	}
	return out;
}
