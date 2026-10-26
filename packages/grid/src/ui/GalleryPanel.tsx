import { Banner, Button, Input } from "@cloudflare/kumo";
import { ArrowLeft, ArrowRight, Images, Plus, Trash, UploadSimple } from "@phosphor-icons/react";
import * as React from "react";

import type { GridRow } from "../model/api.ts";
import type { GridColumn } from "../model/columns.ts";
import { cellValue } from "../model/edits.ts";
import { uploadImage, type MediaValue } from "../model/media.ts";
import { mediaUrl } from "./cells.tsx";
import { errorText, useApi, useNotify } from "./context.tsx";
import { MediaLibrary } from "./MediaLibrary.tsx";
import { SlidePanel } from "./SlidePanel.tsx";

// Photos of one cell in a side panel (2026-10-01): a gallery (repeater of one image
// sub-field) or a single image field such as the cover. Add from the computer, the media library
// or a web address (LYNX Media), remove, reorder by dragging or with the arrows; Save writes the
// whole list in one core update_entry job, so it is in the history and can be rolled back.

export function GalleryPanel(props: {
	open: boolean;
	onClose: () => void;
	collection: string;
	revisions: boolean;
	row: GridRow | null;
	col: GridColumn | null;
	title: string;
	/** The saved value, so the page redraws only this cell (no reload, no scroll jump). */
	onSaved: (value: unknown, mode: "draft" | "publish") => void;
	mediaImport?: (url: string) => Promise<unknown>;
}) {
	const api = useApi();
	const notify = useNotify();
	const { row, col } = props;
	const single = col?.type === "image";
	const itemKey = col?.gallery ?? "image";
	const [items, setItems] = React.useState<MediaValue[]>([]);
	const [changed, setChanged] = React.useState(false);
	// Saved straight into the entry (the status is its own column).
	const mode = "publish" as const;
	const [busy, setBusy] = React.useState(false);
	const [adding, setAdding] = React.useState<string | null>(null);
	const [problem, setProblem] = React.useState<string | null>(null);
	// The media library section: shown or not, a counter that asks it for a fresh list after
	// uploads, and the photo whose details card it should open (a photo of the field clicked).
	const [library, setLibrary] = React.useState(false);
	const [uploads, setUploads] = React.useState(0);
	const [focus, setFocus] = React.useState<string | null>(null);
	const [url, setUrl] = React.useState("");
	const [drag, setDrag] = React.useState<number | null>(null);
	const fileInput = React.useRef<HTMLInputElement>(null);

	React.useEffect(() => {
		if (!props.open || !row || !col) return;
		const v = cellValue(row, col.key);
		const list = single ? (v && typeof v === "object" ? [v as MediaValue] : []) : Array.isArray(v) ? (v as Array<Record<string, unknown>>).map((x) => x?.[itemKey] as MediaValue).filter((x) => x && typeof x === "object") : [];
		setItems(list);
		setChanged(false);
		setProblem(null);
		setLibrary(false);
		setFocus(null);
		setUrl("");
	}, [props.open, row, col, props.revisions, single, itemKey]);

	const update = (next: MediaValue[]) => {
		setItems(single ? next.slice(-1) : next);
		setChanged(true);
	};
	// A photo goes into the field once (2026-10-01): the library hides the ones already in.
	const add = (v: MediaValue) => {
		if (!single && items.some((m) => m.id === v.id)) return;
		update(single ? [v] : [...items, v]);
	};
	const move = (from: number, to: number) => {
		if (to < 0 || to >= items.length || from === to) return;
		const next = [...items];
		const [x] = next.splice(from, 1);
		next.splice(to, 0, x!);
		update(next);
	};

	const upload = async (files: FileList | null) => {
		if (!files?.length) return;
		setProblem(null);
		const list = Array.from(files).filter((f) => f.type.startsWith("image/"));
		const got: MediaValue[] = [];
		try {
			for (const [i, f] of list.entries()) {
				setAdding(`Uploading ${i + 1} of ${list.length}…`);
				got.push(await uploadImage(f));
			}
		} catch (e) {
			setProblem(errorText(e));
		} finally {
			setAdding(null);
			if (got.length) {
				update(single ? got.slice(-1) : [...items, ...got]);
				setUploads((n) => n + 1);
			}
			if (fileInput.current) fileInput.current.value = "";
		}
	};

	const importUrl = async () => {
		if (!props.mediaImport || !url.trim()) return;
		setAdding("Importing…");
		setProblem(null);
		try {
			add((await props.mediaImport(url.trim())) as MediaValue);
			setUrl("");
		} catch (e) {
			setProblem(errorText(e));
		} finally {
			setAdding(null);
		}
	};

	const save = async () => {
		if (!row || !col) return;
		setBusy(true);
		setProblem(null);
		try {
			const value = single ? (items[0] ?? null) : items.map((m) => ({ [itemKey]: m }));
			const empty = value === null || (Array.isArray(value) && value.length === 0);
			const op = empty ? { field: col.key, behavior: "clear" as const } : { field: col.key, behavior: "set" as const, value };
			const first = await api.update(props.collection, row.id, [op], mode);
			const end = await api.drive(first);
			if (end.result && (end.result.failed || end.result.invalid || end.result.held || end.result.conflicts)) {
				const detail = await api.historyJob(end.job_key);
				const why = detail.left_alone[0];
				throw new Error(why?.problems?.[0]?.message ?? why?.message ?? `Not saved (${why?.why ?? "unknown reason"}).`);
			}
			notify("success", `${col.label} saved`);
			props.onSaved(empty ? (single ? null : []) : value, mode);
			props.onClose();
		} catch (e) {
			setProblem(errorText(e));
		} finally {
			setBusy(false);
		}
	};

	const inList = new Set(items.map((m) => m.id));
	// Copies of one photo (added twice before this rule): one click keeps the first of each.
	const copies = items.length - inList.size;
	const dedupe = () => update(items.filter((m, i) => items.findIndex((x) => x.id === m.id) === i));

	return (
		<SlidePanel
			open={props.open}
			onClose={props.onClose}
			title={col ? col.label : "Photos"}
			subtitle={props.title}
			footer={
				<>
					<span className="lynx-grow" />
					<Button variant="secondary" onClick={props.onClose}>
						Cancel
					</Button>
					<Button variant="primary" loading={busy} disabled={!changed || Boolean(adding)} onClick={() => void save()}>
						Save
					</Button>
				</>
			}
		>
			{problem ? <Banner variant="error" description={problem} /> : null}
			<section className="lynx-section">
				<h3 className="lynx-h3">{single ? "Photo" : `Photos (${items.length})`}</h3>
				{items.length ? (
					<ol className="lynx-gallery" aria-label={single ? "Photo" : "Photos in order"}>
						{items.map((m, i) => (
							<li
								key={`${m.id}-${i}`}
								className={`lynx-gallery__item ${drag === i ? "is-dragging" : ""}`}
								draggable={!single}
								onDragStart={(e) => {
									setDrag(i);
									e.dataTransfer.effectAllowed = "move";
								}}
								onDragOver={(e) => {
									if (drag === null) return;
									e.preventDefault();
								}}
								onDrop={(e) => {
									e.preventDefault();
									if (drag !== null) move(drag, i);
									setDrag(null);
								}}
								onDragEnd={() => setDrag(null)}
							>
								<button
									type="button"
									className="lynx-gallery__open"
									title="Title and description of this photo"
									aria-label={`Details of photo ${i + 1}`}
									onClick={() => {
										setLibrary(true);
										setFocus(m.id);
									}}
								>
									{mediaUrl(m) ? <img src={mediaUrl(m)!} alt={m.alt ?? ""} /> : <span className="lynx-hint">{m.filename ?? m.id}</span>}
								</button>
								{!single ? <span className="lynx-gallery__n">{i + 1}</span> : null}
								<span className="lynx-gallery__tools">
									{!single ? (
										<>
											<button type="button" className="lynx-icon-btn lynx-icon-btn--xs" aria-label={`Move photo ${i + 1} left`} disabled={i === 0} onClick={() => move(i, i - 1)}>
												<ArrowLeft size={14} />
											</button>
											<button type="button" className="lynx-icon-btn lynx-icon-btn--xs" aria-label={`Move photo ${i + 1} right`} disabled={i === items.length - 1} onClick={() => move(i, i + 1)}>
												<ArrowRight size={14} />
											</button>
										</>
									) : null}
									<button type="button" className="lynx-icon-btn lynx-icon-btn--xs" aria-label={`Remove photo ${i + 1}`} onClick={() => update(items.filter((_, k) => k !== i))}>
										<Trash size={14} />
									</button>
								</span>
							</li>
						))}
					</ol>
				) : (
					<p className="lynx-hint">{single ? "No photo yet." : "No photos yet."} Add some below.</p>
				)}
				{!single && copies > 0 ? (
					<div className="lynx-gallery__copies" role="status">
						<span>
							{copies} {copies === 1 ? "photo is" : "photos are"} in the gallery twice.
						</span>
						<button type="button" className="lynx-btn lynx-btn--sm" onClick={dedupe}>
							Remove duplicates
						</button>
					</div>
				) : null}
				{!single && items.length > 1 ? <p className="lynx-hint lynx-gallery__hint">Drag a photo to another place, or use the arrows. The first photo comes first on the site.</p> : null}
			</section>

			<section className="lynx-section">
				<h3 className="lynx-h3">{single ? "Replace" : "Add photos"}</h3>
				<div className="lynx-gallery__add">
					<input ref={fileInput} type="file" accept="image/*" multiple={!single} hidden onChange={(e) => void upload(e.target.files)} />
					<Button variant="secondary" icon={<UploadSimple />} disabled={Boolean(adding)} onClick={() => fileInput.current?.click()}>
						From the computer
					</Button>
					<Button variant="secondary" icon={<Images />} disabled={Boolean(adding)} onClick={() => setLibrary((v) => !v)}>
						{library ? "Hide the media library" : "From the media library"}
					</Button>
					{adding ? <span className="lynx-hint">{adding}</span> : null}
				</div>
				{props.mediaImport ? (
					<div className="lynx-gallery__url">
						<Input size="sm" aria-label="Image address" placeholder="https://… image address" value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void importUrl()} />
						<Button size="sm" variant="secondary" icon={<Plus />} disabled={!url.trim() || Boolean(adding)} onClick={() => void importUrl()}>
							Add by address
						</Button>
					</div>
				) : null}
				{library ? <MediaLibrary inField={inList} single={single} onAdd={add} refresh={uploads} focus={focus} onFocusDone={() => setFocus(null)} /> : null}
			</section>
		</SlidePanel>
	);
}
