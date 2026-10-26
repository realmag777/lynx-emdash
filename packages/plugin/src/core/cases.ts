import { isEmptyValue, type Operation } from "@realmag777/lynx-engine";

import { LynxError } from "./errors.ts";
import { content, loadCollection, type Ctx, type HostItem } from "./host.ts";
import { budgetFor, type Meter, type StepSize } from "./meter.ts";
import { previewBulk } from "./preview.ts";
import { find } from "./selections.ts";

// Ready-made starting points (BEAR "cases"). Read-only by construction: a case may only
// find, preview and read. A case that leads to a change returns `to_apply`, the exact
// apply_bulk call, and never performs it.

interface Site {
	collections: Array<{ slug: string; fields: Array<{ slug: string; type: string; unique: boolean }> }>;
	taxonomies: Array<{ name: string; collections: string[] }>;
}

/** All schemas and taxonomies in two bridge calls. */
async function loadSite(ctx: Ctx): Promise<Site> {
	if (!ctx.schema || !ctx.taxonomies) throw new LynxError("FORBIDDEN", "LYNX was installed without schema or taxonomy access.");
	const [collections, taxonomies] = await Promise.all([ctx.schema.listCollections(), ctx.taxonomies.getAll()]);
	return { collections, taxonomies };
}

interface CaseDef {
	id: string;
	render: "table" | "cards";
	/** Parameters and their defaults; what they mean is in the cases tool description (case-texts.ts). */
	params: Record<string, unknown>;
	/** Default params for this site, or null when the case does not apply here. */
	fits(site: Site): Record<string, unknown> | null;
	run(m: Meter, p: Record<string, unknown>, conf: { stepSize: StepSize; cacheRefresh: "republish" | "none" }): Promise<Record<string, unknown>>;
}

const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : d);
const text = (v: unknown, d: string) => (typeof v === "string" && v ? v : d);

function collectionWith(site: Site, fields: Array<[string, string[]]>): string | null {
	for (const c of site.collections) {
		if (fields.every(([slug, types]) => c.fields.some((f) => f.slug === slug && types.includes(f.type)))) return c.slug;
	}
	return null;
}

/** Read the whole collection page by page while the budget lasts. */
async function scan(m: Meter, slug: string, visit: (it: HostItem) => void): Promise<{ seen: number; complete: boolean }> {
	let cursor: string | undefined;
	let seen = 0;
	while (m.has(1)) {
		const res = (await content(m.ctx).list(slug, { limit: 100, ...(cursor ? { cursor } : {}) })) as unknown as { items: HostItem[]; cursor?: string; hasMore: boolean };
		for (const it of res.items) {
			seen++;
			visit(it);
		}
		if (!res.hasMore || !res.cursor) return { seen, complete: true };
		cursor = res.cursor;
	}
	return { seen, complete: false };
}

async function previewCase(m: Meter, conf: { stepSize: StepSize; cacheRefresh: "republish" | "none" }, collection: string, filter: unknown, operations: Operation[], mode: "draft" | "publish") {
	const f = await find(m, { collection, filter, sample: 0 });
	const sel = f.selection;
	if (sel.state !== "ready") {
		return { targets: { selection_id: sel.id, state: sel.state, count_so_far: sel.count }, note: "The selection is still being built; call find_entries with this selection_id until it is ready, then preview_bulk." };
	}
	if (sel.count === 0) return { targets: { selection_id: sel.id, count: 0 }, note: "Nothing matches, so there is nothing to change." };
	if (!m.has(3)) {
		return { targets: { selection_id: sel.id, count: sel.count }, to_preview: { tool: "preview_bulk", arguments: { selection_id: sel.id, operations, mode } } };
	}
	const pv = await previewBulk(m, { selection: sel, operations, mode, cacheRefresh: conf.cacheRefresh, limit: 10, budget: budgetFor(conf.stepSize) });
	return {
		targets: { selection_id: sel.id, count: sel.count, filter: sel.summary },
		preview: pv.plan.entries.map((e) => ({ id: e.id, title: e.title, changes: e.changes.map((c) => ({ field: c.field, before: c.display.before, after: c.display.after })) })),
		warnings: pv.warnings.map((w) => ({ code: w.code, text: w.text })),
		to_apply: { tool: "apply_bulk", arguments: { selection_id: sel.id, operations, confirm_count: sel.count, mode } },
	};
}

const CASES: CaseDef[] = [
	{
		id: "reprice_older",
		render: "table",
		params: {
			collection: "cars",
			before_year: 2018,
			percent: 5,
			direction: "decrease",
			round_to: 100,
			mode: "draft",
		},
		fits: (site) => {
			const c = collectionWith(site, [["year", ["integer"]], ["price", ["number", "integer"]]]);
			return c ? { collection: c } : null;
		},
		run: async (m, p, conf) => {
			const ops: Operation[] = [{ field: "price", behavior: text(p.direction, "decrease") === "increase" ? "increase_percent" : "decrease_percent", value: num(p.percent, 5) }];
			if (num(p.round_to, 100) > 0) ops.push({ field: "price", behavior: "round", step: num(p.round_to, 100), direction: "down" });
			return previewCase(m, conf, text(p.collection, "cars"), { where: { year: { lt: num(p.before_year, 2018) } } }, ops, text(p.mode, "draft") === "publish" ? "publish" : "draft");
		},
	},
	{
		id: "tag_near_sea",
		render: "table",
		params: {
			collection: "properties",
			max_distance_m: 500,
			taxonomy: "amenities",
			term: "sea-view",
		},
		fits: (site) => {
			const c = collectionWith(site, [["distance_to_sea_m", ["integer", "number"]]]);
			return c && site.taxonomies.some((t) => t.name === "amenities" && t.collections.includes(c)) ? { collection: c } : null;
		},
		run: async (m, p, conf) => {
			const tax = text(p.taxonomy, "amenities");
			const term = text(p.term, "sea-view");
			return previewCase(
				m,
				conf,
				text(p.collection, "properties"),
				{ where: { distance_to_sea_m: { lte: num(p.max_distance_m, 500) } }, terms: { [tax]: { none: [term] } } },
				[{ field: `terms:${tax}`, behavior: "add_terms", value: [term] }],
				"draft",
			);
		},
	},
	{
		id: "incomplete_entries",
		render: "table",
		params: { collection: "" },
		fits: (site) => (site.collections[0] ? { collection: site.collections[0].slug } : null),
		run: async (m, p) => {
			const slug = text(p.collection, "");
			if (!slug) throw new LynxError("BAD_ARGUMENT", "params.collection is required.");
			const schema = await loadCollection(m.ctx, slug);
			const fields = schema.fields.filter((f) => !["json", "blocks"].includes(f.type)).map((f) => f.slug);
			const empty = new Map<string, string[]>(fields.map((f) => [f, []]));
			const { seen, complete } = await scan(m, slug, (it) => {
				for (const f of fields) if (isEmptyValue(it.data[f])) empty.get(f)!.push(it.id);
			});
			const rows = [...empty.entries()].filter(([, ids]) => ids.length).map(([field, ids]) => ({ field, empty: ids.length, of: seen, examples: ids.slice(0, 5) }));
			return { collection: slug, looked_at: seen, complete, rows, next: 'find_entries with {"where":{"<field>":{"empty":true}}} gives the list of any row.' };
		},
	},
	{
		id: "drafts_to_review",
		render: "table",
		params: { collection: "" },
		fits: (site) => (site.collections[0] ? { collection: site.collections[0].slug } : null),
		run: async (m, p) => {
			const f = await find(m, { collection: text(p.collection, ""), filter: { status: "draft" }, sample: 20 });
			return {
				selection_id: f.selection.id,
				state: f.selection.state,
				count: f.selection.count,
				rows: f.sample,
				to_preview: { tool: "preview_bulk", arguments: { selection_id: f.selection.id, operations: [{ field: "status", behavior: "publish" }] } },
			};
		},
	},
	{
		id: "duplicate_codes",
		render: "table",
		params: { collection: "" },
		fits: (site) => {
			const c = site.collections.find((x) => x.fields.some((f) => f.unique));
			return c ? { collection: c.slug } : null;
		},
		run: async (m, p) => {
			const slug = text(p.collection, "");
			const schema = await loadCollection(m.ctx, slug);
			const fields = schema.fields.filter((f) => f.unique).map((f) => f.slug);
			const seen = new Map<string, Map<string, string[]>>(fields.map((f) => [f, new Map()]));
			const { seen: looked, complete } = await scan(m, slug, (it) => {
				for (const f of fields) {
					const v = it.data[f];
					if (v === null || v === undefined || v === "") continue;
					const map = seen.get(f)!;
					map.set(String(v), [...(map.get(String(v)) ?? []), it.id]);
				}
			});
			const duplicates = fields.flatMap((f) => [...seen.get(f)!.entries()].filter(([, ids]) => ids.length > 1).map(([value, ids]) => ({ field: f, value, entries: ids })));
			return { collection: slug, fields, looked_at: looked, complete, duplicates };
		},
	},
];

export async function listCases(ctx: Ctx) {
	const site = await loadSite(ctx);
	const out = [];
	for (const c of CASES) {
		const defaults = c.fits(site);
		if (!defaults) continue;
		out.push({ id: c.id, render: c.render, params: { ...c.params, ...defaults } });
	}
	return out;
}

export async function runCase(m: Meter, id: string, params: Record<string, unknown>, conf: { stepSize: StepSize; cacheRefresh: "republish" | "none" }) {
	const c = CASES.find((x) => x.id === id);
	if (!c) throw new LynxError("UNKNOWN_CASE", `There is no case "${id}". cases lists them: ${CASES.map((x) => x.id).join(", ")}.`);
	const merged = { ...c.params, ...params };
	return { case: c.id, render: c.render, params: merged, result: await c.run(m, merged, conf) };
}
