import type { GridRow } from "./api.ts";
import type { GridColumn } from "./columns.ts";
import { cellValue, checkValue } from "./edits.ts";

// Copy and paste of cell ranges, spreadsheet style: tab-separated values, one line per row,
// quoted cells may hold tabs, newlines and doubled quotes (what Excel, Numbers and Google
// Sheets put on the clipboard).

export function parseTsv(text: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let cell = "";
	let quoted = false;
	const s = text.replace(/\r\n?/g, "\n").replace(/\n$/, "");
	for (let i = 0; i < s.length; i++) {
		const c = s[i]!;
		if (quoted) {
			if (c === '"' && s[i + 1] === '"') {
				cell += '"';
				i++;
			} else if (c === '"') quoted = false;
			else cell += c;
		} else if (c === '"' && cell === "") quoted = true;
		else if (c === "\t") {
			row.push(cell);
			cell = "";
		} else if (c === "\n") {
			row.push(cell);
			rows.push(row);
			row = [];
			cell = "";
		} else cell += c;
	}
	row.push(cell);
	rows.push(row);
	return rows;
}

function tsvCell(v: string): string {
	return /[\t\n"]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function toTsv(grid: string[][]): string {
	return grid.map((r) => r.map(tsvCell).join("\t")).join("\n");
}

/** Plain text of a cell for copying (terms as slugs are not known here, so ids; booleans as true/false). */
export function copyText(row: GridRow, col: GridColumn, termLabel?: (id: string) => string): string {
	const v = cellValue(row, col.key);
	if (v === null || v === undefined) return "";
	if (Array.isArray(v)) return v.map((x) => (col.editor === "terms" && termLabel ? termLabel(String(x)) : String(x))).join(", ");
	if (typeof v === "object") return (v as { filename?: string; id?: string }).filename ?? (v as { id?: string }).id ?? "";
	if (col.type === "boolean") return v === true || v === 1 ? "true" : "false";
	return String(v);
}

export interface PasteResult {
	edits: Array<{ rowId: string; key: string; value: unknown }>;
	problems: Array<{ rowId: string; key: string; problem: string }>;
	skipped: number;
}

/**
 * Map pasted text onto the grid from the active cell: row by row, column by column. Values go
 * through the same coercion and field rules as the engine; read-only cells and cells with
 * problems are skipped and reported.
 */
export function planPaste(text: string, rows: GridRow[], cols: GridColumn[], start: { row: number; col: number }, resolveTerms?: (col: GridColumn, labels: string[]) => string[] | null): PasteResult {
	const grid = parseTsv(text);
	const out: PasteResult = { edits: [], problems: [], skipped: 0 };
	grid.forEach((line, r) => {
		const row = rows[start.row + r];
		if (!row) {
			out.skipped += line.length;
			return;
		}
		line.forEach((raw, c) => {
			const col = cols[start.col + c];
			if (!col || col.editor === "readonly" || col.editor === "media" || col.editor === "richtext" || col.key === "slug") {
				out.skipped++;
				return;
			}
			if (col.editor === "terms") {
				const labels = raw.split(",").map((x) => x.trim()).filter(Boolean);
				const ids = resolveTerms?.(col, labels) ?? null;
				if (!ids) out.problems.push({ rowId: row.id, key: col.key, problem: `Unknown term in "${raw}"` });
				else out.edits.push({ rowId: row.id, key: col.key, value: ids });
				return;
			}
			if (col.editor === "status") {
				const v = raw.trim().toLowerCase();
				if (v !== "published" && v !== "draft") out.problems.push({ rowId: row.id, key: col.key, problem: "Status takes published or draft" });
				else out.edits.push({ rowId: row.id, key: col.key, value: v });
				return;
			}
			const checked = checkValue(col, col.editor === "multiselect" ? raw.split(",").map((x) => x.trim()).filter(Boolean) : raw);
			if (checked.ok) out.edits.push({ rowId: row.id, key: col.key, value: checked.value });
			else out.problems.push({ rowId: row.id, key: col.key, problem: checked.problem });
		});
	});
	return out;
}
