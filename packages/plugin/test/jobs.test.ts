import { afterEach, describe, expect, it } from "vitest";

import { call, drive, livePrice, MCP_URL, seed, type Host } from "./helpers.ts";

let host: Host | undefined;
afterEach(async () => {
	await host?.dispose();
	host = undefined;
});

type Obj = Record<string, unknown>;
const stepCalls = (answers: Obj[]) => answers.map((a) => (a.step as { host_calls?: number } | undefined)?.host_calls).filter((x): x is number => x !== undefined);

async function selectAll(h: Host, filter: Obj = {}) {
	return call(h, "find", { collection: "cars", filter });
}

describe("find_entries", () => {
	it("freezes the ids that match host and scan conditions, and says when nothing was narrowed", async () => {
		const s = await seed(8);
		host = s.host;
		const f = await selectAll(host, { where: { price: { gte: 12000 }, color: "black", title: { contains: "car" } } });
		expect(f).toMatchObject({ state: "ready", count: 3, whole_collection: false });
		expect((f.sample as Obj[]).map((r) => r.title)).toEqual(expect.arrayContaining(["Car 3", "Car 5", "Car 7"]));
		const all = await selectAll(host);
		expect(all).toMatchObject({ count: 8, whole_collection: true });
		expect(String(all.note)).toContain("whole collection");
	});

	it("refuses a filter it cannot run exactly, with every problem listed", async () => {
		const s = await seed(2);
		host = s.host;
		const r = await selectAll(host, { where: { nope: 1, year: { gte: "old" } }, colour: "red" });
		expect(r).toMatchObject({ ok: false, code: "BAD_FILTER" });
		expect(String(r.message)).toMatch(/nope: unknown field.*year: gte takes a number/s);
	});
});

describe("preview and apply", () => {
	it("previews without writing, and refuses a wrong confirm_count before creating anything", async () => {
		const s = await seed(4);
		host = s.host;
		const f = await selectAll(host);
		const ops = [{ field: "price", behavior: "decrease_percent", value: 10 }];
		const pv = await call(host, "preview", { selection_id: f.selection_id, operations: ops });
		expect(pv).toMatchObject({ selection_count: 4, confirm_count: 4, sample_counts: { change: 4 } });
		expect((pv.warnings as Obj[]).map((w) => w.code)).toEqual(expect.arrayContaining(["whole_collection", "percent_not_reversible", "saved_as_draft"]));
		expect(await livePrice(host, s.ids[0]!)).toBe(10000);
		const bad = await call(host, "apply", { selection_id: f.selection_id, operations: ops, confirm_count: 3 });
		expect(bad).toMatchObject({ ok: false, code: "CONFIRM_MISMATCH" });
		expect(String(bad.message)).toContain("confirm_count is 3 but this selection holds 4 entries");
		const history = await call(host, "history", {});
		expect(history.jobs).toEqual([]);
	});

	it("runs a draft-mode job 3 entries per step and never goes over 8 host calls", async () => {
		const s = await seed(10);
		host = s.host;
		const f = await selectAll(host);
		const job = await call(host, "apply", { selection_id: f.selection_id, operations: [{ field: "price", behavior: "increase_by", value: 500 }], confirm_count: 10 });
		expect(job).toMatchObject({ entries_per_step: 3, finished: false });
		const { last, steps } = await drive(host, job.job_key as string);
		expect(last).toMatchObject({ state: "completed", result: { written: 10, unchanged: 0, invalid: 0, failed: 0 } });
		expect(Math.max(...stepCalls([job, ...steps]))).toBeLessThanOrEqual(8);
		// Revisions + draft mode: the live values do not change.
		expect(await livePrice(host, s.ids[0]!)).toBe(10000);
	});

	it("runs a publish-mode job 2 entries per step and changes the live values", async () => {
		const s = await seed(5);
		host = s.host;
		const f = await selectAll(host);
		const job = await call(host, "apply", { selection_id: f.selection_id, operations: [{ field: "price", behavior: "round", step: 1000, direction: "up", ending: 990 }], confirm_count: 5, mode: "publish" });
		expect(job.entries_per_step).toBe(2);
		const { last, steps } = await drive(host, job.job_key as string);
		expect(last).toMatchObject({ state: "completed", result: { written: 5 } });
		expect(Math.max(...stepCalls(steps))).toBeLessThanOrEqual(8);
		for (const id of s.ids) expect((await livePrice(host, id))! % 1000).toBe(990);
	});

	it("never publishes draft edits pending on a live entry, in a job or in its rollback", async () => {
		const s = await seed(4);
		host = s.host;
		// An editor saves a draft on entry 0 without publishing it.
		await call(host, "update", { collection: "cars", id: s.ids[0], operations: [{ field: "color", value: "Blue" }] });
		const f = await selectAll(host);
		const ops = [{ field: "price", behavior: "increase_by", value: 100 }];
		const pv = await call(host, "preview", { selection_id: f.selection_id, operations: ops, mode: "publish" });
		expect((pv.warnings as Obj[]).map((w) => w.code)).toContain("pending_drafts");
		expect((pv.rows as Obj[]).find((r) => r.id === s.ids[0])).toMatchObject({ state: "held" });
		const job = await call(host, "apply", { selection_id: f.selection_id, operations: ops, confirm_count: 4, mode: "publish" });
		const { last } = await drive(host, job.job_key as string);
		expect(last).toMatchObject({ result: { written: 3, held: 1, unchanged: 0 } });
		expect(String(last.note)).toContain("1 left untouched because they have unpublished draft edits");
		const detail = await call(host, "history", { job_key: job.job_key });
		expect(detail).toMatchObject({ job_key: job.job_key, left_alone: [{ entry_id: s.ids[0], why: "held" }] });
		expect(await livePrice(host, s.ids[0]!)).toBe(10000);
		expect(await livePrice(host, s.ids[1]!)).toBe(11100);

		// A draft appears on entry 1 after the job: rolling back must not publish it.
		await call(host, "update", { collection: "cars", id: s.ids[1], operations: [{ field: "color", value: "Blue" }] });
		const rb = await call(host, "rollback", { job_key: job.job_key });
		const done = await drive(host, rb.job_key as string);
		expect(done.last).toMatchObject({ result: { written: 2, conflicts: 1 } });
		expect(await livePrice(host, s.ids[1]!)).toBe(11100);
		expect(await livePrice(host, s.ids[2]!)).toBe(12000);
	});

	it("skips entries that would break a field rule and reports them", async () => {
		const s = await seed(4);
		host = s.host;
		const f = await selectAll(host);
		const job = await call(host, "apply", { selection_id: f.selection_id, operations: [{ field: "year", behavior: "increase_by", value: 18 }], confirm_count: 4, mode: "publish" });
		const { last } = await drive(host, job.job_key as string);
		// Years 2010..2013 + 18 = 2028..2031; max is 2030, so the last entry is invalid.
		expect(last).toMatchObject({ result: { written: 3, invalid: 1 } });
	});

	it("enforces uniqueness that EmDash only stores", async () => {
		const s = await seed(3);
		host = s.host;
		const f = await selectAll(host, { where: { price: { gte: 11000 } } });
		const job = await call(host, "apply", { selection_id: f.selection_id, operations: [{ field: "vin", behavior: "set", value: "VIN00000000000000" }], confirm_count: 2, mode: "publish" });
		const { last } = await drive(host, job.job_key as string);
		expect(last).toMatchObject({ result: { written: 0, invalid: 2 } });
	});

	it("assigns and removes terms", async () => {
		const s = await seed(3);
		host = s.host;
		const f = await selectAll(host);
		const job = await call(host, "apply", { selection_id: f.selection_id, operations: [{ field: "terms:fuel", behavior: "add_terms", value: ["diesel"] }], confirm_count: 3 });
		const { last } = await drive(host, job.job_key as string);
		expect(last).toMatchObject({ result: { written: 3 } });
		const terms = await host.inspect.content.terms("cars", s.ids[0]!);
		expect(terms.map((t: { slug: string }) => t.slug)).toContain("diesel");
	});

	it("re-publishes published entries of a collection without revisions (cache refresh)", async () => {
		const s = await seed(1);
		host = s.host;
		const f = await call(host, "find", { collection: "properties", filter: {} });
		const pv = await call(host, "preview", { selection_id: f.selection_id, operations: [{ field: "price", behavior: "set", value: 5000 }] });
		expect((pv.warnings as Obj[]).map((w) => w.code)).toContain("cache_refresh_republish");
		const job = await call(host, "apply", { selection_id: f.selection_id, operations: [{ field: "price", behavior: "set", value: 5000 }], confirm_count: 3 });
		const { last, steps } = await drive(host, job.job_key as string);
		expect(last).toMatchObject({ result: { written: 3 } });
		expect(Math.max(...stepCalls(steps))).toBeLessThanOrEqual(8);
		const items = await host.inspect.content.list("properties");
		expect(items.every((i: { data: Obj; status: string }) => i.data.price === 5000 && i.status === "published")).toBe(true);
	});
});

describe("history and rollback", () => {
	it("restores previous values and leaves fields changed since the job alone", async () => {
		const s = await seed(4);
		host = s.host;
		const f = await selectAll(host);
		const job = await call(host, "apply", { selection_id: f.selection_id, operations: [{ field: "price", behavior: "increase_percent", value: 50 }], confirm_count: 4, mode: "publish" });
		await drive(host, job.job_key as string);
		expect(await livePrice(host, s.ids[1]!)).toBe(16500);

		// Somebody edits one entry after the job.
		const other = await call(host, "update", { collection: "cars", id: s.ids[1], operations: [{ field: "price", value: 99999 }], mode: "publish" });
		expect(other).toMatchObject({ kind: "single", state: "completed" });

		const rb = await call(host, "rollback", { job_key: job.job_key });
		const { last } = await drive(host, rb.job_key as string);
		expect(last).toMatchObject({ kind: "rollback", state: "completed", result: { written: 3, conflicts: 1 } });
		expect(await livePrice(host, s.ids[0]!)).toBe(10000);
		expect(await livePrice(host, s.ids[1]!)).toBe(99999);

		const hist = (await call(host, "history", {})).jobs as Obj[];
		expect(hist.find((j) => j.job_key === job.job_key)).toMatchObject({ state: "rolled_back", rolled_back_by: rb.job_key });
		const again = await call(host, "rollback", { job_key: job.job_key });
		expect(again).toMatchObject({ ok: false, code: "NOTHING_TO_REVERT" });

		// The single edit is its own job and can be rolled back too.
		const rb2 = await call(host, "rollback", { job_key: other.job_key });
		await drive(host, rb2.job_key as string);
		expect(await livePrice(host, s.ids[1]!)).toBe(16500);
	});

	it("marks jobs made through the MCP endpoint", async () => {
		const s = await seed(1);
		host = s.host;
		const r = await call(host, "update", { collection: "cars", id: s.ids[0], operations: [{ field: "color", value: "blue" }] }, MCP_URL);
		expect(r).toMatchObject({ state: "completed" });
		const hist = (await call(host, "history", {})).jobs as Obj[];
		expect(hist[0]).toMatchObject({ via_mcp: true, author: "Eda Editor" });
	});
});

describe("concurrency and recovery", () => {
	it("lets several steppers run one job without processing an entry twice", async () => {
		const s = await seed(12);
		host = s.host;
		const f = await selectAll(host);
		const job = await call(host, "apply", { selection_id: f.selection_id, operations: [{ field: "price", behavior: "increase_by", value: 1 }], confirm_count: 12 });
		const h = host;
		const runners = Array.from({ length: 4 }, async () => {
			for (let i = 0; i < 20; i++) {
				const r = await call(h, "job", { job_key: job.job_key });
				if (r.finished) return;
			}
		});
		await Promise.all(runners);
		const { last } = await drive(host, job.job_key as string);
		expect(last).toMatchObject({ state: "completed", result: { written: 12, failed: 0 } });
		const records = await host.inspect.storage.list("history");
		const entryRecords = records.filter((r) => (r.data as Obj).jobKey === job.job_key && (r.data as Obj).kind === "entry");
		expect(entryRecords).toHaveLength(12);
	});

	it("re-runs a claimed range whose step died before writing anything", async () => {
		const s = await seed(6);
		host = s.host;
		const f = await selectAll(host);
		const job = await call(host, "apply", { selection_id: f.selection_id, operations: [{ field: "price", behavior: "increase_by", value: 7 }], confirm_count: 6 });
		// Simulate a step that claimed tickets 0 and 1 and died: advance the ticket without processing.
		const stored = (await host.inspect.storage.get("jobs", job.job_key as string)) as Obj;
		const spec = stored.spec as Obj;
		await host.fixtures.plugin.storage("jobs", job.job_key as string, { ...stored, ticket: 2, spec: { ...spec, lostAfterMs: 0 } });
		const { last, steps } = await drive(host, job.job_key as string);
		expect(steps.some((st) => (st.step as Obj | undefined)?.phase === "recovered")).toBe(true);
		expect(last).toMatchObject({ state: "completed", result: { written: 6 } });
	});

	it("advances running jobs from the cron hook", async () => {
		const s = await seed(3);
		host = s.host;
		const f = await selectAll(host);
		const job = await call(host, "apply", { selection_id: f.selection_id, operations: [{ field: "price", behavior: "increase_by", value: 3 }], confirm_count: 3 });
		for (let i = 0; i < 4; i++) await host.transport.invokeHook("cron", { name: "lynx-jobs", scheduledAt: new Date().toISOString() });
		const r = await call(host, "job", { job_key: job.job_key });
		expect(r).toMatchObject({ state: "completed", result: { written: 3 } });
	});
});

describe("memory, cases and the admin page", () => {
	it("merges memory notes, deletes with null and enforces limits", async () => {
		const s = await seed(1);
		host = s.host;
		await call(host, "memory/set", { entries: { table_columns: "Show price and year.", tone: "Be brief." } });
		const r = await call(host, "memory/set", { entries: { tone: null, units: "Prices in EUR." } });
		expect(r).toMatchObject({ saved: ["units"], deleted: ["tone"] });
		const got = await call(host, "memory/get", {});
		expect(got.entries).toEqual({ table_columns: "Show price and year.", units: "Prices in EUR." });
		const long = await call(host, "memory/set", { entries: { x: "a".repeat(501) } });
		expect(long).toMatchObject({ ok: false, code: "BAD_ARGUMENT" });
	});

	it("lists only the cases that fit and runs one without writing", async () => {
		const s = await seed(6);
		host = s.host;
		const list = (await call(host, "cases", {})).cases as Obj[];
		expect(list.map((c) => c.id)).toEqual(expect.arrayContaining(["reprice_older", "incomplete_entries", "drafts_to_review", "duplicate_codes"]));
		expect(list.find((c) => c.id === "reprice_older")).toMatchObject({ params: { collection: "cars", before_year: 2018 } });
		expect(list.map((c) => c.id)).not.toContain("tag_near_sea");
		const r = await call(host, "case", { id: "reprice_older", params: { before_year: 2013, percent: 10 } });
		const res = r.result as Obj;
		expect((res.targets as Obj).count).toBe(3);
		expect(res.to_apply).toMatchObject({ tool: "apply_bulk", arguments: { confirm_count: 3 } });
		expect(await livePrice(host, s.ids[0]!)).toBe(10000);
	});

	it("warns on the admin page when LYNX changed version since the agent last connected", async () => {
		const s = await seed(1);
		host = s.host;
		const banners = async () => ((await host!.admin.loadPage("/overview")).blocks as Array<{ type: string; title?: string }>).filter((b) => b.type === "banner").map((b) => b.title);
		await call(host, "capabilities", {}, MCP_URL);
		expect(await banners()).not.toContain("AI agent tools are probably switched off");
		await host.fixtures.plugin.kv("agent:last-session", { version: "0.0.9", at: "2026-09-01T00:00:00Z" });
		expect(await banners()).toContain("AI agent tools are probably switched off");
	});

	it("renders a valid Block Kit page", async () => {
		const s = await seed(2);
		host = s.host;
		const page = await host.admin.loadPage("/overview");
		const types = (page.blocks as Array<{ type: string }>).map((b) => b.type);
		expect(types).toEqual(expect.arrayContaining(["header", "stats", "table", "code"]));
		expect(types).not.toContain("form");
	});
});
