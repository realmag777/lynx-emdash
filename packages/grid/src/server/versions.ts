import { PEERS } from "../model/versions.ts";

// The versions the site has installed for the grid's peers, read from node_modules next to the
// site (what the admin build uses). Node hosts only: on Workers there is no file system, and
// the page falls back to what the browser can see (React's own version, missing providers).

export interface SiteVersions {
	available: boolean;
	versions: Record<string, string | null>;
}

export async function siteVersions(): Promise<SiteVersions> {
	try {
		const proc = (globalThis as { process?: { cwd?: () => string; versions?: { node?: string } } }).process;
		if (!proc?.versions?.node || !proc.cwd) return { available: false, versions: {} };
		const fs = await import("node:fs");
		const path = await import("node:path");
		const versions: Record<string, string | null> = {};
		for (const pkg of Object.keys(PEERS)) {
			versions[pkg] = null;
			// node_modules of the site and of its parents, nearest first (like Node's resolution).
			for (let dir = proc.cwd(); ; dir = path.dirname(dir)) {
				const file = path.join(dir, "node_modules", ...pkg.split("/"), "package.json");
				if (fs.existsSync(file)) {
					versions[pkg] = String((JSON.parse(fs.readFileSync(file, "utf8")) as { version?: string }).version ?? "") || null;
					break;
				}
				if (path.dirname(dir) === dir) break;
			}
		}
		return { available: true, versions };
	} catch {
		return { available: false, versions: {} };
	}
}
