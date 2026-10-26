import { describe, expect, it } from "vitest";

import { validateValue } from "../src/validate.ts";
import { coerceValue, displayValue, isEmptyValue, parseDatetime, parseNumber, stableStringify, valuesEqual } from "../src/values.ts";
import { cars } from "./fixtures.ts";

const field = (slug: string) => cars.fields.find((f) => f.slug === slug)!;

describe("parseNumber", () => {
	it("accepts lossless forms and refuses ambiguous ones", () => {
		expect(parseNumber("12.5")).toBe(12.5);
		expect(parseNumber(" 7 ")).toBe(7);
		expect(parseNumber("12,5")).toBe(12.5);
		expect(parseNumber("1,234")).toBeNull();
		expect(parseNumber("12 000")).toBeNull();
		expect(parseNumber("abc")).toBeNull();
		expect(parseNumber(Infinity)).toBeNull();
	});
});

describe("parseDatetime", () => {
	it("normalises dates to ISO with offset", () => {
		expect(parseDatetime("2026-09-07")).toBe("2026-09-07T00:00:00.000Z");
		expect(parseDatetime("2026-09-07 14:30")).toBe("2026-09-07T14:30:00.000Z");
		expect(parseDatetime("2026-09-07T14:30:00+02:00")).toBe("2026-09-07T12:30:00.000Z");
		expect(parseDatetime("next friday")).toBeNull();
	});
});

describe("coerceValue", () => {
	it("coerces per field type", () => {
		expect(coerceValue(field("price"), "18900")).toEqual({ ok: true, value: 18900 });
		expect(coerceValue(field("year"), "2019.5").ok).toBe(false);
		expect(coerceValue(field("featured"), "yes")).toEqual({ ok: true, value: true });
		expect(coerceValue(field("featured"), "maybe").ok).toBe(false);
		expect(coerceValue(field("transmission"), "Automatic")).toEqual({ ok: true, value: "automatic" });
		expect(coerceValue(field("transmission"), "cvt").ok).toBe(false);
		expect(coerceValue(field("features"), "navigation, tow_bar")).toEqual({ ok: true, value: ["navigation", "tow_bar"] });
		expect(coerceValue(field("website"), "ftp://x").ok).toBe(false);
		expect(coerceValue(field("website"), "/cars/bmw")).toEqual({ ok: true, value: "/cars/bmw" });
		expect(coerceValue(field("description"), "Hello")).toMatchObject({ ok: true });
		expect(coerceValue(field("available_from"), "2026-10-01")).toEqual({ ok: true, value: "2026-10-01T00:00:00.000Z" });
		expect(coerceValue({ slug: "img", label: "Img", type: "image" }, "m1")).toEqual({ ok: true, value: { id: "m1" } });
		expect(coerceValue(field("title"), null)).toEqual({ ok: true, value: null });
	});
});

describe("validateValue", () => {
	it("applies EmDash rules", () => {
		expect(validateValue(field("price"), -5).map((p) => p.rule)).toEqual(["min"]);
		expect(validateValue(field("year"), 2040).map((p) => p.rule)).toEqual(["max"]);
		expect(validateValue(field("vin"), "SHORT").map((p) => p.rule)).toEqual(["pattern"]);
		expect(validateValue(field("vin"), "WBA8E5105K1234567")).toEqual([]);
		expect(validateValue(field("title"), null).map((p) => p.rule)).toEqual(["required"]);
		expect(validateValue(field("title"), "").map((p) => p.rule)).toEqual(["required"]);
		expect(validateValue(field("transmission"), "cvt").map((p) => p.rule)).toEqual(["options"]);
		expect(validateValue(field("features"), ["navigation", "jetpack"]).map((p) => p.rule)).toEqual(["options"]);
		expect(validateValue({ slug: "g", label: "Gallery", type: "repeater", validation: { maxItems: 1 } }, [{}, {}]).map((p) => p.rule)).toEqual(["maxItems"]);
	});
});

describe("equality and emptiness", () => {
	it("compares structurally and treats empty forms alike", () => {
		expect(valuesEqual({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toBe(true);
		expect(valuesEqual(null, "")).toBe(true);
		expect(valuesEqual([], null)).toBe(true);
		expect(valuesEqual(1, "1")).toBe(false);
		expect(isEmptyValue([{ _type: "block", children: [{ _type: "span", text: "  " }] }])).toBe(true);
		expect(stableStringify({ b: 1, a: undefined })).toBe('{"b":1}');
		expect(displayValue(field("featured"), 1)).toBe("yes");
		expect(displayValue(field("title"), "x".repeat(200), 10)).toBe("xxxxxxxxx…");
	});
});
