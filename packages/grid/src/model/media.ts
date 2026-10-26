// The media library through EmDash's admin REST API, as the signed-in user (the grid writes no
// content here: it uploads files and edits their title and description; putting photos into
// entries is a core job). Listing and search go through the grid's own route (media/search).
//
// EmDash keeps three texts per file: the file name (set at upload), the alt text and the
// caption. The photo panel shows the alt text as the photo's "Title" (filled with the file name
// at upload, so a file can always be found by its name) and the caption as its "Description".

import type { LibraryImage } from "./api.ts";

export interface MediaValue {
	provider: string;
	id: string;
	alt?: string;
	width?: number;
	height?: number;
	mimeType?: string;
	filename?: string;
	meta?: { storageKey?: string };
}

interface MediaItem {
	id: string;
	filename?: string;
	mimeType?: string;
	width?: number;
	height?: number;
	alt?: string | null;
	caption?: string | null;
	storageKey?: string;
}

const HEADERS = { "X-EmDash-Request": "1" };

/** The image value an image field stores, from a media-library item. */
export function toMediaValue(m: MediaItem): MediaValue {
	return {
		provider: "local",
		id: m.id,
		...(m.alt ? { alt: m.alt } : {}),
		...(m.width ? { width: m.width } : {}),
		...(m.height ? { height: m.height } : {}),
		...(m.mimeType ? { mimeType: m.mimeType } : {}),
		...(m.filename ? { filename: m.filename } : {}),
		...(m.storageKey ? { meta: { storageKey: m.storageKey } } : {}),
	};
}

/** The value a field stores for a library image, read in full (the list has no storage key). */
export async function libraryValue(m: Pick<LibraryImage, "id">): Promise<MediaValue> {
	const data = await unwrap<{ item: MediaItem }>(await fetch(`/_emdash/api/media/${encodeURIComponent(m.id)}`, { credentials: "same-origin", headers: HEADERS }));
	return toMediaValue(data.item);
}

async function unwrap<T>(res: Response): Promise<T> {
	const body = (await res.json().catch(() => null)) as { success?: boolean; data?: T; error?: { message?: string } } | null;
	if (!res.ok || !body?.success) throw new Error(body?.error?.message ?? `Media library request failed (${res.status})`);
	return body.data as T;
}

/** "kitchen-01.jpg" -> "kitchen-01": the default title of an uploaded photo. */
export const titleFromFilename = (name: string) => name.replace(/\.[a-z0-9]{2,5}$/i, "");

/** One media item with its title (alt text) and description (caption). */
export async function getMedia(id: string): Promise<{ id: string; filename: string; title: string; description: string; storageKey?: string; width?: number; height?: number; mimeType?: string }> {
	const data = await unwrap<{ item: MediaItem }>(await fetch(`/_emdash/api/media/${encodeURIComponent(id)}`, { credentials: "same-origin", headers: HEADERS }));
	const m = data.item;
	return { id: m.id, filename: m.filename ?? "", title: m.alt ?? "", description: m.caption ?? "", ...(m.storageKey ? { storageKey: m.storageKey } : {}), ...(m.width ? { width: m.width } : {}), ...(m.height ? { height: m.height } : {}), ...(m.mimeType ? { mimeType: m.mimeType } : {}) };
}

/** Change a photo's title and description in the media library (both may be empty). */
export async function updateMedia(id: string, meta: { title: string; description: string }): Promise<void> {
	await unwrap(await fetch(`/_emdash/api/media/${encodeURIComponent(id)}`, { method: "PUT", credentials: "same-origin", headers: { ...HEADERS, "Content-Type": "application/json" }, body: JSON.stringify({ alt: meta.title, caption: meta.description }) }));
}

/** Upload one file from the computer; its title starts as the file name. */
export async function uploadImage(file: File): Promise<MediaValue> {
	const form = new FormData();
	form.append("file", file, file.name);
	const data = await unwrap<{ item: MediaItem }>(await fetch("/_emdash/api/media", { method: "POST", credentials: "same-origin", headers: HEADERS, body: form }));
	const item = data.item;
	if (!item.alt) {
		const title = titleFromFilename(file.name);
		await updateMedia(item.id, { title, description: item.caption ?? "" }).catch(() => undefined);
		item.alt = title;
	}
	return toMediaValue(item);
}
