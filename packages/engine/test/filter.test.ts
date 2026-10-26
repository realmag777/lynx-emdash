import { describe, expect, it } from "vitest";

import { EngineError } from "../src/errors.ts";
import { compileFilter, matchesFilter } from "../src/filter.ts";
import { columnMap } from "../src/schema.ts";
import { carEntries, cars, terms } from "./fixtures.ts";

const cols = columnMap(cars);
const compile = (f: unknown) => compileFilter(f, cols, terms);
const select = (f: unknown) => {
	const c = compile(f);
	// Simulate the host part too, so tests cover the whole selection.
	return carEntries()
		.filter((e) => (c.host.status ? e.status === c.host.status : true))
		.filter((e) =>
			Object.entries(c.host.fieldFilters).every(([k, v]) => {
				const x = e.data[k] as number;
				if (v && typeof v === "object" && "in" in (v as object)) return ((v as { in: unknown[] }).in).includes(x);
				if (v && typeof v === "object") {
					const r = v as { gt?: number; gte?: number; lt?: number; lte?: number };
					if (x === null || x === undefined) return false;
					return (r.gt === undefined || x > r.gt) && (r.gte === undefined || x >= r.gte) && (r.lt === undefined || x < r.lt) && (r.lte === undefined || x <= r.lte);
				}
				return x === v;
			}),
		)
		.filter((e) => matchesFilter(e, c, cols))
		.map((e) => e.id);
};

function refusal(f: unknown): string {
	try {
		compile(f);
	} catch (e) {
		expect(e).toBeInstanceOf(EngineError);
		return (e as EngineError).message;
	}
	throw new Error("expected refusal");
}

describe("compileFilter", () => {
	it("pushes indexed conditions to the host and keeps the rest for scanning", () => {
		const c = compile({ status: "published", where: { price: { gte: 10000, lt: 20000 }, transmission: "automatic", title: { contains: "bmw" } } });
		expect(c.host).toEqual({ status: "published", fieldFilters: { price: { gte: 10000, lt: 20000 }, transmission: "automatic" } });
		expect(c.scan).toEqual([{ field: "title", op: "contains", value: "bmw" }]);
		expect(c.needsScan).toBe(true);
		expect(c.empty).toBe(false);
	});

	it("never drops a condition when eq and a range meet on one field", () => {
		const c = compile({ where: { price: { eq: 18900, gt: 100 } } });
		expect(c.host.fieldFilters).toEqual({ price: 18900 });
		expect(c.scan).toEqual([{ field: "price", op: "gt", value: 100 }]);
	});

	it("reports an empty filter", () => {
		expect(compile({}).empty).toBe(true);
		expect(compile(undefined).summary).toBe("everything");
		// Readable summaries (they show in the history of jobs).
		expect(compile({ status: "published", where: { price: { gte: 10000, lt: 20000 }, transmission: "automatic", title: { contains: "bmw" }, color: { empty: false } } }).summary).toBe('published, Price ≥ 10000 and < 20000, Transmission = "automatic", Title contains "bmw", Colour is not empty');
	});

	it("refuses unknown keys, wrong shapes and unknown terms, all at once", () => {
		const msg = refusal({ price: 5, where: { nope: 1, year: { gte: "old" }, title: { lt: 3 } }, terms: { make: { any: ["tesla"] }, colour: {} } });
		expect(msg).toContain("nothing was selected");
		expect(msg).toContain('Put field conditions under where');
		expect(msg).toContain("nope: unknown field");
		expect(msg).toContain("year: gte takes a number");
		expect(msg).toContain("title: lt works on number and date fields only");
		expect(msg).toContain("unknown terms tesla");
		expect(msg).toContain('no taxonomy "colour"');
	});

	it("moves oversized in-lists to scanning", () => {
		const many = Array.from({ length: 60 }, (_, i) => 1990 + (i % 40));
		const c = compile({ where: { year: { in: many } } });
		expect(c.host.fieldFilters).toEqual({});
		expect(c.scan[0]!.op).toBe("in");
	});

	it("coerces operands to the field type", () => {
		const c = compile({ where: { transmission: "Automatic", price: { lte: "20000" } } });
		expect(c.host.fieldFilters).toEqual({ transmission: "automatic", price: { lte: 20000 } });
	});
});

describe("matching", () => {
	it("selects by host and scan conditions together", () => {
		expect(select({ where: { price: { lt: 20000 } } })).toEqual(["c1"]);
		expect(select({ where: { title: { contains: "AUDI" } } })).toEqual(["c2"]);
		expect(select({ where: { price: { empty: true } } })).toEqual(["c3"]);
		expect(select({ where: { color: { ne: "blue" } } })).toEqual(["c2", "c3"]);
		expect(select({ where: { features: "navigation" } })).toEqual(["c1"]);
		expect(select({ where: { description: { contains: "sea view" } } })).toEqual(["c1"]);
		expect(select({ status: ["draft", "published"] })).toEqual(["c1", "c2", "c3"]);
	});

	it("filters by terms without including children of a parent", () => {
		expect(select({ terms: { make: { any: ["bmw-3-series"] } } })).toEqual(["c1"]);
		expect(select({ terms: { make: { exists: false } } })).toEqual(["c3"]);
		expect(select({ terms: { fuel: { none: ["petrol"] } } })).toEqual(["c1"]);
		expect(select({ terms: { make: { all: ["audi", "audi-a4"] } } })).toEqual(["c2"]);
	});
});
