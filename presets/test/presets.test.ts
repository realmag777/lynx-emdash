import { coerceValue, validateValue, type FieldDef } from "@realmag777/lynx-engine";
import { validateSeed } from "emdash/seed";
import { describe, expect, it } from "vitest";

import { carsPreset } from "../src/cars.ts";
import type { Preset } from "../src/model.ts";
import { realEstatePreset } from "../src/real-estate.ts";
import { toSeed } from "../src/seed.ts";

// Fields whose names would collide with EmDash system columns.
const SYSTEM_COLUMNS = ["id", "slug", "status", "author_id", "primary_byline_id", "created_at", "updated_at", "published_at", "scheduled_at", "deleted_at", "version", "live_revision_id", "draft_revision_id", "locale", "translation_group"];

describe.each([carsPreset, realEstatePreset])("preset $id", (preset: Preset) => {
	it("has about 30 entries with unique ids and slugs", () => {
		expect(preset.entries.length).toBe(30);
		expect(new Set(preset.entries.map((e) => e.id)).size).toBe(30);
		expect(new Set(preset.entries.map((e) => e.slug)).size).toBe(30);
		for (const e of preset.entries) expect(e.slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
	});

	it("uses field slugs that do not collide with system columns and indexes only indexable types", () => {
		for (const f of preset.collection.fields) {
			expect(SYSTEM_COLUMNS).not.toContain(f.slug);
			expect(f.slug).toMatch(/^[a-z][a-z0-9_]*$/);
			if (f.indexed) expect(["string", "url", "number", "integer", "boolean", "datetime", "select", "slug"]).toContain(f.type);
		}
	});

	it("stores every value in a shape that passes the field rules", () => {
		const fields = preset.collection.fields as unknown as FieldDef[];
		for (const e of preset.entries) {
			for (const f of fields) {
				const v = e.data[f.slug];
				if (v === undefined) {
					expect(f.required, `${e.id}.${f.slug} is required`).not.toBe(true);
					continue;
				}
				const c = coerceValue(f, v);
				expect(c.ok, `${e.id}.${f.slug}: ${c.ok ? "" : c.reason}`).toBe(true);
				if (c.ok) {
					expect(c.value, `${e.id}.${f.slug} must already be in stored shape`).toEqual(v);
					expect(validateValue(f, c.value), `${e.id}.${f.slug}`).toEqual([]);
				}
			}
		}
	});

	it("keeps unique fields unique", () => {
		for (const f of preset.collection.fields.filter((x) => x.unique)) {
			const values = preset.entries.map((e) => e.data[f.slug]);
			expect(new Set(values).size, f.slug).toBe(values.length);
		}
	});

	it("assigns only terms that exist, and gives every hierarchical term an existing parent", () => {
		for (const t of preset.taxonomies) {
			const slugs = new Set(t.terms.map((x) => x.slug));
			for (const term of t.terms) if (term.parent) expect(slugs.has(term.parent), `${t.name}/${term.slug}`).toBe(true);
		}
		for (const e of preset.entries) {
			for (const [tax, list] of Object.entries(e.taxonomies)) {
				const t = preset.taxonomies.find((x) => x.name === tax);
				expect(t, `${e.id} uses unknown taxonomy ${tax}`).toBeDefined();
				for (const s of list) expect(t!.terms.some((x) => x.slug === s), `${e.id}: ${tax}/${s}`).toBe(true);
			}
		}
	});

	it("references images of the media folder only", () => {
		for (const e of preset.entries) {
			for (const img of [e.cover, ...e.gallery]) expect(img.file).toMatch(/^(car|prop)-\d{2}\.jpg$/);
			expect(e.gallery[0]).toEqual(e.cover);
		}
	});

	it("builds a valid EmDash seed", () => {
		const seed = toSeed([preset]);
		const res = validateSeed(seed);
		expect(res.errors).toEqual([]);
		expect(res.valid).toBe(true);
	});
});

describe("combined seed", () => {
	it("merges the shared location taxonomy and attaches both collections", () => {
		const seed = toSeed([carsPreset, realEstatePreset]) as { taxonomies: Array<{ name: string; collections: string[] }> };
		expect(seed.taxonomies.filter((t) => t.name === "location")).toEqual([expect.objectContaining({ collections: ["cars", "properties"] })]);
		expect(validateSeed(seed).valid).toBe(true);
	});

	it("has realistic spreads (prices, years, deal types)", () => {
		const prices = carsPreset.entries.map((e) => e.data.price as number);
		expect(Math.min(...prices)).toBeGreaterThan(10000);
		expect(Math.max(...prices)).toBeLessThan(60000);
		const deals = realEstatePreset.entries.map((e) => e.data.deal_type);
		expect(deals.filter((d) => d === "Rent").length).toBeGreaterThanOrEqual(8);
		expect(carsPreset.entries.some((e) => e.status === "draft")).toBe(true);
	});
});
