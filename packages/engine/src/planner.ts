import { applyToValue, withAncestors, type NormalizedOperation, type OpNote, type SkipReason } from "./operations.ts";
import { taxonomyOfKey, type Column } from "./schema.ts";
import type { CollectionDef, Entry, TermDef } from "./types.ts";
import { usesRevisions } from "./types.ts";
import { validateValue, type ValidationProblem } from "./validate.ts";
import { coerceValue, displayValue, fromStored, valuesEqual } from "./values.ts";

export type SaveMode = "draft" | "publish";
export type CacheRefresh = "republish" | "none";
export type StatusAction = "publish" | "unpublish" | "schedule" | "unschedule" | "trash";

export interface Change {
	field: string;
	before: unknown;
	after: unknown;
	/** Short readable forms for previews and tables. */
	display: { before: string; after: string };
}

export interface TermDelta {
	add: string[];
	remove: string[];
}

/**
 * "held": a live entry that already carries unpublished draft edits (made in the editor). The
 * host can only publish the whole draft, so a publish-mode write would put those edits live
 * too; such entries are left untouched.
 */
export type EntryState = "change" | "unchanged" | "invalid" | "held";

export interface EntryPlan {
	id: string;
	title: string;
	locale: string | null;
	status: string;
	state: EntryState;
	changes: Change[];
	/** Data fields to write (only changed ones). */
	data: Record<string, unknown>;
	/** New system slug, when it changes. */
	slug?: string;
	termDelta: Record<string, TermDelta>;
	statusAction?: StatusAction;
	scheduleAt?: string;
	/** After writing data, publish the entry (save-and-publish on revisions, or cache refresh). */
	publishAfterWrite?: "publish_mode" | "cache_refresh";
	/** duplicate: the draft copy to create (the source entry itself is not written). */
	create?: { data: Record<string, unknown>; terms: Record<string, string[]>; title: string };
	/** The entry carries unpublished draft edits (revisions collections). */
	onPendingDraft?: boolean;
	/** Non-translatable fields that changed: the other locales of the group must get the same values. */
	syncFields: string[];
	skipped: Array<{ field: string; reason: SkipReason | "already_in_state" }>;
	problems: ValidationProblem[];
	notes: Array<{ field: string; note: OpNote }>;
}

/**
 * Warnings that only inform (how to undo, how the sample was taken, that copies are drafts…).
 * The others change what a job will do (held entries, drafts, invalid entries, replaced terms)
 * and are shown prominently.
 */
export const INFO_WARNING_CODES: ReadonlySet<string> = new Set(["percent_not_reversible", "sample_short", "sample_capped", "saved_as_draft", "copies_are_drafts", "cache_refresh_republish", "status_already_set"]);

export interface Warning {
	code: string;
	text: string;
	count?: number;
	ids?: string[];
}

export interface Plan {
	collection: string;
	mode: SaveMode;
	revisions: boolean;
	fields: string[];
	entries: EntryPlan[];
	counts: { total: number; change: number; unchanged: number; invalid: number; held: number };
	warnings: Warning[];
	/** Values of unique fields the caller must check against the rest of the collection. */
	uniqueChecks: Array<{ field: string; locale: string | null; values: string[] }>;
}

export interface PlanOptions {
	mode?: SaveMode;
	cacheRefresh?: CacheRefresh;
	terms?: Record<string, TermDef[]>;
	/** How many example ids a warning lists. */
	exampleIds?: number;
}

function entryTitle(collection: CollectionDef, entry: Entry): string {
	const key = collection.titleField ?? (collection.fields.some((f) => f.slug === "title") ? "title" : null);
	const v = key ? entry.data[key] : undefined;
	return typeof v === "string" && v ? v : (entry.slug ?? entry.id);
}

function readValue(entry: Entry, working: Record<string, unknown>, col: Column): unknown {
	if (col.key in working) return working[col.key];
	if (col.kind === "system") {
		switch (col.key) {
			case "slug":
				return entry.slug;
			case "status":
				return entry.status;
			case "locale":
				return entry.locale;
			case "id":
				return entry.id;
			case "created_at":
				return entry.createdAt ?? null;
			case "updated_at":
				return entry.updatedAt ?? null;
			case "published_at":
				return entry.publishedAt ?? null;
			case "scheduled_at":
				return entry.scheduledAt ?? null;
		}
	}
	return col.field ? fromStored(col.field, entry.data[col.key]) : entry.data[col.key];
}

function termLabels(ids: string[], terms: TermDef[] | undefined): string {
	return ids.map((id) => terms?.find((t) => t.id === id)?.label ?? id).join(", ");
}

/**
 * Build a deterministic change plan. Operations run in list order on the values the
 * previous ones leave, exactly as the job runner will apply them; preview and apply
 * both call this function, so they cannot disagree.
 */
export function planBulk(collection: CollectionDef, entries: Entry[], operations: NormalizedOperation[], options: PlanOptions = {}): Plan {
	const mode: SaveMode = options.mode ?? "draft";
	const revisions = usesRevisions(collection);
	const cacheRefresh: CacheRefresh = options.cacheRefresh ?? "republish";
	const exampleIds = options.exampleIds ?? 20;

	const plans: EntryPlan[] = entries.map((entry) => {
		const working: Record<string, unknown> = {};
		const termsNow: Record<string, string[]> = {};
		const skipped: EntryPlan["skipped"] = [];
		const notes: EntryPlan["notes"] = [];
		let statusAction: StatusAction | undefined;
		let scheduleAt: string | undefined;

		for (const op of operations) {
			const col = op.column;
			const tax = taxonomyOfKey(col.key);
			if (tax) {
				const current = termsNow[tax] ?? entry.terms?.[tax] ?? [];
				const all = options.terms?.[tax] ?? [];
				let add = op.termIds ?? [];
				if (op.behavior !== "remove_terms" && op.withParents !== false && col.taxonomy?.hierarchical) add = withAncestors(add, all);
				let next: string[];
				if (op.behavior === "add_terms") next = [...current, ...add.filter((id) => !current.includes(id))];
				else if (op.behavior === "remove_terms") next = current.filter((id) => !(op.termIds ?? []).includes(id));
				else next = [...add];
				termsNow[tax] = next;
				continue;
			}
			if (col.key === "entry") {
				if (op.behavior === "trash") statusAction = "trash";
				continue;
			}
			if (col.key === "status") {
				const isScheduled = entry.status === "scheduled" || Boolean(entry.scheduledAt);
				if (op.behavior === "publish") statusAction = "publish";
				else if (op.behavior === "unpublish") statusAction = entry.status === "published" || statusAction === "publish" ? "unpublish" : undefined;
				else if (op.behavior === "schedule") {
					statusAction = "schedule";
					scheduleAt = op.value as string;
				} else if (op.behavior === "unschedule") statusAction = isScheduled || statusAction === "schedule" ? "unschedule" : undefined;
				if (!statusAction) skipped.push({ field: "status", reason: "already_in_state" });
				continue;
			}
			const current = readValue(entry, working, col);
			const sourceValue = op.sourceColumn ? readValue(entry, working, op.sourceColumn) : undefined;
			const outcome = applyToValue(op, current, sourceValue);
			if (outcome.kind === "skip") {
				skipped.push({ field: col.key, reason: outcome.reason });
				continue;
			}
			working[col.key] = outcome.value;
			for (const n of outcome.notes ?? []) notes.push({ field: col.key, note: n });
		}

		// Collect changes against the stored values.
		const changes: Change[] = [];
		const data: Record<string, unknown> = {};
		const problems: ValidationProblem[] = [];
		const syncFields: string[] = [];
		let slug: string | undefined;
		const cols = new Map(operations.map((o) => [o.column.key, o.column]));

		for (const [key, after] of Object.entries(working)) {
			const col = cols.get(key)!;
			const before = readValue(entry, {}, col);
			if (valuesEqual(before, after)) continue;
			if (col.kind === "system" && key === "slug") {
				const s = typeof after === "string" ? after : "";
				if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s)) problems.push({ field: "slug", rule: "pattern", message: `Slug "${s}" must use lowercase letters, digits and single hyphens` });
				slug = s;
				changes.push({ field: key, before, after, display: { before: String(before ?? ""), after: s } });
				continue;
			}
			const field = col.field!;
			// Re-check the shape (e.g. a URL after replace must still be a URL).
			const shaped = coerceValue(field, after);
			if (!shaped.ok) problems.push({ field: key, rule: "pattern", message: shaped.reason });
			problems.push(...validateValue(field, shaped.ok ? shaped.value : after));
			data[key] = shaped.ok ? shaped.value : after;
			if (field.translatable === false) syncFields.push(key);
			changes.push({ field: key, before, after: data[key], display: { before: displayValue(field, before), after: displayValue(field, data[key]) } });
		}

		const termDelta: Record<string, TermDelta> = {};
		for (const [tax, next] of Object.entries(termsNow)) {
			const before = entry.terms?.[tax] ?? [];
			const add = next.filter((id) => !before.includes(id));
			const remove = before.filter((id) => !next.includes(id));
			if (add.length === 0 && remove.length === 0) continue;
			termDelta[tax] = { add, remove };
			const all = options.terms?.[tax];
			changes.push({ field: `terms:${tax}`, before, after: next, display: { before: termLabels(before, all), after: termLabels(next, all) } });
		}

		if (statusAction === "publish" && entry.status === "published" && Object.keys(data).length === 0 && slug === undefined) {
			// Nothing pending to publish unless the entry carries a draft revision; the job re-checks.
			if (!entry.draftRevisionId) {
				statusAction = undefined;
				skipped.push({ field: "status", reason: "already_in_state" });
			}
		}
		if (statusAction) {
			changes.push({
				field: "status",
				before: entry.status,
				after: statusAction === "trash" ? "trash" : statusAction === "schedule" ? `scheduled ${scheduleAt}` : statusAction === "publish" ? "published" : statusAction === "unpublish" ? "draft" : entry.status === "scheduled" ? "draft" : entry.status,
				display: { before: entry.status, after: statusAction === "trash" ? "moved to the trash" : statusAction === "schedule" ? `scheduled for ${scheduleAt}` : statusAction === "publish" ? "published" : statusAction === "unpublish" ? "draft" : "not scheduled" },
			});
		}

		const hasWrites = Object.keys(data).length > 0 || slug !== undefined;
		let publishAfterWrite: EntryPlan["publishAfterWrite"];
		if (hasWrites && !statusAction && entry.status === "published") {
			if (revisions && mode === "publish") publishAfterWrite = "publish_mode";
			else if (!revisions && cacheRefresh === "republish") publishAfterWrite = "cache_refresh";
		}

		if (operations[0]?.behavior === "duplicate") return planCopy(collection, entry, { data, termsNow, changes, problems, skipped, notes });

		let state: EntryState = problems.length ? "invalid" : changes.length ? "change" : "unchanged";
		if (state === "change" && publishAfterWrite === "publish_mode" && entry.draftRevisionId) state = "held";
		return {
			id: entry.id,
			title: entryTitle(collection, entry),
			locale: entry.locale,
			status: entry.status,
			state,
			changes,
			data,
			...(slug !== undefined ? { slug } : {}),
			termDelta,
			...(statusAction ? { statusAction } : {}),
			...(scheduleAt ? { scheduleAt } : {}),
			...(publishAfterWrite ? { publishAfterWrite } : {}),
			...(revisions && entry.status === "published" && entry.draftRevisionId ? { onPendingDraft: true } : {}),
			syncFields,
			skipped,
			problems,
			notes,
		};
	});

	// Uniqueness inside the plan, and the values the caller checks against the collection.
	const uniqueChecks: Plan["uniqueChecks"] = [];
	const uniqueFields = operations.map((o) => o.column).filter((c, i, a) => c.unique && a.findIndex((x) => x.key === c.key) === i);
	for (const col of uniqueFields) {
		const byLocale = new Map<string, Map<string, EntryPlan[]>>();
		for (const p of plans) {
			if (p.state !== "change") continue;
			const v = col.key === "slug" ? p.slug : p.create ? p.create.data[col.key] : p.data[col.key];
			if (v === undefined || v === null || v === "") continue;
			const loc = col.key === "slug" ? (p.locale ?? "") : "";
			const m = byLocale.get(loc) ?? new Map<string, EntryPlan[]>();
			const list = m.get(String(v)) ?? [];
			list.push(p);
			m.set(String(v), list);
			byLocale.set(loc, m);
		}
		for (const [loc, m] of byLocale) {
			for (const [value, list] of m) {
				if (list.length > 1) {
					for (const p of list) {
						p.state = "invalid";
						p.problems.push({ field: col.key, rule: "unique", message: `${col.label} "${value}" would be given to ${list.length} entries of this selection; it must be unique` });
					}
				}
			}
			const values = [...m.entries()].filter(([, list]) => list.length === 1).map(([v]) => v);
			if (values.length) uniqueChecks.push({ field: col.key, locale: col.key === "slug" ? loc || null : null, values });
		}
	}

	const counts = {
		total: plans.length,
		change: plans.filter((p) => p.state === "change").length,
		unchanged: plans.filter((p) => p.state === "unchanged").length,
		invalid: plans.filter((p) => p.state === "invalid").length,
		held: plans.filter((p) => p.state === "held").length,
	};

	const plan: Plan = {
		collection: collection.slug,
		mode,
		revisions,
		fields: [...new Set(operations.map((o) => o.column.key))],
		entries: plans,
		counts,
		warnings: [],
		uniqueChecks,
	};
	plan.warnings = buildWarnings(plan, operations, { cacheRefresh, exampleIds });
	return plan;
}

/**
 * duplicate: the draft copy of one entry. It starts from the stored values, takes the values
 * the other operations computed, gets " (Copy)" on its title unless an operation set the title,
 * and leaves unique fields empty (a required unique field makes the entry invalid instead).
 * Terms are copied as they will be after the operations. EmDash makes the slug.
 */
function planCopy(
	collection: CollectionDef,
	entry: Entry,
	w: { data: Record<string, unknown>; termsNow: Record<string, string[]>; changes: Change[]; problems: ValidationProblem[]; skipped: EntryPlan["skipped"]; notes: EntryPlan["notes"] },
): EntryPlan {
	const sourceTitle = entryTitle(collection, entry);
	const titleKey = collection.titleField ?? (collection.fields.some((f) => f.slug === "title") ? "title" : null);
	const copy: Record<string, unknown> = {};
	for (const f of collection.fields) {
		const v = f.slug in w.data ? w.data[f.slug] : fromStored(f, entry.data[f.slug]);
		if (v !== undefined && v !== null) copy[f.slug] = v;
	}
	if (titleKey && !(titleKey in w.data) && typeof copy[titleKey] === "string") copy[titleKey] = `${copy[titleKey] as string} (Copy)`;
	const cleared: string[] = [];
	for (const f of collection.fields) {
		if (!f.unique || f.slug in w.data || copy[f.slug] === undefined) continue;
		if (f.required) {
			w.problems.push({ field: f.slug, rule: "unique", message: `${f.label} "${String(copy[f.slug])}" would repeat on the copy and must be unique: set a new value in this job, or copy with get_entries and create_entries` });
		} else {
			delete copy[f.slug];
			cleared.push(f.slug);
		}
	}
	const terms: Record<string, string[]> = {};
	for (const t of collection.taxonomies ?? []) {
		const ids = w.termsNow[t.name] ?? entry.terms?.[t.name] ?? [];
		if (ids.length) terms[t.name] = ids;
	}
	const title = titleKey && typeof copy[titleKey] === "string" ? (copy[titleKey] as string) : `${sourceTitle} (Copy)`;
	const changes: Change[] = [
		{ field: "entry", before: sourceTitle, after: title, display: { before: sourceTitle, after: `new draft "${title}"${cleared.length ? ` (${cleared.join(", ")} left empty)` : ""}` } },
		...w.changes.filter((c) => !c.field.startsWith("terms:")),
	];
	return {
		id: entry.id,
		title: sourceTitle,
		locale: entry.locale,
		status: entry.status,
		state: w.problems.length ? "invalid" : "change",
		changes,
		data: {},
		termDelta: {},
		create: { data: copy, terms, title },
		syncFields: [],
		skipped: w.skipped,
		problems: w.problems,
		notes: w.notes,
	};
}

/** Mark entries whose unique values already belong to other entries. `taken` maps value → ids holding it. */
export function applyUniqueConflicts(plan: Plan, field: string, taken: Map<string, string[]>): Plan {
	let conflicts = 0;
	for (const p of plan.entries) {
		if (p.state !== "change") continue;
		const v = field === "slug" ? p.slug : p.data[field];
		if (v === undefined || v === null) continue;
		const holders = (taken.get(String(v)) ?? []).filter((id) => id !== p.id);
		if (holders.length) {
			p.state = "invalid";
			p.problems.push({ field, rule: "unique", message: `${field} "${String(v)}" is already used by ${holders.join(", ")}` });
			conflicts++;
		}
	}
	if (conflicts) {
		plan.counts.change -= conflicts;
		plan.counts.invalid += conflicts;
		plan.warnings = plan.warnings.filter((w) => w.code !== "invalid_entries");
		plan.warnings.push(invalidWarning(plan, 20));
	}
	return plan;
}

function invalidWarning(plan: Plan, exampleIds: number): Warning {
	const bad = plan.entries.filter((p) => p.state === "invalid");
	const examples = bad
		.slice(0, 3)
		.map((p) => `${p.title} (${p.id}): ${p.problems.map((x) => x.message).join("; ")}`)
		.join(" | ");
	return {
		code: "invalid_entries",
		count: bad.length,
		ids: bad.slice(0, exampleIds).map((p) => p.id),
		text: `${bad.length} entr${bad.length === 1 ? "y fails" : "ies fail"} the field rules and will be skipped - nothing is written to them. ${examples}`,
	};
}

function buildWarnings(plan: Plan, operations: NormalizedOperation[], o: { cacheRefresh: CacheRefresh; exampleIds: number }): Warning[] {
	const w: Warning[] = [];
	const ids = (list: EntryPlan[]) => list.slice(0, o.exampleIds).map((p) => p.id);
	const skippedFor = (reason: string) => plan.entries.filter((p) => p.skipped.some((s) => s.reason === reason));

	if (operations.some((op) => op.behavior === "increase_percent" || op.behavior === "decrease_percent" || op.behavior === "multiply")) {
		w.push({
			code: "percent_not_reversible",
			text: 'If these values are wanted back later, undo the job with rollback - it restores the exact previous figures entry by entry. Applying the opposite percentage does NOT restore them: "up 20% then down 20%" turns 1000 into 960, because the second percentage is taken from the new value.',
		});
	}
	const empty = skippedFor("empty_value");
	if (empty.length) {
		const fields = [...new Set(empty.flatMap((p) => p.skipped.filter((s) => s.reason === "empty_value").map((s) => s.field)))];
		w.push({
			code: "percent_on_empty_field",
			count: empty.length,
			ids: ids(empty),
			text: `${empty.length} of the selected entries have no value in ${fields.join(", ")}. A calculation on an empty value would write 0 (and 0 is a real price), so those entries are left as they are for that change.`,
		});
	}
	const noMatch = skippedFor("no_match");
	if (noMatch.length) {
		w.push({ code: "pattern_no_match", count: noMatch.length, ids: ids(noMatch), text: `The text or option to replace was not found in ${noMatch.length} entr${noMatch.length === 1 ? "y" : "ies"}; they stay unchanged for that change.` });
	}
	const srcEmpty = skippedFor("source_empty");
	if (srcEmpty.length) {
		w.push({ code: "source_empty", count: srcEmpty.length, ids: ids(srcEmpty), text: `The source field is empty on ${srcEmpty.length} entr${srcEmpty.length === 1 ? "y" : "ies"}, so nothing is copied there.` });
	}
	const already = skippedFor("already_in_state");
	if (already.length) {
		w.push({ code: "status_already_set", count: already.length, ids: ids(already), text: `${already.length} entr${already.length === 1 ? "y is" : "ies are"} already in the requested publication state and will not be touched for status.` });
	}
	const rounded = plan.entries.filter((p) => p.notes.some((n) => n.note === "integer_rounded"));
	if (rounded.length) {
		w.push({ code: "integer_rounded", count: rounded.length, ids: ids(rounded), text: `${rounded.length} result${rounded.length === 1 ? " is" : "s are"} not whole numbers and will be rounded, because the field takes whole numbers only.` });
	}
	const crossed = plan.entries.filter((p) => p.notes.some((n) => n.note === "marks_crossed"));
	if (crossed.length) {
		w.push({ code: "marks_crossed", count: crossed.length, ids: ids(crossed), text: `In ${crossed.length} entr${crossed.length === 1 ? "y" : "ies"} the found text spans different formatting (bold, link…); the replacement takes the formatting of where the match starts.` });
	}
	if (operations.some((op) => op.behavior === "set_terms")) {
		w.push({ code: "set_terms_replaces", text: "set_terms REPLACES every term of that taxonomy on each entry; terms not in the list are removed. Use add_terms to keep what is there." });
	}
	const writes = plan.entries.filter((p) => p.state === "change" && (Object.keys(p.data).length > 0 || p.slug !== undefined));
	if (plan.revisions && writes.length) {
		if (plan.mode === "draft") {
			w.push({ code: "saved_as_draft", count: writes.length, text: `This collection keeps revisions: the ${writes.length} changed entr${writes.length === 1 ? "y is" : "ies are"} saved as drafts and the live site does not change until they are published. Use mode "publish" to publish the changes of entries that are already live.` });
		} else {
			const live = writes.filter((p) => p.publishAfterWrite === "publish_mode");
			const drafts = writes.length - live.length;
			w.push({
				code: "publish_mode",
				count: live.length,
				text: `The changes of ${live.length} live entr${live.length === 1 ? "y are" : "ies are"} published immediately.${drafts ? ` ${drafts} entr${drafts === 1 ? "y that is not live stays a draft" : "ies that are not live stay drafts"}.` : ""}`,
			});
		}
	}
	const held = plan.entries.filter((p) => p.state === "held");
	if (held.length) {
		w.push({
			code: "pending_drafts",
			count: held.length,
			ids: ids(held),
			text: `${held.length} live entr${held.length === 1 ? "y has" : "ies have"} unpublished draft edits made in the editor. Publishing this change would put those edits live as well, so these entries are left untouched. Publish those drafts first (apply_bulk with the status behavior publish publishes them as they are) or discard them in the editor, or run the change with mode "draft" to edit the drafts.`,
		});
	}
	const onDrafts = plan.mode === "draft" ? plan.entries.filter((p) => p.state === "change" && p.status === "published" && plan.revisions && p.onPendingDraft) : [];
	if (onDrafts.length) {
		w.push({
			code: "on_pending_drafts",
			count: onDrafts.length,
			ids: ids(onDrafts),
			text: `${onDrafts.length} entr${onDrafts.length === 1 ? "y already has" : "ies already have"} unpublished draft edits; the change is applied on top of those drafts. The before-values shown here are the live ones, so the job may start from different figures on these entries.`,
		});
	}
	const copies = plan.entries.filter((p) => p.state === "change" && p.create);
	if (copies.length) {
		w.push({
			code: "copies_are_drafts",
			count: copies.length,
			text: `${copies.length} draft cop${copies.length === 1 ? "y is" : "ies are"} created; the originals do not change. Titles get " (Copy)" unless an operation sets them, EmDash makes new slugs, and unique fields that are not required stay empty on the copies. rollback_bulk moves the copies to the trash.`,
		});
	}
	const trashed = plan.entries.filter((p) => p.state === "change" && p.statusAction === "trash");
	if (trashed.length) {
		const live = trashed.filter((p) => p.status === "published").length;
		w.push({
			code: "to_trash",
			count: trashed.length,
			text: `${trashed.length} entr${trashed.length === 1 ? "y moves" : "ies move"} to the trash${live ? `; ${live} of them are live and go offline` : ""}. rollback_bulk brings them back and publishes again those that were published (EmDash's own restore brings entries back as drafts).`,
		});
	}
	const refresh = plan.entries.filter((p) => p.publishAfterWrite === "cache_refresh");
	if (refresh.length) {
		w.push({
			code: "cache_refresh_republish",
			count: refresh.length,
			text: `${refresh.length} published entr${refresh.length === 1 ? "y is" : "ies are"} re-published after writing so cached pages show the new values. Re-publishing keeps the publication date, but other plugins that react to publishing (webhooks, notifications) will run for each of them.`,
		});
	}
	const sync = plan.entries.filter((p) => p.state === "change" && p.syncFields.length);
	if (sync.length) {
		const label = new Map(operations.map((op) => [op.column.key, op.column.label]));
		const fields = [...new Set(sync.flatMap((p) => p.syncFields))].map((f) => label.get(f) ?? f);
		w.push({ code: "translation_sync", count: sync.length, text: `${fields.join(", ")} ${fields.length === 1 ? "is" : "are"} shared by all translations: the new value${fields.length === 1 ? " also applies" : "s also apply"} to the other language versions of these entries.` });
	}
	if (plan.counts.invalid) w.push(invalidWarning(plan, o.exampleIds));
	return w;
}
