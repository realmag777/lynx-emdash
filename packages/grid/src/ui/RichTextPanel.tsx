import { Banner, Button } from "@cloudflare/kumo";
import { PortableTextEditor, type PortableTextEditorProps } from "@emdash-cms/admin";
import * as React from "react";

import type { GridRow } from "../model/api.ts";
import type { GridColumn } from "../model/columns.ts";
import { cellValue } from "../model/edits.ts";
import { errorText, useApi, useNotify } from "./context.tsx";
import { SlidePanel } from "./SlidePanel.tsx";

type PortableTextBlock = NonNullable<PortableTextEditorProps["value"]>[number];

// Rich text (Portable Text) of one cell, edited with the admin's own PortableTextEditor in a
// side panel (2026-09-30). Saving is one core update_entry job, so it is in the history
// and can be rolled back like every other grid edit.

export function RichTextPanel(props: { open: boolean; onClose: () => void; collection: string; revisions: boolean; row: GridRow | null; col: GridColumn | null; title: string; onSaved: (value: unknown, mode: "draft" | "publish") => void }) {
	const api = useApi();
	const notify = useNotify();
	const { row, col } = props;
	const [value, setValue] = React.useState<PortableTextBlock[]>([]);
	const [changed, setChanged] = React.useState(false);
	// Saved straight into the entry (the status is its own column).
	const mode = "publish" as const;
	const [busy, setBusy] = React.useState(false);
	const [problem, setProblem] = React.useState<string | null>(null);
	const labelId = React.useId();

	React.useEffect(() => {
		if (!props.open || !row || !col) return;
		const v = cellValue(row, col.key);
		setValue(Array.isArray(v) ? (v as PortableTextBlock[]) : []);
		setChanged(false);
		setProblem(null);
	}, [props.open, row, col, props.revisions]);

	const save = async () => {
		if (!row || !col) return;
		setBusy(true);
		setProblem(null);
		try {
			const first = await api.update(props.collection, row.id, [{ field: col.key, behavior: "set", value }], mode);
			const end = await api.drive(first);
			if (end.result && (end.result.failed || end.result.invalid || end.result.held || end.result.conflicts)) {
				const detail = await api.historyJob(end.job_key);
				const why = detail.left_alone[0];
				throw new Error(why?.problems?.[0]?.message ?? why?.message ?? `Not saved (${why?.why ?? "unknown reason"}).`);
			}
			notify("success", `${col.label} saved`);
			props.onSaved(value, mode);
			props.onClose();
		} catch (e) {
			setProblem(errorText(e));
		} finally {
			setBusy(false);
		}
	};

	return (
		<SlidePanel
			open={props.open}
			onClose={props.onClose}
			title={col ? col.label : "Rich text"}
			subtitle={props.title}
			footer={
				<>
					<span className="lynx-grow" />
					<Button variant="secondary" onClick={props.onClose}>
						Cancel
					</Button>
					<Button variant="primary" loading={busy} disabled={!changed} onClick={() => void save()}>
						Save
					</Button>
				</>
			}
		>
			<span id={labelId} className="lynx-sr-only">
				{col?.label}
			</span>
			{problem ? <Banner variant="error" description={problem} /> : null}
			{props.open && row && col ? (
				<div className="lynx-richtext">
					<PortableTextEditor
						value={value}
						aria-labelledby={labelId}
						onChange={(v) => {
							setValue(v);
							setChanged(true);
						}}
					/>
				</div>
			) : null}
		</SlidePanel>
	);
}
