// Host-agnostic data model. Shapes mirror EmDash 1.0 (see 
// but nothing here imports EmDash, so the engine can back other adapters later.

export const FIELD_TYPES = [
	"string",
	"text",
	"url",
	"slug",
	"datetime",
	"select",
	"image",
	"file",
	"number",
	"integer",
	"boolean",
	"multiSelect",
	"portableText",
	"json",
	"repeater",
	"blocks",
	"reference",
] as const;

export type FieldType = (typeof FIELD_TYPES)[number];

export interface FieldValidation {
	min?: number;
	max?: number;
	minLength?: number;
	maxLength?: number;
	pattern?: string;
	options?: string[];
	minItems?: number;
	maxItems?: number;
	subFields?: Array<{ slug: string; type: string; label?: string; required?: boolean; options?: string[] }>;
	[key: string]: unknown;
}

export interface FieldDef {
	slug: string;
	label: string;
	type: FieldType;
	required?: boolean;
	unique?: boolean;
	indexed?: boolean;
	searchable?: boolean;
	translatable?: boolean;
	validation?: FieldValidation | null;
	default?: unknown;
}

export interface TaxonomyDef {
	name: string;
	label: string;
	labelSingular?: string;
	hierarchical: boolean;
	/** One term per entry (a car has one make): LYNX's own setting, EmDash allows several. */
	single?: boolean;
	collections: string[];
}

export interface TermDef {
	id: string;
	taxonomy: string;
	slug: string;
	label: string;
	/** Parent's translation group (EmDash stores the locale-agnostic id). */
	parentId: string | null;
	translationGroup?: string | null;
}

export interface CollectionDef {
	slug: string;
	label: string;
	supports: string[];
	fields: FieldDef[];
	titleField?: string | null;
	dateField?: string | null;
	/** Taxonomy definitions attached to this collection. */
	taxonomies?: TaxonomyDef[];
}

export type EntryStatus = "draft" | "published" | "scheduled" | "archived" | (string & {});

export interface Entry {
	id: string;
	slug: string | null;
	status: EntryStatus;
	locale: string | null;
	translationGroup?: string | null;
	data: Record<string, unknown>;
	/** Assigned term slugs keyed by taxonomy name. Present only when loaded. */
	terms?: Record<string, string[]>;
	version?: number;
	/** Set when the entry has an unpublished draft revision. */
	draftRevisionId?: string | null;
	createdAt?: string;
	updatedAt?: string;
	publishedAt?: string | null;
	scheduledAt?: string | null;
}

export function usesRevisions(collection: Pick<CollectionDef, "supports">): boolean {
	return collection.supports.includes("revisions");
}
