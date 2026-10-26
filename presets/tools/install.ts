// Installs LYNX presets into a running EmDash site through the REST API.
// Usage: node presets/tools/install.ts --url http://localhost:4400 --token ec_pat_… [--preset cars|real-estate|all] [--schema-only]
// The token can also come from EMDASH_TOKEN. It needs the admin scope (schema and taxonomy writes).
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { carsPreset } from "../src/cars.ts";
import { fetchClient, installPreset } from "../src/installer.ts";
import type { Preset } from "../src/model.ts";
import { realEstatePreset } from "../src/real-estate.ts";

const arg = (name: string) => {
	const i = process.argv.indexOf(`--${name}`);
	return i > 0 ? process.argv[i + 1] : undefined;
};
const url = arg("url") ?? "http://localhost:4400";
const token = arg("token") ?? process.env.EMDASH_TOKEN;
const which = arg("preset") ?? "all";
if (!token) {
	console.error("A personal access token is required: --token ec_pat_… or EMDASH_TOKEN.");
	process.exit(2);
}
const presets: Preset[] = which === "cars" ? [carsPreset] : which === "real-estate" ? [realEstatePreset] : [carsPreset, realEstatePreset];
const mediaRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "media");
const client = fetchClient(url, { token });

for (const preset of presets) {
	const res = await installPreset(client, preset, {
		schemaOnly: process.argv.includes("--schema-only"),
		loadImage: async (dir, img) => new Blob([await readFile(join(mediaRoot, dir, img.file))], { type: "image/jpeg" }),
		onProgress: (p) => {
			if (p.step === "entries" || p.step === "media") {
				if ((p.done ?? 0) % 10 === 0) console.log(`  ${p.step} ${p.done}/${p.total} ${p.message}`);
			} else console.log(`  ${p.step}: ${p.message}`);
		},
	});
	console.log(`${preset.name}:`, JSON.stringify(res));
}
