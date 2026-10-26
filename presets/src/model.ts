// Shared shapes of a LYNX preset: one definition feeds both the EmDash seed file
// and the REST installer, so the two cannot drift apart.

export interface PresetField {
	slug: string;
	label: string;
	type: "string" | "text" | "url" | "number" | "integer" | "boolean" | "datetime" | "select" | "multiSelect" | "image" | "repeater" | "portableText";
	required?: boolean;
	indexed?: boolean;
	unique?: boolean;
	searchable?: boolean;
	translatable?: boolean;
	validation?: Record<string, unknown>;
}

export interface PresetTerm {
	slug: string;
	label: string;
	parent?: string;
}

export interface PresetTaxonomy {
	name: string;
	label: string;
	labelSingular: string;
	hierarchical: boolean;
	/** One term per entry (a car has one make, one location): set in LYNX after install. */
	single?: boolean;
	terms: PresetTerm[];
}

/** An image of the preset, stored in presets/media/<dir>/<file>. */
export interface PresetImage {
	file: string;
	alt: string;
}

export interface PresetEntry {
	id: string;
	slug: string;
	status: "published" | "draft";
	/** Plain field values; images are referenced by PresetImage and resolved per target. */
	data: Record<string, unknown>;
	cover: PresetImage;
	gallery: PresetImage[];
	taxonomies: Record<string, string[]>;
}

export interface Preset {
	id: string;
	name: string;
	description: string;
	mediaDir: string;
	collection: {
		slug: string;
		label: string;
		labelSingular: string;
		description: string;
		supports: string[];
		fields: PresetField[];
	};
	taxonomies: PresetTaxonomy[];
	entries: PresetEntry[];
}

/** Deterministic PRNG so generated demo data is identical on every build. */
export function prng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export function slugify(s: string): string {
	return s
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

type Span = { _type: "span"; _key: string; text: string; marks: string[] };

/** Portable Text paragraphs. `**bold**` becomes a strong mark; `[text](url)` becomes a link. */
export function portableText(paragraphs: string[], keyPrefix: string): unknown[] {
	return paragraphs.map((p, bi) => {
		const children: Span[] = [];
		const markDefs: Array<{ _type: "link"; _key: string; href: string }> = [];
		const re = /\*\*(.+?)\*\*|\[(.+?)\]\((.+?)\)/g;
		let last = 0;
		let si = 0;
		const push = (text: string, marks: string[]) => {
			if (text) children.push({ _type: "span", _key: `${keyPrefix}b${bi}s${si++}`, text, marks });
		};
		for (const m of p.matchAll(re)) {
			push(p.slice(last, m.index), []);
			if (m[1]) push(m[1], ["strong"]);
			else {
				const key = `${keyPrefix}b${bi}l${markDefs.length}`;
				markDefs.push({ _type: "link", _key: key, href: m[3]! });
				push(m[2]!, [key]);
			}
			last = (m.index ?? 0) + m[0].length;
		}
		push(p.slice(last), []);
		return { _type: "block", _key: `${keyPrefix}b${bi}`, style: "normal", markDefs, children };
	});
}

/** Spanish-coast location tree shared by both presets (region → city → district). */
export const LOCATIONS: PresetTaxonomy = {
	name: "location",
	label: "Locations",
	labelSingular: "Location",
	hierarchical: true,
	single: true,
	terms: [
		{ slug: "andalucia", label: "Andalucía" },
		{ slug: "malaga", label: "Málaga", parent: "andalucia" },
		{ slug: "malaga-centro", label: "Centro", parent: "malaga" },
		{ slug: "malaga-el-palo", label: "El Palo", parent: "malaga" },
		{ slug: "malaga-teatinos", label: "Teatinos", parent: "malaga" },
		{ slug: "marbella", label: "Marbella", parent: "andalucia" },
		{ slug: "marbella-golden-mile", label: "Golden Mile", parent: "marbella" },
		{ slug: "marbella-nueva-andalucia", label: "Nueva Andalucía", parent: "marbella" },
		{ slug: "marbella-puerto-banus", label: "Puerto Banús", parent: "marbella" },
		{ slug: "estepona", label: "Estepona", parent: "andalucia" },
		{ slug: "estepona-centro", label: "Centro", parent: "estepona" },
		{ slug: "estepona-el-padron", label: "El Padrón", parent: "estepona" },
		{ slug: "valenciana", label: "Comunidad Valenciana" },
		{ slug: "valencia", label: "Valencia", parent: "valenciana" },
		{ slug: "valencia-ruzafa", label: "Ruzafa", parent: "valencia" },
		{ slug: "valencia-cabanyal", label: "El Cabanyal", parent: "valencia" },
		{ slug: "valencia-benimaclet", label: "Benimaclet", parent: "valencia" },
		{ slug: "alicante", label: "Alicante", parent: "valenciana" },
		{ slug: "alicante-centro", label: "Centro", parent: "alicante" },
		{ slug: "alicante-san-juan-playa", label: "San Juan Playa", parent: "alicante" },
		{ slug: "altea", label: "Altea", parent: "valenciana" },
		{ slug: "altea-casco-antiguo", label: "Casco Antiguo", parent: "altea" },
		{ slug: "altea-mascarat", label: "Mascarat", parent: "altea" },
		{ slug: "benidorm", label: "Benidorm", parent: "valenciana" },
		{ slug: "benidorm-levante", label: "Levante", parent: "benidorm" },
		{ slug: "benidorm-poniente", label: "Poniente", parent: "benidorm" },
	],
};
