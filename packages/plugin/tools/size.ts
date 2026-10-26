// Fails when the registry bundle would not fit EmDash's limits: 128 KiB per file (backend.js = dist/plugin.mjs, which the sandbox
// loads as ONE module) and 256 KiB in total. Run after `emdash-plugin build`.
import { statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FILE_LIMIT = 128 * 1024;
/** Kept free under the per-file limit, so a fix never lands on a bundle the registry refuses. */
const FILE_MARGIN = 2 * 1024;
const TOTAL_LIMIT = 220 * 1024;
const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const files = ["plugin.mjs", "manifest.json"];
let total = 0;
let failed = false;
for (const f of files) {
	const size = statSync(join(dist, f)).size;
	total += size;
	const over = size > FILE_LIMIT - FILE_MARGIN;
	failed ||= over;
	console.log(`${f.padEnd(14)} ${(size / 1024).toFixed(1)} KiB (${((FILE_LIMIT - size) / 1024).toFixed(1)} KiB free of the 128 KiB per-file limit)${over ? "  <- too large" : ""}`);
}
console.log(`${"total".padEnd(14)} ${(total / 1024).toFixed(1)} KiB (limit ${TOTAL_LIMIT / 1024} KiB, registry hard limit 256 KiB)`);
if (failed || total > TOTAL_LIMIT) {
	console.error("Bundle too large for the registry.");
	process.exit(1);
}
