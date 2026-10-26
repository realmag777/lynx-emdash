import type { Preset, PresetImage } from "./model.ts";

// EmDash seed files (validated with validateSeed() from emdash/seed).
// `$media` must be a public http(s) URL: the seed applier downloads it through its
// SSRF guard, so localhost and private hosts are refused. The base URL is therefore
// a parameter; the REST installer (installer.ts) uploads the local files instead.

export const DEFAULT_MEDIA_BASE_URL = "https://example.com/lynx-presets/media";

function media(img: PresetImage, base: string, dir: string) {
	return { $media: { url: `${base.replace(/\/$/, "")}/${dir}/${img.file}`, alt: img.alt, filename: img.file } };
}

export function toSeed(presets: Preset[], mediaBaseUrl = DEFAULT_MEDIA_BASE_URL): Record<string, unknown> {
	const taxonomies = new Map<string, { name: string; label: string; labelSingular: string; hierarchical: boolean; collections: string[]; terms: Array<{ slug: string; label: string; parent?: string }> }>();
	for (const p of presets) {
		for (const t of p.taxonomies) {
			const existing = taxonomies.get(t.name);
			if (existing) {
				if (!existing.collections.includes(p.collection.slug)) existing.collections.push(p.collection.slug);
				for (const term of t.terms) if (!existing.terms.some((x) => x.slug === term.slug)) existing.terms.push(term);
			} else {
				taxonomies.set(t.name, { name: t.name, label: t.label, labelSingular: t.labelSingular, hierarchical: t.hierarchical, collections: [p.collection.slug], terms: t.terms.map((x) => ({ ...x })) });
			}
		}
	}
	return {
		$schema: "https://emdashcms.com/seed.schema.json",
		version: "1",
		meta: {
			name: presets.length === 1 ? `LYNX preset: ${presets[0]!.name}` : `LYNX presets: ${presets.map((p) => p.name).join(" + ")}`,
			description: presets.map((p) => p.description).join(" "),
			author: "realmag777",
		},
		collections: presets.map((p) => ({
			slug: p.collection.slug,
			label: p.collection.label,
			labelSingular: p.collection.labelSingular,
			description: p.collection.description,
			supports: p.collection.supports,
			fields: p.collection.fields,
		})),
		taxonomies: [...taxonomies.values()],
		content: Object.fromEntries(
			presets.map((p) => [
				p.collection.slug,
				p.entries.map((e) => ({
					id: e.id,
					slug: e.slug,
					status: e.status,
					data: {
						...e.data,
						cover: media(e.cover, mediaBaseUrl, p.mediaDir),
						gallery: e.gallery.map((img) => ({ image: media(img, mediaBaseUrl, p.mediaDir) })),
					},
					taxonomies: e.taxonomies,
				})),
			]),
		),
	};
}
