# @realmag777/lynx-media — LYNX Media for EmDash

Imports images by URL into the EmDash media library, for the LYNX Grid and for AI agents
(MCP tool `lynx-media__import_media`). A separate sandboxed plugin, so only it needs network
access; content is still written by the [LYNX core](https://www.npmjs.com/package/@realmag777/lynx).

```js
import lynxMedia from "@realmag777/lynx-media";
// emdash({ sandboxed: [lynx, lynxMedia], … })
```

Up to 20 URLs per call, 8 MB per image.

Made by Rostislav Sofronov (realmag777) — [realmag777.com](https://realmag777.com). MIT licence.
