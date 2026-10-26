import { displayValue, toPlainText } from "@realmag777/lynx-engine";
import { Badge } from "@cloudflare/kumo";
import { Check, Image as ImageIcon, MagnifyingGlass, X } from "@phosphor-icons/react";
import * as React from "react";
import { createPortal } from "react-dom";

import type { GridRow, Term } from "../model/api.ts";
import { sliderRange, type GridColumn } from "../model/columns.ts";
import { formatNumber, unitLabel } from "../model/format.ts";
import Calendar23, { type Calendar23Selected } from "../vendor/calendar23.js";

// Cell renderers and in-cell editors, the Botoscope editor catalogue in React: text and number
// inputs (Enter commits, Esc cancels, blur commits), textarea with ✓/✗ (Ctrl+Enter commits),
// select, switch, date, multi-select and taxonomy pickers (SelectM23 look), media.

export type Move = "down" | "up" | "right" | "left" | null;
export type Commit = (value: unknown, move?: Move) => string | null;

export interface TermIndex {
	byId: Map<string, Term>;
	list: Term[];
}

export function mediaUrl(v: unknown): string | null {
	if (!v || typeof v !== "object") return null;
	const m = v as { provider?: string; url?: string; meta?: { storageKey?: string }; storageKey?: string };
	const key = m.meta?.storageKey ?? m.storageKey;
	if (key) return `/_emdash/api/media/file/${encodeURIComponent(key)}`;
	return typeof m.url === "string" ? m.url : null;
}

function formatDate(v: unknown): string {
	if (typeof v !== "string" || !v) return "";
	const d = new Date(v);
	if (Number.isNaN(d.getTime())) return v;
	return d.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/**
 * Terms as the reader thinks of them: a child with its parents ("Mercedes-Benz › A-Class"),
 * and a parent shown on its own only when none of its children is assigned too.
 */
export function termChains(ids: string[], index: TermIndex | undefined): Array<{ id: string; text: string }> {
	if (!index) return ids.map((id) => ({ id, text: id }));
	const parentOf = (t: Term) => (t.parent ? index.list.find((x) => x.id === t.parent || x.group === t.parent) : undefined);
	const ancestors = new Set<string>();
	for (const id of ids) {
		let p = index.byId.get(id);
		for (let guard = 0; p && guard < 10; guard++) {
			p = parentOf(p);
			if (p) ancestors.add(p.id);
		}
	}
	return ids
		.filter((id) => !ancestors.has(id))
		.map((id) => {
			const chain: string[] = [];
			let t = index.byId.get(id);
			for (let guard = 0; t && guard < 10; guard++) {
				chain.unshift(t.label);
				t = parentOf(t);
			}
			return { id, text: chain.length ? chain.join(" › ") : id };
		});
}

/** ISO date ↔ the value of an <input type="datetime-local">. */
export function toLocalInput(v: unknown): string {
	if (typeof v !== "string" || !v) return "";
	const d = new Date(v);
	if (Number.isNaN(d.getTime())) return "";
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function CellView({ col, value, row, terms }: { col: GridColumn; value: unknown; row: GridRow; terms?: TermIndex }) {
	if (col.editor === "status") {
		const published = value === "published";
		return (
			<span className="lynx-status">
				<Badge variant={published ? "success" : value === "scheduled" ? "info" : "neutral"}>{String(value ?? "")}</Badge>
				{row.draft && published ? (
					<span title="This entry has unpublished draft changes">
						<Badge variant="warning">draft changes</Badge>
					</span>
				) : null}
			</span>
		);
	}
	if (value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0)) return <span className="lynx-cell__empty">—</span>;
	switch (col.editor) {
		case "switch": {
			const on = value === true || value === 1;
			return <span className={`lynx-switch ${on ? "is-on" : ""}`} role="img" aria-label={on ? "Yes" : "No"} />;
		}
		case "media": {
			const url = mediaUrl(value);
			return url ? <img className="lynx-thumb" src={url} alt={(value as { alt?: string }).alt ?? ""} loading="lazy" /> : <ImageIcon size={18} aria-label="Media" />;
		}
		case "terms": {
			const ids = Array.isArray(value) ? (value as string[]) : [];
			return (
				<span className="lynx-chips">
					{termChains(ids, terms).map((t) => (
						<span key={t.id} className="lynx-chip">
							{t.text}
						</span>
					))}
				</span>
			);
		}
		case "multiselect":
			return (
				<span className="lynx-chips">
					{(Array.isArray(value) ? value : [value]).map((x) => (
						<span key={String(x)} className="lynx-chip">
							{String(x)}
						</span>
					))}
				</span>
			);
		case "datetime":
			return <span>{formatDate(value)}</span>;
		case "number":
			return (
				<span className="lynx-num">
					{typeof value === "number" ? formatNumber(value, col.type, col.format) : String(value)}
					{unitLabel(col.unit) ? <span className="lynx-unit"> {unitLabel(col.unit)}</span> : null}
				</span>
			);
	}
	if (col.type === "datetime") return <span>{formatDate(value)}</span>;
	if (col.type === "repeater" && Array.isArray(value)) {
		const pics = value.map((x) => mediaUrl((x as { image?: unknown })?.image ?? x)).filter((u): u is string => Boolean(u));
		return pics.length ? (
			<span className="lynx-thumbs">
				{pics.slice(0, 3).map((u, i) => (
					<img key={i} className="lynx-thumb lynx-thumb--sm" src={u} alt="" loading="lazy" />
				))}
				{pics.length > 3 ? <span className="lynx-hint">+{pics.length - 3}</span> : null}
			</span>
		) : (
			<span className="lynx-hint">
				{value.length} {value.length === 1 ? "item" : "items"}
			</span>
		);
	}
	if (col.type === "portableText") return <span>{toPlainText(value).slice(0, 200)}</span>;
	return <span>{col.field ? displayValue(col.field, value, 200) : String(value)}</span>;
}

// ---------------------------------------------------------------------------
// Editors

interface EditorProps {
	col: GridColumn;
	value: unknown;
	/** A typed character that opened the editor; it replaces the value. */
	initial?: string;
	terms?: TermIndex;
	onCommit: Commit;
	onCancel: () => void;
	mediaImport?: (url: string) => Promise<unknown>;
	/** Title of the entry being edited, for editors that open a dialog. */
	entry?: string;
}

function useCommitter(onCommit: Commit) {
	const [problem, setProblem] = React.useState<string | null>(null);
	const done = React.useRef(false);
	const commit = (v: unknown, move?: Move) => {
		if (done.current) return;
		const p = onCommit(v, move);
		setProblem(p);
		if (!p) done.current = true;
	};
	return { problem, commit, done };
}

function Problem({ text }: { text: string | null }) {
	return text ? (
		<div className="lynx-editor__problem" role="alert">
			{text}
		</div>
	) : null;
}

export function CellEditor(props: EditorProps) {
	switch (props.col.editor) {
		case "textarea":
			return <TextareaEditor {...props} />;
		case "select":
		case "status":
			return <SelectEditor {...props} />;
		case "datetime":
			return <DateEditor {...props} />;
		case "multiselect":
		case "terms":
			return <ListEditor {...props} />;
		case "media":
			return <MediaEditor {...props} />;
		case "number":
			return props.initial === undefined && sliderRange(props.col) ? <SliderEditor {...props} /> : <InputEditor {...props} />;
		default:
			return <InputEditor {...props} />;
	}
}

/** A number with a short range: a slider, Enter or Apply to set it, Escape to leave. */
function SliderEditor({ col, value, onCommit, onCancel }: EditorProps) {
	const range = sliderRange(col)!;
	const digits = range.step < 1 ? 1 : 0;
	const start = typeof value === "number" ? value : Number(value);
	const [v, setV] = React.useState(Number.isFinite(start) ? Math.min(range.max, Math.max(range.min, start)) : range.min);
	const { problem, commit, done } = useCommitter(onCommit);
	const cancel = () => {
		done.current = true;
		onCancel();
	};
	const apply = () => commit(v.toFixed(digits), null);
	return (
		<div
			className="lynx-editor lynx-editor--pop lynx-editor--slider"
			onKeyDown={(e) => {
				if (e.key === "Escape") {
					e.preventDefault();
					e.stopPropagation();
					cancel();
				} else if (e.key === "Enter") {
					e.preventDefault();
					apply();
				}
			}}
		>
			<div className="lynx-slider__head">
				<span>{col.label}</span>
				<output className="lynx-slider__value" aria-live="polite">
					{v.toFixed(digits)}
					{col.unit && col.unit !== "currency" ? ` ${col.unit}` : ""}
				</output>
			</div>
			<input autoFocus type="range" className="lynx-slider" min={range.min} max={range.max} step={range.step} value={v} aria-label={col.label} onChange={(e) => setV(Number(e.target.value))} />
			<div className="lynx-slider__ends" aria-hidden>
				<span>{range.min}</span>
				<span>{range.max}</span>
			</div>
			<div className="lynx-editor__actions">
				<span className="lynx-hint">Arrows move it</span>
				<button type="button" className="lynx-btn lynx-btn--sm" onClick={cancel}>
					Cancel
				</button>
				<button type="button" className="lynx-btn lynx-btn--sm lynx-btn--primary" onClick={apply}>
					Apply
				</button>
			</div>
			<Problem text={problem} />
		</div>
	);
}

function InputEditor({ col, value, initial, onCommit, onCancel }: EditorProps) {
	const [text, setText] = React.useState(initial ?? (value === null || value === undefined ? "" : String(value)));
	const { problem, commit, done } = useCommitter(onCommit);
	const ref = React.useRef<HTMLInputElement>(null);
	React.useEffect(() => {
		ref.current?.focus();
		if (initial === undefined) ref.current?.select();
	}, [initial]);
	return (
		<div className="lynx-editor">
			<input
				ref={ref}
				className={`lynx-editor__input ${col.editor === "number" ? "is-num" : ""}`}
				inputMode={col.editor === "number" ? "decimal" : undefined}
				value={text}
				aria-label={`Edit ${col.label}`}
				aria-invalid={problem ? true : undefined}
				onChange={(e) => setText(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Enter") {
						e.preventDefault();
						commit(text, e.shiftKey ? "up" : "down");
					} else if (e.key === "Tab") {
						e.preventDefault();
						commit(text, e.shiftKey ? "left" : "right");
					} else if (e.key === "Escape") {
						e.preventDefault();
						e.stopPropagation();
						done.current = true;
						onCancel();
					}
				}}
				onBlur={() => commit(text, null)}
			/>
			<Problem text={problem} />
		</div>
	);
}

function TextareaEditor({ col, value, initial, onCommit, onCancel }: EditorProps) {
	const [text, setText] = React.useState(initial ?? (typeof value === "string" ? value : value == null ? "" : String(value)));
	const { problem, commit, done } = useCommitter(onCommit);
	const cancel = () => {
		done.current = true;
		onCancel();
	};
	return (
		<div className="lynx-editor lynx-editor--pop">
			<textarea
				autoFocus
				className="lynx-editor__textarea"
				value={text}
				rows={5}
				aria-label={`Edit ${col.label}`}
				onChange={(e) => setText(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
						e.preventDefault();
						commit(text, "down");
					} else if (e.key === "Escape") {
						e.preventDefault();
						e.stopPropagation();
						cancel();
					}
				}}
			/>
			<div className="lynx-editor__actions">
				<span className="lynx-hint">Ctrl+Enter to keep</span>
				<button type="button" className="lynx-icon-btn lynx-icon-btn--ok" aria-label="Keep" onMouseDown={(e) => e.preventDefault()} onClick={() => commit(text, null)}>
					<Check size={14} weight="bold" />
				</button>
				<button type="button" className="lynx-icon-btn" aria-label="Cancel" onMouseDown={(e) => e.preventDefault()} onClick={cancel}>
					<X size={14} weight="bold" />
				</button>
			</div>
			<Problem text={problem} />
		</div>
	);
}

function SelectEditor({ col, value, onCommit, onCancel }: EditorProps) {
	const { problem, commit, done } = useCommitter(onCommit);
	const options = col.editor === "status" ? ["published", "draft"] : (col.options ?? []);
	const current = value == null ? "" : String(value);
	return (
		<div className="lynx-editor">
			<select
				autoFocus
				className="lynx-editor__input"
				value={current}
				aria-label={`Edit ${col.label}`}
				onChange={(e) => commit(e.target.value === "" ? null : e.target.value, null)}
				onKeyDown={(e) => {
					if (e.key === "Escape") {
						e.preventDefault();
						e.stopPropagation();
						done.current = true;
						onCancel();
					} else if (e.key === "Enter") {
						e.preventDefault();
						commit(current === "" ? null : current, "down");
					}
				}}
				onBlur={() => {
					if (!done.current) {
						done.current = true;
						onCancel();
					}
				}}
			>
				{col.editor === "status" || col.required ? null : <option value="">—</option>}
				{col.editor === "status" && !options.includes(current) ? <option value={current}>{current}</option> : null}
				{options.map((o) => (
					<option key={o} value={o}>
						{o}
					</option>
				))}
			</select>
			<Problem text={problem} />
		</div>
	);
}

/**
 * Date and time of a cell, picked in Calendar23 (realmag777's calendar from Botoscope, the author
 * 2026-10-01): days, then month and year by clicking the header, the time below, ✔ to apply.
 * Calendar23 works on a wall-clock time read as UTC; the cell shows local time, so the value is
 * handed over as local wall clock and turned back into an ISO date on the way out.
 */
function toWallSeconds(v: unknown): number | null {
	if (typeof v !== "string" || !v) return null;
	const d = new Date(v);
	if (Number.isNaN(d.getTime())) return null;
	return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()) / 1000;
}
function fromWallSeconds(s: number): string {
	const w = new Date(s * 1000);
	return new Date(w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate(), w.getUTCHours(), w.getUTCMinutes()).toISOString();
}

function DateEditor({ col, value, entry, onCommit, onCancel }: EditorProps) {
	const box = React.useRef<HTMLDivElement>(null);
	const dialog = React.useRef<HTMLDivElement>(null);
	const { problem, commit, done } = useCommitter(onCommit);
	const latest = React.useRef(commit);
	latest.current = commit;
	// The second click of the double-click that opened the dialog must not land on a day: the
	// dialog takes clicks only after a moment.
	const [armed, setArmed] = React.useState(false);
	React.useEffect(() => {
		const t = window.setTimeout(() => setArmed(true), 400);
		return () => window.clearTimeout(t);
	}, []);
	// Built before the first paint (Calendar23 reads innerText, so its box must be rendered).
	React.useLayoutEffect(() => {
		const el = box.current;
		if (!el) return;
		const id = `lynx-cal-${Math.random().toString(36).slice(2)}`;
		new Calendar23(el, 0, id, toWallSeconds(value), { show_time: true });
		const picked = (e: Event) => {
			const d = (e as CustomEvent<Calendar23Selected>).detail;
			if (d?.calendar_id === id) latest.current(fromWallSeconds(d.date), null);
		};
		document.addEventListener("calendar23-date-selected", picked);
		dialog.current?.focus({ preventScroll: true });
		return () => document.removeEventListener("calendar23-date-selected", picked);
		// The calendar is built once per opening.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);
	const cancel = () => {
		done.current = true;
		onCancel();
	};
	// A centred dialog over the page (2026-10-01): the calendar is taller than a few rows
	// and must never be cut off; the header names the field and the entry.
	return (
		<>
			<span className="lynx-editor__pending">{formatDate(value) || "—"}</span>
			{createPortal(
				<div
					className={`lynx-root lynx-datemodal ${armed ? "is-armed" : ""}`}
					onKeyDown={(e) => {
						if (e.key === "Escape") {
							e.preventDefault();
							e.stopPropagation();
							cancel();
						}
					}}
				>
					<div className="lynx-datemodal__scrim" onClick={cancel} aria-hidden />
					<div ref={dialog} className="lynx-datemodal__box" role="dialog" aria-modal="true" aria-label={`${col.label}${entry ? `: ${entry}` : ""}`} tabIndex={-1}>
						<header className="lynx-datemodal__head">
							<div>
								<div className="lynx-datemodal__title">{col.label}</div>
								{entry ? <div className="lynx-datemodal__entry">{entry}</div> : null}
							</div>
							<button type="button" className="lynx-icon-btn" aria-label="Close" onClick={cancel}>
								<X size={18} weight="bold" />
							</button>
						</header>
						<div className="lynx-datemodal__body">
							<div ref={box} className="lynx-calendar" />
						</div>
						<footer className="lynx-datemodal__foot">
							<span className="lynx-hint">Pick a day (click the month for months and years), set the time, then ✔</span>
							{!col.required ? (
								<button type="button" className="lynx-btn lynx-btn--sm" onClick={() => commit(null, null)}>
									Clear
								</button>
							) : null}
							<button type="button" className="lynx-btn lynx-btn--sm" onClick={cancel}>
								Cancel
							</button>
						</footer>
						{problem ? (
							<div className="lynx-datemodal__problem" role="alert">
								{problem}
							</div>
						) : null}
					</div>
				</div>,
				document.body,
			)}
		</>
	);
}

/**
 * A term tree (termOptions order) narrowed to a search: each matching term with its parents (so
 * "3 Series" shows under BMW) and its children (so "BMW" shows every model); `keep` stays listed.
 */
export function searchTermOptions<T extends { id: string; label: string; depth: number }>(all: T[], q: string, keep: string[] = []): T[] {
	const needle = q.trim().toLowerCase();
	if (!needle) return all;
	const show = new Set<number>();
	all.forEach((o, i) => {
		if (!o.label.toLowerCase().includes(needle) && !keep.includes(o.id)) return;
		show.add(i);
		for (let d = o.depth, j = i - 1; j >= 0 && d > 0; j--) if (all[j]!.depth < d) (show.add(j), (d = all[j]!.depth));
		for (let j = i + 1; j < all.length && all[j]!.depth > o.depth; j++) show.add(j);
	});
	return all.filter((_, i) => show.has(i));
}

/** Multi-select and taxonomy picker: search, checkboxes, Apply / Cancel. */
function ListEditor({ col, value, terms, onCommit, onCancel }: EditorProps) {
	const isTerms = col.editor === "terms";
	const all: Array<{ id: string; label: string; depth: number }> = isTerms ? termOptions(terms?.list ?? []) : (col.options ?? []).map((o) => ({ id: o, label: o, depth: 0 }));
	const [picked, setPicked] = React.useState<string[]>(Array.isArray(value) ? (value as unknown[]).map(String) : value ? [String(value)] : []);
	const [q, setQ] = React.useState("");
	const { problem, commit, done } = useCommitter(onCommit);
	const shown = searchTermOptions(all, q);
	const cancel = () => {
		done.current = true;
		onCancel();
	};
	const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
	// A one-term taxonomy (a car has one make): radio buttons, a pick applies at once. On a tree the
	// entry also carries the parents (Mercedes-Benz › GLC), so the chosen term is the deepest one.
	const single = isTerms && col.info.single === true;
	const current = single ? all.filter((o) => picked.includes(o.id)).sort((a, b) => b.depth - a.depth)[0]?.id : undefined;
	return (
		<div
			className="lynx-editor lynx-editor--pop lynx-editor--list"
			onKeyDown={(e) => {
				if (e.key === "Escape") {
					e.preventDefault();
					e.stopPropagation();
					cancel();
				} else if (e.key === "Enter" && (e.ctrlKey || e.metaKey || (e.target as HTMLElement).tagName === "INPUT")) {
					e.preventDefault();
					if (!single) commit(picked, null);
				}
			}}
		>
			<label className="lynx-search lynx-search--sm">
				<MagnifyingGlass size={14} aria-hidden />
				<input autoFocus type="search" placeholder={`Find ${isTerms ? "terms" : "options"}`} value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter the list" />
			</label>
			<ul className="lynx-checklist" role={single ? "radiogroup" : "listbox"} aria-multiselectable={single ? undefined : "true"} aria-label={col.label}>
				{shown.length === 0 ? <li className="lynx-hint">Nothing matches.</li> : null}
				{shown.map((o) => (
					<li key={o.id} style={{ paddingInlineStart: 8 + o.depth * 14 }}>
						<label className="lynx-check">
							{single ? <input type="radio" name={`one-${col.key}`} checked={current === o.id} onChange={() => commit([o.id], null)} /> : <input type="checkbox" checked={picked.includes(o.id)} onChange={() => toggle(o.id)} />}
							<span>{o.label}</span>
						</label>
					</li>
				))}
			</ul>
			<div className="lynx-editor__actions">
				<span className="lynx-hint">{single ? "One per entry" : `${picked.length} chosen`}</span>
				<button type="button" className="lynx-btn lynx-btn--sm" onClick={cancel}>
					Cancel
				</button>
				{single ? (
					<button type="button" className="lynx-btn lynx-btn--sm" disabled={!current} onClick={() => commit([], null)}>
						Clear
					</button>
				) : (
					<button type="button" className="lynx-btn lynx-btn--sm lynx-btn--primary" onClick={() => commit(picked, null)}>
						Apply
					</button>
				)}
			</div>
			<Problem text={problem} />
		</div>
	);
}

/** Terms in tree order (parents before children) with their depth. */
export function termOptions(list: Term[]): Array<{ id: string; label: string; depth: number }> {
	const children = new Map<string | null, Term[]>();
	for (const t of list) {
		const parent = t.parent ? list.find((x) => x.id === t.parent || x.group === t.parent) : undefined;
		const p = parent ? parent.id : null;
		children.set(p, [...(children.get(p) ?? []), t]);
	}
	const out: Array<{ id: string; label: string; depth: number }> = [];
	const walk = (p: string | null, depth: number) => {
		for (const t of (children.get(p) ?? []).sort((a, b) => a.label.localeCompare(b.label))) {
			out.push({ id: t.id, label: t.label, depth });
			walk(t.id, depth + 1);
		}
	};
	walk(null, 0);
	return out;
}

/** Media cell: preview, clear, and (with LYNX Media installed) import from a URL. */
function MediaEditor({ col, value, onCommit, onCancel, mediaImport }: EditorProps) {
	const [url, setUrl] = React.useState("");
	const [busy, setBusy] = React.useState(false);
	const [err, setErr] = React.useState<string | null>(null);
	const { problem, commit, done } = useCommitter(onCommit);
	const src = mediaUrl(value);
	const cancel = () => {
		done.current = true;
		onCancel();
	};
	const run = async () => {
		if (!mediaImport || !url.trim()) return;
		setBusy(true);
		setErr(null);
		try {
			commit(await mediaImport(url.trim()), null);
		} catch (e) {
			setErr(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	};
	return (
		<div
			className="lynx-editor lynx-editor--pop lynx-editor--media"
			onKeyDown={(e) => {
				if (e.key === "Escape") {
					e.preventDefault();
					e.stopPropagation();
					cancel();
				}
			}}
		>
			{src ? <img className="lynx-editor__preview" src={src} alt="" /> : <div className="lynx-hint">No image.</div>}
			{col.type === "image" && mediaImport ? (
				<div className="lynx-row">
					<input
						autoFocus
						className="lynx-input lynx-input--sm"
						type="url"
						placeholder="https://… image URL"
						value={url}
						aria-label="Image URL"
						onChange={(e) => setUrl(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") {
								e.preventDefault();
								void run();
							}
						}}
					/>
					<button type="button" className="lynx-btn lynx-btn--sm lynx-btn--primary" disabled={busy || !url.trim()} onClick={() => void run()}>
						{busy ? "Importing…" : "Import"}
					</button>
				</div>
			) : col.type === "image" ? (
				<p className="lynx-hint">Install the LYNX Media plugin to import images by URL. To pick an image from the library, open the entry.</p>
			) : null}
			{err ? <div className="lynx-editor__problem">{err}</div> : null}
			<div className="lynx-editor__actions">
				{!col.required && value ? (
					<button type="button" className="lynx-btn lynx-btn--sm" onClick={() => commit(null, null)}>
						Clear
					</button>
				) : null}
				<button type="button" className="lynx-btn lynx-btn--sm" autoFocus={!(col.type === "image" && mediaImport)} onClick={cancel}>
					Close
				</button>
			</div>
			<Problem text={problem} />
		</div>
	);
}
