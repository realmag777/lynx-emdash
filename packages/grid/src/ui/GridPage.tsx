import { Badge, Button, Checkbox, DropdownMenu, Empty, Input, Loader, Popover, Switch } from "@cloudflare/kumo";
import { Broom, ClockCounterClockwise, Columns, CurrencyEur, Database, DotsThreeVertical, FloppyDisk, Funnel, GearSix, Plus, MagnifyingGlass, PencilSimpleLine, PushPin, Star, Trash, X } from "@phosphor-icons/react";
import * as React from "react";

import { LynxApiError, type FieldInfo, type GridRow, type JobAnswer, type SavedView, type SiteInfo } from "../model/api.ts";
import { buildGridColumns, titleColumn, type GridColumn } from "../model/columns.ts";
import { CURRENCIES, formatNumber, formatOf, type FieldFormat, type Formats } from "../model/format.ts";
import { batches, checkValue, dirtyCount, setDirty, toOperations, withCellValue, type Dirty } from "../model/edits.ts";
import { activeFilterCount, emptyFilter, toEntryFilter, type FilterState } from "../model/filter.ts";
import type { CellPos } from "../model/keyboard.ts";
import { copyText, planPaste, toTsv } from "../model/paste.ts";
import { emptySelection, selectedCount, toggleAllLoaded, toggleRow, type RowSelection } from "../model/selection.ts";
import { fromConfig, loadLocalView, moveColumn, nextSort, reconcileView, resizeColumn, saveLocalView, toConfig, toggleHidden, togglePinned, visibleColumns, type ViewState } from "../model/view.ts";
import { BulkPanel, type BulkTarget } from "./BulkPanel.tsx";
import { NewEntryPanel } from "./NewEntryPanel.tsx";
import { Cards } from "./Cards.tsx";
import { type TermIndex } from "./cells.tsx";
import { errorText, useApi, useGridApi, useMedia, useNotify } from "./context.tsx";
import { FilterPanel } from "./FilterPanel.tsx";
import { Grid, isEditable, type Editing } from "./Grid.tsx";
import { EmptyDraftsCleanup, HistoryPanel, JobProgress } from "./jobs.tsx";
import { ConfirmDialog, IconButton, KSelect, ShortcutsDialog } from "./kit.tsx";
import { Pagination } from "./Pagination.tsx";
import { PresetWizard } from "./PresetWizard.tsx";
import { GalleryPanel } from "./GalleryPanel.tsx";
import { IndexToggle } from "./IndexToggle.tsx";
import { SettingsPanel } from "./SettingsPanel.tsx";
import { ADMIN_ROLE, currentRole, indexable } from "../model/schema.ts";
import { RichTextPanel } from "./RichTextPanel.tsx";

// The LYNX Grid page. It owns the state (collection, view, page of rows, dirty cells, row
// selection). Reads go to the grid's own routes (no sandbox budget); every content write goes
// to the core (edits, bulk jobs, update_entry, rollback), so history and rollback are shared
// with agents. Exceptions, both outside content writes: the preset wizard (schema REST API)
// and removing empty drafts (admin REST discard-draft), each as the signed-in user.

const LAST_COLLECTION = "lynx-grid:collection";
const MEDIA_PLUGIN = "lynx-media";

type Panel = "filter" | "bulk" | "new" | "history" | "preset" | "richtext" | "gallery" | "settings" | null;

function lsGet(k: string): string | null {
	try {
		return localStorage.getItem(k);
	} catch {
		return null;
	}
}
function lsSet(k: string, v: string) {
	try {
		localStorage.setItem(k, v);
	} catch {
		// ignore
	}
}

/** Is LYNX Media installed and enabled? Read from the admin manifest (the core cannot tell). */
async function detectMediaPlugin(): Promise<boolean> {
	try {
		const res = await fetch("/_emdash/api/manifest", { credentials: "same-origin", headers: { "X-EmDash-Request": "1" } });
		const body = (await res.json()) as { data?: { plugins?: Record<string, { enabled?: boolean }> } };
		const p = body.data?.plugins?.[MEDIA_PLUGIN];
		return Boolean(p && p.enabled !== false);
	} catch {
		return false;
	}
}

async function importViaMedia(url: string): Promise<unknown> {
	const res = await fetch(`/_emdash/api/plugins/${MEDIA_PLUGIN}/import`, {
		method: "POST",
		credentials: "same-origin",
		headers: { "content-type": "application/json", "X-EmDash-Request": "1" },
		body: JSON.stringify({ images: [{ url }] }),
	});
	const body = (await res.json().catch(() => null)) as { success?: boolean; data?: { imported?: Array<{ value: unknown }>; failed?: Array<{ message: string }>; ok?: boolean; message?: string }; error?: { message?: string } } | null;
	if (!res.ok || !body?.success) throw new Error(body?.error?.message ?? `Import failed (${res.status})`);
	if (body.data?.ok === false) throw new Error(body.data.message ?? "Import failed");
	const got = body.data?.imported?.[0];
	if (!got) throw new Error(body.data?.failed?.[0]?.message ?? "The image could not be imported");
	return got.value;
}


export function GridPage() {
	const api = useApi();
	const grid = useGridApi();
	const notify = useNotify();
	const mobile = useMedia("(max-width: 768px)");

	const [site, setSite] = React.useState<SiteInfo | null>(null);
	const [fatal, setFatal] = React.useState<{ code: string; text: string } | null>(null);
	const [collection, setCollection] = React.useState<string>("");
	const [fields, setFields] = React.useState<FieldInfo[]>([]);
	const [revisions, setRevisions] = React.useState(false);
	const [view, setViewState] = React.useState<ViewState | null>(null);
	const [terms, setTerms] = React.useState<Map<string, TermIndex>>(new Map());
	const [total, setTotal] = React.useState<number | null>(null);
	const [counted, setCounted] = React.useState(0);
	const [estimate, setEstimate] = React.useState<number | null>(null);
	const [page, setPage] = React.useState(0);
	const [rows, setRows] = React.useState<GridRow[]>([]);
	const [loading, setLoading] = React.useState(true);
	const [dirty, setDirtyState] = React.useState<Dirty>(new Map());
	const [failed, setFailed] = React.useState<Map<string, Map<string, string>>>(new Map());
	const [saved, setSaved] = React.useState<Set<string>>(new Set());
	const [rowSel, setRowSel] = React.useState<RowSelection>(emptySelection());
	const [active, setActive] = React.useState<CellPos | null>(null);
	const [editing, setEditing] = React.useState<Editing | null>(null);
	const [panel, setPanel] = React.useState<Panel>(null);
	/** The toolbar's Bulk edit picked "all matching" itself: drop that selection when the panel closes. */
	const autoAll = React.useRef(false);
	// Field settings (2026-10-01): the gear menu open on a column, a slow sort to point at it,
	// and whether the user may change indexes (EmDash: administrators only).
	const [fieldMenu, setFieldMenu] = React.useState<string | null>(null);
	const [role, setRole] = React.useState<number | null | undefined>(undefined);
	React.useEffect(() => {
		void currentRole().then(setRole);
	}, []);
	const canManage = role === undefined ? null : role !== null && role >= ADMIN_ROLE;
	const [views, setViews] = React.useState<SavedView[]>([]);
	// Edits go straight into the entry, as in WooCommerce (2026-10-01): a published entry
	// shows them on the site at once, a draft stays a draft. The status has its own column.
	const saveMode = "publish" as const;
	const [saving, setSaving] = React.useState<JobAnswer | null>(null);
	const [hasMedia, setHasMedia] = React.useState(false);
	const [search, setSearch] = React.useState("");
	const [viewName, setViewName] = React.useState("");
	const [tick, setTick] = React.useState(0);
	const [pendingCollection, setPendingCollection] = React.useState<string | null>(null);
	const [richText, setRichText] = React.useState<{ row: GridRow; col: GridColumn } | null>(null);
	const [draftCheck, setDraftCheck] = React.useState(0);
	const [help, setHelp] = React.useState(false);
	const [formats, setFormats] = React.useState<Formats | null>(null);
	// Repeater fields that are photo galleries (field key -> its image sub-field), from the grid's route.
	const [galleries, setGalleries] = React.useState<Record<string, string>>({});

	const cols = React.useMemo(
		() =>
			buildGridColumns(fields).map((c): GridColumn => {
				if (c.type === "number" || c.type === "integer") return { ...c, format: formatOf(formats ?? undefined, c.key, c) };
				if (c.type === "repeater" && galleries[c.key] && c.info.editable) {
					const { closed: _closed, ...rest } = c;
					return { ...rest, editor: "gallery", gallery: galleries[c.key] };
				}
				return c;
			}),
		[fields, formats, galleries],
	);
	const colByKey = React.useMemo(() => new Map(cols.map((c) => [c.key, c])), [cols]);
	const shown = React.useMemo(() => (view ? visibleColumns(cols, view) : []), [cols, view]);
	const titleKey = titleColumn(cols);
	const taxonomies = React.useMemo(() => site?.collections.find((c) => c.slug === collection)?.taxonomies ?? [], [site, collection]);
	const counts = dirtyCount(dirty);
	const filter = React.useMemo(() => (view ? toEntryFilter(view.filter, fields, titleKey) : {}), [view, fields, titleKey]);

	const setView = React.useCallback(
		(f: (v: ViewState) => ViewState) =>
			setViewState((v) => {
				if (!v) return v;
				const next = f(v);
				saveLocalView(collection, next);
				return next;
			}),
		[collection],
	);

	// 1. Site description (core: the same schema rules agents see) and LYNX Media detection.
	const loadSite = React.useCallback(async () => {
		try {
			const s = await api.describe();
			setSite(s);
			setFatal(null);
			return s;
		} catch (e) {
			setFatal({ code: e instanceof LynxApiError ? e.code : "ERROR", text: errorText(e) });
			setLoading(false);
			return null;
		}
	}, [api]);

	React.useEffect(() => {
		void (async () => {
			const s = await loadSite();
			if (!s) return;
			const last = lsGet(LAST_COLLECTION);
			const pick = s.collections.find((c) => c.slug === last)?.slug ?? s.collections[0]?.slug ?? "";
			setCollection(pick);
			if (!pick) setLoading(false);
		})();
		void detectMediaPlugin().then(setHasMedia);
	}, [loadSite]);

	// 2. Collection: fields (core), layout, term lists and saved views (grid routes).
	React.useEffect(() => {
		if (!collection) return;
		let stale = false;
		setLoading(true);
		setFields([]);
		setFormats(null);
		setGalleries({});
		setViewState(null);
		setTotal(null);
		setRows([]);
		setDirtyState(new Map());
		setFailed(new Map());
		setRowSel(emptySelection());
		setActive(null);
		setEditing(null);
		lsSet(LAST_COLLECTION, collection);
		void (async () => {
			try {
				const f = await api.fields(collection);
				if (stale) return;
				const gridCols = buildGridColumns(f.fields);
				setFields(f.fields);
				setRevisions(f.revisions);
				const v = reconcileView(loadLocalView(collection), gridCols);
				setViewState(v);
				setSearch(v.filter.search);
				const taxes = gridCols.filter((c) => c.taxonomy).map((c) => c.taxonomy!);
				const loaded = await Promise.all(taxes.map((t) => grid.terms(t).then((r) => [t, r.terms] as const).catch(() => [t, []] as const)));
				if (stale) return;
				setTerms(new Map(loaded.map(([t, list]) => [t, { list: [...list], byId: new Map(list.map((x) => [x.id, x])) }])));
				grid.views(collection)
					.then((r) => !stale && setViews(r.views))
					.catch(() => setViews([]));
				grid.galleries(collection)
					.then((r) => !stale && setGalleries(r.galleries))
					.catch(() => undefined);
				grid.formats(collection)
					.then((r) => !stale && setFormats(r.formats))
					.catch(() => undefined);
			} catch (e) {
				if (!stale) {
					notify("error", "Could not load the collection", errorText(e));
					setLoading(false);
				}
			}
		})();
		return () => {
			stale = true;
		};
	}, [api, grid, collection, notify]);

	/**
	 * After a side panel (rich text, photos) saved one cell through the core: redraw that cell in
	 * place. No reload, so the table keeps its scroll position and the active cell.
	 */
	const patchCell = (value: unknown, mode: "draft" | "publish") => {
		if (!richText) return;
		const { row, col } = richText;
		setRows((rs) => rs.map((r) => (r.id === row.id ? { ...withCellValue(r, col.key, value), draft: r.draft || (revisions && mode === "draft") } : r)));
	};

	/** A number field's display format, saved for everyone (the grid's formats storage). */
	const saveFormat = (key: string, fmt: FieldFormat) => {
		const next = { ...(formats ?? {}), [key]: fmt };
		setFormats(next);
		grid.saveFormats(collection, next).catch((e) => notify("error", "Could not save the number format", errorText(e)));
	};

	// A new filter or sort starts at page 1 with nothing selected.
	const filterKey = view ? JSON.stringify([view.filter, view.sort]) : "";
	React.useEffect(() => {
		setPage(0);
		setRowSel(emptySelection());
	}, [filterKey]);

	// 3. A page of rows: one call to the grid's own read route (terms and draft values included).
	// On big collections the page arrives before the count; the count is polled until it is known.
	// After the grid's own writes (tick changed) the server is asked for a fresh scan.
	const lastTick = React.useRef(tick);
	React.useEffect(() => {
		if (!view || !collection || !fields.length) return;
		let stale = false;
		let timer: number | undefined;
		setLoading(true);
		const taxes = cols.filter((c) => c.taxonomy).map((c) => c.taxonomy!);
		const fresh = lastTick.current !== tick;
		lastTick.current = tick;
		const load = (first: boolean) =>
			grid
				.rows({ collection, filter, sort: view.sort, offset: page * view.pageSize, limit: view.pageSize, terms: taxes, ...(first && fresh ? { fresh: true } : {}) })
				.then((r) => {
					if (stale) return;
					setRows(r.rows);
					setTotal(r.total);
					setCounted(r.counted);
					setEstimate(r.estimate ?? null);
					if (first) {
						setActive((a) => (a && a.row < r.rows.length ? a : null));
						setEditing(null);
					}
					if (r.total === null) timer = window.setTimeout(() => void load(false), 400);
				})
				.catch((e) => {
					if (stale) return;
					// A sort the collection has outgrown (over the in-memory limit, no index): drop it and say why.
					if (e instanceof LynxApiError && e.code === "NEEDS_INDEX") {
						notify("warning", "Sort removed", errorText(e));
						setView((v) => ({ ...v, sort: null }));
						return;
					}
					setRows([]);
					setTotal(0);
					notify("error", "Could not load the rows", errorText(e));
				})
				.finally(() => first && !stale && setLoading(false));
		void load(true);
		return () => {
			stale = true;
			if (timer) window.clearTimeout(timer);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [grid, collection, fields, filterKey, page, view?.pageSize, tick]);

	// Quick search: debounced into the filter.
	React.useEffect(() => {
		if (!view || search === view.filter.search) return;
		const t = window.setTimeout(() => setView((v) => ({ ...v, filter: { ...v.filter, search } })), 400);
		return () => window.clearTimeout(t);
	}, [search, view, setView]);

	// Unsaved edits: warn before leaving the page.
	React.useEffect(() => {
		if (!counts.cells) return;
		const on = (e: BeforeUnloadEvent) => {
			e.preventDefault();
			e.returnValue = "";
		};
		window.addEventListener("beforeunload", on);
		return () => window.removeEventListener("beforeunload", on);
	}, [counts.cells]);

	/** After an index changed: read the fields again (sortable columns, filters in the database). */
	const reloadFields = React.useCallback(() => {
		api.fields(collection)
			.then((f) => setFields(f.fields))
			.catch((e) => notify("error", "Could not read the fields again", errorText(e)));
	}, [api, collection, notify]);

	const refreshAll = React.useCallback(() => {
		setTick((t) => t + 1);
		setRowSel(emptySelection());
		void loadSite();
	}, [loadSite]);

	// ---------------------------------------------------------------------------
	// Editing

	const commit = React.useCallback((row: GridRow, col: GridColumn, value: unknown): string | null => {
		if (!isEditable(col)) return col.closed ? `Read only: ${col.closed}` : "Read only";
		const checked = checkValue(col, value);
		if (!checked.ok) return checked.problem;
		setDirtyState((d) => setDirty(d, row, col, checked.value));
		setFailed((f) => {
			if (!f.get(row.id)?.has(col.key)) return f;
			const next = new Map(f);
			const m = new Map(next.get(row.id));
			m.delete(col.key);
			if (m.size) next.set(row.id, m);
			else next.delete(row.id);
			return next;
		});
		return null;
	}, []);

	const resolveTerms = React.useCallback(
		(col: GridColumn, labels: string[]): string[] | null => {
			const idx = col.taxonomy ? terms.get(col.taxonomy) : undefined;
			if (!idx) return null;
			const out: string[] = [];
			for (const l of labels) {
				const k = l.toLowerCase();
				const t = idx.list.find((x) => x.id === l || x.slug.toLowerCase() === k || x.label.toLowerCase() === k);
				if (!t) return null;
				out.push(t.id);
			}
			return out;
		},
		[terms],
	);

	const onPaste = (text: string) => {
		if (!active) return;
		const plan = planPaste(text, rows, shown, active, resolveTerms);
		setDirtyState((d) => {
			let next = d;
			for (const e of plan.edits) {
				const row = rows.find((r) => r.id === e.rowId);
				const col = colByKey.get(e.key);
				if (row && col) next = setDirty(next, row, col, e.value);
			}
			return next;
		});
		if (plan.problems.length || plan.skipped) notify(plan.problems.length ? "warning" : "info", `Pasted ${plan.edits.length} cells`, [plan.problems.length ? `${plan.problems.length} not pasted: ${plan.problems[0]!.problem}` : "", plan.skipped ? `${plan.skipped} skipped (read-only or outside the grid)` : ""].filter(Boolean).join(". "));
		else notify("success", `Pasted ${plan.edits.length} cells`, "Review them and press Save.");
	};

	const onCopy = () => {
		const picked = rows.filter((r) => rowSel.ids.has(r.id));
		const labelOf = (c: GridColumn) => (id: string) => (c.taxonomy ? (terms.get(c.taxonomy)?.byId.get(id)?.label ?? id) : id);
		let text = "";
		if (picked.length) text = toTsv(picked.map((r) => shown.map((c) => copyText(r, c, labelOf(c)))));
		else if (active && rows[active.row] && shown[active.col]) text = copyText(rows[active.row]!, shown[active.col]!, labelOf(shown[active.col]!));
		if (!text) return;
		navigator.clipboard?.writeText(text).then(
			() => notify("info", picked.length ? `Copied ${picked.length} rows` : "Copied"),
			() => notify("warning", "The browser did not allow copying"),
		);
	};

	const onClear = () => {
		if (!active) return;
		const row = rows[active.row];
		const col = shown[active.col];
		if (!row || !col || !isEditable(col) || col.editor === "status" || col.editor === "richtext") return;
		const p = commit(row, col, col.editor === "terms" || col.editor === "multiselect" ? [] : col.editor === "switch" ? false : null);
		if (p) notify("warning", "Not cleared", p);
	};

	const save = async () => {
		if (!counts.cells || saving) return;
		// Cells saved per entry. The core writes an entry whole; when it turns one down only for
		// edited cells that break a rule, the entry's other edited cells are saved in one more pass,
		// so a bad value in one cell does not hold back the rest of the row.
		const saved = new Map<string, Set<string>>();
		const bad = new Map<string, Map<string, string>>();
		const label = (k: string) => colByKey.get(k)?.label ?? k;
		const run = async (cells: Dirty): Promise<Dirty> => {
			const retry: Dirty = new Map();
			for (const part of batches(Object.entries(toOperations(cells, colByKey)))) {
				const first = await api.saveEdits(collection, part, saveMode);
				const end = await api.drive(first, setSaving);
				const left = new Set<string>();
				if (end.result && (end.result.failed || end.result.invalid || end.result.conflicts || end.result.held)) {
					const detail = await api.historyJob(end.job_key);
					for (const x of detail.left_alone) {
						left.add(x.entry_id);
						const mine = cells.get(x.entry_id) ?? new Map<string, unknown>();
						const m = new Map<string, string>();
						for (const pr of x.problems ?? []) m.set(pr.field, pr.message);
						const others = new Map([...mine].filter(([k]) => !m.has(k)));
						if (x.why === "invalid" && m.size && [...m.keys()].every((k) => mine.has(k)) && others.size) retry.set(x.entry_id, others);
						else {
							const why = x.message ?? (x.why === "held" ? "Not saved: this entry has unpublished changes made in the entry editor. Publish or discard them there first." : x.why === "conflict" ? "Changed by someone else meanwhile; reload and try again." : m.size ? `Not saved: a value already in ${[...m.keys()].map(label).join(", ")} breaks a rule; fix it first.` : `Not saved (${x.why}).`);
							for (const k of mine.keys()) if (!m.has(k)) m.set(k, why);
						}
						bad.set(x.entry_id, new Map([...(bad.get(x.entry_id) ?? []), ...[...m].filter(([k]) => mine.has(k))]));
					}
				}
				for (const id of Object.keys(part)) if (!left.has(id)) saved.set(id, new Set([...(saved.get(id) ?? []), ...(cells.get(id)?.keys() ?? [])]));
			}
			return retry;
		};
		try {
			const retry = await run(dirty);
			if (retry.size) await run(retry);
		} catch (e) {
			notify("error", "Save failed", errorText(e));
		}
		const ok = new Set(saved.keys());
		setSaving(null);
		// Show the saved values in place: no reload, so rows keep their order (the default sort is by
		// last change) and the table keeps its scroll and active cell.
		setRows((rs) =>
			rs.map((r) => {
				const keys = saved.get(r.id);
				const d = dirty.get(r.id);
				if (!keys || !d) return r;
				let next = r;
				for (const k of keys) if (d.has(k)) next = withCellValue(next, k, d.get(k));
				// Written into the entry itself: nothing waits in a draft any more.
				const { live: _, ...written } = next;
				return { ...written, draft: false };
			}),
		);
		setDirtyState((d) => {
			const next = new Map(d);
			for (const [id, keys] of saved) {
				const rest = new Map([...(next.get(id) ?? [])].filter(([k]) => !keys.has(k)));
				if (rest.size) next.set(id, rest);
				else next.delete(id);
			}
			return next;
		});
		setFailed(bad);
		// Say why right away (the red cells repeat it on hover).
		const reasons = [...bad.values()].flatMap((m) => [...m.values()]);
		const why = reasons.length ? `${reasons.length} ${reasons.length === 1 ? "cell" : "cells"} not saved (red): ${reasons[0]}${reasons.length > 1 ? " …" : ""}` : undefined;
		if (ok.size) {
			setSaved(new Set(ok));
			window.setTimeout(() => setSaved(new Set()), 1600);
			notify(bad.size ? "warning" : "success", `Saved ${ok.size} ${ok.size === 1 ? "entry" : "entries"}`, why);
		} else if (bad.size) notify("error", "Nothing was saved", why);
	};

	const discard = () => {
		setDirtyState(new Map());
		setFailed(new Map());
	};

	// ---------------------------------------------------------------------------
	// Views

	const applySaved = (v: SavedView) => {
		const next = reconcileView(fromConfig(v.config), cols);
		setViewState(next);
		saveLocalView(collection, next);
		setSearch(next.filter.search);
	};
	const saveCurrentView = async () => {
		if (!view || !viewName.trim()) return;
		try {
			const existing = views.find((v) => v.name.toLowerCase() === viewName.trim().toLowerCase());
			const res = await grid.saveView({ ...(existing ? { id: existing.id } : {}), collection, name: viewName.trim(), config: toConfig(view) });
			setViews((vs) => [...vs.filter((v) => v.id !== res.id), res]);
			setViewName("");
			notify("success", `View "${res.name}" saved`);
		} catch (e) {
			notify("error", "Could not save the view", errorText(e));
		}
	};
	const deleteView = async (v: SavedView) => {
		try {
			await grid.deleteView(v.id);
			setViews((vs) => vs.filter((x) => x.id !== v.id));
		} catch (e) {
			notify("error", "Could not delete the view", errorText(e));
		}
	};
	const resetLayout = () => {
		const next = reconcileView(null, cols);
		setViewState(next);
		saveLocalView(collection, next);
		setSearch("");
	};

	// ---------------------------------------------------------------------------
	// Selection

	const counting = total === null && (counted > 0 || estimate !== null);
	const count = total ?? counted;
	// While counting, the count found last time ("≈50,030"); the exact number replaces it (2026-10-02).
	const approx = total === null && estimate !== null;
	const countShown = total ?? Math.max(counted, estimate ?? 0);
	const order = rows.map((r) => r.id);
	const nSelected = selectedCount(rowSel, count);
	const allLoadedSelected = rows.length > 0 && rows.every((r) => rowSel.ids.has(r.id));
	const bulkTarget: BulkTarget = rowSel.allMatching ? { filter, count } : { ids: [...rowSel.ids], count: rowSel.ids.size };

	const switchCollection = (slug: string) => {
		if (slug === collection) return;
		if (counts.cells) setPendingCollection(slug);
		else setCollection(slug);
	};

	// ---------------------------------------------------------------------------
	// Render

	if (fatal) {
		return (
			<div className="lynx-root lynx-page">
				<Empty icon={<Database size={40} />} title={fatal.code === "CORE_MISSING" ? "LYNX core is not installed" : "LYNX could not start"} description={fatal.code === "CORE_MISSING" ? "The grid edits content through the LYNX plugin. Install and enable LYNX (the sandboxed plugin) on this site, then reload this page." : fatal.text} />
			</div>
		);
	}

	const collections = site?.collections ?? [];
	const filterCount = view ? activeFilterCount(view.filter) : 0;
	const searching = Boolean(view?.filter.search);

	return (
		<div className="lynx-root lynx-page">
			<header className="lynx-top">
				<div className="lynx-top__title">
					<h1 className="lynx-h1">LYNX Grid</h1>
					{collections.length ? <KSelect label="Collection" value={collection} onChange={switchCollection} options={collections.map((c) => ({ value: c.slug, label: c.label }))} /> : null}
					{total !== null || counting ? (
						<span className="lynx-hint" aria-live="polite">
							{approx ? `≈${countShown.toLocaleString()} entries · counting…` : counting ? `counting… ${count.toLocaleString()}+ entries` : `${count.toLocaleString()} ${count === 1 ? "entry" : "entries"}${filterCount || searching ? " match" : ""}`}
						</span>
					) : null}
				</div>
				<div className="lynx-top__actions">
					{collection ? (
						<Button variant="primary" icon={<Plus />} disabled={counts.cells > 0} title={counts.cells ? "Save or discard your cell edits first" : "A new entry, every field in a side panel"} onClick={() => setPanel("new")}>
							New entry
						</Button>
					) : null}
					<Button variant="secondary" shape="square" icon={<GearSix />} aria-label="Settings" title="Settings" onClick={() => setPanel("settings")} />
					<Button variant="secondary" icon={<ClockCounterClockwise />} onClick={() => setPanel("history")}>
						History
					</Button>
					<DropdownMenu>
						<DropdownMenu.Trigger render={<Button variant="secondary" shape="square" icon={<DotsThreeVertical weight="bold" />} aria-label="More actions" />} />
						<DropdownMenu.Content align="end">
							<DropdownMenu.Item icon={<Database />} onClick={() => setPanel("preset")}>
								Install demo data…
							</DropdownMenu.Item>
							{collection ? (
								<DropdownMenu.Item icon={<Broom />} onClick={() => setDraftCheck((n) => n + 1)}>
									Find empty drafts
								</DropdownMenu.Item>
							) : null}
							<DropdownMenu.Separator />
							{/* A label must sit in a group (Base UI throws otherwise: 2026-10-05, "⋯ crashes the page"). */}
							<DropdownMenu.Group>
								<DropdownMenu.Label>{hasMedia ? "LYNX Media installed: image cells import from a URL." : "LYNX Media not installed: no images by URL."}</DropdownMenu.Label>
							</DropdownMenu.Group>
						</DropdownMenu.Content>
					</DropdownMenu>
				</div>
			</header>

			{draftCheck > 0 && collection ? <EmptyDraftsCleanup key={`${collection}-${draftCheck}`} collection={collection} onDone={refreshAll} /> : null}

			{!collections.length && site ? (
				<Empty
					icon={<Database size={40} />}
					title="No collections yet"
					description="Create a collection in Content types, or install a demo preset to try LYNX."
					contents={
						<Button variant="primary" onClick={() => setPanel("preset")}>
							Install demo data
						</Button>
					}
				/>
			) : null}

			{view && collection ? (
				<>
					<div className="lynx-toolbar" role="toolbar" aria-label="Grid tools">
						<div className="lynx-qsearch">
							<Input size="sm" type="search" aria-label="Quick search" placeholder={`Search ${colByKey.get(titleKey ?? "")?.label.toLowerCase() ?? "title"}…`} value={search} onChange={(e) => setSearch(e.target.value)} />
							<MagnifyingGlass size={14} className="lynx-qsearch__icon" aria-hidden />
						</div>
						<Button variant="secondary" size="sm" icon={<Funnel />} onClick={() => setPanel("filter")}>
							Filter
							{filterCount ? <Badge variant="primary">{filterCount}</Badge> : null}
						</Button>
						{filterCount ? (
							<Button variant="ghost" size="sm" icon={<X />} onClick={() => setView((v) => ({ ...v, filter: { ...emptyFilter(), search: v.filter.search } }))}>
								Clear filter
							</Button>
						) : null}
						{/* As in BEAR (2026-10-05): filter, then bulk-edit every entry that matches, no ticking needed. */}
						<Button
							variant="primary"
							size="sm"
							icon={<PencilSimpleLine />}
							disabled={counts.cells > 0 || count === 0}
							title={counts.cells ? "Save or discard your cell edits first" : nSelected ? "Bulk edit the selected entries" : "Bulk edit every entry that matches the search and the filter"}
							onClick={() => {
								if (!nSelected) {
									autoAll.current = true;
									setRowSel({ ids: new Set(), anchor: null, allMatching: true });
								}
								setPanel("bulk");
							}}
						>
							{nSelected ? `Bulk edit ${nSelected.toLocaleString()} selected` : `Bulk edit ${filterCount || searching ? "" : "all "}${total === null ? "≈" : ""}${countShown.toLocaleString()}${filterCount || searching ? " matching" : ""}`}
						</Button>
						<span className="lynx-grow" />
						<Popover>
							<Popover.Trigger render={<Button variant="secondary" size="sm" icon={<Columns />} />}>
								<span className="lynx-hide-sm">Columns</span>
							</Popover.Trigger>
							<Popover.Content align="end" className="lynx-root lynx-pop">
								<Popover.Title className="lynx-pop__title">Columns</Popover.Title>
								<ColumnsMenu cols={cols} view={view} setView={setView} />
							</Popover.Content>
						</Popover>
						{cols.some((c) => c.format) ? (
							<Popover>
								<Popover.Trigger render={<Button variant="secondary" size="sm" icon={<CurrencyEur />} />}>
									<span className="lynx-hide-sm">Numbers</span>
								</Popover.Trigger>
								<Popover.Content align="end" className="lynx-root lynx-pop">
									<Popover.Title className="lynx-pop__title">Number formats</Popover.Title>
									<FormatsMenu cols={cols} rows={rows} onChange={saveFormat} />
								</Popover.Content>
							</Popover>
						) : null}
						<Popover>
							<Popover.Trigger render={<Button variant="secondary" size="sm" icon={<Star />} />}>
								<span className="lynx-hide-sm">Views</span>
							</Popover.Trigger>
							<Popover.Content align="end" className="lynx-root lynx-pop">
								<Popover.Title className="lynx-pop__title">Saved views</Popover.Title>
								{views.length === 0 ? <p className="lynx-hint">No saved views for this collection.</p> : null}
								<ul className="lynx-menu">
									{views.map((v) => (
										<li key={v.id} className="lynx-menu__row">
											<Popover.Close render={<Button variant="ghost" size="sm" className="lynx-grow lynx-menu__item" onClick={() => applySaved(v)} />}>{v.name}</Popover.Close>
											<IconButton label={`Delete view ${v.name}`} icon={<Trash />} size="xs" onClick={() => void deleteView(v)} />
										</li>
									))}
								</ul>
								<form
									className="lynx-row"
									onSubmit={(e) => {
										e.preventDefault();
										void saveCurrentView();
									}}
								>
									<Input size="sm" placeholder="Name this view" value={viewName} onChange={(e) => setViewName(e.target.value)} aria-label="View name" />
									<Button type="submit" size="sm" variant="secondary" disabled={!viewName.trim()}>
										Save
									</Button>
								</form>
								<Popover.Close render={<Button variant="ghost" size="sm" onClick={resetLayout} />}>Reset layout</Popover.Close>
							</Popover.Content>
						</Popover>
						<Switch label="Compact" size="sm" checked={view.density === "compact"} onCheckedChange={(c) => setView((v) => ({ ...v, density: c ? "compact" : "comfortable" }))} />
					</div>

					{nSelected > 0 ? (
						<div className="lynx-selbar" role="status">
							<span className="lynx-strong">{nSelected.toLocaleString()} selected</span>
							{allLoadedSelected && !rowSel.allMatching && count > rows.length ? (
								<Button variant="ghost" size="sm" onClick={() => setRowSel((s) => ({ ...s, allMatching: true }))}>
									Select all {count.toLocaleString()} matching entries
								</Button>
							) : null}
							{rowSel.allMatching ? <span className="lynx-hint">All entries that match the filter, including other pages.</span> : null}
							<span className="lynx-grow" />
							<Button variant="primary" size="sm" icon={<PencilSimpleLine />} disabled={counts.cells > 0} title={counts.cells ? "Save or discard your cell edits first" : undefined} onClick={() => setPanel("bulk")}>
								Bulk edit
							</Button>
							<Button variant="ghost" size="sm" icon={<X />} onClick={() => setRowSel(emptySelection())}>
								Clear selection
							</Button>
						</div>
					) : null}

					<Pagination
						label="Pages (top)"
						page={page}
						pageSize={view.pageSize}
						total={countShown}
						approx={approx}
						onPage={setPage}
						onPageSize={(n) => {
							setView((v) => ({ ...v, pageSize: n }));
							setPage(0);
						}}
					/>

					{!loading && total === 0 ? (
						<Empty
							icon={<Funnel size={40} />}
							title={filterCount || searching ? "No entries match" : "This collection is empty"}
							description={filterCount || searching ? "Change the search or the filter." : "Create entries in the admin, or install demo data."}
							contents={
								filterCount || searching ? (
									<Button
										variant="secondary"
										onClick={() => {
											setSearch("");
											setView((v) => ({ ...v, filter: emptyFilter() }));
										}}
									>
										Clear search and filter
									</Button>
								) : (
									<Button variant="primary" onClick={() => (window.location.href = `/_emdash/admin/content/${encodeURIComponent(collection)}/new`)}>
										New entry
									</Button>
								)
							}
						/>
					) : mobile ? (
						<Cards
							collection={collection}
							cols={shown}
							rows={rows}
							dirty={dirty}
							failed={failed}
							selection={rowSel}
							editing={editing}
							terms={terms}
							titleKey={titleKey}
							onEdit={setEditing}
							onCommit={commit}
							onToggleRow={(id, shift) => setRowSel((s) => toggleRow(s, order, id, shift))}
							onRichText={(row, col) => (setRichText({ row, col }), setPanel(col.editor === "richtext" ? "richtext" : "gallery"))}
							{...(hasMedia ? { mediaImport: importViaMedia } : {})}
						/>
					) : (
						<Grid
							collection={collection}
							cols={shown}
							rows={rows}
							dirty={dirty}
							failed={failed}
							saved={saved}
							selection={rowSel}
							active={active}
							editing={editing}
							density={view.density}
							sort={view.sort}
							terms={terms}
							loading={loading}
							onActive={setActive}
							onEdit={setEditing}
							onCommit={commit}
							onToggleRow={(id, shift) => setRowSel((s) => toggleRow(s, order, id, shift))}
							onToggleAll={() => setRowSel((s) => (s.allMatching ? emptySelection() : toggleAllLoaded(s, order)))}
							onSort={(key) => setView((v) => ({ ...v, sort: nextSort(v.sort, key) }))}
							onMoveColumn={(key, d) => setView((v) => moveColumn(v, key, d))}
							onResize={(key, w) => setView((v) => resizeColumn(v, key, w))}
							onCopy={onCopy}
							onPaste={onPaste}
							onClear={onClear}
							onSave={() => void save()}
							onRichText={(row, col) => (setRichText({ row, col }), setPanel(col.editor === "richtext" ? "richtext" : "gallery"))}
							onHelp={() => setHelp(true)}
							{...(hasMedia ? { mediaImport: importViaMedia } : {})}
							fieldSettings={{
								open: fieldMenu,
								onOpen: setFieldMenu,
								render: (c) => (indexable(c.info) ? <IndexToggle collection={collection} field={c.info} entries={total ?? null} canManage={canManage} onChanged={reloadFields} /> : null),
							}}
						/>
					)}

					<Pagination label="Pages (bottom)" page={page} pageSize={view.pageSize} total={countShown} approx={approx} onPage={setPage} />

					<p className="lynx-keys lynx-hide-sm">
						<kbd>↑↓←→</kbd> move · <kbd>Enter</kbd> edit · <kbd>Esc</kbd> cancel · <kbd>Space</kbd> select row · <kbd>Ctrl</kbd>+<kbd>C</kbd>/<kbd>V</kbd> copy, paste from a spreadsheet · <kbd>Ctrl</kbd>+<kbd>S</kbd> save ·{" "}
						<Button variant="ghost" size="xs" onClick={() => setHelp(true)}>
							All shortcuts (?)
						</Button>
					</p>
					{/* Author credit, only on the plugin's own admin page (never on the public site). */}
					<p className="lynx-credit">
						LYNX by{" "}
						<a href="https://realmag777.com" target="_blank" rel="noopener noreferrer">
							realmag777.com
						</a>
					</p>
				</>
			) : loading ? (
				<div className="lynx-center">
					<Loader size="lg" />
				</div>
			) : null}

			{counts.cells > 0 || saving ? (
				<div className="lynx-savebar" role="region" aria-label="Unsaved changes">
					{saving ? (
						<div className="lynx-savebar__progress">
							<JobProgress job={saving} />
						</div>
					) : (
						<>
							<span className="lynx-strong">
								{counts.cells} unsaved {counts.cells === 1 ? "change" : "changes"} in {counts.rows} {counts.rows === 1 ? "entry" : "entries"}
							</span>
							{failed.size ? <Badge variant="error">{failed.size} not saved</Badge> : null}
							<span className="lynx-grow" />
							<Button variant="secondary" size="sm" onClick={discard}>
								Discard
							</Button>
							<Button variant="primary" size="sm" icon={<FloppyDisk />} onClick={() => void save()}>
								Save
							</Button>
						</>
					)}
				</div>
			) : null}

			{view ? <FilterPanel open={panel === "filter"} onClose={() => setPanel(null)} fields={fields} taxonomies={(site?.taxonomies ?? []).filter((t) => taxonomies.includes(t.name))} terms={terms} value={view.filter} onApply={(f: FilterState) => setView((v) => ({ ...v, filter: { ...f, search: v.filter.search } }))} /> : null}
			<BulkPanel
				open={panel === "bulk"}
				onClose={() => {
					setPanel(null);
					if (autoAll.current) setRowSel(emptySelection());
					autoAll.current = false;
				}}
collection={collection} revisions={revisions} fields={fields} columns={cols} terms={terms} target={bulkTarget} onChanged={refreshAll} />
			<HistoryPanel open={panel === "history"} onClose={() => setPanel(null)} onChanged={refreshAll} />
			{collection ? <NewEntryPanel open={panel === "new"} onClose={() => setPanel(null)} collection={collection} label={site?.collections.find((c) => c.slug === collection)?.label ?? collection} fields={fields} terms={terms} onCreated={refreshAll} /> : null}
			<SettingsPanel open={panel === "settings"} onClose={() => setPanel(null)} collection={collection} collectionLabel={site?.collections.find((c) => c.slug === collection)?.label ?? collection} fields={fields} entries={total ?? null} canManage={canManage} onChanged={reloadFields} />
			<RichTextPanel
				open={panel === "richtext"}
				onClose={() => setPanel(null)}
				collection={collection}
				revisions={revisions}
				row={richText?.row ?? null}
				col={richText?.col ?? null}
				title={richText && titleKey ? String(richText.row.data[titleKey] ?? richText.row.slug ?? "") : ""}
				onSaved={patchCell}
			/>
			<GalleryPanel
				open={panel === "gallery"}
				onClose={() => setPanel(null)}
				collection={collection}
				revisions={revisions}
				row={richText?.row ?? null}
				col={richText?.col ?? null}
				title={richText && titleKey ? String(richText.row.data[titleKey] ?? richText.row.slug ?? "") : ""}
				onSaved={patchCell}
				{...(hasMedia ? { mediaImport: importViaMedia } : {})}
			/>
			<PresetWizard
				open={panel === "preset"}
				onClose={() => setPanel(null)}
				existing={collections.map((c) => c.slug)}
				onInstalled={(slug) => {
					void loadSite().then(() => {
						setCollection("");
						window.setTimeout(() => setCollection(slug), 0);
					});
				}}
			/>
			<ShortcutsDialog open={help} onClose={() => setHelp(false)} />
			<ConfirmDialog
				open={pendingCollection !== null}
				title="Discard unsaved changes?"
				text={`${counts.cells} unsaved ${counts.cells === 1 ? "change is" : "changes are"} lost when you switch the collection.`}
				confirm="Discard and switch"
				destructive
				onConfirm={() => {
					const next = pendingCollection;
					setPendingCollection(null);
					if (next) setCollection(next);
				}}
				onCancel={() => setPendingCollection(null)}
			/>
		</div>
	);
}

function ColumnsMenu({ cols, view, setView }: { cols: GridColumn[]; view: ViewState; setView: (f: (v: ViewState) => ViewState) => void }) {
	const byKey = new Map(cols.map((c) => [c.key, c]));
	const known = view.order.filter((k) => byKey.has(k));
	const shownAll = known.every((k) => !view.hidden.includes(k));
	return (
		<ul className="lynx-menu lynx-colmenu">
			{/* 2026-10-05: one tick for every column. Pinned columns (the title) stay when all are hidden. */}
			<li className="lynx-menu__row lynx-colmenu__all">
				<span className="lynx-grow">
					<Checkbox
						label="All columns"
						checked={shownAll}
						indeterminate={!shownAll && view.hidden.length < known.length}
						onCheckedChange={() => setView((v) => ({ ...v, hidden: shownAll ? known.filter((k) => !v.pinned.includes(k)) : [] }))}
					/>
				</span>
			</li>
			{view.order.map((k) => {
				const c = byKey.get(k);
				if (!c) return null;
				const visible = !view.hidden.includes(k);
				const pinned = view.pinned.includes(k);
				return (
					<li key={k} className="lynx-menu__row">
						<span className="lynx-grow">
							<Checkbox label={c.label} checked={visible} onCheckedChange={() => setView((v) => toggleHidden(v, k))} />
						</span>
						<IconButton label={`${pinned ? "Unpin" : "Pin"} ${c.label}`} pressed={pinned} size="xs" disabled={!visible} icon={<PushPin weight={pinned ? "fill" : "regular"} />} onClick={() => setView((v) => togglePinned(v, k))} />
					</li>
				);
			})}
			<li className="lynx-menu__note">Drag a header edge to resize; use the arrows on a header to move it.</li>
		</ul>
	);
}

/** Currency symbol and position, and decimals, of the number fields (Columns menu). */
function FormatsMenu({ cols, rows, onChange }: { cols: GridColumn[]; rows: GridRow[]; onChange: (key: string, f: FieldFormat) => void }) {
	const nums = cols.filter((c) => c.format && c.info.editable !== false && !c.key.startsWith("terms:"));
	if (!nums.length) return null;
	// A value from the page, so the sample looks like the column (a year stays 2019).
	const sample = (c: GridColumn) => {
		const v = rows.map((r) => r.data[c.key]).find((x): x is number => typeof x === "number");
		return formatNumber(v ?? (c.type === "integer" ? 19500 : 19500.5), c.type, c.format);
	};
	return (
		<div className="lynx-formats">
			<ul className="lynx-menu">
				{nums.map((c) => {
					const f = c.format ?? {};
					return (
						<li key={c.key} className="lynx-formats__row">
							<span className="lynx-formats__name" title={c.label}>
								{c.label}
							</span>
							<KSelect
								label={`${c.label}: currency`}
								size="xs"
								value={f.currency ?? ""}
								onChange={(v) => onChange(c.key, { ...f, currency: v, position: f.position ?? "before" })}
								options={[{ value: "", label: "No currency" }, ...CURRENCIES.map((x) => ({ value: x, label: x }))]}
							/>
							{f.currency ? (
								<KSelect
									label={`${c.label}: symbol position`}
									size="xs"
									value={f.position ?? "before"}
									onChange={(v) => onChange(c.key, { ...f, position: v === "after" ? "after" : "before" })}
									options={[
										{ value: "before", label: `${f.currency}1` },
										{ value: "after", label: `1 ${f.currency}` },
									]}
								/>
							) : null}
							<KSelect
								label={`${c.label}: decimals`}
								size="xs"
								value={f.decimals === undefined ? "auto" : String(f.decimals)}
								onChange={(v) => {
									const { decimals: _drop, ...rest } = f;
									onChange(c.key, v === "auto" ? rest : { ...rest, decimals: Number(v) });
								}}
								options={[{ value: "auto", label: "As stored" }, ...["0", "1", "2", "3"].map((d) => ({ value: d, label: d === "1" ? "1 decimal" : `${d} decimals` }))]}
							/>
							<span className="lynx-formats__sample" aria-hidden>
								{sample(c)}
							</span>
						</li>
					);
				})}
				<li className="lynx-menu__note">Shown in the table, the cards and the bulk-edit preview, for everyone.</li>
			</ul>
		</div>
	);
}
