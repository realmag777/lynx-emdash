// Types of Calendar23 (realmag777, MIT), copied from Botoscope: see calendar23.js.
export default class Calendar23 {
	constructor(
		container: HTMLElement,
		scene?: 0 | 1 | 2,
		calendar_id?: string | null,
		unix_time_stamp?: number | null,
		additional?: { show_time?: boolean; month_names?: string[]; month_names_short?: string[]; day_names?: string[] },
	);
	calendar_id: string;
}

/** Fired on document when a date is chosen: unix seconds of the wall-clock date (read as UTC). */
export interface Calendar23Selected {
	date: number;
	hour?: number;
	minute?: number;
	calendar_id: string;
}
