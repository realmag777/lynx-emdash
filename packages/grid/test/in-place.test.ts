import { describe, expect, it } from "vitest";

import type { GridRow } from "../src/model/api.ts";
import { cellValue, withCellValue } from "../src/model/edits.ts";

// After a save the page shows the values in place instead of reloading (rows keep their order).
describe("saved values shown in place", () => {
	const row: GridRow = { id: "e1", slug: "car-1", status: "published", locale: "en", updated_at: "2026-10-01T10:00:00Z", published_at: null, draft: false, data: { price: 1000, title: "Car" }, terms: { fuel: ["diesel"] } } as GridRow;

	it("writes fields, terms, slug and status where cellValue reads them", () => {
		for (const [key, value] of [["price", 1200], ["terms:fuel", ["petrol", "hybrid"]], ["slug", "car-one"], ["status", "draft"], ["available_from", "2026-11-20T14:45:00.000Z"]] as const) {
			const next = withCellValue(row, key, value);
			expect(cellValue(next, key)).toEqual(value);
			expect(next).not.toBe(row);
		}
		expect(row.data.price).toBe(1000);
	});

	it("leaves read-only system values alone", () => {
		expect(withCellValue(row, "updated_at", "x")).toBe(row);
		expect(withCellValue(row, "id", "x")).toBe(row);
	});
});
