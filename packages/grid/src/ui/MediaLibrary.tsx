import { Button, Input, InputArea } from "@cloudflare/kumo";
import { CaretLeft, CaretRight, MagnifyingGlass, Plus } from "@phosphor-icons/react";
import * as React from "react";

import type { LibraryImage } from "../model/api.ts";
import { getMedia, libraryValue, updateMedia, type MediaValue } from "../model/media.ts";
import { errorText, useGridApi, useNotify } from "./context.tsx";
import { KSelect } from "./kit.tsx";

// The media library inside the photo panel (2026-10-01): search by title, description or
// file name, numbered pages with a page size, and a details card per photo where its title and
// description are set. "+" on a photo, or the button in the card, puts it into the field; photos
// already in the field are not listed (the author: a photo goes into a gallery once).

const PER_PAGE = [12, 24, 48, 96];

/** Page buttons: first, last, the current one and its neighbours, gaps as "…". */
export function pageList(page: number, pages: number): Array<number | "gap"> {
	const want = new Set([1, pages, page - 1, page, page + 1].filter((n) => n >= 1 && n <= pages));
	const out: Array<number | "gap"> = [];
	let last = 0;
	for (const n of [...want].sort((a, b) => a - b)) {
		if (n - last > 1) out.push("gap");
		out.push(n);
		last = n;
	}
	return out;
}

export function MediaLibrary(props: { inField: Set<string>; single: boolean; onAdd: (v: MediaValue) => void; refresh: number; focus: string | null; onFocusDone: () => void }) {
	const grid = useGridApi();
	const [q, setQ] = React.useState("");
	const [query, setQuery] = React.useState("");
	const [page, setPage] = React.useState(1);
	const [perPage, setPerPage] = React.useState(24);
	const [data, setData] = React.useState<{ total: number; inField?: number; pages: number; items: LibraryImage[] } | null>(null);
	const [loading, setLoading] = React.useState(false);
	const [problem, setProblem] = React.useState<string | null>(null);
	const [selected, setSelected] = React.useState<string | null>(null);
	const [fresh, setFresh] = React.useState(0);
	const notify = useNotify();
	const add = (m: LibraryImage) =>
		libraryValue(m)
			.then(props.onAdd)
			.catch((e) => notify("error", errorText(e)));

	// Search as you type, a moment after the last key.
	React.useEffect(() => {
		const t = window.setTimeout(() => {
			setQuery(q.trim());
			setPage(1);
		}, 300);
		return () => window.clearTimeout(t);
	}, [q]);

	// Photos already in the field are not offered (a photo goes in once); a removed one comes back.
	const exclude = [...props.inField].sort().join(",");
	const asked = React.useRef(0);
	React.useEffect(() => {
		const n = ++asked.current;
		setLoading(true);
		grid.mediaSearch({ q: query, page, per_page: perPage, fresh: fresh > 0 || props.refresh > 0, exclude: exclude ? exclude.split(",") : [] })
			.then((r) => {
				if (n !== asked.current) return;
				setData(r);
				if (r.page !== page) setPage(r.page);
				setProblem(null);
			})
			.catch((e) => n === asked.current && setProblem(errorText(e)))
			.finally(() => n === asked.current && setLoading(false));
	}, [grid, query, page, perPage, fresh, props.refresh, exclude]);

	// A photo of the field clicked above: show its card here.
	React.useEffect(() => {
		if (props.focus) {
			setSelected(props.focus);
			props.onFocusDone();
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [props.focus]);

	return (
		<div className="lynx-library">
			<div className="lynx-library__bar">
				<label className="lynx-search lynx-search--sm lynx-library__search">
					<MagnifyingGlass size={14} aria-hidden />
					<input type="search" placeholder="Search by title, description or file name" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search the media library" />
				</label>
				<KSelect
					label="Photos per page"
					size="xs"
					value={String(perPage)}
					onChange={(v) => {
						setPerPage(Number(v));
						setPage(1);
					}}
					options={PER_PAGE.map((n) => ({ value: String(n), label: `${n} per page` }))}
				/>
				<span className="lynx-hint">{data ? `${data.total.toLocaleString()} ${data.total === 1 ? "photo" : "photos"}` : loading ? "Loading…" : ""}</span>
			</div>
			{problem ? <p className="lynx-text-danger">{problem}</p> : null}
			{data && data.items.length === 0 && !loading ? <p className="lynx-hint">{query ? "Nothing else matches the search." : "The media library has no images yet."}</p> : null}
			{/* A photo goes in once, so photos the field holds are not offered: say so, or a fresh upload looks lost. */}
			{data?.inField ? <p className="lynx-hint">{`${data.inField} ${query ? "more matching " : ""}${data.inField === 1 ? "photo is" : "photos are"} already in this gallery (above), so not offered again.`}</p> : null}
			<ul className={`lynx-library__grid ${loading ? "is-loading" : ""}`}>
				{(data?.items ?? []).map((m) => {
					return (
						<li key={m.id} className={`lynx-library__tile ${selected === m.id ? "is-selected" : ""}`}>
							<button type="button" className="lynx-library__pick" title={m.title || m.filename} aria-label={`Show details: ${m.title || m.filename}`} aria-pressed={selected === m.id} onClick={() => setSelected(selected === m.id ? null : m.id)}>
								<img src={m.url} alt="" loading="lazy" />
							</button>
							<button type="button" className="lynx-library__add" aria-label={`${props.single ? "Use" : "Add"} ${m.title || m.filename}`} title={props.single ? "Use this photo" : "Add to the gallery"} onClick={() => void add(m)}>
								<Plus size={14} weight="bold" />
							</button>
							<span className="lynx-library__name">{m.title || m.filename}</span>
						</li>
					);
				})}
			</ul>
			{data && data.pages > 1 ? (
				<nav className="lynx-library__pages" aria-label="Media library pages">
					<button type="button" className="lynx-icon-btn" aria-label="Previous page" disabled={page <= 1} onClick={() => setPage(page - 1)}>
						<CaretLeft size={14} />
					</button>
					{pageList(page, data.pages).map((n, i) =>
						n === "gap" ? (
							<span key={`g${i}`} className="lynx-hint">
								…
							</span>
						) : (
							<button key={n} type="button" className={`lynx-library__page ${n === page ? "is-current" : ""}`} aria-current={n === page ? "page" : undefined} onClick={() => setPage(n)}>
								{n}
							</button>
						),
					)}
					<button type="button" className="lynx-icon-btn" aria-label="Next page" disabled={page >= data.pages} onClick={() => setPage(page + 1)}>
						<CaretRight size={14} />
					</button>
				</nav>
			) : null}
			{selected ? (
				<MediaDetails
					key={selected}
					id={selected}
					single={props.single}
					inField={props.inField.has(selected)}
					onAdd={props.onAdd}
					onSaved={() => setFresh((f) => f + 1)}
					onClose={() => setSelected(null)}
				/>
			) : null}
		</div>
	);
}

/** One photo: preview, file name, editable title and description, add to the field. */
function MediaDetails(props: { id: string; single: boolean; inField: boolean; onAdd: (v: MediaValue) => void; onSaved: () => void; onClose: () => void }) {
	const notify = useNotify();
	const [item, setItem] = React.useState<Awaited<ReturnType<typeof getMedia>> | null>(null);
	const [title, setTitle] = React.useState("");
	const [description, setDescription] = React.useState("");
	const [busy, setBusy] = React.useState(false);
	const [problem, setProblem] = React.useState<string | null>(null);
	React.useEffect(() => {
		let stale = false;
		getMedia(props.id)
			.then((m) => {
				if (stale) return;
				setItem(m);
				setTitle(m.title);
				setDescription(m.description);
			})
			.catch((e) => !stale && setProblem(errorText(e)));
		return () => {
			stale = true;
		};
	}, [props.id]);
	const changed = item !== null && (title !== item.title || description !== item.description);
	const value = (): MediaValue => ({ provider: "local", id: props.id, ...(title ? { alt: title } : {}), ...(item?.width ? { width: item.width } : {}), ...(item?.height ? { height: item.height } : {}), ...(item?.mimeType ? { mimeType: item.mimeType } : {}), ...(item?.filename ? { filename: item.filename } : {}), ...(item?.storageKey ? { meta: { storageKey: item.storageKey } } : {}) });
	const save = async () => {
		setBusy(true);
		setProblem(null);
		try {
			await updateMedia(props.id, { title, description });
			setItem((m) => (m ? { ...m, title, description } : m));
			notify("success", "Photo details saved");
			props.onSaved();
		} catch (e) {
			setProblem(errorText(e));
		} finally {
			setBusy(false);
		}
	};
	return (
		<section className="lynx-mediacard" aria-label="Photo details">
			{item?.storageKey ? <img className="lynx-mediacard__img" src={`/_emdash/api/media/file/${encodeURIComponent(item.storageKey)}`} alt="" /> : <div className="lynx-mediacard__img" />}
			<div className="lynx-mediacard__form">
				<div className="lynx-hint">File: {item?.filename ?? "…"}</div>
				<label className="lynx-mediacard__field">
					<span>Title</span>
					<Input size="sm" value={title} placeholder="No title" onChange={(e) => setTitle(e.target.value)} aria-label="Title" />
				</label>
				<label className="lynx-mediacard__field">
					<span>Description</span>
					<InputArea rows={3} value={description} placeholder="No description" onChange={(e) => setDescription(e.target.value)} aria-label="Description" />
				</label>
				{problem ? <p className="lynx-text-danger">{problem}</p> : null}
				<div className="lynx-mediacard__actions">
					<Button size="sm" variant="secondary" loading={busy} disabled={!changed} onClick={() => void save()}>
						Save title and description
					</Button>
					{props.inField ? (
						<span className="lynx-hint">{props.single ? "This is the photo of the field" : "Already in this gallery"}</span>
					) : (
						<Button size="sm" variant="primary" icon={<Plus />} disabled={!item} onClick={() => props.onAdd(value())}>
							{props.single ? "Use this photo" : "Add to the gallery"}
						</Button>
					)}
					<Button size="sm" variant="ghost" onClick={props.onClose}>
						Close
					</Button>
				</div>
			</div>
		</section>
	);
}
