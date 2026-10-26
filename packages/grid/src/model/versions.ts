// Version guard (2026-09-30): the grid is built into the admin's bundle and shares its
// React, Kumo, phosphor icons and @emdash-cms/admin. A version outside the grid's peer ranges,
// or a second copy of one of them, breaks the grid page in confusing ways (invalid hook calls,
// toasts that never show). The page checks this at load and says exactly how to fix it.

/** The grid's peer ranges; a unit test keeps them equal to package.json. */
export const PEERS: Record<string, string> = {
	react: "^19.0.0",
	"react-dom": "^19.0.0",
	"@cloudflare/kumo": "^2.6.0",
	"@phosphor-icons/react": "^2.1.10",
	"@emdash-cms/admin": "^1.0.1",
};

/** Packages installed together: fixing one version means installing both. */
const TOGETHER: Record<string, string> = { react: "react-dom", "react-dom": "react" };

export interface VersionProblem {
	pkg: string;
	/** The version the admin uses; null when the package is missing. */
	found: string | null;
	range: string;
}

function parse(v: string): [number, number, number] | null {
	const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
	return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

const cmp = (a: [number, number, number], b: [number, number, number]) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** Enough of semver for peer ranges: ^x.y.z, ~x.y.z, >=x.y.z, x.y.z, "*". */
export function satisfies(version: string, range: string): boolean {
	const v = parse(version);
	if (!v) return false;
	const r = range.trim();
	if (r === "*" || r === "") return true;
	const op = /^(\^|~|>=)?\s*(.*)$/.exec(r)!;
	const base = parse(op[2]!);
	if (!base) return false;
	if (cmp(v, base) < 0) return false;
	switch (op[1]) {
		case ">=":
			return true;
		case "~":
			return v[0] === base[0] && v[1] === base[1];
		case "^":
			return base[0] > 0 ? v[0] === base[0] : base[1] > 0 ? v[0] === 0 && v[1] === base[1] : cmp(v, base) === 0;
		default:
			return cmp(v, base) === 0;
	}
}

/** Packages whose version (known ones only) falls outside the peer range. */
export function versionProblems(found: Record<string, string | null | undefined>): VersionProblem[] {
	const out: VersionProblem[] = [];
	for (const [pkg, range] of Object.entries(PEERS)) {
		if (!(pkg in found) || found[pkg] === undefined) continue;
		const v = found[pkg] ?? null;
		if (v === null || !satisfies(v, range)) out.push({ pkg, found: v, range });
	}
	return out;
}

/** The exact command that installs matching versions (react and react-dom move together). */
export function fixCommand(problems: VersionProblem[]): string {
	const pkgs = new Set<string>();
	for (const p of problems) {
		pkgs.add(p.pkg);
		const mate = TOGETHER[p.pkg];
		if (mate) pkgs.add(mate);
	}
	return `npm install ${[...pkgs].map((p) => `${p}@"${PEERS[p]}"`).join(" ")}`;
}

/** For two copies of a package: one copy for the admin and the grid. */
export const DEDUPE_COMMAND = "npm dedupe";
// The admin is pre-bundled with its own Kumo; this makes the grid share it (an npm install needs it).
export const DEDUPE_CONFIG = `vite: { optimizeDeps: { include: ["@cloudflare/kumo", "@phosphor-icons/react"] }, resolve: { dedupe: ["react", "react-dom", "@cloudflare/kumo", "@phosphor-icons/react", "@emdash-cms/admin"] } }`;
