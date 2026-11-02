// Where the LYNX plugins live on this site. An npm (in-process) install keeps its id ("lynx",
// "lynx-media"); a registry install gets a generated one ("r_65xx…") and records the registry
// slug and publisher next to it (found by installing from the registry, 2026-11-02). Routes are
// /_emdash/api/plugins/<id>/<route>, so the grid looks the id up once per page load.

/** realmag777.com: the publisher of every LYNX package in the EmDash registry. */
export const LYNX_PUBLISHER = "did:plc:el6ylegupn3bt4kf2uwa7nle";

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

interface ManifestPlugin {
	enabled?: boolean;
	sandboxed?: boolean;
	adminPages?: Array<{ path?: string; label?: string }>;
}
interface InstalledPlugin {
	id: string;
	enabled?: boolean;
	source?: string;
	registrySlug?: string;
	registryPublisherDid?: string;
}

const getJson = async (fetcher: Fetcher, url: string): Promise<unknown> => {
	try {
		const res = await fetcher(url, { credentials: "same-origin", headers: { "X-EmDash-Request": "1" } });
		if (!res.ok) return null;
		const body = (await res.json()) as { data?: unknown };
		return body.data ?? null;
	} catch {
		return null;
	}
};

/**
 * The id of an active LYNX plugin, or null when it is not installed. `slug` is the npm id and the
 * registry slug; `label` is its admin page label, the last resort for users who may not list
 * plugins (the plugin list needs the editor role).
 */
export async function findPluginId(slug: string, label: string | null, fetcher: Fetcher = fetch): Promise<string | null> {
	const manifest = ((await getJson(fetcher, "/_emdash/api/manifest")) as { plugins?: Record<string, ManifestPlugin> } | null)?.plugins ?? {};
	const on = (id: string) => manifest[id] !== undefined && manifest[id]!.enabled !== false;
	if (on(slug)) return slug;
	const listed = await getJson(fetcher, "/_emdash/api/admin/plugins");
	const items = (Array.isArray(listed) ? listed : ((listed as { items?: unknown } | null)?.items ?? [])) as InstalledPlugin[];
	const fromRegistry = items.find((p) => p.source === "registry" && p.registrySlug === slug && p.registryPublisherDid === LYNX_PUBLISHER && p.enabled !== false);
	if (fromRegistry && on(fromRegistry.id)) return fromRegistry.id;
	if (listed !== null || label === null) return null;
	const byPage = Object.entries(manifest).filter(([id, p]) => id.startsWith("r_") && p.sandboxed && p.enabled !== false && p.adminPages?.some((x) => x.label === label));
	return byPage.length === 1 ? byPage[0]![0] : null;
}

const found = new Map<string, Promise<string | null>>();

/** findPluginId, asked once per page load. */
export function pluginId(slug: string, label: string | null): Promise<string | null> {
	let p = found.get(slug);
	if (!p) {
		p = findPluginId(slug, label);
		found.set(slug, p);
		void p.then((id) => {
			if (id === null) found.delete(slug);
		});
	}
	return p;
}
