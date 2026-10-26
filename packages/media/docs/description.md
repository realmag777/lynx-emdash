LYNX Media imports images from web addresses into your EmDash media library, for the LYNX plugin
and for AI agents that use it.

- One MCP tool, `lynx-media__import_media`: up to 20 addresses per call, images only, 8 MB each,
  private network addresses refused.
- It returns the value an image field takes. Entries get the picture only through LYNX
  (`create_entries`, `update_entry`, `apply_bulk`), so the change is in the LYNX history and can be
  rolled back.
- In the LYNX Grid, an image cell can import a picture by URL when LYNX Media is installed.

It is the only part of LYNX with network access, kept separate so the LYNX core needs none.
