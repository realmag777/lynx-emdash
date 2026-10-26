import type { PluginRoute, RouteContext, StorageCollection } from "emdash";

import { searchLibrary } from "./media.ts";
import { previewAll } from "./preview.ts";
import { siteVersions } from "./versions.ts";
import { cacheStats, emptyDrafts, galleryFields, GridReadError, listTerms, MAX_LIMIT, readRows } from "./read.ts";

// Routes of the native lynx-grid plugin: /_emdash/api/plugins/lynx-grid/<route>. Reads only
// (rows, terms, bulk-edit preview, empty-draft check) and the user's saved views. Content writes go to the core.

type Obj = Record<string, unknown>;

interface ViewDoc {
	userId: string;
	collection: string;
	name: string;
	config: unknown;
	updatedAt: string;
}

const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
function str(o: Obj, k: string, required = false): string | undefined {
	const v = o[k];
	if (typeof v === "string" && v.trim()) return v.trim();
	if (required) throw new GridReadError("BAD_ARGUMENT", `${k} is required.`);
	return undefined;
}
const strList = (o: Obj, k: string, max: number): string[] => (Array.isArray(o[k]) ? (o[k] as unknown[]).filter((x): x is string => typeof x === "string" && x.length > 0).slice(0, max) : []);
function int(o: Obj, k: string, min: number, max: number, def: number): number {
	const v = o[k];
	return typeof v === "number" && Number.isFinite(v) ? Math.max(min, Math.min(max, Math.floor(v))) : def;
}

/** Turn read errors into the plugin error shape the admin client understands. */
// A read refusal comes back as { ok: false, code, message } in a 200 answer, as the core does: a
// thrown PluginRouteError reaches the admin as a bare "Plugin route error" (500) whenever the grid
// and the site load two copies of emdash (instanceof fails), which hid every reason from the user.
async function guard<T>(run: () => Promise<T>): Promise<T | { ok: false; code: string; message: string }> {
	try {
		return await run();
	} catch (err) {
		if (err instanceof GridReadError || (err as { name?: string })?.name === "GridReadError") return { ok: false, code: (err as GridReadError).code, message: (err as Error).message };
		throw err;
	}
}

const views = (ctx: RouteContext) => ctx.storage.views as StorageCollection<ViewDoc>;
const formats = (ctx: RouteContext) => ctx.storage.formats as StorageCollection<{ collection: string; formats: Record<string, unknown>; updatedAt: string }>;

/** A field format as stored: currency symbol (≤ 8 chars), position, decimals 0-6. */
function cleanFormats(raw: unknown): Record<string, { currency?: string; position?: "before" | "after"; decimals?: number }> {
	const out: Record<string, { currency?: string; position?: "before" | "after"; decimals?: number }> = {};
	for (const [key, v] of Object.entries(obj(raw))) {
		if (!/^[a-z][a-z0-9_]*$/i.test(key)) continue;
		const o = obj(v);
		out[key] = {
			...(typeof o.currency === "string" && o.currency.length <= 8 ? { currency: o.currency } : {}),
			...(o.position === "after" || o.position === "before" ? { position: o.position } : {}),
			...(typeof o.decimals === "number" && o.decimals >= 0 && o.decimals <= 6 ? { decimals: Math.floor(o.decimals) } : {}),
		};
	}
	return out;
}
const userOf = (ctx: RouteContext) => ctx.user?.id ?? "anonymous";

const allRoutes: Record<string, PluginRoute> = {
	rows: {
		permission: "content:read",
		handler: async (ctx) =>
			guard(async () => {
				const o = obj(ctx.input);
				const sort = obj(o.sort);
				return readRows(ctx, {
					collection: str(o, "collection", true)!,
					filter: o.filter ?? {},
					sort: typeof sort.key === "string" ? { key: sort.key, dir: sort.dir === "asc" ? "asc" : "desc" } : null,
					offset: int(o, "offset", 0, Number.MAX_SAFE_INTEGER, 0),
					limit: int(o, "limit", 1, MAX_LIMIT, 50),
					terms: strList(o, "terms", 20),
					fresh: o.fresh === true,
				});
			}),
	},

	preview: {
		permission: "content:read",
		handler: async (ctx) =>
			guard(async () => {
				const o = obj(ctx.input);
				const ids = strList(o, "ids", 5000);
				return previewAll(ctx, { collection: str(o, "collection", true)!, ...(ids.length ? { ids } : { filter: o.filter ?? {} }), operations: o.operations, mode: o.mode === "draft" ? "draft" : "publish" });
			}),
	},

	terms: {
		permission: "content:read",
		handler: async (ctx) => guard(async () => ({ terms: await listTerms(ctx, str(obj(ctx.input), "taxonomy", true)!) })),
	},

	"drafts/empty": {
		permission: "content:read",
		handler: async (ctx) =>
			guard(async () => {
				const o = obj(ctx.input);
				return { empty: await emptyDrafts(ctx, str(o, "collection", true)!, strList(o, "ids", 500)) };
			}),
	},

	// Installed versions of the grid's peers (the page warns when they do not match).
	versions: {
		permission: "content:read",
		handler: async () => siteVersions(),
	},

	// The media library for the photo panel: search (title, description, file name) and pages.
	// What the grid keeps in memory now (ids and indexed values per cached read): for checks and Settings.
	cache: {
		permission: "content:read",
		handler: async () => cacheStats(),
	},

	"media/search": {
		permission: "content:read",
		handler: async (ctx) => {
			const o = obj(ctx.input);
			const exclude = Array.isArray(o.exclude) ? o.exclude.filter((x): x is string => typeof x === "string").slice(0, 500) : [];
			return searchLibrary(ctx, { q: typeof o.q === "string" ? o.q : "", page: Number(o.page) || 1, perPage: Number(o.per_page) || 24, fresh: o.fresh === true, exclude });
		},
	},

	// Repeaters that are photo galleries (one image sub-field): the grid edits them in a panel.
	galleries: {
		permission: "content:read",
		handler: async (ctx) => ({ galleries: await galleryFields(ctx, str(obj(ctx.input), "collection", true)!) }),
	},

	"formats/get": {
		permission: "content:read",
		handler: async (ctx) => {
			const collection = str(obj(ctx.input), "collection", true)!;
			return { formats: (await formats(ctx).get(collection))?.formats ?? null };
		},
	},

	"formats/save": {
		// Site-wide display settings of number fields (currency, decimals): editors may change them.
		permission: "content:edit_any",
		handler: async (ctx) => {
			const o = obj(ctx.input);
			const collection = str(o, "collection", true)!;
			const doc = { collection, formats: cleanFormats(o.formats), updatedAt: new Date().toISOString() };
			await formats(ctx).put(collection, doc);
			return { formats: doc.formats };
		},
	},

	"views/list": {
		permission: "content:read",
		handler: async (ctx) => {
			const res = await views(ctx).query({ where: { userId: userOf(ctx), collection: str(obj(ctx.input), "collection", true)! }, limit: 50 });
			return { views: res.items.map((x) => ({ id: x.id, name: x.data.name, collection: x.data.collection, config: x.data.config, updatedAt: x.data.updatedAt })) };
		},
	},

	"views/save": {
		permission: "content:read",
		handler: async (ctx) => {
			const o = obj(ctx.input);
			const name = str(o, "name", true)!.slice(0, 80);
			const collection = str(o, "collection", true)!;
			let id = str(o, "id");
			if (id) {
				const got = await views(ctx).get(id);
				if (!got || got.userId !== userOf(ctx)) throw new GridReadError("NOT_FOUND", "No such view.");
			} else id = `v_${crypto.randomUUID()}`;
			const doc: ViewDoc = { userId: userOf(ctx), collection, name, config: obj(o.config), updatedAt: new Date().toISOString() };
			await views(ctx).put(id, doc);
			return { id, name, collection, config: doc.config, updatedAt: doc.updatedAt };
		},
	},

	"views/delete": {
		permission: "content:read",
		handler: async (ctx) => {
			const id = str(obj(ctx.input), "id", true)!;
			const got = await views(ctx).get(id);
			if (!got || got.userId !== userOf(ctx)) return { deleted: false };
			return { deleted: await views(ctx).delete(id) };
		},
	},
};

/** Every route answers a refusal as { ok: false, code, message } (see guard). */
export const routes: Record<string, PluginRoute> = Object.fromEntries(Object.entries(allRoutes).map(([name, r]) => [name, { ...r, handler: (ctx: RouteContext) => guard(() => r.handler(ctx as never) as Promise<unknown>) }])) as Record<string, PluginRoute>;
