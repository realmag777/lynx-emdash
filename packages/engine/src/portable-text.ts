import { buildMatcher, findMatches, type FindOptions } from "./text.ts";

// Portable Text find/replace. Works on the tree, never on raw JSON:
// - text is matched across the spans of one block, so a phrase split by
//   formatting ("sea <b>view</b>") is still found;
// - the replacement inherits the marks of the span where the match starts;
// - every existing `_key`, mark and markDef is kept; spans emptied by a
//   replacement are dropped (a block always keeps at least one span);
// - inline objects (non-span children) are boundaries: a match never crosses them.

export interface PTSpan {
	_type: "span";
	_key?: string;
	text: string;
	marks?: string[];
	[key: string]: unknown;
}

export interface PTBlock {
	_type: string;
	_key?: string;
	children?: unknown[];
	markDefs?: unknown[];
	style?: string;
	[key: string]: unknown;
}

export function isSpan(node: unknown): node is PTSpan {
	return typeof node === "object" && node !== null && (node as { _type?: unknown })._type === "span" && typeof (node as { text?: unknown }).text === "string";
}

function isTextBlock(node: unknown): node is PTBlock & { children: unknown[] } {
	return typeof node === "object" && node !== null && (node as PTBlock)._type === "block" && Array.isArray((node as PTBlock).children);
}

export function isPortableText(value: unknown): value is PTBlock[] {
	return Array.isArray(value) && value.every((b) => typeof b === "object" && b !== null && typeof (b as PTBlock)._type === "string");
}

/** Plain text of a Portable Text value: blocks joined by blank lines. */
export function toPlainText(value: unknown): string {
	if (!Array.isArray(value)) return "";
	return value
		.filter(isTextBlock)
		.map((b) => b.children.filter(isSpan).map((s) => s.text).join(""))
		.join("\n\n");
}

let keyCounter = 0;
/** Short random-looking key; deterministic within a process run is fine for new nodes. */
export function newKey(): string {
	keyCounter = (keyCounter + 1) % 0xffffff;
	return `lx${Date.now().toString(36).slice(-5)}${keyCounter.toString(36)}`;
}

/** One paragraph block per non-empty line group (split on blank lines). */
export function fromPlainText(text: string): PTBlock[] {
	return text
		.split(/\n{2,}/)
		.map((p) => p.trim())
		.filter((p) => p.length > 0)
		.map((p) => ({
			_type: "block",
			_key: newKey(),
			style: "normal",
			markDefs: [],
			children: [{ _type: "span", _key: newKey(), text: p, marks: [] }],
		}));
}

interface Run {
	/** Indexes into block.children of consecutive spans. */
	indexes: number[];
}

function spanRuns(children: unknown[]): Run[] {
	const runs: Run[] = [];
	let current: number[] = [];
	children.forEach((child, i) => {
		if (isSpan(child)) current.push(i);
		else if (current.length) {
			runs.push({ indexes: current });
			current = [];
		}
	});
	if (current.length) runs.push({ indexes: current });
	return runs;
}

export interface PTReplaceResult {
	value: PTBlock[];
	count: number;
	/** Matches whose text crossed a formatting boundary (the replacement took the first span's marks). */
	crossedMarks: number;
}

/** Find/replace inside Portable Text. The input is not mutated. */
export function replaceInPortableText(value: unknown, opts: FindOptions & { replace: string }): PTReplaceResult {
	if (!Array.isArray(value)) return { value: [], count: 0, crossedMarks: 0 };
	const matcher = buildMatcher(opts);
	let count = 0;
	let crossedMarks = 0;

	const blocks = (value as PTBlock[]).map((block) => {
		if (!isTextBlock(block)) return block;
		const children = block.children.slice();
		let changed = false;
		const removed = new Set<number>();

		for (const run of spanRuns(children)) {
			const spans = run.indexes.map((i) => children[i] as PTSpan);
			const full = spans.map((s) => s.text).join("");
			const matches = findMatches(full, matcher, opts.replace, opts.regex === true);
			if (matches.length === 0) continue;

			// Owner span of every character position (and of the end position).
			const owner: number[] = new Array(full.length + 1);
			let pos = 0;
			spans.forEach((s, si) => {
				for (let c = 0; c < s.text.length; c++) owner[pos + c] = si;
				pos += s.text.length;
			});
			owner[full.length] = spans.length - 1;

			const out = spans.map(() => "");
			let cursor = 0;
			for (const m of matches) {
				for (let c = cursor; c < m.start; c++) out[owner[c]!] += full[c]!;
				const first = owner[m.start] ?? spans.length - 1;
				out[first] += m.replacement;
				if (m.end > m.start && owner[m.end - 1] !== first) crossedMarks++;
				cursor = m.end;
				count++;
			}
			for (let c = cursor; c < full.length; c++) out[owner[c]!] += full[c]!;

			spans.forEach((s, si) => {
				const idx = run.indexes[si]!;
				if (out[si] !== s.text) {
					children[idx] = { ...s, text: out[si]! };
					changed = true;
				}
			});
			// Drop spans emptied by the replacement, but keep one span per run.
			const nonEmpty = run.indexes.filter((idx) => (children[idx] as PTSpan).text.length > 0);
			const keep = nonEmpty.length > 0 ? new Set(nonEmpty) : new Set([run.indexes[0]!]);
			for (const idx of run.indexes) {
				if (!keep.has(idx) && spans[run.indexes.indexOf(idx)]!.text.length > 0) removed.add(idx);
			}
		}

		if (!changed) return block;
		return { ...block, children: children.filter((_, i) => !removed.has(i)) };
	});

	return { value: blocks, count, crossedMarks };
}

/** Count matches without building a new value. */
export function countInPortableText(value: unknown, opts: FindOptions): number {
	return replaceInPortableText(value, { ...opts, replace: "" }).count;
}

/** Append (or prepend) plain text as new paragraph blocks. */
export function addParagraphs(value: unknown, text: string, where: "append" | "prepend"): PTBlock[] {
	const base = Array.isArray(value) ? (value as PTBlock[]) : [];
	const extra = fromPlainText(text);
	return where === "append" ? [...base, ...extra] : [...extra, ...base];
}
