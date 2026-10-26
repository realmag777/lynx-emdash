// The MCP tool set is frozen (approved by the author on 2026-09-29). EmDash snapshots every tool's
// name, description, route, permission, destructive flag and schemas into the admin's consent;
// any change switches agent access off on every site. This check fails on any change to the
// built manifest's tools. After a change that was agreed on: node tools/freeze.ts --update
// Run after `emdash-plugin build`.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const built = JSON.stringify((JSON.parse(readFileSync(join(root, "dist", "manifest.json"), "utf8")) as { mcp?: { tools?: unknown[] } }).mcp?.tools ?? [], null, "\t") + "\n";
const frozenPath = join(root, "mcp-tools.frozen.json");
if (process.argv.includes("--update") || !existsSync(frozenPath)) {
	writeFileSync(frozenPath, built);
	console.log(`MCP tools written to mcp-tools.frozen.json (${(JSON.parse(built) as unknown[]).length} tools).`);
} else if (readFileSync(frozenPath, "utf8").replace(/\r\n/g, "\n") !== built) {
	console.error("The MCP tools differ from mcp-tools.frozen.json. The tool set is frozen: revert the change, or run node tools/freeze.ts --update only for an agreed change.");
	process.exit(1);
} else {
	console.log(`MCP tools unchanged (${(JSON.parse(built) as unknown[]).length} frozen tools).`);
}
