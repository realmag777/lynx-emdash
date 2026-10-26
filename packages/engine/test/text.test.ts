import { describe, expect, it } from "vitest";

import { buildMatcher, changeCase, normalizeWhitespace, PatternError, replaceText, slugify } from "../src/text.ts";

describe("replaceText", () => {
	it("replaces plain text case-insensitively by default", () => {
		expect(replaceText("Sea view, SEA VIEW", { find: "sea view", replace: "ocean view" })).toEqual({ text: "ocean view, ocean view", count: 2 });
	});

	it("respects caseSensitive", () => {
		expect(replaceText("Sea sea", { find: "sea", replace: "x", caseSensitive: true })).toEqual({ text: "Sea x", count: 1 });
	});

	it("treats regex metacharacters literally in plain mode", () => {
		expect(replaceText("price (EUR) 1.5", { find: "(EUR)", replace: "€" }).text).toBe("price € 1.5");
		expect(replaceText("a.b", { find: ".", replace: "!" }).text).toBe("a!b");
	});

	it("matches whole words with Unicode letters", () => {
		expect(replaceText("car cart scar car", { find: "car", replace: "auto", wholeWord: true }).text).toBe("auto cart scar auto");
		expect(replaceText("ñcar car", { find: "car", replace: "X", wholeWord: true }).text).toBe("ñcar X");
	});

	it("expands regex groups, named groups and $$", () => {
		expect(replaceText("2018-05", { find: "(\\d{4})-(\\d{2})", replace: "$2/$1", regex: true }).text).toBe("05/2018");
		expect(replaceText("5 km", { find: "(?<n>\\d+) km", replace: "$<n>000 m", regex: true }).text).toBe("5000 m");
		expect(replaceText("10", { find: "\\d+", replace: "$$$&", regex: true }).text).toBe("$10");
	});

	it("keeps lookbehind context when expanding replacements", () => {
		expect(replaceText("€100 $100", { find: "(?<=€)(\\d+)", replace: "[$1]", regex: true }).text).toBe("€[100] $100");
	});

	it("rejects empty, oversized and invalid patterns", () => {
		expect(() => buildMatcher({ find: "" })).toThrow(PatternError);
		expect(() => buildMatcher({ find: "x".repeat(501) })).toThrow(PatternError);
		expect(() => buildMatcher({ find: "(", regex: true })).toThrow(PatternError);
	});

	it("returns count 0 and the same text when nothing matches", () => {
		expect(replaceText("abc", { find: "z", replace: "y" })).toEqual({ text: "abc", count: 0 });
	});
});

describe("text helpers", () => {
	it("changes case", () => {
		expect(changeCase("hello WORLD", "upper")).toBe("HELLO WORLD");
		expect(changeCase("hello WORLD", "title")).toBe("Hello World");
		expect(changeCase("HELLO. WORLD here", "sentence")).toBe("Hello. World here");
		expect(changeCase("ÁLVARO", "lower")).toBe("álvaro");
	});

	it("normalizes whitespace and slugifies", () => {
		expect(normalizeWhitespace("  a \n\t b  ")).toBe("a b");
		expect(slugify("Škoda Octavia 2.0 TDI — Combi")).toBe("skoda-octavia-2-0-tdi-combi");
	});
});
