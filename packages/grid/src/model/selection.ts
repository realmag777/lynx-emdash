// Row selection (absent in Botoscope, required for a bulk editor): click toggles, Shift-click
// selects the range from the last clicked row, and "all matching" switches to the whole frozen
// selection on the server instead of the loaded rows.

export interface RowSelection {
	ids: Set<string>;
	/** Last row clicked without Shift: the start of a Shift range. */
	anchor: string | null;
	/** Every entry that matches the current filter, not just the loaded ones. */
	allMatching: boolean;
}

export const emptySelection = (): RowSelection => ({ ids: new Set(), anchor: null, allMatching: false });

export function toggleRow(sel: RowSelection, order: string[], id: string, shift: boolean): RowSelection {
	if (shift && sel.anchor && order.includes(sel.anchor)) {
		const a = order.indexOf(sel.anchor);
		const b = order.indexOf(id);
		const [from, to] = a < b ? [a, b] : [b, a];
		const ids = new Set(sel.ids);
		const select = !sel.ids.has(id) || sel.ids.has(sel.anchor);
		for (const x of order.slice(from, to + 1)) {
			if (select) ids.add(x);
			else ids.delete(x);
		}
		return { ids, anchor: sel.anchor, allMatching: false };
	}
	const ids = new Set(sel.ids);
	if (ids.has(id)) ids.delete(id);
	else ids.add(id);
	return { ids, anchor: id, allMatching: false };
}

export function toggleAllLoaded(sel: RowSelection, order: string[]): RowSelection {
	const all = order.length > 0 && order.every((id) => sel.ids.has(id));
	return { ids: all ? new Set() : new Set(order), anchor: null, allMatching: false };
}

export function selectedCount(sel: RowSelection, matching: number): number {
	return sel.allMatching ? matching : sel.ids.size;
}
