import { afterEach, describe, expect, it } from "vitest";

import { call, drive, livePrice, seed, type Host } from "./helpers.ts";

let host: Host | undefined;
afterEach(async () => {
	await host?.dispose();
	host = undefined;
});

describe("smoke", () => {
	it("finds, previews and applies a publish-mode job within 8 host calls per step", async () => {
		const s = await seed(5);
		host = s.host;
		const fields = await call(host, "fields", { collection: "cars" });
		expect(fields.fields).toBeDefined();
		const found = await call(host, "find", { collection: "cars", filter: { where: { price: { lt: 13000 } } } });
		expect(found).toMatchObject({ state: "ready", count: 3 });
		const ops = [{ field: "price", behavior: "increase_percent", value: 10 }];
		const pv = await call(host, "preview", { selection_id: found.selection_id, operations: ops, mode: "publish" });
		expect(pv).toMatchObject({ selection_count: 3, confirm_count: 3, sample_size: 3 });
		const job = await call(host, "apply", { selection_id: found.selection_id, operations: ops, confirm_count: 3, mode: "publish" });
		expect(job).toMatchObject({ kind: "bulk", total: 3, entries_per_step: 2 });
		const { last, steps } = await drive(host, job.job_key as string);
		expect(last).toMatchObject({ state: "completed", result: { written: 3, failed: 0 } });
		for (const st of [job, ...steps]) {
			const calls = (st.step as { host_calls?: number } | undefined)?.host_calls;
			if (calls !== undefined) expect(calls).toBeLessThanOrEqual(8);
		}
		expect(await livePrice(host, s.ids[0]!)).toBe(11000);
	});
});
