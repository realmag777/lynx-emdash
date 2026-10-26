import { LOCATIONS, portableText, prng, slugify, type Preset, type PresetEntry, type PresetImage } from "./model.ts";

const IMG = {
	villaPool: { file: "prop-01.jpg", alt: "Modern white villa with an infinity pool and sea view" },
	living: { file: "prop-02.jpg", alt: "Bright living room with large windows and a balcony" },
	kitchen: { file: "prop-03.jpg", alt: "Modern fitted kitchen with an island" },
	bedroom: { file: "prop-04.jpg", alt: "Master bedroom with calm neutral decor" },
	bathroom: { file: "prop-05.jpg", alt: "Bathroom with a walk-in shower and marble tiles" },
	building: { file: "prop-06.jpg", alt: "Contemporary apartment building with balconies and palm trees" },
	terrace: { file: "prop-07.jpg", alt: "Terrace with outdoor furniture overlooking the sea" },
	townhouse: { file: "prop-08.jpg", alt: "Row of whitewashed Andalusian townhouses" },
	studio: { file: "prop-09.jpg", alt: "Compact tidy studio apartment" },
	penthouse: { file: "prop-10.jpg", alt: "Penthouse roof terrace with a city view at dusk" },
	finca: { file: "prop-11.jpg", alt: "Rustic country house among olive trees" },
	garden: { file: "prop-12.jpg", alt: "Private garden with lawn, pool and loungers" },
} satisfies Record<string, PresetImage>;

type Kind = "flat" | "penthouse" | "studio" | "house" | "townhouse" | "villa" | "finca";

type Row = [
	kind: Kind,
	deal: "sale" | "rent",
	district: string,
	price: number,
	area: number,
	plot: number | null,
	bedrooms: number,
	bathrooms: number,
	floor: number | null,
	floorsTotal: number | null,
	yearBuilt: number,
	seaM: number,
	energy: "A" | "B" | "C" | "D" | "E" | "F" | "G",
	amenities: string[],
];

// Asking prices in EUR (rent = per month), autumn 2026.
const ROWS: Row[] = [
	["flat", "sale", "malaga-centro", 385000, 92, null, 2, 2, 4, 7, 2004, 900, "C", ["lift", "air-conditioning", "terrace"]],
	["flat", "rent", "malaga-teatinos", 1450, 85, null, 2, 1, 2, 6, 2012, 3800, "B", ["lift", "parking", "pool", "air-conditioning"]],
	["penthouse", "sale", "malaga-el-palo", 695000, 118, null, 3, 2, 6, 6, 2018, 250, "A", ["sea-view", "terrace", "lift", "parking", "air-conditioning"]],
	["studio", "rent", "malaga-centro", 980, 38, null, 0, 1, 3, 5, 1978, 1100, "E", ["air-conditioning", "furnished"]],
	["villa", "sale", "marbella-golden-mile", 3450000, 520, 1450, 5, 6, null, 2, 2016, 400, "A", ["pool", "sea-view", "garden", "parking", "air-conditioning", "gym"]],
	["villa", "sale", "marbella-nueva-andalucia", 1895000, 380, 1100, 4, 4, null, 2, 2009, 3200, "B", ["pool", "garden", "parking", "air-conditioning"]],
	["flat", "sale", "marbella-puerto-banus", 540000, 110, null, 2, 2, 1, 4, 2006, 150, "C", ["pool", "sea-view", "terrace", "parking", "concierge"]],
	["townhouse", "sale", "marbella-nueva-andalucia", 675000, 195, 120, 3, 3, null, 3, 2001, 3500, "D", ["pool", "terrace", "parking"]],
	["flat", "rent", "estepona-centro", 1250, 78, null, 2, 2, 2, 5, 2010, 350, "C", ["lift", "pool", "sea-view", "air-conditioning"]],
	["penthouse", "sale", "estepona-el-padron", 459000, 104, null, 2, 2, 4, 4, 2021, 600, "A", ["sea-view", "terrace", "pool", "parking"]],
	["house", "sale", "estepona-el-padron", 1150000, 290, 800, 4, 3, null, 2, 1998, 1200, "E", ["pool", "garden", "parking", "sea-view"]],
	["flat", "sale", "valencia-ruzafa", 329000, 96, null, 3, 2, 3, 6, 1965, 4200, "E", ["lift", "air-conditioning", "balcony"]],
	["flat", "rent", "valencia-ruzafa", 1350, 80, null, 2, 1, 1, 5, 1972, 4300, "F", ["balcony", "furnished"]],
	["flat", "sale", "valencia-cabanyal", 289000, 74, null, 2, 1, 2, 3, 1930, 300, "G", ["balcony", "sea-view"]],
	["studio", "rent", "valencia-benimaclet", 750, 34, null, 0, 1, 1, 4, 1985, 5100, "E", ["furnished", "air-conditioning"]],
	["penthouse", "sale", "valencia-benimaclet", 415000, 112, null, 3, 2, 7, 7, 2008, 5000, "C", ["terrace", "lift", "parking", "air-conditioning"]],
	["flat", "sale", "alicante-centro", 215000, 88, null, 3, 2, 5, 9, 1990, 700, "D", ["lift", "balcony", "air-conditioning"]],
	["flat", "rent", "alicante-san-juan-playa", 1100, 90, null, 2, 2, 3, 8, 2003, 120, "C", ["pool", "sea-view", "parking", "lift"]],
	["townhouse", "sale", "alicante-san-juan-playa", 398000, 165, 90, 3, 2, null, 3, 1999, 450, "D", ["terrace", "parking", "garden"]],
	["villa", "sale", "altea-mascarat", 1290000, 310, 900, 4, 4, null, 2, 2015, 200, "A", ["pool", "sea-view", "garden", "parking", "air-conditioning"]],
	["house", "rent", "altea-casco-antiguo", 2400, 140, 60, 3, 2, null, 3, 1920, 700, "F", ["terrace", "sea-view"]],
	["finca", "sale", "altea-casco-antiguo", 845000, 260, 12000, 4, 3, null, 2, 1890, 2500, "F", ["pool", "garden", "parking"]],
	["flat", "sale", "benidorm-levante", 279000, 70, null, 1, 1, 14, 22, 1996, 100, "D", ["sea-view", "pool", "lift", "terrace"]],
	["flat", "rent", "benidorm-poniente", 1050, 65, null, 1, 1, 9, 18, 2009, 150, "C", ["sea-view", "pool", "lift", "parking"]],
	["penthouse", "rent", "benidorm-levante", 2900, 150, null, 3, 3, 24, 24, 2019, 200, "A", ["sea-view", "terrace", "pool", "lift", "parking", "concierge"]],
	["studio", "sale", "benidorm-levante", 139000, 40, null, 0, 1, 6, 15, 1978, 250, "E", ["pool", "lift"]],
	["townhouse", "rent", "malaga-el-palo", 1900, 130, 40, 3, 2, null, 3, 1985, 300, "E", ["terrace", "sea-view"]],
	["finca", "sale", "estepona-el-padron", 1450000, 340, 25000, 5, 4, null, 2, 1975, 6000, "D", ["pool", "garden", "parking", "gym"]],
	["house", "sale", "valencia-benimaclet", 520000, 180, 250, 4, 2, null, 2, 1955, 5200, "F", ["garden", "parking"]],
	["villa", "rent", "marbella-golden-mile", 9500, 420, 1200, 5, 5, null, 2, 2012, 500, "B", ["pool", "sea-view", "garden", "parking", "air-conditioning", "concierge"]],
];

const KIND_LABEL: Record<Kind, string> = { flat: "Flat", penthouse: "Penthouse", studio: "Studio", house: "House", townhouse: "Townhouse", villa: "Villa", finca: "Finca" };

const COVER: Record<Kind, PresetImage> = { flat: IMG.building, penthouse: IMG.penthouse, studio: IMG.studio, house: IMG.garden, townhouse: IMG.townhouse, villa: IMG.villaPool, finca: IMG.finca };

const COORDS: Record<string, [number, number]> = {
	malaga: [36.7213, -4.4214],
	marbella: [36.5101, -4.8825],
	estepona: [36.4276, -5.1463],
	valencia: [39.4699, -0.3763],
	alicante: [38.3452, -0.481],
	altea: [38.5988, -0.0515],
	benidorm: [38.5411, -0.1225],
};

const AMENITIES = [
	["pool", "Pool"],
	["parking", "Parking"],
	["terrace", "Terrace"],
	["balcony", "Balcony"],
	["sea-view", "Sea view"],
	["garden", "Garden"],
	["lift", "Lift"],
	["air-conditioning", "Air conditioning"],
	["furnished", "Furnished"],
	["gym", "Gym"],
	["concierge", "Concierge"],
] as const;

function districtLabel(slug: string): { city: string; district: string } {
	const d = LOCATIONS.terms.find((t) => t.slug === slug)!;
	const c = LOCATIONS.terms.find((t) => t.slug === d.parent)!;
	return { city: c.label, district: d.label };
}

function describe(r: Row, rand: () => number): string[] {
	const [kind, deal, district, , area, plot, bedrooms, , , , yearBuilt, seaM, , amenities] = r;
	const { city, district: dl } = districtLabel(district);
	const rooms = bedrooms === 0 ? "an open-plan layout" : `${bedrooms} bedroom${bedrooms === 1 ? "" : "s"}`;
	const sea = seaM <= 300 ? `just **${seaM} m from the beach**` : `${(seaM / 1000).toFixed(1)} km from the sea`;
	const p = [
		`${KIND_LABEL[kind]} ${deal === "rent" ? "for rent" : "for sale"} in ${dl}, ${city}: ${area} m² with ${rooms}${plot ? ` on a ${plot.toLocaleString("en")} m² plot` : ""}, ${sea}.`,
		`Built in ${yearBuilt}${yearBuilt < 1990 ? " and renovated to a high standard" : ""}. ${amenities.includes("sea-view") ? "Wide sea views from the main rooms. " : ""}${amenities.includes("pool") ? "Communal or private pool. " : ""}Close to shops, schools and public transport.`,
		rand() > 0.5 ? `Book a viewing or ask for the [floor plan](https://example.com/floor-plans).` : `Viewings available seven days a week.`,
	];
	return p;
}

function build(): PresetEntry[] {
	const rand = prng(20260930);
	return ROWS.map((r, i) => {
		const [kind, deal, district, price, area, plot, bedrooms, bathrooms, floor, floorsTotal, yearBuilt, seaM, energy, amenities] = r;
		const city = LOCATIONS.terms.find((t) => t.slug === district)!.parent!;
		const { district: dl, city: cl } = districtLabel(district);
		const [lat, lng] = COORDS[city]!;
		const jitter = () => Math.round((rand() - 0.5) * 0.04 * 1e5) / 1e5;
		const title = `${KIND_LABEL[kind]}${bedrooms ? ` with ${bedrooms} bedroom${bedrooms === 1 ? "" : "s"}` : ""} in ${dl}, ${cl}${deal === "rent" ? " (rent)" : ""}`;
		const id = `prop-${String(i + 1).padStart(2, "0")}`;
		const cover = COVER[kind];
		const interior = kind === "studio" ? [IMG.studio, IMG.bathroom] : [IMG.living, IMG.kitchen, IMG.bedroom, IMG.bathroom];
		const extra = amenities.includes("terrace") || amenities.includes("sea-view") ? [IMG.terrace] : amenities.includes("garden") ? [IMG.garden] : [];
		return {
			id,
			slug: slugify(`${title} ${i + 1}`),
			status: i % 10 === 9 ? "draft" : "published",
			data: {
				title,
				price,
				deal_type: deal === "rent" ? "Rent" : "Sale",
				area_m2: area,
				plot_m2: plot,
				rooms: bedrooms + 1,
				bedrooms,
				bathrooms,
				floor,
				floors_total: floorsTotal,
				year_built: yearBuilt,
				distance_to_sea_m: seaM,
				energy_rating: energy,
				ref_code: `LX-ES-${String(1001 + i)}`,
				// Free to move in or to view from (a datetime field for the grid's calendar).
				available_from: new Date(Date.UTC(2026, 9, 3 + ((i * 11) % 80), 10 + (i % 3), 0)).toISOString(),
				lat: Math.round((lat + jitter()) * 1e5) / 1e5,
				lng: Math.round((lng + jitter()) * 1e5) / 1e5,
				description: portableText(describe(r, rand), `${id}-`),
			},
			cover,
			gallery: [cover, ...interior, ...extra].filter((img, idx, a) => a.findIndex((x) => x.file === img.file) === idx),
			taxonomies: {
				property_type: [kind],
				location: [district],
				amenities,
			},
		};
	});
}

export const realEstatePreset: Preset = {
	id: "real-estate",
	name: "Real estate",
	description: "Property listings for sale and rent: price, area, rooms, floor, year built, distance to the sea, energy rating and reference code, with property type, location and amenities taxonomies.",
	mediaDir: "properties",
	collection: {
		slug: "properties",
		label: "Properties",
		labelSingular: "Property",
		description: "Real-estate listings (LYNX preset)",
		// No revisions on purpose: edits go live at once, which exercises LYNX's cache-refresh path.
		supports: ["drafts", "search"],
		fields: [
			{ slug: "title", label: "Title", type: "string", required: true, indexed: true, searchable: true },
			{ slug: "price", label: "Price", type: "number", indexed: true, translatable: false, validation: { min: 0 } },
			{ slug: "deal_type", label: "Deal", type: "select", indexed: true, translatable: false, validation: { options: ["Sale", "Rent"] } },
			{ slug: "area_m2", label: "Area (m²)", type: "number", indexed: true, translatable: false, validation: { min: 0 } },
			{ slug: "plot_m2", label: "Plot (m²)", type: "number", indexed: true, translatable: false, validation: { min: 0 } },
			{ slug: "rooms", label: "Rooms", type: "integer", indexed: true, translatable: false, validation: { min: 0, max: 50 } },
			{ slug: "bedrooms", label: "Bedrooms", type: "integer", indexed: true, translatable: false, validation: { min: 0, max: 30 } },
			{ slug: "bathrooms", label: "Bathrooms", type: "integer", indexed: true, translatable: false, validation: { min: 0, max: 30 } },
			{ slug: "floor", label: "Floor", type: "integer", indexed: true, translatable: false, validation: { min: -3, max: 200 } },
			{ slug: "floors_total", label: "Floors in building", type: "integer", indexed: true, translatable: false, validation: { min: 1, max: 200 } },
			{ slug: "year_built", label: "Year built", type: "integer", indexed: true, translatable: false, validation: { min: 1500, max: 2030 } },
			{ slug: "distance_to_sea_m", label: "Distance to sea (m)", type: "integer", indexed: true, translatable: false, validation: { min: 0 } },
			{ slug: "energy_rating", label: "Energy rating", type: "select", indexed: true, translatable: false, validation: { options: ["A", "B", "C", "D", "E", "F", "G"] } },
			{ slug: "available_from", label: "Available from", type: "datetime", indexed: true, translatable: false },
			{ slug: "ref_code", label: "Reference", type: "string", indexed: true, unique: true, translatable: false, validation: { pattern: "^LX-[A-Z]{2}-\\d{4,6}$" } },
			{ slug: "lat", label: "Latitude", type: "number", translatable: false, validation: { min: -90, max: 90 } },
			{ slug: "lng", label: "Longitude", type: "number", translatable: false, validation: { min: -180, max: 180 } },
			{ slug: "cover", label: "Cover photo", type: "image" },
			{ slug: "gallery", label: "Gallery", type: "repeater", validation: { subFields: [{ slug: "image", label: "Image", type: "image", required: true }], maxItems: 40 } },
			{ slug: "description", label: "Description", type: "portableText", searchable: true },
		],
	},
	taxonomies: [
		{
			name: "property_type",
			label: "Property types",
			labelSingular: "Property type",
			hierarchical: false,
			single: true,
			terms: (Object.keys(KIND_LABEL) as Kind[]).map((k) => ({ slug: k, label: KIND_LABEL[k] })),
		},
		LOCATIONS,
		{ name: "amenities", label: "Amenities", labelSingular: "Amenity", hierarchical: false, terms: AMENITIES.map(([slug, label]) => ({ slug, label })) },
	],
	entries: build(),
};
