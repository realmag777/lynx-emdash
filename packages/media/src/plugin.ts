import type { SandboxedPlugin } from "emdash/plugin";
import { z } from "zod";

import { importImages, MAX_IMAGES, SAFE_PER_CALL } from "./import.ts";

// zod is referenced only inside the `mcp` block, which the plugin build strips from the
// runtime bundle (same rule as the LYNX core).

const plugin: SandboxedPlugin = {
	routes: {
		import: {
			permission: "content:edit_any",
			handler: async (r, ctx) => importImages(r, ctx),
		},
	},

	mcp: {
		tools: {
			import_media: {
				description: `Writes (adds files to the media library). Part of LYNX Media, the companion of the LYNX plugin. Downloads up to ${MAX_IMAGES} images from http(s) addresses and adds them to the media library; in the sandbox one call does ${SAFE_PER_CALL} and returns the rest in remaining: call again with them straight away. imported gives for each URL the value an image field takes. Put it into entries only through LYNX - lynx__create_entries rows, or lynx__update_entry / lynx__apply_bulk (e.g. {"field":"cover","behavior":"set","value":<value>}); a gallery takes [{"image":<value>}, ...] - so the change is in LYNX history and can be rolled back. The files stay in the media library; EmDash's media_delete removes one nobody uses. Only images, at most 8 MB each; addresses on private networks are refused.`,
				route: "import",
				input: z.object({
					images: z
						.array(
							z.object({
								url: z.string().describe("http(s) address of the image."),
								alt: z.string().max(500).optional().describe("Alternative text for the image."),
								filename: z.string().max(120).optional(),
							}),
						)
						.min(1)
						.max(MAX_IMAGES),
				}),
				output: z.looseObject({}),
				destructive: false,
			},
		},
	},
};

export default plugin;
