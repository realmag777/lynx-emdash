import { BridgeCounter, FAST_STEP_BUDGET, SAFE_STEP_BUDGET } from "@realmag777/lynx-engine";

import { hostWithoutSubrequestLimit, type Ctx } from "./host.ts";

/** Counts bridge calls of one invocation against its budget. */
export class Meter {
	readonly counter = new BridgeCounter();
	readonly ctx: Ctx;
	readonly limit: number;

	constructor(raw: Ctx, limit: number) {
		this.ctx = this.counter.wrap(raw);
		this.limit = limit;
	}

	get used(): number {
		return this.counter.calls;
	}

	remaining(): number {
		return this.limit - this.counter.calls;
	}

	has(calls: number): boolean {
		return this.remaining() >= calls;
	}

	/** A view of this meter that keeps `calls` back for later work. */
	reserving(calls: number): Meter {
		const parent = this;
		return Object.assign(Object.create(Meter.prototype) as Meter, {
			counter: parent.counter,
			ctx: parent.ctx,
			limit: parent.limit - calls,
		});
	}
}

export type StepSize = "auto" | "safe" | "fast";

export function budgetFor(size: StepSize): number {
	if (size === "fast") return FAST_STEP_BUDGET;
	if (size === "safe") return SAFE_STEP_BUDGET;
	return hostWithoutSubrequestLimit() ? FAST_STEP_BUDGET : SAFE_STEP_BUDGET;
}
