import { buildColumns } from "@realmag777/lynx-engine";

import { LynxError } from "./errors.ts";
import { loadCollection, SINGLE_KEY, taxonomies, withSingle, type Ctx } from "./host.ts";
import { stores, type MemoryDoc } from "./store.ts";

export async function describeSite(ctx: Ctx) {
	if (!ctx.schema) throw new LynxError("FORBIDDEN", "LYNX was installed without schema access.");
	const [cols, defs] = await Promise.all([ctx.schema.listCollections(), taxonomies(ctx).getAll()]);
	return {
		site: { name: ctx.site.name, url: ctx.site.url, locale: ctx.site.locale },
		collections: cols.map((c) => ({
			slug: c.slug,
			label: c.label,
			revisions: c.supports.includes("revisions"),
			search: c.supports.includes("search"),
			fields: c.fields.length,
			indexed_fields: c.fields.filter((f) => f.indexed).map((f) => f.slug),
			taxonomies: defs.filter((d) => d.collections.includes(c.slug)).map((d) => d.name),
		})),
		taxonomies: defs.map((d) => ({ name: d.name, label: d.label, hierarchical: d.hierarchical, collections: d.collections })),
	};
}

export async function listFields(ctx: Ctx, collection: string, editableOnly: boolean, single: string[]) {
	const schema = withSingle(await loadCollection(ctx, collection), single);
	const cols = buildColumns(schema).filter((c) => !editableOnly || c.editable);
	return {
		collection: schema.slug,
		revisions: schema.supports.includes("revisions"),
		count: cols.length,
		fields: cols.map((c) => ({
			key: c.key,
			label: c.label,
			type: c.type,
			editable: c.editable,
			bulk: c.bulk,
			filter: c.filter,
			sortable: c.sortable,
			behaviors: c.behaviors,
			...(c.options ? { options: c.options } : {}),
			...(c.unit ? { unit: c.unit } : {}),
			...(c.format ? { format: c.format } : {}),
			...(c.closed ? { closed: c.closed } : {}),
			// The field's value rules (limits, pattern…), so a value can be checked before saving.
			...(c.field?.validation ? { rules: c.field.validation } : {}),
			...(c.taxonomy?.single ? { single: true } : {}),
			required: c.required,
			unique: c.unique,
			translatable: c.translatable,
		})),
	};
}

/** Make a taxonomy take one term per entry, or several again. */
export async function setSingle(ctx: Ctx, taxonomy: string, single: boolean) {
	const now = new Set((await ctx.kv.get<string[]>(SINGLE_KEY)) ?? []);
	if (single) now.add(taxonomy);
	else now.delete(taxonomy);
	await ctx.kv.set(SINGLE_KEY, [...now]);
	return { single_taxonomies: [...now] };
}

export async function listTerms(ctx: Ctx, taxonomy: string, search: string | undefined, limit: number) {
	const defs = await taxonomies(ctx).getAll();
	const def = defs.find((d) => d.name === taxonomy);
	if (!def) throw new LynxError("UNKNOWN_TAXONOMY", `There is no taxonomy "${taxonomy}". describe_site lists them: ${defs.map((d) => d.name).join(", ")}.`);
	const terms = (await taxonomies(ctx).getTerms(taxonomy)) as Array<{ id: string; slug: string; label: string; parentId: string | null; translationGroup: string | null }>;
	const byGroup = new Map(terms.map((t) => [t.translationGroup ?? t.id, t]));
	const depth = (t: (typeof terms)[number]): number => {
		let d = 0;
		let cur = t;
		while (cur.parentId && d < 10) {
			const p = byGroup.get(cur.parentId) ?? terms.find((x) => x.id === cur.parentId);
			if (!p) break;
			cur = p;
			d++;
		}
		return d;
	};
	const q = search?.toLowerCase();
	const rows = terms
		.filter((t) => !q || t.label.toLowerCase().includes(q) || t.slug.includes(q))
		.map((t) => {
			const parent = t.parentId ? (byGroup.get(t.parentId) ?? terms.find((x) => x.id === t.parentId)) : undefined;
			return { id: t.id, slug: t.slug, label: t.label, parent: parent?.slug ?? null, depth: depth(t) };
		});
	return { taxonomy, hierarchical: def.hierarchical, count: rows.length, terms: rows.slice(0, limit), ...(rows.length > limit ? { truncated: true } : {}) };
}

export const MEMORY_MAX_KEYS = 50;
export const MEMORY_MAX_TEXT = 500;

export async function getMemory(ctx: Ctx) {
	const res = await stores(ctx).memory.query({ limit: 100 });
	return Object.fromEntries(res.items.map((i) => [i.id, i.data.text]));
}

export async function setMemory(ctx: Ctx, entries: Record<string, unknown>, userId?: string) {
	const s = stores(ctx).memory;
	const put: Array<{ id: string; data: MemoryDoc }> = [];
	const del: string[] = [];
	const now = new Date().toISOString();
	for (const [rawKey, value] of Object.entries(entries)) {
		const key = rawKey.toLowerCase().replace(/[^a-z0-9_-]+/g, "_").slice(0, 64);
		if (!key) continue;
		if (value === null) del.push(key);
		else if (typeof value === "string") {
			const text = value.trim();
			if (text.length > MEMORY_MAX_TEXT) throw new LynxError("BAD_ARGUMENT", `The note for ${key} is ${text.length} characters; keep each note under ${MEMORY_MAX_TEXT}. Nothing was saved.`);
			put.push({ id: key, data: { key, text, updatedAt: now, ...(userId ? { userId } : {}) } });
		} else throw new LynxError("BAD_ARGUMENT", `entries.${rawKey} must be a short sentence (text) or null to delete it. Nothing was saved.`);
	}
	if (!put.length && !del.length) throw new LynxError("BAD_ARGUMENT", "entries is empty. Nothing was saved.");
	const existing = await getMemory(ctx);
	const keys = new Set([...Object.keys(existing).filter((k) => !del.includes(k)), ...put.map((p) => p.id)]);
	if (keys.size > MEMORY_MAX_KEYS) throw new LynxError("MEMORY_FULL", `Memory holds at most ${MEMORY_MAX_KEYS} notes; this would make ${keys.size}. Delete or merge notes first. Nothing was saved.`);
	if (put.length) await s.putMany(put);
	if (del.length) await s.deleteMany(del);
	return { saved: put.map((p) => p.id), deleted: del, entries: { ...Object.fromEntries(Object.entries(existing).filter(([k]) => !del.includes(k))), ...Object.fromEntries(put.map((p) => [p.id, p.data.text])) } };
}

// Agent access detector. EmDash switches a plugin's agent tools off on every registry or
// marketplace update, even when the tools did not change, and a plugin cannot read that switch
//. LYNX remembers the version the agent last
// connected to; when it differs from the running version, the admin page asks to check.
const AGENT_KEY = "agent:last-session";

export interface AgentSession {
	version: string;
	at: string;
}

export async function noteAgentSession(ctx: Ctx): Promise<void> {
	try {
		await ctx.kv.set(AGENT_KEY, { version: ctx.plugin.version, at: new Date().toISOString() } satisfies AgentSession);
	} catch {
		// Housekeeping only.
	}
}

export async function lastAgentSession(ctx: Ctx): Promise<AgentSession | null> {
	try {
		return (await ctx.kv.get<AgentSession>(AGENT_KEY)) ?? null;
	} catch {
		return null;
	}
}
