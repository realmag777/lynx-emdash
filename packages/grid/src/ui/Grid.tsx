import { Popover } from "@cloudflare/kumo";
import { ArrowSquareOut, CaretDown, CaretLeft, CaretRight, CaretUp, GearSix, Lock } from "@phosphor-icons/react";
import * as React from "react";

import type { GridRow } from "../model/api.ts";
import { opensPanel, type GridColumn } from "../model/columns.ts";
import { cellValue, type Dirty } from "../model/edits.ts";
import { moveActive, startsTyping, type CellPos } from "../model/keyboard.ts";
import type { RowSelection } from "../model/selection.ts";
import type { ViewState } from "../model/view.ts";
import { CellEditor, CellView, type Commit, type Move, type TermIndex } from "./cells.tsx";
import { FloatingScrollbar, scrollParent } from "./FloatingScrollbar.tsx";

// The grid body: pinned columns, fixed-height rows, checkbox selection, click-to-edit cells and
// the keyboard model. The table is as tall as its page (at most 200 rows, all drawn; the author,
// 2026-10-05: no second vertical scrollbar): the page scrolls, the header row follows it down,
// and a floating scrollbar at the bottom of the window moves the table sideways.

export interface Editing {
	row: number;
	col: number;
	initial?: string;
}

export interface GridProps {
	collection: string;
	cols: GridColumn[];
	rows: GridRow[];
	dirty: Dirty;
	failed: Map<string, Map<string, string>>;
	saved: Set<string>;
	selection: RowSelection;
	active: CellPos | null;
	editing: Editing | null;
	density: ViewState["density"];
	sort: ViewState["sort"];
	terms: Map<string, TermIndex>;
	loading: boolean;
	onActive: (p: CellPos | null) => void;
	onEdit: (e: Editing | null) => void;
	onCommit: (row: GridRow, col: GridColumn, value: unknown) => string | null;
	onToggleRow: (id: string, shift: boolean) => void;
	onToggleAll: () => void;
	onSort: (key: string) => void;
	onMoveColumn: (key: string, delta: -1 | 1) => void;
	onResize: (key: string, width: number) => void;
	onCopy: () => void;
	onPaste: (text: string) => void;
	onClear: () => void;
	onSave: () => void;
	mediaImport?: (url: string) => Promise<unknown>;
	/** Rich text, gallery and image cells open a side panel instead of an in-cell editor. */
	onRichText: (row: GridRow, col: GridColumn) => void;
	/** Show the keyboard shortcuts (? or F1). */
	onHelp: () => void;
	/**
	 * The gear menu in a column header (field settings; the index for now). render() returns null
	 * for columns without settings; attention marks the gear a slow sort points at.
	 */
	fieldSettings?: { open: string | null; onOpen: (key: string | null) => void; render: (col: GridColumn) => React.ReactNode | null; attention?: string | null };
}

const CHECK_W = 72;

/** The visible band of a scroll parent, in window coordinates. */
function viewOf(parent: HTMLElement | Window): { top: number; bottom: number } {
	return parent === window ? { top: 0, bottom: window.innerHeight } : (parent as HTMLElement).getBoundingClientRect();
}

/** A live value in a tooltip: short plain text. */
function liveText(v: unknown): string {
	if (v === null || v === undefined || v === "") return "(empty)";
	if (typeof v === "object") return JSON.stringify(v).slice(0, 80);
	return String(v).slice(0, 80);
}

export function isEditable(col: GridColumn): boolean {
	return col.editor !== "readonly";
}

export function Grid(p: GridProps) {
	const { cols, rows, dirty, failed, saved, selection, active, editing, density, sort, terms } = p;
	const rowH = density === "compact" ? 34 : 44;
	const scroller = React.useRef<HTMLDivElement>(null);
	const head = React.useRef<HTMLDivElement>(null);
	const gridId = React.useId();

	// The header row follows the page down while the table is on screen (moved, not re-rendered).
	React.useEffect(() => {
		const el = scroller.current;
		const h = head.current;
		if (!el || !h) return;
		let frame = 0;
		const place = () => {
			frame = 0;
			const box = el.getBoundingClientRect();
			const shift = Math.max(0, Math.min(viewOf(scrollParent(el)).top - box.top, box.height - 2 * rowH));
			h.style.transform = shift ? `translateY(${shift}px)` : "";
			h.classList.toggle("is-stuck", shift > 0);
		};
		const later = () => {
			if (!frame) frame = requestAnimationFrame(place);
		};
		place();
		document.addEventListener("scroll", later, { capture: true, passive: true });
		window.addEventListener("resize", later);
		return () => {
			document.removeEventListener("scroll", later, { capture: true });
			window.removeEventListener("resize", later);
			if (frame) cancelAnimationFrame(frame);
		};
	}, [rowH, rows.length]);

	// More columns to the right than fit: a shade at the right edge says so.
	const [moreRight, setMoreRight] = React.useState(false);
	const edge = () => {
		const el = scroller.current;
		if (el) setMoreRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
	};
	React.useEffect(edge);

	const onScroll = edge;

	// Sticky offsets of pinned columns.
	const lefts: number[] = [];
	let acc = CHECK_W;
	const total = CHECK_W + cols.reduce((s, c) => s + c.width, 0);
	cols.forEach((c, i) => {
		lefts[i] = acc;
		acc += c.width;
	});

	// Keep the active cell in view: the page scrolls up and down (below the header row that follows it).
	React.useEffect(() => {
		const el = scroller.current;
		if (!el || !active) return;
		const row = el.querySelector<HTMLElement>(`[aria-rowindex="${active.row + 2}"]`);
		if (row) {
			const parent = scrollParent(el);
			const view = viewOf(parent);
			const r = row.getBoundingClientRect();
			const by = r.top < view.top + rowH ? r.top - view.top - rowH : r.bottom > view.bottom - 24 ? r.bottom - view.bottom + 24 : 0;
			if (by) parent.scrollBy({ top: by });
		}
		// Sideways: only this scroller moves.
		const col = cols[active.col];
		if (col && !col.pinned) {
			const pinnedW = CHECK_W + cols.filter((c) => c.pinned).reduce((s, c) => s + c.width, 0);
			const left = lefts[active.col]!;
			if (left - pinnedW < el.scrollLeft) el.scrollLeft = left - pinnedW;
			else if (left + col.width > el.scrollLeft + el.clientWidth) el.scrollLeft = left + col.width - el.clientWidth;
		}
		// Only when the active cell moves, not when rows or widths change.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [active, rowH]);

	const focusGrid = () => scroller.current?.focus({ preventScroll: true });

	const commitAt = (rowIdx: number, colIdx: number): Commit => (value, move) => {
		const row = rows[rowIdx];
		const col = cols[colIdx];
		if (!row || !col) return null;
		const problem = p.onCommit(row, col, value);
		if (problem) return problem;
		p.onEdit(null);
		if (move) {
			const key = move === "down" ? "ArrowDown" : move === "up" ? "ArrowUp" : "Tab";
			const next = moveActive({ row: rowIdx, col: colIdx }, key, { ctrl: false, shift: move === "left" }, rows.length, cols.length, 10);
			if (next) p.onActive(next);
		}
		window.setTimeout(focusGrid, 0);
		return null;
	};

	const startEdit = (row: number, col: number, initial?: string) => {
		const c = cols[col];
		const r = rows[row];
		if (!c || !r || !isEditable(c)) return;
		if (opensPanel(c)) {
			p.onRichText(r, c);
			return;
		}
		if (c.editor === "switch") {
			const cur = currentValue(r, c, dirty);
			p.onCommit(r, c, !(cur === true || cur === 1));
			return;
		}
		p.onEdit({ row, col, ...(initial !== undefined && (c.editor === "text" || c.editor === "number") ? { initial } : {}) });
	};

	const onKeyDown = (e: React.KeyboardEvent) => {
		if (editing) return;
		const mod = e.ctrlKey || e.metaKey;
		if (mod && e.key.toLowerCase() === "s") {
			e.preventDefault();
			p.onSave();
			return;
		}
		if (e.key === "?" || e.key === "F1") {
			e.preventDefault();
			p.onHelp();
			return;
		}
		if (!active) {
			if (["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key) && rows.length) {
				e.preventDefault();
				p.onActive({ row: 0, col: 0 });
			}
			return;
		}
		if (mod && e.key.toLowerCase() === "c") {
			e.preventDefault();
			p.onCopy();
			return;
		}
		if (mod && e.key.toLowerCase() === "a") {
			e.preventDefault();
			p.onToggleAll();
			return;
		}
		if (e.key === "Enter" && e.altKey) {
			e.preventDefault();
			const r = rows[active.row];
			if (r) window.location.assign(`/_emdash/admin/content/${encodeURIComponent(p.collection)}/${encodeURIComponent(r.id)}`);
			return;
		}
		if (e.key === "Enter" || e.key === "F2") {
			e.preventDefault();
			startEdit(active.row, active.col);
			return;
		}
		if (e.key === " ") {
			e.preventDefault();
			const c = cols[active.col];
			if (c?.editor === "switch") startEdit(active.row, active.col);
			else if (rows[active.row]) p.onToggleRow(rows[active.row]!.id, e.shiftKey);
			return;
		}
		if (e.key === "Delete" || e.key === "Backspace") {
			e.preventDefault();
			p.onClear();
			return;
		}
		if (e.key === "Escape") {
			p.onActive(null);
			return;
		}
		const next = moveActive(active, e.key, { ctrl: mod, shift: e.shiftKey }, rows.length, cols.length, Math.max(1, Math.floor(window.innerHeight / rowH) - 3));
		if (next) {
			e.preventDefault();
			p.onActive(next);
			return;
		}
		if (startsTyping(e)) {
			e.preventDefault();
			startEdit(active.row, active.col, e.key);
		}
	};

	const onPaste = (e: React.ClipboardEvent) => {
		if (editing || !active) return;
		const text = e.clipboardData.getData("text/plain");
		if (!text) return;
		e.preventDefault();
		p.onPaste(text);
	};

	/** An editor in the lower half of the window opens upwards. */
	const flipAt = (ri: number) => {
		const el = scroller.current;
		return el ? el.getBoundingClientRect().top + (ri + 1) * rowH > window.innerHeight / 2 : false;
	};

	const allLoaded = rows.length > 0 && rows.every((r) => selection.ids.has(r.id));
	const someLoaded = !allLoaded && rows.some((r) => selection.ids.has(r.id));
	const activeId = active ? `${gridId}-c-${active.row}-${active.col}` : undefined;

	return (
		<div className={`lynx-gridwrap ${moreRight ? "has-more" : ""}`}>
			<div
				ref={scroller}
				className={`lynx-grid lynx-grid--${density} ${p.loading ? "is-loading" : ""}`}
				role="grid"
				aria-rowcount={rows.length + 1}
				aria-colcount={cols.length + 1}
				aria-multiselectable="true"
				aria-activedescendant={activeId}
				aria-busy={p.loading}
				tabIndex={0}
				onScroll={onScroll}
				onKeyDown={onKeyDown}
				onPaste={onPaste}
				style={{ "--lynx-row-h": `${rowH}px` } as React.CSSProperties}
			>
				<div className="lynx-grid__inner" style={{ width: total }}>
					<div className="lynx-grid__head" ref={head} role="row" aria-rowindex={1}>
						<div className="lynx-grid__cell lynx-grid__cell--check is-pinned" role="columnheader" aria-colindex={1} style={{ width: CHECK_W, left: 0 }}>
							<input
								type="checkbox"
								className="lynx-checkbox"
								aria-label={allLoaded ? "Unselect all rows on this page" : "Select all rows on this page"}
								checked={allLoaded || selection.allMatching}
								ref={(el) => {
									if (el) el.indeterminate = someLoaded;
								}}
								onChange={p.onToggleAll}
							/>
						</div>
						{cols.map((c, i) => (
							<HeaderCell key={c.key} col={c} index={i} left={c.pinned ? lefts[i]! : undefined} sort={sort} first={i === 0} last={i === cols.length - 1} onSort={p.onSort} onMove={p.onMoveColumn} onResize={p.onResize} {...(p.fieldSettings ? { settings: p.fieldSettings } : {})} />
						))}
					</div>
					<div className="lynx-grid__body" style={{ height: rows.length * rowH }}>
						{rows.map((r, ri) => {
							const selected = selection.allMatching || selection.ids.has(r.id);
							const rowDirty = dirty.get(r.id);
							const rowFailed = failed.get(r.id);
							return (
								<div key={r.id} className={`lynx-grid__row ${ri % 2 ? "is-odd" : ""} ${selected ? "is-selected" : ""} ${saved.has(r.id) ? "is-saved" : ""}`} role="row" aria-rowindex={ri + 2} aria-selected={selected} style={{ top: ri * rowH, height: rowH }}>
									<div className="lynx-grid__cell lynx-grid__cell--check is-pinned" role="gridcell" style={{ width: CHECK_W, left: 0 }}>
										<input
											type="checkbox"
											className="lynx-checkbox"
											tabIndex={-1}
											aria-label={`Select row ${ri + 1}`}
											checked={selected}
											onClick={(e) => {
												e.stopPropagation();
												p.onToggleRow(r.id, e.shiftKey);
											}}
											onChange={() => {}}
										/>
										<a className="lynx-icon-btn lynx-open" href={`/_emdash/admin/content/${encodeURIComponent(p.collection)}/${encodeURIComponent(r.id)}`} target="_blank" rel="noopener" tabIndex={-1} title="Open in the entry editor (new tab)" aria-label="Open in the entry editor (new tab)">
											<ArrowSquareOut size={14} />
										</a>
									</div>
									{cols.map((c, ci) => {
										const isActive = active?.row === ri && active.col === ci;
										const isEditing = editing?.row === ri && editing.col === ci;
										const hasDirty = rowDirty?.has(c.key) ?? false;
										const problem = rowFailed?.get(c.key);
										const value = hasDirty ? rowDirty!.get(c.key) : cellValue(r, c.key);
										// Saved in the draft but not on the site yet: say what the site shows.
										const drafted = !hasDirty && r.live !== undefined && c.key in r.live;
										return (
											<div
												key={c.key}
												id={`${gridId}-c-${ri}-${ci}`}
												data-cell={`${ri}:${ci}`}
												role="gridcell"
												aria-colindex={ci + 2}
												aria-selected={isActive}
												aria-readonly={!isEditable(c)}
												title={problem ?? (drafted ? `Saved as a draft, not on the site yet. On the site now: ${liveText(r.live![c.key])}` : isEditable(c) ? undefined : c.closed ? `Read only: ${c.closed}` : "Read only")}
												className={`lynx-grid__cell lynx-align-${c.align} ${c.pinned ? "is-pinned" : ""} ${isActive ? "is-active" : ""} ${isEditing ? "is-editing" : ""} ${hasDirty ? "is-dirty" : ""} ${problem ? "is-failed" : ""} ${drafted ? "is-drafted" : ""} ${isEditable(c) ? "" : "is-readonly"} ${isEditing && flipAt(ri) ? "is-flip" : ""} ${ci >= cols.length - 2 ? "is-tail" : ""}`}
												style={{ width: c.width, ...(c.pinned ? { left: lefts[ci] } : {}) }}
												onMouseDown={(e) => {
													if (isEditing) return;
													if (e.detail > 1) e.preventDefault();
												}}
												onClick={() => {
													if (isEditing) return;
													if (c.editor === "switch" && isEditable(c)) {
														p.onActive({ row: ri, col: ci });
														startEdit(ri, ci);
														return;
													}
													if (isActive) startEdit(ri, ci);
													else p.onActive({ row: ri, col: ci });
													focusGrid();
												}}
												onDoubleClick={() => startEdit(ri, ci)}
											>
												{isEditing ? (
													<CellEditor
														col={c}
														value={value}
														{...(editing?.initial !== undefined ? { initial: editing.initial } : {})}
														{...(c.taxonomy && terms.get(c.taxonomy) ? { terms: terms.get(c.taxonomy)! } : {})}
														{...(p.mediaImport ? { mediaImport: p.mediaImport } : {})}
														entry={String(r.data.title ?? r.slug ?? "")}
														onCommit={commitAt(ri, ci)}
														onCancel={() => {
															p.onEdit(null);
															window.setTimeout(focusGrid, 0);
														}}
													/>
												) : (
													<>
														<CellView col={c} value={value} row={r} {...(c.taxonomy && terms.get(c.taxonomy) ? { terms: terms.get(c.taxonomy)! } : {})} />
														{!isEditable(c) && isActive ? <Lock size={12} className="lynx-lock" aria-hidden /> : null}
													</>
												)}
											</div>
										);
									})}
								</div>
							);
						})}
					</div>
				</div>
				{p.loading ? (
					<div className="lynx-grid__loader" aria-hidden>
						<span className="lynx-spinner" />
					</div>
				) : null}
			</div>
			<FloatingScrollbar target={scroller} />
		</div>
	);
}

export function currentValue(row: GridRow, col: GridColumn, dirty: Dirty): unknown {
	const d = dirty.get(row.id);
	return d?.has(col.key) ? d.get(col.key) : cellValue(row, col.key);
}

function HeaderCell(props: { col: GridColumn; index: number; left: number | undefined; sort: ViewState["sort"]; first: boolean; last: boolean; onSort: (k: string) => void; onMove: (k: string, d: -1 | 1) => void; onResize: (k: string, w: number) => void; settings?: NonNullable<GridProps["fieldSettings"]> }) {
	const { col, left, sort, first, last } = props;
	const menu = props.settings?.render(col) ?? null;
	const active = sort?.key === col.key;
	const ariaSort = active ? (sort!.dir === "asc" ? "ascending" : "descending") : col.sortable ? "none" : undefined;
	const startResize = (e: React.PointerEvent) => {
		e.preventDefault();
		e.stopPropagation();
		const startX = e.clientX;
		const startW = col.width;
		const target = e.currentTarget as HTMLElement;
		target.setPointerCapture(e.pointerId);
		const move = (ev: PointerEvent) => props.onResize(col.key, startW + ev.clientX - startX);
		const up = () => {
			target.removeEventListener("pointermove", move);
			target.removeEventListener("pointerup", up);
		};
		target.addEventListener("pointermove", move);
		target.addEventListener("pointerup", up);
	};
	return (
		<div className={`lynx-grid__cell lynx-grid__hcell lynx-align-${col.align} ${left !== undefined ? "is-pinned" : ""}`} role="columnheader" aria-colindex={props.index + 2} aria-sort={ariaSort} style={{ width: col.width, ...(left !== undefined ? { left } : {}) }}>
			{col.sortable ? (
				<button type="button" className={`lynx-hbtn ${active ? "is-sorted" : ""}`} onClick={() => props.onSort(col.key)} title={`${col.label} (click to sort)`}>
					<span className="lynx-hlabel">{col.label}</span>
					{active ? sort!.dir === "asc" ? <CaretUp size={12} weight="bold" /> : <CaretDown size={12} weight="bold" /> : null}
				</button>
			) : (
				<span className={`lynx-hlabel ${col.sortHint ? "is-nosort" : ""}`} title={col.sortHint ?? col.label}>
					{col.label}
				</span>
			)}
			{menu ? (
				<Popover open={props.settings!.open === col.key} onOpenChange={(o) => props.settings!.onOpen(o ? col.key : null)}>
					<Popover.Trigger render={<button type="button" className={`lynx-hgear ${props.settings!.attention === col.key ? "is-attention" : ""}`} aria-label={`${col.label} settings`} title={`${col.label} settings`} />}>
						<GearSix size={13} weight="bold" />
					</Popover.Trigger>
					<Popover.Content align="end" className="lynx-root lynx-pop lynx-fieldmenu">
						<Popover.Title className="lynx-pop__title">{col.label}</Popover.Title>
						{menu}
					</Popover.Content>
				</Popover>
			) : null}
			<span className="lynx-hmove">
				{!first ? (
					<button type="button" className="lynx-icon-btn lynx-icon-btn--xs" aria-label={`Move ${col.label} left`} onClick={() => props.onMove(col.key, -1)}>
						<CaretLeft size={10} weight="bold" />
					</button>
				) : null}
				{!last ? (
					<button type="button" className="lynx-icon-btn lynx-icon-btn--xs" aria-label={`Move ${col.label} right`} onClick={() => props.onMove(col.key, 1)}>
						<CaretRight size={10} weight="bold" />
					</button>
				) : null}
			</span>
			<span
				className="lynx-resize"
				role="separator"
				aria-orientation="vertical"
				aria-label={`Resize ${col.label}`}
				aria-valuenow={col.width}
				aria-valuemin={64}
				aria-valuemax={640}
				tabIndex={0}
				onKeyDown={(e) => {
					// Keyboard resizing: arrows by 16 px (Shift: 64 px), Home resets.
					const step = e.shiftKey ? 64 : 16;
					if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
						e.preventDefault();
						props.onResize(col.key, col.width + (e.key === "ArrowLeft" ? -step : step));
					} else if (e.key === "Home") {
						e.preventDefault();
						props.onResize(col.key, col.key === "title" ? 280 : 180);
					}
				}}
				onPointerDown={startResize}
				onDoubleClick={() => props.onResize(col.key, col.key === "title" ? 280 : 180)}
			/>
		</div>
	);
}
