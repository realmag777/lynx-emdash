import type { PluginContext } from "emdash";

// The last known counts of a collection (2026-10-02: show "≈50,030" at once, the exact
// number when the count is done). EmDash gives plugins no count, so counting means reading every
// entry; meanwhile the grid shows the number it found last time. One KV document per collection:
// the count of every entry (kept close by the create, trash and restore hooks) and of the filters
// counted most recently. Written after every finished count that differs.

type Kv = NonNullable<PluginContext["kv"]>;

/** How many filtered counts a collection keeps besides the whole collection. */
const MAX_FILTERS = 40;
/** The key of the unfiltered count. */
export const ALL = "{}";

interface CountsDoc {
	/** Filter key -> [count, when it was counted (ms)]. */
	n: Record<string, [number, number]>;
}

const docKey = (collection: string) => `counts:${collection}`;

/** A short key for a filter (its JSON, hashed when long). */
export function filterKey(filter: unknown): string {
	const json = JSON.stringify(filter ?? {});
	if (json.length <= 64) return json;
	let h = 0x811c9dc5;
	for (let i = 0; i < json.length; i++) h = Math.imul(h ^ json.charCodeAt(i), 0x01000193);
	return `#${(h >>> 0).toString(36)}:${json.length}`;
}

export async function lastCount(kv: Kv | undefined, collection: string, key: string): Promise<number | null> {
	if (!kv) return null;
	try {
		const doc = await kv.get<CountsDoc>(docKey(collection));
		const v = doc?.n?.[key]?.[0];
		return typeof v === "number" && v >= 0 ? v : null;
	} catch {
		return null;
	}
}

/** Changes the document with a compare-and-set, a few tries (hooks of a bulk job run at once). */
async function change(kv: Kv, collection: string, fn: (doc: CountsDoc) => boolean): Promise<void> {
	for (let i = 0; i < 6; i++) {
		const cur = await kv.getVersioned<CountsDoc>(docKey(collection));
		const doc: CountsDoc = cur?.value && typeof cur.value === "object" && cur.value.n ? { n: { ...cur.value.n } } : { n: {} };
		if (!fn(doc)) return;
		const res = await kv.compareAndSet(docKey(collection), cur?.revision ?? null, doc);
		if (res.applied) return;
	}
}

/** After a finished count. */
export async function rememberCount(kv: Kv | undefined, collection: string, key: string, count: number): Promise<void> {
	if (!kv) return;
	try {
		await change(kv, collection, (doc) => {
			if (doc.n[key]?.[0] === count) return false;
			doc.n[key] = [count, Date.now()];
			const keys = Object.keys(doc.n).filter((k) => k !== ALL);
			if (keys.length > MAX_FILTERS) for (const k of keys.sort((a, b) => doc.n[a]![1] - doc.n[b]![1]).slice(0, keys.length - MAX_FILTERS)) delete doc.n[k];
			return true;
		});
	} catch {
		// A count is only a hint: never fail a read over it.
	}
}

/** From the content hooks: an entry was created (+1), trashed (-1) or restored (+1). */
export async function shiftCount(kv: Kv | undefined, collection: string, delta: number): Promise<void> {
	if (!kv || !delta) return;
	try {
		await change(kv, collection, (doc) => {
			const cur = doc.n[ALL];
			if (!cur) return false;
			doc.n[ALL] = [Math.max(0, cur[0] + delta), cur[1]];
			return true;
		});
	} catch {
		// See rememberCount.
	}
}
