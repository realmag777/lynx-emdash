// The web copies of the preset photos (media/cars, media/properties), as URLs the site's Vite build
// bundles. Relative to this package, so it works from node_modules as well as from the monorepo.
// Outside Vite (Node tools, tests) there is no import.meta.glob and the list is empty.

declare global {
	interface ImportMeta {
		glob?: (pattern: string, options: { query: string; import: string; eager: true }) => Record<string, string>;
	}
}

export const PRESET_PHOTOS: Record<string, string> = (() => {
	try {
		return import.meta.glob!("../media/{cars,properties}/*.jpg", { query: "?url", import: "default", eager: true });
	} catch {
		return {};
	}
})();
