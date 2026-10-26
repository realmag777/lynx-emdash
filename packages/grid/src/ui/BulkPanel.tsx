import { BEHAVIOR_LABEL, type Behavior, type Operation } from "@realmag777/lynx-engine";
import { Badge, Banner, Button, Checkbox, Input, InputArea } from "@cloudflare/kumo";
import { ArrowCounterClockwise, ArrowRight, Plus, Trash, Warning } from "@phosphor-icons/react";
import * as React from "react";

import type { FieldInfo, GridPreview, JobAnswer } from "../model/api.ts";
import { columnKind, type GridColumn } from "../model/columns.ts";
import { formatWithUnit } from "../model/format.ts";
import { termOptions, type TermIndex } from "./cells.tsx";
import { errorText, useApi, useGridApi, useNotify } from "./context.tsx";
import { EmptyDraftsCleanup, JobProgress } from "./jobs.tsx";
import { IconButton, KSelect } from "./kit.tsx";
import { SlidePanel } from "./SlidePanel.tsx";

// Bulk edit: a stack of operations (the core's behaviours per field), a preview of before →
// after over every selected entry (up to 500, computed by the grid's native part with the
// core's engine), then apply through the core with live progress, cancel, and rollback.

export { BEHAVIOR_LABEL };

interface OpDraft {
	id: string;
	field: string;
	behavior: Behavior;
	p: Record<string, string>;
	list: string[];
	flags: Record<string, boolean>;
}

let seq = 0;
const nid = () => `o${Date.now().toString(36)}${seq++}`;

function num(s: string | undefined): number | undefined {
	if (s === undefined || s.trim() === "") return undefined;
	const n = Number(s.replace(",", "."));
	return Number.isFinite(n) ? n : (s as unknown as number);
}

/** The core operation for one row of the stack (operands typed; the core validates them). */
export function toOperation(d: OpDraft, f: FieldInfo | undefined): Operation {
	const op: Operation = { field: d.field, behavior: d.behavior };
	const v = d.p.value;
	switch (d.behavior) {
		case "set":
			if (f?.type === "boolean") op.value = v === "true";
			else if (f?.type === "number" || f?.type === "integer") op.value = num(v);
			else if (f?.type === "multiSelect" || f?.type === "terms") op.value = d.list;
			else if (f?.type === "datetime") op.value = v ? new Date(v).toISOString() : v;
			else op.value = v ?? "";
			break;
		case "append":
		case "prepend":
			op.value = v ?? "";
			if (d.p.separator) op.separator = d.p.separator;
			break;
		case "replace":
			op.find = d.p.find ?? "";
			op.replace = d.p.replace ?? "";
			if (d.flags.regex) op.regex = true;
			if (d.flags.caseSensitive) op.caseSensitive = true;
			if (d.flags.wholeWord) op.wholeWord = true;
			break;
		case "change_case":
			op.case = (d.p.case ?? "title") as Operation["case"];
			break;
		case "slugify":
			if (d.p.source) op.source = d.p.source;
			break;
		case "increase_by":
		case "decrease_by":
		case "increase_percent":
		case "decrease_percent":
		case "multiply":
			op.value = num(v);
			break;
		case "round":
			if (d.p.step) op.step = num(d.p.step)!;
			op.direction = (d.p.direction ?? "nearest") as Operation["direction"];
			if (d.p.ending) op.ending = num(d.p.ending)!;
			break;
		case "copy_from":
			op.source = d.p.source ?? "";
			if (d.p.percent) op.percent = num(d.p.percent)!;
			break;
		case "add_values":
		case "remove_values":
		case "add_terms":
		case "remove_terms":
		case "set_terms":
			op.value = d.list;
			if (d.behavior === "add_terms" && d.flags.noParents) op.withParents = false;
			break;
		case "replace_value":
			op.from = d.p.from;
			op.value = v;
			break;
		case "shift_date":
			op.value = num(v);
			op.unit = (d.p.unit ?? "days") as Operation["unit"];
			break;
		case "schedule":
			op.value = v ? new Date(v).toISOString() : v;
			break;
	}
	return op;
}

export interface BulkTarget {
	/** Every entry matching this filter ("all matching"): the core freezes it as a selection. */
	filter?: unknown;
	/** Or the rows ticked in the grid. */
	ids?: string[];
	count: number;
}

type Phase = "edit" | "preview" | "running" | "done";

export function BulkPanel(props: { open: boolean; onClose: () => void; collection: string; revisions: boolean; fields: FieldInfo[]; columns: GridColumn[]; terms: Map<string, TermIndex>; target: BulkTarget; onChanged: () => void }) {
	const api = useApi();
	const grid = useGridApi();
	const notify = useNotify();
	const { fields, terms, collection } = props;
	// The target is frozen when the panel opens: the grid refreshes (and clears its row selection)
	// after a job, and the result and its rollback must stay on screen.
	const [target, setTarget] = React.useState<BulkTarget>(props.target);
	const bulkFields = fields.filter((f) => f.bulk && f.behaviors.length);
	const byKey = new Map(fields.map((f) => [f.key, f]));
	const [ops, setOps] = React.useState<OpDraft[]>([]);
	// Bulk edits go straight into the entries too (2026-10-01); status is its own operation.
	const mode = "publish" as const;
	const [phase, setPhase] = React.useState<Phase>("edit");
	const [busy, setBusy] = React.useState(false);
	const [selection, setSelection] = React.useState<{ id: string; count: number } | null>(null);
	const [preview, setPreview] = React.useState<GridPreview | null>(null);
	const [job, setJob] = React.useState<JobAnswer | null>(null);
	const [problem, setProblem] = React.useState<string | null>(null);
	const [cleanup, setCleanup] = React.useState(false);
	const cancel = React.useRef({ cancelled: false });

	React.useEffect(() => {
		if (!props.open) return;
		setTarget(props.target);
		setPhase("edit");
		setPreview(null);
		setJob(null);
		setProblem(null);
		setCleanup(false);
		setSelection(null);
		setOps((o) => (o.length ? o : bulkFields[0] ? [blank(bulkFields.find((f) => columnKind(f.key) === "field") ?? bulkFields[0])] : []));
		// Re-open keeps the stack of changes.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [props.open]);

	const blank = (f: FieldInfo): OpDraft => ({ id: nid(), field: f.key, behavior: f.behaviors[0] as Behavior, p: {}, list: [], flags: {} });
	const setOp = (id: string, patch: Partial<OpDraft>) => {
		setOps((xs) => xs.map((x) => (x.id === id ? { ...x, ...patch } : x)));
		setPhase("edit");
		setPreview(null);
	};

	const operations = () => ops.map((d) => toOperation(d, byKey.get(d.field)));

	/** The core's frozen selection for the target (a write never takes a filter directly). */
	const ensureSelection = async (): Promise<{ id: string; count: number }> => {
		if (selection) return selection;
		let sel = await api.find({ collection, filter: target.filter ?? { ids: target.ids ?? [] } });
		while (sel.state === "building") sel = await api.find({ selection_id: sel.selection_id });
		const out = { id: sel.selection_id, count: sel.count };
		setSelection(out);
		return out;
	};

	const runPreview = async () => {
		setBusy(true);
		setProblem(null);
		try {
			// The grid previews every entry (up to 500) while the core freezes the selection it will write.
			const [res] = await Promise.all([grid.preview({ collection, ...(target.filter ? { filter: target.filter } : { ids: target.ids ?? [] }), operations: operations(), mode }), ensureSelection()]);
			setPreview(res);
			setPhase("preview");
		} catch (e) {
			setProblem(errorText(e));
		} finally {
			setBusy(false);
		}
	};

	const runApply = async () => {
		if (!preview) return;
		setBusy(true);
		setProblem(null);
		cancel.current = { cancelled: false };
		try {
			const sel = await ensureSelection();
			const first = await api.apply(sel.id, operations(), sel.count, mode);
			setPhase("running");
			const end = await api.drive(first, setJob, cancel.current);
			setJob(end);
			setPhase("done");
			notify(end.state === "completed" ? "success" : "warning", end.state === "completed" ? "Bulk edit finished" : `Bulk edit ${end.state.replace("_", " ")}`, end.summary);
			props.onChanged();
		} catch (e) {
			setProblem(errorText(e));
			setPhase(job ? "done" : "preview");
		} finally {
			setBusy(false);
		}
	};

	const runRollback = async () => {
		if (!job) return;
		setBusy(true);
		setProblem(null);
		const draftJob = job.mode === "draft";
		try {
			const first = await api.rollback(job.job_key);
			setPhase("running");
			const end = await api.drive(first, setJob);
			setJob(end);
			setPhase("done");
			notify("success", "Rolled back", end.summary);
			if (draftJob) setCleanup(true);
			props.onChanged();
		} catch (e) {
			setProblem(errorText(e));
			setPhase("done");
		} finally {
			setBusy(false);
		}
	};

	const trashing = ops.some((o) => o.behavior === "trash");
	const applyCount = selection?.count ?? preview?.total ?? 0;
	// Nothing to do only when every entry was checked and none changes.
	const nothingToDo = preview ? preview.counts.change === 0 && preview.checked >= preview.total : false;
	const footer =
		phase === "running" ? (
			<>
				<span className="lynx-grow" />
				<Button variant="secondary" onClick={() => (cancel.current.cancelled = true)}>
					Stop after this step
				</Button>
			</>
		) : phase === "done" ? (
			<>
				{job && job.state === "completed" && job.kind !== "rollback" ? (
					<Button variant="secondary" icon={<ArrowCounterClockwise />} loading={busy} onClick={() => void runRollback()}>
						Roll back
					</Button>
				) : null}
				<span className="lynx-grow" />
				<Button variant="primary" onClick={props.onClose}>
					Close
				</Button>
			</>
		) : (
			<>
				<span className="lynx-hint">{target.count.toLocaleString()} entries selected</span>
				<span className="lynx-grow" />
				{phase === "preview" && preview ? (
					<Button variant={trashing ? "destructive" : "primary"} loading={busy} disabled={nothingToDo} onClick={() => void runApply()}>
						Apply to {applyCount.toLocaleString()} {applyCount === 1 ? "entry" : "entries"}
					</Button>
				) : (
					<Button variant="primary" loading={busy} disabled={!ops.length || target.count === 0} onClick={() => void runPreview()}>
						Preview changes
					</Button>
				)}
			</>
		);

	return (
		<SlidePanel open={props.open} onClose={props.onClose} title="Bulk edit" subtitle={`${collection} · ${target.filter ? "all entries matching the filter" : "the selected rows"} (${target.count.toLocaleString()})`} footer={footer}>
			{phase === "running" || phase === "done" ? (
				<section className="lynx-section">
					{job ? <JobProgress job={job} /> : null}
					{cleanup ? <EmptyDraftsCleanup collection={collection} onDone={props.onChanged} /> : null}
				</section>
			) : (
				<>
					<section className="lynx-section">
						<h3 className="lynx-h3">Changes</h3>
						<ol className="lynx-ops">
							{ops.map((d, i) => (
								<OpRow
									key={d.id}
									index={i}
									draft={d}
									fields={bulkFields}
									allFields={fields}
									terms={terms}
									onField={(key) => {
										const f = byKey.get(key)!;
										setOp(d.id, { field: key, behavior: f.behaviors[0] as Behavior, p: {}, list: [], flags: {} });
									}}
									onChange={(patch) => setOp(d.id, patch)}
									onRemove={() => {
										setOps((xs) => xs.filter((x) => x.id !== d.id));
										setPreview(null);
										setPhase("edit");
									}}
								/>
							))}
						</ol>
						<Button variant="ghost" size="sm" icon={<Plus />} disabled={!bulkFields.length} onClick={() => setOps((xs) => [...xs, blank(bulkFields.find((f) => columnKind(f.key) === "field") ?? bulkFields[0]!)])}>
							Add a change
						</Button>
					</section>
					{preview ? <PreviewView preview={preview} columns={props.columns} selected={selection?.count ?? null} /> : null}
				</>
			)}
			{problem ? <Banner variant="error" icon={<Warning weight="fill" />} description={problem} /> : null}
		</SlidePanel>
	);
}

function OpRow(props: { index: number; draft: OpDraft; fields: FieldInfo[]; allFields: FieldInfo[]; terms: Map<string, TermIndex>; onField: (k: string) => void; onChange: (p: Partial<OpDraft>) => void; onRemove: () => void }) {
	const { draft: d, fields } = props;
	const f = fields.find((x) => x.key === d.field);
	const setP = (k: string, v: string) => props.onChange({ p: { ...d.p, [k]: v } });
	const setFlag = (k: string, v: boolean) => props.onChange({ flags: { ...d.flags, [k]: v } });
	const toggleList = (v: string) => props.onChange({ list: d.list.includes(v) ? d.list.filter((x) => x !== v) : [...d.list, v] });
	const taxonomy = f?.key.startsWith("terms:") ? f.key.slice(6) : null;
	const listOptions = taxonomy ? termOptions(props.terms.get(taxonomy)?.list ?? []) : (f?.options ?? []).map((o) => ({ id: o, label: o, depth: 0 }));
	const sources = props.allFields.filter((x) => x.key !== d.field && !x.key.startsWith("terms:") && x.key !== "entry" && x.type !== "image" && x.type !== "file");
	const numericSources = f && (f.type === "number" || f.type === "integer");
	const text = (label: string, key: string, extra: { placeholder?: string; narrow?: boolean; decimal?: boolean; type?: string } = {}) => (
		<Input
			size="sm"
			aria-label={label}
			className={extra.narrow ? "lynx-narrow" : undefined}
			placeholder={extra.placeholder ?? label}
			type={extra.type ?? "text"}
			inputMode={extra.decimal ? "decimal" : undefined}
			value={d.p[key] ?? ""}
			onChange={(e) => setP(key, e.target.value)}
		/>
	);

	const valueInput = (label = "Value") => {
		if (!f) return null;
		if (f.type === "boolean")
			return (
				<KSelect
					label={label}
					value={d.p.value ?? "true"}
					onChange={(v) => setP("value", v)}
					options={[
						{ value: "true", label: "Yes" },
						{ value: "false", label: "No" },
					]}
				/>
			);
		if (f.type === "select") return <KSelect label={label} value={d.p.value ?? ""} placeholder="Choose…" onChange={(v) => setP("value", v)} options={(f.options ?? []).map((o) => ({ value: o, label: o }))} />;
		if (f.type === "datetime") return text(label, "value", { type: "datetime-local" });
		if (f.type === "text" || f.type === "portableText") return <InputArea aria-label={label} rows={3} placeholder={label} value={d.p.value ?? ""} onChange={(e) => setP("value", e.target.value)} />;
		return text(label, "value", { decimal: f.type === "number" || f.type === "integer" });
	};
	const checklist = (
		<ul className="lynx-checklist lynx-checklist--inline" aria-label="Values">
			{listOptions.map((o) => (
				<li key={o.id} style={{ paddingInlineStart: o.depth * 14 }}>
					<Checkbox label={o.label} checked={d.list.includes(o.id)} onCheckedChange={() => toggleList(o.id)} />
				</li>
			))}
			{listOptions.length === 0 ? <li className="lynx-hint">No terms in this taxonomy yet.</li> : null}
		</ul>
	);

	let params: React.ReactNode = null;
	switch (d.behavior) {
		case "set":
			params = f?.type === "multiSelect" || taxonomy ? checklist : valueInput();
			break;
		case "append":
		case "prepend":
			params = (
				<>
					{valueInput("Text")}
					{f?.type !== "portableText" ? text("Separator", "separator", { narrow: true }) : null}
				</>
			);
			break;
		case "replace":
			params = (
				<>
					{text("Find", "find")}
					{text("Replace with", "replace", { placeholder: "Replace with (empty deletes)" })}
					<span className="lynx-flags">
						<Checkbox label="Regular expression" checked={Boolean(d.flags.regex)} onCheckedChange={(c) => setFlag("regex", Boolean(c))} />
						<Checkbox label="Match case" checked={Boolean(d.flags.caseSensitive)} onCheckedChange={(c) => setFlag("caseSensitive", Boolean(c))} />
						<Checkbox label="Whole words" checked={Boolean(d.flags.wholeWord)} onCheckedChange={(c) => setFlag("wholeWord", Boolean(c))} />
					</span>
				</>
			);
			break;
		case "change_case":
			params = (
				<KSelect
					label="Case"
					value={d.p.case ?? "title"}
					onChange={(v) => setP("case", v)}
					options={[
						{ value: "upper", label: "UPPER CASE" },
						{ value: "lower", label: "lower case" },
						{ value: "title", label: "Title Case" },
						{ value: "sentence", label: "Sentence case" },
					]}
				/>
			);
			break;
		case "slugify":
			params = <KSelect label="From field" value={d.p.source ?? ""} onChange={(v) => setP("source", v)} options={[{ value: "", label: "From the current value" }, ...sources.map((s) => ({ value: s.key, label: `From ${s.label}` }))]} />;
			break;
		case "increase_by":
		case "decrease_by":
		case "increase_percent":
		case "decrease_percent":
		case "multiply":
			params = text("Amount", "value", { narrow: true, decimal: true, placeholder: d.behavior.endsWith("percent") ? "%" : "Amount" });
			break;
		case "round":
			params = (
				<>
					{text("Step", "step", { narrow: true, decimal: true, placeholder: "Step (1)" })}
					<KSelect
						label="Direction"
						value={d.p.direction ?? "nearest"}
						onChange={(v) => setP("direction", v)}
						options={[
							{ value: "nearest", label: "nearest" },
							{ value: "up", label: "up" },
							{ value: "down", label: "down" },
						]}
					/>
					{text("Ending", "ending", { narrow: true, decimal: true, placeholder: "Ending (0.99)" })}
				</>
			);
			break;
		case "copy_from":
			params = (
				<>
					<KSelect label="Source field" value={d.p.source ?? ""} placeholder="Choose a field…" onChange={(v) => setP("source", v)} options={sources.map((s) => ({ value: s.key, label: s.label }))} />
					{numericSources ? text("Adjust by percent", "percent", { narrow: true, decimal: true, placeholder: "± %" }) : null}
				</>
			);
			break;
		case "add_values":
		case "remove_values":
		case "remove_terms":
		case "set_terms":
			params = checklist;
			break;
		case "add_terms":
			params = (
				<>
					{checklist}
					<Checkbox label="Do not add parent terms" checked={Boolean(d.flags.noParents)} onCheckedChange={(c) => setFlag("noParents", Boolean(c))} />
				</>
			);
			break;
		case "replace_value":
			params = (
				<>
					<KSelect label="Replace" value={d.p.from ?? ""} placeholder="Option…" onChange={(v) => setP("from", v)} options={(f?.options ?? []).map((o) => ({ value: o, label: o }))} />
					<ArrowRight size={14} aria-hidden />
					{valueInput("With")}
				</>
			);
			break;
		case "shift_date":
			params = (
				<>
					{text("Amount", "value", { narrow: true, placeholder: "±N" })}
					<KSelect label="Unit" value={d.p.unit ?? "days"} onChange={(v) => setP("unit", v)} options={["minutes", "hours", "days", "weeks", "months", "years"].map((u) => ({ value: u, label: u }))} />
				</>
			);
			break;
		case "schedule":
			params = text("Publish at", "value", { type: "datetime-local" });
			break;
	}

	return (
		<li className="lynx-op">
			<span className="lynx-op__n" aria-hidden>
				{props.index + 1}
			</span>
			<div className="lynx-op__main">
				<div className="lynx-op__line">
					<KSelect label="Field" value={d.field} onChange={(v) => props.onField(v)} options={fields.map((x) => ({ value: x.key, label: x.key === "entry" ? "Whole entry" : x.label }))} />
					<KSelect label="Change" value={d.behavior} onChange={(v) => props.onChange({ behavior: v as Behavior, p: {}, list: [], flags: {} })} options={(f?.behaviors ?? []).map((b) => ({ value: b, label: BEHAVIOR_LABEL[b as Behavior] ?? b }))} />
					<IconButton label="Remove this change" icon={<Trash />} onClick={props.onRemove} />
				</div>
				{params ? <div className="lynx-op__params">{params}</div> : null}
			</div>
		</li>
	);
}

const ROW_BADGE: Record<string, { variant: "info" | "error" | "neutral" | "warning"; text: string }> = {
	change: { variant: "info", text: "changes" },
	invalid: { variant: "error", text: "skipped: invalid" },
	unchanged: { variant: "neutral", text: "stays the same" },
	held: { variant: "warning", text: "held" },
};

const SHOWN = 100;

/** A preview value as the table shows it: numbers with separators, currency and units. */
function shown(raw: unknown, text: string, col: GridColumn | undefined): string {
	if (typeof raw === "number" && col && (col.type === "number" || col.type === "integer")) return formatWithUnit(raw, col, col.format);
	return text;
}

function PreviewView({ preview, columns, selected }: { preview: GridPreview; columns: GridColumn[]; selected: number | null }) {
	const [all, setAll] = React.useState(false);
	const c = preview.counts;
	const byKey = new Map(columns.map((col) => [col.key, col]));
	const important = preview.warnings.filter((w) => w.important);
	const info = preview.warnings.filter((w) => !w.important);
	const rows = all ? preview.rows : preview.rows.slice(0, SHOWN);
	const n = (x: number) => x.toLocaleString();
	return (
		<section className="lynx-section" aria-live="polite">
			<h3 className="lynx-h3">Preview</h3>
			<p className="lynx-summary">
				{preview.checked >= preview.total ? `Checked all ${n(preview.total)} ${preview.total === 1 ? "entry" : "entries"}` : `Checked the first ${n(preview.checked)} of ${n(preview.total)} entries`}: <b>{n(c.change)}</b> will change, {n(c.unchanged)} stay the same
				{c.invalid ? (
					<>
						, <b className="lynx-text-danger">{n(c.invalid)}</b> would be skipped as invalid
					</>
				) : null}
				{c.held ? <>, {n(c.held)} held (they carry someone else's draft)</> : null}.
			</p>
			{selected !== null && selected !== preview.total ? (
				<Banner variant="alert" icon={<Warning weight="fill" />} description={`Entries changed while the preview was made: the job will change ${n(selected)} entries, the preview saw ${n(preview.total)}. Preview again to be sure.`} />
			) : null}
			{important.length ? (
				<div className="lynx-warnings">
					{important.map((w) => (
						<Banner key={w.code} variant="alert" icon={<Warning weight="fill" />} description={w.text} />
					))}
				</div>
			) : null}
			<div className="lynx-table-wrap">
				<table className="lynx-table">
					<thead>
						<tr>
							<th>Entry</th>
							<th>Change</th>
						</tr>
					</thead>
					<tbody>
						{rows.map((r) => (
							<tr key={r.id} className={r.state === "invalid" ? "is-failed" : r.state === "unchanged" ? "is-muted" : ""}>
								<td>
									<div className="lynx-strong">{r.title || r.id}</div>
									<Badge variant={ROW_BADGE[r.state]?.variant ?? "neutral"}>{ROW_BADGE[r.state]?.text ?? r.state}</Badge>
								</td>
								<td>
									{r.changes.map((ch, i) => {
										const col = byKey.get(ch.field);
										return (
											<div key={i} className="lynx-diff">
												<span className="lynx-diff__field">{ch.label}</span>
												<span className="lynx-diff__before">{shown(ch.before, ch.before_text, col) || "—"}</span>
												<ArrowRight size={12} aria-label="becomes" />
												<span className="lynx-diff__after">{shown(ch.after, ch.after_text, col) || "—"}</span>
											</div>
										);
									})}
									{r.problems?.map((pr, i) => (
										<div key={`p${i}`} className="lynx-text-danger">
											{pr}
										</div>
									))}
									{!r.changes.length && !r.problems?.length ? <span className="lynx-hint">No change</span> : null}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
			{preview.rows.length > rows.length ? (
				<Button variant="ghost" size="sm" onClick={() => setAll(true)}>
					Show all {n(preview.rows.length)} checked entries
				</Button>
			) : null}
			{info.length ? (
				<ul className="lynx-notes" aria-label="Notes">
					{info.map((w) => (
						<li key={w.code}>{w.text}</li>
					))}
				</ul>
			) : null}
		</section>
	);
}
