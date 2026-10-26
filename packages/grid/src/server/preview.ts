import { applyUniqueConflicts, columnMap, displayValue, INFO_WARNING_CODES, normalizeOperations, planBulk, taxonomyOfKey, type Operation, type TermDef, type Warning } from "@realmag777/lynx-engine";
import type { PluginContext } from "emdash";

import { GridReadError, listTerms, matchingEntries } from "./read.ts";

// Bulk-edit preview over every selected entry (up to PREVIEW_CAP), in the grid's native part
// (2026-09-30): the same normalisation and planner the core's job runs, so preview and
// apply agree. Writes nothing; applying stays with the core.

export const PREVIEW_CAP = 500;

export interface PreviewInput {
	collection: string;
	filter?: unknown;
	ids?: string[];
	operations: unknown;
	mode: "draft" | "publish";
}

export async function previewAll(ctx: PluginContext, input: PreviewInput) {
	const raw = Array.isArray(input.operations) ? (input.operations as Operation[]) : [];
	if (!raw.length) throw new GridReadError("BAD_OPERATION", "Add at least one change.");
	const termNames = [...new Set(raw.map((o) => (typeof o?.field === "string" ? taxonomyOfKey(o.field) : null)).filter((x): x is string => Boolean(x)))];
	const terms: Record<string, TermDef[]> = {};
	for (const name of termNames) terms[name] = (await listTerms(ctx, name)).map((t) => ({ id: t.id, taxonomy: name, slug: t.slug, label: t.label, parentId: t.parent, translationGroup: t.group }));
	const { schema, total, entries } = await matchingEntries(ctx, { collection: input.collection, filter: input.filter, ids: input.ids, cap: PREVIEW_CAP, withTerms: termNames });
	const cols = columnMap(schema);
	let ops;
	try {
		ops = normalizeOperations(raw, { columns: cols, terms });
	} catch (err) {
		throw new GridReadError((err as { code?: string }).code ?? "BAD_OPERATION", (err as Error).message);
	}
	// The core's default: republish published entries so caches refresh (its setting; the grid cannot read it).
	const plan = planBulk(schema, entries, ops, { mode: input.mode, cacheRefresh: "republish", terms });
	for (const check of plan.uniqueChecks) {
		if (check.field === "slug" || !check.values.length) continue;
		const taken = new Map<string, string[]>();
		for (let i = 0; i < check.values.length; i += 50) {
			const res = (await ctx.content!.list(schema.slug, { limit: 100, where: { fieldFilters: { [check.field]: { in: check.values.slice(i, i + 50) } } as never } })) as unknown as { items: Array<{ id: string; data: Record<string, unknown> }> };
			for (const it of res.items) taken.set(String(it.data[check.field]), [...(taken.get(String(it.data[check.field])) ?? []), it.id]);
		}
		applyUniqueConflicts(plan, check.field, taken);
	}
	const warnings: Warning[] = [...plan.warnings];
	const filtered = input.ids?.length || (input.filter && typeof input.filter === "object" && Object.keys(input.filter).length > 0);
	if (!filtered) warnings.unshift({ code: "whole_collection", text: `This changes the whole collection: ${total.toLocaleString("en-US")} entries.` });
	if (total > entries.length) warnings.push({ code: "sample_capped", text: `The preview covers the first ${entries.length.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} entries; the job changes all of them.` });
	// Term names as chains ("Mercedes-Benz › A-Class"); a parent listed with its child is folded in.
	const allTerms = Object.values(terms).flat();
	const parentOf = (t: TermDef) => (t.parentId ? allTerms.find((x) => x.id === t.parentId || x.translationGroup === t.parentId) : undefined);
	const chain = (id: string) => {
		const parts: string[] = [];
		let t = allTerms.find((x) => x.id === id);
		for (let guard = 0; t && guard < 10; guard++) {
			parts.unshift(t.label);
			t = parentOf(t);
		}
		return parts.length ? parts.join(" › ") : id;
	};
	const termChain = (v: unknown) => {
		const ids = Array.isArray(v) ? v.map(String) : [];
		const ancestors = new Set<string>();
		for (const id of ids) for (let t = parentOf(allTerms.find((x) => x.id === id)!); t; t = parentOf(t)) ancestors.add(t.id);
		return ids.filter((id) => !ancestors.has(id)).map(chain).join(", ");
	};
	return {
		total,
		checked: entries.length,
		counts: plan.counts,
		mode: plan.mode,
		revisions: plan.revisions,
		rows: plan.entries.map((e) => ({
			id: e.id,
			title: e.title,
			status: e.status,
			state: e.state,
			changes: e.changes.map((c) => {
				const col = cols.get(c.field);
				const isTerms = c.field.startsWith("terms:");
				const names = termChain;
				return {
					field: c.field,
					label: col?.label ?? c.field,
					// Raw values let the grid format numbers like the table (currency, units).
					before: isTerms ? names(c.before) : c.before,
					after: isTerms ? names(c.after) : c.after,
					before_text: isTerms ? names(c.before) : col?.field ? displayValue(col.field, c.before, 120) : c.display.before,
					after_text: isTerms ? names(c.after) : col?.field ? displayValue(col.field, c.after, 120) : c.display.after,
				};
			}),
			...(e.problems.length ? { problems: e.problems.map((p) => p.message) } : {}),
		})),
		warnings: warnings.map((w) => ({ code: w.code, text: w.text, important: !INFO_WARNING_CODES.has(w.code) })),
	};
}

export type PreviewAll = Awaited<ReturnType<typeof previewAll>>;
