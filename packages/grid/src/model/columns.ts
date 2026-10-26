import type { FieldDef, FieldType } from "@realmag777/lynx-engine";

import type { FieldInfo } from "./api.ts";

// Columns of the grid, built from list_fields (the Botoscope header[] model: key, title,
// width, sortable) plus what the grid needs to edit a cell: the editor kind and the field
// definition the engine uses to check a typed value before it is sent.

export type EditorKind = "text" | "textarea" | "number" | "switch" | "select" | "multiselect" | "datetime" | "terms" | "status" | "media" | "richtext" | "gallery" | "readonly";

export interface GridColumn {
	key: string;
	label: string;
	type: string;
	editor: EditorKind;
	width: number;
	sortable: boolean;
	align: "start" | "end" | "center";
	options?: string[];
	taxonomy?: string;
	unit?: string;
	/** Why the cell cannot be edited, shown as its tooltip. */
	closed?: string;
	required: boolean;
	/** The engine field definition used to coerce and validate typed values. */
	field?: FieldDef;
	info: FieldInfo;
	/** Why the header does not sort (the field has no index): shown as its tooltip. */
	sortHint?: string;
	/** Pinned to the left while scrolling sideways (set by the view). */
	pinned?: boolean;
	/** A photo gallery (repeater of one image sub-field): the key of that sub-field. Set by the page. */
	gallery?: string;
	/** Number format (currency, decimals) of number columns, set by the page from the saved formats. */
	format?: import("./format.ts").FieldFormat;
}

/**
 * A slider for numbers with a short range set by the field's rules (2026-10-01: doors 2-6,
 * seats 1-9, engine 0-10 L): whole numbers up to 30 apart, decimals (step 0.1) up to 20 apart.
 * Typing into the cell still opens the plain input.
 */
export function sliderRange(col: GridColumn): { min: number; max: number; step: number } | null {
	if (col.editor !== "number") return null;
	const { min, max } = col.info.rules ?? {};
	if (typeof min !== "number" || typeof max !== "number" || max <= min) return null;
	if (col.type === "integer") return max - min <= 30 ? { min, max, step: 1 } : null;
	return max - min <= 20 ? { min, max, step: 0.1 } : null;
}

/** EmDash's indexable field types (scalar query types with a column of their own). */
const INDEXABLE = new Set(["string", "url", "number", "integer", "boolean", "datetime", "select", "reference", "slug"]);

/** A field of the collection that can carry a database index (its header gets a gear menu). */
export function indexable(f: FieldInfo): boolean {
	return columnKind(f.key) === "field" && INDEXABLE.has(f.type) && f.editable !== false;
}

const EDITOR_BY_TYPE: Record<string, EditorKind> = {
	string: "text",
	url: "text",
	slug: "text",
	text: "textarea",
	// Rich text opens the admin's PortableTextEditor in a side panel (formatting kept).
	portableText: "richtext",
	number: "number",
	integer: "number",
	boolean: "switch",
	select: "select",
	multiSelect: "multiselect",
	datetime: "datetime",
	image: "media",
	file: "media",
	terms: "terms",
	status: "status",
};

const WIDTH_BY_EDITOR: Record<EditorKind, number> = { text: 200, textarea: 260, number: 120, switch: 96, select: 150, multiselect: 200, datetime: 180, terms: 200, status: 190, media: 96, richtext: 260, gallery: 200, readonly: 160 };

/**
 * Field types the grid can sort itself when EmDash cannot order by the field (no index): the
 * read route reads every matching entry first, so such a sort shows the first page only after
 * the whole scan (the grid shows its loading indicator meanwhile).
 */
export const SCAN_SORT_TYPES = new Set(["string", "text", "slug", "url", "number", "integer", "boolean", "select", "datetime"]);

/** System columns LYNX adds to every collection (list_fields does not mark them). */
export const SYSTEM_KEYS = new Set(["id", "slug", "status", "locale", "created_at", "updated_at", "published_at", "scheduled_at", "entry"]);

export function columnKind(key: string): "system" | "terms" | "field" {
	return SYSTEM_KEYS.has(key) ? "system" : key.startsWith("terms:") ? "terms" : "field";
}

/** Columns hidden until the user shows them (system details). */
export const HIDDEN_BY_DEFAULT = new Set(["id", "locale", "created_at", "published_at", "scheduled_at", "entry"]);

export function toFieldDef(f: FieldInfo): FieldDef | undefined {
	if (columnKind(f.key) !== "field") return undefined;
	return { slug: f.key, label: f.label, type: f.type as FieldType, required: f.required, unique: f.unique, validation: f.options || f.rules ? { ...f.rules, ...(f.options ? { options: f.options } : {}) } : null };
}

/** Width that shows a header label whole: text plus the sort arrow, move buttons and padding. */
export function labelWidth(label: string): number {
	return Math.min(320, Math.round(label.length * 7.5 + 66));
}

export function buildGridColumns(fields: FieldInfo[]): GridColumn[] {
	return fields
		.filter((f) => f.key !== "entry")
		.map((f) => {
			const editor: EditorKind = !f.editable ? "readonly" : f.key === "slug" ? "text" : (EDITOR_BY_TYPE[f.type] ?? "readonly");
			const numeric = f.type === "number" || f.type === "integer";
			const field = toFieldDef(f);
			return {
				key: f.key,
				label: f.label,
				type: f.type,
				editor,
				width: f.key === "title" ? 280 : Math.max(WIDTH_BY_EDITOR[editor], labelWidth(f.label) + (indexable(f) ? 34 : 0)),
				// Only indexed fields (and the system dates, title, slug, status) sort; any other sortable
				// type says how to get there (2026-10-02).
				sortable: f.sortable,
				...(!f.sortable && columnKind(f.key) === "field" && SCAN_SORT_TYPES.has(f.type) ? { sortHint: `${f.label}: index this field to sort and filter by it (the gear ⚙ on the column).` } : {}),
				align: numeric ? "end" : f.type === "boolean" ? "center" : "start",
				...(f.options ? { options: f.options } : {}),
				...(f.type === "terms" ? { taxonomy: f.key.slice("terms:".length) } : {}),
				...(f.unit ? { unit: f.unit } : {}),
				...(f.closed ? { closed: f.closed } : f.type === "repeater" ? { closed: "a list of fields: edit it in the entry editor (the ↗ icon at the start of the row)" } : {}),
				required: f.required,
				...(field ? { field } : {}),
				info: f,
			};
		});
}

/** Cells that open a side panel instead of an in-cell editor: rich text, galleries, image fields. */
export function opensPanel(c: Pick<GridColumn, "editor" | "type">): boolean {
	return c.editor === "richtext" || c.editor === "gallery" || (c.editor === "media" && c.type === "image");
}

/** The column shown first and pinned: the title field, else the first text field. */
export function titleColumn(cols: GridColumn[]): string | undefined {
	return cols.find((c) => c.key === "title")?.key ?? cols.find((c) => c.type === "string")?.key;
}

/** Default order: title first, then status, the collection's fields, terms, and system columns. */
export function defaultOrder(cols: GridColumn[]): string[] {
	const title = titleColumn(cols);
	const rank = (c: GridColumn) => (c.key === title ? 0 : c.key === "status" ? 1 : columnKind(c.key) === "field" ? 2 : c.type === "terms" ? 3 : 4);
	return [...cols].sort((a, b) => rank(a) - rank(b)).map((c) => c.key);
}
