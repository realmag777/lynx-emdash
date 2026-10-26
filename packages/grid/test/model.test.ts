import { describe, expect, it } from "vitest";

import type { FieldInfo, GridRow } from "../src/model/api.ts";
import { buildGridColumns, defaultOrder, titleColumn } from "../src/model/columns.ts";
import { batches, checkValue, dirtyCount, setDirty, toOperations, type Dirty } from "../src/model/edits.ts";
import { moveActive } from "../src/model/keyboard.ts";
import { pageItems } from "../src/model/pagination.ts";
import { copyText, parseTsv, planPaste, toTsv } from "../src/model/paste.ts";
import { emptySelection, toggleAllLoaded, toggleRow } from "../src/model/selection.ts";

const f = (key: string, type: string, extra: Partial<FieldInfo> = {}): FieldInfo => ({ key, label: key, type, editable: true, bulk: true, filter: "host", sortable: false, behaviors: ["set"], required: false, unique: false, translatable: true, ...extra });
const FIELDS: FieldInfo[] = [
	f("id", "id", { editable: false }),
	f("slug", "slug"),
	f("status", "status"),
	f("title", "string", { required: true }),
	f("price", "number"),
	f("year", "integer"),
	f("featured", "boolean"),
	f("color", "select", { options: ["black", "white"] }),
	f("cover", "image"),
	f("terms:fuel", "terms"),
	f("entry", "entry"),
];
const cols = buildGridColumns(FIELDS);
const byKey = new Map(cols.map((c) => [c.key, c]));
const row = (id: string, data: Record<string, unknown>, terms?: Record<string, string[]>): GridRow => ({ id, slug: id, status: "published", locale: "en", updated_at: null, published_at: null, draft: false, data, ...(terms ? { terms } : {}) });

describe("pagination window (Botoscope algorithm, fixed)", () => {
	const nums = (current: number, pages: number) => pageItems(current, pages).map((i) => (i.type === "page" ? (i.current ? `[${i.page + 1}]` : String(i.page + 1)) : i.type === "dots" ? "…" : i.type));
	it("shows every page up to 10 and a window above", () => {
		expect(nums(0, 1)).toEqual([]);
		expect(nums(1, 4)).toEqual(["prev", "1", "[2]", "3", "4", "next"]);
		expect(nums(0, 12)).toEqual(["prev", "[1]", "2", "3", "…", "10", "11", "12", "next"]);
		expect(nums(6, 12)).toEqual(["prev", "1", "2", "3", "…", "6", "[7]", "8", "…", "10", "11", "12", "next"]);
	});
	it("keeps the last page reachable near the end (Botoscope lost it)", () => {
		expect(nums(9, 12)).toEqual(["prev", "1", "2", "3", "…", "9", "[10]", "11", "12", "next"]);
		expect(pageItems(11, 12).at(-1)).toEqual({ type: "next", page: null });
	});
});

describe("columns", () => {
	it("maps field types to editors and puts the title first", () => {
		expect(byKey.get("price")).toMatchObject({ editor: "number", align: "end" });
		expect(byKey.get("featured")?.editor).toBe("switch");
		expect(byKey.get("terms:fuel")).toMatchObject({ editor: "terms", taxonomy: "fuel" });
		expect(byKey.get("id")?.editor).toBe("readonly");
		expect(byKey.has("entry")).toBe(false);
		expect(titleColumn(cols)).toBe("title");
		expect(defaultOrder(cols).slice(0, 2)).toEqual(["title", "status"]);
	});
});

describe("edits", () => {
	it("tracks dirty cells, drops edits back to the original and builds core operations", () => {
		const r = row("a", { title: "Car", price: 100, featured: 1 }, { fuel: ["t1"] });
		let d: Dirty = new Map();
		d = setDirty(d, r, byKey.get("price")!, 120);
		d = setDirty(d, r, byKey.get("featured")!, true);
		expect(dirtyCount(d)).toEqual({ cells: 1, rows: 1 });
		d = setDirty(d, r, byKey.get("terms:fuel")!, ["t2"]);
		d = setDirty(d, r, byKey.get("status")!, "draft");
		d = setDirty(d, r, byKey.get("color")!, null);
		expect(toOperations(d, byKey).a).toEqual([
			{ field: "price", behavior: "set", value: 120 },
			{ field: "terms:fuel", behavior: "set_terms", value: ["t2"] },
			{ field: "status", behavior: "unpublish" },
		]);
		d = setDirty(d, r, byKey.get("price")!, 100);
		expect(d.get("a")?.has("price")).toBe(false);
	});
	it("checks values like the engine", () => {
		expect(checkValue(byKey.get("year")!, "2019")).toEqual({ ok: true, value: 2019 });
		expect(checkValue(byKey.get("year")!, "20.5")).toMatchObject({ ok: false });
		expect(checkValue(byKey.get("color")!, "White")).toEqual({ ok: true, value: "white" });
		expect(checkValue(byKey.get("title")!, "")).toMatchObject({ ok: false, problem: "title is required" });
	});
	it("splits large saves into batches of 100", () => {
		const entries = Array.from({ length: 230 }, (_, i) => [`e${i}`, i] as [string, number]);
		expect(batches(entries).map((b) => Object.keys(b).length)).toEqual([100, 100, 30]);
	});
});

describe("selection", () => {
	const order = ["a", "b", "c", "d", "e"];
	it("toggles, extends with Shift and selects all loaded", () => {
		let s = toggleRow(emptySelection(), order, "b", false);
		s = toggleRow(s, order, "d", true);
		expect([...s.ids]).toEqual(["b", "c", "d"]);
		s = toggleRow(s, order, "c", false);
		expect([...s.ids].sort()).toEqual(["b", "d"]);
		expect(toggleAllLoaded(s, order).ids.size).toBe(5);
		expect(toggleAllLoaded(toggleAllLoaded(s, order), order).ids.size).toBe(0);
	});
});

describe("keyboard", () => {
	it("moves the active cell and wraps Tab across rows", () => {
		const m = (key: string, row = 1, col = 1, shift = false) => moveActive({ row, col }, key, { ctrl: false, shift }, 5, 4, 3);
		expect(m("ArrowRight")).toEqual({ row: 1, col: 2 });
		expect(m("ArrowUp", 0)).toEqual({ row: 0, col: 1 });
		expect(m("Tab", 1, 3)).toEqual({ row: 2, col: 0 });
		expect(m("Tab", 2, 0, true)).toEqual({ row: 1, col: 3 });
		expect(m("PageDown")).toEqual({ row: 4, col: 1 });
		expect(moveActive({ row: 2, col: 2 }, "End", { ctrl: true, shift: false }, 5, 4, 3)).toEqual({ row: 4, col: 3 });
		expect(m("x")).toBeNull();
	});
});

describe("copy and paste", () => {
	it("round-trips spreadsheet text with quotes, tabs and newlines", () => {
		const grid = [["a", 'say "hi"'], ["line1\nline2", "x\ty"]];
		expect(parseTsv(toTsv(grid))).toEqual(grid);
		expect(parseTsv("1\t2\r\n3\t4\r\n")).toEqual([["1", "2"], ["3", "4"]]);
	});
	it("maps a pasted block onto rows and columns with the engine's checks", () => {
		const rows = [row("a", { title: "A", price: 1, year: 2000 }), row("b", { title: "B", price: 2, year: 2001 })];
		const visible = [byKey.get("title")!, byKey.get("price")!, byKey.get("year")!, byKey.get("id")!];
		const res = planPaste("X\t10\t2010\tz\nY\tcheap\t2011", rows, visible, { row: 0, col: 0 });
		expect(res.edits).toEqual([
			{ rowId: "a", key: "title", value: "X" },
			{ rowId: "a", key: "price", value: 10 },
			{ rowId: "a", key: "year", value: 2010 },
			{ rowId: "b", key: "title", value: "Y" },
			{ rowId: "b", key: "year", value: 2011 },
		]);
		expect(res.problems).toEqual([{ rowId: "b", key: "price", problem: expect.stringContaining("number") }]);
		expect(res.skipped).toBe(1);
		expect(copyText(rows[0]!, byKey.get("price")!)).toBe("1");
	});
});
