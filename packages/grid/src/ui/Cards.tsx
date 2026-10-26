import { Checkbox } from "@cloudflare/kumo";
import { ArrowSquareOut } from "@phosphor-icons/react";

import type { GridRow } from "../model/api.ts";
import { opensPanel, type GridColumn } from "../model/columns.ts";
import type { Dirty } from "../model/edits.ts";
import type { RowSelection } from "../model/selection.ts";
import { CellEditor, CellView, type TermIndex } from "./cells.tsx";
import { currentValue, isEditable, type Editing } from "./Grid.tsx";

// Phones (≤ 768 px): each row becomes a card, like Botoscope's mobile layout. Tapping a value
// opens the same in-cell editor as the grid.

export function Cards(props: {
	collection: string;
	cols: GridColumn[];
	rows: GridRow[];
	dirty: Dirty;
	failed: Map<string, Map<string, string>>;
	selection: RowSelection;
	editing: Editing | null;
	terms: Map<string, TermIndex>;
	titleKey: string | undefined;
	onEdit: (e: Editing | null) => void;
	onCommit: (row: GridRow, col: GridColumn, value: unknown) => string | null;
	onToggleRow: (id: string, shift: boolean) => void;
	mediaImport?: (url: string) => Promise<unknown>;
	/** Rich text, galleries and image fields open a side panel. */
	onRichText: (row: GridRow, col: GridColumn) => void;
}) {
	const { cols, rows, dirty, failed, selection, editing, terms } = props;
	return (
		<ul className="lynx-cardlist">
			{rows.map((r, ri) => {
				const selected = selection.allMatching || selection.ids.has(r.id);
				const title = props.titleKey ? currentValue(r, cols.find((c) => c.key === props.titleKey) ?? cols[0]!, dirty) : r.slug;
				return (
					<li key={r.id} className={`lynx-rowcard ${selected ? "is-selected" : ""}`}>
						<div className="lynx-rowcard__head">
							<Checkbox aria-label="Select entry" checked={selected} onCheckedChange={() => props.onToggleRow(r.id, false)} />
							<span className="lynx-strong lynx-rowcard__title">{String(title ?? r.slug ?? r.id)}</span>
							<a className="lynx-icon-btn" href={`/_emdash/admin/content/${encodeURIComponent(props.collection)}/${encodeURIComponent(r.id)}`} aria-label="Open in the entry editor">
								<ArrowSquareOut size={16} />
							</a>
						</div>
						<dl className="lynx-rowcard__fields">
							{cols.map((c, ci) => {
								if (c.key === props.titleKey) return null;
								const isEditing = editing?.row === ri && editing.col === ci;
								const d = dirty.get(r.id)?.has(c.key);
								const problem = failed.get(r.id)?.get(c.key);
								const value = currentValue(r, c, dirty);
								return (
									<div key={c.key} className={`lynx-rowcard__field ${d ? "is-dirty" : ""} ${problem ? "is-failed" : ""}`}>
										<dt>{c.label}</dt>
										<dd>
											{isEditing ? (
												<CellEditor
													col={c}
													value={value}
													{...(c.taxonomy && terms.get(c.taxonomy) ? { terms: terms.get(c.taxonomy)! } : {})}
													{...(props.mediaImport ? { mediaImport: props.mediaImport } : {})}
													entry={String(title ?? "")}
													onCommit={(v) => {
														const p = props.onCommit(r, c, v);
														if (!p) props.onEdit(null);
														return p;
													}}
													onCancel={() => props.onEdit(null)}
												/>
											) : (
												<button
													type="button"
													className="lynx-cardvalue"
													disabled={!isEditable(c)}
													title={problem}
													onClick={() => {
														if (c.editor === "switch") props.onCommit(r, c, !(value === true || value === 1));
														else if (opensPanel(c)) props.onRichText(r, c);
														else props.onEdit({ row: ri, col: ci });
													}}
												>
													<CellView col={c} value={value} row={r} {...(c.taxonomy && terms.get(c.taxonomy) ? { terms: terms.get(c.taxonomy)! } : {})} />
												</button>
											)}
										</dd>
									</div>
								);
							})}
						</dl>
					</li>
				);
			})}
		</ul>
	);
}
