import { Button, Dialog, Select, Tooltip } from "@cloudflare/kumo";
import * as React from "react";

// Thin helpers over Kumo, the admin's component library (2026-09-30: every control
// outside the table is a Kumo component, so the grid looks like part of EmDash).

export interface Option {
	value: string;
	label: React.ReactNode;
}

/** Kumo Select over a list of options; the value is always a string ("" allowed). */
export function KSelect(props: { value: string; onChange: (v: string) => void; options: Option[]; label: string; showLabel?: boolean; size?: "xs" | "sm" | "base" | "lg"; className?: string; disabled?: boolean; placeholder?: string }) {
	const { value, onChange, options, label, showLabel, size = "sm", className, disabled, placeholder } = props;
	return (
		<Select
			size={size}
			{...(showLabel ? { label } : { "aria-label": label })}
			{...(className ? { className } : {})}
			{...(disabled ? { disabled } : {})}
			{...(placeholder ? { placeholder } : {})}
			value={value}
			onValueChange={(v) => onChange(v == null ? "" : String(v))}
			items={Object.fromEntries(options.map((o) => [o.value, o.label]))}
		>
			{options.map((o) => (
				<Select.Option key={o.value} value={o.value}>
					{o.label}
				</Select.Option>
			))}
		</Select>
	);
}

/** Icon-only Kumo button with a tooltip and an accessible name. */
export function IconButton(props: { label: string; icon: React.ReactNode; onClick?: () => void; disabled?: boolean; variant?: "secondary" | "ghost" | "outline"; size?: "xs" | "sm" | "base"; pressed?: boolean }) {
	const { label, icon, onClick, disabled, variant = "ghost", size = "sm", pressed } = props;
	return <Tooltip content={label} render={<Button shape="square" size={size} variant={variant} icon={icon} aria-label={label} {...(pressed !== undefined ? { "aria-pressed": pressed } : {})} {...(disabled ? { disabled } : {})} {...(onClick ? { onClick } : {})} />} />;
}

/** Kumo confirmation dialog, controlled. */
export function ConfirmDialog(props: { open: boolean; title: string; text: React.ReactNode; confirm: string; destructive?: boolean; onConfirm: () => void; onCancel: () => void }) {
	return (
		<Dialog.Root open={props.open} onOpenChange={(o) => !o && props.onCancel()}>
			<Dialog className="p-6" size="sm">
				<Dialog.Title className="text-lg font-semibold">{props.title}</Dialog.Title>
				<Dialog.Description>{props.text}</Dialog.Description>
				<div className="mt-6 flex justify-end gap-2">
					<Button variant="secondary" onClick={props.onCancel}>
						Cancel
					</Button>
					<Button variant={props.destructive ? "destructive" : "primary"} onClick={props.onConfirm}>
						{props.confirm}
					</Button>
				</div>
			</Dialog>
		</Dialog.Root>
	);
}

const SHORTCUTS: Array<[string, string]> = [
	["↑ ↓ ← →", "Move between cells"],
	["Home / End", "First / last cell of the row (with Ctrl: of the page)"],
	["Page Up / Page Down", "Move a screen up or down"],
	["Tab / Shift+Tab", "Next / previous cell, wrapping to the next row"],
	["Enter or F2", "Edit the cell (Enter again keeps the value and moves down)"],
	["Typing", "Starts editing a text or number cell with that character"],
	["Esc", "Cancel the edit, or leave the active cell"],
	["Space", "Select the row (Shift: a range), or flip a yes/no cell"],
	["Delete / Backspace", "Clear the cell"],
	["Ctrl+C / Ctrl+V", "Copy the cell or the selected rows; paste from a spreadsheet"],
	["Ctrl+A", "Select every row on the page"],
	["Ctrl+S", "Save the changed cells"],
	["Alt+Enter", "Open the entry in the editor"],
	["? or F1", "This list"],
	["Header: ← → on a resize handle", "Change the column width (Shift: bigger steps)"],
];

/** The grid's keyboard shortcuts in a Kumo dialog. */
export function ShortcutsDialog(props: { open: boolean; onClose: () => void }) {
	return (
		<Dialog.Root open={props.open} onOpenChange={(o) => !o && props.onClose()}>
			<Dialog className="p-6" size="lg">
				<Dialog.Title className="text-lg font-semibold">Keyboard shortcuts</Dialog.Title>
				<Dialog.Description>The grid works without a mouse. Click a cell or tab into the grid first.</Dialog.Description>
				<table className="lynx-shortcuts">
					<tbody>
						{SHORTCUTS.map(([k, what]) => (
							<tr key={k}>
								<th scope="row">
									<kbd>{k}</kbd>
								</th>
								<td>{what}</td>
							</tr>
						))}
					</tbody>
				</table>
				<div className="mt-6 flex justify-end gap-2">
					<Button variant="primary" onClick={props.onClose}>
						Close
					</Button>
				</div>
			</Dialog>
		</Dialog.Root>
	);
}
