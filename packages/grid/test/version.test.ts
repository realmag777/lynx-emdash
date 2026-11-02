import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { GRID_VERSION } from "../src/index.ts";

describe("GRID_VERSION", () => {
	it("is the package version (the admin's plugin list shows it)", () => {
		const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
		expect(GRID_VERSION).toBe(pkg.version);
	});
});
