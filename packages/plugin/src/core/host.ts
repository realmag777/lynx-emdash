import type { CollectionDef, Entry, FieldDef, TaxonomyDef, TermDef } from "@realmag777/lynx-engine";
import type { PluginContext } from "emdash/plugin";

import { LynxError } from "./errors.ts";

// Thin, typed access to the capability-gated host APIs. Only exported authoring types
// are used (skills/creating-plugins/references/sandbox-boundaries.md).

export type Ctx = PluginContext;

/** The shape of ContentItem the plugin relies on (emdash core/src/plugins/types.ts:396-418). */
export interface HostItem {
	id: string;
	type?: string;
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
	version?: number;
}

interface HostTerm {
	id: string;
	taxonomy: string;
	slug: string;
	label: string;
	parentId: string | null;
	translationGroup: string | null;
}

export function content(ctx: Ctx) {
	if (!ctx.content) throw new LynxError("FORBIDDEN", "LYNX was installed without content access.");
	return ctx.content as Required<NonNullable<Ctx["content"]>>;
}

export function taxonomies(ctx: Ctx) {
	if (!ctx.taxonomies) throw new LynxError("FORBIDDEN", "LYNX was installed without taxonomy access.");
	return ctx.taxonomies as Required<NonNullable<Ctx["taxonomies"]>>;
}

export function toEntry(item: HostItem, terms?: Record<string, string[]>): Entry {
	return {
		id: item.id,
		slug: item.slug,
		status: item.status,
		locale: item.locale,
		translationGroup: item.translationGroup ?? null,
		data: item.data ?? {},
		...(terms ? { terms } : {}),
		...(item.version !== undefined ? { version: item.version } : {}),
		draftRevisionId: item.draftRevisionId ?? null,
		...(item.createdAt ? { createdAt: item.createdAt } : {}),
		updatedAt: item.updatedAt,
		publishedAt: item.publishedAt ?? null,
		scheduledAt: item.scheduledAt ?? null,
	};
}

/** Taxonomies that take one term per entry: a LYNX setting (EmDash allows several), read with the others. */
export const SINGLE_KEY = "settings:singleTaxonomies";

/** The schema with the one-term taxonomies marked. */
export function withSingle(schema: CollectionDef, single: string[]): CollectionDef {
	return single.length ? { ...schema, taxonomies: schema.taxonomies?.map((t) => (single.includes(t.name) ? { ...t, single: true } : t)) } : schema;
}

/** Collection schema plus the taxonomies attached to it. Two bridge calls. */
export async function loadCollection(ctx: Ctx, slug: string, opts: { withTaxonomies?: boolean } = {}): Promise<CollectionDef> {
	if (!ctx.schema) throw new LynxError("FORBIDDEN", "LYNX was installed without schema access.");
	// Taxonomies cost a second call; callers that never touch terms skip it.
	const [col, defs] = await Promise.all([ctx.schema.getCollection(slug), opts.withTaxonomies === false ? Promise.resolve([]) : taxonomies(ctx).getAll()]);
	if (!col) {
		throw new LynxError("UNKNOWN_COLLECTION", `There is no collection "${slug}" on this site. describe_site lists the collections.`);
	}
	return {
		slug: col.slug,
		label: col.label,
		supports: col.supports,
		titleField: col.titleField ?? (col.fields.some((f) => f.slug === "title") ? "title" : null),
		dateField: col.dateField,
		fields: col.fields.map(
			(f): FieldDef => ({
				slug: f.slug,
				label: f.label,
				type: f.type as FieldDef["type"],
				required: f.required,
				unique: f.unique,
				indexed: f.indexed,
				searchable: f.searchable,
				translatable: f.translatable,
				validation: (f.validation as FieldDef["validation"]) ?? null,
			}),
		),
		taxonomies: defs.filter((d) => d.collections.includes(slug)).map((d): TaxonomyDef => ({ name: d.name, label: d.label, ...(d.labelSingular ? { labelSingular: d.labelSingular } : {}), hierarchical: d.hierarchical, collections: d.collections })),
	};
}

/** Every term of the given taxonomies. One bridge call per taxonomy. */
export async function loadTerms(ctx: Ctx, names: string[]): Promise<Record<string, TermDef[]>> {
	const out: Record<string, TermDef[]> = {};
	for (const name of names) {
		const rows = (await taxonomies(ctx).getTerms(name)) as HostTerm[];
		out[name] = rows.map((t) => ({ id: t.id, taxonomy: name, slug: t.slug, label: t.label, parentId: t.parentId, translationGroup: t.translationGroup }));
	}
	return out;
}

/** Term ids assigned to an entry, keyed by taxonomy. One bridge call. */
export async function loadEntryTerms(ctx: Ctx, collection: string, entryId: string, only?: string[]): Promise<Record<string, string[]>> {
	const rows = (await taxonomies(ctx).getEntryTerms(collection, entryId)) as HostTerm[];
	const out: Record<string, string[]> = {};
	for (const name of only ?? []) out[name] = [];
	for (const t of rows) {
		if (only && !only.includes(t.taxonomy)) continue;
		(out[t.taxonomy] ??= []).push(t.id);
	}
	return out;
}

/** The _rev the host will expect after one successful update. */
export function revAfterUpdate(versionBefore: number | undefined, updatedAt: string): string {
	const text = `${(versionBefore ?? 0) + 1}:${updatedAt}`;
	const bytes = new TextEncoder().encode(text);
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin);
}

/**
 * True where LYNX runs in-process (Node), with no subrequest limit. Inside a sandbox `process`
 * is absent: on Cloudflare's Worker Loader, and also on the Node.js workerd runner (measured
 * 2026-10-01 in production mode: step_budget 8), so "auto" keeps the safe budget in every
 * sandbox. On a Node host the "fast" setting is safe in the sandbox too (that runner enforces
 * only wall time).
 */
export function hostWithoutSubrequestLimit(): boolean {
	const p = (globalThis as { process?: { versions?: { node?: string } } }).process;
	return Boolean(p?.versions?.node);
}
