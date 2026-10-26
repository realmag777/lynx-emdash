import { describe, expect, it } from "vitest";

import { EngineError } from "../src/errors.ts";
import { applyToValue, normalizeOperations, roundTo, shiftDate, withAncestors, type NormalizedOperation } from "../src/operations.ts";
import { buildColumns, columnMap } from "../src/schema.ts";
import { cars, terms } from "./fixtures.ts";

const ctx = { columns: columnMap(cars), terms, now: new Date("2026-09-29T12:00:00Z") };
const norm = (ops: unknown) => normalizeOperations(ops, ctx);
const one = (op: unknown) => norm([op])[0]!;
const run = (op: unknown, current: unknown, source?: unknown) => applyToValue(one(op) as NormalizedOperation, current, source);

function refusal(ops: unknown): EngineError {
	try {
		norm(ops);
	} catch (e) {
		return e as EngineError;
	}
	throw new Error("expected a refusal");
}

describe("schema columns", () => {
	it("derives editability, filter mode and units", () => {
		const cols = buildColumns(cars);
		const by = (k: string) => cols.find((c) => c.key === k)!;
		expect(by("price")).toMatchObject({ filter: "host", sortable: true, numeric: true, unit: "currency" });
		expect(by("mileage_km").unit).toBe("km");
		expect(by("title")).toMatchObject({ filter: "scan", sortable: true });
		expect(by("dealer")).toMatchObject({ editable: false, closed: "relation: edit it in the entry editor" });
		expect(by("id").editable).toBe(false);
		expect(by("status").behaviors).toEqual(["publish", "unpublish", "schedule", "unschedule"]);
		expect(by("terms:make")).toMatchObject({ kind: "terms", behaviors: ["add_terms", "remove_terms", "set_terms"] });
		expect(by("vin")).toMatchObject({ unique: true, translatable: false });
	});
});

describe("normalizeOperations", () => {
	it("refuses empty input with a usage example", () => {
		expect(refusal([]).code).toBe("NO_OPERATIONS");
	});

	it("collects every problem at once", () => {
		const e = refusal([
			{ field: "nope", behavior: "set", value: 1 },
			{ field: "price", behavior: "toggle" },
			{ field: "year", behavior: "set", value: "abc" },
			{ field: "id", behavior: "set", value: "x" },
		]);
		expect(e.code).toBe("BAD_OPERATION");
		const problems = (e.details as { problems: Array<{ code: string }> }).problems.map((p) => p.code);
		expect(problems).toEqual(["UNKNOWN_FIELD", "BAD_BEHAVIOR", "BAD_VALUE", "FIELD_READ_ONLY"]);
		expect(e.message).toContain("nothing was changed");
	});

	it("validates operands per behaviour", () => {
		expect(refusal([{ field: "price", behavior: "decrease_percent", value: 150 }]).message).toContain("negative");
		expect(refusal([{ field: "title", behavior: "clear" }]).message).toContain("required");
		expect(refusal([{ field: "title", behavior: "replace", find: "(", regex: true }]).code).toBe("INVALID_PATTERN");
		expect(refusal([{ field: "price", behavior: "round", step: 1, ending: 1.5 }]).message).toContain("ending");
		expect(refusal([{ field: "terms:make", behavior: "add_terms", value: ["tesla"] }]).message).toContain("never created");
		expect(refusal([{ field: "status", behavior: "schedule", value: "2020-01-01" }]).message).toContain("future");
		expect(refusal([{ field: "price", behavior: "copy_from", source: "nope" }]).code).toBe("UNKNOWN_FIELD");
		expect(refusal([{ field: "available_from", behavior: "shift_date", value: 1, unit: "fortnights" }]).message).toContain("unit");
	});

	it("defaults behaviour to set, accepts a single object, and coerces values", () => {
		const [op] = norm({ field: "price", value: "19990" });
		expect(op).toMatchObject({ behavior: "set", value: 19990 });
		expect(one({ field: "terms:make", behavior: "add_terms", value: ["bmw-3-series"] }).termIds).toEqual(["t-3series"]);
	});
});

describe("applyToValue", () => {
	it("does number arithmetic without float noise", () => {
		expect(run({ field: "price", behavior: "increase_percent", value: 10 }, 18900)).toEqual({ kind: "value", value: 20790 });
		expect(run({ field: "price", behavior: "decrease_by", value: 0.1 }, 0.3)).toEqual({ kind: "value", value: 0.2 });
		expect(run({ field: "price", behavior: "multiply", value: 1.1 }, 100)).toEqual({ kind: "value", value: 110 });
	});

	it("skips computed behaviours on empty values instead of writing 0", () => {
		expect(run({ field: "price", behavior: "increase_percent", value: 10 }, null)).toEqual({ kind: "skip", reason: "empty_value" });
		expect(run({ field: "price", behavior: "round" }, "")).toEqual({ kind: "skip", reason: "empty_value" });
	});

	it("rounds integers and says so", () => {
		expect(run({ field: "mileage_km", behavior: "increase_percent", value: 3 }, 1001)).toEqual({ kind: "value", value: 1031, notes: ["integer_rounded"] });
	});

	it("rounds with step, direction and price ending", () => {
		expect(roundTo(18943, 100)).toBe(18900);
		expect(roundTo(18943, 100, "up")).toBe(19000);
		expect(roundTo(18.43, 1, "nearest", 0.99)).toBe(17.99);
		expect(roundTo(18.43, 1, "up", 0.99)).toBe(18.99);
		expect(roundTo(18430, 1000, "up", 990)).toBe(18990);
		expect(run({ field: "price", behavior: "round", step: 100, direction: "down" }, 21549)).toEqual({ kind: "value", value: 21500 });
	});

	it("edits text", () => {
		expect(run({ field: "title", behavior: "append", value: "(sold)", separator: " " }, "BMW")).toEqual({ kind: "value", value: "BMW (sold)" });
		expect(run({ field: "title", behavior: "prepend", value: "NEW" }, "")).toEqual({ kind: "value", value: "NEW" });
		expect(run({ field: "title", behavior: "replace", find: "touring", replace: "Estate" }, "BMW 320d Touring")).toEqual({ kind: "value", value: "BMW 320d Estate", matches: 1 });
		expect(run({ field: "title", behavior: "replace", find: "zzz", replace: "x" }, "BMW")).toEqual({ kind: "skip", reason: "no_match" });
		expect(run({ field: "title", behavior: "change_case", case: "upper" }, "bmw")).toEqual({ kind: "value", value: "BMW" });
		expect(run({ field: "title", behavior: "trim" }, "  a  b ")).toEqual({ kind: "value", value: "a b" });
		expect(run({ field: "slug", behavior: "slugify", source: "title" }, "old", "Škoda Octavia")).toEqual({ kind: "value", value: "skoda-octavia" });
	});

	it("edits Portable Text in place", () => {
		const value = [{ _type: "block", _key: "b", children: [{ _type: "span", _key: "s", text: "sea ", marks: [] }, { _type: "span", _key: "t", text: "view", marks: ["strong"] }] }];
		const r = run({ field: "description", behavior: "replace", find: "sea view", replace: "ocean view" }, value);
		expect(r).toMatchObject({ kind: "value", matches: 1, notes: ["marks_crossed"] });
		const appended = run({ field: "description", behavior: "append", value: "Extra." }, value);
		expect((appended as { value: unknown[] }).value).toHaveLength(2);
	});

	it("copies between fields with coercion and percent", () => {
		expect(run({ field: "price", behavior: "copy_from", source: "year", percent: -10 }, 1, 2000)).toEqual({ kind: "value", value: 1800 });
		expect(run({ field: "title", behavior: "copy_from", source: "description" }, "", [{ _type: "block", children: [{ _type: "span", text: "Hi" }] }])).toEqual({ kind: "value", value: "Hi" });
		expect(run({ field: "title", behavior: "copy_from", source: "vin" }, "x", null)).toEqual({ kind: "skip", reason: "source_empty" });
	});

	it("handles booleans, options and dates", () => {
		expect(run({ field: "featured", behavior: "toggle" }, 1)).toEqual({ kind: "value", value: false });
		expect(run({ field: "features", behavior: "add_values", value: ["tow_bar", "navigation"] }, ["navigation"])).toEqual({ kind: "value", value: ["navigation", "tow_bar"] });
		expect(run({ field: "features", behavior: "remove_values", value: ["navigation"] }, ["navigation", "tow_bar"])).toEqual({ kind: "value", value: ["tow_bar"] });
		expect(run({ field: "color", behavior: "replace_value", from: "grey", value: "silver" }, "grey")).toEqual({ kind: "value", value: "silver" });
		expect(run({ field: "color", behavior: "replace_value", from: "grey", value: "silver" }, "red")).toEqual({ kind: "skip", reason: "no_match" });
		expect(run({ field: "available_from", behavior: "shift_date", value: 1, unit: "months" }, "2026-01-31T10:00:00.000Z")).toEqual({ kind: "value", value: "2026-02-28T10:00:00.000Z" });
		expect(shiftDate("2024-02-29T00:00:00Z", 1, "years")).toBe("2025-02-28T00:00:00.000Z");
		expect(shiftDate("2026-03-01T00:00:00Z", -1, "days")).toBe("2026-02-28T00:00:00.000Z");
	});

	it("adds ancestors of hierarchical terms", () => {
		expect(withAncestors(["t-3series"], terms.make!)).toEqual(["t-3series", "t-bmw"]);
	});
});

describe("one-term taxonomies", () => {
	const single = { ...cars, taxonomies: cars.taxonomies!.map((t) => (t.name === "make" ? { ...t, label: "Makes", labelSingular: "Make", single: true } : t)) };
	const sctx = { ...ctx, columns: columnMap(single) };
	it("names the column in the singular and offers no add_terms", () => {
		expect(buildColumns(single).find((c) => c.key === "terms:make")).toMatchObject({ label: "Make", behaviors: ["set_terms", "remove_terms"] });
	});
	it("refuses two terms, takes one", () => {
		expect(() => normalizeOperations([{ field: "terms:make", behavior: "set_terms", value: ["bmw", "audi"] }], sctx)).toThrow(/Make takes one term per entry; got 2/);
		expect(normalizeOperations([{ field: "terms:make", behavior: "set_terms", value: ["audi-a4"] }], sctx)[0]!.termIds).toEqual(["t-a4"]);
		expect(() => normalizeOperations([{ field: "terms:make", behavior: "add_terms", value: ["bmw"] }], sctx)).toThrow();
	});
});
