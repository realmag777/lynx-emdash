import { describe, expect, it } from "vitest";

import { ALL, lastCount, shiftCount } from "../src/server/counts.ts";
import { cacheStats, emptyDrafts, invalidateCollection, readRows } from "../src/server/read.ts";

// The grid's native read routes against a fake EmDash plugin context: host paging with a
// cursor, engine filtering, terms and draft values for the page, and the empty-draft check.

interface Item {
	id: string;
	slug: string;
	status: string;
	locale: string;
	data: Record<string, unknown>;
	updatedAt: string;
	draftRevisionId: string | null;
	liveRevisionId: string | null;
}

/** EmDash's plugin KV with revisions (compare-and-set). */
function fakeKv() {
	const m = new Map<string, { value: unknown; revision: string }>();
	let rev = 0;
	return {
		get: async (k: string) => (m.get(k)?.value ?? null) as never,
		getVersioned: async (k: string) => (m.get(k) ?? null) as never,
		compareAndSet: async (k: string, expected: string | null, value: unknown) => {
			if ((m.get(k)?.revision ?? null) !== expected) return { applied: false };
			const revision = String(++rev);
			m.set(k, { value: structuredClone(value), revision });
			return { applied: true, revision };
		},
	};
}

function fakeCtx(n: number, opts: { engineIndexed?: boolean } = {}) {
	const items: Item[] = Array.from({ length: n }, (_, i) => ({
		id: `e${String(i).padStart(3, "0")}`,
		slug: `car-${i}`,
		status: i % 5 === 0 ? "draft" : "published",
		locale: "en",
		data: { title: `Car ${i}`, price: 1000 + i * 10, ...(i % 9 ? { engine: ((i * 7) % 25) / 10 } : {}) },
		updatedAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
		draftRevisionId: null,
		liveRevisionId: `r${i}`,
	}));
	const revisions = new Map<string, Record<string, unknown>>();
	const entryTerms = new Map<string, string[]>(items.map((it, i) => [it.id, [i % 2 ? "diesel" : "petrol"]]));
	// Entry 3 has a real draft (price changed); entry 4 has a draft identical to the live values.
	items[3]!.draftRevisionId = "d3";
	revisions.set("d3", { title: "Car 3", price: 999, _slug: "car-3" });
	items[4]!.draftRevisionId = "d4";
	revisions.set("d4", { title: "Car 4", price: 1040, _slug: "car-4" });
	let listCalls = 0;
	const ctx = {
		schema: {
			getCollection: async (slug: string) =>
				slug === "cars"
					? {
							slug: "cars",
							label: "Cars",
							supports: ["drafts", "revisions"],
							titleField: "title",
							fields: [
								{ slug: "title", label: "Title", type: "string", required: true, unique: false, indexed: true, searchable: true, translatable: true },
								{ slug: "price", label: "Price", type: "number", required: false, unique: false, indexed: true, searchable: false, translatable: false },
								// Not indexed: EmDash refuses to order by it.
								{ slug: "engine", label: "Engine (L)", type: "number", required: false, unique: false, indexed: opts.engineIndexed === true, searchable: false, translatable: false },
							],
						}
					: null,
		},
		taxonomies: {
			getAll: async () => [{ name: "fuel", label: "Fuel", hierarchical: false, collections: ["cars"] }],
			getTerms: async () => [
				{ id: "diesel", slug: "diesel", label: "Diesel", parentId: null, taxonomy: "fuel" },
				{ id: "petrol", slug: "petrol", label: "Petrol", parentId: null, taxonomy: "fuel" },
			],
			getEntryTerms: async (_c: string, id: string) => (entryTerms.get(id) ?? []).map((t) => ({ id: t, slug: t, label: t, taxonomy: "fuel", parentId: null })),
		},
		content: {
			list: async (_c: string, o: { limit: number; cursor?: string; orderBy?: Record<string, string>; where?: { status?: string; fieldFilters?: Record<string, Record<string, number>> } }) => {
				listCalls++;
				if (o.orderBy && Object.keys(o.orderBy).some((k) => !["updatedAt", "price", "title", ...(opts.engineIndexed ? ["engine"] : [])].includes(k))) throw new Error("orderBy needs an indexed field");
				const ff = Object.entries(o.where?.fieldFilters ?? {});
				const cmp: Record<string, (a: number, b: number) => boolean> = { gt: (a, b) => a > b, gte: (a, b) => a >= b, lt: (a, b) => a < b, lte: (a, b) => a <= b };
				let all = items.filter((it) => (!o.where?.status || it.status === o.where.status) && ff.every(([k, c]) => Object.entries(c).every(([op, v]) => cmp[op]!(it.data[k] as number, v))));
				const [key, dir] = Object.entries(o.orderBy ?? { updatedAt: "desc" })[0]!;
				const val = (it: Item) => (key === "updatedAt" ? it.updatedAt : (it.data[key] as number | string));
				all = [...all].sort((a, b) => (val(a) < val(b) ? -1 : val(a) > val(b) ? 1 : 0) * (dir === "asc" ? 1 : -1));
				const start = o.cursor ? Number(o.cursor) : 0;
				const page = all.slice(start, start + o.limit);
				const next = start + o.limit;
				return { items: page, hasMore: next < all.length, ...(next < all.length ? { cursor: String(next) } : {}) };
			},
			get: async (_c: string, id: string) => items.find((it) => it.id === id) ?? null,
			getRevision: async (_c: string, _id: string, rev: string) => (revisions.has(rev) ? { id: rev, collection: "cars", entryId: _id, data: revisions.get(rev)!, createdAt: "" } : null),
		},
	};
	return { ctx: ctx as never, calls: () => listCalls, items, raw: ctx as Record<string, unknown> };
}

describe("grid read route", () => {
	it("pages a sorted, filtered collection with totals, terms and draft values", async () => {
		const { ctx, calls } = fakeCtx(250);
		const input = { collection: "cars", filter: {}, sort: { key: "price", dir: "asc" as const }, offset: 0, limit: 50, terms: ["fuel"] };
		// The first page comes as soon as it is scanned; the count may still be running.
		let all = await readRows(ctx, input);
		expect(all.rows).toHaveLength(50);
		expect(all.rows[3]).toMatchObject({ id: "e003", draft: true, data: { price: 999 }, terms: { fuel: ["diesel"] } });
		// Counting runs in the background: wait for it by time, not by attempts (slow CI machines).
		for (const end = Date.now() + 10000; all.total === null && Date.now() < end; ) {
			await new Promise((r) => setTimeout(r, 20));
			all = await readRows(ctx, input);
		}
		expect(all.total).toBe(250);
		// The same filter and sort reuse the scan: one call for the freshness stamp only.
		const before = calls();
		const next = await readRows(ctx, { ...input, offset: 200 });
		expect(calls()).toBe(before + 1);
		expect(next.rows).toHaveLength(50);
		expect(next.total).toBe(250);
		// A fresh read scans again.
		await readRows(ctx, { ...input, fresh: true });
		expect(calls()).toBeGreaterThan(before + 2);

		const q = { collection: "cars", filter: { status: "published", where: { price: { gte: 2000 } }, terms: { fuel: { any: ["petrol"] } } }, sort: { key: "price", dir: "desc" as const }, offset: 10, limit: 20, terms: [] };
		let cheap = await readRows(ctx, q);
		for (const end = Date.now() + 10000; cheap.total === null && Date.now() < end; ) {
			await new Promise((r) => setTimeout(r, 20));
			cheap = await readRows(ctx, q);
		}
		// published (4 of 5), price >= 2000 (i >= 100), petrol (even i): i in 100..249, even, not a multiple of 5.
		const expected = Array.from({ length: 250 }, (_, i) => i).filter((i) => i >= 100 && i % 2 === 0 && i % 5 !== 0);
		expect(cheap.total).toBe(expected.length);
		expect(cheap.rows.map((r) => r.data.price)).toEqual(expected.reverse().slice(10, 30).map((i) => 1000 + i * 10));
		expect(cheap.rows[0]!.terms).toBeUndefined();
	}, 30000);

	it("sorts only by indexed fields, empty values last both ways", async () => {
		await expect(readRows(fakeCtx(30).ctx, { collection: "cars", filter: {}, sort: { key: "engine", dir: "asc" }, offset: 0, limit: 10, terms: [] })).rejects.toThrow(/no index/);
		const { ctx } = fakeCtx(250, { engineIndexed: true });
		const v = (r: { data: Record<string, unknown> }) => (typeof r.data.engine === "number" ? r.data.engine : null);
		for (const dir of ["asc", "desc"] as const) {
			let first = await readRows(ctx, { collection: "cars", filter: {}, sort: { key: "engine", dir }, offset: 0, limit: 50, terms: [], fresh: true });
			for (let i = 0; first.total === null && i < 50; i++) first = await readRows(ctx, { collection: "cars", filter: {}, sort: { key: "engine", dir }, offset: 0, limit: 50, terms: [] });
			expect(first.total).toBe(250);
			const all = (await readRows(ctx, { collection: "cars", filter: {}, sort: { key: "engine", dir }, offset: 0, limit: 250, terms: [] })).rows.map(v);
			const known = all.filter((x): x is number => x !== null);
			expect(known).toEqual([...known].sort((a, b) => (dir === "asc" ? a - b : b - a)));
			expect(all.slice(known.length).every((x) => x === null)).toBe(true);
			expect(first.rows.map(v)).toEqual(all.slice(0, 50));
		}
	}, 30000);

	it("drops its cached read of a collection when a content hook says it changed", async () => {
		const { ctx, items } = fakeCtx(120);
		const q = { collection: "cars", filter: {}, sort: { key: "price", dir: "asc" as const }, offset: 5, limit: 5, terms: [] };
		await readRows(ctx, { ...q, fresh: true });
		const first = (await readRows(ctx, q)).rows[0]!.id;
		// A change that leaves updatedAt alone: the cached read still answers.
		items[50]!.data.price = -1;
		expect((await readRows(ctx, q)).rows[0]!.id).toBe(first);
		invalidateCollection("cars");
		expect((await readRows(ctx, { ...q, offset: 0 })).rows[0]!.id).toBe("e050");
	}, 30000);

	it("keeps ids and indexed values in one column store shared by every filter, and filters only by indexed fields", async () => {
		const { ctx } = fakeCtx(120);
		invalidateCollection("cars");
		await readRows(ctx, { collection: "cars", filter: {}, sort: { key: "price", dir: "desc" }, offset: 0, limit: 50, terms: [], fresh: true });
		// Title and price are indexed, engine is not: two columns.
		expect(cacheStats().stores.find((s) => s.collection === "cars")).toMatchObject({ entries: 120, columns: 2 });
		await expect(readRows(ctx, { collection: "cars", filter: { where: { engine: { gte: 1 } } }, sort: null, offset: 0, limit: 10, terms: [] })).rejects.toThrow(/no index/);
		let cheap = await readRows(ctx, { collection: "cars", filter: { where: { price: { gte: 2000 } } }, sort: { key: "price", dir: "asc" }, offset: 0, limit: 10, terms: [] });
		for (let i = 0; cheap.total === null && i < 50; i++) cheap = await readRows(ctx, { collection: "cars", filter: { where: { price: { gte: 2000 } } }, sort: { key: "price", dir: "asc" }, offset: 0, limit: 10, terms: [] });
		expect(cheap.rows.map((r) => r.data.price)).toEqual([2000, 2010, 2020, 2030, 2040, 2050, 2060, 2070, 2080, 2090]);
		// The filter's read holds positions only: the store still has one copy of each entry.
		expect(cacheStats().stores.find((s) => s.collection === "cars")!.entries).toBe(120);
		expect(cacheStats().scans.find((s) => s.key.includes("2000"))!.entries).toBe(20);
	}, 30000);

	it("shows the count found last time until the new count is done", async () => {
		const { ctx, raw } = fakeCtx(400);
		const kv = fakeKv();
		raw.kv = kv;
		invalidateCollection("cars");
		const q = { collection: "cars", filter: {}, sort: null, offset: 0, limit: 10, terms: [] };
		let r = await readRows(ctx, { ...q, fresh: true });
		expect(r.estimate).toBeUndefined();
		for (let i = 0; r.total === null && i < 50; i++) r = await readRows(ctx, q);
		expect(r.total).toBe(400);
		await new Promise((ok) => setTimeout(ok, 20));
		expect(await lastCount(kv as never, "cars", ALL)).toBe(400);
		// Two entries created elsewhere (the hooks), one trashed: the next read starts with ≈401.
		await shiftCount(kv as never, "cars", 1);
		await shiftCount(kv as never, "cars", 1);
		await shiftCount(kv as never, "cars", -1);
		invalidateCollection("cars");
		r = await readRows(ctx, { ...q, fresh: true });
		if (r.total === null) expect(r.estimate).toBe(401);
		for (let i = 0; r.total === null && i < 50; i++) r = await readRows(ctx, q);
		expect(r.total).toBe(400);
		await new Promise((ok) => setTimeout(ok, 20));
		expect(await lastCount(kv as never, "cars", ALL)).toBe(400);
	}, 30000);

	it("refuses a bad filter with the engine's reason", async () => {
		const { ctx } = fakeCtx(6);
		await expect(readRows(ctx, { collection: "cars", filter: { where: { nope: 1 } }, sort: null, offset: 0, limit: 10, terms: [] })).rejects.toThrow(/unknown field/);
	});

	it("finds drafts identical to the published values", async () => {
		const { ctx } = fakeCtx(10);
		expect(await emptyDrafts(ctx, "cars", [])).toEqual(["e004"]);
		expect(await emptyDrafts(ctx, "cars", ["e003", "e004", "e005"])).toEqual(["e004"]);
	});
});
