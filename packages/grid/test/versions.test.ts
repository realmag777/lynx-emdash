import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { fixCommand, PEERS, satisfies, versionProblems } from "../src/model/versions.ts";

describe("version guard", () => {
	it("keeps the peer ranges equal to package.json", () => {
		const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { peerDependencies: Record<string, string> };
		const { emdash: _host, ...peers } = pkg.peerDependencies;
		expect(PEERS).toEqual(peers);
	});

	it("reads caret, tilde and exact ranges", () => {
		expect(satisfies("19.2.4", "^19.0.0")).toBe(true);
		expect(satisfies("18.3.1", "^19.0.0")).toBe(false);
		expect(satisfies("20.0.0", "^19.0.0")).toBe(false);
		expect(satisfies("2.5.9", "^2.6.0")).toBe(false);
		expect(satisfies("2.7.1", "^2.6.0")).toBe(true);
		expect(satisfies("0.3.4", "^0.3.1")).toBe(true);
		expect(satisfies("0.4.0", "^0.3.1")).toBe(false);
		expect(satisfies("1.2.9", "~1.2.3")).toBe(true);
		expect(satisfies("1.3.0", "~1.2.3")).toBe(false);
		expect(satisfies("1.0.1", "1.0.1")).toBe(true);
		expect(satisfies("19.0.0-rc.1", "^19.0.0")).toBe(true);
	});

	it("names the mismatches and the exact install command", () => {
		const problems = versionProblems({ react: "18.3.1", "@cloudflare/kumo": "2.6.0", "@phosphor-icons/react": null });
		expect(problems.map((p) => p.pkg)).toEqual(["react", "@phosphor-icons/react"]);
		expect(fixCommand(problems)).toBe('npm install react@"^19.0.0" react-dom@"^19.0.0" @phosphor-icons/react@"^2.1.10"');
		expect(versionProblems({ react: "19.2.4", "react-dom": "19.2.4", "@cloudflare/kumo": "2.6.0", "@phosphor-icons/react": "2.1.10", "@emdash-cms/admin": "1.0.1" })).toEqual([]);
	});
});
