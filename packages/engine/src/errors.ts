/** Stable error codes. Texts are written for the person an agent relays them to. */
export type EngineErrorCode =
	| "UNKNOWN_FIELD"
	| "FIELD_READ_ONLY"
	| "BAD_BEHAVIOR"
	| "BAD_OPERATION"
	| "NO_OPERATIONS"
	| "BAD_VALUE"
	| "INVALID_PATTERN"
	| "BAD_FILTER"
	| "CONFIRM_MISMATCH"
	| "SELECTION_TOO_LARGE"
	| "STEP_TOO_LARGE";

export class EngineError extends Error {
	readonly code: EngineErrorCode;
	readonly details?: unknown;

	constructor(code: EngineErrorCode, message: string, details?: unknown) {
		super(message);
		this.name = "EngineError";
		this.code = code;
		this.details = details;
	}

	toJSON(): { ok: false; code: EngineErrorCode; message: string; details?: unknown } {
		return { ok: false, code: this.code, message: this.message, ...(this.details === undefined ? {} : { details: this.details }) };
	}
}
