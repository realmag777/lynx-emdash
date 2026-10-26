import { createPluginRuntimeTestHost } from "@emdash-cms/plugin-test";
import { describe, expect, it } from "vitest";

const call = async (host: Awaited<ReturnType<typeof createPluginRuntimeTestHost>>, input: unknown) =>
	(await host.transport.invokeRoute("import", input, {
		url: "http://localhost/_emdash/api/plugins/lynx-media/import",
		method: "POST",
		user: { id: "user-editor", email: "editor@example.com", name: "Eda Editor", role: 40, createdAt: "2026-01-01T00:00:00Z" },
	} as never)) as Record<string, unknown>;

describe("import_media", () => {
	it("refuses bad addresses before fetching anything", async () => {
		const host = await createPluginRuntimeTestHost();
		const r = await call(host, { images: [{ url: "ftp://example.com/a.jpg" }, { url: "not a url" }] });
		expect(r).toMatchObject({ ok: false, code: "BAD_ARGUMENT" });
		expect(String(r.message)).toContain("#1: url must be an http(s) address");
		await host.dispose();
	});

	it("does 3 images per call in the sandbox, reports refused ones and returns the rest", async () => {
		const host = await createPluginRuntimeTestHost();
		const images = [1, 2, 3, 4, 5].map((n) => ({ url: `http://127.0.0.1/p${n}.jpg`, alt: `p${n}` }));
		const r = (await call(host, { images })) as { imported: unknown[]; failed: Array<{ url: string; message: string }>; remaining: Array<{ url: string }>; note: string };
		expect(r.imported).toEqual([]);
		expect(r.failed.map((f) => f.url)).toEqual(["http://127.0.0.1/p1.jpg", "http://127.0.0.1/p2.jpg", "http://127.0.0.1/p3.jpg"]);
		expect(r.remaining.map((x) => x.url)).toEqual(["http://127.0.0.1/p4.jpg", "http://127.0.0.1/p5.jpg"]);
		expect(r.note).toContain("call import_media again with remaining");
		await host.dispose();
	});
});
