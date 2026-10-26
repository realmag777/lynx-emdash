// Builds presets/cars/seed.json, presets/real-estate/seed.json and presets/all/seed.json
// and validates each with EmDash's own validateSeed().
// Usage: node presets/tools/build-seeds.ts [--media-base https://cdn.example.com/lynx/media]
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { validateSeed } from "emdash/seed";

import { carsPreset } from "../src/cars.ts";
import type { Preset } from "../src/model.ts";
import { realEstatePreset } from "../src/real-estate.ts";
import { DEFAULT_MEDIA_BASE_URL, toSeed } from "../src/seed.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const argIdx = process.argv.indexOf("--media-base");
const base = argIdx > 0 ? process.argv[argIdx + 1]! : (process.env.LYNX_MEDIA_BASE ?? DEFAULT_MEDIA_BASE_URL);

const targets: Array<[string, Preset[]]> = [
	["cars", [carsPreset]],
	["real-estate", [realEstatePreset]],
	["all", [carsPreset, realEstatePreset]],
];

let failed = false;
for (const [dir, presets] of targets) {
	const seed = toSeed(presets, base);
	const result = validateSeed(seed);
	const out = join(root, dir, "seed.json");
	mkdirSync(dirname(out), { recursive: true });
	writeFileSync(out, `${JSON.stringify(seed, null, "\t")}\n`);
	const entries = presets.reduce((n, p) => n + p.entries.length, 0);
	if (result.valid) console.log(`ok   ${dir}/seed.json: ${presets.length} collection(s), ${entries} entries${result.warnings?.length ? `, warnings: ${result.warnings.join("; ")}` : ""}`);
	else {
		failed = true;
		console.error(`FAIL ${dir}/seed.json:\n  ${result.errors.join("\n  ")}`);
	}
}
process.exit(failed ? 1 : 0);
