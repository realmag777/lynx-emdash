// What each case is for, shown to agents in the cases tool description (mcp.ts). Kept out of
// cases.ts so the texts ship in the manifest, not in the size-limited sandbox bundle.

export const CASE_TEXTS: Record<string, { title: string; question: string; answers: string; params: Record<string, string> }> = {
	reprice_older: {
		title: "Reprice older stock",
		question: "Lower (or raise) the price of everything older than a given year by a percentage.",
		answers: "Which entries it touches, what each price becomes, the warnings - and the exact call to apply it. Nothing is written until you say so.",
		params: {
			collection: "Collection with integer year and number price fields.",
			before_year: "Entries with year below this.",
			percent: "How much, in percent.",
			direction: "decrease or increase.",
			round_to: "Round the new price down to a multiple of this (0 = no rounding).",
			mode: "draft or publish (collections with revisions).",
		},
	},
	tag_near_sea: {
		title: "Tag properties near the sea",
		question: "Mark every property within a distance of the sea with an amenity term, such as sea view.",
		answers: "The properties that would get the term, the warnings, and the exact call to apply it. Nothing is written until you say so.",
		params: {
			collection: "Collection with an integer distance_to_sea_m field.",
			max_distance_m: "Distance to the sea in metres, inclusive.",
			taxonomy: "Taxonomy of the term.",
			term: "Term slug to add.",
		},
	},
	incomplete_entries: {
		title: "What is missing",
		question: "Which entries lack a photo, a description, a price or another field that should be filled in?",
		answers: "For each field, how many entries leave it empty, with a few examples - a to-do list for the catalogue.",
		params: {
			collection: "Collection to check.",
		},
	},
	drafts_to_review: {
		title: "Drafts waiting",
		question: "Which entries are still drafts and have never been published?",
		answers: "The count and the first of them, ready to be published together once you have checked them.",
		params: {
			collection: "Collection to check.",
		},
	},
	duplicate_codes: {
		title: "Duplicate codes",
		question: "Do two entries share a VIN, a reference code or another value that must be unique?",
		answers: "Every value used more than once and the entries that share it. EmDash stores the unique flag but does not enforce it, so duplicates can slip in by hand.",
		params: {
			collection: "Collection with unique fields.",
		},
	},
};
