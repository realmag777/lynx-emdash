import { describe, expect, it } from "vitest";

import { BEHAVIORS } from "../src/schema.ts";
import { BEHAVIOR_LABEL, describeOperations, entriesText, readableSummary } from "../src/describe.ts";

const price = { key: "price", label: "Price" };
const fuel = { key: "terms:fuel", label: "Fuel" };
const title = { key: "title", label: "Title" };
const entry = { key: "entry", label: "Entry" };

describe("one dictionary for behaviours", () => {
	it("labels every behaviour", () => {
		for (const b of BEHAVIORS) expect(BEHAVIOR_LABEL[b]).toBeTruthy();
	});

	it("describes jobs in plain words, without internal names", () => {
		expect(describeOperations([{ op: { field: "price", behavior: "decrease_percent", value: 10 }, column: price }, { op: { field: "price", behavior: "round", step: 1 }, column: price }])).toBe("Price −10%, rounded");
		expect(describeOperations([{ op: { field: "price", behavior: "increase_by", value: 1500 }, column: price }], { number: (_k, v) => `€${v.toLocaleString("en-US")}` })).toBe("Price +€1,500");
		expect(describeOperations([{ op: { field: "terms:fuel", behavior: "add_terms", value: ["diesel"], termIds: ["t1"] }, column: fuel }], { termLabel: (id) => (id === "t1" ? "Diesel" : id) })).toBe("Fuel: + Diesel");
		expect(describeOperations([{ op: { field: "title", behavior: "replace", find: "Sport", replace: "S" }, column: title }])).toBe("Title: “Sport” → “S”");
		expect(describeOperations([{ op: { field: "entry", behavior: "trash" }, column: entry }])).toBe("Moved to trash");
		expect(describeOperations([{ op: { field: "price", behavior: "round", step: 100, direction: "down", ending: 99 }, column: price }])).toBe("Price rounded down to 100 ending 99");
		expect(entriesText(5000)).toBe("5,000 entries");
		expect(entriesText(1)).toBe("1 entry");
	});
});

describe("summaries written before the dictionary", () => {
	it("drop job ids and behaviour names", () => {
		expect(readableSummary("rollback of job_7puiEQoXCrPAPibi (published, year < 2020 → price decrease_percent, price round)")).toBe("Undo: Price: Decrease by %; Price: Round (published, year < 2020)");
		expect(readableSummary("everything → entry trash")).toBe("Move to trash");
		expect(readableSummary("create 3 entries in cars")).toBe("Created 3 entries");
		expect(readableSummary("edit of 2 entries: price, engine_l")).toBe("Edited Price, Engine l · 2 entries");
		expect(readableSummary("Price −10% · 5 entries")).toBe("Price −10% · 5 entries");
	});
});
