import { Check } from "@phosphor-icons/react";
import * as React from "react";

import type { FieldInfo } from "../model/api.ts";
import { isIndexed, setIndexed } from "../model/schema.ts";
import { errorText, useNotify } from "./context.tsx";

// One field's index, as a checkbox (2026-10-01): tick it and EmDash builds the database
// index (a moving bar while it works, then "Indexed"); untick it to drop the index. Used in the
// Settings panel and in the gear menu of a column header.

export function IndexToggle(props: { collection: string; field: FieldInfo; entries: number | null; canManage: boolean | null; onChanged: () => void; compact?: boolean }) {
	const notify = useNotify();
	const [busy, setBusy] = React.useState<null | "on" | "off">(null);
	const [seconds, setSeconds] = React.useState(0);
	const [problem, setProblem] = React.useState<string | null>(null);
	// Shown until the fields are read again after a change.
	const [now, setNow] = React.useState<boolean | null>(null);
	const indexed = now ?? isIndexed(props.field);
	React.useEffect(() => setNow(null), [props.field]);

	const change = async (on: boolean) => {
		setBusy(on ? "on" : "off");
		setProblem(null);
		setSeconds(0);
		const t0 = Date.now();
		const tick = window.setInterval(() => setSeconds(Math.floor((Date.now() - t0) / 1000)), 250);
		try {
			// The bar stays a moment even when EmDash is done at once, so the change is seen.
			const [ms] = await Promise.all([setIndexed(props.collection, props.field.key, on).then(() => Date.now() - t0), new Promise((r) => window.setTimeout(r, 700))]);
			setNow(on);
			const took = (ms / 1000).toFixed(1);
			notify("success", on ? `${props.field.label} indexed` : `Index of ${props.field.label} removed`, on ? `Built in ${took} s. Sorting and filtering by it now run in the database.` : undefined);
			props.onChanged();
		} catch (e) {
			setProblem(errorText(e));
		} finally {
			window.clearInterval(tick);
			setBusy(null);
		}
	};

	const entries = props.entries !== null ? `${props.entries.toLocaleString()} entries` : "the entries";
	return (
		<div className={`lynx-index ${props.compact ? "lynx-index--compact" : ""}`}>
			<label className="lynx-check">
				<input type="checkbox" checked={busy ? busy === "on" : indexed} disabled={!props.canManage || busy !== null} onChange={(e) => void change(e.target.checked)} aria-label={`Index ${props.field.label}`} />
				<span>{props.compact ? "Indexed" : "Index this field"}</span>
			</label>
			{busy ? (
				<div className="lynx-index__progress" role="status">
					<div className="lynx-index__bar" aria-hidden>
						<span />
					</div>
					<span className="lynx-hint">
						{busy === "on" ? `Indexing ${props.field.label} over ${entries}…` : `Removing the index…`} {seconds ? `${seconds} s` : ""}
					</span>
				</div>
			) : indexed ? (
				<span className="lynx-index__state is-on">
					<Check size={12} weight="bold" aria-hidden /> Indexed: sorts and filters run in the database
				</span>
			) : (
				<span className="lynx-index__state">Not indexed: sorting reads every entry first</span>
			)}
			{props.canManage === false ? <span className="lynx-hint">Only administrators can change indexes.</span> : null}
			{problem ? <span className="lynx-text-danger">{problem}</span> : null}
		</div>
	);
}
