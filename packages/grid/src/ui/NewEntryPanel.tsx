import { Button, Checkbox, Input, Switch } from "@cloudflare/kumo";
import * as React from "react";

import type { FieldInfo } from "../model/api.ts";
import { searchTermOptions, termOptions, type TermIndex } from "./cells.tsx";
import { errorText, useApi, useNotify } from "./context.tsx";
import { KSelect } from "./kit.tsx";
import { SlidePanel } from "./SlidePanel.tsx";

// A new entry from the grid (2026-10-05: "where is Add new? A side panel with every field").
// The form holds every field the grid can fill; the core checks the row (its create_entries dry
// run: required fields, ranges, options, unique values, terms) and then creates it as a job, so it
// is in History and a rollback moves it to the trash. Photos, rich text and other lists are added
// afterwards in the grid's own panels.

const SKIP_TYPES = new Set(["image", "file", "repeater", "portableText", "reference", "json"]);
const SYSTEM = new Set(["id", "entry", "locale", "created_at", "updated_at", "published_at", "scheduled_at"]);

type Values = Record<string, string | boolean | string[]>;

/** The fields the form offers, the rest named in a note. */
function formFields(fields: FieldInfo[]): { shown: FieldInfo[]; later: FieldInfo[] } {
	const usable = fields.filter((f) => f.editable && !SYSTEM.has(f.key) && f.key !== "status");
	return { shown: usable.filter((f) => !SKIP_TYPES.has(f.type)), later: usable.filter((f) => SKIP_TYPES.has(f.type)) };
}

/** Form values as a create_entries row (empty fields left out). */
function toRow(fields: FieldInfo[], values: Values, status: string, terms: Map<string, TermIndex>): Record<string, unknown> {
	const row: Record<string, unknown> = { status };
	for (const f of fields) {
		const v = values[f.key];
		if (v === undefined || v === "" || (Array.isArray(v) && v.length === 0)) continue;
		if (f.type === "terms") {
			const index = terms.get(f.key.slice("terms:".length));
			row[f.key] = (v as string[]).map((id) => index?.byId.get(id)?.slug ?? id);
		} else if (f.type === "number") row[f.key] = Number(String(v).replace(",", "."));
		else if (f.type === "integer") row[f.key] = Number(v);
		else if (f.type === "boolean") row[f.key] = v === true;
		else if (f.type === "datetime") row[f.key] = new Date(String(v)).toISOString();
		else row[f.key] = v;
	}
	return row;
}

export function NewEntryPanel(props: { open: boolean; onClose: () => void; collection: string; label: string; fields: FieldInfo[]; terms: Map<string, TermIndex>; onCreated: () => void }) {
	const api = useApi();
	const notify = useNotify();
	const { shown, later } = formFields(props.fields);
	const [values, setValues] = React.useState<Values>({});
	const [status, setStatus] = React.useState("draft");
	const [problems, setProblems] = React.useState<Record<string, string>>({});
	const [general, setGeneral] = React.useState<string | null>(null);
	const [busy, setBusy] = React.useState(false);

	React.useEffect(() => {
		if (!props.open) return;
		setValues({});
		setStatus("draft");
		setProblems({});
		setGeneral(null);
	}, [props.open, props.collection]);

	const set = (key: string, v: string | boolean | string[]) => {
		setValues((x) => ({ ...x, [key]: v }));
		setProblems((p) => {
			const { [key]: _, ...rest } = p;
			return rest;
		});
	};

	const create = async () => {
		setBusy(true);
		setGeneral(null);
		try {
			const row = toRow(shown, values, status, props.terms);
			const check = await api.create(props.collection, [row], true);
			const bad = check.rows[0]?.problems ?? [];
			if (check.ok !== 1) {
				const byField: Record<string, string> = {};
				const rest: string[] = [];
				for (const p of bad) {
					const said = p.message ?? p.text ?? p.code;
					const text = p.hint ? `${said} ${p.hint}` : said;
					if (p.field && shown.some((f) => f.key === p.field)) byField[p.field] = text;
					else rest.push(text);
				}
				setProblems(byField);
				setGeneral(rest.length ? rest.join(" ") : Object.keys(byField).length ? "Fix the marked fields." : "The entry was not accepted.");
				return;
			}
			const job = await api.create(props.collection, [row], false, 1);
			const done = job.job_key && !job.finished ? await api.drive(job as never) : job;
			if ((done as { result?: { written?: number } }).result?.written === 0) throw new Error("The entry was not created.");
			const name = String(values.title ?? values[shown.find((f) => f.required && f.type === "string")?.key ?? ""] ?? "") || "new entry";
			notify("success", `Created “${name}”`, `It is in History; a rollback there moves it to the trash.${status === "draft" ? " Saved as a draft." : ""}`);
			props.onCreated();
			props.onClose();
		} catch (e) {
			setGeneral(errorText(e));
		} finally {
			setBusy(false);
		}
	};

	return (
		<SlidePanel
			open={props.open}
			onClose={props.onClose}
			title={`New entry in ${props.label}`}
			subtitle="Fill in what you know; the required fields are marked. LYNX checks the entry before it creates it."
			size="md"
			footer={
				<>
					<KSelect
						label="Status"
						showLabel
						value={status}
						onChange={setStatus}
						options={[
							{ value: "draft", label: "Draft" },
							{ value: "published", label: "Published" },
						]}
					/>
					<span className="lynx-grow" />
					<Button variant="secondary" onClick={props.onClose}>
						Cancel
					</Button>
					<Button variant="primary" loading={busy} onClick={() => void create()}>
						Create
					</Button>
				</>
			}
		>
			{general ? <p className="lynx-text-danger" role="alert">{general}</p> : null}
			<div className="lynx-newform">
				{shown.map((f) => (
					<NewField key={f.key} field={f} value={values[f.key]} problem={problems[f.key]} terms={f.type === "terms" ? props.terms.get(f.key.slice("terms:".length)) : undefined} onChange={(v) => set(f.key, v)} />
				))}
			</div>
			{later.length ? <p className="lynx-hint">Added after creating, in the grid: {later.map((f) => f.label).join(", ")}.</p> : null}
		</SlidePanel>
	);
}

function NewField(props: { field: FieldInfo; value: string | boolean | string[] | undefined; problem?: string; terms?: TermIndex; onChange: (v: string | boolean | string[]) => void }) {
	const { field: f, value, problem } = props;
	const id = `lynx-new-${f.key.replace(/[^a-z0-9_-]/gi, "-")}`;
	const rules = f.rules as { min?: number; max?: number } | undefined;
	const range = rules && (rules.min !== undefined || rules.max !== undefined) ? ` (${rules.min ?? "…"}–${rules.max ?? "…"})` : "";
	const label = (
		<label className="lynx-newform__label" htmlFor={id}>
			{f.label}
			{f.required ? <span className="lynx-text-danger"> *</span> : null}
			{range ? <span className="lynx-hint">{range}</span> : null}
		</label>
	);
	let control: React.ReactNode;
	if (f.type === "boolean") control = <Switch label={f.label} checked={value === true} onCheckedChange={(c) => props.onChange(c)} />;
	else if (f.type === "select")
		control = <KSelect label={f.label} value={typeof value === "string" ? value : ""} placeholder="Choose…" onChange={props.onChange} options={[{ value: "", label: "—" }, ...(f.options ?? []).map((o) => ({ value: o, label: o }))]} />;
	else if (f.type === "multiSelect")
		control = (
			<ul className="lynx-checklist lynx-checklist--inline">
				{(f.options ?? []).map((o) => {
					const picked = Array.isArray(value) ? value : [];
					return (
						<li key={o}>
							<Checkbox label={o} checked={picked.includes(o)} onCheckedChange={() => props.onChange(picked.includes(o) ? picked.filter((x) => x !== o) : [...picked, o])} />
						</li>
					);
				})}
			</ul>
		);
	else if (f.type === "terms") control = <NewTerms field={f} index={props.terms} picked={Array.isArray(value) ? value : []} onChange={props.onChange} />;
	else if (f.type === "text") control = <textarea id={id} className="lynx-input" rows={3} value={typeof value === "string" ? value : ""} onChange={(e) => props.onChange(e.target.value)} />;
	else
		control = (
			<Input
				id={id}
				size="sm"
				aria-label={f.label}
				type={f.type === "datetime" ? "datetime-local" : f.type === "url" ? "url" : "text"}
				inputMode={f.type === "number" || f.type === "integer" ? "decimal" : undefined}
				value={typeof value === "string" ? value : ""}
				onChange={(e) => props.onChange(e.target.value)}
			/>
		);
	return (
		<div className={`lynx-newform__row ${problem ? "is-failed" : ""}`}>
			{f.type === "boolean" ? null : label}
			{control}
			{problem ? <span className="lynx-text-danger lynx-newform__problem">{problem}</span> : null}
		</div>
	);
}

/** Terms of a new entry: radio buttons for a one-term taxonomy (a car has one make), checkboxes otherwise; with a search. */
function NewTerms(props: { field: FieldInfo; index: TermIndex | undefined; picked: string[]; onChange: (v: string[]) => void }) {
	const [q, setQ] = React.useState("");
	const all = termOptions(props.index?.list ?? []);
	const shown = searchTermOptions(all, q, props.picked);
	const single = props.field.single === true;
	return (
		<div className="lynx-termpick">
			{all.length > 12 ? <Input size="sm" type="search" placeholder={`Find ${props.field.label.toLowerCase()}…`} aria-label={`Find ${props.field.label}`} value={q} onChange={(e) => setQ(e.target.value)} /> : null}
			<ul className="lynx-checklist lynx-checklist--inline" role={single ? "radiogroup" : undefined} aria-label={props.field.label}>
				{shown.length === 0 ? <li className="lynx-hint">Nothing matches.</li> : null}
				{shown.map((o) => (
					<li key={o.id} style={{ paddingInlineStart: o.depth * 14 }}>
						{single ? (
							<label className="lynx-check">
								<input type="radio" name={`new-${props.field.key}`} checked={props.picked[0] === o.id} onChange={() => props.onChange([o.id])} />
								{o.label}
							</label>
						) : (
							<Checkbox label={o.label} checked={props.picked.includes(o.id)} onCheckedChange={() => props.onChange(props.picked.includes(o.id) ? props.picked.filter((x) => x !== o.id) : [...props.picked, o.id])} />
						)}
					</li>
				))}
			</ul>
		</div>
	);
}
