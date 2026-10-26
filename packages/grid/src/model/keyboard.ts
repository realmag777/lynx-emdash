// Keyboard model of the grid (Botoscope had only Enter/Esc inside an open editor): an active
// cell moved with the arrows, Home/End (row), Ctrl+Home/End (grid), PageUp/PageDown, Tab and
// Shift+Tab (wrapping to the next/previous row), Enter/F2 to edit, Esc to cancel.

export interface CellPos {
	row: number;
	col: number;
}

export function moveActive(pos: CellPos, key: string, mods: { ctrl: boolean; shift: boolean }, rows: number, cols: number, pageRows: number): CellPos | null {
	if (rows === 0 || cols === 0) return null;
	const clamp = (r: number, c: number): CellPos => ({ row: Math.max(0, Math.min(rows - 1, r)), col: Math.max(0, Math.min(cols - 1, c)) });
	switch (key) {
		case "ArrowUp":
			return clamp(pos.row - 1, pos.col);
		case "ArrowDown":
			return clamp(pos.row + 1, pos.col);
		case "ArrowLeft":
			return clamp(pos.row, pos.col - 1);
		case "ArrowRight":
			return clamp(pos.row, pos.col + 1);
		case "Home":
			return mods.ctrl ? clamp(0, 0) : clamp(pos.row, 0);
		case "End":
			return mods.ctrl ? clamp(rows - 1, cols - 1) : clamp(pos.row, cols - 1);
		case "PageUp":
			return clamp(pos.row - pageRows, pos.col);
		case "PageDown":
			return clamp(pos.row + pageRows, pos.col);
		case "Tab": {
			if (mods.shift) return pos.col > 0 ? clamp(pos.row, pos.col - 1) : pos.row > 0 ? clamp(pos.row - 1, cols - 1) : pos;
			return pos.col < cols - 1 ? clamp(pos.row, pos.col + 1) : pos.row < rows - 1 ? clamp(pos.row + 1, 0) : pos;
		}
		default:
			return null;
	}
}

/** Keys that start editing the active cell with a typed character replacing its value. */
export function startsTyping(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }): boolean {
	return e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
}
