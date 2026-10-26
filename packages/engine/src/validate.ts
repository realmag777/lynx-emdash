import type { FieldDef } from "./types.ts";
import { isEmptyValue } from "./values.ts";

export interface ValidationProblem {
	field: string;
	rule: "required" | "minLength" | "maxLength" | "pattern" | "min" | "max" | "options" | "minItems" | "maxItems" | "unique";
	message: string;
}

// Rules mirror EmDash's zod generator (core/src/schema/zod-generator.ts:95-286):
// string rules apply to string/text/slug/url and a select without options;
// min/max to number/integer; minItems/maxItems to repeater/blocks.
const STRING_RULE_TYPES = new Set(["string", "text", "slug", "url"]);

/** Validate an already coerced value against the field rules. Returns every problem found. */
export function validateValue(field: FieldDef, value: unknown): ValidationProblem[] {
	const v = field.validation ?? {};
	const problems: ValidationProblem[] = [];
	const p = (rule: ValidationProblem["rule"], message: string) => problems.push({ field: field.slug, rule, message });

	if (value === null || value === undefined) {
		if (field.required) p("required", `${field.label} is required and cannot be cleared`);
		return problems;
	}

	const stringRules = STRING_RULE_TYPES.has(field.type) || (field.type === "select" && !(v.options && v.options.length));
	if (stringRules && typeof value === "string") {
		if (v.minLength !== undefined && value.length < v.minLength) p("minLength", `${field.label} needs at least ${v.minLength} characters (has ${value.length})`);
		if (v.maxLength !== undefined && value.length > v.maxLength) p("maxLength", `${field.label} allows at most ${v.maxLength} characters (has ${value.length})`);
		if (v.pattern) {
			let re: RegExp | null = null;
			try {
				re = new RegExp(v.pattern);
			} catch {
				re = null;
			}
			if (re && !re.test(value)) p("pattern", `${field.label} must match the pattern ${v.pattern}`);
		}
	}

	if ((field.type === "number" || field.type === "integer") && typeof value === "number") {
		if (v.min !== undefined && value < v.min) p("min", `${field.label} must be at least ${v.min} (would be ${value})`);
		if (v.max !== undefined && value > v.max) p("max", `${field.label} must be at most ${v.max} (would be ${value})`);
	}

	if (field.type === "select" && v.options && v.options.length && typeof value === "string" && !v.options.includes(value)) {
		p("options", `${field.label} must be one of: ${v.options.join(", ")}`);
	}
	if (field.type === "multiSelect" && v.options && v.options.length && Array.isArray(value)) {
		const bad = value.filter((x) => !v.options!.includes(String(x)));
		if (bad.length) p("options", `${field.label} does not offer: ${bad.join(", ")}`);
	}

	if ((field.type === "repeater" || field.type === "blocks") && Array.isArray(value)) {
		if (v.minItems !== undefined && value.length < v.minItems) p("minItems", `${field.label} needs at least ${v.minItems} items`);
		if (v.maxItems !== undefined && value.length > v.maxItems) p("maxItems", `${field.label} allows at most ${v.maxItems} items`);
	}

	if (field.required && isEmptyValue(value) && field.type !== "boolean") {
		p("required", `${field.label} is required and cannot be empty`);
	}
	return problems;
}
