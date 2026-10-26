import type { ViewConfig } from "./api.ts";
import { defaultOrder, HIDDEN_BY_DEFAULT, titleColumn, type GridColumn } from "./columns.ts";
import { emptyFilter, type FilterState } from "./filter.ts";

// Layout of the grid for one collection: column order, hidden columns, widths, pinned columns,
// sort, density and page size. Kept like Botoscope's column order, on two levels: localStorage
// for an instant first paint, and named views stored per user by the core (views/* routes).

export interface ViewState {
	order: string[];
	hidden: string[];
	widths: Record<string, number>;
	pinned: string[];
	sort: { key: string; dir: "asc" | "desc" } | null;
	density: "comfortable" | "compact";
	pageSize: number;
	filter: FilterState;
}

export const PAGE_SIZES = [25, 50, 100, 200];
export const MIN_WIDTH = 64;
export const MAX_WIDTH = 640;

export function defaultView(cols: GridColumn[]): ViewState {
	const title = titleColumn(cols);
	return {
		order: defaultOrder(cols),
		hidden: cols.filter((c) => HIDDEN_BY_DEFAULT.has(c.key)).map((c) => c.key),
		widths: {},
		pinned: title ? [title] : [],
		sort: { key: "updated_at", dir: "desc" },
		density: "comfortable",
		pageSize: 50,
		filter: emptyFilter(),
	};
}

/** Make a stored view fit the current schema: drop unknown columns, append new ones. */
export function reconcileView(view: Partial<ViewState> | null | undefined, cols: GridColumn[]): ViewState {
	const base = defaultView(cols);
	if (!view) return base;
	const known = new Set(cols.map((c) => c.key));
	const order = (view.order ?? []).filter((k) => known.has(k));
	for (const k of base.order) if (!order.includes(k)) order.push(k);
	const sortOk = view.sort === null || (view.sort && (known.has(view.sort.key) || view.sort.key === "updated_at"));
	return {
		order,
		hidden: (view.hidden ?? base.hidden).filter((k) => known.has(k)),
		widths: Object.fromEntries(Object.entries(view.widths ?? {}).filter(([k, w]) => known.has(k) && typeof w === "number")),
		pinned: (view.pinned ?? base.pinned).filter((k) => known.has(k)),
		sort: sortOk ? (view.sort ?? base.sort) : base.sort,
		density: view.density === "compact" ? "compact" : "comfortable",
		pageSize: PAGE_SIZES.includes(view.pageSize ?? 0) ? view.pageSize! : base.pageSize,
		filter: view.filter ? { ...emptyFilter(), ...view.filter } : base.filter,
	};
}

/** Visible columns in display order, pinned ones first, each with its current width. */
export function visibleColumns(cols: GridColumn[], view: ViewState): GridColumn[] {
	const byKey = new Map(cols.map((c) => [c.key, c]));
	const hidden = new Set(view.hidden);
	const shown = view.order.filter((k) => !hidden.has(k) && byKey.has(k)).map((k) => ({ ...byKey.get(k)!, width: view.widths[k] ?? byKey.get(k)!.width }));
	const pinned = new Set(view.pinned);
	return [...shown.filter((c) => pinned.has(c.key)).map((c) => ({ ...c, pinned: true })), ...shown.filter((c) => !pinned.has(c.key))];
}

export function moveColumn(view: ViewState, key: string, delta: -1 | 1): ViewState {
	const visible = view.order.filter((k) => !view.hidden.includes(k));
	const i = visible.indexOf(key);
	const j = i + delta;
	if (i < 0 || j < 0 || j >= visible.length) return view;
	const other = visible[j]!;
	const order = [...view.order];
	const a = order.indexOf(key);
	const b = order.indexOf(other);
	order[a] = other;
	order[b] = key;
	return { ...view, order };
}

export function resizeColumn(view: ViewState, key: string, width: number): ViewState {
	return { ...view, widths: { ...view.widths, [key]: Math.round(Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, width))) } };
}

export function toggleHidden(view: ViewState, key: string): ViewState {
	const hidden = view.hidden.includes(key) ? view.hidden.filter((k) => k !== key) : [...view.hidden, key];
	return { ...view, hidden };
}

export function togglePinned(view: ViewState, key: string): ViewState {
	const pinned = view.pinned.includes(key) ? view.pinned.filter((k) => k !== key) : [...view.pinned, key];
	return { ...view, pinned };
}

/** One sort at a time (Botoscope kept an arrow per column): asc → desc → back to the default. */
export function nextSort(sort: ViewState["sort"], key: string): ViewState["sort"] {
	if (!sort || sort.key !== key) return { key, dir: "asc" };
	if (sort.dir === "asc") return { key, dir: "desc" };
	return { key: "updated_at", dir: "desc" };
}

export const toConfig = (v: ViewState): ViewConfig => ({ ...v, filter: v.filter });
export const fromConfig = (c: ViewConfig): Partial<ViewState> => c as Partial<ViewState>;

const LS = (collection: string) => `lynx-grid:view:${collection}`;

export function loadLocalView(collection: string): Partial<ViewState> | null {
	try {
		const raw = localStorage.getItem(LS(collection));
		return raw ? (JSON.parse(raw) as Partial<ViewState>) : null;
	} catch {
		return null;
	}
}

export function saveLocalView(collection: string, view: ViewState): void {
	try {
		localStorage.setItem(LS(collection), JSON.stringify(view));
	} catch {
		// Private mode or full storage: the layout just is not remembered.
	}
}
