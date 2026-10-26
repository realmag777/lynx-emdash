import * as React from "react";

// A horizontal scrollbar that floats at the bottom of the window while the table is on screen
// (2026-10-05, as in BEAR: the table is as tall as its page, so the native scrollbar sat
// under the last row, out of reach). Drawn by the grid: drag the thumb, click the track to move
// by a screen, or scroll sideways on the table as before; the table's own scrollbar is hidden.

const MIN_THUMB = 48;

/** The element the admin page scrolls in (or the window). */
export function scrollParent(el: HTMLElement): HTMLElement | Window {
	for (let n = el.parentElement; n; n = n.parentElement) {
		const oy = getComputedStyle(n).overflowY;
		if (oy === "auto" || oy === "scroll") return n;
	}
	return window;
}

export function FloatingScrollbar(props: { target: React.RefObject<HTMLElement | null> }) {
	const track = React.useRef<HTMLDivElement>(null);
	const [m, setM] = React.useState({ left: 0, client: 0, width: 0, track: 0, pad: 0 });

	React.useEffect(() => {
		const el = props.target.current;
		if (!el) return;
		// The admin's scroll area has a bottom padding: the bar sits over it, at the window's edge.
		const parent = scrollParent(el);
		const pad = parent === window ? 0 : Number.parseFloat(getComputedStyle(parent as HTMLElement).paddingBottom) || 0;
		const measure = () => setM({ left: el.scrollLeft, client: el.clientWidth, width: el.scrollWidth, track: track.current?.clientWidth ?? el.clientWidth, pad });
		measure();
		el.addEventListener("scroll", measure, { passive: true });
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		if (el.firstElementChild) ro.observe(el.firstElementChild);
		return () => {
			el.removeEventListener("scroll", measure);
			ro.disconnect();
		};
	}, [props.target]);

	const max = m.width - m.client;
	if (max <= 1) return null;
	const thumbW = Math.max(MIN_THUMB, (m.client / m.width) * m.track);
	const room = Math.max(1, m.track - thumbW);
	const thumbX = (m.left / max) * room;

	const drag = (e: React.PointerEvent<HTMLDivElement>) => {
		const el = props.target.current;
		if (!el) return;
		e.preventDefault();
		e.stopPropagation();
		const thumb = e.currentTarget;
		thumb.setPointerCapture(e.pointerId);
		const startX = e.clientX;
		const startLeft = el.scrollLeft;
		const move = (ev: PointerEvent) => {
			el.scrollLeft = startLeft + ((ev.clientX - startX) * max) / room;
		};
		const up = () => {
			thumb.removeEventListener("pointermove", move);
			thumb.removeEventListener("pointerup", up);
			thumb.removeEventListener("pointercancel", up);
		};
		thumb.addEventListener("pointermove", move);
		thumb.addEventListener("pointerup", up);
		thumb.addEventListener("pointercancel", up);
	};

	const page = (e: React.PointerEvent<HTMLDivElement>) => {
		const el = props.target.current;
		const t = track.current;
		if (!el || !t) return;
		const x = e.clientX - t.getBoundingClientRect().left;
		el.scrollBy({ left: x < thumbX ? -el.clientWidth * 0.9 : el.clientWidth * 0.9, behavior: "smooth" });
	};

	return (
		<div className="lynx-hbar" aria-hidden style={m.pad ? { bottom: -m.pad } : undefined}>
			<div className="lynx-hbar__track" ref={track} onPointerDown={page}>
				<div className="lynx-hbar__thumb" style={{ width: thumbW, transform: `translateX(${thumbX}px)` }} onPointerDown={drag} />
			</div>
		</div>
	);
}
