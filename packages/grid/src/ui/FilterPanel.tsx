import { Button, Checkbox, Input, Tabs } from "@cloudflare/kumo";
import { Plus, Trash } from "@phosphor-icons/react";
import * as React from "react";

import type { FieldInfo } from "../model/api.ts";
import { emptyFilter, filterFields, needsValue, unindexedFields, OP_LABEL, opsFor, type FilterOp, type FilterState } from "../model/filter.ts";
import { searchTermOptions, termOptions, type TermIndex } from "./cells.tsx";
import { IconButton, KSelect } from "./kit.tsx";
import { SlidePanel } from "./SlidePanel.tsx";

// Filter builder: status, field conditions and taxonomy conditions. The grid reads the
// matching rows with its own route; a bulk edit on "all matching" freezes the same filter
// as a core selection.

let seq = 0;
const nid = () => `c${Date.now().toString(36)}${seq++}`;

export function FilterPanel(props: { open: boolean; onClose: () => void; fields: FieldInfo[]; taxonomies: Array<{ name: string; label: string }>; terms: Map<string, TermIndex>; value: FilterState; onApply: (f: FilterState) => void }) {
	const { fields, taxonomies, terms } = props;
	const [draft, setDraft] = React.useState<FilterState>(props.value);
	React.useEffect(() => {
		if (props.open) setDraft(props.value);
	}, [props.open, props.value]);
	const usable = filterFields(fields);
	const byKey = new Map(usable.map((f) => [f.key, f]));

	const setCond = (id: string, patch: Partial<FilterState["conditions"][number]>) => setDraft((d) => ({ ...d, conditions: d.conditions.map((c) => (c.id === id ? { ...c, ...patch } : c)) }));
	const setTerm = (id: string, patch: Partial<FilterState["terms"][number]>) => setDraft((d) => ({ ...d, terms: d.terms.map((t) => (t.id === id ? { ...t, ...patch } : t)) }));

	return (
		<SlidePanel
			open={props.open}
			onClose={props.onClose}
			title="Filter entries"
			subtitle="Conditions are combined with AND. Bulk edits on “all matching” use the same filter."
			size="md"
			footer={
				<>
					<Button variant="ghost" onClick={() => setDraft({ ...emptyFilter(), search: draft.search })}>
						Clear all
					</Button>
					<span className="lynx-grow" />
					<Button variant="secondary" onClick={props.onClose}>
						Cancel
					</Button>
					<Button
						variant="primary"
						onClick={() => {
							props.onApply(draft);
							props.onClose();
						}}
					>
						Apply filter
					</Button>
				</>
			}
		>
			<section className="lynx-section">
				<h3 className="lynx-h3">Status</h3>
				<Tabs
					variant="segmented"
					size="sm"
					value={draft.status}
					onValueChange={(v) => setDraft((d) => ({ ...d, status: v as FilterState["status"] }))}
					tabs={[
						{ value: "any", label: "Any" },
						{ value: "published", label: "Published" },
						{ value: "draft", label: "Draft" },
					]}
				/>
			</section>

			<section className="lynx-section">
				<h3 className="lynx-h3">Fields</h3>
				{unindexedFields(fields).length ? (
					<p className="lynx-hint">
						Only indexed fields can be filtered. Not indexed: {unindexedFields(fields).map((f) => f.label).join(", ")} — index them with the gear ⚙ on their column or in Settings.
					</p>
				) : null}
				{draft.conditions.length === 0 ? <p className="lynx-hint">No field conditions.</p> : null}
				{draft.conditions.map((c) => {
					const f = byKey.get(c.field);
					const ops = f ? opsFor(f) : [];
					return (
						<div key={c.id} className="lynx-cond">
							<KSelect
								label="Field"
								value={c.field}
								placeholder="Choose a field…"
								onChange={(v) => {
									const next = byKey.get(v);
									setCond(c.id, { field: v, op: next ? opsFor(next)[0]! : "eq", value: next?.type === "boolean" ? "true" : "" });
								}}
								options={usable.map((x) => ({ value: x.key, label: x.label }))}
							/>
							<KSelect label="Condition" value={c.op} disabled={!f} onChange={(v) => setCond(c.id, { op: v as FilterOp })} options={ops.map((op) => ({ value: op, label: OP_LABEL[op] }))} />
							{f && needsValue(c.op) ? (
								f.type === "boolean" ? (
									<KSelect
										label="Value"
										value={c.value || "true"}
										onChange={(v) => setCond(c.id, { value: v })}
										options={[
											{ value: "true", label: "Yes" },
											{ value: "false", label: "No" },
										]}
									/>
								) : f.type === "select" && (c.op === "eq" || c.op === "ne") ? (
									<KSelect label="Value" value={c.value} placeholder="Choose…" onChange={(v) => setCond(c.id, { value: v })} options={(f.options ?? []).map((o) => ({ value: o, label: o }))} />
								) : (
									<Input
										size="sm"
										aria-label="Value"
										type={f.type === "datetime" ? "date" : "text"}
										inputMode={f.type === "number" || f.type === "integer" ? "decimal" : undefined}
										placeholder={c.op === "in" || c.op === "not_in" ? "a, b, c" : "Value"}
										value={c.value}
										onChange={(e) => setCond(c.id, { value: e.target.value })}
									/>
								)
							) : (
								<span />
							)}
							<IconButton label="Remove condition" icon={<Trash />} onClick={() => setDraft((d) => ({ ...d, conditions: d.conditions.filter((x) => x.id !== c.id) }))} />
						</div>
					);
				})}
				<Button variant="ghost" size="sm" icon={<Plus />} onClick={() => setDraft((d) => ({ ...d, conditions: [...d.conditions, { id: nid(), field: "", op: "contains", value: "" }] }))}>
					Add condition
				</Button>
			</section>

			{taxonomies.length ? (
				<section className="lynx-section">
					<h3 className="lynx-h3">Taxonomies</h3>
					{draft.terms.map((t) => {
						const opts = termOptions(terms.get(t.taxonomy)?.list ?? []);
						return (
							<div key={t.id} className="lynx-cond lynx-cond--terms">
								<KSelect label="Taxonomy" value={t.taxonomy} onChange={(v) => setTerm(t.id, { taxonomy: v, ids: [] })} options={taxonomies.map((x) => ({ value: x.name, label: x.label }))} />
								<KSelect
									label="Match"
									value={t.mode}
									onChange={(v) => setTerm(t.id, { mode: v as "any" | "all" | "none" })}
									options={[
										{ value: "any", label: "has any of" },
										{ value: "all", label: "has all of" },
										{ value: "none", label: "has none of" },
									]}
								/>
								<IconButton label="Remove condition" icon={<Trash />} onClick={() => setDraft((d) => ({ ...d, terms: d.terms.filter((x) => x.id !== t.id) }))} />
								<TermPicker opts={opts} picked={t.ids} label={taxonomies.find((x) => x.name === t.taxonomy)?.label ?? "terms"} onToggle={(id) => setTerm(t.id, { ids: t.ids.includes(id) ? t.ids.filter((x) => x !== id) : [...t.ids, id] })} />
							</div>
						);
					})}
					<Button variant="ghost" size="sm" icon={<Plus />} onClick={() => setDraft((d) => ({ ...d, terms: [...d.terms, { id: nid(), taxonomy: taxonomies[0]!.name, mode: "any", ids: [] }] }))}>
						Add taxonomy condition
					</Button>
				</section>
			) : null}
		</SlidePanel>
	);
}

/** The terms of one condition: a search over the tree (2026-10-05: hundreds of models) and checkboxes. */
function TermPicker({ opts, picked, label, onToggle }: { opts: Array<{ id: string; label: string; depth: number }>; picked: string[]; label: string; onToggle: (id: string) => void }) {
	const [q, setQ] = React.useState("");
	const shown = searchTermOptions(opts, q, picked);
	return (
		<div className="lynx-termpick">
			<Input size="sm" type="search" placeholder={`Find ${label.toLowerCase()}…`} aria-label={`Find ${label}`} value={q} onChange={(e) => setQ(e.target.value)} />
			{picked.length ? <span className="lynx-hint">{picked.length} chosen</span> : null}
			<ul className="lynx-checklist lynx-checklist--inline" aria-label="Terms">
				{shown.length === 0 ? <li className="lynx-hint">Nothing matches.</li> : null}
				{shown.map((o) => (
					<li key={o.id} style={{ paddingInlineStart: o.depth * 14 }}>
						<Checkbox label={o.label} checked={picked.includes(o.id)} onCheckedChange={() => onToggle(o.id)} />
					</li>
				))}
			</ul>
		</div>
	);
}
