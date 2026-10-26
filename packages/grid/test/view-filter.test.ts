import { describe, expect, it } from "vitest";

import type { FieldInfo } from "../src/model/api.ts";
import { buildGridColumns } from "../src/model/columns.ts";
import { activeFilterCount, emptyFilter, filterFields, opsFor, toEntryFilter, unindexedFields, type FilterState } from "../src/model/filter.ts";
import { defaultView, moveColumn, nextSort, reconcileView, resizeColumn, toggleHidden, togglePinned, visibleColumns } from "../src/model/view.ts";

const f = (key: string, type: string, extra: Partial<FieldInfo> = {}): FieldInfo => ({ key, label: key, type, editable: true, bulk: true, filter: "host", sortable: false, behaviors: ["set"], required: false, unique: false, translatable: true, ...extra });
const FIELDS: FieldInfo[] = [
	f("id", "id", { editable: false, filter: "none" }),
	f("status", "status"),
	f("updated_at", "datetime", { editable: false, filter: "scan" }),
	f("title", "string"),
	f("price", "number"),
	f("featured", "boolean"),
	f("color", "select", { options: ["black", "white"] }),
	f("description", "portableText", { filter: "scan" }),
	f("terms:fuel", "terms", { filter: "terms" }),
];
const cols = buildGridColumns(FIELDS);

describe("filter builder → core filter", () => {
	it("combines search, status, conditions and taxonomy conditions", () => {
		const state: FilterState = {
			search: " golf ",
			status: "published",
			conditions: [
				{ id: "a", field: "price", op: "gte", value: "10000" },
				{ id: "b", field: "price", op: "lt", value: "20000" },
				{ id: "c", field: "color", op: "in", value: "black, white" },
				{ id: "d", field: "featured", op: "eq", value: "false" },
				{ id: "e", field: "description", op: "empty", value: "" },
				{ id: "f", field: "title", op: "contains", value: "  " },
			],
			terms: [
				{ id: "t", taxonomy: "fuel", mode: "any", ids: ["t1", "t2"] },
				{ id: "u", taxonomy: "fuel", mode: "none", ids: ["t3"] },
			],
		};
		expect(toEntryFilter(state, FIELDS, "title")).toEqual({
			status: "published",
			where: {
				title: { contains: "golf" },
				price: { gte: "10000", lt: "20000" },
				color: { in: ["black", "white"] },
				featured: { eq: false },
				description: { empty: true },
			},
			terms: { fuel: { any: ["t1", "t2"], none: ["t3"] } },
		});
		expect(activeFilterCount(state)).toBe(8);
		expect(toEntryFilter(emptyFilter(), FIELDS, "title")).toEqual({});
	});

	it("offers conditions that fit the field type and leaves taxonomies and ids out of field rows", () => {
		expect(opsFor(f("n", "integer"))).toContain("gte");
		expect(opsFor(f("s", "string"))).not.toContain("gte");
		expect(opsFor(f("b", "boolean"))).toEqual(["eq"]);
		// Only indexed fields (and system ones) are offered; the others are named as indexable.
		expect(filterFields(FIELDS).map((x) => x.key)).toEqual(["updated_at", "title", "price", "featured", "color"]);
		expect(unindexedFields(FIELDS).map((x) => x.key)).toEqual(["description"]);
	});
});

describe("view layout", () => {
	it("starts with the title pinned first, system details hidden, newest first", () => {
		const v = defaultView(cols);
		expect(v.order[0]).toBe("title");
		expect(v.pinned).toEqual(["title"]);
		expect(v.hidden).toContain("id");
		expect(v.sort).toEqual({ key: "updated_at", dir: "desc" });
		expect(visibleColumns(cols, v)[0]).toMatchObject({ key: "title", pinned: true });
	});

	it("moves, resizes, hides and pins columns", () => {
		let v = defaultView(cols);
		const before = visibleColumns(cols, v).map((c) => c.key);
		v = moveColumn(v, "price", -1);
		const after = visibleColumns(cols, v).map((c) => c.key);
		expect(after.indexOf("price")).toBe(before.indexOf("price") - 1);
		v = resizeColumn(v, "price", 9999);
		expect(visibleColumns(cols, v).find((c) => c.key === "price")!.width).toBe(640);
		v = toggleHidden(v, "price");
		expect(visibleColumns(cols, v).some((c) => c.key === "price")).toBe(false);
		v = togglePinned(toggleHidden(v, "price"), "price");
		expect(visibleColumns(cols, v).slice(0, 2).map((c) => c.key)).toEqual(["title", "price"]);
	});

	it("cycles one sort at a time and reconciles stored views with a changed schema", () => {
		expect(nextSort(null, "price")).toEqual({ key: "price", dir: "asc" });
		expect(nextSort({ key: "price", dir: "asc" }, "price")).toEqual({ key: "price", dir: "desc" });
		expect(nextSort({ key: "price", dir: "desc" }, "price")).toEqual({ key: "updated_at", dir: "desc" });
		const stored = { order: ["gone", "price", "title"], hidden: ["gone"], widths: { gone: 100, price: 200 }, pinned: ["gone"], sort: { key: "gone", dir: "asc" as const }, pageSize: 37, density: "compact" as const };
		const v = reconcileView(stored, cols);
		expect(v.order.slice(0, 2)).toEqual(["price", "title"]);
		expect(v.order).toHaveLength(cols.length);
		expect(v.hidden).toEqual([]);
		expect(v.widths).toEqual({ price: 200 });
		expect(v.pinned).toEqual([]);
		expect(v.sort).toEqual({ key: "updated_at", dir: "desc" });
		expect(v.pageSize).toBe(50);
		expect(v.density).toBe("compact");
	});
});
