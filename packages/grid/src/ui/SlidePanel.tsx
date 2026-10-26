import { X } from "@phosphor-icons/react";
import * as React from "react";
import { createPortal } from "react-dom";

// Botoscope's side panel: slides in from the right in 350 ms, round close button on its left
// edge, stackable (nested panels are narrower). Added for LYNX: a scrim, Esc to close, a focus
// trap and aria-modal, and focus returned to the opener on close.

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function SlidePanel(props: { open: boolean; onClose: () => void; title: string; subtitle?: React.ReactNode; size?: "lg" | "md" | "wide"; footer?: React.ReactNode; children: React.ReactNode }) {
	const { open, onClose, title, subtitle, size = "lg", footer, children } = props;
	const [mounted, setMounted] = React.useState(open);
	const [shown, setShown] = React.useState(false);
	const panel = React.useRef<HTMLDivElement>(null);
	const opener = React.useRef<Element | null>(null);
	const titleId = React.useId();

	React.useEffect(() => {
		if (open) {
			opener.current = document.activeElement;
			setMounted(true);
			// A timer, not requestAnimationFrame: rAF does not run in hidden tabs. Reading the layout
			// first commits the off-screen position, so the slide still animates.
			const t = window.setTimeout(() => {
				panel.current?.getBoundingClientRect();
				setShown(true);
			}, 20);
			return () => window.clearTimeout(t);
		}
		setShown(false);
		const t = window.setTimeout(() => {
			setMounted(false);
			if (opener.current instanceof HTMLElement) opener.current.focus();
		}, 360);
		return () => window.clearTimeout(t);
	}, [open]);

	// While a panel is open, Kumo popups (selects, menus, dialogs, tooltips: base-ui portals
	// without a z-index) must stack above it; the class scopes that rule to this moment.
	React.useEffect(() => {
		if (!mounted) return;
		document.body.classList.add("lynx-has-panel");
		return () => document.body.classList.remove("lynx-has-panel");
	}, [mounted]);

	React.useEffect(() => {
		if (shown) panel.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus() ?? panel.current?.focus();
	}, [shown]);

	const onKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Escape") {
			e.stopPropagation();
			onClose();
			return;
		}
		if (e.key !== "Tab" || !panel.current) return;
		const items = Array.from(panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null);
		if (!items.length) return;
		const first = items[0]!;
		const last = items[items.length - 1]!;
		if (e.shiftKey && document.activeElement === first) {
			e.preventDefault();
			last.focus();
		} else if (!e.shiftKey && document.activeElement === last) {
			e.preventDefault();
			first.focus();
		}
	};

	if (!mounted) return null;
	return createPortal(
		<div className={`lynx-root lynx-slide ${shown ? "is-open" : ""}`} onKeyDown={onKeyDown}>
			<div className="lynx-slide__scrim" onClick={onClose} aria-hidden />
			<div ref={panel} className={`lynx-slide__panel lynx-slide__panel--${size}`} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
				<button type="button" className="lynx-slide__close" aria-label="Close panel" onClick={onClose}>
					<X size={18} weight="bold" />
				</button>
				<header className="lynx-slide__head">
					<h2 id={titleId} className="lynx-slide__title">
						{title}
					</h2>
					{subtitle ? <div className="lynx-slide__subtitle">{subtitle}</div> : null}
				</header>
				<div className="lynx-slide__body">{children}</div>
				{footer ? <footer className="lynx-slide__foot">{footer}</footer> : null}
			</div>
		</div>,
		document.body,
	);
}
