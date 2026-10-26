import type { Preset, PresetImage } from "./model.ts";

// Installs a preset into a running EmDash site through its REST API, as an admin.
// Runs in Node (CLI, with a personal access token) and in the browser (the LYNX grid
// wizard, with the admin's session cookie). Idempotent: existing collections, fields,
// taxonomies, terms and entries (matched by slug) are kept; media is deduplicated by
// content hash on the server.

export interface InstallerClient {
	/** JSON request to /_emdash/api<path>. Resolves the unwrapped `data` or throws ApiError. */
	json<T = unknown>(method: string, path: string, body?: unknown): Promise<T>;
	/** Multipart upload to /_emdash/api/media. */
	upload(file: Blob, filename: string): Promise<{ id: string; url?: string; width?: number; height?: number; mimeType?: string; filename?: string; storageKey?: string; deduplicated?: boolean }>;
}

export class ApiError extends Error {
	readonly status: number;
	readonly code: string;

	constructor(status: number, code: string, message: string) {
		super(message);
		this.name = "ApiError";
		this.status = status;
		this.code = code;
	}
}

/** fetch-based client. `auth` is a bearer token (CLI) or omitted to use the browser session. */
export function fetchClient(baseUrl: string, auth?: { token: string }, fetchImpl: typeof fetch = fetch): InstallerClient {
	const root = `${baseUrl.replace(/\/$/, "")}/_emdash/api`;
	const headers = (extra: Record<string, string> = {}) => ({
		"X-EmDash-Request": "1",
		...(auth ? { Authorization: `Bearer ${auth.token}` } : {}),
		...extra,
	});
	async function unwrap<T>(res: Response): Promise<T> {
		const body = (await res.json().catch(() => null)) as { success?: boolean; data?: T; error?: { code?: string; message?: string } } | null;
		if (!res.ok || body?.success === false) throw new ApiError(res.status, body?.error?.code ?? `HTTP_${res.status}`, body?.error?.message ?? res.statusText);
		return (body?.data ?? body) as T;
	}
	return {
		async json<T>(method: string, path: string, body?: unknown) {
			const res = await fetchImpl(`${root}${path}`, {
				method,
				headers: headers(body === undefined ? {} : { "Content-Type": "application/json" }),
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
				credentials: "same-origin",
			});
			return unwrap<T>(res);
		},
		async upload(file: Blob, filename: string) {
			const form = new FormData();
			form.append("file", file, filename);
			form.append("deduplicate", "true");
			const res = await fetchImpl(`${root}/media`, { method: "POST", headers: headers(), body: form, credentials: "same-origin" });
			const data = await unwrap<{ item: { id: string; url?: string; width?: number; height?: number; mimeType?: string; filename?: string; storageKey?: string }; deduplicated?: boolean }>(res);
			return { ...data.item, deduplicated: data.deduplicated === true };
		},
	};
}

export interface InstallProgress {
	step: "schema" | "taxonomies" | "terms" | "media" | "entries" | "done";
	message: string;
	done?: number;
	total?: number;
}

export interface InstallOptions {
	/** Loads an image of the preset; the CLI reads presets/media, the grid fetches bundled assets. */
	loadImage: (dir: string, img: PresetImage) => Promise<Blob>;
	onProgress?: (p: InstallProgress) => void;
	/** Only install the schema and taxonomies, no demo entries or media. */
	schemaOnly?: boolean;
}

export interface InstallResult {
	collection: { created: boolean; fieldsCreated: string[] };
	taxonomies: { created: string[]; attached: string[] };
	terms: { created: number };
	media: { uploaded: number; reused: number };
	entries: { created: number; skipped: number; published: number };
}

interface TermRow {
	id: string;
	slug: string;
	parentId?: string | null;
	translationGroup?: string | null;
}

export async function installPreset(client: InstallerClient, preset: Preset, options: InstallOptions): Promise<InstallResult> {
	const report = options.onProgress ?? (() => {});
	const result: InstallResult = {
		collection: { created: false, fieldsCreated: [] },
		taxonomies: { created: [], attached: [] },
		terms: { created: 0 },
		media: { uploaded: 0, reused: 0 },
		entries: { created: 0, skipped: 0, published: 0 },
	};
	const c = preset.collection;

	// 1. Collection and fields
	report({ step: "schema", message: `Collection ${c.slug}` });
	let existingFields: string[] = [];
	try {
		const got = await client.json<{ item: { fields?: Array<{ slug: string }> } }>("GET", `/schema/collections/${c.slug}?includeFields=true`);
		existingFields = (got.item.fields ?? []).map((f) => f.slug);
		if (!got.item.fields) {
			const fields = await client.json<{ items: Array<{ slug: string }> }>("GET", `/schema/collections/${c.slug}/fields`);
			existingFields = fields.items.map((f) => f.slug);
		}
	} catch (err) {
		if (!(err instanceof ApiError) || err.status !== 404) throw err;
		await client.json("POST", "/schema/collections", { slug: c.slug, label: c.label, labelSingular: c.labelSingular, description: c.description, supports: c.supports });
		result.collection.created = true;
	}
	for (const f of c.fields) {
		if (existingFields.includes(f.slug)) continue;
		await client.json("POST", `/schema/collections/${c.slug}/fields`, { ...f, validation: f.validation ?? null });
		result.collection.fieldsCreated.push(f.slug);
	}

	// 2. Taxonomy definitions (attach the collection to shared ones such as "location")
	report({ step: "taxonomies", message: "Taxonomies" });
	const defs = await client.json<{ taxonomies: Array<{ name: string; collections: string[] }> }>("GET", "/taxonomies");
	for (const t of preset.taxonomies) {
		const def = defs.taxonomies.find((d) => d.name === t.name);
		if (!def) {
			await client.json("POST", "/taxonomies", { name: t.name, label: t.label, labelSingular: t.labelSingular, hierarchical: t.hierarchical, collections: [c.slug] });
			result.taxonomies.created.push(t.name);
		} else if (!def.collections.includes(c.slug)) {
			await client.json("PUT", `/taxonomies/${t.name}`, { collections: [...def.collections, c.slug] });
			result.taxonomies.attached.push(t.name);
		}
	}
	// One-term taxonomies are a LYNX setting (EmDash allows several terms everywhere). Without the
	// LYNX core on the site there is nobody to keep it: the install goes on.
	for (const t of preset.taxonomies.filter((x) => x.single)) {
		await client.json("POST", "/plugins/lynx/taxonomy/single", { taxonomy: t.name, single: true }).catch(() => undefined);
	}

	// 3. Terms, parents first
	for (const t of preset.taxonomies) {
		report({ step: "terms", message: `Terms of ${t.name}` });
		const list = await client.json<{ terms?: TermRow[]; items?: TermRow[] }>("GET", `/taxonomies/${t.name}/terms`);
		// Hierarchical taxonomies come back as a tree (children nested under each term).
		const flat: TermRow[] = [];
		const walk = (rows: Array<TermRow & { children?: TermRow[] }>) => {
			for (const r of rows) {
				flat.push(r);
				if (r.children?.length) walk(r.children);
			}
		};
		walk(list.terms ?? list.items ?? []);
		const bySlug = new Map(flat.map((x) => [x.slug, x]));
		for (const term of t.terms) {
			if (bySlug.has(term.slug)) continue;
			const parent = term.parent ? bySlug.get(term.parent) : undefined;
			const created = await client.json<{ term?: TermRow; item?: TermRow }>("POST", `/taxonomies/${t.name}/terms`, {
				slug: term.slug,
				label: term.label,
				...(parent ? { parentId: parent.id } : {}),
			});
			const row = created.term ?? created.item;
			if (row) bySlug.set(term.slug, row);
			result.terms.created++;
		}
	}
	if (options.schemaOnly) {
		report({ step: "done", message: "Schema installed" });
		return result;
	}

	// 4. Media: upload each distinct image once
	const images = new Map<string, PresetImage>();
	for (const e of preset.entries) for (const img of [e.cover, ...e.gallery]) images.set(img.file, img);
	const mediaValues = new Map<string, Record<string, unknown>>();
	let n = 0;
	for (const img of images.values()) {
		report({ step: "media", message: img.file, done: n++, total: images.size });
		const blob = await options.loadImage(preset.mediaDir, img);
		const item = await client.upload(blob, img.file);
		mediaValues.set(img.file, {
			provider: "local",
			id: item.id,
			alt: img.alt,
			...(item.width ? { width: item.width } : {}),
			...(item.height ? { height: item.height } : {}),
			mimeType: item.mimeType ?? blob.type,
			filename: item.filename ?? img.file,
			...(item.storageKey ? { meta: { storageKey: item.storageKey } } : {}),
		});
		if (item.deduplicated) result.media.reused++;
		else result.media.uploaded++;
	}

	// 5. Entries, matched by slug
	let i = 0;
	for (const e of preset.entries) {
		report({ step: "entries", message: e.slug, done: i++, total: preset.entries.length });
		try {
			await client.json("GET", `/content/${c.slug}/${e.slug}`);
			result.entries.skipped++;
			continue;
		} catch (err) {
			if (!(err instanceof ApiError) || err.status !== 404) throw err;
		}
		const created = await client.json<{ item: { id: string } }>("POST", `/content/${c.slug}`, {
			slug: e.slug,
			data: { ...e.data, cover: mediaValues.get(e.cover.file), gallery: e.gallery.map((g) => ({ image: mediaValues.get(g.file) })) },
			taxonomies: e.taxonomies,
		});
		result.entries.created++;
		if (e.status === "published") {
			await client.json("POST", `/content/${c.slug}/${created.item.id}/publish`);
			result.entries.published++;
		}
	}
	report({ step: "done", message: `${preset.name}: ${result.entries.created} entries created` });
	return result;
}
