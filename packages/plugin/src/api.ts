import { applyNewRowUniqueConflicts, MAX_NEW_ROWS, planNewRows, PRODUCT, SAFE_STEP_BUDGET, taxonomyOfKey, type Operation, type SaveMode } from "@realmag777/lynx-engine";
import type { PluginContext, SandboxedRouteContext } from "emdash/plugin";

import { runCase, listCases } from "./core/cases.ts";
import { guard, LynxError } from "./core/errors.ts";
import { content, loadCollection, loadTerms, withSingle, type HostItem } from "./core/host.ts";
import { bool, int, obj, oneOf, record, str, strList } from "./core/input.ts";
import { cancelJob, createBulkJob, createCreateJob, ensureCron, createRollbackJob, createSingleJob, getJob, progressOf, runFirstClaimed, runStep, stepCalls, type Actor, type StepOutcome } from "./core/jobs.ts";
import { budgetFor, Meter, type StepSize } from "./core/meter.ts";
import { previewBulk } from "./core/preview.ts";
import { DEFAULT_SAMPLE, defaultFields, find, loadReadySelection, MAX_ROWS, readSelection, toRow } from "./core/selections.ts";
import { describeSite, getMemory, listFields, listTerms, noteAgentSession, setMemory, setSingle } from "./core/site.ts";
import { stores, type JobDoc } from "./core/store.ts";
import { notes } from "./core/texts.ts";
import { columnMap } from "@realmag777/lynx-engine";

export const VERSION = "0.1.0";

type Handler = (routeCtx: SandboxedRouteContext, ctx: PluginContext) => Promise<unknown>;

interface RouteDef {
	permission: "content:read" | "content:edit_any";
	methods?: ["POST"] | ["GET", "POST"];
	handler: Handler;
}

interface Settings {
	stepSize: StepSize;
	cacheRefresh: "republish" | "none";
	/** One-term taxonomies (route taxonomy/single). */
	single: string[];
}

export async function settings(ctx: PluginContext): Promise<Settings> {
	const list = (await ctx.settings.list()) as Array<{ key: string; value: unknown }>;
	const get = (k: string) => list.find((x) => x.key === k || x.key === `settings:${k}`)?.value;
	const stepSize = get("stepSize");
	const cacheRefresh = get("cacheRefresh");
	return {
		stepSize: stepSize === "safe" || stepSize === "fast" ? stepSize : "auto",
		cacheRefresh: cacheRefresh === "none" ? "none" : "republish",
		single: ((x) => (Array.isArray(x) ? x.map(String) : []))(get("singleTaxonomies")),
	};
}

export function actorOf(routeCtx: SandboxedRouteContext): Actor {
	let viaMcp = false;
	try {
		viaMcp = new URL(routeCtx.request.url).pathname.endsWith("/_emdash/api/mcp");
	} catch {
		viaMcp = false;
	}
	const u = routeCtx.user as { id?: string; name?: string | null; email?: string } | undefined;
	return { ...(u?.id ? { userId: u.id } : {}), ...(u?.name || u?.email ? { userName: (u.name ?? u.email)! } : {}), viaMcp };
}

const meter = (ctx: PluginContext, size: StepSize = "auto") => new Meter(ctx, budgetFor(size));

/** How long one job_status call keeps stepping on a host without a subrequest limit. */
const LOOP_MS = 20_000;

const COUNTS = ["processed", "written", "unchanged", "invalid", "held", "failed", "conflicts", "calls"] as const;

function sumOutcomes(a: StepOutcome, b: StepOutcome): StepOutcome {
	const out: StepOutcome = { ...b, steps: (a.steps ?? 1) + (b.steps ?? 1) };
	for (const k of COUNTS) out[k] = a[k] + b[k];
	if (a.failures || b.failures) out.failures = [...(a.failures ?? []), ...(b.failures ?? [])];
	return out;
}

// ---------------------------------------------------------------------------
// Answer shapes

export function jobAnswer(job: JobDoc, step?: StepOutcome) {
	const p = progressOf(job);
	const finished = job.state !== "running";
	return {
		job_key: job.jobKey,
		kind: job.kind,
		state: job.state,
		collection: job.collection,
		summary: job.summary,
		mode: job.spec.mode,
		total: p.total,
		done: p.done,
		percent_done: p.percent,
		remaining: p.remaining,
		finished,
		entries_per_step: job.k,
		...(step ? { step: { phase: step.phase, processed: step.processed, written: step.written, unchanged: step.unchanged, invalid: step.invalid, ...(step.held ? { held: step.held } : {}), failed: step.failed, conflicts: step.conflicts, host_calls: step.calls, ...(step.steps && step.steps > 1 ? { steps: step.steps } : {}), ...(step.failures ? { failures: step.failures.slice(0, 10) } : {}) } } : {}),
		...(job.result ? { result: job.result } : {}),
		...(job.rollbackOf ? { rollback_of: job.rollbackOf } : {}),
		...(job.rolledBackBy ? { rolled_back_by: job.rolledBackBy } : {}),
		...(job.warnings.length ? { warnings: job.warnings } : {}),
		...(job.kind !== "rollback" && finished && job.state !== "rolled_back" ? { rollback_with: `rollback_bulk with job_key ${job.jobKey}` } : {}),
		note:
			job.state === "completed" && job.result
				? notes.finished(job.result, job.jobKey, job.kind)
				: job.state === "running"
					? notes.running(p.done, p.total, job.jobKey)
					: notes.notRunning(job.state),
	};
}

function parseMode(o: Record<string, unknown>): SaveMode {
	return oneOf(o, "mode", ["draft", "publish"] as const, "draft")!;
}

// ---------------------------------------------------------------------------
// Routes. Each MCP tool points at one of these; the grid (for writes) and the Block Kit page use them too.

export const routes: Record<string, RouteDef> = {
	capabilities: {
		permission: "content:read",
		methods: ["GET", "POST"],
		handler: async (r, ctx) =>
			guard(async () => {
				await ensureCron(ctx);
				if (actorOf(r).viaMcp) await noteAgentSession(ctx);
				return {
					lynx: PRODUCT.name,
					version: VERSION,
					step_budget: budgetFor("auto"),
					limits: { rows_per_answer: MAX_ROWS, selection_max: 50000, selection_ttl_hours: 24, memory_keys: 50 },
					note: "The working order and the rules are in the description of this tool: follow them for every change. Call get_memory next, then describe_site on a site you have not seen.",
				};
			}),
	},

	describe: {
		permission: "content:read",
		methods: ["GET", "POST"],
		handler: async (_r, ctx) => guard(async () => ({ ...(await describeSite(ctx)), lynx: { version: VERSION, step_budget: budgetFor("auto") }, note: notes.describe })),
	},

	fields: {
		permission: "content:read",
		methods: ["GET", "POST"],
		handler: async (r, ctx) =>
			guard(async () => {
				const o = obj(r.input);
				return { ...(await listFields(ctx, str(o, "collection", { required: true })!, bool(o, "editable_only"), (await settings(ctx)).single)), note: notes.fields };
			}),
	},

	terms: {
		permission: "content:read",
		methods: ["GET", "POST"],
		handler: async (r, ctx) =>
			guard(async () => {
				const o = obj(r.input);
				return { ...(await listTerms(ctx, str(o, "taxonomy", { required: true })!, str(o, "search", { max: 100 }), int(o, "limit", { min: 1, max: 500, def: 200 })!)), note: notes.terms };
			}),
	},

	find: {
		permission: "content:read",
		methods: ["POST"],
		handler: async (r, ctx) =>
			guard(async () => {
				const o = obj(r.input);
				const selectionId = str(o, "selection_id");
				const m = meter(ctx);
				const res = await find(m, {
					...(selectionId ? { selectionId } : { collection: str(o, "collection", { required: true })!, filter: o.filter ?? {} }),
					sample: int(o, "sample", { min: 0, max: MAX_ROWS, def: DEFAULT_SAMPLE })!,
					...(strList(o, "fields", { max: 30 }) ? { fields: strList(o, "fields", { max: 30 })! } : {}),
					...(actorOf(r).userId ? { userId: actorOf(r).userId! } : {}),
				});
				const sel = res.selection;
				return {
					selection_id: sel.id,
					collection: sel.collection,
					state: sel.state,
					count: sel.count,
					scanned: sel.scanned,
					whole_collection: sel.state === "ready" && sel.wholeCollection,
					expires_in: Math.max(0, Math.round((Date.parse(sel.expiresAt) - Date.now()) / 1000)),
					filter: sel.summary,
					fields: res.fields,
					sample: res.sample,
					note: sel.state === "ready" ? notes.findReady(sel.count, sel.wholeCollection) : notes.findBuilding(sel.count, sel.scanned),
				};
			}),
	},

	entries: {
		permission: "content:read",
		methods: ["POST"],
		handler: async (r, ctx) =>
			guard(async () => {
				const o = obj(r.input);
				const m = meter(ctx);
				const offset = int(o, "offset", { min: 0, def: 0 })!;
				const perPage = int(o, "per_page", { min: 1, max: MAX_ROWS, def: 25 })!;
				const selectionId = str(o, "selection_id");
				let sel;
				if (selectionId) sel = await loadReadySelection(m, selectionId);
				else {
					const ids = strList(o, "ids", { max: MAX_ROWS });
					const collection = str(o, "collection");
					if (!ids?.length || !collection) throw new LynxError("BAD_ARGUMENT", "Give either selection_id, or collection with ids (at most 50).");
					const f = await find(m, { collection, filter: { ids }, sample: 0 });
					sel = f.selection;
				}
				const entries = await readSelection(m, sel, offset, perPage);
				const cols = columnMap(sel.schema);
				const fields = strList(o, "fields", { max: 30 }) ?? defaultFields(sel.schema);
				return { collection: sel.collection, total: sel.count, offset, per_page: perPage, entries: entries.map((e) => toRow(e, fields, cols)), note: notes.entries };
			}),
	},

	preview: {
		permission: "content:read",
		methods: ["POST"],
		handler: async (r, ctx) =>
			guard(async () => {
				const o = obj(r.input);
				const m = meter(ctx);
				const sel = await loadReadySelection(m, str(o, "selection_id", { required: true })!);
				const conf = await settings(m.ctx);
				const res = await previewBulk(m, { selection: { ...sel, schema: withSingle(sel.schema, conf.single) }, operations: o.operations, mode: parseMode(o), cacheRefresh: conf.cacheRefresh, limit: int(o, "limit", { min: 1, max: MAX_ROWS, def: 10 })!, budget: budgetFor(conf.stepSize) });
				return {
					selection_id: sel.id,
					selection_count: sel.count,
					confirm_count: sel.count,
					sample_size: res.sampleSize,
					sample_counts: res.plan.counts,
					mode: res.plan.mode,
					revisions: res.plan.revisions,
					rows: res.plan.entries.map((e) => ({ id: e.id, title: e.title, status: e.status, state: e.state, changes: e.changes.map((c) => ({ field: c.field, before: c.display.before, after: c.display.after })), ...(e.problems.length ? { problems: e.problems.map((p) => p.message) } : {}) })),
					warnings: res.warnings.map((w) => ({ code: w.code, text: w.text })),
					entries_per_step: res.entriesPerStep,
					steps_estimate: res.stepsEstimate,
					note: notes.preview(sel.count, res.sampleSize),
				};
			}),
	},

	apply: {
		permission: "content:edit_any",
		methods: ["POST"],
		handler: async (r, ctx) =>
			guard(async () => {
				const o = obj(r.input);
				const conf = await settings(ctx);
				const m = meter(ctx, conf.stepSize);
				const sel = await loadReadySelection(m, str(o, "selection_id", { required: true })!);
				const { job } = await createBulkJob(m, { selection: { ...sel, schema: withSingle(sel.schema, conf.single) }, operations: o.operations, confirmCount: o.confirm_count, mode: parseMode(o), cacheRefresh: conf.cacheRefresh, budget: m.limit, actor: actorOf(r) });
				// Run the first step in this call only when the whole step still fits the budget.
				if (m.has(stepCalls(job))) {
					const res = await runStep(m, job.jobKey);
					return jobAnswer(res.job ?? job, res.outcome);
				}
				return jobAnswer(job);
			}),
	},

	create: {
		permission: "content:edit_any",
		methods: ["POST"],
		handler: async (r, ctx) =>
			guard(async () => {
				const o = obj(r.input);
				const collection = str(o, "collection", { required: true })!;
				const raw = o.entries;
				if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_NEW_ROWS) {
					throw new LynxError("BAD_ARGUMENT", `entries takes a list of 1 to ${MAX_NEW_ROWS} rows, each an object of list_fields keys and values. Nothing was done.`);
				}
				const dryRun = bool(o, "dry_run", true);
				const conf = await settings(ctx);
				const m = meter(ctx, conf.stepSize);
				const schema = await loadCollection(m.ctx, collection);
				const attached = new Set((schema.taxonomies ?? []).map((t) => t.name));
				const used = [...new Set(raw.flatMap((row) => (row && typeof row === "object" ? Object.keys(row as object) : [])).map((k) => taxonomyOfKey(k)).filter((t): t is string => Boolean(t && attached.has(t))))];
				const terms = await loadTerms(m.ctx, used);
				const plan = planNewRows(schema, raw, { terms });
				// Uniqueness against the entries already there: one query per unique field, indexed fields only.
				const unchecked: string[] = [];
				for (const check of plan.uniqueChecks) {
					const field = schema.fields.find((f) => f.slug === check.field);
					if (!field?.indexed || !m.has(dryRun ? 1 : 2)) {
						unchecked.push(check.field);
						continue;
					}
					const res = (await content(m.ctx).list(collection, { limit: 100, where: { fieldFilters: { [check.field]: { in: check.values.slice(0, 50) } } as never } })) as unknown as { items: HostItem[] };
					const taken = new Map<string, string[]>();
					for (const it of res.items) taken.set(String(it.data[check.field]), [...(taken.get(String(it.data[check.field])) ?? []), it.id]);
					applyNewRowUniqueConflicts(plan, check.field, taken);
				}
				const warnings = [
					...plan.warnings,
					...(unchecked.length ? [{ code: "unique_unchecked", text: `${unchecked.join(", ")} must be unique, but LYNX could not compare the new values with the existing entries (the field is not indexed). Make sure they are new.` }] : []),
				].map((w) => ({ code: w.code, text: w.text }));
				const rows = plan.rows.map((row) => ({ row: row.index + 1, status: row.state, title: row.title, ...(row.problems.length ? { problems: row.problems } : {}) }));
				const head = { collection, dry_run: dryRun, total: plan.counts.total, ok: plan.counts.ok, invalid: plan.counts.invalid, rows, warnings };
				if (dryRun) return { ...head, confirm_count: plan.counts.ok, note: notes.createDryRun(plan.counts.ok, plan.counts.invalid) };
				const confirm = o.confirm_count;
				if (typeof confirm !== "number" || confirm !== plan.counts.ok) {
					throw new LynxError("CONFIRM_MISMATCH", `confirm_count is ${JSON.stringify(confirm ?? null)} but ${plan.counts.ok} of the rows are valid. Run a dry run, show its result to the user, and pass the number of valid rows. Nothing was created.`);
				}
				const job = await createCreateJob(m, { schema, rows: plan.rows.filter((x) => x.state === "ok"), budget: budgetFor(conf.stepSize), actor: actorOf(r) });
				const res = m.has(stepCalls(job)) ? await runStep(m, job.jobKey) : null;
				return { ...head, ...jobAnswer(res?.job ?? job, res?.outcome) };
			}),
	},

	job: {
		permission: "content:edit_any",
		methods: ["POST"],
		handler: async (r, ctx) =>
			guard(async () => {
				const o = obj(r.input);
				const key = str(o, "job_key", { required: true })!;
				const m = meter(ctx);
				if (bool(o, "cancel")) {
					await cancelJob(m, key);
					return jobAnswer(await getJob(m, key));
				}
				const res = await runStep(m, key);
				if (m.limit <= SAFE_STEP_BUDGET || !res.job || res.job.state !== "running") return jobAnswer(res.job ?? (await getJob(m, key)), res.outcome);
				// No subrequest limit on this host: keep stepping for up to LOOP_MS, each step with
				// its own meter, so one call moves a large job a long way.
				const started = Date.now();
				let job = res.job;
				let total = res.outcome;
				while (job.state === "running" && Date.now() - started < LOOP_MS) {
					const next = await runStep(meter(ctx), key);
					if (!next.job) break;
					job = next.job;
					total = sumOutcomes(total, next.outcome);
					// Finishing waits for steps still in flight elsewhere: do not spin on it.
					if (next.outcome.phase === "finishing" && job.state === "running") break;
				}
				return jobAnswer(job, total);
			}),
	},

	update: {
		permission: "content:edit_any",
		methods: ["POST"],
		handler: async (r, ctx) =>
			guard(async () => {
				const o = obj(r.input);
				const conf = await settings(ctx);
				const m = meter(ctx, conf.stepSize);
				const collection = str(o, "collection", { required: true })!;
				const id = str(o, "id", { required: true })!;
				const raw = o.operations;
				const ops = (Array.isArray(raw) ? raw : raw && typeof raw === "object" ? [raw] : []) as Operation[];
				const schema = await loadCollection(m.ctx, collection, { withTaxonomies: ops.some((x) => typeof x?.field === "string" && x.field.startsWith("terms:")) });
				const job = await createSingleJob(m, { schema: withSingle(schema, conf.single), edits: { [id]: ops }, mode: parseMode(o), cacheRefresh: conf.cacheRefresh, budget: m.limit, actor: actorOf(r), claimFirst: true });
				const res = await runFirstClaimed(m, job);
				return jobAnswer(res.job, res.outcome);
			}),
	},

	edits: {
		// Grid saves: many entries, explicit per-entry operations, one job.
		permission: "content:edit_any",
		methods: ["POST"],
		handler: async (r, ctx) =>
			guard(async () => {
				const o = obj(r.input);
				const conf = await settings(ctx);
				const m = meter(ctx, conf.stepSize);
				const collection = str(o, "collection", { required: true })!;
				const edits = record(o, "edits");
				if (!edits) throw new LynxError("BAD_ARGUMENT", "edits must be an object of entry id to a list of operations.");
				const all = Object.values(edits).flatMap((x) => (Array.isArray(x) ? x : [])) as Operation[];
				const schema = await loadCollection(m.ctx, collection, { withTaxonomies: all.some((x) => typeof x?.field === "string" && x.field.startsWith("terms:")) });
				const job = await createSingleJob(m, { schema: withSingle(schema, conf.single), edits: edits as Record<string, Operation[]>, mode: parseMode(o), cacheRefresh: conf.cacheRefresh, budget: m.limit, actor: actorOf(r), claimFirst: true });
				const res = await runFirstClaimed(m, job);
				return jobAnswer(res.job, res.outcome);
			}),
	},

	history: {
		permission: "content:read",
		methods: ["GET", "POST"],
		handler: async (r, ctx) =>
			guard(async () => {
				const o = obj(r.input);
				const limit = int(o, "limit", { min: 1, max: 100, def: 20 })!;
				const jobKey = str(o, "job_key");
				const s = stores(ctx);
				if (jobKey) {
					// One job in detail: its answer plus the entries it did not write, and why.
					const job = await getJob(meter(ctx), jobKey);
					const res = await s.history.query({ where: { jobKey, kind: { in: ["invalid", "held", "failure", "conflict"] } }, limit: Math.min(limit, 50) });
					const leftAlone = res.items.map(({ data: d }) => ({
						entry_id: d.entryId,
						why: d.kind === "failure" ? "failed" : d.kind,
						...(d.problems ? { problems: d.problems } : {}),
						...(d.message ? { message: d.message } : {}),
					}));
					return { ...jobAnswer(job), left_alone: leftAlone, ...(res.hasMore ? { more_left_alone: true } : {}), note: notes.historyJob };
				}
				const cursor = str(o, "cursor");
				const [res, total] = await Promise.all([s.jobs.query({ orderBy: { createdAt: "desc" }, limit, ...(cursor ? { cursor } : {}) }), s.jobs.count()]);
				return {
					total,
					...(res.cursor ? { cursor: res.cursor } : {}),
					jobs: res.items.map(({ data: j }) => ({
						job_key: j.jobKey,
						kind: j.kind,
						state: j.state,
						collection: j.collection,
						summary: j.summary,
						fields: j.fields,
						total: j.total,
						mode: j.spec.mode,
						started: j.createdAt,
						finished: j.finishedAt ?? null,
						author: j.userName ?? null,
						via_mcp: j.viaMcp,
						...(j.result ? { result: j.result } : {}),
						...(j.rolledBackBy ? { rolled_back_by: j.rolledBackBy } : {}),
						...(j.rollbackOf ? { rollback_of: j.rollbackOf } : {}),
					})),
					note: notes.history,
				};
			}),
	},

	rollback: {
		permission: "content:edit_any",
		methods: ["POST"],
		handler: async (r, ctx) =>
			guard(async () => {
				const o = obj(r.input);
				const conf = await settings(ctx);
				const m = meter(ctx, conf.stepSize);
				const source = await getJob(m, str(o, "job_key", { required: true })!);
				const job = await createRollbackJob(m, { source, force: bool(o, "force"), budget: m.limit, actor: actorOf(r) });
				const res = m.has(stepCalls(job)) ? await runStep(m, job.jobKey) : null;
				return jobAnswer(res?.job ?? job, res?.outcome);
			}),
	},

	"taxonomy/single": {
		permission: "content:edit_any",
		methods: ["POST"],
		handler: async (r, ctx) =>
			guard(async () => {
				const o = obj(r.input);
				return setSingle(ctx, str(o, "taxonomy", { required: true })!, bool(o, "single") !== false);
			}),
	},

	"memory/get": {
		permission: "content:read",
		methods: ["GET", "POST"],
		handler: async (_r, ctx) => guard(async () => ({ entries: await getMemory(ctx), note: notes.memoryGet })),
	},

	"memory/set": {
		permission: "content:edit_any",
		methods: ["POST"],
		handler: async (r, ctx) =>
			guard(async () => {
				const o = obj(r.input);
				const entries = record(o, "entries");
				if (!entries) throw new LynxError("BAD_ARGUMENT", 'entries must be an object of key to a short sentence, e.g. {"table_columns":"Always show price, year and mileage."}. Nothing was saved.');
				return setMemory(ctx, entries, actorOf(r).userId);
			}),
	},

	cases: {
		permission: "content:read",
		methods: ["GET", "POST"],
		handler: async (_r, ctx) => guard(async () => ({ cases: await listCases(ctx), note: notes.cases })),
	},

	case: {
		permission: "content:read",
		methods: ["POST"],
		handler: async (r, ctx) =>
			guard(async () => {
				const o = obj(r.input);
				const conf = await settings(ctx);
				return { ...(await runCase(meter(ctx), str(o, "id", { required: true })!, record(o, "params") ?? {}, conf)), note: notes.caseRun };
			}),
	},
};
