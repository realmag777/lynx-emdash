import { createPluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import { afterEach, describe, expect, it } from "vitest";

import { call, drive, type Host } from "./helpers.ts";

// Entries whose term writes do not fit one sandbox step (8 host calls) are split: the create or
// the edit in its own step, the other term writes in pending steps before the job completes.

let host: Host | undefined;
afterEach(async () => {
	await host?.dispose();
	host = undefined;
});

type Obj = Record<string, unknown>;
const TAXONOMIES = ["t1", "t2", "t3", "t4", "t5", "t6"];
const maxCalls = (answers: Obj[]) => Math.max(0, ...answers.map((a) => (a.step as { host_calls?: number } | undefined)?.host_calls ?? 0));

async function boats(): Promise<Host> {
	const h = await createPluginRuntimeTestHost();
	await h.fixtures.collection({
		slug: "boats",
		label: "Boats",
		supports: ["drafts", "revisions"],
		fields: [
			{ slug: "title", label: "Title", type: "string", required: true },
			{ slug: "price", label: "Price", type: "number", indexed: true },
		],
	});
	for (const t of TAXONOMIES) {
		await h.fixtures.taxonomyDefinition({ name: t, label: t.toUpperCase(), hierarchical: false, collections: ["boats"] });
		await h.fixtures.taxonomy({ name: t, slug: "a", label: "A" });
		await h.fixtures.taxonomy({ name: t, slug: "b", label: "B" });
	}
	return h;
}

const slugsByTaxonomy = async (h: Host, id: string) => {
	const terms = (await h.inspect.content.terms("boats", id)) as Array<{ taxonomy?: string; name?: string; slug: string }>;
	return terms.map((t) => `${t.taxonomy ?? t.name}:${t.slug}`).sort();
};

describe("entries that need more than one step", () => {
	it("creates, copies, re-terms and rolls back entries with six taxonomies within 8 calls per step", async () => {
		host = await boats();
		const rows = [1, 2].map((n) => ({ title: `Boat ${n}`, price: 1000 * n, status: "published", ...Object.fromEntries(TAXONOMIES.map((t) => [`terms:${t}`, ["a"]])) }));
		const created = await call(host, "create", { collection: "boats", entries: rows, dry_run: false, confirm_count: 2 });
		const c = await drive(host, created.job_key as string);
		expect(c.last).toMatchObject({ state: "completed", result: { written: 2, failed: 0 } });
		expect(maxCalls([created, ...c.steps])).toBeLessThanOrEqual(8);
		const originals = (await host.inspect.content.list("boats")) as Array<{ id: string; status: string }>;
		expect(originals.every((o) => o.status === "published")).toBe(true);
		for (const o of originals) expect(await slugsByTaxonomy(host, o.id)).toEqual(TAXONOMIES.map((t) => `${t}:a`));

		const all = await call(host, "find", { collection: "boats", filter: {} });
		const dup = await call(host, "apply", { selection_id: all.selection_id, operations: [{ field: "entry", behavior: "duplicate" }], confirm_count: 2 });
		const d = await drive(host, dup.job_key as string);
		expect(d.last).toMatchObject({ state: "completed", result: { written: 2, failed: 0 } });
		expect(maxCalls([dup, ...d.steps])).toBeLessThanOrEqual(8);
		const copies = ((await host.inspect.content.list("boats")) as Array<{ id: string; data: Obj }>).filter((x) => String(x.data.title).endsWith("(Copy)"));
		expect(copies.length).toBe(2);
		for (const x of copies) expect(await slugsByTaxonomy(host, x.id)).toEqual(TAXONOMIES.map((t) => `${t}:a`));

		const sel = await call(host, "find", { collection: "boats", filter: { where: { title: { contains: "copy" } } } });
		const ops = TAXONOMIES.map((t) => ({ field: `terms:${t}`, behavior: "set_terms", value: ["b"] }));
		const re = await call(host, "apply", { selection_id: sel.selection_id, operations: ops, confirm_count: 2 });
		const r = await drive(host, re.job_key as string);
		expect(r.last).toMatchObject({ state: "completed", result: { written: 2, failed: 0 } });
		expect(maxCalls([re, ...r.steps])).toBeLessThanOrEqual(8);
		expect(r.steps.some((s) => (s.step as Obj | undefined)?.phase === "terms")).toBe(true);
		for (const x of copies) expect(await slugsByTaxonomy(host, x.id)).toEqual(TAXONOMIES.map((t) => `${t}:b`));

		const rb = await call(host, "rollback", { job_key: re.job_key });
		const b = await drive(host, rb.job_key as string);
		expect(b.last).toMatchObject({ state: "completed", result: { written: 2 } });
		expect(maxCalls([rb, ...b.steps])).toBeLessThanOrEqual(8);
		for (const x of copies) expect(await slugsByTaxonomy(host, x.id)).toEqual(TAXONOMIES.map((t) => `${t}:a`));
	});
});
