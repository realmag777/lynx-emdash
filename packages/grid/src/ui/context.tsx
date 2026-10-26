import { Toast } from "@cloudflare/kumo";
import * as React from "react";

import { CoreApi, GridApi, LynxApiError } from "../model/api.ts";

// Shared services of the grid page: the core client (writes, schema, selections), the grid's
// own read client, and notifications through the admin's Kumo toasts (the admin shell renders
// the <Toasty> viewport, so toasts look and stack like every other admin message).

export const ApiContext = React.createContext<CoreApi>(new CoreApi());
export const useApi = () => React.useContext(ApiContext);

export const GridApiContext = React.createContext<GridApi>(new GridApi());
export const useGridApi = () => React.useContext(GridApiContext);

export type ToastKind = "info" | "success" | "warning" | "error";
type Notify = (kind: ToastKind, title: string, text?: string) => void;

export function useNotify(): Notify {
	// Without the admin's toast provider (a second Kumo copy: the version guard says so) the
	// grid still works; messages go to the console instead.
	let manager: ReturnType<typeof Toast.useToastManager> | null;
	try {
		manager = Toast.useToastManager();
	} catch {
		manager = null;
	}
	// The function must stay the same for the life of the page: the toast manager object changes
	// with every toast, and effects that list notify as a dependency (loading the collection)
	// would otherwise run again after each message, rebuilding the table and losing the scroll.
	const current = React.useRef(manager);
	current.current = manager;
	return React.useCallback<Notify>((kind, title, text) => {
		const m = current.current;
		if (!m) {
			(kind === "error" ? console.error : console.info)(`LYNX Grid: ${title}${text ? ` - ${text}` : ""}`);
			return;
		}
		m.add({ title, ...(text ? { description: text } : {}), ...(kind === "info" ? {} : { type: kind }), timeout: kind === "error" ? 9000 : 4500 });
	}, []);
}

/** Readable message of anything thrown by a core or grid call. */
export function errorText(err: unknown): string {
	if (err instanceof LynxApiError) return err.message || err.code;
	if (err instanceof Error) return err.message;
	return String(err);
}

/** Media query hook (mobile cards below 768 px, like Botoscope). */
export function useMedia(query: string): boolean {
	const get = () => (typeof window !== "undefined" && window.matchMedia ? window.matchMedia(query).matches : false);
	const [match, setMatch] = React.useState(get);
	React.useEffect(() => {
		if (!window.matchMedia) return;
		const m = window.matchMedia(query);
		const on = () => setMatch(m.matches);
		on();
		m.addEventListener("change", on);
		// Some embedded or emulated viewports resize without a media change event.
		window.addEventListener("resize", on);
		return () => {
			m.removeEventListener("change", on);
			window.removeEventListener("resize", on);
		};
	}, [query]);
	return match;
}
