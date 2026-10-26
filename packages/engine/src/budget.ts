import type { NormalizedOperation } from "./operations.ts";
import type { EntryPlan, SaveMode } from "./planner.ts";
import { EngineError } from "./errors.ts";
import { taxonomyOfKey } from "./schema.ts";

// Sandbox budget. On Cloudflare every ctx.* call is a bridge RPC and one plugin
// invocation may make 10 subrequests.
// Step model:
//   claim            storage.jobs.updateIf        1
//   history+receipt  storage.history.putMany      1
//   per entry        getVersioned                 1
//                    update                       1 (if data changes)
//                    publish (computed _rev)      1 (publish mode / cache refresh / status action)
//                    terms read + add/remove      1 + 1 per delta kind

/** Hard platform limit per invocation on Cloudflare. */
export const PLATFORM_SUBREQUEST_LIMIT = 10;

/** Default ceiling LYNX plans for: two calls of headroom under the platform limit. */
export const SAFE_STEP_BUDGET = 8;

/** Ceiling for hosts without a subrequest limit (in-process or Node.js runner). */
export const FAST_STEP_BUDGET = 200;

/** Calls a step spends besides its entries: the claim and the one history putMany. */
export const STEP_OVERHEAD = 2;

/** Bridge calls needed to apply one planned entry. */
export function entryCost(p: Pick<EntryPlan, "data" | "slug" | "termDelta" | "statusAction" | "publishAfterWrite" | "create">, opts: { termsLoaded?: boolean } = {}): number {
	let calls = 1; // getVersioned: before-values and the _rev the publish is computed from
	if (p.create) return calls + (opts.termsLoaded ? 0 : 1) + 1 + Object.keys(p.create.terms).length; // + source terms, create, addEntryTerms per taxonomy
	if (p.statusAction === "trash") return calls + 1; // content.delete
	const writesData = Object.keys(p.data).length > 0 || p.slug !== undefined;
	if (writesData) calls += 1; // content.update
	const deltas = Object.values(p.termDelta);
	if (deltas.length && !opts.termsLoaded) calls += 1; // taxonomies.getEntryTerms
	for (const d of deltas) {
		if (d.add.length) calls += 1; // addEntryTerms
		if (d.remove.length) calls += 1; // removeEntryTerms
	}
	if (p.statusAction || p.publishAfterWrite) calls += 1; // publish/unpublish/schedule with a computed _rev
	return calls;
}

/**
 * Worst-case calls per entry for a job's operations, known before any entry is read.
 * A step claims floor((budget - overhead - extra) / cost) entries.
 */
export function worstEntryCost(ops: NormalizedOperation[], options: { mode: SaveMode; revisions: boolean; cacheRefresh: "republish" | "none"; taxonomies?: number }): number {
	const c = worstStepCost(ops, options);
	return c.base + c.terms;
}

/**
 * Calls per entry split in two: `base` must happen in one step (read, write, create, publish);
 * `terms` (one call per taxonomy and kind of term change) can be spread over later steps.
 */
export interface StepCost {
	base: number;
	terms: number;
}

export function worstStepCost(ops: NormalizedOperation[], options: { mode: SaveMode; revisions: boolean; cacheRefresh: "republish" | "none"; taxonomies?: number }): StepCost {
	if (ops[0]?.behavior === "trash") return { base: 2, terms: 0 }; // read, content.delete
	if (ops[0]?.behavior === "duplicate") {
		const taxonomies = options.taxonomies ?? 0;
		return { base: 1 + (taxonomies ? 1 : 0) + 1, terms: taxonomies }; // read, source terms, create | addEntryTerms per taxonomy
	}
	let base = 1;
	let terms = 0;
	const writesData = ops.some((o) => !taxonomyOfKey(o.column.key) && o.column.key !== "status");
	if (writesData) base += 1;
	const taxOps = ops.filter((o) => taxonomyOfKey(o.column.key));
	if (taxOps.length) {
		base += 1; // getEntryTerms: the planner needs the current terms
		for (const tax of new Set(taxOps.map((o) => o.column.key))) {
			const kinds = new Set(taxOps.filter((o) => o.column.key === tax).flatMap((o) => (o.behavior === "set_terms" ? ["add", "remove"] : o.behavior === "add_terms" ? ["add"] : ["remove"])));
			terms += kinds.size;
		}
	}
	const status = ops.some((o) => o.column.key === "status");
	const publishes = status || (writesData && (options.revisions ? options.mode === "publish" : options.cacheRefresh === "republish"));
	if (publishes) base += 1;
	return { base, terms };
}

/** Calls a pending-terms step spends besides the term writes: claim, receipt count, query, delete. */
export const TERMS_STEP_OVERHEAD = 4;

export interface StepShape {
	/** Entries per claimed step. */
	k: number;
	/** Calls per entry a step plans for (base + inline terms). */
	cost: number;
	/** Term calls done in the entry's own step; the rest waits as pending term chunks. */
	inlineTerms: number;
	/** Term calls per pending chunk (one pending-terms step handles at least one chunk). */
	termChunk: number;
}

/**
 * Size a job's steps. An entry that needs more than one step is split: its base (read, write,
 * create, publish) in its own step with as many term calls as still fit, the other term calls
 * in pending chunks that later steps apply. Only a base that alone does not fit is refused.
 */
export function shapeStep(c: StepCost, budget: number, extraPerEntry = 0): StepShape {
	const room = budget - STEP_OVERHEAD;
	const base = c.base + extraPerEntry;
	if (base > room) {
		throw new EngineError(
			"STEP_TOO_LARGE",
			`One entry of this change needs ${base} host calls that cannot be spread over several steps, more than one step may make (${room}). Nothing was done. Split the change into smaller jobs.`,
		);
	}
	const inlineTerms = Math.min(c.terms, room - base);
	const cost = base + inlineTerms;
	return { k: Math.max(1, Math.floor(room / Math.max(1, cost))), cost, inlineTerms, termChunk: Math.max(1, budget - TERMS_STEP_OVERHEAD) };
}

/** One term write: add or remove some terms of one taxonomy on one entry. */
export interface TermUnit {
	tax: string;
	op: "add" | "remove";
	ids: string[];
}

export function termUnits(delta: Record<string, { add: string[]; remove: string[] }>): TermUnit[] {
	const out: TermUnit[] = [];
	for (const [tax, d] of Object.entries(delta)) {
		if (d.add.length) out.push({ tax, op: "add", ids: d.add });
		if (d.remove.length) out.push({ tax, op: "remove", ids: d.remove });
	}
	return out;
}

/** Split term writes into the ones done now and the pending chunks. */
export function splitTermUnits(units: TermUnit[], inline: number, chunk: number): { now: TermUnit[]; later: TermUnit[][] } {
	const now = units.slice(0, inline);
	const later: TermUnit[][] = [];
	for (let i = inline; i < units.length; i += chunk) later.push(units.slice(i, i + chunk));
	return { now, later };
}

/** How many entries one step may claim. Always at least 1. */
export function entriesPerStep(costPerEntry: number, budget = SAFE_STEP_BUDGET, extraCalls = 0): number {
	return Math.max(1, Math.floor((budget - STEP_OVERHEAD - extraCalls) / Math.max(1, costPerEntry)));
}

export interface Step<T> {
	items: T[];
	calls: number;
	/** A single item that alone exceeds the budget still runs, flagged. */
	overBudget: boolean;
}

/** Greedy split into steps whose cost fits `budget - overhead`. Order is preserved. */
export function chunkByBudget<T>(items: T[], cost: (item: T) => number, budget = SAFE_STEP_BUDGET, overhead = STEP_OVERHEAD): Step<T>[] {
	const room = Math.max(1, budget - overhead);
	const steps: Step<T>[] = [];
	let current: Step<T> = { items: [], calls: overhead, overBudget: false };
	for (const item of items) {
		const c = cost(item);
		if (current.items.length && current.calls + c > budget) {
			steps.push(current);
			current = { items: [], calls: overhead, overBudget: false };
		}
		current.items.push(item);
		current.calls += c;
		if (c > room) current.overBudget = true;
	}
	if (current.items.length) steps.push(current);
	return steps;
}

/** Counts bridge calls made through a wrapped object; used by tests and the step runner. */
export class BridgeCounter {
	calls = 0;
	readonly log: string[] = [];

	wrap<T extends object>(target: T, path = "ctx"): T {
		return new Proxy(target, {
			get: (obj, prop, receiver) => {
				const value = Reflect.get(obj, prop, receiver);
				if (typeof prop === "symbol") return value;
				if (typeof value === "function") {
					return (...args: unknown[]) => {
						this.calls++;
						this.log.push(`${path}.${prop}`);
						return (value as (...a: unknown[]) => unknown).apply(obj, args);
					};
				}
				if (value && typeof value === "object") return this.wrap(value as object, `${path}.${prop}`);
				return value;
			},
		});
	}

	reset(): void {
		this.calls = 0;
		this.log.length = 0;
	}
}
