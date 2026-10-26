import type { PluginContext } from "emdash";

import { GridReadError } from "./read.ts";

// The media library for the grid's photo panel (2026-10-01): search by title (alt text),
// description (caption) and file name, numbered pages, page size. EmDash lists media only by
// cursor and searches file names only, so the grid reads the image list itself (in-process, a
// few calls of 100) and keeps it for a short while; uploads and edits ask for a fresh list.

export interface LibraryImage {
	id: string;
	filename: string;
	title: string;
	description: string;
	width?: number;
	height?: number;
	mimeType: string;
	/** Preview address; plugins get no storage key, the field value is read by id (getMedia). */
	url: string;
	createdAt: string;
}

type HostMedia = { id: string; filename: string; mimeType: string; url: string; createdAt: string; width?: number | null; height?: number | null; alt?: string | null; caption?: string | null };

const KEEP_MS = 30_000;
let cache: { at: number; items: LibraryImage[] } | null = null;

async function allImages(ctx: PluginContext, fresh: boolean): Promise<LibraryImage[]> {
	if (!fresh && cache && Date.now() - cache.at < KEEP_MS) return cache.items;
	const media = ctx.media;
	if (!media) throw new GridReadError("FORBIDDEN", "LYNX Grid was installed without media access.");
	const items: LibraryImage[] = [];
	let cursor: string | undefined;
	for (let guard = 0; guard < 500; guard++) {
		const page = (await media.list({ limit: 100, mimeType: "image/", ...(cursor ? { cursor } : {}) })) as { items: HostMedia[]; cursor?: string; hasMore: boolean };
		for (const m of page.items) {
			items.push({
				id: m.id,
				filename: m.filename,
				title: m.alt ?? "",
				description: m.caption ?? "",
				...(m.width ? { width: m.width } : {}),
				...(m.height ? { height: m.height } : {}),
				mimeType: m.mimeType,
				url: m.url,
				createdAt: m.createdAt,
			});
		}
		if (!page.hasMore || !page.cursor) break;
		cursor = page.cursor;
	}
	items.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
	cache = { at: Date.now(), items };
	return items;
}

/** One page of images whose title, description or file name contain every word of q (minus exclude). */
export async function searchLibrary(ctx: PluginContext, input: { q?: string; page?: number; perPage?: number; fresh?: boolean; exclude?: string[] }) {
	// Photos already in the field are left out, so pages and counts stay right.
	const out = new Set(input.exclude ?? []);
	const words = (input.q ?? "").toLowerCase().split(/\s+/).filter(Boolean);
	const matches = (await allImages(ctx, input.fresh === true)).filter((m) => !words.length || words.every((w) => `${m.title} ${m.description} ${m.filename}`.toLowerCase().includes(w)));
	const hits = matches.filter((m) => !out.has(m.id));
	// Matches left out because the field holds them already (2026-10-05: "just uploaded, not found").
	const inField = matches.length - hits.length;
	const perPage = [12, 24, 48, 96].includes(input.perPage ?? 0) ? input.perPage! : 24;
	const pages = Math.max(1, Math.ceil(hits.length / perPage));
	const page = Math.min(Math.max(1, Math.floor(input.page ?? 1)), pages);
	return { total: hits.length, inField, page, pages, perPage, items: hits.slice((page - 1) * perPage, page * perPage) };
}
