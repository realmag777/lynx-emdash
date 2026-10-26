import { EngineError } from "@realmag777/lynx-engine";

// Every route answers with a payload, never a thrown error: the sandbox reduces thrown
// errors to ROUTE_ERROR and drops the code.
// The code is repeated in the text because MCP clients differ in which one they pass on.

export type LynxErrorCode =
	| "BAD_ARGUMENT"
	| "UNKNOWN_COLLECTION"
	| "UNKNOWN_TAXONOMY"
	| "UNKNOWN_SELECTION"
	| "SELECTION_EXPIRED"
	| "SELECTION_BUILDING"
	| "UNKNOWN_JOB"
	| "NOTHING_TO_REVERT"
	| "NOT_FOUND"
	| "FORBIDDEN"
	| "MEMORY_FULL"
	| "UNKNOWN_CASE"
	| "INTERNAL";

export class LynxError extends Error {
	readonly code: string;
	readonly details?: unknown;

	constructor(code: LynxErrorCode | string, message: string, details?: unknown) {
		super(message);
		this.name = "LynxError";
		this.code = code;
		this.details = details;
	}
}

export interface ErrorResult {
	ok: false;
	code: string;
	message: string;
	details?: unknown;
}

export function toErrorResult(err: unknown): ErrorResult {
	if (err instanceof LynxError || err instanceof EngineError) {
		return { ok: false, code: err.code, message: `LYNX error [${err.code}]: ${err.message}`, ...(err.details === undefined ? {} : { details: err.details }) };
	}
	const message = err instanceof Error ? err.message : String(err);
	return { ok: false, code: "INTERNAL", message: `LYNX error [INTERNAL]: ${message}` };
}

/** Run a handler and turn every failure into a stable error payload. */
export async function guard<T>(fn: () => Promise<T>): Promise<T | ErrorResult> {
	try {
		return await fn();
	} catch (err) {
		return toErrorResult(err);
	}
}
