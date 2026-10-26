1. Install **LYNX** from the registry and approve its capabilities (schema and content read,
   content write and publish, restore from the trash, assign terms). It needs no network access.
2. Optional: install **LYNX Media** for images by URL.
3. For the spreadsheet page, add the grid to your site:

   ```bash
   npm install @realmag777/lynx-grid
   ```

   ```js
   import { lynxGrid } from "@realmag777/lynx-grid";
   emdash({ plugins: [lynxGrid()] });
   ```

4. Open **LYNX Grid** in the admin. No content yet? Choose **Install demo data**.
5. For AI agents: Plugins → LYNX → switch **Agent access** on, then create an API token with the
   scope `mcp:tools:lynx` and connect your MCP client to `/_emdash/api/mcp`.

Node hosts: bulk jobs run about twice as fast with **Job step size: Fast** in the LYNX settings,
or with LYNX in-process (`npm install @realmag777/lynx`, then `plugins: [lynx]` instead of the
registry copy). On Cloudflare keep **Auto**.

Full guide: `docs/user-guide.md` in the package.
