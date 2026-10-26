// Page buttons, ported from Botoscope's lib/pagination.js (window algorithm): up to 10 pages
// all numbers are shown; above that the first 3, a window around the current page and the
// last 3, with "…" between. Pages are 0-based inside, shown 1-based.
//
// Fixed in the port: Botoscope drops the last page when the current page is 2-3 pages before
// the end (the window stops at current + 1 and the tail block is skipped), so page 12 of 12 was
// unreachable from page 10.

export type PageItem = { type: "prev" | "next"; page: number | null } | { type: "page"; page: number; current: boolean } | { type: "dots"; key: string };

export function pageItems(current: number, pages: number): PageItem[] {
	if (pages <= 1) return [];
	const items: PageItem[] = [{ type: "prev", page: current > 0 ? current - 1 : null }];
	const push = (p: number) => items.push({ type: "page", page: p, current: p === current });
	if (pages <= 10) {
		for (let p = 0; p < pages; p++) push(p);
	} else {
		const shown = new Set<number>();
		for (let p = 0; p < 3; p++) shown.add(p);
		for (let p = Math.max(0, current - 1); p <= Math.min(pages - 1, current + 1); p++) shown.add(p);
		for (let p = pages - 3; p < pages; p++) shown.add(p);
		let prev = -1;
		for (const p of [...shown].sort((a, b) => a - b)) {
			if (p - prev > 1) items.push({ type: "dots", key: `d${p}` });
			push(p);
			prev = p;
		}
	}
	items.push({ type: "next", page: current < pages - 1 ? current + 1 : null });
	return items;
}
