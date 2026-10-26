import type { SandboxedPlugin } from "emdash/plugin";

import { actorOf, routes, settings } from "./api.ts";
import { adminRoute } from "./core/admin.ts";
import { CRON_TASK, ensureCron, runStep } from "./core/jobs.ts";
import { budgetFor, Meter } from "./core/meter.ts";
import { stores } from "./core/store.ts";
import { mcpTools } from "./mcp.ts";

const plugin: SandboxedPlugin = {
	hooks: {
		"plugin:activate": async (_event, ctx) => {
			await ensureCron(ctx);
		},
		cron: async (event, ctx) => {
			if (event.name !== CRON_TASK) return;
			const m = new Meter(ctx, budgetFor("auto"));
			const running = await stores(m.ctx).jobs.query({ where: { state: "running" }, orderBy: { createdAt: "asc" }, limit: 1 });
			const next = running.items[0];
			if (next) await runStep(m, next.id);
		},
	},

	routes: {
		...routes,
		admin: {
			permission: "content:edit_any",
			handler: async (r, ctx) => adminRoute(r, ctx, settings, actorOf(r)),
		},
	},

	mcp: { tools: mcpTools() },
};

export default plugin;
