import { LOCATIONS, portableText, prng, slugify, type Preset, type PresetEntry, type PresetImage } from "./model.ts";

const IMG = {
	silverHatch: { file: "car-01.jpg", alt: "Silver compact hatchback on a dealership forecourt" },
	blackSedan: { file: "car-02.jpg", alt: "Black executive sedan on a city street" },
	whiteSuv: { file: "car-03.jpg", alt: "White mid-size SUV in a showroom" },
	blueEstate: { file: "car-04.jpg", alt: "Dark blue estate car on a driveway" },
	redCity: { file: "car-05.jpg", alt: "Red city car on a Mediterranean street" },
	greyElectric: { file: "car-06.jpg", alt: "Grey electric fastback at a charging station" },
	greenCrossover: { file: "car-07.jpg", alt: "Dark green crossover on a countryside road" },
	whiteMpv: { file: "car-08.jpg", alt: "White seven-seat MPV in a car park" },
	dashboard: { file: "car-09.jpg", alt: "Dashboard and steering wheel with digital instruments" },
	rearSeats: { file: "car-10.jpg", alt: "Rear seats with light leather upholstery" },
	pearlSuv: { file: "car-11.jpg", alt: "Pearl white large SUV on a coastal road" },
	orangeHatch: { file: "car-12.jpg", alt: "Orange sporty hatchback in an urban car park" },
} satisfies Record<string, PresetImage>;

const FEATURES = ["Navigation", "Heated seats", "Parking camera", "Parking sensors", "Adaptive cruise control", "Apple CarPlay", "Leather seats", "Panoramic roof", "Tow bar", "LED headlights", "Keyless entry", "Heat pump"];

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

type Row = [
	make: string,
	model: string,
	trim: string,
	body: string,
	fuel: string,
	year: number,
	mileage: number,
	price: number,
	engine: number | null,
	hp: number,
	gearbox: "manual" | "automatic",
	doors: number,
	seats: number,
	color: string,
	city: string,
	image: keyof typeof IMG,
];

// Realistic Spanish used-car market figures (EUR), autumn 2026.
const ROWS: Row[] = [
	["BMW", "3 Series", "320d Touring", "estate", "diesel", 2019, 112400, 18900, 2.0, 190, "automatic", 5, 5, "blue", "malaga", "blueEstate"],
	["BMW", "3 Series", "330e Sedan", "sedan", "hybrid", 2021, 64200, 31500, 2.0, 292, "automatic", 4, 5, "black", "marbella", "blackSedan"],
	["BMW", "X3", "xDrive20d", "suv", "diesel", 2020, 88900, 29900, 2.0, 190, "automatic", 5, 5, "white", "valencia", "whiteSuv"],
	["BMW", "1 Series", "118i Sport", "hatchback", "petrol", 2022, 31000, 24900, 1.5, 136, "manual", 5, 5, "silver", "alicante", "silverHatch"],
	["Mercedes-Benz", "C-Class", "C 220 d", "sedan", "diesel", 2020, 97300, 27400, 2.0, 200, "automatic", 4, 5, "black", "malaga", "blackSedan"],
	["Mercedes-Benz", "GLC", "300 e 4MATIC", "suv", "hybrid", 2022, 41800, 45900, 2.0, 320, "automatic", 5, 5, "white", "marbella", "pearlSuv"],
	["Mercedes-Benz", "A-Class", "A 180", "hatchback", "petrol", 2019, 73500, 19500, 1.3, 136, "automatic", 5, 5, "silver", "estepona", "silverHatch"],
	["Audi", "A3", "Sportback 35 TFSI", "hatchback", "petrol", 2021, 45200, 25800, 1.5, 150, "automatic", 5, 5, "grey", "valencia", "silverHatch"],
	["Audi", "A4", "Avant 40 TDI", "estate", "diesel", 2020, 84000, 26900, 2.0, 204, "automatic", 5, 5, "blue", "benidorm", "blueEstate"],
	["Audi", "Q5", "45 TFSI quattro", "suv", "petrol", 2019, 99800, 30500, 2.0, 265, "automatic", 5, 5, "white", "altea", "whiteSuv"],
	["Volkswagen", "Golf", "1.5 TSI Life", "hatchback", "petrol", 2022, 28700, 22400, 1.5, 130, "manual", 5, 5, "silver", "malaga", "silverHatch"],
	["Volkswagen", "Passat", "Variant 2.0 TDI", "estate", "diesel", 2018, 148000, 15900, 2.0, 150, "automatic", 5, 5, "blue", "alicante", "blueEstate"],
	["Volkswagen", "Tiguan", "2.0 TDI 4Motion", "suv", "diesel", 2021, 59900, 29800, 2.0, 150, "automatic", 5, 5, "green", "valencia", "greenCrossover"],
	["Volkswagen", "ID.3", "Pro Performance", "hatchback", "electric", 2023, 18400, 27900, null, 204, "automatic", 5, 5, "grey", "valencia", "greyElectric"],
	["Toyota", "Corolla", "1.8 Hybrid Active", "hatchback", "hybrid", 2021, 52300, 19900, 1.8, 122, "automatic", 5, 5, "silver", "marbella", "silverHatch"],
	["Toyota", "RAV4", "2.5 Hybrid AWD", "suv", "hybrid", 2022, 38800, 36500, 2.5, 222, "automatic", 5, 5, "white", "estepona", "pearlSuv"],
	["Toyota", "Yaris", "1.5 Hybrid", "city_car", "hybrid", 2020, 61000, 15400, 1.5, 116, "automatic", 5, 5, "red", "malaga", "redCity"],
	["Škoda", "Octavia", "Combi 2.0 TDI Style", "estate", "diesel", 2021, 76500, 21900, 2.0, 150, "automatic", 5, 5, "blue", "benidorm", "blueEstate"],
	["Škoda", "Kodiaq", "2.0 TDI 7-seater", "suv", "diesel", 2020, 91200, 27900, 2.0, 150, "automatic", 5, 7, "white", "valencia", "whiteMpv"],
	["Renault", "Clio", "TCe 90 Evolution", "city_car", "petrol", 2022, 24100, 15900, 1.0, 90, "manual", 5, 5, "red", "alicante", "redCity"],
	["Renault", "Captur", "E-Tech Hybrid", "crossover", "hybrid", 2023, 12900, 24500, 1.6, 145, "automatic", 5, 5, "green", "altea", "greenCrossover"],
	["Peugeot", "308", "1.2 PureTech Allure", "hatchback", "petrol", 2021, 47800, 18400, 1.2, 130, "manual", 5, 5, "orange", "estepona", "orangeHatch"],
	["Peugeot", "5008", "1.5 BlueHDi GT", "mpv", "diesel", 2020, 103400, 23900, 1.5, 130, "automatic", 5, 7, "white", "malaga", "whiteMpv"],
	["Volvo", "XC60", "B4 Momentum", "suv", "hybrid", 2021, 69800, 34900, 2.0, 197, "automatic", 5, 5, "white", "marbella", "pearlSuv"],
	["Volvo", "V60", "D4 Inscription", "estate", "diesel", 2019, 118600, 19800, 2.0, 190, "automatic", 5, 5, "grey", "valencia", "blueEstate"],
	["Tesla", "Model 3", "Long Range AWD", "sedan", "electric", 2022, 45100, 33900, null, 440, "automatic", 4, 5, "grey", "malaga", "greyElectric"],
	["Ford", "Focus", "1.0 EcoBoost ST-Line", "hatchback", "petrol", 2020, 67200, 16900, 1.0, 125, "manual", 5, 5, "orange", "alicante", "orangeHatch"],
	["Ford", "Kuga", "2.5 PHEV Titanium", "crossover", "hybrid", 2022, 36900, 29400, 2.5, 225, "automatic", 5, 5, "green", "benidorm", "greenCrossover"],
	["Hyundai", "Tucson", "1.6 T-GDI HEV", "suv", "hybrid", 2023, 15800, 33400, 1.6, 230, "automatic", 5, 5, "white", "valencia", "whiteSuv"],
	["Kia", "Sportage", "1.6 CRDi Drive", "suv", "diesel", 2019, 107900, 18900, 1.6, 136, "manual", 5, 5, "silver", "estepona", "whiteSuv"],
];

/** A handover date in October-November 2026, 9:00-12:30 UTC on a weekday, the same for every build. */
function availableFrom(i: number): string {
	const d = new Date(Date.UTC(2026, 9, 5 + ((i * 7) % 45), 9 + (i % 4), (i % 2) * 30));
	if (d.getUTCDay() === 0) d.setUTCDate(d.getUTCDate() + 1);
	if (d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 2);
	return d.toISOString();
}

const VIN_CHARS = "ABCDEFGHJKLMNPRSTUVWXYZ0123456789";

function vin(rand: () => number, prefix: string): string {
	let s = prefix;
	while (s.length < 17) s += VIN_CHARS[Math.floor(rand() * VIN_CHARS.length)];
	return s;
}

const WMI: Record<string, string> = { BMW: "WBA", "Mercedes-Benz": "WDD", Audi: "WAU", Volkswagen: "WVW", Toyota: "SB1", Škoda: "TMB", Renault: "VF1", Peugeot: "VF3", Volvo: "YV1", Tesla: "5YJ", Ford: "WF0", Hyundai: "TMA", Kia: "U5Y" };

function describe(r: Row, rand: () => number): string[] {
	const [make, model, trim, , fuel, year, mileage, , , hp, gearbox] = r;
	const owner = rand() > 0.5 ? "one owner" : "two owners";
	const service = rand() > 0.3 ? "full main-dealer service history" : "documented service history";
	const p = [
		`${make} ${model} ${trim} from ${year} with ${mileage.toLocaleString("en")} km, ${owner} and a **${service}**.`,
		`${hp} hp ${fuel === "electric" ? "electric drive" : `${fuel} engine`} with ${gearbox === "automatic" ? "an automatic gearbox" : "a manual gearbox"}. ITV (MOT) passed, two keys, ready to drive away.`,
		rand() > 0.5 ? `Financing available on request. See our [warranty terms](https://example.com/warranty) for details.` : `Part exchange welcome. Viewing by appointment at our showroom.`,
	];
	return p;
}

function build(): PresetEntry[] {
	const rand = prng(20260929);
	const vins = new Set<string>();
	return ROWS.map((r, i) => {
		const [make, model, trim, body, fuel, year, mileage, price, engine, hp, gearbox, doors, seats, color, city, image] = r;
		let v = vin(rand, WMI[make] ?? "WLX");
		while (vins.has(v)) v = vin(rand, WMI[make] ?? "WLX");
		vins.add(v);
		const featureCount = 3 + Math.floor(rand() * 5);
		const pool = [...FEATURES];
		for (let k = pool.length - 1; k > 0; k--) {
			const j = Math.floor(rand() * (k + 1));
			[pool[k], pool[j]] = [pool[j]!, pool[k]!];
		}
		const features = pool.slice(0, featureCount).sort();
		if (fuel !== "electric") {
			const hp_ = features.indexOf("Heat pump");
			if (hp_ >= 0) features.splice(hp_, 1);
		}
		const title = `${make} ${model} ${trim}`;
		const cover = IMG[image];
		const id = `car-${String(i + 1).padStart(2, "0")}`;
		return {
			id,
			slug: slugify(`${title} ${year}`),
			status: i % 9 === 8 ? "draft" : "published",
			data: {
				title,
				price,
				year,
				mileage_km: mileage,
				engine_l: engine,
				power_hp: hp,
				transmission: cap(gearbox),
				doors,
				seats,
				color: cap(color),
				vin: v,
				condition: year >= 2023 && mileage < 20000 ? "New" : "Used",
				// Ready for handover: a weekday morning in the next weeks (a datetime field for the grid's calendar).
				available_from: availableFrom(i),
				features,
				description: portableText(describe(r, rand), `${id}-`),
			},
			cover,
			gallery: [cover, IMG.dashboard, IMG.rearSeats],
			taxonomies: {
				make: [slugify(make), `${slugify(make)}-${slugify(model)}`],
				body_type: [body],
				fuel: [fuel],
				location: [city],
			},
		};
	});
}

function makeTerms() {
	const out: Array<{ slug: string; label: string; parent?: string }> = [];
	for (const [make, model] of ROWS.map((r) => [r[0], r[1]] as const)) {
		const ms = slugify(make);
		if (!out.some((t) => t.slug === ms)) out.push({ slug: ms, label: make });
		const mm = `${ms}-${slugify(model)}`;
		if (!out.some((t) => t.slug === mm)) out.push({ slug: mm, label: model, parent: ms });
	}
	return out;
}

export const carsPreset: Preset = {
	id: "cars",
	name: "Cars",
	description: "Used and new car listings: price, year, mileage, engine, gearbox, VIN and more, with make → model, body type, fuel and location taxonomies.",
	mediaDir: "cars",
	collection: {
		slug: "cars",
		label: "Cars",
		labelSingular: "Car",
		description: "Vehicle listings (LYNX preset)",
		supports: ["drafts", "revisions", "search"],
		fields: [
			{ slug: "title", label: "Title", type: "string", required: true, indexed: true, searchable: true },
			{ slug: "price", label: "Price", type: "number", indexed: true, translatable: false, validation: { min: 0 } },
			{ slug: "year", label: "Year", type: "integer", indexed: true, translatable: false, validation: { min: 1950, max: 2030 } },
			{ slug: "mileage_km", label: "Mileage (km)", type: "integer", indexed: true, translatable: false, validation: { min: 0 } },
			{ slug: "engine_l", label: "Engine (L)", type: "number", indexed: true, translatable: false, validation: { min: 0, max: 10 } },
			{ slug: "power_hp", label: "Power (hp)", type: "integer", indexed: true, translatable: false, validation: { min: 0, max: 2000 } },
			{ slug: "transmission", label: "Transmission", type: "select", indexed: true, translatable: false, validation: { options: ["Manual", "Automatic"] } },
			{ slug: "doors", label: "Doors", type: "integer", indexed: true, translatable: false, validation: { min: 2, max: 6 } },
			{ slug: "seats", label: "Seats", type: "integer", indexed: true, translatable: false, validation: { min: 1, max: 9 } },
			{ slug: "color", label: "Colour", type: "select", indexed: true, translatable: false, validation: { options: ["Black", "White", "Silver", "Grey", "Blue", "Red", "Green", "Orange", "Brown", "Yellow"] } },
			{ slug: "vin", label: "VIN", type: "string", indexed: true, unique: true, translatable: false, validation: { pattern: "^[A-HJ-NPR-Z0-9]{17}$" } },
			{ slug: "condition", label: "Condition", type: "select", indexed: true, translatable: false, validation: { options: ["New", "Used"] } },
			{ slug: "available_from", label: "Available from", type: "datetime", indexed: true, translatable: false },
			{ slug: "cover", label: "Cover photo", type: "image" },
			{ slug: "gallery", label: "Gallery", type: "repeater", validation: { subFields: [{ slug: "image", label: "Image", type: "image", required: true }], maxItems: 30 } },
			{ slug: "description", label: "Description", type: "portableText", searchable: true },
			{ slug: "features", label: "Features", type: "multiSelect", translatable: false, validation: { options: FEATURES } },
		],
	},
	taxonomies: [
		{ name: "make", label: "Makes", labelSingular: "Make", hierarchical: true, single: true, terms: makeTerms() },
		{
			name: "body_type",
			label: "Body types",
			labelSingular: "Body type",
			hierarchical: false,
			single: true,
			terms: [
				{ slug: "hatchback", label: "Hatchback" },
				{ slug: "sedan", label: "Sedan" },
				{ slug: "estate", label: "Estate" },
				{ slug: "suv", label: "SUV" },
				{ slug: "crossover", label: "Crossover" },
				{ slug: "mpv", label: "MPV" },
				{ slug: "city_car", label: "City car" },
				{ slug: "coupe", label: "Coupé" },
			].map((t) => ({ ...t, slug: t.slug.replace("_", "-") })),
		},
		{
			name: "fuel",
			label: "Fuel types",
			labelSingular: "Fuel",
			hierarchical: false,
			single: true,
			terms: [
				{ slug: "petrol", label: "Petrol" },
				{ slug: "diesel", label: "Diesel" },
				{ slug: "hybrid", label: "Hybrid" },
				{ slug: "electric", label: "Electric" },
			],
		},
		LOCATIONS,
	],
	entries: build().map((e) => ({ ...e, taxonomies: { ...e.taxonomies, body_type: e.taxonomies.body_type!.map((b) => b.replace("_", "-")) } })),
};
