import type { CollectionDef, CompiledFilter, HistoryRecord, NewRowPlan, Operation, SaveMode, TermDef, TermUnit, Warning } from "@realmag777/lynx-engine";
import type { StorageCollection } from "emdash";

import type { Ctx } from "./host.ts";

// Documents LYNX keeps in its own plugin storage. One core plugin id, one storage:
// the single source of truth for jobs and history.

export const PAGE_SIZE = 2000; // ids per selection page document

export interface SelectionDoc {
	id: string;
	collection: string;
	state: "building" | "ready";
	/** Filter as given, and compiled (host part pushed down, rest scanned). */
	filter: unknown;
	compiled: CompiledFilter;
	summary: string;
	schema: CollectionDef;
	/** Host list cursor to continue scanning; null when the first page is next. */
	cursor: string | null;
	/** Items of the host page at `cursor` already looked at (a call ran out of budget mid-page). */
	skip: number;
	scanned: number;
	count: number;
	/** Ids matched but not yet flushed to a page document. */
	buffer: string[];
	pages: number;
	/** Where each host page started, so get_entries can jump to an offset with one list call. */
	hostPages: Array<{ cursor: string | null; first: number }>;
	/** A row whose translation group differs from its id was seen: the collection has translations. */
	translations: boolean;
	wholeCollection: boolean;
	createdAt: string;
	expiresAt: string;
	userId?: string;
}

export interface PageDoc {
	owner: string;
	n: number;
	ids: string[];
}

export type JobKind = "bulk" | "single" | "rollback" | "create";
export type JobState = "running" | "completed" | "cancelled" | "rolled_back";

export interface JobSpec {
	schema: CollectionDef;
	operations: Operation[];
	/** Per-entry operations for single-edit jobs (grid saves, update_entry). */
	edits?: Record<string, Operation[]>;
	terms: Record<string, TermDef[]>;
	mode: SaveMode;
	cacheRefresh: "republish" | "none";
	force?: boolean;
	/** create jobs: the validated rows, created in window order (window items are row indexes). */
	rows?: NewRowPlan[];
	/** Tests shorten the wait before a claimed-but-unfinished step counts as lost. */
	lostAfterMs?: number;
}

/** A rollback window carries the history records themselves. */
export type WindowItem = string | HistoryRecord;

export interface JobDoc {
	v: 1;
	jobKey: string;
	kind: JobKind;
	state: JobState;
	collection: string;
	createdAt: string;
	finishedAt?: string;
	exhaustedAt?: string;
	userId?: string;
	userName?: string;
	viaMcp: boolean;
	total: number;
	fields: string[];
	summary: string;
	selectionId?: string;
	/** Rollback jobs: the job being undone and the history cursor for the next window. */
	rollbackOf?: string;
	historyCursor?: string | null;
	/** Entries per claim, the budget it was sized for, and the window of ids being worked on. */
	k: number;
	cost: number;
	/** Term writes an entry does in its own step; the rest go into pending chunks of termChunk. */
	inlineTerms?: number;
	termChunk?: number;
	budget: number;
	windowSize: number;
	windowNo: number;
	windowStart: number;
	window: WindowItem[];
	ticket: number;
	spec: JobSpec;
	warnings: Warning[];
	result?: JobResult;
	rolledBackBy?: string;
}

export interface JobResult {
	written: number;
	unchanged: number;
	invalid: number;
	/** Live entries left alone because they carry unpublished draft edits (publish mode). */
	held?: number;
	failed: number;
	conflicts: number;
}

export type HistoryKind = "entry" | "invalid" | "held" | "failure" | "conflict" | "receipt" | "pending" | "pending_done";

export interface HistoryDoc {
	jobKey: string;
	kind: HistoryKind;
	at: string;
	entryId?: string;
	windowNo?: number;
	ticket?: number;
	record?: HistoryRecord;
	problems?: Array<{ field: string; message: string }>;
	stage?: string;
	message?: string;
	count?: number;
	/** pending: term writes left for a later step. */
	units?: TermUnit[];
}

export interface MemoryDoc {
	key: string;
	text: string;
	updatedAt: string;
	userId?: string;
}

export function stores(ctx: Ctx) {
	const s = ctx.storage as Record<string, StorageCollection<unknown>>;
	return {
		jobs: s.jobs as StorageCollection<JobDoc>,
		selections: s.selections as StorageCollection<SelectionDoc>,
		pages: s.pages as StorageCollection<PageDoc>,
		history: s.history as StorageCollection<HistoryDoc>,
		memory: s.memory as StorageCollection<MemoryDoc>,
	};
}

export const pageId = (owner: string, n: number) => `${owner}:${n}`;
