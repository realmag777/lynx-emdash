import {
	applyUniqueConflicts,
	columnMap,
	normalizeOperations,
	planBulk,
	taxonomyOfKey,
	usesRevisions,
	shapeStep,
	worstStepCost,
	type Operation,
	type Plan,
	type SaveMode,
	type Warning,
} from "@realmag777/lynx-engine";

import { content, loadTerms, type HostItem } from "./host.ts";
import type { Meter } from "./meter.ts";
import { readSelection } from "./selections.ts";
import type { SelectionDoc } from "./store.ts";

export interface PreviewArgs {
	selection: SelectionDoc;
	operations: unknown;
	mode: SaveMode;
	cacheRefresh: "republish" | "none";
	limit: number;
	budget: number;
}

export interface PreviewResult {
	plan: Plan;
	sampleSize: number;
	warnings: Warning[];
	stepsEstimate: number;
	entriesPerStep: number;
}

/**
 * Dry run on a sample: the same normalisation and planner the job runs, so preview and
 * apply cannot disagree. Writes nothing.
 */
export async function previewBulk(m: Meter, a: PreviewArgs): Promise<PreviewResult> {
	const sel = a.selection;
	const raw = Array.isArray(a.operations) ? (a.operations as Operation[]) : a.operations && typeof a.operations === "object" ? [a.operations as Operation] : [];
	const termNames = [...new Set(raw.map((o) => (typeof o?.field === "string" ? taxonomyOfKey(o.field) : null)).filter((x): x is string => Boolean(x)))];
	const terms = termNames.length ? await loadTerms(m.ctx, termNames) : {};
	const ops = normalizeOperations(raw, { columns: columnMap(sel.schema), terms });
	const revisions = usesRevisions(sel.schema);

	// Keep one call for the uniqueness check when unique fields change.
	const unique = ops.some((o) => o.column.unique && o.column.key !== "slug");
	// Entries whose terms did not fit the budget are left out of the sample (no terms is not "none").
	const entries = (await readSelection(m.reserving(unique ? 1 : 0), sel, 0, a.limit, termNames)).filter((e) => !termNames.length || e.terms);

	const plan = planBulk(sel.schema, entries, ops, { mode: a.mode, cacheRefresh: a.cacheRefresh, terms });
	for (const check of plan.uniqueChecks) {
		if (check.field === "slug" || !check.values.length || !m.has(1)) continue;
		const res = (await content(m.ctx).list(sel.collection, { limit: 100, where: { fieldFilters: { [check.field]: { in: check.values.slice(0, 50) } } as never } })) as unknown as { items: HostItem[] };
		const taken = new Map<string, string[]>();
		for (const it of res.items) taken.set(String(it.data[check.field]), [...(taken.get(String(it.data[check.field])) ?? []), it.id]);
		applyUniqueConflicts(plan, check.field, taken);
	}

	const taxonomyCount = sel.schema.taxonomies?.filter((t) => t.collections.includes(sel.collection)).length ?? 0;
	const k = shapeStep(worstStepCost(ops, { mode: a.mode, revisions, cacheRefresh: a.cacheRefresh, taxonomies: taxonomyCount }), a.budget, unique ? 1 : 0).k;
	const warnings: Warning[] = [...plan.warnings];
	if (sel.wholeCollection) {
		warnings.unshift({ code: "whole_collection", text: `The selection is the whole ${sel.collection} collection (${sel.count} entries): the filter narrowed nothing. Say so to the user before applying.` });
	}
	if (entries.length < Math.min(a.limit, sel.count)) {
		warnings.push({ code: "sample_short", text: `Only ${entries.length} of the requested sample could be read in this call; the preview covers those. The job itself reads every entry.` });
	}
	return { plan, sampleSize: entries.length, warnings, stepsEstimate: Math.ceil(sel.count / k), entriesPerStep: k };
}
