import type { Operation } from "./operations.ts";
import type { Behavior } from "./schema.ts";

// One dictionary for what behaviours are called: the bulk-edit panel lists them with
// BEHAVIOR_LABEL, and job summaries (history, the core's admin page, list_history for agents)
// describe operations with describeOperations: "Price −10%, rounded; Fuel: + Diesel".

export const BEHAVIOR_LABEL: Record<Behavior, string> = {
	set: "Set to",
	clear: "Clear",
	append: "Append text",
	prepend: "Prepend text",
	replace: "Find and replace",
	change_case: "Change case",
	trim: "Trim spaces",
	slugify: "Make slug",
	increase_by: "Increase by",
	decrease_by: "Decrease by",
	increase_percent: "Increase by %",
	decrease_percent: "Decrease by %",
	multiply: "Multiply by",
	round: "Round",
	copy_from: "Copy from field",
	toggle: "Toggle yes/no",
	add_values: "Add options",
	remove_values: "Remove options",
	replace_value: "Replace option",
	shift_date: "Shift date",
	add_terms: "Add terms",
	remove_terms: "Remove terms",
	set_terms: "Replace all terms with",
	publish: "Publish",
	unpublish: "Unpublish (to draft)",
	schedule: "Schedule publication",
	unschedule: "Cancel schedule",
	duplicate: "Duplicate (draft copies)",
	trash: "Move to trash",
};

export interface DescribeColumn {
	key: string;
	label: string;
}

export interface DescribeOptions {
	/** Label of a term id (term ops carry ids once normalised). */
	termLabel?: (id: string) => string;
	/** Label of another field (copy_from, slugify sources). */
	fieldLabel?: (key: string) => string;
	/** Number formatting of a field (currency, units); default: grouped digits. */
	number?: (key: string, value: number) => string;
}

const CASE_TEXT: Record<string, string> = { upper: "to UPPER CASE", lower: "to lower case", title: "to Title Case", sentence: "to Sentence case" };
/** Behaviours that describe the whole entry: no field name in front. */
const WHOLE_ENTRY = new Set<Behavior>(["publish", "unpublish", "schedule", "unschedule", "duplicate", "trash"]);

function quote(v: unknown): string {
	return `“${String(v ?? "")}”`;
}

function list(v: unknown, label: (x: string) => string = String): string {
	return (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]).map((x) => label(String(x))).join(", ");
}

function signed(n: unknown, fmt: (v: number) => string, suffix = ""): string {
	const v = Number(n);
	return `${v < 0 ? "−" : "+"}${fmt(Math.abs(v))}${suffix}`;
}

/** The phrase of one operation, without the field name: "−10%", "rounded", "+ Diesel". */
export function describeOperation(op: Operation & { termIds?: string[] }, column: DescribeColumn, o: DescribeOptions = {}): string {
	const num = (v: number) => (o.number ? o.number(column.key, v) : v.toLocaleString("en-US", { maximumFractionDigits: 6 }));
	const plain = (v: number) => v.toLocaleString("en-US", { maximumFractionDigits: 6 });
	const terms = () => list(op.termIds ?? op.value, (x) => o.termLabel?.(x) ?? x);
	switch (op.behavior) {
		case "set":
			return typeof op.value === "number" ? `set to ${num(op.value)}` : Array.isArray(op.value) ? `set to ${list(op.value)}` : typeof op.value === "boolean" ? (op.value ? "set to yes" : "set to no") : `set to ${quote(op.value)}`;
		case "clear":
			return "cleared";
		case "append":
			return `appended ${quote(op.value)}`;
		case "prepend":
			return `prepended ${quote(op.value)}`;
		case "replace":
			return `${quote(op.find)} → ${quote(op.replace ?? "")}`;
		case "change_case":
			return CASE_TEXT[String(op.case)] ?? "case changed";
		case "trim":
			return "spaces trimmed";
		case "slugify":
			return op.source ? `slug from ${o.fieldLabel?.(op.source) ?? op.source}` : "slugified";
		case "increase_by":
			return signed(op.value, num);
		case "decrease_by":
			return signed(-Number(op.value), num);
		case "increase_percent":
			return signed(op.value, plain, "%");
		case "decrease_percent":
			return signed(-Number(op.value), plain, "%");
		case "multiply":
			return `×${plain(Number(op.value))}`;
		case "round": {
			const parts = ["rounded"];
			if (op.direction === "up" || op.direction === "down") parts.push(op.direction);
			if (op.step !== undefined && Number(op.step) !== 1) parts.push(`to ${num(Number(op.step))}`);
			if (op.ending !== undefined) parts.push(`ending ${plain(Number(op.ending))}`);
			return parts.join(" ");
		}
		case "copy_from":
			return `copied from ${o.fieldLabel?.(String(op.source)) ?? op.source}${op.percent ? ` ${signed(op.percent, plain, "%")}` : ""}`;
		case "toggle":
			return "switched";
		case "add_values":
			return `+ ${list(op.value)}`;
		case "remove_values":
			return `− ${list(op.value)}`;
		case "replace_value":
			return `${quote(op.from)} → ${quote(op.value)}`;
		case "shift_date":
			return `${signed(op.value, plain)} ${op.unit ?? "days"}`;
		case "add_terms":
			return `+ ${terms()}`;
		case "remove_terms":
			return `− ${terms()}`;
		case "set_terms": {
			const t = terms();
			return t ? `= ${t}` : "all terms removed";
		}
		case "publish":
			return "Published";
		case "unpublish":
			return "Set to draft";
		case "schedule":
			return `Scheduled for ${String(op.value ?? "").slice(0, 16).replace("T", " ")}`;
		case "unschedule":
			return "Schedule cancelled";
		case "duplicate":
			return "Duplicated";
		case "trash":
			return "Moved to trash";
	}
	return String(op.behavior);
}

/** "Price −10%, rounded; Fuel: + Diesel; Published" — consecutive operations on a field share its name. */
export function describeOperations(ops: Array<{ op: Operation & { termIds?: string[] }; column: DescribeColumn }>, o: DescribeOptions = {}): string {
	const groups: Array<{ key: string; label: string | null; phrases: string[] }> = [];
	for (const { op, column } of ops) {
		const phrase = describeOperation(op, column, o);
		const label = WHOLE_ENTRY.has(op.behavior) ? null : column.label;
		const last = groups.at(-1);
		if (last && label !== null && last.key === column.key) last.phrases.push(phrase);
		else groups.push({ key: column.key, label, phrases: [phrase] });
	}
	return groups.map((g) => (g.label === null ? g.phrases.join(", ") : `${g.label}${column_sep(g.phrases[0]!)}${g.phrases.join(", ")}`)).join("; ");
}

/** "Price −10%", "Price rounded", but "Fuel: + Diesel" and "Title: “a” → “b”" (lists and quotes get a colon). */
function column_sep(first: string): string {
	return /^[−+×=] /.test(first) || first.startsWith("“") ? ": " : " ";
}

/** "1 entry", "5,000 entries". */
export function entriesText(n: number): string {
	return `${n.toLocaleString("en-US")} ${n === 1 ? "entry" : "entries"}`;
}

const human = (key: string) => {
	const t = key.replace(/^terms:/, "").replace(/_/g, " ");
	return t.charAt(0).toUpperCase() + t.slice(1);
};

/**
 * Job summaries written before the dictionary ("rollback of job_x (… → price increase_percent)")
 * read like the new ones: no job ids, no behaviour names. New summaries pass through unchanged.
 */
export function readableSummary(summary: string): string {
	const undo = /^rollback of \S+ \((.*)\)$/s.exec(summary);
	if (undo) return `Undo: ${readableSummary(undo[1]!)}`;
	const created = /^create (\d+) entr(?:y|ies) in \S+$/.exec(summary);
	if (created) return `Created ${entriesText(Number(created[1]))}`;
	const edit = /^edit of (\d+) entr(?:y|ies): (.*)$/.exec(summary);
	if (edit) return `Edited ${edit[2]!.split(", ").map(human).join(", ")} · ${entriesText(Number(edit[1]))}`;
	const bulk = /^(.*) → (.*)$/.exec(summary);
	if (bulk && /^[a-z0-9_:]+ [a-z_]+(, [a-z0-9_:]+ [a-z_]+)*$/.test(bulk[2]!)) {
		const ops = bulk[2]!.split(", ").map((x) => {
			const [key, behavior] = x.split(" ") as [string, string];
			const label = BEHAVIOR_LABEL[behavior as Behavior] ?? behavior;
			return WHOLE_ENTRY.has(behavior as Behavior) ? label : `${human(key)}: ${label}`;
		});
		const where = bulk[1]!.trim();
		return `${ops.join("; ")}${where && where !== "everything" ? ` (${where})` : ""}`;
	}
	return summary;
}
