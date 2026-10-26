/**
 * LYNX Grid — native EmDash plugin (npm).
 *
 * An admin page with a spreadsheet-style editor. Every content WRITE goes through the routes
 * of the LYNX core (the sandboxed plugin `lynx`), so edits made here land in the same jobs and
 * history as bulk edits and AI-agent changes. Reads (pages of rows, terms, draft values) and
 * the user's saved views are this plugin's own routes: it runs in the site's process, without
 * the sandbox's call budget (2026-09-30).
 *
 * ```js
 * // astro.config.mjs
 * import lynx from "@realmag777/lynx";
 * import { lynxGrid } from "@realmag777/lynx-grid";
 * emdash({ sandboxed: [lynx], plugins: [lynxGrid()] });
 * ```
 *
 * The id is `lynx-grid`, not `lynx`: a native plugin with the core's id would silently
 * shadow the sandboxed core.
 */

import type { PluginContext, PluginDescriptor } from "emdash";
import { definePlugin } from "emdash";

import { shiftCount } from "./server/counts.ts";
import { invalidateCollection } from "./server/read.ts";
import { routes } from "./server/routes.ts";

export const GRID_PLUGIN_ID = "lynx-grid";
export const GRID_VERSION = "0.2.0";

/** Read-only access: rows, terms, draft revisions, and the media library for the photo panel (never a write). */
const CAPABILITIES = ["content:read", "content:revisions:read", "schema:read", "taxonomies:read", "media:read"] as const;

const CONTENT_HOOKS = ["content:afterSave", "content:afterPublish", "content:afterUnpublish", "content:afterDelete", "content:afterRestore", "content:afterSchedule", "content:afterUnschedule"] as const;

export function createPlugin() {
	return definePlugin({
		id: GRID_PLUGIN_ID,
		version: GRID_VERSION,
		capabilities: [...CAPABILITIES],
		storage: { views: { indexes: ["userId", "collection", ["userId", "collection"]] }, formats: { indexes: ["collection"] } },
		routes,
		// Any change to content, by anyone (the core, an AI agent, the entry editor, another admin),
		// drops the grid's cached reads of that collection in this process (2026-10-02).
		// The last known count of the collection follows creates, trashes and restores (shown as "≈").
		hooks: Object.fromEntries(
			CONTENT_HOOKS.map((name) => [
				name,
				async (event: { collection: string; isNew?: boolean; permanent?: boolean }, ctx: PluginContext) => {
					invalidateCollection(event.collection);
					const delta = name === "content:afterSave" ? (event.isNew ? 1 : 0) : name === "content:afterDelete" ? (event.permanent ? 0 : -1) : name === "content:afterRestore" ? 1 : 0;
					await shiftCount(ctx?.kv, event.collection, delta);
				},
			]),
		),
		// The page is listed here too: for a native plugin EmDash builds the admin menu from this
		// definition, not from the descriptor (without it the grid has no menu entry).
		admin: { entry: "@realmag777/lynx-grid/admin", pages: [{ path: "/", label: "LYNX Grid", icon: "grid" }] },
	});
}

export default createPlugin;

export function lynxGrid(): PluginDescriptor {
	return {
		id: GRID_PLUGIN_ID,
		version: GRID_VERSION,
		entrypoint: "@realmag777/lynx-grid",
		options: {},
		capabilities: [...CAPABILITIES],
		storage: { views: { indexes: ["userId", "collection"] }, formats: { indexes: ["collection"] } },
		adminEntry: "@realmag777/lynx-grid/admin",
		adminPages: [{ path: "/", label: "LYNX Grid", icon: "grid" }],
	};
}
