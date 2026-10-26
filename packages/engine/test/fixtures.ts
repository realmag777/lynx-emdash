import type { CollectionDef, Entry, TermDef } from "../src/types.ts";

export const cars: CollectionDef = {
	slug: "cars",
	label: "Cars",
	supports: ["drafts", "revisions", "search"],
	titleField: "title",
	fields: [
		{ slug: "title", label: "Title", type: "string", required: true, searchable: true },
		{ slug: "price", label: "Price", type: "number", indexed: true, translatable: false, validation: { min: 0 } },
		{ slug: "year", label: "Year", type: "integer", indexed: true, translatable: false, validation: { min: 1950, max: 2030 } },
		{ slug: "mileage_km", label: "Mileage", type: "integer", indexed: true, translatable: false, validation: { min: 0 } },
		{ slug: "transmission", label: "Transmission", type: "select", indexed: true, translatable: false, validation: { options: ["manual", "automatic"] } },
		{ slug: "color", label: "Colour", type: "select", indexed: true, validation: { options: ["black", "white", "silver", "grey", "blue", "red", "green", "orange"] } },
		{ slug: "vin", label: "VIN", type: "string", indexed: true, unique: true, translatable: false, validation: { pattern: "^[A-HJ-NPR-Z0-9]{17}$" } },
		{ slug: "features", label: "Features", type: "multiSelect", validation: { options: ["navigation", "heated_seats", "parking_camera", "tow_bar", "panoramic_roof"] } },
		{ slug: "available_from", label: "Available from", type: "datetime" },
		{ slug: "featured", label: "Featured", type: "boolean" },
		{ slug: "website", label: "Website", type: "url" },
		{ slug: "description", label: "Description", type: "portableText" },
		{ slug: "dealer", label: "Dealer", type: "reference", validation: { relation: "car-dealer" } },
	],
	taxonomies: [
		{ name: "make", label: "Make", hierarchical: true, collections: ["cars"] },
		{ name: "fuel", label: "Fuel", hierarchical: false, collections: ["cars"] },
	],
};

export const plainCollection: CollectionDef = { ...cars, slug: "plain", supports: ["drafts"] };

export const terms: Record<string, TermDef[]> = {
	make: [
		{ id: "t-bmw", taxonomy: "make", slug: "bmw", label: "BMW", parentId: null, translationGroup: "g-bmw" },
		{ id: "t-3series", taxonomy: "make", slug: "bmw-3-series", label: "3 Series", parentId: "g-bmw", translationGroup: "g-3series" },
		{ id: "t-audi", taxonomy: "make", slug: "audi", label: "Audi", parentId: null, translationGroup: "g-audi" },
		{ id: "t-a4", taxonomy: "make", slug: "audi-a4", label: "A4", parentId: "g-audi", translationGroup: "g-a4" },
	],
	fuel: [
		{ id: "t-diesel", taxonomy: "fuel", slug: "diesel", label: "Diesel", parentId: null },
		{ id: "t-petrol", taxonomy: "fuel", slug: "petrol", label: "Petrol", parentId: null },
		{ id: "t-electric", taxonomy: "fuel", slug: "electric", label: "Electric", parentId: null },
	],
};

const pt = (text: string) => [{ _type: "block", _key: "b1", style: "normal", markDefs: [], children: [{ _type: "span", _key: "s1", text, marks: [] }] }];

export function carEntries(): Entry[] {
	return [
		{
			id: "c1",
			slug: "bmw-320d-touring",
			status: "published",
			locale: "en",
			data: { title: "BMW 320d Touring", price: 18900, year: 2019, mileage_km: 112400, transmission: "automatic", color: "blue", vin: "WBA8E5105K1234567", features: ["navigation"], featured: 1, description: pt("Well kept estate with sea view parking.") },
			terms: { make: ["t-bmw", "t-3series"], fuel: ["t-diesel"] },
		},
		{
			id: "c2",
			slug: "audi-a4-avant",
			status: "published",
			locale: "en",
			data: { title: "Audi A4 Avant", price: 21500, year: 2020, mileage_km: 84000, transmission: "automatic", color: "black", vin: "WAUZZZF45LA000001", features: [], featured: 0 },
			terms: { make: ["t-audi", "t-a4"], fuel: ["t-petrol"] },
		},
		{
			id: "c3",
			slug: "city-car",
			status: "draft",
			locale: "en",
			data: { title: "City car", price: null, year: 2016, mileage_km: 150000, transmission: "manual", color: "red", vin: null },
			terms: { make: [], fuel: ["t-petrol"] },
		},
	];
}
