import { afterEach, describe, expect, it } from "vitest";

import { call, drive, seed, type Host } from "./helpers.ts";

let host: Host | undefined;
afterEach(async () => {
	await host?.dispose();
	host = undefined;
});

type Obj = Record<string, unknown>;
const stepCalls = (answers: Obj[]) => answers.map((a) => (a.step as { host_calls?: number } | undefined)?.host_calls).filter((x): x is number => x !== undefined);

describe("create_entries", () => {
	it("dry-runs by default, reports problems with codes and hints, and writes nothing", async () => {
		const s = await seed(2);
		host = s.host;
		const r = await call(host, "create", {
			collection: "cars",
			entries: [
				{ title: "New A", price: 9000, year: 2021, color: "blue", "terms:fuel": ["diesel"] },
				{ titel: "Typo", price: "cheap", color: "Purple", "terms:fuel": ["disel"], vin: "VIN00000000000000" },
			],
		});
		expect(r).toMatchObject({ dry_run: true, total: 2, ok: 1, invalid: 1, confirm_count: 1 });
		const bad = (r.rows as Obj[])[1] as { problems: Array<{ code: string; field: string; hint?: string }> };
		expect(bad.problems.map((p) => p.code)).toEqual(expect.arrayContaining(["unknown_field", "wrong_type", "not_in_options", "unknown_term", "duplicate_unique", "missing_required"]));
		expect(bad.problems.find((p) => p.field === "terms:fuel")!.hint).toBe("diesel");
		expect(bad.problems.find((p) => p.field === "titel")!.hint).toBe("title");
		expect((await host.inspect.content.list("cars")).length).toBe(2);
	});

	it("creates only the valid rows after a matching confirm_count, and rollback trashes them", async () => {
		const s = await seed(1);
		host = s.host;
		const entries = [
			{ title: "New A", price: 9000, year: 2021, "terms:fuel": ["diesel"], status: "published" },
			{ title: "New B", price: 9500, year: 2022 },
			{ title: "Broken", year: 1800 },
		];
		const wrong = await call(host, "create", { collection: "cars", entries, dry_run: false, confirm_count: 3 });
		expect(wrong).toMatchObject({ ok: false, code: "CONFIRM_MISMATCH" });
		const job = await call(host, "create", { collection: "cars", entries, dry_run: false, confirm_count: 2 });
		expect(job).toMatchObject({ kind: "create", total: 2 });
		const { last, steps } = await drive(host, job.job_key as string);
		expect(last).toMatchObject({ state: "completed", result: { written: 2, failed: 0 } });
		expect(Math.max(...stepCalls([job, ...steps]))).toBeLessThanOrEqual(8);
		const items = (await host.inspect.content.list("cars")) as Array<{ id: string; status: string; data: Obj }>;
		const a = items.find((i) => i.data.title === "New A")!;
		expect(a.status).toBe("published");
		expect((await host.inspect.content.terms("cars", a.id)).map((t: { slug: string }) => t.slug)).toEqual(["diesel"]);
		expect(items.find((i) => i.data.title === "New B")!.status).toBe("draft");

		const rb = await call(host, "rollback", { job_key: job.job_key });
		const done = await drive(host, rb.job_key as string);
		expect(done.last).toMatchObject({ result: { written: 2, conflicts: 0 } });
		const after = (await host.inspect.content.list("cars")) as Array<{ data: Obj }>;
		expect(after.map((i) => i.data.title)).toEqual(["Car 0"]);
	});
});

describe("duplicate and trash through apply_bulk", () => {
	it("makes draft copies with the later operations applied, and rollback trashes the copies", async () => {
		const s = await seed(2);
		host = s.host;
		const f = await call(host, "find", { collection: "cars", filter: {} });
		const ops = [{ field: "entry", behavior: "duplicate" }, { field: "price", behavior: "increase_by", value: 1 }];
		const pv = await call(host, "preview", { selection_id: f.selection_id, operations: ops });
		expect((pv.warnings as Obj[]).map((w) => w.code)).toContain("copies_are_drafts");
		const job = await call(host, "apply", { selection_id: f.selection_id, operations: ops, confirm_count: 2 });
		const { last, steps } = await drive(host, job.job_key as string);
		expect(last).toMatchObject({ state: "completed", result: { written: 2 } });
		expect(Math.max(...stepCalls([job, ...steps]))).toBeLessThanOrEqual(8);
		const items = (await host.inspect.content.list("cars")) as Array<{ id: string; status: string; data: Obj }>;
		const copy = items.find((i) => i.data.title === "Car 0 (Copy)")!;
		expect(copy).toMatchObject({ status: "draft", data: { price: 10001, year: 2010 } });
		expect(copy.data.vin ?? null).toBeNull();
		expect(items.find((i) => i.data.title === "Car 0")!.data.price).toBe(10000);

		const rb = await call(host, "rollback", { job_key: job.job_key });
		await drive(host, rb.job_key as string);
		const after = (await host.inspect.content.list("cars")) as Array<{ data: Obj }>;
		expect(after.map((i) => i.data.title).sort()).toEqual(["Car 0", "Car 1"]);
	});

	it("moves entries to the trash, and rollback restores them and publishes them again", async () => {
		const s = await seed(3);
		host = s.host;
		const f = await call(host, "find", { collection: "cars", filter: { where: { price: { gte: 11000 } } } });
		const job = await call(host, "apply", { selection_id: f.selection_id, operations: [{ field: "entry", behavior: "trash" }], confirm_count: 2 });
		const { last } = await drive(host, job.job_key as string);
		expect(last).toMatchObject({ state: "completed", result: { written: 2 } });
		expect(((await host.inspect.content.list("cars")) as unknown[]).length).toBe(1);

		const rb = await call(host, "rollback", { job_key: job.job_key });
		const done = await drive(host, rb.job_key as string);
		expect(done.last).toMatchObject({ result: { written: 2 } });
		const items = (await host.inspect.content.list("cars")) as Array<{ status: string }>;
		expect(items.length).toBe(3);
		expect(items.every((i) => i.status === "published")).toBe(true);
	});
});
