import { createdRecord, splitTermUnits, TERMS_STEP_OVERHEAD, type HistoryRecord, type TermUnit } from "@realmag777/lynx-engine";

import { content, revAfterUpdate, taxonomies, type HostItem } from "./host.ts";
import type { Meter } from "./meter.ts";
import { stores, type HistoryDoc, type JobDoc } from "./store.ts";

// Steps that create entries (create_entries, duplicate).
// Nothing is overwritten, so there are no before-values to save first, and the new id exists
// only after the create: these steps write their history and receipt in one putMany AFTER the
// writes. A step that dies in between leaves no receipt; recovery then reports its rows as
// interrupted instead of running them again, because running them again could create twice.

export interface CreateOutcome {
	written: number;
	/** Pending term chunks recorded for later steps. */
	pending: number;
	failed: number;
	failures: Array<{ id: string; stage: string; message: string }>;
	docs: Array<{ id: string; data: HistoryDoc }>;
}

export interface NewEntry {
	data: Record<string, unknown>;
	terms: Record<string, string[]>;
	publish: boolean;
	title: string;
	locale?: string | null;
	sourceId?: string;
}

/**
 * Create one entry, assign the terms that fit this step and publish it when asked. The other
 * term writes come back as `later` chunks for pending-terms steps. Publishing uses the _rev the
 * create implies (version 1); if the host refuses it, one re-read per step is allowed.
 */
export async function createEntry(m: Meter, job: JobDoc, e: NewEntry, at: string, fallback: { used: boolean }): Promise<{ record: HistoryRecord; later: TermUnit[][] }> {
	const api = content(m.ctx);
	const item = (await api.create(job.collection, e.data, e.locale ? { locale: e.locale } : undefined)) as unknown as HostItem;
	const units: TermUnit[] = Object.entries(e.terms)
		.filter(([, ids]) => ids.length)
		.map(([tax, ids]) => ({ tax, op: "add" as const, ids }));
	const { now, later } = splitTerms(job, units);
	await applyTermUnits(m, job, item.id, now);
	let version = item.version ?? 1;
	if (e.publish) {
		let res: { item: HostItem };
		try {
			res = (await api.publish(job.collection, item.id, { _rev: revAfterUpdate(version - 1, item.updatedAt) })) as unknown as { item: HostItem };
		} catch (err) {
			if (fallback.used || !/conflict|rev/i.test(String(err))) throw err;
			fallback.used = true;
			const v = (await api.getVersioned(job.collection, item.id)) as unknown as { _rev: string };
			res = (await api.publish(job.collection, item.id, { _rev: v._rev })) as unknown as { item: HostItem };
		}
		version = res.item.version ?? version + 1;
	}
	const record = createdRecord({
		jobKey: job.jobKey,
		collection: job.collection,
		entryId: item.id,
		...(e.sourceId ? { sourceId: e.sourceId } : {}),
		locale: item.locale ?? null,
		title: e.title,
		at,
		data: e.data,
		terms: e.terms,
		version,
		published: e.publish,
		...(job.userId ? { userId: job.userId } : {}),
		viaMcp: job.viaMcp,
	});
	return { record, later };
}

/** An entry's term writes: the ones this step makes, and pending chunks for later steps. */
export function splitTerms(job: Pick<JobDoc, "inlineTerms" | "termChunk" | "budget">, units: TermUnit[]): { now: TermUnit[]; later: TermUnit[][] } {
	return splitTermUnits(units, job.inlineTerms ?? units.length, job.termChunk ?? Math.max(1, job.budget - TERMS_STEP_OVERHEAD));
}

export async function applyTermUnits(m: Meter, job: JobDoc, entryId: string, units: TermUnit[]): Promise<void> {
	for (const u of units) {
		if (u.op === "add") await taxonomies(m.ctx).addEntryTerms(job.collection, entryId, u.tax, u.ids);
		else await taxonomies(m.ctx).removeEntryTerms(job.collection, entryId, u.tax, u.ids);
	}
}

/** History documents for term writes left to later steps (applied before the job completes). */
export function pendingDocs(job: JobDoc, entryId: string, later: TermUnit[][], at: string): Array<{ id: string; data: HistoryDoc }> {
	return later.map((units, i) => ({ id: `${job.jobKey}:p:${entryId}:${i}`, data: { jobKey: job.jobKey, kind: "pending" as const, at, entryId, units } }));
}

/** One claimed range of a create_entries job: window items are row indexes into spec.rows. */
export async function createRows(m: Meter, job: JobDoc, items: string[], at: string): Promise<CreateOutcome> {
	const out: CreateOutcome = { written: 0, pending: 0, failed: 0, failures: [], docs: [] };
	const fallback = { used: false };
	for (const idx of items) {
		const row = job.spec.rows?.[Number(idx)];
		if (!row) continue;
		try {
			const { record, later } = await createEntry(m, job, { data: row.data, terms: row.terms, publish: row.publish, title: row.title }, at, fallback);
			out.docs.push({ id: `${job.jobKey}:e:${idx}`, data: { jobKey: job.jobKey, kind: "entry", at, entryId: record.entryId, record } }, ...pendingDocs(job, record.entryId, later, at));
			out.pending += later.length;
			out.written++;
		} catch (err) {
			out.failures.push({ id: `row ${row.index + 1}`, stage: "create", message: err instanceof Error ? err.message : String(err) });
		}
	}
	out.failed = out.failures.length;
	return out;
}

/** The step's single history write: records, failures and the receipt together. */
export async function saveCreateStep(m: Meter, job: JobDoc, o: CreateOutcome, at: string, windowNo: number, ticket: number, count: number, extra: Array<{ id: string; data: HistoryDoc }> = []): Promise<void> {
	const docs = [
		...extra,
		...o.docs,
		...o.failures.map((f, i) => ({ id: `${job.jobKey}:f:${windowNo}:${ticket}:${i}`, data: { jobKey: job.jobKey, kind: "failure" as const, at, entryId: f.id, stage: f.stage, message: f.message.slice(0, 500) } })),
		{ id: `${job.jobKey}:r:${windowNo}:${ticket}`, data: { jobKey: job.jobKey, kind: "receipt" as const, at, windowNo, ticket, count } },
	];
	await stores(m.ctx).history.putMany(docs);
}
