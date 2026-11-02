import { describe, expect, it } from "vitest";

import { findPluginId, LYNX_PUBLISHER } from "../src/model/plugins.ts";

const site = (manifest: Record<string, unknown>, list: unknown[] | null) => async (url: string) => {
	if (url.endsWith("/manifest")) return new Response(JSON.stringify({ data: { plugins: manifest } }));
	if (list === null) return new Response("{}", { status: 403 });
	return new Response(JSON.stringify({ data: { items: list } }));
};
const page = (label: string) => ({ enabled: true, sandboxed: true, adminPages: [{ path: "/overview", label }] });

describe("findPluginId", () => {
	it("keeps the npm id", async () => {
		expect(await findPluginId("lynx", "LYNX", site({ lynx: { enabled: true } }, []))).toBe("lynx");
	});
	it("finds a registry install by slug and publisher", async () => {
		const list = [{ id: "r_abc", source: "registry", registrySlug: "lynx", registryPublisherDid: LYNX_PUBLISHER, enabled: true }];
		expect(await findPluginId("lynx", "LYNX", site({ r_abc: page("LYNX") }, list))).toBe("r_abc");
	});
	it("ignores the same slug from another publisher", async () => {
		const list = [{ id: "r_x", source: "registry", registrySlug: "lynx", registryPublisherDid: "did:plc:someone", enabled: true }];
		expect(await findPluginId("lynx", "LYNX", site({ r_x: page("LYNX") }, list))).toBeNull();
	});
	it("falls back to the admin page label when the plugin list is not allowed", async () => {
		expect(await findPluginId("lynx", "LYNX", site({ r_abc: page("LYNX"), r_other: page("Forms") }, null))).toBe("r_abc");
		expect(await findPluginId("lynx-media", null, site({ r_abc: page("LYNX") }, null))).toBeNull();
	});
	it("is null when nothing is installed or it is disabled", async () => {
		expect(await findPluginId("lynx", "LYNX", site({}, []))).toBeNull();
		expect(await findPluginId("lynx", "LYNX", site({ lynx: { enabled: false } }, []))).toBeNull();
	});
});
