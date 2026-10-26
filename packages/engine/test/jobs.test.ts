import { describe, expect, it } from "vitest";

import { BridgeCounter, chunkByBudget, entriesPerStep, entryCost, SAFE_STEP_BUDGET, STEP_OVERHEAD, worstEntryCost } from "../src/budget.ts";
import { EngineError } from "../src/errors.ts";
import { historyFor, planRollback } from "../src/history.ts";
import { normalizeOperations } from "../src/operations.ts";
import { planBulk } from "../src/planner.ts";
import { columnMap } from "../src/schema.ts";
import { checkConfirmCount, durationWords, isExpired, makeSelection, newJobKey, newSelectionId, SELECTION_MAX } from "../src/selection.ts";
import type { Entry } from "../src/types.ts";
import { carEntries, cars, terms } from "./fixtures.ts";

const ops = (list: unknown[]) => normalizeOperations(list, { columns: columnMap(cars), terms, now: new Date("2026-09-29T12:00:00Z") });

describe("budget", () => {
	it("counts bridge calls per entry", () => {
		const base = { data: {}, termDelta: {} };
		expect(entryCost(base)).toBe(1);
		expect(entryCost({ ...base, data: { a: 1 } })).toBe(2);
		expect(entryCost({ ...base, data: { a: 1 }, publishAfterWrite: "publish_mode" })).toBe(3);
		expect(entryCost({ ...base, statusAction: "publish" })).toBe(2);
		expect(entryCost({ ...base, data: { a: 1 }, statusAction: "publish" })).toBe(3);
		expect(entryCost({ ...base, termDelta: { make: { add: ["x"], remove: ["y"] } } })).toBe(4);
		expect(entryCost({ ...base, termDelta: { make: { add: ["x"], remove: [] } } }, { termsLoaded: true })).toBe(2);
	});

	it("meets the Stage 3 target: 3 draft entries and 2 publish entries per 8-call step", () => {
		const o = { revisions: true, cacheRefresh: "republish" as const };
		const price = ops([{ field: "price", behavior: "increase_percent", value: 5 }]);
		expect(worstEntryCost(price, { ...o, mode: "draft" })).toBe(2);
		expect(worstEntryCost(price, { ...o, mode: "publish" })).toBe(3);
		expect(entriesPerStep(2)).toBe(3);
		expect(entriesPerStep(3)).toBe(2);
		expect(STEP_OVERHEAD + 3 * 2).toBe(SAFE_STEP_BUDGET);
		expect(STEP_OVERHEAD + 2 * 3).toBe(SAFE_STEP_BUDGET);
		// Non-revision collection: re-publish for the cache costs the same as publish mode.
		expect(worstEntryCost(price, { revisions: false, cacheRefresh: "republish", mode: "draft" })).toBe(3);
		expect(worstEntryCost(price, { revisions: false, cacheRefresh: "none", mode: "draft" })).toBe(2);
		// set_terms needs a terms read plus add and remove.
		expect(worstEntryCost(ops([{ field: "terms:fuel", behavior: "set_terms", value: ["diesel"] }]), { ...o, mode: "draft" })).toBe(4);
		expect(entriesPerStep(9)).toBe(1);
	});

	it("splits into steps that respect the budget and keep order", () => {
		const steps = chunkByBudget([1, 2, 3, 4, 5, 6, 7], () => 2, SAFE_STEP_BUDGET);
		expect(steps.map((s) => s.items)).toEqual([[1, 2, 3], [4, 5, 6], [7]]);
		expect(steps.every((s) => s.calls <= SAFE_STEP_BUDGET)).toBe(true);
		expect(steps[0]!.calls).toBe(STEP_OVERHEAD + 6);
	});

	it("runs an over-budget item alone and flags it", () => {
		const steps = chunkByBudget(["a", "big", "b"], (x) => (x === "big" ? 9 : 1), 8);
		expect(steps.map((s) => [s.items, s.overBudget])).toEqual([
			[["a"], false],
			[["big"], true],
			[["b"], false],
		]);
	});

	it("plans real entries within the safe budget", () => {
		const plan = planBulk(cars, carEntries(), ops([{ field: "price", behavior: "increase_percent", value: 5 }]), { mode: "publish" });
		const steps = chunkByBudget(plan.entries.filter((e) => e.state === "change"), (e) => entryCost(e));
		expect(steps.every((s) => s.calls <= SAFE_STEP_BUDGET && !s.overBudget)).toBe(true);
	});

	it("counts calls through nested proxies", async () => {
		const counter = new BridgeCounter();
		const ctx = counter.wrap({ kv: { get: async () => 1 }, content: { list: async () => ({ items: [] }) }, plugin: { id: "lynx" } });
		await ctx.kv.get();
		await ctx.content.list();
		expect(ctx.plugin.id).toBe("lynx");
		expect(counter.calls).toBe(2);
		expect(counter.log).toEqual(["ctx.kv.get", "ctx.content.list"]);
	});
});

describe("selection", () => {
	const rnd = (n: number) => new Uint8Array(n).map((_, i) => i * 7);

	it("makes ids and keys of a fixed shape", () => {
		expect(newSelectionId(rnd)).toMatch(/^sel_[A-Za-z2-9]{16}$/);
		expect(newJobKey()).toMatch(/^job_[A-Za-z2-9]{16}$/);
		expect(newSelectionId()).not.toBe(newSelectionId());
	});

	it("freezes, pages, dedupes and expires", () => {
		const now = new Date("2026-09-29T00:00:00Z");
		const ids = Array.from({ length: 4500 }, (_, i) => `e${i}`).concat(["e1"]);
		const { record, pages } = makeSelection({ id: "sel_x", collection: "cars", ids, filter: {}, summary: "everything", wholeCollection: true, now });
		expect(record.count).toBe(4500);
		expect(pages.map((p) => p.length)).toEqual([2000, 2000, 500]);
		expect(isExpired(record, new Date("2026-09-29T23:59:00Z"))).toBe(false);
		expect(isExpired(record, new Date("2026-09-30T00:00:00Z"))).toBe(true);
		expect(() => makeSelection({ id: "s", collection: "c", ids: Array.from({ length: SELECTION_MAX + 1 }, (_, i) => `${i}`), filter: {}, summary: "", wholeCollection: false })).toThrow(EngineError);
	});

	it("guards confirm_count", () => {
		expect(() => checkConfirmCount({ count: 19 }, 19)).not.toThrow();
		expect(() => checkConfirmCount({ count: 19 }, "19")).not.toThrow();
		expect(() => checkConfirmCount({ count: 19 }, 18)).toThrow("confirm_count is 18 but this selection holds 19 entries");
		expect(() => checkConfirmCount({ count: 19 }, undefined)).toThrow("confirm_count was not given");
		expect(durationWords(23 * 3600_000 + 40 * 60000)).toBe("24 hours");
		expect(durationWords(90_000)).toBe("2 minutes");
	});
});

describe("history and rollback", () => {
	const plan = planBulk(cars, carEntries(), ops([
		{ field: "price", behavior: "increase_by", value: 1000 },
		{ field: "terms:fuel", behavior: "add_terms", value: ["electric"] },
	]), { terms });
	const entry = carEntries()[0]!;
	const rec = historyFor({ jobKey: "job_1", collection: "cars", plan: plan.entries[0]!, current: entry, at: "2026-09-29T12:00:00Z", viaMcp: true });

	it("records before and after values", () => {
		expect(rec.before).toEqual({ data: { price: 18900 }, terms: { fuel: ["t-diesel"] } });
		expect(rec.after).toEqual({ data: { price: 19900 }, terms: { fuel: ["t-diesel", "t-electric"] } });
		expect(rec.viaMcp).toBe(true);
	});

	const afterJob = (patch: Partial<Entry["data"]> = {}, fuel = ["t-diesel", "t-electric"]): Entry => ({ ...entry, data: { ...entry.data, price: 19900, ...patch }, terms: { ...entry.terms, fuel } });

	it("restores what the job wrote", () => {
		const r = planRollback(rec, afterJob());
		expect(r.state).toBe("restore");
		expect(r.data).toEqual({ price: 18900 });
		expect(r.termDelta).toEqual({ fuel: { add: [], remove: ["t-electric"] } });
	});

	it("leaves fields changed since the job alone, unless forced", () => {
		const changed = afterJob({ price: 25000 });
		const r = planRollback(rec, changed);
		expect(r.data).toEqual({});
		expect(r.conflicts).toEqual([{ field: "price", recorded: 19900, current: 25000 }]);
		expect(r.state).toBe("restore"); // terms still revert
		expect(planRollback(rec, changed, true).data).toEqual({ price: 18900 });
	});

	it("writes the old slug back even when the entry shows it (the new one waits in a draft)", () => {
		const slugRec = { ...rec, before: { ...rec.before, slug: "old-slug" }, after: { ...rec.after, slug: "new-slug" } };
		expect(planRollback(slugRec, { ...afterJob(), slug: "old-slug" }).slug).toBe("old-slug");
		expect(planRollback(slugRec, { ...afterJob(), slug: "new-slug" }).slug).toBe("old-slug");
		expect(planRollback(slugRec, { ...afterJob(), slug: "someone-else" }).conflicts).toContainEqual({ field: "slug", recorded: "new-slug", current: "someone-else" });
	});

	it("does nothing when already restored, and reports missing entries", () => {
		expect(planRollback(rec, { ...entry }).state).toBe("nothing");
		expect(planRollback(rec, null).state).toBe("missing");
	});

	it("reverses status actions", () => {
		const p = planBulk(cars, carEntries(), ops([{ field: "status", behavior: "publish" }]));
		const r = historyFor({ jobKey: "j", collection: "cars", plan: p.entries[2]!, current: carEntries()[2]!, at: "t", viaMcp: false });
		expect(r.after.status).toBe("published");
		expect(planRollback(r, { ...carEntries()[2]!, status: "published" }).statusAction).toBe("unpublish");
		expect(planRollback(r, { ...carEntries()[2]!, status: "draft" }).state).toBe("conflict");
	});
});
