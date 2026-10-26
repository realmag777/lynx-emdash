# LYNX — bulk editor and AI-agent tools for EmDash

LYNX is a content manager for [EmDash CMS](https://github.com/emdash-cms/emdash): edit thousands of
entries like a spreadsheet, change them in bulk with a before → after preview, let an AI agent do
the same through MCP — and roll back any change from the history.

![The LYNX Grid on 10,000 cars](docs/screens/registry/01-grid.png)

- **Spreadsheet editing.** Edit in the cells, move with the keyboard, paste a column from Excel or
  Google Sheets, filter and sort by indexed fields, save views, pin and resize columns; photos and
  galleries, rich text, dates and terms have their own editors.
- **Bulk edits you can trust.** Pick entries by a filter, choose the change (set, add text, ±%,
  round, replace, terms, publish…), see every value before and after, then apply. Every job is
  recorded first and can be rolled back, entry by entry.
- **AI agent through MCP.** Claude, ChatGPT or any MCP client can find, preview, apply and roll back
  changes with the same rules: it must show the count and the preview and wait for your yes.
- **Built for big catalogues.** Tested on 50,000 entries: the first page in ~60 ms, page 10,000 in
  ~40 ms, about 7 MB of memory for the whole collection.

| Bulk edit with preview | History and rollback |
|---|---|
| ![Bulk preview](docs/screens/registry/02-bulk-preview.png) | ![History](docs/screens/registry/03-history.png) |

## Packages

| Package | What it is |
|---|---|
| [`@realmag777/lynx`](packages/plugin) | The core: a sandboxed EmDash plugin with the jobs, history, rollback, the admin page and 17 MCP tools. Every write goes through it. |
| [`@realmag777/lynx-grid`](packages/grid) | LYNX Grid: the spreadsheet page in the EmDash admin (a native plugin). |
| [`@realmag777/lynx-media`](packages/media) | LYNX Media: imports images by URL into the media library (for the grid and agents). |
| [`@realmag777/lynx-engine`](packages/engine) | The shared engine: filters, operations, validation, planning and history records. |
| [`@realmag777/lynx-presets`](presets) | Demo collections (cars, real estate) with photos, to try LYNX on a fresh site. |

## Install

1. **LYNX core** — from the EmDash plugin registry (Admin → Plugins), or in `astro.config.mjs`:

   ```js
   import lynx from "@realmag777/lynx";
   // emdash({ sandboxed: [lynx], sandboxRunner: … })
   ```

2. **LYNX Grid** — a native plugin, added once by the site's developer:

   ```bash
   npm install @realmag777/lynx-grid
   ```

   ```js
   import { lynxGrid } from "@realmag777/lynx-grid";
   // emdash({ plugins: [lynxGrid()] }), and in the same defineConfig:
   // vite: { optimizeDeps: { include: ["@cloudflare/kumo", "@phosphor-icons/react"] } }
   ```

   Then build and deploy the site; **LYNX Grid** appears in the admin menu.

3. **AI agent (optional)** — switch on *Agent access* for LYNX in Admin → Plugins, create an API
   token with the LYNX tools scope and point your MCP client at `https://your-site/_emdash/api/mcp`.

The full guide — the grid, bulk edits, history, agents, presets, settings and troubleshooting — is
in [docs/user-guide.md](docs/user-guide.md).

## Develop

```bash
pnpm install
pnpm test   # every package: engine, core (with the sandbox bundle-size check), media, grid, presets
```

Tested with Node.js 24 and 26, pnpm 11.

## Author and licence

Made by **Rostislav Sofronov** (realmag777) — [realmag777.com](https://realmag777.com).

MIT licence: see [LICENSE](LICENSE).
