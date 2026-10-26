import {
	buildColumns,
	columnMap,
	compileFilter,
	displayValue,
	isExpired,
	matchesFilter,
	newSelectionId,
	SELECTION_MAX,
	SELECTION_TTL_MS,
	type Column,
	type CollectionDef,
	type Entry,
} from "@realmag777/lynx-engine";

import { LynxError } from "./errors.ts";
import { content, loadCollection, loadEntryTerms, loadTerms, toEntry, type HostItem } from "./host.ts";
import type { Meter } from "./meter.ts";
import { PAGE_SIZE, pageId, stores, type SelectionDoc } from "./store.ts";

// Frozen selections (BEAR rule: a write never takes a filter). Building one can take
// several calls on Cloudflare: each call scans host pages until its budget runs out and
// the answer says "building" until the whole collection has been looked at.

const HOST_PAGE = 100;
/** Calls kept back at the end of a find call to save the selection. */
const SAVE_RESERVE = 1;

export interface Row {
	id: string;
	[field: string]: unknown;
}

export const DEFAULT_SAMPLE = 20;
export const MAX_ROWS = 50;

/** Default columns: title, status, then up to six indexed fields in schema order. */
export function defaultFields(schema: CollectionDef): string[] {
	const title = schema.titleField ?? "title";
	const indexed = schema.fields.filter((f) => f.indexed && f.slug !== title).map((f) => f.slug).slice(0, 6);
	return [title, "status", ...indexed];
}

export function toRow(entry: Entry, fields: string[], cols: Map<string, Column>): Row {
	const row: Row = { id: entry.id };
	for (const f of fields) {
		if (f === "status") row.status = entry.status;
		else if (f === "slug") row.slug = entry.slug;
		else if (f === "locale") row.locale = entry.locale;
		else if (f === "updated_at") row.updated_at = entry.updatedAt;
		else {
			const col = cols.get(f);
			const v = entry.data[f];
			// Scalars stay typed for tables; structured values become short text.
			row[f] = v === null || v === undefined ? null : typeof v === "object" ? displayValue(col?.field ?? { type: "json" }, v, 80) : col?.type === "boolean" ? v === true || v === 1 : v;
		}
	}
	return row;
}

function hostWhere(sel: Pick<SelectionDoc, "compiled">) {
	const h = sel.compiled.host;
	return {
		...(h.status ? { status: h.status } : {}),
		...(h.locale ? { locale: h.locale } : {}),
		...(Object.keys(h.fieldFilters).length ? { fieldFilters: h.fieldFilters as never } : {}),
	};
}

export interface FindArgs {
	collection?: string;
	filter?: unknown;
	selectionId?: string;
	sample: number;
	fields?: string[];
	userId?: string;
	now?: Date;
}

export interface FindResult {
	selection: SelectionDoc;
	sample: Row[];
	fields: string[];
}

/** Start or continue building a selection within the meter's budget. */
export async function find(m: Meter, args: FindArgs): Promise<FindResult> {
	const s = stores(m.ctx);
	const now = args.now ?? new Date();
	let sel: SelectionDoc;
	let termsNeeded: string[] = [];

	if (args.selectionId) {
		const got = await s.selections.get(args.selectionId);
		if (!got) throw new LynxError("UNKNOWN_SELECTION", "Unknown or expired selection. Run find_entries again - do not guess an entry list.");
		if (isExpired(got, now)) throw new LynxError("SELECTION_EXPIRED", "That selection has expired. Run find_entries again so the count is current.");
		sel = got;
		termsNeeded = sel.compiled.terms.map((t) => t.taxonomy);
	} else {
		if (!args.collection) throw new LynxError("BAD_ARGUMENT", "collection is required to start a selection.");
		const schema = await loadCollection(m.ctx, args.collection);
		const cols = columnMap(schema);
		const termNames = collectTermNames(args.filter);
		const terms = termNames.length ? await loadTerms(m.ctx, termNames) : {};
		const compiled = compileFilter(args.filter, cols, terms);
		termsNeeded = compiled.terms.map((t) => t.taxonomy);
		const id = newSelectionId();
		sel = {
			id,
			collection: schema.slug,
			state: "building",
			filter: args.filter ?? {},
			compiled,
			summary: compiled.summary,
			schema,
			cursor: null,
			skip: 0,
			scanned: 0,
			count: 0,
			buffer: [],
			pages: 0,
			hostPages: [],
			translations: false,
			wholeCollection: compiled.empty,
			createdAt: now.toISOString(),
			expiresAt: new Date(now.getTime() + SELECTION_TTL_MS).toISOString(),
			...(args.userId ? { userId: args.userId } : {}),
		};
		if (compiled.ids) {
			// An explicit id list is frozen as given; get_entries reads those ids one by one.
			sel.buffer = compiled.ids.slice(0, SELECTION_MAX);
			sel.count = sel.buffer.length;
			sel.state = "ready";
		}
	}

	const cols = columnMap(sel.schema);
	const fields = (args.fields?.length ? args.fields : defaultFields(sel.schema)).filter((f) => f === "status" || f === "slug" || f === "locale" || f === "updated_at" || cols.has(f));
	const sample: Row[] = [];
	const newPages: Array<{ id: string; data: { owner: string; n: number; ids: string[] } }> = [];
	const flush = (force: boolean) => {
		while (sel.buffer.length >= PAGE_SIZE || (force && sel.buffer.length)) {
			const ids = sel.buffer.splice(0, PAGE_SIZE);
			newPages.push({ id: pageId(sel.id, sel.pages), data: { owner: sel.id, n: sel.pages, ids } });
			sel.pages++;
		}
	};

	const list = content(m.ctx).list;
	while (sel.state === "building" && m.has(1 + SAVE_RESERVE)) {
		const first = sel.count;
		const res = (await list(sel.collection, { limit: HOST_PAGE, ...(sel.cursor ? { cursor: sel.cursor } : {}), where: hostWhere(sel) })) as unknown as { items: HostItem[]; cursor?: string; hasMore: boolean };
		if (sel.skip === 0) sel.hostPages.push({ cursor: sel.cursor, first });
		for (let i = sel.skip; i < res.items.length; i++) {
			const item = res.items[i]!;
			if (item.translationGroup && item.translationGroup !== item.id) sel.translations = true;
			let entry = toEntry(item);
			if (termsNeeded.length) {
				if (!m.has(1 + SAVE_RESERVE)) {
					// Out of budget in the middle of a host page: resume at this item next time.
					sel.skip = i;
					return finish();
				}
				entry = toEntry(item, await loadEntryTerms(m.ctx, sel.collection, item.id, termsNeeded));
			}
			sel.scanned++;
			if (!matchesFilter(entry, sel.compiled, cols)) {
				sel.wholeCollection = false;
				continue;
			}
			if (sel.count >= SELECTION_MAX) {
				throw new LynxError("SELECTION_TOO_LARGE", `The filter matched more than ${SELECTION_MAX} entries, above the limit for one selection. Narrow it.`);
			}
			sel.buffer.push(item.id);
			sel.count++;
			if (sample.length < args.sample) sample.push(toRow(entry, fields, cols));
		}
		sel.skip = 0;
		sel.cursor = res.cursor ?? null;
		if (!res.hasMore || !res.cursor) sel.state = "ready";
		flush(false);
	}
	return finish();

	async function finish(): Promise<FindResult> {
		if (sel.state === "ready") flush(true);
		await s.selections.put(sel.id, sel);
		if (newPages.length) await s.pages.putMany(newPages);
		return { selection: sel, sample, fields };
	}
}

function collectTermNames(filter: unknown): string[] {
	if (!filter || typeof filter !== "object") return [];
	const t = (filter as { terms?: unknown }).terms;
	return t && typeof t === "object" && !Array.isArray(t) ? Object.keys(t) : [];
}

/** Load a ready selection for a write. */
export async function loadReadySelection(m: Meter, id: string, now = new Date()): Promise<SelectionDoc> {
	const sel = await stores(m.ctx).selections.get(id);
	if (!sel) throw new LynxError("UNKNOWN_SELECTION", "Unknown or expired selection. Run find_entries again - do not guess an entry list.");
	if (isExpired(sel, now)) throw new LynxError("SELECTION_EXPIRED", "That selection has expired. Run find_entries again so the count is current.");
	if (sel.state !== "ready") {
		throw new LynxError("SELECTION_BUILDING", `This selection is still being built (${sel.count} found in ${sel.scanned} looked at so far). Call find_entries with this selection_id until state is ready, then use it.`);
	}
	return sel;
}

/** Ids of a selection page (small selections keep their ids in the buffer). */
export async function selectionIds(m: Meter, sel: SelectionDoc, page: number): Promise<string[]> {
	if (sel.pages === 0) return page === 0 ? sel.buffer : [];
	const doc = await stores(m.ctx).pages.get(pageId(sel.id, page));
	return doc?.ids ?? [];
}

/**
 * Read entries of a selection from `offset`, using the host query the selection was built
 * with (one list call per 100 rows scanned). Explicit-id selections read ids one by one.
 */
export async function readSelection(m: Meter, sel: SelectionDoc, offset: number, count: number, withTerms: string[] = []): Promise<Entry[]> {
	const ids = new Set<string>();
	const firstPage = Math.floor(offset / PAGE_SIZE);
	const lastPage = Math.floor((offset + count - 1) / PAGE_SIZE);
	const ordered: string[] = [];
	for (let p = firstPage; p <= lastPage && p < Math.max(1, sel.pages); p++) {
		const pageIds = await selectionIds(m, sel, p);
		const from = p === firstPage ? offset - p * PAGE_SIZE : 0;
		for (const id of pageIds.slice(from, from + count - ordered.length)) {
			ids.add(id);
			ordered.push(id);
		}
	}
	const found = new Map<string, Entry>();
	if (sel.compiled.ids || sel.hostPages.length === 0) {
		for (const id of ordered) {
			if (!m.has(1)) break;
			const v = await content(m.ctx).getVersioned(sel.collection, id);
			if (v) found.set(id, toEntry(v.item as unknown as HostItem));
		}
	} else {
		// Jump to the host page that holds `offset`, then scan forward.
		let hp = 0;
		for (let i = 0; i < sel.hostPages.length; i++) if (sel.hostPages[i]!.first <= offset) hp = i;
		let cursor = sel.hostPages[hp]?.cursor ?? null;
		while (found.size < ids.size && m.has(1)) {
			const res = (await content(m.ctx).list(sel.collection, { limit: HOST_PAGE, ...(cursor ? { cursor } : {}), where: hostWhere(sel) })) as unknown as { items: HostItem[]; cursor?: string; hasMore: boolean };
			for (const item of res.items) if (ids.has(item.id)) found.set(item.id, toEntry(item));
			if (!res.hasMore || !res.cursor) break;
			cursor = res.cursor;
		}
	}
	const out: Entry[] = [];
	for (const id of ordered) {
		const e = found.get(id);
		if (!e) continue;
		// Terms cost one call per entry: load them while the budget lasts; the rest come without a terms key.
		if (withTerms.length && m.has(1)) e.terms = await loadEntryTerms(m.ctx, sel.collection, id, withTerms);
		out.push(e);
	}
	return out;
}

export function describeColumns(schema: CollectionDef): Column[] {
	return buildColumns(schema);
}
