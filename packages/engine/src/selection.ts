import { EngineError } from "./errors.ts";

// A selection is the frozen list of entry ids a bulk operation targets.
// Writes never re-run a filter (BEAR rule 2). Ids are materialised at find time.

export const SELECTION_TTL_MS = 24 * 60 * 60 * 1000;
export const SELECTION_MAX = 50_000;
/** Ids per stored page record; keeps each storage document small. */
export const SELECTION_PAGE_SIZE = 2_000;

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

export function randomToken(length: number, random: (n: number) => Uint8Array = defaultRandom): string {
	const bytes = random(length);
	let out = "";
	for (let i = 0; i < length; i++) out += ALPHABET[bytes[i]! % ALPHABET.length];
	return out;
}

function defaultRandom(n: number): Uint8Array {
	const a = new Uint8Array(n);
	crypto.getRandomValues(a);
	return a;
}

export function newSelectionId(random?: (n: number) => Uint8Array): string {
	return `sel_${randomToken(16, random)}`;
}

export function newJobKey(random?: (n: number) => Uint8Array): string {
	return `job_${randomToken(16, random)}`;
}

export interface SelectionRecord {
	id: string;
	collection: string;
	count: number;
	pages: number;
	/** Normalised filter as it was run, and a readable summary. */
	filter: unknown;
	summary: string;
	wholeCollection: boolean;
	createdAt: string;
	expiresAt: string;
	userId?: string;
}

export function makeSelection(args: { id: string; collection: string; ids: string[]; filter: unknown; summary: string; wholeCollection: boolean; now?: Date; userId?: string }): { record: SelectionRecord; pages: string[][] } {
	const unique = [...new Set(args.ids)];
	if (unique.length > SELECTION_MAX) {
		throw new EngineError("SELECTION_TOO_LARGE", `The filter matched ${unique.length} entries, above the ${SELECTION_MAX} limit for one selection. Narrow it.`);
	}
	const now = args.now ?? new Date();
	const pages: string[][] = [];
	for (let i = 0; i < unique.length; i += SELECTION_PAGE_SIZE) pages.push(unique.slice(i, i + SELECTION_PAGE_SIZE));
	return {
		record: {
			id: args.id,
			collection: args.collection,
			count: unique.length,
			pages: pages.length,
			filter: args.filter,
			summary: args.summary,
			wholeCollection: args.wholeCollection,
			createdAt: now.toISOString(),
			expiresAt: new Date(now.getTime() + SELECTION_TTL_MS).toISOString(),
			...(args.userId ? { userId: args.userId } : {}),
		},
		pages,
	};
}

export function isExpired(record: Pick<SelectionRecord, "expiresAt">, now = new Date()): boolean {
	return Date.parse(record.expiresAt) <= now.getTime();
}

/** The confirm_count guard: an agent that did not look at the number cannot guess it. */
export function checkConfirmCount(record: Pick<SelectionRecord, "count">, confirmCount: unknown): void {
	const n = typeof confirmCount === "number" ? confirmCount : typeof confirmCount === "string" && /^\d+$/.test(confirmCount) ? Number(confirmCount) : NaN;
	if (n !== record.count) {
		throw new EngineError(
			"CONFIRM_MISMATCH",
			`${Number.isNaN(n) ? "confirm_count was not given" : `confirm_count is ${n}`} but this selection holds ${record.count} entries. Re-read the count and confirm it with the user.`,
		);
	}
}

/** "in 23 hours" style remaining time, for answers read out to a person. */
export function durationWords(ms: number): string {
	const m = Math.max(0, Math.round(ms / 60000));
	if (m < 1) return "less than a minute";
	if (m < 60) return `${m} minute${m === 1 ? "" : "s"}`;
	const h = Math.round(m / 60);
	return `${h} hour${h === 1 ? "" : "s"}`;
}
