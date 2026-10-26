// Field indexes, through EmDash's own schema API as the signed-in user (2026-10-01: sorting
// by a field without an index reads every entry first; on 10,000 cars that takes seconds). The
// core cannot do this: sandboxed plugins may not change the schema. EmDash creates or drops the
// database index itself; only administrators (schema:manage) may.

import type { FieldInfo } from "./api.ts";
export { indexable } from "./columns.ts";

const HEADERS = { "X-EmDash-Request": "1" };

/** The core marks indexed fields as filtered in the database ("host"). */
export function isIndexed(f: FieldInfo): boolean {
	return f.filter === "host";
}

/** EmDash role of the signed-in user (50 = administrator), or null when unknown. */
export async function currentRole(): Promise<number | null> {
	try {
		const res = await fetch("/_emdash/api/auth/me", { credentials: "same-origin", headers: HEADERS });
		const body = (await res.json()) as { data?: { role?: number } };
		return typeof body.data?.role === "number" ? body.data.role : null;
	} catch {
		return null;
	}
}
export const ADMIN_ROLE = 50;

/** Create (on) or drop (off) the database index of one field. */
export async function setIndexed(collection: string, field: string, on: boolean): Promise<void> {
	const res = await fetch(`/_emdash/api/schema/collections/${encodeURIComponent(collection)}/fields/${encodeURIComponent(field)}`, {
		method: "PUT",
		credentials: "same-origin",
		headers: { ...HEADERS, "Content-Type": "application/json" },
		body: JSON.stringify({ indexed: on }),
	});
	if (res.ok) return;
	const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
	if (res.status === 403) throw new Error("Only administrators can change field indexes.");
	throw new Error(body?.error?.message ?? `EmDash did not change the index (${res.status}).`);
}
