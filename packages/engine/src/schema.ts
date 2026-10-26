import type { CollectionDef, FieldDef, FieldType, TaxonomyDef } from "./types.ts";
import { isNumericType } from "./values.ts";

// One table drives what the UI offers, what list_fields reports, and what the
// planner accepts. BEAR's lesson: never offer a behaviour the engine would
// silently ignore (docs/bear-mcp-study.md §3.4).

export const BEHAVIORS = [
	"set",
	"clear",
	"append",
	"prepend",
	"replace",
	"change_case",
	"trim",
	"slugify",
	"increase_by",
	"decrease_by",
	"increase_percent",
	"decrease_percent",
	"multiply",
	"round",
	"copy_from",
	"toggle",
	"add_values",
	"remove_values",
	"replace_value",
	"shift_date",
	"add_terms",
	"remove_terms",
	"set_terms",
	"publish",
	"unpublish",
	"schedule",
	"unschedule",
	"duplicate",
	"trash",
] as const;

export type Behavior = (typeof BEHAVIORS)[number];

/** Behaviours computed from the current value: they skip entries whose value is empty (never write 0). */
export const COMPUTED_BEHAVIORS: ReadonlySet<Behavior> = new Set(["increase_by", "decrease_by", "increase_percent", "decrease_percent", "multiply", "round"]);

export const BEHAVIOR_HELP: Record<Behavior, string> = {
	set: "Replace the value with `value`.",
	clear: "Empty the field (not allowed on required fields).",
	append: "Add `value` at the end (text: joined with `separator`, default none; Portable Text: new paragraphs).",
	prepend: "Add `value` at the start (text: joined with `separator`; Portable Text: new paragraphs).",
	replace: "Find `find` and replace it with `replace`. Options: `regex`, `caseSensitive`, `wholeWord`. Portable Text is edited in place, formatting kept.",
	change_case: "Change letter case: `case` = upper, lower, title or sentence.",
	trim: "Remove leading/trailing whitespace and collapse inner runs of spaces.",
	slugify: "Build a URL slug from `source` (another field) or from the current value.",
	increase_by: "Add `value` to the number. Empty values are skipped.",
	decrease_by: "Subtract `value` from the number. Empty values are skipped.",
	increase_percent: "Raise the number by `value` percent. Empty values are skipped.",
	decrease_percent: "Lower the number by `value` percent. Empty values are skipped.",
	multiply: "Multiply the number by `value`. Empty values are skipped.",
	round: "Round to a multiple of `step` (default 1), `direction` nearest|up|down, optional price `ending` (e.g. 0.99 or 990). Empty values are skipped.",
	copy_from: "Copy the value of field `source`; for numbers an optional `percent` adjustment (e.g. -10) is applied to the copied value.",
	toggle: "Flip true/false.",
	add_values: "Add options `value` (a list) to the multi-select, keeping existing ones.",
	remove_values: "Remove options `value` (a list) from the multi-select.",
	replace_value: "Replace option `from` with option `value` where it is set.",
	shift_date: "Move the date by `value` units (`unit` = minutes, hours, days, weeks, months, years; negative moves back). Empty values are skipped.",
	add_terms: "Add terms `value` (term slugs or ids) and keep the ones already assigned. On a hierarchical taxonomy the parents are added too unless `withParents` is false.",
	remove_terms: "Remove terms `value` (term slugs or ids).",
	set_terms: "REPLACE all terms of this taxonomy with `value` (an empty list removes every term). Use add_terms to keep existing ones.",
	publish: "Publish the entry (on collections with revisions this also publishes pending drafts).",
	unpublish: "Return the entry to draft.",
	schedule: "Schedule publication at `value` (a future date).",
	unschedule: "Cancel a scheduled publication.",
	duplicate: "Create a draft copy of each entry (title gets \" (Copy)\", unique fields are left empty). Must be the first operation; the operations after it change the copy, never the original.",
	trash: "Move the entry to the trash (published entries go offline). Must be the only operation. rollback_bulk restores the entries and publishes again those that were published.",
};

const BY_TYPE: Record<FieldType, Behavior[]> = {
	string: ["set", "clear", "append", "prepend", "replace", "change_case", "trim", "copy_from"],
	text: ["set", "clear", "append", "prepend", "replace", "change_case", "trim", "copy_from"],
	url: ["set", "clear", "append", "prepend", "replace", "copy_from"],
	slug: ["set", "clear", "replace", "slugify", "copy_from"],
	number: ["set", "clear", "increase_by", "decrease_by", "increase_percent", "decrease_percent", "multiply", "round", "copy_from"],
	integer: ["set", "clear", "increase_by", "decrease_by", "increase_percent", "decrease_percent", "multiply", "round", "copy_from"],
	boolean: ["set", "toggle", "clear"],
	datetime: ["set", "clear", "shift_date", "copy_from"],
	select: ["set", "clear", "replace_value", "copy_from"],
	multiSelect: ["set", "clear", "add_values", "remove_values", "replace_value"],
	portableText: ["set", "clear", "append", "prepend", "replace"],
	image: ["set", "clear", "copy_from"],
	file: ["set", "clear", "copy_from"],
	reference: ["set", "clear", "copy_from"],
	json: ["set", "clear"],
	repeater: ["set", "clear"],
	blocks: ["set", "clear"],
};

/** Field types EmDash can index (core/src/schema/types.ts:56-66). */
export const INDEXABLE_TYPES: ReadonlySet<FieldType> = new Set(["string", "url", "number", "integer", "boolean", "datetime", "select", "reference", "slug"]);

export type ColumnKind = "system" | "field" | "terms";
export type FilterMode = "host" | "scan" | "terms" | "none";

export interface Column {
	key: string;
	label: string;
	kind: ColumnKind;
	/** Field type, or a pseudo type for system and taxonomy columns. */
	type: FieldType | "id" | "status" | "locale" | "terms" | "entry";
	editable: boolean;
	/** Can take part in a bulk operation. */
	bulk: boolean;
	/** Why the column cannot be edited, shown on the row itself. */
	closed?: string;
	/** host = pushed down to the host query (indexed); scan = evaluated by LYNX over loaded entries; terms = taxonomy scan. */
	filter: FilterMode;
	sortable: boolean;
	behaviors: Behavior[];
	options?: string[];
	required: boolean;
	unique: boolean;
	translatable: boolean;
	numeric: boolean;
	unit?: string;
	/** What to send, for types where the storage shape is not obvious. */
	format?: string;
	field?: FieldDef;
	taxonomy?: TaxonomyDef;
}

export const TERMS_PREFIX = "terms:";

export function termsKey(taxonomy: string): string {
	return `${TERMS_PREFIX}${taxonomy}`;
}

export function taxonomyOfKey(key: string): string | null {
	return key.startsWith(TERMS_PREFIX) ? key.slice(TERMS_PREFIX.length) : null;
}

/** Unit suffixes recognised in field slugs (mileage_km, area_m2 …). Display only. */
const UNIT_SUFFIXES: Array<[RegExp, string]> = [
	[/_km$/, "km"],
	[/_m2$/, "m²"],
	[/_m$/, "m"],
	[/_l$/, "l"],
	[/_hp$/, "hp"],
	[/_kw$/, "kW"],
	[/_kg$/, "kg"],
	[/_cm$/, "cm"],
	[/(^|_)(price|cost|amount)$/, "currency"],
];

export function unitOf(slug: string): string | undefined {
	return UNIT_SUFFIXES.find(([re]) => re.test(slug))?.[1];
}

const DATE_FORMAT = "a date as 2026-01-31 (read as UTC midnight) or a full ISO date-time such as 2026-01-31T14:30:00Z";

function fieldColumn(collection: CollectionDef, field: FieldDef): Column {
	const bound = field.type === "reference" && field.validation?.relation;
	const behaviors = bound ? [] : BY_TYPE[field.type];
	const indexed = Boolean(field.indexed) && INDEXABLE_TYPES.has(field.type);
	return {
		key: field.slug,
		label: field.label,
		kind: "field",
		type: field.type,
		editable: !bound,
		bulk: !bound,
		...(bound ? { closed: "relation: edit it in the entry editor" } : {}),
		filter: bound ? "none" : indexed ? "host" : "scan",
		sortable: indexed || field.slug === collection.titleField || field.slug === collection.dateField,
		behaviors,
		...(field.validation?.options?.length ? { options: field.validation.options } : {}),
		required: Boolean(field.required),
		unique: Boolean(field.unique),
		translatable: field.translatable !== false,
		numeric: isNumericType(field.type),
		...(isNumericType(field.type) && unitOf(field.slug) ? { unit: unitOf(field.slug) } : {}),
		...(field.type === "datetime" ? { format: DATE_FORMAT } : {}),
		...(field.type === "image" || field.type === "file" ? { format: "a media id from the media library, or an object {id, alt}" } : {}),
		...(field.type === "portableText" ? { format: "plain text (paragraphs separated by a blank line) or Portable Text blocks" } : {}),
		field,
	};
}

function systemColumns(): Column[] {
	const base = { kind: "system" as const, required: false, unique: false, translatable: true, numeric: false };
	return [
		{ ...base, key: "id", label: "ID", type: "id", editable: false, bulk: false, closed: "identity", filter: "none", sortable: false, behaviors: [] },
		{
			...base,
			key: "slug",
			label: "Slug",
			type: "slug",
			editable: true,
			bulk: true,
			filter: "scan",
			sortable: false,
			behaviors: ["set", "replace", "slugify", "append", "prepend"],
			unique: true,
			format: "lowercase letters, digits and single hyphens; unique per locale",
		},
		{
			...base,
			key: "status",
			label: "Status",
			type: "status",
			editable: true,
			bulk: true,
			filter: "host",
			sortable: true,
			behaviors: ["publish", "unpublish", "schedule", "unschedule"],
			options: ["draft", "published", "scheduled"],
		},
		{
			...base,
			key: "entry",
			label: "Entry",
			type: "entry",
			editable: true,
			bulk: true,
			filter: "none",
			sortable: false,
			behaviors: ["duplicate", "trash"],
			format: "the entry as a whole: duplicate makes draft copies, trash moves entries to the trash",
		},
		{ ...base, key: "locale", label: "Locale", type: "locale", editable: false, bulk: false, closed: "identity", filter: "host", sortable: true, behaviors: [] },
		{ ...base, key: "created_at", label: "Created", type: "datetime", editable: false, bulk: false, closed: "read only", filter: "scan", sortable: true, behaviors: [], format: DATE_FORMAT },
		{ ...base, key: "updated_at", label: "Updated", type: "datetime", editable: false, bulk: false, closed: "read only", filter: "scan", sortable: true, behaviors: [], format: DATE_FORMAT },
		{ ...base, key: "published_at", label: "Published", type: "datetime", editable: false, bulk: false, closed: "read only", filter: "scan", sortable: true, behaviors: [], format: DATE_FORMAT },
		{ ...base, key: "scheduled_at", label: "Scheduled", type: "datetime", editable: false, bulk: false, closed: "use the status behaviors schedule/unschedule", filter: "scan", sortable: true, behaviors: [], format: DATE_FORMAT },
	];
}

function termsColumn(taxonomy: TaxonomyDef): Column {
	const one = taxonomy.single === true;
	return {
		key: termsKey(taxonomy.name),
		label: one ? (taxonomy.labelSingular ?? taxonomy.label) : taxonomy.label,
		kind: "terms",
		type: "terms",
		editable: true,
		bulk: true,
		filter: "terms",
		sortable: false,
		behaviors: one ? ["set_terms", "remove_terms"] : ["add_terms", "remove_terms", "set_terms"],
		required: false,
		unique: false,
		translatable: false,
		numeric: false,
		format: `${one ? "one term slug or id" : "term slugs or ids"} of taxonomy ${taxonomy.name}${taxonomy.hierarchical ? " (hierarchical: a parent term does not include its children in filters)" : ""}`,
		taxonomy,
	};
}

/** Normalise a collection schema into editor columns: system columns, then fields in schema order, then taxonomies. */
export function buildColumns(collection: CollectionDef): Column[] {
	return [
		...systemColumns(),
		...collection.fields.map((f) => fieldColumn(collection, f)),
		...(collection.taxonomies ?? []).filter((t) => t.collections.includes(collection.slug)).map(termsColumn),
	];
}

export function columnMap(collection: CollectionDef): Map<string, Column> {
	return new Map(buildColumns(collection).map((c) => [c.key, c]));
}
