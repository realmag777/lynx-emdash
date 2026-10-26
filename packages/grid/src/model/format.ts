// Number formats of the grid: currency symbol and position, decimals, and unit display. One
// formatter for the table, the phone cards and the bulk-edit preview (2026-09-30).
// Settings are per collection and field, site-wide (the grid's `formats` storage); a field
// without a setting gets a default from its unit: "currency" → €, litres → one decimal.

export interface FieldFormat {
	/** Currency symbol, e.g. "€"; empty for none. */
	currency?: string;
	position?: "before" | "after";
	/** Fixed number of decimals; undefined = as stored (up to 6). */
	decimals?: number;
}

export type Formats = Record<string, FieldFormat>;

export const CURRENCIES = ["€", "$", "£", "¥", "CHF", "₽", "zł"];

/** How a unit is written: litres as "L" (a lowercase l reads like a 1). */
export function unitLabel(unit: string | undefined): string | undefined {
	if (!unit || unit === "currency") return undefined;
	if (unit === "l") return "L";
	return unit;
}

export function defaultFormat(field: { unit?: string; type: string }): FieldFormat {
	if (field.unit === "currency") return { currency: "€", position: "before" };
	if (field.unit === "l" || field.unit === "L") return { decimals: 1 };
	return {};
}

export function formatOf(formats: Formats | undefined, key: string, field: { unit?: string; type: string }): FieldFormat {
	return formats?.[key] ?? defaultFormat(field);
}

/**
 * The number as the table shows it: thousands separators (not for small whole numbers such as
 * years, doors or seats), fixed decimals, currency symbol. The unit is appended by the caller.
 */
export function formatNumber(value: number, type: string, fmt: FieldFormat = {}): string {
	// Money that is not whole shows cents ("€20,796.60", not "€20,796.6").
	const decimals = fmt.decimals ?? (fmt.currency && !Number.isInteger(value) ? 2 : undefined);
	const fixed = decimals !== undefined;
	const plainInteger = type === "integer" && Math.abs(value) < 10000 && !fmt.currency && !fixed;
	const digits = plainInteger ? String(value) : value.toLocaleString(undefined, fixed ? { minimumFractionDigits: decimals, maximumFractionDigits: decimals } : { maximumFractionDigits: 6 });
	if (!fmt.currency) return digits;
	const neg = digits.startsWith("-") || digits.startsWith("−");
	const abs = neg ? digits.slice(1) : digits;
	const sign = neg ? "−" : "";
	return fmt.position === "after" ? `${sign}${abs} ${fmt.currency}` : `${sign}${fmt.currency}${abs}`;
}

/** Number with its unit ("2.0 L", "73,500 km", "€19,500"), for text places such as previews. */
export function formatWithUnit(value: number, field: { type: string; unit?: string }, fmt: FieldFormat = {}): string {
	const unit = unitLabel(field.unit);
	return `${formatNumber(value, field.type, fmt)}${unit ? ` ${unit}` : ""}`;
}
