# @realmag777/lynx-grid — LYNX Grid for EmDash

A spreadsheet page in the EmDash admin for the [LYNX](../../docs/user-guide.md) content manager:
edit entries in cells, copy and paste from spreadsheets, filter and sort, save views, bulk edit
with a before → after preview, and roll back any job from the history, including the ones AI
agents made.

The grid is a native plugin (`lynx-grid`). It **reads** with its own routes and read-only
capabilities (content, revisions, schema, taxonomies) and **writes only through the LYNX core
plugin**, so every change is a LYNX job with history and rollback. Two admin actions run as the
signed-in user through EmDash's own REST API: installing demo data (collections and fields) and
removing drafts that are identical to the published version.

## Requirements

- EmDash 1.0 with the **LYNX** plugin installed (sandboxed, from the registry).
- Optional: **LYNX Media** for importing images by URL.
- Peer dependencies, the same ones the EmDash admin uses: `react` and `react-dom` 19, `@cloudflare/kumo` 2.6,
  `@phosphor-icons/react` 2.1, `@emdash-cms/admin` 1.0.

## Install

```bash
npm install @realmag777/lynx-grid
```

```js
// astro.config.mjs
import emdash from "emdash/astro";
import { lynxGrid } from "@realmag777/lynx-grid";

export default defineConfig({
	integrations: [emdash({ plugins: [lynxGrid()] })],
	// Required: the EmDash admin is pre-bundled with its own Kumo; this makes the grid share it
	// (without it the grid gets a second copy and its messages do not show).
	vite: { optimizeDeps: { include: ["@cloudflare/kumo", "@phosphor-icons/react"] } },
});
```

Then open **LYNX Grid** in the admin menu.

## Version check

The grid is compiled into the admin's bundle and shares its React, Kumo, phosphor icons and
`@emdash-cms/admin`. When the page loads it compares them with its peer ranges:

- React's version from the browser (every host);
- the other packages from the site's `node_modules` through the grid's `versions` route (Node
  hosts; on Workers this part is skipped);
- a second copy of React (hooks would fail) or of Kumo (the admin's toasts are out of reach).

On a mismatch the page shows a banner with the exact fix, for example
`npm install @cloudflare/kumo@"^2.6.0"`, or the `optimizeDeps` setting above / `npm dedupe` for a
second copy. The banner is plain markup, the grid page runs inside an error boundary, and nothing
else in the admin is touched.

## What is inside

- `src/index.ts` — the plugin descriptor (`lynxGrid()`) and definition (routes, storage for saved
  views and number formats).
- `src/server/` — read routes: `rows` (a page of rows read whole by id, with terms and draft values; the order and the count
  come from the ids and indexed values the grid keeps per filter; only indexed fields sort and filter), `terms`, `preview` (bulk-edit preview over up to 500
  entries with the core's engine; applying stays with the core), `drafts/empty`, `galleries` (which repeaters are photo lists, edited in the photo panel), `media/search` (the photo panel's media library: search by title, description and file name, numbered pages), `cache` (what the grid keeps: one column store per collection — ids and indexed values — and the positions each filter holds), `versions`,
  `formats/*`, `views/*`.
- `src/admin.tsx`, `src/ui/` — the admin page (React, Kumo components, `.lynx-` CSS on Kumo tokens).
- `src/model/` — the grid's logic without React (columns, edits, filter, view, paste, keyboard,
  pagination), covered by unit tests.

## Keyboard

Arrows, Home/End, Page Up/Down and Tab move; Enter or F2 edits; Esc cancels; Space selects a row;
Ctrl+C / Ctrl+V copy and paste; Ctrl+S saves; Alt+Enter opens the entry; **?** lists everything.

See the [user guide](../../docs/user-guide.md) for the whole tour.

## Third-party code

- `src/vendor/calendar23.js` and `calendar23.css`: [Calendar23](https://github.com/realmag777/calendar23)
  by realmag777 (MIT), the date picker of Botoscope, with its licence header kept; two small fixes
  are marked `LYNX fix` in the file.
