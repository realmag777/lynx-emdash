import { describe, expect, it } from "vitest";

import { addParagraphs, countInPortableText, fromPlainText, replaceInPortableText, toPlainText, type PTBlock } from "../src/portable-text.ts";

const span = (key: string, text: string, marks: string[] = []) => ({ _type: "span" as const, _key: key, text, marks });
const block = (key: string, children: unknown[], markDefs: unknown[] = []): PTBlock => ({ _type: "block", _key: key, style: "normal", markDefs, children });

describe("replaceInPortableText", () => {
	it("replaces inside one span and keeps keys and marks", () => {
		const value = [block("b1", [span("s1", "Great sea view flat", ["strong"])])];
		const res = replaceInPortableText(value, { find: "sea view", replace: "ocean view" });
		expect(res.count).toBe(1);
		expect(res.value).toEqual([block("b1", [span("s1", "Great ocean view flat", ["strong"])])]);
	});

	it("finds a phrase split across spans and gives the replacement the first span's marks", () => {
		const value = [block("b1", [span("s1", "Great sea "), span("s2", "view", ["strong"]), span("s3", " flat")])];
		const res = replaceInPortableText(value, { find: "sea view", replace: "ocean view" });
		expect(res.count).toBe(1);
		expect(res.crossedMarks).toBe(1);
		const children = (res.value[0]!.children ?? []) as Array<{ _key: string; text: string; marks: string[] }>;
		expect(children.map((c) => c._key)).toEqual(["s1", "s3"]);
		expect(children.map((c) => c.text)).toEqual(["Great ocean view", " flat"]);
		expect(toPlainText(res.value)).toBe("Great ocean view flat");
	});

	it("keeps the tail of a partially matched later span", () => {
		const value = [block("b1", [span("s1", "sea"), span("s2", " viewpoint", ["em"])])];
		const res = replaceInPortableText(value, { find: "sea view", replace: "X" });
		const children = res.value[0]!.children as Array<{ text: string; marks: string[] }>;
		expect(children.map((c) => [c.text, c.marks])).toEqual([
			["X", []],
			["point", ["em"]],
		]);
	});

	it("keeps links (markDefs) untouched", () => {
		const markDefs = [{ _type: "link", _key: "l1", href: "https://example.com" }];
		const value = [block("b1", [span("s1", "see "), span("s2", "our offer", ["l1"])], markDefs)];
		const res = replaceInPortableText(value, { find: "offer", replace: "deal" });
		expect(res.value[0]!.markDefs).toEqual(markDefs);
		expect((res.value[0]!.children as Array<{ text: string; marks: string[] }>)[1]).toMatchObject({ text: "our deal", marks: ["l1"] });
	});

	it("does not match across inline objects", () => {
		const value = [block("b1", [span("s1", "sea "), { _type: "inlineIcon", _key: "i1" }, span("s2", "view")])];
		expect(replaceInPortableText(value, { find: "sea view", replace: "X" }).count).toBe(0);
	});

	it("keeps one empty span when a whole run is deleted", () => {
		const value = [block("b1", [span("s1", "delete "), span("s2", "me", ["strong"])])];
		const res = replaceInPortableText(value, { find: "delete me", replace: "" });
		expect(res.value[0]!.children).toEqual([span("s1", "")]);
	});

	it("leaves non-text blocks and pre-existing empty spans alone, and does not mutate input", () => {
		const image = { _type: "image", _key: "img", asset: { _ref: "m1" } };
		const value = [image, block("b1", [span("s0", ""), span("s1", "old")])];
		const snapshot = JSON.stringify(value);
		const res = replaceInPortableText(value, { find: "old", replace: "new" });
		expect(res.value[0]).toBe(image);
		expect(res.value[1]!.children).toEqual([span("s0", ""), span("s1", "new")]);
		expect(JSON.stringify(value)).toBe(snapshot);
	});

	it("supports regex with groups across spans and counts multiple matches", () => {
		const value = [block("b1", [span("s1", "Built 1998, "), span("s2", "renovated 2019", ["em"])])];
		const res = replaceInPortableText(value, { find: "(\\d{4})", replace: "[$1]", regex: true });
		expect(res.count).toBe(2);
		expect(toPlainText(res.value)).toBe("Built [1998], renovated [2019]");
	});

	it("returns the same block object when nothing changes", () => {
		const b = block("b1", [span("s1", "nothing")]);
		expect(replaceInPortableText([b], { find: "zzz", replace: "y" }).value[0]).toBe(b);
	});
});

describe("portable text helpers", () => {
	it("counts, converts and appends", () => {
		const value = fromPlainText("First paragraph.\n\nSecond one.");
		expect(value).toHaveLength(2);
		expect(toPlainText(value)).toBe("First paragraph.\n\nSecond one.");
		expect(countInPortableText(value, { find: "one" })).toBe(1);
		const more = addParagraphs(value, "Third.", "append");
		expect(toPlainText(more)).toBe("First paragraph.\n\nSecond one.\n\nThird.");
		expect(toPlainText(addParagraphs(null, "Only.", "prepend"))).toBe("Only.");
	});
});
