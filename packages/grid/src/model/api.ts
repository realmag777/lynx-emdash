// Two clients. CoreApi: the LYNX core (sandboxed plugin) for every content WRITE, the schema
// description and the frozen selections bulk edits run on (2026-09-29). GridApi: this
// plugin's own native routes for READS (pages of rows, terms, drafts) and saved views
// (2026-09-30). Business answers of the core come back as { ok: false, code, message }
// inside a 200 response (the sandbox strips error codes), so both shapes become LynxApiError.

import type { Operation } from "@realmag777/lynx-engine";

export const CORE = "/_emdash/api/plugins/lynx";
export const GRID = "/_emdash/api/plugins/lynx-grid";

export class LynxApiError extends Error {
	readonly code: string;
	readonly details?: unknown;
	constructor(code: string, message: string, details?: unknown) {
		super(message);
		this.name = "LynxApiError";
		this.code = code;
		this.details = details;
	}
}

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

/** Same as emdash/plugin-utils apiFetch: the CSRF header every state-changing admin call needs. */
const defaultFetch: Fetcher = (input, init) => {
	const headers = new Headers(init?.headers);
	headers.set("X-EmDash-Request", "1");
	return fetch(input, { ...init, headers, credentials: "same-origin" });
};

export interface FieldInfo {
	key: string;
	label: string;
	type: string;
	editable: boolean;
	bulk: boolean;
	filter: "host" | "scan" | "terms" | "none";
	sortable: boolean;
	behaviors: string[];
	options?: string[];
	/** Value rules of the field (min, max, minLength, maxLength, pattern …). */
	rules?: Record<string, unknown>;
	/** A taxonomy that takes one term per entry (a car has one make). */
	single?: boolean;
	unit?: string;
	format?: string;
	closed?: string;
	required: boolean;
	unique: boolean;
	translatable: boolean;
}

export interface CollectionInfo {
	slug: string;
	label: string;
	revisions: boolean;
	search: boolean;
	fields: number;
	indexed_fields: string[];
	taxonomies: string[];
}

export interface SiteInfo {
	site: { name: string; url: string; locale: string };
	collections: CollectionInfo[];
	taxonomies: Array<{ name: string; label: string; hierarchical: boolean; collections: string[] }>;
	lynx: { version: string; step_budget: number };
}

export interface Term {
	id: string;
	slug: string;
	label: string;
	/** Parent reference (EmDash stores the parent's translation group). */
	parent?: string | null;
	/** Translation group of this term (what children point at). */
	group?: string | null;
}

export interface GridRow {
	id: string;
	slug: string | null;
	status: string;
	locale: string | null;
	updated_at: string | null;
	published_at: string | null;
	/** The entry carries unpublished draft edits (data shows the draft values). */
	draft: boolean;
	data: Record<string, unknown>;
	terms?: Record<string, string[]>;
	/** For cells the draft changes: the value the site shows now (absent: same as shown). */
	live?: Record<string, unknown>;
}

export interface Selection {
	selection_id: string;
	collection: string;
	state: "building" | "ready";
	count: number;
	scanned: number;
	whole_collection: boolean;
	filter: string;
}

export interface Warning {
	code: string;
	text: string;
}

export interface PreviewAnswer {
	selection_id: string;
	selection_count: number;
	confirm_count: number;
	sample_size: number;
	sample_counts: { total: number; change: number; unchanged: number; invalid: number; held: number };
	mode: "draft" | "publish";
	revisions: boolean;
	rows: Array<{ id: string; title: string; status: string; state: string; changes: Array<{ field: string; before: string; after: string }>; problems?: string[] }>;
	warnings: Warning[];
	entries_per_step: number;
	steps_estimate: number;
}

export interface JobResult {
	written: number;
	unchanged: number;
	invalid: number;
	held?: number;
	failed: number;
	conflicts: number;
}

export interface JobAnswer {
	job_key: string;
	kind: string;
	state: "running" | "completed" | "cancelled" | "rolled_back";
	collection: string;
	summary: string;
	mode: "draft" | "publish";
	total: number;
	done: number;
	percent_done: number;
	remaining: number;
	finished: boolean;
	step?: { phase: string; failed: number; failures?: Array<{ id: string; stage: string; message: string }> };
	result?: JobResult;
	rolled_back_by?: string;
	rollback_of?: string;
	note: string;
}

export interface HistoryJob {
	job_key: string;
	kind: string;
	state: string;
	collection: string;
	summary: string;
	fields: string[];
	total: number;
	mode: string;
	started: string;
	finished: string | null;
	author: string | null;
	via_mcp: boolean;
	result?: JobResult;
	rolled_back_by?: string;
	rollback_of?: string;
}

export interface ViewConfig {
	columns?: string[];
	hidden?: string[];
	widths?: Record<string, number>;
	pinned?: string[];
	sort?: { key: string; dir: "asc" | "desc" } | null;
	filter?: unknown;
	density?: "comfortable" | "compact";
	pageSize?: number;
}

export interface SavedView {
	id: string;
	name: string;
	collection: string;
	config: ViewConfig;
	updatedAt: string;
}

class PluginApi {
	private readonly fetcher: Fetcher;
	private readonly base: string;
	private readonly missing: string;
	constructor(base: string, missing: string, fetcher: Fetcher = defaultFetch) {
		this.base = base;
		this.missing = missing;
		this.fetcher = fetcher;
	}

	async call<T>(route: string, input: unknown = {}): Promise<T> {
		let res: Response;
		try {
			res = await this.fetcher(`${this.base}/${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
		} catch {
			throw new LynxApiError("NETWORK", "The site did not answer. Check the connection and try again.");
		}
		let body: { success?: boolean; data?: unknown; error?: { code?: string; message?: string } } | null = null;
		try {
			body = await res.json();
		} catch {
			body = null;
		}
		if (res.status === 404 && !body?.error) throw new LynxApiError("CORE_MISSING", this.missing);
		if (!res.ok || !body || body.success === false) {
			throw new LynxApiError(body?.error?.code ?? `HTTP_${res.status}`, body?.error?.message ?? `The request failed (${res.status}).`);
		}
		const data = body.data as { ok?: boolean; code?: string; message?: string; details?: unknown };
		if (data && data.ok === false) throw new LynxApiError(data.code ?? "ERROR", (data.message ?? "").replace(/^LYNX error \[[A-Z_]+\]: /, ""), data.details);
		return data as T;
	}
}

export class CoreApi extends PluginApi {
	constructor(fetcher?: Fetcher) {
		super(CORE, "The LYNX core plugin is not installed or not active on this site.", fetcher);
	}

	capabilities() {
		return this.call<{ lynx: string; version: string; step_budget: number }>("capabilities");
	}
	describe() {
		return this.call<SiteInfo>("describe");
	}
	fields(collection: string) {
		return this.call<{ collection: string; revisions: boolean; count: number; fields: FieldInfo[] }>("fields", { collection });
	}
	find(a: { collection: string; filter: unknown } | { selection_id: string }) {
		return this.call<Selection>("find", { ...a, sample: 0 });
	}
	preview(selectionId: string, operations: Operation[], mode: "draft" | "publish", limit = 20) {
		return this.call<PreviewAnswer>("preview", { selection_id: selectionId, operations, mode, limit });
	}
	apply(selectionId: string, operations: Operation[], confirmCount: number, mode: "draft" | "publish") {
		return this.call<JobAnswer>("apply", { selection_id: selectionId, operations, confirm_count: confirmCount, mode });
	}
	saveEdits(collection: string, edits: Record<string, Operation[]>, mode: "draft" | "publish") {
		return this.call<JobAnswer>("edits", { collection, edits, mode });
	}
	/**
	 * New entries (the core's create_entries): a dry run checks the rows (problems per row), the
	 * real call creates the valid ones as a job (history; rollback trashes them).
	 */
	create(collection: string, entries: Array<Record<string, unknown>>, dryRun: boolean, confirmCount?: number) {
		return this.call<CreateAnswer>("create", { collection, entries, dry_run: dryRun, ...(confirmCount !== undefined ? { confirm_count: confirmCount } : {}) });
	}
	/** One entry, explicit operations (the core's update_entry). */
	update(collection: string, id: string, operations: Operation[], mode: "draft" | "publish") {
		return this.call<JobAnswer>("update", { collection, id, operations, mode });
	}
	job(jobKey: string, cancel = false) {
		return this.call<JobAnswer>("job", { job_key: jobKey, ...(cancel ? { cancel: true } : {}) });
	}
	/** One page of jobs, newest first; cursor continues from the previous page. */
	history(limit = 30, cursor?: string) {
		return this.call<{ jobs: HistoryJob[]; total?: number; cursor?: string }>("history", { limit, ...(cursor ? { cursor } : {}) });
	}
	historyJob(jobKey: string) {
		return this.call<JobAnswer & { left_alone: Array<{ entry_id: string; why: string; problems?: Array<{ field: string; message: string }>; message?: string }> }>("history", { job_key: jobKey });
	}
	rollback(jobKey: string, force = false) {
		return this.call<JobAnswer>("rollback", { job_key: jobKey, ...(force ? { force: true } : {}) });
	}

	/** Run a job to the end: every job_status call does work, so call it again straight away. */
	/**
	 * Run a job to the end: every job_status call does work, so keep calling. Several callers may
	 * step a job at once (the core's claims are atomic and disjoint), so big jobs are driven by
	 * a few parallel workers; progress reports the furthest state seen.
	 */
	async drive(job: JobAnswer, onProgress?: (j: JobAnswer) => void, signal?: { cancelled: boolean }, workers = 4): Promise<JobAnswer> {
		let latest = job;
		onProgress?.(latest);
		if (latest.finished) return latest;
		let failure: unknown = null;
		const seen = (j: JobAnswer) => {
			if (j.finished || j.done >= latest.done) {
				latest = j.finished || !latest.finished ? j : latest;
				onProgress?.(latest);
			}
		};
		const worker = async () => {
			while (!latest.finished && !failure) {
				if (signal?.cancelled) return;
				try {
					seen(await this.job(job.job_key));
				} catch (err) {
					failure = err;
				}
			}
		};
		const n = Math.max(1, Math.min(workers, Math.ceil((job.remaining || job.total) / 20)));
		await Promise.all(Array.from({ length: n }, worker));
		if (failure) throw failure;
		if (signal?.cancelled && !latest.finished) return this.job(job.job_key, true);
		return latest;
	}

}

export interface GridPreview {
	total: number;
	checked: number;
	counts: { total: number; change: number; unchanged: number; invalid: number; held: number };
	mode: "draft" | "publish";
	revisions: boolean;
	rows: Array<{ id: string; title: string; status: string; state: string; changes: Array<{ field: string; label: string; before: unknown; after: unknown; before_text: string; after_text: string }>; problems?: string[] }>;
	warnings: Array<{ code: string; text: string; important: boolean }>;
}

/** An image of the media library as the photo panel lists it (title = alt text, description = caption). */
export interface LibraryImage {
	id: string;
	filename: string;
	title: string;
	description: string;
	width?: number;
	height?: number;
	mimeType: string;
	/** Preview address (EmDash gives plugins no storage key; the value for a field comes from getMedia). */
	url: string;
	createdAt: string;
}

/** The grid's own read routes (native plugin lynx-grid) and saved views. */
export class GridApi extends PluginApi {
	constructor(fetcher?: Fetcher) {
		super(GRID, "The LYNX Grid plugin routes are not available on this site.", fetcher);
	}

	/** A page of rows. total is null while the count is still running (counted: found so far; estimate: the count found last time). */
	rows(a: { collection: string; filter: unknown; sort: { key: string; dir: "asc" | "desc" } | null; offset: number; limit: number; terms: string[]; fresh?: boolean }) {
		return this.call<{ total: number | null; counted: number; estimate?: number; offset: number; rows: GridRow[] }>("rows", a);
	}
	terms(taxonomy: string) {
		return this.call<{ terms: Term[] }>("terms", { taxonomy });
	}
	emptyDrafts(collection: string, ids: string[]) {
		return this.call<{ empty: string[] }>("drafts/empty", { collection, ids });
	}
	/** Number formats of a collection's fields (null: none saved yet, use defaults). */
	formats(collection: string) {
		return this.call<{ formats: Record<string, { currency?: string; position?: "before" | "after"; decimals?: number }> | null }>("formats/get", { collection });
	}
	saveFormats(collection: string, formats: Record<string, { currency?: string; position?: "before" | "after"; decimals?: number }>) {
		return this.call<{ formats: Record<string, { currency?: string; position?: "before" | "after"; decimals?: number }> }>("formats/save", { collection, formats });
	}
	/** Bulk-edit preview over every selected entry (up to 500), by the grid with the core's engine. */
	preview(a: { collection: string; filter?: unknown; ids?: string[]; operations: unknown; mode: "draft" | "publish" }) {
		return this.call<GridPreview>("preview", a);
	}
	/** One page of the media library's images, searched by title, description and file name. */
	mediaSearch(a: { q: string; page: number; per_page: number; fresh?: boolean; exclude?: string[] }) {
		return this.call<{ total: number; inField?: number; page: number; pages: number; perPage: number; items: LibraryImage[] }>("media/search", a);
	}
	/** Repeater fields that are photo galleries: field key -> the key of its image sub-field. */
	galleries(collection: string) {
		return this.call<{ galleries: Record<string, string> }>("galleries", { collection });
	}
	/** Installed versions of the peers (Node hosts; available: false elsewhere). */
	versions() {
		return this.call<{ available: boolean; versions: Record<string, string | null> }>("versions", {});
	}
	views(collection: string) {
		return this.call<{ views: SavedView[] }>("views/list", { collection });
	}
	saveView(v: { id?: string; collection: string; name: string; config: ViewConfig }) {
		return this.call<SavedView>("views/save", v);
	}
	deleteView(id: string) {
		return this.call<{ deleted: boolean }>("views/delete", { id });
	}
}

/** The core's create route: per-row check (dry run), then a job. */
export interface CreateAnswer extends Partial<JobAnswer> {
	dry_run: boolean;
	ok: number;
	invalid: number;
	confirm_count?: number;
	rows: Array<{ row: number; status: string; title?: string; problems?: Array<{ code: string; field?: string; message?: string; text?: string; hint?: string }> }>;
	warnings: Array<{ code: string; text: string }>;
}
