import { describe, expect, it } from "vitest";

import { newStore, Positions, putEntry, sortPositions } from "../src/server/store.ts";

// The column store of the grid's cached reads: values by position, sorting with empty values last.

function fill(rows: Array<Record<string, unknown>>) {
	const store = newStore("s1", [
		{ key: "price", type: "number" },
		{ key: "title", type: "string" },
		{ key: "from", type: "datetime" },
		{ key: "sold", type: "boolean" },
	], 2);
	const list = new Positions();
	rows.forEach((data, i) => list.push(putEntry(store, `e${i}`, data)));
	const order = (key: string, dir: "asc" | "desc") => Array.from(sortPositions(store, list, key, dir), (p) => store.ids[p]);
	return { store, list, order };
}

describe("column store", () => {
	const rows = [
		{ price: 300, title: "Model 10", from: "2026-03-01T00:00:00.000Z", sold: true },
		{ price: null, title: "", from: null },
		{ price: 100, title: "Model 2", from: "2026-01-15T00:00:00.000Z", sold: false },
		{ price: 200, title: "model 2", from: "2025-12-31T00:00:00.000Z" },
	];

	it("sorts numbers, dates, booleans and text (2 before 10, lower case first as before), empty values last both ways", () => {
		const { order } = fill(rows);
		expect(order("price", "asc")).toEqual(["e2", "e3", "e0", "e1"]);
		expect(order("price", "desc")).toEqual(["e0", "e3", "e2", "e1"]);
		expect(order("from", "asc")).toEqual(["e3", "e2", "e0", "e1"]);
		expect(order("title", "asc")).toEqual(["e3", "e2", "e0", "e1"]);
		expect(order("title", "desc")).toEqual(["e0", "e2", "e3", "e1"]);
		expect(order("sold", "desc")).toEqual(["e0", "e2", "e1", "e3"]);
	});

	it("grows past its first size, keeps one copy per entry and updates it in place", () => {
		const { store, list, order } = fill(rows);
		expect(store.capacity).toBeGreaterThanOrEqual(4);
		// The same entry read again (another filter): same position, new value.
		const again = putEntry(store, "e1", { price: 50, title: "A" });
		expect(again).toBe(1);
		expect(store.ids.length).toBe(4);
		expect(list.length).toBe(4);
		expect(order("price", "asc")).toEqual(["e1", "e2", "e3", "e0"]);
		// Repeated text is stored once.
		putEntry(store, "e9", { title: "Model 2" });
		const title = store.cols.get("title")!;
		expect(title.kind === "text" && title.words.filter((w) => w === "Model 2").length).toBe(1);
	});

	it("keeps nearly unique text (VIN, title) as plain strings, still sorted the same way", () => {
		const store = newStore("s1", [{ key: "vin", type: "string" }, { key: "color", type: "select" }]);
		const list = new Positions();
		const n = 5000;
		for (let i = 0; i < n; i++) list.push(putEntry(store, `e${i}`, { vin: i === 7 ? "" : `VIN${(n - i) % 3000}`, color: ["Red", "Blue"][i % 2] }));
		expect(store.cols.get("vin")!.kind).toBe("str");
		expect(store.cols.get("color")!.kind).toBe("text");
		const asc = Array.from(sortPositions(store, list, "vin", "asc"), (p) => store.ids[p]);
		// VIN0 (e2000), VIN1 (e1999, then e4999 in read order) …, and the empty one last.
		expect(asc.slice(0, 3)).toEqual(["e2000", "e1999", "e4999"]);
		expect(asc[n - 1]).toBe("e7");
		putEntry(store, "e7", { vin: "AAA" });
		expect(store.ids[sortPositions(store, list, "vin", "asc")[0]!]).toBe("e7");
	});
});
