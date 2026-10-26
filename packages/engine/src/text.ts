export interface FindOptions {
	find: string;
	/** Treat `find` as a JavaScript regular expression source. */
	regex?: boolean;
	caseSensitive?: boolean;
	/** Match whole words only (Unicode letters, digits and underscore are word characters). */
	wholeWord?: boolean;
}

export const MAX_PATTERN_LENGTH = 500;

export class PatternError extends Error {
	readonly code = "INVALID_PATTERN";
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Build a global, Unicode-aware matcher. Throws PatternError on an invalid pattern. */
export function buildMatcher(opts: FindOptions): RegExp {
	if (opts.find.length === 0) throw new PatternError("Find text must not be empty");
	if (opts.find.length > MAX_PATTERN_LENGTH) throw new PatternError(`Find text is longer than ${MAX_PATTERN_LENGTH} characters`);
	let source = opts.regex ? opts.find : escapeRegExp(opts.find);
	if (opts.wholeWord) source = `(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])`;
	const flags = `gu${opts.caseSensitive ? "" : "i"}`;
	try {
		return new RegExp(source, flags);
	} catch (err) {
		throw new PatternError(`Invalid regular expression: ${(err as Error).message}`);
	}
}

export interface TextMatch {
	start: number;
	end: number;
	replacement: string;
}

/**
 * All matches of `matcher` in `text` with the replacement already expanded
 * (`$1`, `$<name>`, `$&` work for regex mode; plain mode inserts the text as is).
 */
export function findMatches(text: string, matcher: RegExp, replace: string, regexMode: boolean): TextMatch[] {
	const out: TextMatch[] = [];
	matcher.lastIndex = 0;
	for (const m of text.matchAll(matcher)) {
		const start = m.index ?? 0;
		const matched = m[0];
		const replacement = regexMode ? expandReplacement(replace, m, text) : replace;
		out.push({ start, end: start + matched.length, replacement });
	}
	return out;
}

/** Expand `$$`, `$&`, `` $` ``, `$'`, `$1`..`$99` and `$<name>` like String.prototype.replace. */
function expandReplacement(template: string, m: RegExpMatchArray, input: string): string {
	const start = m.index ?? 0;
	const groupCount = m.length - 1;
	return template.replace(/\$(\$|&|`|'|\d{1,2}|<([^>]*)>)/g, (token, what: string, name: string | undefined) => {
		if (what === "$") return "$";
		if (what === "&") return m[0];
		if (what === "`") return input.slice(0, start);
		if (what === "'") return input.slice(start + m[0].length);
		if (name !== undefined) return m.groups?.[name] ?? "";
		const two = Number(what);
		if (two >= 1 && two <= groupCount) return m[two] ?? "";
		if (what.length === 2) {
			const one = Number(what[0]);
			if (one >= 1 && one <= groupCount) return (m[one] ?? "") + what[1];
		}
		return token;
	});
}

/** Replace in a plain string. Returns the new text and the number of replacements. */
export function replaceText(text: string, opts: FindOptions & { replace: string }): { text: string; count: number } {
	const matcher = buildMatcher(opts);
	const matches = findMatches(text, matcher, opts.replace, opts.regex === true);
	if (matches.length === 0) return { text, count: 0 };
	let result = "";
	let cursor = 0;
	for (const m of matches) {
		result += text.slice(cursor, m.start) + m.replacement;
		cursor = m.end;
	}
	result += text.slice(cursor);
	return { text: result, count: matches.length };
}

export type CaseMode = "upper" | "lower" | "title" | "sentence";

export function changeCase(text: string, mode: CaseMode): string {
	switch (mode) {
		case "upper":
			return text.toLocaleUpperCase();
		case "lower":
			return text.toLocaleLowerCase();
		case "title":
			return text.toLocaleLowerCase().replace(/(^|[^\p{L}\p{N}'’])(\p{L})/gu, (_m, pre: string, ch: string) => pre + ch.toLocaleUpperCase());
		case "sentence": {
			const lower = text.toLocaleLowerCase();
			return lower.replace(/(^\s*|[.!?]\s+)(\p{L})/gu, (_m, pre: string, ch: string) => pre + ch.toLocaleUpperCase());
		}
	}
}

/** Collapse runs of whitespace and trim both ends. */
export function normalizeWhitespace(text: string): string {
	return text.replace(/\s+/gu, " ").trim();
}

/** URL-safe slug: lowercase ASCII letters, digits and single hyphens. */
export function slugify(text: string): string {
	return text
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/-{2,}/g, "-");
}
