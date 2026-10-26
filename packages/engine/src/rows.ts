import { resolveTerms, withAncestors } from "./operations.ts";
import type { Warning } from "./planner.ts";
import { buildColumns, taxonomyOfKey, type Column } from "./schema.ts";
import type { CollectionDef, FieldDef, FieldType, TermDef } from "./types.ts";
import { validateValue, type ValidationProblem } from "./validate.ts";
import { coerceValue, isEmptyValue } from "./values.ts";

// New entries in one strict shape (create_entries). The keys and value types are exactly
// the ones list_fields reports; converting a file or a table into this shape is the agent's
// job. Nothing is guessed: every problem is reported with a code, a readable text and, where
// possible, the closest valid value.

export const MAX_NEW_ROWS = 50;

export type RowProblemCode = "missing_required" | "unknown_field" | "wrong_type" | "not_in_options" | "unknown_term" | "duplicate_unique" | "out_of_range" | "bad_format";

export interface RowProblem {
	code: RowProblemCode;
	field: string;
	message: string;
	/** The closest valid option, field key or term, when one is close enough. */
	hint?: string;
}

export interface NewRowPlan {
	index: number;
	state: "ok" | "invalid";
	title: string;
	/** Coerced field values to create the entry with. */
	data: Record<string, unknown>;
	/** Term ids per taxonomy (parents included on hierarchical taxonomies). */
	terms: Record<string, string[]>;
	publish: boolean;
	problems: RowProblem[];
}

export interface NewRowsPlan {
	collection: string;
	rows: NewRowPlan[];
	counts: { total: number; ok: number; invalid: number };
	/** Values of unique fields the caller checks against the entries already in the collection. */
	uniqueChecks: Array<{ field: string; values: string[] }>;
	warnings: Warning[];
}

const RULE_CODE: Record<ValidationProblem["rule"], RowProblemCode> = {
	required: "missing_required",
	minLength: "out_of_range",
	maxLength: "out_of_range",
	min: "out_of_range",
	max: "out_of_range",
	minItems: "out_of_range",
	maxItems: "out_of_range",
	pattern: "bad_format",
	options: "not_in_options",
	unique: "duplicate_unique",
};

/** Keys EmDash sets itself; a row may not carry them. */
const HOST_KEYS: Record<string, string> = {
	id: "the id is made by EmDash",
	slug: "EmDash makes the slug from the title; rename the entry afterwards with update_entry if needed",
	locale: "entries are created in the site's default language",
	created_at: "set by EmDash",
	updated_at: "set by EmDash",
	published_at: "set by EmDash when the entry is published",
	scheduled_at: "use the status behaviors after creating",
};

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "");

function distance(a: string, b: string): number {
	if (a === b) return 0;
	const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		let diag = prev[0]!;
		prev[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const tmp = prev[j]!;
			prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
			diag = tmp;
		}
	}
	return prev[b.length]!;
}

/** The candidate closest to `value`, if it is close enough to be a plausible typo or spelling. */
export function closest(value: string, candidates: string[]): string | undefined {
	const v = norm(value);
	if (!v) return undefined;
	let best: { c: string; d: number } | undefined;
	for (const c of candidates) {
		const n = norm(c);
		if (!n) continue;
		const d = n === v ? 0 : n.startsWith(v) || v.startsWith(n) || n.includes(v) || v.includes(n) ? 1 : distance(v, n);
		if (!best || d < best.d) best = { c, d };
	}
	return best && best.d <= Math.max(2, Math.floor(v.length / 3)) ? best.c : undefined;
}

const looksLikeUrl = (s: string) => /^https?:\/\//i.test(s.trim());

function mediaHint(field: string): RowProblem {
	return {
		code: "wrong_type",
		field,
		message: `${field} takes a media library value, not a web address`,
		hint: "Import the image first with lynx-media__import_media (the LYNX Media plugin) and put the value it returns here.",
	};
}

/** Check one value against its field and return the coerced value, or problems. */
function checkValue(field: FieldDef, key: string, raw: unknown, out: RowProblem[]): { ok: true; value: unknown } | { ok: false } {
	const options = field.validation?.options ?? [];
	if ((field.type === "image" || field.type === "file") && typeof raw === "string" && looksLikeUrl(raw)) {
		out.push(mediaHint(key));
		return { ok: false };
	}
	const c = coerceValue(field, raw);
	if (!c.ok) {
		if ((field.type === "select" || field.type === "multiSelect") && options.length) {
			const given = Array.isArray(raw) ? raw.map(String) : typeof raw === "string" ? (field.type === "multiSelect" ? raw.split(",").map((s) => s.trim()) : [raw]) : [String(raw)];
			const bad = given.filter((g) => !options.some((o) => o.toLowerCase() === g.trim().toLowerCase()));
			for (const b of bad.length ? bad : given) {
				const hint = closest(b, options);
				out.push({ code: "not_in_options", field: key, message: `${field.label} takes one of: ${options.join(", ")}; "${b}" is not one of them`, ...(hint ? { hint } : {}) });
			}
		} else {
			out.push({ code: "wrong_type", field: key, message: c.reason });
		}
		return { ok: false };
	}
	for (const p of validateValue(field, c.value)) {
		const code = RULE_CODE[p.rule];
		const hint = code === "not_in_options" && typeof c.value === "string" ? closest(c.value, options) : undefined;
		out.push({ code, field: key, message: p.message, ...(hint ? { hint } : {}) });
	}
	if (field.type === "repeater" && Array.isArray(c.value)) checkRepeater(field, key, c.value as Array<Record<string, unknown>>, out);
	return { ok: true, value: c.value };
}

/** Repeater rows: known sub-fields only, required ones present, each value of its sub-field's type. */
function checkRepeater(field: FieldDef, key: string, items: Array<Record<string, unknown>>, out: RowProblem[]): void {
	const subs = field.validation?.subFields ?? [];
	if (!subs.length) return;
	items.forEach((item, i) => {
		for (const k of Object.keys(item)) {
			if (!subs.some((s) => s.slug === k)) {
				const hint = closest(k, subs.map((s) => s.slug));
				out.push({ code: "unknown_field", field: `${key}[${i}].${k}`, message: `${field.label} rows have no "${k}"; they take ${subs.map((s) => s.slug).join(", ")}`, ...(hint ? { hint } : {}) });
			}
		}
		for (const s of subs) {
			const sub: FieldDef = { slug: s.slug, label: s.label ?? s.slug, type: s.type as FieldType, required: s.required, validation: s.options ? { options: s.options } : null };
			const v = item[s.slug];
			if (v === undefined || isEmptyValue(v)) {
				if (s.required) out.push({ code: "missing_required", field: `${key}[${i}].${s.slug}`, message: `Every ${field.label} row needs ${sub.label}` });
				continue;
			}
			checkValue(sub, `${key}[${i}].${s.slug}`, v, out);
		}
	});
}

/**
 * Validate new rows against a collection. Deterministic and free of host calls: the caller
 * then checks `uniqueChecks` against the collection and applies the result with
 * applyNewRowUniqueConflicts. A row is ok only when it has no problem at all.
 */
export function planNewRows(collection: CollectionDef, rows: unknown[], opts: { terms?: Record<string, TermDef[]> } = {}): NewRowsPlan {
	const columns = buildColumns(collection);
	const byKey = new Map<string, Column>(columns.map((c) => [c.key, c]));
	const keys = columns.filter((c) => c.kind !== "system" || c.key === "status").map((c) => c.key);
	const titleKey = collection.titleField ?? (collection.fields.some((f) => f.slug === "title") ? "title" : null);

	const plans: NewRowPlan[] = rows.map((raw, index) => {
		const problems: RowProblem[] = [];
		const data: Record<string, unknown> = {};
		const terms: Record<string, string[]> = {};
		let publish = false;
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
			problems.push({ code: "wrong_type", field: "(row)", message: 'Each row is an object of field keys and values, e.g. {"title":"BMW 320d","price":18900,"terms:fuel":["diesel"]}' });
			return { index, state: "invalid", title: `row ${index + 1}`, data, terms, publish, problems };
		}
		const row = raw as Record<string, unknown>;
		for (const [key, value] of Object.entries(row)) {
			if (key in HOST_KEYS) {
				problems.push({ code: "unknown_field", field: key, message: `${key} cannot be given: ${HOST_KEYS[key]}` });
				continue;
			}
			const col = byKey.get(key);
			if (!col || (col.kind === "system" && key !== "status")) {
				const hint = closest(key, keys);
				problems.push({ code: "unknown_field", field: key, message: `${collection.label} has no field "${key}". Use the keys list_fields gives.`, ...(hint ? { hint } : {}) });
				continue;
			}
			if (!col.editable) {
				problems.push({ code: "unknown_field", field: key, message: `${col.label} cannot be set through LYNX${col.closed ? ` (${col.closed})` : ""}` });
				continue;
			}
			if (key === "status") {
				const s = typeof value === "string" ? value.trim().toLowerCase() : "";
				if (s === "published") publish = true;
				else if (s !== "draft" && s !== "") {
					const hint = closest(String(value), ["draft", "published"]);
					problems.push({ code: "not_in_options", field: "status", message: 'status takes "draft" (the default) or "published"', ...(hint ? { hint } : {}) });
				}
				continue;
			}
			const tax = taxonomyOfKey(key);
			if (tax) {
				const all = opts.terms?.[tax] ?? [];
				const { ids, unknown } = resolveTerms(tax, value, all);
				if (value !== null && value !== undefined && !Array.isArray(value) && typeof value !== "string") {
					problems.push({ code: "wrong_type", field: key, message: `${key} takes a list of term slugs, e.g. ["diesel"]` });
					continue;
				}
				for (const u of unknown) {
					const hint = closest(u, all.flatMap((t) => [t.slug, t.label]));
					const match = hint ? all.find((t) => t.slug === hint || t.label === hint) : undefined;
					problems.push({ code: "unknown_term", field: key, message: `${col.label} has no term "${u}". Terms are never created by an edit: use list_terms, or ask the user.`, ...(match ? { hint: match.slug } : {}) });
				}
				const withParents = col.taxonomy?.hierarchical ? withAncestors(ids, all) : ids;
				if (withParents.length) terms[tax] = withParents;
				continue;
			}
			const field = col.field!;
			if (value === null || value === undefined || isEmptyValue(value)) continue;
			const c = checkValue(field, key, value, problems);
			if (c.ok) data[key] = c.value;
		}
		for (const f of collection.fields) {
			if (!f.required || f.type === "boolean" || f.default !== undefined) continue;
			if (data[f.slug] === undefined && !problems.some((p) => p.field === f.slug)) {
				problems.push({ code: "missing_required", field: f.slug, message: `${f.label} is required and the row has no value for it` });
			}
		}
		const t = titleKey ? data[titleKey] : undefined;
		return { index, state: problems.length ? "invalid" : "ok", title: typeof t === "string" && t ? t : `row ${index + 1}`, data, terms, publish, problems };
	});

	// Unique fields: repeated values inside the batch, and the values to check against the collection.
	const uniqueChecks: NewRowsPlan["uniqueChecks"] = [];
	for (const f of collection.fields.filter((x) => x.unique)) {
		const seen = new Map<string, NewRowPlan[]>();
		for (const p of plans) {
			const v = p.data[f.slug];
			if (v === undefined || v === null || v === "") continue;
			seen.set(String(v), [...(seen.get(String(v)) ?? []), p]);
		}
		for (const [value, list] of seen) {
			if (list.length < 2) continue;
			for (const p of list) {
				p.problems.push({ code: "duplicate_unique", field: f.slug, message: `${f.label} "${value}" is given to ${list.length} rows (${list.map((x) => x.index + 1).join(", ")}); it must be unique` });
				p.state = "invalid";
			}
		}
		// Invalid rows are checked too, so one dry run reports every problem of a row.
		const values = [...seen.entries()].filter(([, list]) => list.length === 1).map(([v]) => v);
		if (values.length) uniqueChecks.push({ field: f.slug, values });
	}

	const plan: NewRowsPlan = { collection: collection.slug, rows: plans, counts: { total: plans.length, ok: 0, invalid: 0 }, uniqueChecks, warnings: [] };
	refreshRows(plan);
	return plan;
}

/** Mark rows whose unique values already belong to entries of the collection. `taken`: value → entry ids. */
export function applyNewRowUniqueConflicts(plan: NewRowsPlan, field: string, taken: Map<string, string[]>): NewRowsPlan {
	for (const p of plan.rows) {
		const v = p.data[field];
		if (v === undefined || v === null) continue;
		const holders = taken.get(String(v)) ?? [];
		if (holders.length) {
			p.problems.push({ code: "duplicate_unique", field, message: `${field} "${String(v)}" is already used by entr${holders.length === 1 ? "y" : "ies"} ${holders.join(", ")}; it must be unique` });
			p.state = "invalid";
		}
	}
	refreshRows(plan);
	return plan;
}

function refreshRows(plan: NewRowsPlan): void {
	plan.counts = { total: plan.rows.length, ok: plan.rows.filter((r) => r.state === "ok").length, invalid: plan.rows.filter((r) => r.state === "invalid").length };
	const w: Warning[] = [];
	const live = plan.rows.filter((r) => r.state === "ok" && r.publish).length;
	if (live) w.push({ code: "published_on_create", count: live, text: `${live} new entr${live === 1 ? "y is" : "ies are"} published at once (status "published"); the others are created as drafts.` });
	if (plan.counts.invalid) w.push({ code: "invalid_rows", count: plan.counts.invalid, text: `${plan.counts.invalid} row${plan.counts.invalid === 1 ? " has" : "s have"} problems and will not be created. Show them to the user, fix the rows and call again.` });
	plan.warnings = w;
}
