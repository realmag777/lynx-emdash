import type { PluginContext, SandboxedRouteContext } from "emdash/plugin";

// LYNX Media: images by URL into the media library. A separate plugin so that the LYNX core
// needs no network access (2026-09-29). It only makes media library values; putting them
// into entries is the core's job (create_entries, update_entry, apply_bulk), with the core's
// history and rollback.

/** Images per call: at most 20 are accepted, and in the sandbox 3 are done per call (2 host calls each). */
export const MAX_IMAGES = 20;
/** The size the tool description promises (8 MB per image). */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const SAFE_PER_CALL = 3;

export interface ImageSpec {
	url: string;
	alt?: string;
	filename?: string;
}

const EXTENSIONS: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "image/avif": "avif", "image/svg+xml": "svg" };

function fileName(item: ImageSpec, mime: string): string {
	const ext = EXTENSIONS[mime] ?? mime.split("/")[1] ?? "bin";
	const given = item.filename ?? decodeURIComponent(new URL(item.url).pathname.split("/").pop() ?? "");
	const base = given.replace(/\.[a-z0-9]+$/i, "").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "image";
	return `${base}.${ext}`;
}

/** True where no subrequest limit applies (in-process, or the Node.js runner with nodejs_compat). */
function unlimitedHost(): boolean {
	return Boolean((globalThis as { process?: { versions?: { node?: string } } }).process?.versions?.node);
}

class BadInput extends Error {}

function parseImages(input: unknown): ImageSpec[] {
	const raw = (input as { images?: unknown } | null)?.images;
	if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_IMAGES) {
		throw new BadInput(`images takes a list of 1 to ${MAX_IMAGES} objects {"url": "https://…", "alt": "…"}. Nothing was done.`);
	}
	const problems: string[] = [];
	const items: ImageSpec[] = [];
	raw.forEach((x, i) => {
		const it: Record<string, unknown> = x && typeof x === "object" ? (x as Record<string, unknown>) : { url: x };
		const url = typeof it.url === "string" ? it.url.trim() : "";
		let ok = false;
		try {
			ok = ["http:", "https:"].includes(new URL(url).protocol);
		} catch {
			ok = false;
		}
		if (!ok) problems.push(`#${i + 1}: url must be an http(s) address, not ${JSON.stringify(it.url ?? null)}`);
		else if (items.some((y) => y.url === url)) problems.push(`#${i + 1}: ${url} is listed twice`);
		else items.push({ url, ...(typeof it.alt === "string" && it.alt ? { alt: it.alt.slice(0, 500) } : {}), ...(typeof it.filename === "string" && it.filename ? { filename: it.filename.slice(0, 120) } : {}) });
	});
	if (problems.length) throw new BadInput(`Nothing was imported. ${problems.join(" ")}`);
	return items;
}

/**
 * Fetch each URL, check it is an image, upload it, and return the value an image field takes
 * (the shape the LYNX preset installer uses). What does not fit this call comes back in remaining.
 */
export async function importImages(r: SandboxedRouteContext, ctx: PluginContext): Promise<unknown> {
	let items: ImageSpec[];
	try {
		items = parseImages(r.input);
	} catch (err) {
		if (err instanceof BadInput) return { ok: false, code: "BAD_ARGUMENT", message: `LYNX Media error [BAD_ARGUMENT]: ${err.message}` };
		throw err;
	}
	const perCall = unlimitedHost() ? MAX_IMAGES : SAFE_PER_CALL;
	const now = items.slice(0, perCall);
	const remaining = items.slice(perCall);
	const imported: Array<{ url: string; value: Record<string, unknown> }> = [];
	const failed: Array<{ url: string; message: string }> = [];
	const media = ctx.media as { upload?: (f: string, t: string, b: ArrayBuffer) => Promise<{ mediaId: string; storageKey: string }> } | undefined;
	for (const item of now) {
		try {
			if (!ctx.http || !media?.upload) throw new Error("LYNX Media was installed without network or media access, so it cannot import files.");
			const res = await ctx.http.fetch(item.url);
			if (!res.ok) throw new Error(`The address answered ${res.status}; nothing was imported.`);
			const mime = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
			if (!mime.startsWith("image/")) throw new Error(`The address returns ${mime || "an unknown type"}, not an image.`);
			const declared = Number(res.headers.get("content-length") ?? 0);
			if (declared > MAX_IMAGE_BYTES) throw new Error(`The image is ${Math.round(declared / 1048576)} MB; the limit is 8 MB.`);
			const bytes = await res.arrayBuffer();
			if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error(`The image is ${Math.round(bytes.byteLength / 1048576)} MB; the limit is 8 MB.`);
			const filename = fileName(item, mime);
			const up = await media.upload(filename, mime, bytes);
			imported.push({ url: item.url, value: { provider: "local", id: up.mediaId, ...(item.alt ? { alt: item.alt } : {}), mimeType: mime, filename, meta: { storageKey: up.storageKey } } });
		} catch (err) {
			failed.push({ url: item.url, message: err instanceof Error ? err.message : String(err) });
		}
	}
	const next = remaining.length ? ` ${remaining.length} image${remaining.length === 1 ? " was" : "s were"} not done in this call: call import_media again with remaining, straight away.` : "";
	return {
		imported,
		failed,
		remaining,
		note: `${imported.length} imported${failed.length ? `, ${failed.length} failed - say so` : ""}.${next} Put each value into an image field through LYNX: lynx__create_entries rows, or lynx__update_entry / lynx__apply_bulk with {"field":"cover","behavior":"set","value":<value>}; a gallery takes [{"image":<value>}, ...]. LYNX records those writes in its history.`,
	};
}
