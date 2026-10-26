import {
	describeOperations,
	entriesText,
	type DescribeOptions,
	applyUniqueConflicts,
	checkConfirmCount,
	columnMap,
	historyFor,
	newJobKey,
	normalizeOperations,
	EDITED_SINCE,
	PENDING_DRAFT,
	planBulk,
	planRollback,
	SAFE_STEP_BUDGET,
	taxonomyOfKey,
	usesRevisions,
	shapeStep,
	splitTermUnits,
	termUnits,
	worstStepCost,
	type StepShape,
	type TermUnit,
	type Entry,
	type EntryPlan,
	type NewRowPlan,
	type HistoryRecord,
	type NormalizedOperation,
	type Operation,
	type Plan,
	type SaveMode,
	type TermDef,
	type Warning,
} from "@realmag777/lynx-engine";

import { applyTermUnits, createEntry, createRows, pendingDocs, saveCreateStep, splitTerms } from "./create.ts";
import { LynxError } from "./errors.ts";
import { content, loadEntryTerms, loadTerms, revAfterUpdate, taxonomies, toEntry, type Ctx, type HostItem } from "./host.ts";
import type { Meter } from "./meter.ts";
import { selectionIds } from "./selections.ts";
import { PAGE_SIZE, pageId, stores, type HistoryDoc, type JobDoc, type JobResult, type SelectionDoc, type WindowItem } from "./store.ts";

// Job runner. One step = one atomic claim + one history
// putMany + the entries' own calls. History is written before the content writes.

const LOST_AFTER_MS = 60_000;

export const CRON_TASK = "lynx-jobs";

/**
 * Make sure the background task exists: it advances running jobs one step a minute, so a
 * job left by an agent or a closed browser tab still finishes. `plugin:activate` only runs
 * on registry installs and on enable, not for plugins listed in astro.config, so cheap entry points call this too. One call, two when missing.
 */
export async function ensureCron(ctx: Ctx): Promise<void> {
	if (!ctx.cron) return;
	try {
		const tasks = await ctx.cron.list();
		if (!tasks.some((t) => t.name === CRON_TASK)) await ctx.cron.schedule(CRON_TASK, { schedule: "* * * * *" });
	} catch {
		// Never let housekeeping break the answer; job_status and the admin page still step jobs.
	}
}

export interface Actor {
	userId?: string;
	userName?: string;
	viaMcp: boolean;
}

export interface StepOutcome {
	phase: "entries" | "refill" | "finishing" | "terms" | "finished" | "recovered" | "not_running";
	processed: number;
	written: number;
	unchanged: number;
	invalid: number;
	held: number;
	failed: number;
	conflicts: number;
	calls: number;
	/** Term chunks this step left for pending-terms steps. */
	pending?: number;
	/** Steps summed into this outcome (job_status loops on hosts without limits). */
	steps?: number;
	failures?: Array<{ id: string; stage: string; message: string }>;
}

const windowSizeFor = (budget: number, k: number) => Math.max(budget > SAFE_STEP_BUDGET ? 500 : 100, k);

/** Jobs whose steps create entries or files: history is written after the writes (create.ts). */
export function createsThings(job: Pick<JobDoc, "kind" | "spec">): boolean {
	return job.kind === "create" || (job.kind === "bulk" && job.spec.operations[0]?.behavior === "duplicate");
}

function termNamesOf(ops: Operation[]): string[] {
	return [...new Set(ops.map((o) => taxonomyOfKey(o.field)).filter((x): x is string => Boolean(x)))];
}

/** Normalise a job's operations against its stored schema snapshot (no bridge calls). */
function normalized(job: JobDoc, ops: Operation[]): NormalizedOperation[] {
	return normalizeOperations(ops, { columns: columnMap(job.spec.schema), terms: job.spec.terms });
}

function guardTranslations(sel: Pick<SelectionDoc, "translations">, revisions: boolean, ops: NormalizedOperation[]): void {
	if (revisions || !sel.translations) return;
	const shared = ops.filter((o) => o.column.field && o.column.field.translatable === false).map((o) => o.column.key);
	if (shared.length) {
		throw new LynxError(
			"TRANSLATION_SYNC_UNSUPPORTED",
			`${shared.join(", ")} ${shared.length === 1 ? "is" : "are"} shared by all language versions, and this collection keeps no revisions, so EmDash would not copy the new value to the other languages. LYNX does not edit shared fields of translated entries on such collections yet. Edit them per language in the entry editor, or ask the site owner to enable revisions for this collection.`,
		);
	}
}

// ---------------------------------------------------------------------------
// Creating jobs

export interface BulkJobArgs {
	selection: SelectionDoc;
	operations: unknown;
	confirmCount: unknown;
	mode: SaveMode;
	cacheRefresh: "republish" | "none";
	budget: number;
	actor: Actor;
	now?: Date;
}

export async function createBulkJob(m: Meter, a: BulkJobArgs): Promise<{ job: JobDoc; ops: NormalizedOperation[] }> {
	const sel = a.selection;
	checkConfirmCount(sel, a.confirmCount);
	const raw = Array.isArray(a.operations) ? (a.operations as Operation[]) : a.operations && typeof a.operations === "object" ? [a.operations as Operation] : [];
	const termNames = termNamesOf(raw);
	const terms = termNames.length ? await loadTerms(m.ctx, termNames) : {};
	const ops = normalizeOperations(raw, { columns: columnMap(sel.schema), terms });
	const revisions = usesRevisions(sel.schema);
	guardTranslations(sel, revisions, ops);
	const unique = ops.some((o) => o.column.unique && o.column.key !== "slug");
	const taxonomyCount = sel.schema.taxonomies?.filter((t) => t.collections.includes(sel.collection)).length ?? 0;
	const shape = shapeStep(worstStepCost(ops, { mode: a.mode, revisions, cacheRefresh: a.cacheRefresh, taxonomies: taxonomyCount }), a.budget, unique ? 1 : 0);
	const W = windowSizeFor(a.budget, shape.k);
	const firstIds = (await selectionIds(m, sel, 0)).slice(0, W);
	const job = await saveJob(m, a.actor, a.now, {
		kind: "bulk",
		collection: sel.collection,
		total: sel.count,
		fields: [...new Set(ops.map((o) => o.column.key))],
		summary: `${describeOperations(ops.map((o) => ({ op: o, column: o.column })), labelsFor(sel.schema, terms))} · ${entriesText(sel.count)}${sel.wholeCollection ? "" : ` (${sel.summary})`}`,
		selectionId: sel.id,
		...shapeFields(shape),
		budget: a.budget,
		windowSize: W,
		window: firstIds,
		spec: { schema: sel.schema, operations: ops.map(stripColumn), terms, mode: a.mode, cacheRefresh: a.cacheRefresh },
	});
	return { job, ops };
}

/** Calls to create one new entry: the create and the publish when asked, then one term write per taxonomy. */
export function createRowShape(rows: Pick<NewRowPlan, "terms" | "publish">[], budget: number): StepShape {
	const base = 1 + (rows.some((r) => r.publish) ? 1 : 0);
	const terms = Math.max(0, ...rows.map((r) => Object.values(r.terms).filter((ids) => ids.length).length));
	return shapeStep({ base, terms }, budget);
}

/** Field and term labels for job summaries (what people read in the history). */
function labelsFor(schema: SelectionDoc["schema"], terms: Record<string, Array<{ id: string; label: string }>>): DescribeOptions {
	const cols = columnMap(schema);
	const byId = new Map(Object.values(terms).flat().map((t) => [t.id, t.label]));
	return { termLabel: (id) => byId.get(id) ?? id, fieldLabel: (k) => cols.get(k)?.label ?? k };
}

/** create_entries: a job over validated rows (at most 50); window items are row indexes. */
export async function createCreateJob(m: Meter, a: { schema: SelectionDoc["schema"]; rows: NewRowPlan[]; budget: number; actor: Actor; now?: Date }): Promise<JobDoc> {
	if (!a.rows.length) throw new LynxError("NOTHING_TO_CREATE", "No row is valid, so nothing would be created. Fix the rows the dry run reported and call again.");
	const shape = createRowShape(a.rows, a.budget);
	const job = await saveJob(m, a.actor, a.now, {
		kind: "create",
		collection: a.schema.slug,
		total: a.rows.length,
		fields: [...new Set(a.rows.flatMap((r) => [...Object.keys(r.data), ...Object.keys(r.terms).map((t) => `terms:${t}`)]))],
		summary: `Created ${entriesText(a.rows.length)}`,
		...shapeFields(shape),
		budget: a.budget,
		windowSize: a.rows.length,
		window: a.rows.map((_, i) => String(i)),
		spec: { schema: a.schema, operations: [], terms: {}, mode: "draft", cacheRefresh: "none", rows: a.rows },
	});
	return job;
}

/** A single-edit job: explicit per-entry operations (grid saves, update_entry). */
export async function createSingleJob(
	m: Meter,
	a: { schema: SelectionDoc["schema"]; edits: Record<string, Operation[]>; mode: SaveMode; cacheRefresh: "republish" | "none"; budget: number; actor: Actor; translations?: boolean; now?: Date; claimFirst?: boolean },
): Promise<JobDoc> {
	const ids = Object.keys(a.edits);
	if (ids.length === 0) throw new LynxError("BAD_ARGUMENT", "Nothing to save: no entry has a change.");
	const all = Object.values(a.edits).flat();
	const termNames = termNamesOf(all);
	const terms = termNames.length ? await loadTerms(m.ctx, termNames) : {};
	// Validate every entry's operations now, so nothing is written if one is wrong.
	const cols = columnMap(a.schema);
	const worst = { base: 1, terms: 0 };
	const revisions = usesRevisions(a.schema);
	for (const id of ids) {
		const ops = normalizeOperations(a.edits[id], { columns: cols, terms });
		guardTranslations({ translations: a.translations ?? false }, revisions, ops);
		const c = worstStepCost(ops, { mode: a.mode, revisions, cacheRefresh: a.cacheRefresh });
		worst.base = Math.max(worst.base, c.base);
		worst.terms = Math.max(worst.terms, c.terms);
	}
	const unique = all.some((o) => cols.get(o.field)?.unique && o.field !== "slug");
	const shape = shapeStep(worst, a.budget, unique ? 1 : 0);
	const W = windowSizeFor(a.budget, shape.k);
	if (ids.length > W) throw new LynxError("BAD_ARGUMENT", `One save can change at most ${W} entries; this one has ${ids.length}. Save in parts or use a bulk edit.`);
	const job = await saveJob(m, a.actor, a.now, {
		kind: "single",
		collection: a.schema.slug,
		total: ids.length,
		fields: [...new Set(all.map((o) => o.field))],
		summary: `Edited ${[...new Set(all.map((o) => cols.get(o.field)?.label ?? o.field))].join(", ")} · ${entriesText(ids.length)}`,
		...shapeFields(shape),
		budget: a.budget,
		windowSize: W,
		window: ids,
		// claimFirst: the creator runs ticket 0 itself (runFirstClaimed), so no other stepper can take it.
		ticket: a.claimFirst ? 1 : 0,
		spec: { schema: a.schema, operations: [], edits: a.edits, terms, mode: a.mode, cacheRefresh: a.cacheRefresh },
	});
	return job;
}

/** A rollback job over the history records of `source`. */
export async function createRollbackJob(m: Meter, a: { source: JobDoc; force: boolean; budget: number; actor: Actor; now?: Date }): Promise<JobDoc> {
	const s = stores(m.ctx);
	const src = a.source;
	if (src.kind === "rollback" && src.state === "rolled_back") throw new LynxError("NOTHING_TO_REVERT", `${src.jobKey} was itself rolled back already.`);
	if (src.rolledBackBy) throw new LynxError("NOTHING_TO_REVERT", `${src.jobKey} was already rolled back by ${src.rolledBackBy}.`);
	if (src.state === "running") {
		// Stop the job first, so no step writes while the rollback runs.
		await s.jobs.updateIf(src.jobKey, { where: { state: "running" }, set: { state: "cancelled", finishedAt: new Date().toISOString() } });
	}
	const total = await s.history.count({ jobKey: src.jobKey, kind: "entry" });
	if (total === 0) throw new LynxError("NOTHING_TO_REVERT", `No revertible changes for ${src.jobKey}: it wrote nothing that history recorded.`);
	const revisions = usesRevisions(src.spec.schema);
	const first0 = src.spec.operations[0]?.behavior;
	// Undo costs: created → read + trash (2); trashed → read + restore + publish (3); an edit →
	// read, write, terms read, publish, and up to an add and a remove per taxonomy it touched.
	const taxonomiesTouched = src.fields.filter((x) => x.startsWith("terms:")).length;
	const shape = shapeStep(
		src.kind === "create" || first0 === "duplicate"
			? { base: 2, terms: 0 }
			: first0 === "trash"
				? { base: 3, terms: 0 }
				: { base: 2 + (taxonomiesTouched ? 1 : 0) + (revisions || src.spec.cacheRefresh === "republish" ? 1 : 0), terms: taxonomiesTouched * 2 },
		a.budget,
	);
	const W = Math.min(100, windowSizeFor(a.budget, shape.k));
	const first = await s.history.query({ where: { jobKey: src.jobKey, kind: "entry" }, limit: W });
	const job = await saveJob(m, a.actor, a.now, {
		kind: "rollback",
		collection: src.collection,
		total,
		fields: src.fields,
		summary: `Undo: ${src.summary}`,
		rollbackOf: src.jobKey,
		historyCursor: first.cursor ?? null,
		...shapeFields(shape),
		budget: a.budget,
		windowSize: W,
		window: first.items.map((x) => x.data.record!).filter(Boolean),
		spec: { ...src.spec, force: a.force },
	});
	return job;
}

type NewJob = Pick<JobDoc, "kind" | "collection" | "total" | "fields" | "summary" | "k" | "cost" | "budget" | "windowSize" | "window" | "spec"> & Partial<Pick<JobDoc, "selectionId" | "rollbackOf" | "historyCursor" | "ticket" | "inlineTerms" | "termChunk">>;

const shapeFields = (x: StepShape) => ({ k: x.k, cost: x.cost, inlineTerms: x.inlineTerms, termChunk: x.termChunk });

/** Store a new running job: the parts every job shares, plus what makes this one. */
async function saveJob(m: Meter, actor: Actor, now: Date | undefined, a: NewJob): Promise<JobDoc> {
	const job: JobDoc = { v: 1, jobKey: newJobKey(), state: "running", createdAt: (now ?? new Date()).toISOString(), ...actorFields(actor), windowNo: 0, windowStart: 0, ticket: 0, warnings: [], ...a };
	await stores(m.ctx).jobs.put(job.jobKey, job);
	return job;
}

function actorFields(a: Actor) {
	return { ...(a.userId ? { userId: a.userId } : {}), ...(a.userName ? { userName: a.userName } : {}), viaMcp: a.viaMcp };
}

function stripColumn(op: NormalizedOperation): Operation {
	const { column: _c, sourceColumn: _s, termIds: _t, ...rest } = op;
	return rest;
}

// ---------------------------------------------------------------------------
// Running steps

function emptyOutcome(phase: StepOutcome["phase"], calls: number): StepOutcome {
	return { phase, processed: 0, written: 0, unchanged: 0, invalid: 0, held: 0, failed: 0, conflicts: 0, calls };
}

/**
 * Advance a job by one step (and, when the budget allows, refill its window and claim again).
 * Safe to call from several places at once: claims are atomic and disjoint.
 */
/**
 * Run ticket 0 of a job created with claimFirst, without a claim call. When that ticket covers
 * the whole job, finish it in the same call with the step's own counts (one updateIf), so a
 * single correction costs exactly: create + read + history + write (+ publish) + finish.
 */
export async function runFirstClaimed(m: Meter, job: JobDoc, now = new Date()): Promise<{ job: JobDoc; outcome: StepOutcome }> {
	const items = job.window.slice(0, job.k);
	const outcome = await processSlice(m, job, 0, 0, items, now);
	if (job.total > job.k || !m.has(1) || outcome.pending) return { job: { ...job, ticket: Math.max(job.ticket, 1) }, outcome };
	const result: JobResult = { written: outcome.written, unchanged: outcome.unchanged, invalid: outcome.invalid, ...(outcome.held ? { held: outcome.held } : {}), failed: outcome.failed, conflicts: outcome.conflicts };
	const done = await stores(m.ctx).jobs.updateIf(job.jobKey, { where: { state: "running" }, set: { state: "completed", finishedAt: now.toISOString(), result } });
	return { job: done.applied ? done.data : job, outcome: { ...outcome, calls: m.used } };
}

/** Host calls one full step of `job` needs: the claim, the history write and its entries. */
export function stepCalls(job: Pick<JobDoc, "k" | "cost">): number {
	return 2 + job.k * job.cost;
}

export async function runStep(m: Meter, jobKey: string, opts: { now?: () => Date } = {}): Promise<{ job: JobDoc | null; outcome: StepOutcome }> {
	const s = stores(m.ctx);
	const now = opts.now ?? (() => new Date());
	for (let attempt = 0; attempt < 3; attempt++) {
		const claim = await s.jobs.updateIf(jobKey, { where: { state: "running" }, delta: { ticket: { inc: 1 } } });
		if (!claim.applied) {
			const job = await s.jobs.get(jobKey);
			if (!job) throw new LynxError("UNKNOWN_JOB", `There is no job ${jobKey}. list_history shows the recent jobs.`);
			return { job, outcome: emptyOutcome(job.state === "running" ? "not_running" : "finished", m.used) };
		}
		const job = claim.data;
		const t = job.ticket - 1;
		const start = t * job.k;
		const items = job.window.slice(start, start + job.k);
		if (items.length) {
			const outcome = await processSlice(m, job, job.windowNo, t, items, now());
			return { job, outcome };
		}
		// The window is used up.
		if (job.windowStart + job.window.length >= job.total || job.window.length === 0) {
			return finishing(m, job, now());
		}
		const refilled = await refill(m, job);
		if (!refilled || !m.has(stepCalls(job))) return { job, outcome: emptyOutcome("refill", m.used) };
	}
	return { job: null, outcome: emptyOutcome("refill", m.used) };
}

/** Load the next window of ids (bulk) or history records (rollback). Returns false if another stepper did it. */
async function refill(m: Meter, job: JobDoc): Promise<boolean> {
	const s = stores(m.ctx);
	let items: WindowItem[] = [];
	let historyCursor: string | null | undefined;
	const nextStart = job.windowStart + job.window.length;
	if (job.kind === "rollback") {
		const res = await s.history.query({ where: { jobKey: job.rollbackOf!, kind: "entry" }, limit: job.windowSize, ...(job.historyCursor ? { cursor: job.historyCursor } : {}) });
		items = res.items.map((x) => x.data.record!).filter(Boolean);
		historyCursor = res.cursor ?? null;
	} else if (job.selectionId) {
		const page = Math.floor(nextStart / PAGE_SIZE);
		const offset = nextStart % PAGE_SIZE;
		const sel = await s.selections.get(job.selectionId);
		const ids = sel ? (sel.pages === 0 ? sel.buffer : ((await s.pages.get(pageId(sel.id, page)))?.ids ?? [])) : [];
		items = ids.slice(offset, offset + job.windowSize);
	}
	const res = await s.jobs.updateIf(job.jobKey, {
		where: { state: "running", windowNo: job.windowNo },
		set: { windowNo: job.windowNo + 1, windowStart: nextStart, window: items, ticket: 0, ...(job.kind === "rollback" ? { historyCursor: historyCursor ?? null } : {}) },
	});
	return res.applied;
}

function ticketsIn(job: Pick<JobDoc, "total" | "windowSize" | "k">, w: number): number {
	const len = Math.max(0, Math.min(job.windowSize, job.total - w * job.windowSize));
	return Math.ceil(len / job.k);
}

function windowCount(job: Pick<JobDoc, "total" | "windowSize">): number {
	return Math.max(1, Math.ceil(job.total / job.windowSize));
}

async function finishing(m: Meter, job: JobDoc, now: Date): Promise<{ job: JobDoc; outcome: StepOutcome }> {
	const s = stores(m.ctx);
	let expected = 0;
	for (let w = 0; w < windowCount(job); w++) expected += ticketsIn(job, w);
	const receipts = await s.history.count({ jobKey: job.jobKey, kind: "receipt" });
	if (receipts >= expected) {
		// Term writes left by entries that needed more than one step come before completion.
		const pending = await s.history.query({ where: { jobKey: job.jobKey, kind: "pending" }, limit: 10 });
		if (pending.items.length) return { job, outcome: await applyPending(m, job, pending.items.map((x) => ({ id: x.id, data: x.data })), now) };
		const result = await summarize(m, job);
		const done = await s.jobs.updateIf(job.jobKey, { where: { state: "running" }, set: { state: "completed", finishedAt: now.toISOString(), result } });
		if (done.applied && job.kind === "rollback" && job.rollbackOf) {
			await s.jobs.updateIf(job.rollbackOf, { where: {}, set: { rolledBackBy: job.jobKey, state: "rolled_back" } });
		}
		const fresh = done.applied ? done.data : job;
		return { job: fresh, outcome: emptyOutcome("finished", m.used) };
	}
	// Some claimed ranges have no receipt yet: their steps may still be running.
	if (!job.exhaustedAt) {
		await s.jobs.updateIf(job.jobKey, { where: { state: "running" }, set: { exhaustedAt: now.toISOString() } });
		return { job, outcome: emptyOutcome("finishing", m.used) };
	}
	const lostAfter = job.spec.lostAfterMs ?? LOST_AFTER_MS;
	if (now.getTime() - Date.parse(job.exhaustedAt) < lostAfter) return { job, outcome: emptyOutcome("finishing", m.used) };
	return recover(m, job, now);
}

/**
 * Apply pending term chunks while the budget lasts, then mark them done (or failed) in one
 * putMany. Term writes are idempotent, so two steppers doing the same chunk is harmless.
 */
async function applyPending(m: Meter, job: JobDoc, docs: Array<{ id: string; data: HistoryDoc }>, now: Date): Promise<StepOutcome> {
	const marks: Array<{ id: string; data: HistoryDoc }> = [];
	const failures: Array<{ id: string; stage: string; message: string }> = [];
	let units = 0;
	for (const d of docs) {
		const u = d.data.units ?? [];
		if (!m.has(u.length + 1)) break;
		try {
			await applyTermUnits(m, job, d.data.entryId!, u);
			units += u.length;
			marks.push({ id: d.id, data: { ...d.data, kind: "pending_done", at: now.toISOString() } });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			failures.push({ id: d.data.entryId!, stage: "terms", message });
			marks.push({ id: d.id, data: { ...d.data, kind: "failure", stage: "terms", message: message.slice(0, 500), at: now.toISOString() } });
		}
	}
	if (marks.length) await stores(m.ctx).history.putMany(marks);
	return { ...emptyOutcome("terms", m.used), processed: units, failed: failures.length, ...(failures.length ? { failures } : {}) };
}

/** Re-run claimed ranges whose step died before writing its receipt (so it wrote nothing). */
async function recover(m: Meter, job: JobDoc, now: Date): Promise<{ job: JobDoc; outcome: StepOutcome }> {
	const s = stores(m.ctx);
	for (let w = 0; w < windowCount(job) && m.has(4); w++) {
		const want = ticketsIn(job, w);
		const have = await s.history.count({ jobKey: job.jobKey, kind: "receipt", windowNo: w });
		if (have >= want) continue;
		const got = await s.history.query({ where: { jobKey: job.jobKey, kind: "receipt", windowNo: w }, limit: 100 });
		const done = new Set(got.items.map((x) => x.data.ticket));
		const missing = Array.from({ length: want }, (_, i) => i).find((t) => !done.has(t));
		if (missing === undefined) continue;
		const items = await windowItems(m, job, w);
		const slice = items.slice(missing * job.k, missing * job.k + job.k);
		if (!slice.length) continue;
		if (createsThings(job)) {
			// Running a creating step again could create twice: report its items instead.
			const at = now.toISOString();
			const label = (x: WindowItem) => (job.kind === "create" ? `row ${Number(x) + 1}` : String(x));
			const failures = (slice as string[]).map((x) => ({ id: label(x), stage: "interrupted", message: "The step was interrupted: this item may or may not have been created, and history has no record of it. Look for it before creating it again." }));
			await saveCreateStep(m, job, { written: 0, pending: 0, failed: failures.length, failures, docs: [] }, at, w, missing, slice.length);
			return { job, outcome: { ...emptyOutcome("recovered", m.used), processed: slice.length, failed: failures.length, failures } };
		}
		const outcome = await processSlice(m, job, w, missing, slice, now);
		return { job, outcome: { ...outcome, phase: "recovered" } };
	}
	return { job, outcome: emptyOutcome("finishing", m.used) };
}

async function windowItems(m: Meter, job: JobDoc, w: number): Promise<WindowItem[]> {
	if (w === job.windowNo) return job.window;
	const s = stores(m.ctx);
	const start = w * job.windowSize;
	if (job.kind === "rollback") {
		// Rollback windows are history pages in query order; walk to window w.
		let cursor: string | undefined;
		let items: WindowItem[] = [];
		for (let i = 0; i <= w && m.has(3); i++) {
			const res = await s.history.query({ where: { jobKey: job.rollbackOf!, kind: "entry" }, limit: job.windowSize, ...(cursor ? { cursor } : {}) });
			items = res.items.map((x) => x.data.record!).filter(Boolean);
			cursor = res.cursor;
		}
		return items;
	}
	if (job.kind === "single") return job.window;
	const sel = job.selectionId ? await s.selections.get(job.selectionId) : null;
	if (!sel) return [];
	const page = Math.floor(start / PAGE_SIZE);
	const ids = sel.pages === 0 ? sel.buffer : ((await s.pages.get(pageId(sel.id, page)))?.ids ?? []);
	return ids.slice(start % PAGE_SIZE, (start % PAGE_SIZE) + job.windowSize);
}

async function summarize(m: Meter, job: JobDoc): Promise<JobResult> {
	const h = stores(m.ctx).history;
	if (createsThings(job)) {
		// Records exist only for what was created, so every record is a written item.
		const [entries, invalid, failed] = await Promise.all([
			h.count({ jobKey: job.jobKey, kind: "entry" }),
			h.count({ jobKey: job.jobKey, kind: "invalid" }),
			h.count({ jobKey: job.jobKey, kind: "failure" }),
		]);
		return {
			written: entries,
			unchanged: Math.max(0, job.total - entries - invalid - failed),
			invalid,
			failed,
			conflicts: 0,
		};
	}
	// Four counts at most (the finishing step has to fit 8 calls): rollbacks have conflicts and
	// never invalid entries, other jobs have invalid and held entries.
	const [entries, invalid, failed, conflicts, held] = await Promise.all([
		h.count({ jobKey: job.jobKey, kind: "entry" }),
		job.kind === "rollback" ? Promise.resolve(0) : h.count({ jobKey: job.jobKey, kind: "invalid" }),
		h.count({ jobKey: job.jobKey, kind: "failure" }),
		job.kind === "rollback" ? h.count({ jobKey: job.jobKey, kind: "conflict" }) : Promise.resolve(0),
		job.kind === "rollback" ? Promise.resolve(0) : h.count({ jobKey: job.jobKey, kind: "held" }),
	]);
	const written = Math.max(0, entries - failed);
	return { written, unchanged: Math.max(0, job.total - entries - invalid - held), invalid, ...(held ? { held } : {}), failed, conflicts };
}

// ---------------------------------------------------------------------------
// Processing one claimed range

interface Current {
	item: HostItem;
	rev: string;
	entry: Entry;
}

async function processSlice(m: Meter, job: JobDoc, windowNo: number, ticket: number, items: WindowItem[], now: Date): Promise<StepOutcome> {
	const at = now.toISOString();
	const receiptId = `${job.jobKey}:r:${windowNo}:${ticket}`;
	if (job.kind === "rollback") return processRollback(m, job, windowNo, ticket, items as HistoryRecord[], at, receiptId);
	if (job.kind === "create") {
		const o = await createRows(m, job, items as string[], at);
		await saveCreateStep(m, job, o, at, windowNo, ticket, items.length);
		return { phase: "entries", processed: items.length, written: o.written, unchanged: 0, invalid: 0, held: 0, failed: o.failed, conflicts: 0, calls: m.used, pending: o.pending, ...(o.failures.length ? { failures: o.failures } : {}) };
	}

	const ids = items as string[];
	const bulkOps = job.kind === "bulk" ? normalized(job, job.spec.operations) : [];
	const opsFor = (id: string) => (job.kind === "bulk" ? bulkOps : normalized(job, job.spec.edits?.[id] ?? []));
	const duplicating = bulkOps[0]?.behavior === "duplicate";
	// A copy takes every term of its source, so a duplicate step reads all taxonomies of the collection.
	const termNames = duplicating
		? (job.spec.schema.taxonomies ?? []).filter((t) => t.collections.includes(job.collection)).map((t) => t.name)
		: [...new Set(ids.flatMap((id) => opsFor(id).map((o) => taxonomyOfKey(o.column.key)).filter((x): x is string => Boolean(x))))];

	// 1. Read every entry (before-values and the _rev the publish is computed from).
	const current = new Map<string, Current>();
	const failures: Array<{ id: string; stage: string; message: string }> = [];
	for (const id of ids) {
		const v = (await content(m.ctx).getVersioned(job.collection, id)) as unknown as { item: HostItem; _rev: string } | null;
		if (!v) {
			failures.push({ id, stage: "read", message: "The entry no longer exists (deleted or moved to the trash)." });
			continue;
		}
		const terms = termNames.length ? await loadEntryTerms(m.ctx, job.collection, id, termNames) : undefined;
		current.set(id, { item: v.item, rev: v._rev, entry: toEntry(v.item, terms) });
	}

	// 2. Plan with the same engine function preview used.
	const plans: EntryPlan[] = [];
	let merged = null as Plan | null;
	if (job.kind === "bulk") {
		merged = planBulk(job.spec.schema, [...current.values()].map((c) => c.entry), bulkOps, { mode: job.spec.mode, cacheRefresh: job.spec.cacheRefresh, terms: job.spec.terms });
		plans.push(...merged.entries);
	} else {
		for (const [id, c] of current) {
			const p = planBulk(job.spec.schema, [c.entry], opsFor(id), { mode: job.spec.mode, cacheRefresh: job.spec.cacheRefresh, terms: job.spec.terms });
			plans.push(...p.entries);
			const prev: Plan | null = merged;
			merged = prev ? { ...prev, uniqueChecks: [...prev.uniqueChecks, ...p.uniqueChecks], entries: [...prev.entries, ...p.entries] } : p;
		}
	}

	// 3. Uniqueness against the rest of the collection (EmDash stores `unique` but does not enforce it).
	if (merged) {
		for (const check of merged.uniqueChecks) {
			if (check.field === "slug" || !check.values.length) continue;
			const res = (await content(m.ctx).list(job.collection, { limit: 100, where: { fieldFilters: { [check.field]: { in: check.values.slice(0, 50) } } as never } })) as unknown as { items: HostItem[] };
			const taken = new Map<string, string[]>();
			for (const it of res.items) {
				const v = String(it.data[check.field]);
				taken.set(v, [...(taken.get(v) ?? []), it.id]);
			}
			applyUniqueConflicts(merged, check.field, taken);
		}
	}

	// Copies: create each one, then record the new entries, the invalid ones and the receipt.
	if (duplicating) {
		const o = { written: 0, pending: 0, failed: 0, failures: [] as Array<{ id: string; stage: string; message: string }>, docs: [] as Array<{ id: string; data: HistoryDoc }> };
		const invalidDocs: Array<{ id: string; data: HistoryDoc }> = [];
		const fallback = { used: false };
		for (const p of plans) {
			if (p.state === "invalid") {
				invalidDocs.push({ id: `${job.jobKey}:i:${p.id}`, data: { jobKey: job.jobKey, kind: "invalid", at, entryId: p.id, problems: p.problems.map((x) => ({ field: x.field, message: x.message })) } });
				continue;
			}
			if (p.state !== "change" || !p.create) continue;
			try {
				const { record, later } = await createEntry(m, job, { data: p.create.data, terms: p.create.terms, publish: false, title: p.create.title, locale: p.locale, sourceId: p.id }, at, fallback);
				o.docs.push({ id: `${job.jobKey}:e:${p.id}`, data: { jobKey: job.jobKey, kind: "entry", at, entryId: record.entryId, record } }, ...pendingDocs(job, record.entryId, later, at));
				o.pending += later.length;
				o.written++;
			} catch (err) {
				o.failures.push({ id: p.id, stage: "create", message: err instanceof Error ? err.message : String(err) });
			}
		}
		for (const f of failures) o.failures.push(f);
		o.failed = o.failures.length;
		await saveCreateStep(m, job, o, at, windowNo, ticket, ids.length, invalidDocs);
		return { phase: "entries", processed: ids.length, written: o.written, unchanged: plans.filter((p) => p.state === "unchanged").length, invalid: invalidDocs.length, held: 0, failed: o.failed, conflicts: 0, calls: m.used, pending: o.pending, ...(o.failures.length ? { failures: o.failures } : {}) };
	}

	// 4. History before any write: entry records, invalid entries, and the step receipt.
	const docs: Array<{ id: string; data: HistoryDoc }> = [];
	let written = 0;
	let invalid = 0;
	let held = 0;
	let unchanged = 0;
	let pending = 0;
	const pendingIds = new Map<string, string[]>();
	for (const p of plans) {
		if (p.state === "invalid") {
			invalid++;
			docs.push({ id: `${job.jobKey}:i:${p.id}`, data: { jobKey: job.jobKey, kind: "invalid", at, entryId: p.id, problems: p.problems.map((x) => ({ field: x.field, message: x.message })) } });
		} else if (p.state === "held") {
			held++;
			docs.push({ id: `${job.jobKey}:h:${p.id}`, data: { jobKey: job.jobKey, kind: "held", at, entryId: p.id, problems: [{ field: PENDING_DRAFT, message: "The entry has unpublished draft edits; publishing would put them live too, so it was left untouched." }] } });
		} else if (p.state === "unchanged") unchanged++;
		else {
			const c = current.get(p.id)!;
			const record = historyFor({ jobKey: job.jobKey, collection: job.collection, plan: p, current: c.entry, at, viaMcp: job.viaMcp, ...(job.userId ? { userId: job.userId } : {}) });
			docs.push({ id: `${job.jobKey}:e:${p.id}`, data: { jobKey: job.jobKey, kind: "entry", at, entryId: p.id, record } });
			const later = pendingDocs(job, p.id, splitTerms(job, termUnits(p.termDelta)).later, at);
			if (later.length) {
				docs.push(...later);
				pending += later.length;
				pendingIds.set(p.id, later.map((x) => x.id));
			}
		}
	}
	docs.push({ id: `${job.jobKey}:r:${windowNo}:${ticket}`, data: { jobKey: job.jobKey, kind: "receipt", at, windowNo, ticket, count: ids.length } });
	await stores(m.ctx).history.putMany(docs);

	// 5. Writes.
	let fallbackUsed = false;
	for (const p of plans) {
		if (p.state !== "change") continue;
		const c = current.get(p.id)!;
		try {
			fallbackUsed = await writePlan(m, job, p, c, fallbackUsed);
			written++;
		} catch (err) {
			failures.push({ id: p.id, stage: "write", message: err instanceof Error ? err.message : String(err) });
		}
	}
	if (failures.length) {
		// A failed entry's pending term chunks are dropped with it.
		const dropped = failures.flatMap((f) => (pendingIds.get(f.id) ?? []).map((id) => ({ id, data: { jobKey: job.jobKey, kind: "pending_done" as const, at, entryId: f.id } })));
		await stores(m.ctx).history.putMany([...failures.map((f) => ({ id: `${job.jobKey}:f:${f.id}`, data: { jobKey: job.jobKey, kind: "failure" as const, at, entryId: f.id, stage: f.stage, message: f.message.slice(0, 500) } })), ...dropped]);
	}
	return { phase: "entries", processed: ids.length, written, unchanged, invalid, held, failed: failures.length, conflicts: 0, calls: m.used, pending, ...(failures.length ? { failures } : {}) };
}

/** Apply one planned entry. Returns whether the one allowed _rev fallback has been spent. */
async function writePlan(m: Meter, job: JobDoc, p: EntryPlan, c: Current, fallbackUsed: boolean): Promise<boolean> {
	const api = content(m.ctx);
	if (p.statusAction === "trash") {
		// The history record (written before) keeps whether it was live; rollback restores and republishes.
		if (!(await api.delete(job.collection, p.id))) throw new Error("The entry was not in the collection any more (already in the trash?).");
		return fallbackUsed;
	}
	let rev = c.rev;
	const patch: Record<string, unknown> = { ...p.data, ...(p.slug !== undefined ? { slug: p.slug } : {}) };
	if (Object.keys(patch).length) {
		const updated = (await api.update(job.collection, p.id, patch)) as unknown as HostItem;
		rev = revAfterUpdate(c.item.version, updated.updatedAt);
	}
	await applyTermUnits(m, job, p.id, splitTerms(job, termUnits(p.termDelta)).now);
	const action = p.statusAction ?? (p.publishAfterWrite ? "publish" : undefined);
	if (!action) return fallbackUsed;
	const run = (r: string) => {
		switch (action) {
			case "publish":
				return api.publish(job.collection, p.id, { _rev: r });
			case "unpublish":
				return api.unpublish(job.collection, p.id, { _rev: r });
			case "schedule":
				return api.schedule(job.collection, p.id, { scheduledAt: p.scheduleAt!, _rev: r });
			case "unschedule":
				return api.unschedule(job.collection, p.id, { _rev: r });
		}
	};
	try {
		await run(rev);
		return fallbackUsed;
	} catch (err) {
		// The computed _rev relies on an internal format; re-read once per step if it is refused.
		if (fallbackUsed || !/conflict|rev/i.test(String(err))) throw err;
		const v = (await api.getVersioned(job.collection, p.id)) as unknown as { _rev: string } | null;
		if (!v) throw err;
		await run(v._rev);
		return true;
	}
}

function conflictText(c: { field: string; recorded: unknown; current: unknown }): string {
	if (c.field === PENDING_DRAFT) return "the entry now has unpublished draft edits; restoring would publish them too, so it was left alone (force overrides)";
	if (c.field === EDITED_SINCE) return "the entry was edited after the job created it, so it was left in place (force moves it to the trash anyway)";
	return `changed since the job: it holds ${JSON.stringify(c.current)}, the job wrote ${JSON.stringify(c.recorded)}`;
}

/** Trash an entry a job created, or restore one it trashed (publishing it again if it was live). */
async function undoLifecycle(m: Meter, job: JobDoc, id: string, action: "trash" | "untrash", rev: string, publish: boolean): Promise<void> {
	const api = content(m.ctx);
	if (action === "trash") {
		await api.delete(job.collection, id);
		return;
	}
	// EmDash brings a restored entry back as a draft; the job publishes it again if it was live.
	const restored = (await api.restore(job.collection, id, { _rev: rev })) as unknown as { _rev: string };
	if (publish) await api.publish(job.collection, id, { _rev: restored._rev });
}

async function processRollback(m: Meter, job: JobDoc, windowNo: number, ticket: number, records: HistoryRecord[], at: string, receiptId: string): Promise<StepOutcome> {
	const api = content(m.ctx);
	const termNames = [...new Set(records.flatMap((r) => Object.keys(r.before.terms ?? {})))];
	const docs: Array<{ id: string; data: HistoryDoc }> = [];
	const work: Array<{ rec: HistoryRecord; plan: ReturnType<typeof planRollback>; item: HostItem | null; rev: string }> = [];
	const failures: Array<{ id: string; stage: string; message: string }> = [];
	let conflicts = 0;
	let unchanged = 0;
	for (const rec of records) {
		// Whole-entry records: a trashed entry is looked up in the trash.
		const v =
			rec.lifecycle === "trashed"
					? ((await api.getTrashedVersioned(job.collection, rec.entryId)) as unknown as { item: HostItem; _rev: string } | null)
					: ((await api.getVersioned(job.collection, rec.entryId)) as unknown as { item: HostItem; _rev: string } | null);
		const terms = v && termNames.length && !rec.lifecycle ? await loadEntryTerms(m.ctx, job.collection, rec.entryId, termNames) : undefined;
		const plan = planRollback(rec, v ? toEntry(v.item, terms) : null, job.spec.force === true);
		if (plan.conflicts.length) {
			conflicts++;
			docs.push({ id: `${job.jobKey}:c:${rec.entryId}`, data: { jobKey: job.jobKey, kind: "conflict", at, entryId: rec.entryId, problems: plan.conflicts.map((c) => ({ field: c.field, message: conflictText(c) })) } });
		}
		if (plan.state === "missing") failures.push({ id: rec.entryId, stage: "read", message: "The entry no longer exists." });
		if (plan.state !== "restore" || !v) {
			if (plan.state === "nothing") unchanged++;
			continue;
		}
		work.push({ rec, plan, item: v?.item ?? null, rev: v?._rev ?? "" });
		if (plan.lifecycle) {
			// Undoing a create trashes the entry (so undoing this restores it), undoing a trash restores
			// it (so undoing this trashes it again).
			const record: HistoryRecord = {
				jobKey: job.jobKey,
				collection: job.collection,
				entryId: rec.entryId,
				locale: rec.locale,
				title: rec.title,
				at,
				before: { data: {} },
				after: { data: {} },
				published: plan.lifecycle === "trash" ? v?.item.status === "published" : false,
				viaMcp: job.viaMcp,
				...(job.userId ? { userId: job.userId } : {}),
				...(plan.lifecycle === "trash" ? { lifecycle: "trashed" as const } : plan.lifecycle === "untrash" ? { lifecycle: "created" as const } : {}),
			};
			docs.push({ id: `${job.jobKey}:e:${rec.entryId}`, data: { jobKey: job.jobKey, kind: "entry", at, entryId: rec.entryId, record } });
			continue;
		}
		if (!v) continue;
		const record: HistoryRecord = {
			jobKey: job.jobKey,
			collection: job.collection,
			entryId: rec.entryId,
			locale: rec.locale,
			title: rec.title,
			at,
			before: { data: Object.fromEntries(Object.keys(plan.data).map((k) => [k, v.item.data[k] ?? null])), ...(plan.slug !== undefined ? { slug: v.item.slug } : {}), ...(terms && Object.keys(plan.termDelta).length ? { terms } : {}), ...(plan.statusAction ? { status: v.item.status } : {}) },
			after: { data: plan.data, ...(plan.slug !== undefined ? { slug: plan.slug } : {}) },
			...(plan.statusAction ? { statusAction: plan.statusAction } : {}),
			published: plan.publishAfterWrite,
			viaMcp: job.viaMcp,
			...(job.userId ? { userId: job.userId } : {}),
		};
		docs.push({ id: `${job.jobKey}:e:${rec.entryId}`, data: { jobKey: job.jobKey, kind: "entry", at, entryId: rec.entryId, record } });
		docs.push(...pendingDocs(job, rec.entryId, splitTerms(job, termUnits(plan.termDelta)).later, at));
	}
	docs.push({ id: receiptId, data: { jobKey: job.jobKey, kind: "receipt", at, windowNo, ticket, count: records.length } });
	await stores(m.ctx).history.putMany(docs);

	let written = 0;
	let fallbackUsed = false;
	for (const w of work) {
		if (w.plan.lifecycle) {
			try {
				await undoLifecycle(m, job, w.rec.entryId, w.plan.lifecycle, w.rev, w.plan.publishAfterWrite);
				written++;
			} catch (err) {
				failures.push({ id: w.rec.entryId, stage: "write", message: err instanceof Error ? err.message : String(err) });
			}
			continue;
		}
		if (!w.item) continue;
		// writePlan reads only the write parts of a plan.
		const p = {
			id: w.rec.entryId,
			data: w.plan.data,
			...(w.plan.slug != null ? { slug: w.plan.slug } : {}),
			termDelta: w.plan.termDelta,
			statusAction: w.plan.statusAction,
			scheduleAt: w.plan.scheduleAt,
			...(!w.plan.statusAction && w.plan.publishAfterWrite && w.item.status === "published" ? { publishAfterWrite: "publish_mode" as const } : {}),
		} as EntryPlan;
		try {
			fallbackUsed = await writePlan(m, job, p, { item: w.item, rev: w.rev, entry: toEntry(w.item) }, fallbackUsed);
			written++;
		} catch (err) {
			failures.push({ id: w.rec.entryId, stage: "write", message: err instanceof Error ? err.message : String(err) });
		}
	}
	if (failures.length) {
		await stores(m.ctx).history.putMany(failures.map((f) => ({ id: `${job.jobKey}:f:${f.id}`, data: { jobKey: job.jobKey, kind: "failure" as const, at, entryId: f.id, stage: f.stage, message: f.message.slice(0, 500) } })));
	}
	return { phase: "entries", processed: records.length, written, unchanged, invalid: 0, held: 0, failed: failures.length, conflicts, calls: m.used, ...(failures.length ? { failures } : {}) };
}

// ---------------------------------------------------------------------------
// Reading job state

export interface Progress {
	done: number;
	total: number;
	percent: number;
	remaining: number;
}

/** Entries claimed so far (steps in flight count as done; receipts settle the exact numbers at the end). */
export function progressOf(job: JobDoc): Progress {
	const inWindow = Math.min(job.window.length, job.ticket * job.k);
	const done = job.state === "running" ? Math.min(job.total, job.windowStart + inWindow) : job.total;
	return { done, total: job.total, percent: job.total ? Math.round((done / job.total) * 100) : 100, remaining: Math.max(0, job.total - done) };
}

export async function getJob(m: Meter, jobKey: string): Promise<JobDoc> {
	const job = await stores(m.ctx).jobs.get(jobKey);
	if (!job) throw new LynxError("UNKNOWN_JOB", `There is no job ${jobKey}. list_history shows the recent jobs.`);
	return job;
}

export async function cancelJob(m: Meter, jobKey: string): Promise<boolean> {
	const res = await stores(m.ctx).jobs.updateIf(jobKey, { where: { state: "running" }, set: { state: "cancelled", finishedAt: new Date().toISOString() } });
	return res.applied;
}

export type { TermDef, Warning };
