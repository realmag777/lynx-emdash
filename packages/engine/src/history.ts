import type { EntryPlan, StatusAction } from "./planner.ts";
import type { Entry } from "./types.ts";
import { valuesEqual } from "./values.ts";

// History = what a job changed, recorded BEFORE each write (BEAR rule 9), plus the
// value written, so rollback can tell whether somebody changed the entry since.

export interface EntrySnapshot {
	data: Record<string, unknown>;
	slug?: string | null;
	terms?: Record<string, string[]>;
	status?: string;
	scheduledAt?: string | null;
	/** created entries: the version after the job's last write, to tell later edits apart. */
	version?: number;
}

export interface HistoryRecord {
	jobKey: string;
	collection: string;
	entryId: string;
	locale: string | null;
	title: string;
	at: string;
	before: EntrySnapshot;
	after: EntrySnapshot;
	statusAction?: StatusAction;
	/** The job published after writing, so rollback publishes the restored values too. */
	published: boolean;
	userId?: string;
	viaMcp: boolean;
	reverted?: string;
	/**
	 * Whole-entry changes. created: the job made this entry (entryId is the new entry; sourceId
	 * the original for duplicates); rollback moves it to the trash. trashed: the job moved it to
	 * the trash; rollback restores it and publishes it again if it was published.
	 */
	lifecycle?: "created" | "trashed";
	sourceId?: string;
}

export interface JobHead {
	jobKey: string;
	collection: string;
	kind: "bulk" | "single" | "rollback";
	fields: string[];
	total: number;
	done: number;
	written: number;
	skipped: number;
	failed: number;
	state: "running" | "completed" | "failed" | "cancelled" | "rolled_back";
	startedAt: string;
	finishedAt?: string;
	userId?: string;
	userName?: string;
	viaMcp: boolean;
	mode: "draft" | "publish";
}

/**
 * Build the history record for one planned entry, using the entry as re-read at apply
 * time (not the preview's copy), so the before-values are what was actually overwritten.
 */
export function historyFor(args: { jobKey: string; collection: string; plan: EntryPlan; current: Entry; at: string; userId?: string; viaMcp: boolean }): HistoryRecord {
	const { plan, current } = args;
	const before: EntrySnapshot = { data: {} };
	const after: EntrySnapshot = { data: {} };
	for (const [k, v] of Object.entries(plan.data)) {
		before.data[k] = current.data[k] ?? null;
		after.data[k] = v;
	}
	if (plan.slug !== undefined) {
		before.slug = current.slug;
		after.slug = plan.slug;
	}
	const taxes = Object.keys(plan.termDelta);
	if (taxes.length) {
		before.terms = {};
		after.terms = {};
		for (const t of taxes) {
			const cur = current.terms?.[t] ?? [];
			const d = plan.termDelta[t]!;
			before.terms[t] = cur;
			after.terms[t] = [...cur.filter((id) => !d.remove.includes(id)), ...d.add.filter((id) => !cur.includes(id))];
		}
	}
	if (plan.statusAction === "trash") {
		before.status = current.status;
		after.status = "trash";
		return {
			jobKey: args.jobKey,
			collection: args.collection,
			entryId: plan.id,
			locale: plan.locale,
			title: plan.title,
			at: args.at,
			before,
			after,
			published: current.status === "published",
			...(args.userId ? { userId: args.userId } : {}),
			viaMcp: args.viaMcp,
			lifecycle: "trashed",
		};
	}
	if (plan.statusAction) {
		before.status = current.status;
		before.scheduledAt = current.scheduledAt ?? null;
		after.status = plan.statusAction === "publish" ? "published" : plan.statusAction === "unpublish" ? "draft" : plan.statusAction === "schedule" ? "scheduled" : "draft";
		after.scheduledAt = plan.statusAction === "schedule" ? (plan.scheduleAt ?? null) : null;
	}
	return {
		jobKey: args.jobKey,
		collection: args.collection,
		entryId: plan.id,
		locale: plan.locale,
		title: plan.title,
		at: args.at,
		before,
		after,
		...(plan.statusAction ? { statusAction: plan.statusAction } : {}),
		published: plan.publishAfterWrite === "publish_mode" || plan.statusAction === "publish",
		...(args.userId ? { userId: args.userId } : {}),
		viaMcp: args.viaMcp,
	};
}

export interface RollbackEntryPlan {
	entryId: string;
	title: string;
	/** Data fields to write back. */
	data: Record<string, unknown>;
	slug?: string | null;
	termDelta: Record<string, { add: string[]; remove: string[] }>;
	statusAction?: StatusAction;
	scheduleAt?: string;
	publishAfterWrite: boolean;
	/** Whole-entry undo: trash an entry the job created, or restore one it trashed. */
	lifecycle?: "trash" | "untrash";
	/** Fields skipped because the entry changed after the job. */
	conflicts: Array<{ field: string; recorded: unknown; current: unknown }>;
	state: "restore" | "nothing" | "conflict" | "missing";
}

/** Conflict "field" for an entry the job created and somebody edited afterwards. */
export const EDITED_SINCE = "(edited since)";

/** Conflict "field" for an entry that now carries unpublished draft edits. */
export const PENDING_DRAFT = "(pending draft)";

/**
 * Plan the rollback of one history record against the entry as it is now.
 * A field is restored only if it still holds the value the job wrote; otherwise it is
 * reported as a conflict and left alone, unless `force` is set.
 */
export function planRollback(rec: HistoryRecord, current: Entry | null, force = false): RollbackEntryPlan {
	const base: RollbackEntryPlan = { entryId: rec.entryId, title: rec.title, data: {}, termDelta: {}, publishAfterWrite: rec.published, conflicts: [], state: "nothing" };
	if (rec.lifecycle === "created") {
		// Already gone (trashed or deleted since): nothing to undo.
		if (!current) return base;
		if (!force && rec.after.version !== undefined && current.version !== undefined && current.version !== rec.after.version) {
			return { ...base, conflicts: [{ field: EDITED_SINCE, recorded: rec.after.version, current: current.version }], state: "conflict" };
		}
		return { ...base, publishAfterWrite: false, lifecycle: "trash", state: "restore" };
	}
	if (rec.lifecycle === "trashed") {
		// `current` is the entry as found in the trash; null when it is no longer there.
		if (!current) return base;
		return { ...base, publishAfterWrite: rec.published, lifecycle: "untrash", state: "restore" };
	}
	if (!current) return { ...base, state: "missing" };

	for (const [k, written] of Object.entries(rec.after.data)) {
		const now = current.data[k] ?? null;
		const prev = rec.before.data[k] ?? null;
		if (valuesEqual(now, prev)) continue;
		if (!force && !valuesEqual(now, written)) {
			base.conflicts.push({ field: k, recorded: written, current: now });
			continue;
		}
		base.data[k] = prev;
	}
	// The slug is written back even when the entry shows the old one: a draft keeps its new slug
	// apart (EmDash _slug) and the entry still shows the live one (2026-10-01).
	if (rec.after.slug !== undefined) {
		if (!force && current.slug !== rec.after.slug && current.slug !== rec.before.slug) base.conflicts.push({ field: "slug", recorded: rec.after.slug, current: current.slug });
		else base.slug = rec.before.slug ?? null;
	}
	for (const [tax, beforeIds] of Object.entries(rec.before.terms ?? {})) {
		const afterIds = rec.after.terms?.[tax] ?? [];
		const nowIds = current.terms?.[tax] ?? [];
		// Undo only what the job did: remove what it added, re-add what it removed.
		const add = beforeIds.filter((id) => !afterIds.includes(id) && !nowIds.includes(id));
		const remove = afterIds.filter((id) => !beforeIds.includes(id) && nowIds.includes(id));
		if (add.length || remove.length) base.termDelta[tax] = { add, remove };
	}
	if (rec.statusAction) {
		const was = rec.before.status;
		if (current.status === rec.after.status || force) {
			if (rec.statusAction === "publish" && was !== "published") base.statusAction = "unpublish";
			else if (rec.statusAction === "unpublish" && was === "published") base.statusAction = "publish";
			else if (rec.statusAction === "schedule") base.statusAction = "unschedule";
			else if (rec.statusAction === "unschedule" && rec.before.scheduledAt && Date.parse(rec.before.scheduledAt) > Date.now()) {
				base.statusAction = "schedule";
				base.scheduleAt = rec.before.scheduledAt;
			}
		} else base.conflicts.push({ field: "status", recorded: rec.after.status, current: current.status });
	}
	const hasWork = Object.keys(base.data).length > 0 || base.slug !== undefined || Object.keys(base.termDelta).length > 0 || base.statusAction !== undefined;
	// Restoring a published write means publishing again, which would also put live any draft
	// edits made in the editor since the job. Hold such entries unless forced.
	if (hasWork && !force && rec.published && current.status === "published" && current.draftRevisionId) {
		const { slug: _slug, statusAction: _action, scheduleAt: _at, ...rest } = base;
		return { ...rest, data: {}, termDelta: {}, conflicts: [...base.conflicts, { field: PENDING_DRAFT, recorded: null, current: current.draftRevisionId }], state: "conflict" };
	}
	return { ...base, state: hasWork ? "restore" : base.conflicts.length ? "conflict" : "nothing" };
}

/** The history record of an entry a job created (written after the create: only then is the id known). */
export function createdRecord(a: { jobKey: string; collection: string; entryId: string; sourceId?: string; locale: string | null; title: string; at: string; data: Record<string, unknown>; terms?: Record<string, string[]>; version?: number; published: boolean; userId?: string; viaMcp: boolean }): HistoryRecord {
	return {
		jobKey: a.jobKey,
		collection: a.collection,
		entryId: a.entryId,
		locale: a.locale,
		title: a.title,
		at: a.at,
		before: { data: {} },
		after: { data: a.data, ...(a.terms && Object.keys(a.terms).length ? { terms: a.terms } : {}), status: a.published ? "published" : "draft", ...(a.version !== undefined ? { version: a.version } : {}) },
		published: a.published,
		...(a.userId ? { userId: a.userId } : {}),
		viaMcp: a.viaMcp,
		lifecycle: "created",
		...(a.sourceId ? { sourceId: a.sourceId } : {}),
	};
}
