# @realmag777/lynx — LYNX core for EmDash

The core of [LYNX](https://github.com/realmag777/lynx-emdash): a sandboxed EmDash plugin that
runs every content change as a job — find → preview → apply — recorded in history first, so any
job can be rolled back entry by entry. It serves the LYNX Grid, its own admin page and 17 MCP
tools for AI agents.

## Install

From the EmDash plugin registry (Admin → Plugins), or in `astro.config.mjs`:

```js
import lynx from "@realmag777/lynx";

export default defineConfig({
	integrations: [emdash({ sandboxed: [lynx], sandboxRunner: "@emdash-cms/sandbox-workerd/sandbox" })],
});
```

On a host without a sandbox runner it can run in-process: `emdash({ plugins: [lynx] })`.

## AI agent (MCP)

1. Admin → Plugins → LYNX → switch on **Agent access**.
2. Settings → API tokens → a token with **Plugin tools: lynx** plus content read/write.
3. Point your MCP client at `https://your-site/_emdash/api/mcp` with `Authorization: Bearer <token>`.

The agent must show the count and the preview and wait for your yes before it applies anything;
`rollback_bulk` undoes a job.

Add the spreadsheet editor with [`@realmag777/lynx-grid`](https://www.npmjs.com/package/@realmag777/lynx-grid).

Made by Rostislav Sofronov (realmag777) — [realmag777.com](https://realmag777.com). MIT licence.
