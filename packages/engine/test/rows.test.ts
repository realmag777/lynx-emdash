import { describe, expect, it } from "vitest";

import { planRollback, createdRecord, EDITED_SINCE, historyFor } from "../src/history.ts";
import { normalizeOperations } from "../src/operations.ts";
import { planBulk } from "../src/planner.ts";
import { applyNewRowUniqueConflicts, closest, planNewRows } from "../src/rows.ts";
import { columnMap } from "../src/schema.ts";
import { worstEntryCost, entryCost } from "../src/budget.ts";
import { carEntries, cars, terms } from "./fixtures.ts";

const codes = (p: { problems: Array<{ code: string }> }) => p.problems.map((x) => x.code);
const ops = (list: unknown[]) => normalizeOperations(list, { columns: columnMap(cars), terms });

describe("planNewRows", () => {
	it("accepts rows in the list_fields shape and coerces their values", () => {
		const plan = planNewRows(cars, [{ title: "Škoda Octavia", price: "18900", year: 2021, color: "Blue", "terms:make": ["bmw-3-series"], "terms:fuel": "diesel", status: "published" }], { terms });
		const r = plan.rows[0]!;
		expect(r.state).toBe("ok");
		expect(r.data).toEqual({ title: "Škoda Octavia", price: 18900, year: 2021, color: "blue" });
		expect(r.terms).toEqual({ make: ["t-3series", "t-bmw"], fuel: ["t-diesel"] });
		expect(r.publish).toBe(true);
		expect(plan.counts).toEqual({ total: 1, ok: 1, invalid: 0 });
		expect(plan.warnings.map((w) => w.code)).toContain("published_on_create");
	});

	it("reports every problem with a code and the closest valid value", () => {
		const plan = planNewRows(
			cars,
			[
				{ titel: "Typo", price: "cheap", year: 1900, color: "Bleu", vin: "short", "terms:fuel": ["disel"], status: "live", features: ["navigaton"], cover: "https://example.com/a.jpg" },
				{ id: "x", slug: "y", title: "Fine" },
			],
			{ terms },
		);
		const [a, b] = plan.rows;
		expect(a!.state).toBe("invalid");
		expect(codes(a!)).toEqual(expect.arrayContaining(["unknown_field", "wrong_type", "out_of_range", "not_in_options", "bad_format", "unknown_term", "missing_required"]));
		const by = (field: string) => a!.problems.find((p) => p.field === field)!;
		expect(by("titel")).toMatchObject({ code: "unknown_field", hint: "title" });
		expect(by("color")).toMatchObject({ code: "not_in_options", hint: "blue" });
		expect(by("terms:fuel")).toMatchObject({ code: "unknown_term", hint: "diesel" });
		expect(by("status")).toMatchObject({ code: "not_in_options" });
		expect(by("features")).toMatchObject({ code: "not_in_options", hint: "navigation" });
		expect(by("title")).toMatchObject({ code: "missing_required" });
		expect(b!.problems.map((p) => p.field)).toEqual(["id", "slug"]);
	});

	it("refuses a web address in an image field and points to import_media", () => {
		const withImage = { ...cars, fields: [...cars.fields, { slug: "cover", label: "Cover", type: "image" as const }] };
		const plan = planNewRows(withImage, [{ title: "A", cover: "https://example.com/a.jpg" }, { title: "B", cover: { id: "m1", provider: "local" } }]);
		expect(plan.rows[0]!.problems[0]).toMatchObject({ code: "wrong_type", field: "cover" });
		expect(plan.rows[0]!.problems[0]!.hint).toContain("import_media");
		expect(plan.rows[1]!.state).toBe("ok");
	});

	it("checks repeater rows against their sub-fields", () => {
		const withGallery = { ...cars, fields: [...cars.fields, { slug: "gallery", label: "Gallery", type: "repeater" as const, validation: { subFields: [{ slug: "image", label: "Image", type: "image", required: true }] } }] };
		const plan = planNewRows(withGallery, [{ title: "A", gallery: [{ image: { id: "m1" } }, { picture: { id: "m2" } }, { image: "https://x.test/a.jpg" }] }]);
		expect(plan.rows[0]!.problems.map((p) => `${p.code}:${p.field}`)).toEqual(["unknown_field:gallery[1].picture", "missing_required:gallery[1].image", "wrong_type:gallery[2].image"]);
	});

	it("finds unique values repeated in the batch and asks the caller about the rest", () => {
		const plan = planNewRows(cars, [
			{ title: "A", vin: "WBA8E5105K1234567" },
			{ title: "B", vin: "WBA8E5105K1234567" },
			{ title: "C", vin: "WAUZZZF45LA000009" },
		]);
		expect(plan.rows.map((r) => r.state)).toEqual(["invalid", "invalid", "ok"]);
		expect(plan.uniqueChecks).toEqual([{ field: "vin", values: ["WAUZZZF45LA000009"] }]);
		applyNewRowUniqueConflicts(plan, "vin", new Map([["WAUZZZF45LA000009", ["c9"]]]));
		expect(plan.rows[2]!.problems[0]).toMatchObject({ code: "duplicate_unique" });
		expect(plan.counts).toEqual({ total: 3, ok: 0, invalid: 3 });
	});

	it("suggests only plausible neighbours", () => {
		expect(closest("disel", ["diesel", "petrol"])).toBe("diesel");
		expect(closest("hydrogen", ["diesel", "petrol"])).toBeUndefined();
	});
});

describe("duplicate and trash", () => {
	it("plans draft copies: title marked, unique fields emptied, terms copied, later operations shape the copy", () => {
		const plan = planBulk(cars, carEntries(), ops([{ field: "entry", behavior: "duplicate" }, { field: "price", behavior: "decrease_by", value: 1000 }]));
		const c1 = plan.entries[0]!;
		expect(c1.state).toBe("change");
		expect(c1.data).toEqual({});
		expect(c1.create!.data).toMatchObject({ title: "BMW 320d Touring (Copy)", price: 17900, year: 2019 });
		expect(c1.create!.data.vin).toBeUndefined();
		expect(c1.create!.terms).toEqual({ make: ["t-bmw", "t-3series"], fuel: ["t-diesel"] });
		expect(plan.warnings.map((w) => w.code)).toContain("copies_are_drafts");
		expect(entryCost(c1)).toBe(1 + 1 + 1 + 2);
		expect(worstEntryCost(ops([{ field: "entry", behavior: "duplicate" }]), { mode: "draft", revisions: true, cacheRefresh: "republish", taxonomies: 2 })).toBe(5);
	});

	it("refuses to repeat a required unique value on a copy", () => {
		const strict = { ...cars, fields: cars.fields.map((f) => (f.slug === "vin" ? { ...f, required: true } : f)) };
		const plan = planBulk(strict, carEntries().slice(0, 1), normalizeOperations([{ field: "entry", behavior: "duplicate" }], { columns: columnMap(strict), terms }));
		expect(plan.entries[0]!.state).toBe("invalid");
		expect(plan.entries[0]!.problems[0]!.message).toContain("create_entries");
	});

	it("keeps whole-entry operations apart from the rest", () => {
		expect(() => ops([{ field: "entry", behavior: "trash" }, { field: "price", behavior: "set", value: 1 }])).toThrow(/trash must be the only operation/);
		expect(() => ops([{ field: "price", behavior: "set", value: 1 }, { field: "entry", behavior: "duplicate" }])).toThrow(/duplicate must be the first operation/);
		expect(() => ops([{ field: "entry", behavior: "duplicate" }, { field: "status", behavior: "publish" }])).toThrow(/Copies are created as drafts/);
	});

	it("plans trash and its rollback, which publishes again what was live", () => {
		const plan = planBulk(cars, carEntries(), ops([{ field: "entry", behavior: "trash" }]));
		expect(plan.entries.map((e) => e.statusAction)).toEqual(["trash", "trash", "trash"]);
		expect(plan.warnings.find((w) => w.code === "to_trash")!.text).toContain("2 of them are live");
		const e = carEntries()[0]!;
		const rec = historyFor({ jobKey: "j", collection: "cars", plan: plan.entries[0]!, current: e, at: "t", viaMcp: false });
		expect(rec).toMatchObject({ lifecycle: "trashed", published: true });
		expect(planRollback(rec, e)).toMatchObject({ state: "restore", lifecycle: "untrash", publishAfterWrite: true });
		expect(planRollback(rec, null)).toMatchObject({ state: "nothing" });
	});

	it("undoes a created entry by trashing it, unless it was edited since", () => {
		const rec = createdRecord({ jobKey: "j", collection: "cars", entryId: "n1", locale: "en", title: "New", at: "t", data: { title: "New" }, version: 2, published: true, viaMcp: true });
		const e = { ...carEntries()[0]!, id: "n1", version: 2 };
		expect(planRollback(rec, e)).toMatchObject({ state: "restore", lifecycle: "trash" });
		expect(planRollback(rec, { ...e, version: 3 })).toMatchObject({ state: "conflict", conflicts: [{ field: EDITED_SINCE }] });
		expect(planRollback(rec, { ...e, version: 3 }, true)).toMatchObject({ state: "restore", lifecycle: "trash" });
		expect(planRollback(rec, null)).toMatchObject({ state: "nothing" });
	});
});

describe("step shape", () => {
	it("keeps the base of an entry in one step and spreads its term writes", async () => {
		const { shapeStep, splitTermUnits, termUnits } = await import("../src/budget.ts");
		// A copy with six taxonomies: read, source terms, create = 3; six term writes.
		expect(shapeStep({ base: 3, terms: 6 }, 8)).toEqual({ k: 1, cost: 6, inlineTerms: 3, termChunk: 4 });
		expect(shapeStep({ base: 3, terms: 0 }, 8)).toMatchObject({ k: 2, inlineTerms: 0 });
		expect(shapeStep({ base: 3, terms: 6 }, 200)).toMatchObject({ inlineTerms: 6, k: 22 });
		expect(() => shapeStep({ base: 7, terms: 0 }, 8)).toThrow(/cannot be spread/);
		const units = termUnits({ a: { add: ["1"], remove: ["2"] }, b: { add: ["3"], remove: [] }, c: { add: [], remove: ["4"] } });
		expect(units.map((u) => `${u.tax}:${u.op}`)).toEqual(["a:add", "a:remove", "b:add", "c:remove"]);
		expect(splitTermUnits(units, 1, 2)).toEqual({ now: [units[0]], later: [[units[1], units[2]], [units[3]]] });
	});
});
