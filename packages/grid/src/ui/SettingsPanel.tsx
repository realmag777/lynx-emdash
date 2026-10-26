import { Tabs } from "@cloudflare/kumo";
import * as React from "react";

import type { FieldInfo } from "../model/api.ts";
import { indexable, isIndexed } from "../model/schema.ts";
import { IndexToggle } from "./IndexToggle.tsx";
import { SlidePanel } from "./SlidePanel.tsx";

// LYNX Grid settings (2026-10-01): a side panel with tabs. For now one tab, Basic, with the
// indexes of the fields of the open collection.

export function SettingsPanel(props: { open: boolean; onClose: () => void; collection: string; collectionLabel: string; fields: FieldInfo[]; entries: number | null; canManage: boolean | null; onChanged: () => void }) {
	const [tab, setTab] = React.useState("basic");
	const list = props.fields.filter(indexable);
	const on = list.filter(isIndexed).length;
	return (
		<SlidePanel open={props.open} onClose={props.onClose} title="Settings" subtitle={`LYNX Grid · ${props.collectionLabel}`} size="md">
			<Tabs variant="segmented" size="sm" value={tab} onValueChange={(v) => setTab(String(v))} tabs={[{ value: "basic", label: "Basic" }]} />
			{tab === "basic" ? (
				<section className="lynx-section lynx-settings">
					<h3 className="lynx-h3">Indexing</h3>
					<p className="lynx-hint">
						The grid sorts and filters by indexed fields only: their values come from the database's index, and the grid keeps just those values and the ids
						{props.entries !== null ? ` of the ${props.entries.toLocaleString()} entries` : ""}, never whole entries. A field without an index shows a hint in its header instead. An index takes a little space and makes saving a little
						slower: index the fields people sort or filter by. {on} of {list.length} indexed.
					</p>
					<ul className="lynx-settings__fields">
						{list.map((f) => (
							<li key={f.key} className="lynx-settings__field">
								<div>
									<div className="lynx-strong">{f.label}</div>
									<div className="lynx-hint">
										{f.key} · {f.type}
									</div>
								</div>
								<IndexToggle collection={props.collection} field={f} entries={props.entries} canManage={props.canManage} onChanged={props.onChanged} compact />
							</li>
						))}
					</ul>
				</section>
			) : null}
		</SlidePanel>
	);
}
