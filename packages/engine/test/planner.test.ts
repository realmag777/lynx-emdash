import { describe, expect, it } from "vitest";

import { normalizeOperations } from "../src/operations.ts";
import { applyUniqueConflicts, planBulk } from "../src/planner.ts";
import { columnMap } from "../src/schema.ts";
import { carEntries, cars, plainCollection, terms } from "./fixtures.ts";

const now = new Date("2026-09-29T12:00:00Z");
const ops = (list: unknown[], collection = cars) => normalizeOperations(list, { columns: columnMap(collection), terms, now });
const codes = (p: { warnings: Array<{ code: string }> }) => p.warnings.map((w) => w.code);

describe("planBulk", () => {
	it("chains operations in order on the values the previous ones leave", () => {
		const plan = planBulk(cars, carEntries(), ops([
			{ field: "price", behavior: "increase_percent", value: 10 },
			{ field: "price", behavior: "round", step: 100, direction: "down", ending: 90 },
		]));
		const c1 = plan.entries[0]!;
		expect(c1.state).toBe("change");
		expect(c1.data).toEqual({ price: 20790 });
		expect(c1.changes[0]).toMatchObject({ field: "price", before: 18900, after: 20790, display: { before: "18900", after: "20790" } });
		expect(plan.entries[1]!.data).toEqual({ price: 23590 });
		expect(plan.entries[2]!.state).toBe("unchanged");
		expect(plan.counts).toEqual({ total: 3, change: 2, unchanged: 1, invalid: 0, held: 0 });
		expect(codes(plan)).toEqual(expect.arrayContaining(["percent_not_reversible", "percent_on_empty_field", "saved_as_draft"]));
	});

	it("holds live entries with pending draft edits in publish mode, and warns in draft mode", () => {
		const entries = carEntries().map((e, i) => (i === 0 ? { ...e, status: "published", draftRevisionId: "rev-1" } : { ...e, status: "published" }));
		const o = ops([{ field: "price", behavior: "increase_by", value: 1 }]);
		const pub = planBulk(cars, entries, o, { mode: "publish" });
		expect(pub.entries[0]!.state).toBe("held");
		expect(pub.counts.held).toBe(1);
		expect(pub.warnings.find((w) => w.code === "pending_drafts")).toMatchObject({ count: 1, ids: [entries[0]!.id] });
		const draft = planBulk(cars, entries, o, { mode: "draft" });
		expect(draft.entries[0]!.state).toBe("change");
		expect(codes(draft)).toContain("on_pending_drafts");
	});

	it("is deterministic", () => {
		const o = ops([{ field: "title", behavior: "append", value: "!" }]);
		expect(planBulk(cars, carEntries(), o)).toEqual(planBulk(cars, carEntries(), o));
	});

	it("marks an entry invalid as a whole when any change breaks a rule", () => {
		const plan = planBulk(cars, carEntries(), ops([
			{ field: "year", behavior: "increase_by", value: 12 },
			{ field: "title", behavior: "append", value: " 2" },
		]));
		// 2019+12 and 2020+12 exceed max 2030; 2016+12 = 2028 is fine.
		expect(plan.entries.map((e) => e.state)).toEqual(["invalid", "invalid", "change"]);
		expect(plan.entries[0]!.problems[0]!.rule).toBe("max");
		expect(codes(plan)).toContain("invalid_entries");
		expect(plan.warnings.find((w) => w.code === "invalid_entries")!.text).toContain("2 entries fail");
	});

	it("re-checks the shape after text edits (a VIN must still match its pattern)", () => {
		const plan = planBulk(cars, carEntries(), ops([{ field: "vin", behavior: "append", value: "X" }]));
		expect(plan.entries[0]!.state).toBe("invalid");
	});

	it("detects duplicate unique values inside the selection and asks for the rest", () => {
		const plan = planBulk(cars, carEntries(), ops([{ field: "vin", behavior: "set", value: "WBA8E5105K1234567" }]));
		// c1 already has it (unchanged); c2 and c3 would both get it.
		expect(plan.entries.map((e) => e.state)).toEqual(["unchanged", "invalid", "invalid"]);
		expect(plan.entries[1]!.problems[0]!.rule).toBe("unique");

		const plan2 = planBulk(cars, carEntries().slice(1, 2), ops([{ field: "vin", behavior: "set", value: "WBA8E5105K1234567" }]));
		expect(plan2.uniqueChecks).toEqual([{ field: "vin", locale: null, values: ["WBA8E5105K1234567"] }]);
		applyUniqueConflicts(plan2, "vin", new Map([["WBA8E5105K1234567", ["c1"]]]));
		expect(plan2.entries[0]!.state).toBe("invalid");
		expect(plan2.counts).toMatchObject({ change: 0, invalid: 1 });
	});

	it("computes term deltas, adds parents, and warns that set_terms replaces", () => {
		const plan = planBulk(cars, carEntries(), ops([
			{ field: "terms:make", behavior: "add_terms", value: ["audi-a4"] },
			{ field: "terms:fuel", behavior: "set_terms", value: ["electric"] },
		]), { terms });
		const c1 = plan.entries[0]!;
		expect(c1.termDelta.make).toEqual({ add: ["t-a4", "t-audi"], remove: [] });
		expect(c1.termDelta.fuel).toEqual({ add: ["t-electric"], remove: ["t-diesel"] });
		expect(c1.changes.find((c) => c.field === "terms:fuel")!.display).toEqual({ before: "Diesel", after: "Electric" });
		expect(plan.entries[1]!.termDelta.make).toBeUndefined();
		expect(codes(plan)).toContain("set_terms_replaces");
	});

	it("plans status actions and skips entries already in that state", () => {
		const plan = planBulk(cars, carEntries(), ops([{ field: "status", behavior: "unpublish" }]));
		expect(plan.entries.map((e) => e.statusAction)).toEqual(["unpublish", "unpublish", undefined]);
		expect(codes(plan)).toContain("status_already_set");
		const pub = planBulk(cars, carEntries(), ops([{ field: "status", behavior: "publish" }]));
		expect(pub.entries.map((e) => e.statusAction)).toEqual([undefined, undefined, "publish"]);
	});

	it("publishes live entries in publish mode on revisions collections only", () => {
		const o = ops([{ field: "color", behavior: "set", value: "silver" }]);
		const plan = planBulk(cars, carEntries(), o, { mode: "publish" });
		expect(plan.entries.map((e) => e.publishAfterWrite)).toEqual(["publish_mode", "publish_mode", undefined]);
		expect(plan.warnings.find((w) => w.code === "publish_mode")!.text).toContain("1 entry that is not live stays a draft");
	});

	it("re-publishes published entries of non-revision collections to refresh cached pages", () => {
		const o = ops([{ field: "color", behavior: "set", value: "silver" }], plainCollection);
		const plan = planBulk(plainCollection, carEntries(), o);
		expect(plan.entries.map((e) => e.publishAfterWrite)).toEqual(["cache_refresh", "cache_refresh", undefined]);
		expect(codes(plan)).toContain("cache_refresh_republish");
		expect(codes(plan)).not.toContain("saved_as_draft");
		const none = planBulk(plainCollection, carEntries(), o, { cacheRefresh: "none" });
		expect(none.entries.every((e) => !e.publishAfterWrite)).toBe(true);
	});

	it("flags non-translatable fields for translation sync", () => {
		const plan = planBulk(cars, carEntries(), ops([{ field: "price", behavior: "set", value: 1000 }]));
		expect(plan.entries[0]!.syncFields).toEqual(["price"]);
		expect(codes(plan)).toContain("translation_sync");
	});

	it("normalises stored booleans before comparing", () => {
		const plan = planBulk(cars, carEntries(), ops([{ field: "featured", behavior: "set", value: true }]));
		expect(plan.entries[0]!.state).toBe("unchanged");
		expect(plan.entries[1]!.changes[0]).toMatchObject({ before: false, after: true });
	});

	it("uses the system slug with per-locale uniqueness", () => {
		const plan = planBulk(cars, carEntries(), ops([{ field: "slug", behavior: "slugify", source: "title" }]));
		expect(plan.entries.map((e) => e.slug)).toEqual([undefined, undefined, undefined]);
		const dup = planBulk(cars, carEntries(), ops([{ field: "slug", behavior: "set", value: "same" }]));
		expect(dup.entries.every((e) => e.state === "invalid")).toBe(true);
	});
});
