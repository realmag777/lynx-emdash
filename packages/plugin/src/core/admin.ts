import type { SandboxedRouteContext } from "emdash/plugin";

import { LynxError, toErrorResult } from "./errors.ts";
import type { Ctx } from "./host.ts";
import { cancelJob, ensureCron, createRollbackJob, getJob, progressOf, runStep, stepCalls, type Actor } from "./jobs.ts";
import { budgetFor, Meter, type StepSize } from "./meter.ts";
import { lastAgentSession } from "./site.ts";
import { stores, type JobDoc, type JobResult } from "./store.ts";

// Block Kit admin page: works right after a registry install, without the grid. It manages
// jobs (run, cancel, roll back) and agent access; editing lives in the grid and the MCP tools.
// A guided bulk form existed here until Stage 3: the sandbox bundle has a hard 128 KiB limit
// per file, and the grid and the agent both do it better.
// Stateless: every interaction re-renders the page; wizard state travels in form values
// and button values.

type Block = Record<string, unknown>;
interface Conf {
	stepSize: StepSize;
	cacheRefresh: "republish" | "none";
}

type Interaction =
	| { type: "page_load"; page?: string }
	| { type: "block_action"; action_id: string; value?: unknown };

const header = (text: string): Block => ({ type: "header", text });
const context = (text: string): Block => ({ type: "context", text });
const banner = (title: string, description: string, variant: "default" | "alert" | "error" = "default"): Block => ({ type: "banner", title, description, variant });

function resultText(r: JobResult): string {
	const parts = [
		`${r.written} written`,
		...(r.held ? [`${r.held} held (pending drafts)`] : []),
		...(r.invalid ? [`${r.invalid} invalid`] : []),
		...(r.conflicts ? [`${r.conflicts} conflicts`] : []),
		...(r.failed ? [`${r.failed} failed`] : []),
	];
	return parts.join(", ");
}

const clip = (s: string) => (s.length > 90 ? `${s.slice(0, 89)}…` : s);

function jobRow(j: JobDoc) {
	const p = progressOf(j);
	const items = [
		...(j.state === "running" ? [{ label: "Run next steps", value: `step:${j.jobKey}` }, { label: "Cancel", value: `cancel:${j.jobKey}` }] : []),
		...(j.kind !== "rollback" && !j.rolledBackBy && j.state !== "rolled_back" ? [{ label: "Roll back", value: `rollback:${j.jobKey}` }] : []),
	];
	return {
		started: j.createdAt,
		summary: clip(j.summary),
		entries: j.total,
		progress: j.state === "running" ? `${p.percent}%` : j.result ? resultText(j.result) : "",
		state: j.state.replace("_", " "),
		by: j.userName ?? "",
		via: j.viaMcp ? "AI agent" : "Person",
		...(items.length ? { actions: { type: "menu", action_id: "job_menu", label: "Actions", items } } : {}),
	};
}

async function overview(ctx: Ctx, flash?: Block[]): Promise<{ blocks: Block[] }> {
	const s = stores(ctx);
	const [cols, jobs, running, agent] = await Promise.all([ctx.schema!.listCollections(), s.jobs.query({ orderBy: { createdAt: "desc" }, limit: 15 }), s.jobs.count({ state: "running" }), lastAgentSession(ctx)]);
	// EmDash switches agent tools off on every registry/marketplace update and does not let a
	// plugin read the switch; a version change since the agent's last session is the signal.
	const agentNotice =
		agent && agent.version !== ctx.plugin.version
			? [
					banner(
						"AI agent tools are probably switched off",
						`LYNX was updated from ${agent.version} to ${ctx.plugin.version} since an AI agent last connected (${agent.at.slice(0, 10)}). EmDash switches a plugin's agent tools off on every update, even when the tools did not change. If you use an AI agent with LYNX, switch them on again: Plugins → LYNX → Agent access. This notice goes away after the agent's next session.`,
						"alert",
					),
				]
			: [];
	const blocks: Block[] = [
		header("LYNX"),
		context("Content manager and bulk editor with AI-agent tools. Every change goes find → preview → apply, is recorded in history first, and can be rolled back."),
		...agentNotice,
		...(flash ?? []),
		{
			type: "stats",
			items: [
				{ label: "Collections", value: cols.length },
				{ label: "Jobs running", value: running },
				{ label: "Recent jobs", value: jobs.items.length },
				{ label: "Step size", value: budgetFor("auto") > 8 ? "fast" : "safe", description: budgetFor("auto") > 8 ? "no sandbox limits on this host" : "Cloudflare-safe steps" },
			],
		},
		header("Jobs"),
		{
			type: "table",
			page_action_id: "jobs_page",
			empty_text: "No jobs yet. Start one below, from the grid, or through an AI agent.",
			columns: [
				{ key: "started", label: "Started", format: "relative_time" },
				{ key: "summary", label: "Change" },
				{ key: "entries", label: "Entries", format: "number" },
				{ key: "progress", label: "Result" },
				{ key: "state", label: "State", format: "badge" },
				{ key: "by", label: "By" },
				{ key: "via", label: "Via", format: "badge" },
				{ key: "actions", label: "", format: "element" },
			],
			rows: jobs.items.map((x) => jobRow(x.data)),
		},
		{ type: "actions", elements: [{ type: "button", action_id: "refresh", label: "Refresh" }] },
		{ type: "divider" },
		header("Spreadsheet editor: LYNX Grid"),
		context("Edit like a spreadsheet: cells, Excel paste, photos, views. Your developer adds it once:"),
		{ type: "code", language: "bash", code: "npm install @realmag777/lynx-grid\n# astro.config.mjs: emdash({ plugins: [lynxGrid()] }), then deploy" },
		{ type: "actions", elements: [{ type: "link", label: "How to install", target: { kind: "external", url: "https://github.com/realmag777/lynx-emdash#install" } }] },
		{ type: "divider" },
		header("Connect an AI agent (MCP)"),
		{
			type: "code",
			language: "bash",
			code: [
				`# 1. Plugins → LYNX → Agent access: switch it on.`,
				`# 2. Settings → API tokens: create a token with the LYNX tools scope`,
				`#    (mcp:tools:lynx) plus content read/write.`,
				`# 3. Point your MCP client at:`,
				`${ctx.site.url.replace(/\/$/, "")}/_emdash/api/mcp`,
				`#    with the header  Authorization: Bearer <token>`,
			].join("\n"),
		},
		context("Every plugin update switches agent access off until an administrator switches it on again."),
		{ type: "actions", elements: [{ type: "link", label: "LYNX settings", target: { kind: "plugin-settings" } }] },
	];
	return { blocks };
}

/** Calls kept back so the page can always be re-rendered after an action. */
const RENDER_CALLS = 3;

export async function adminRoute(routeCtx: SandboxedRouteContext, rawCtx: Ctx, readConf: (ctx: Ctx) => Promise<Conf>, actor: Actor): Promise<unknown> {
	const i = (routeCtx.input ?? { type: "page_load" }) as Interaction;
	const root = new Meter(rawCtx, budgetFor("auto"));
	const ctx = root.ctx;
	const conf = () => readConf(ctx);
	try {
		if (i.type === "block_action" && i.action_id === "job_menu") {
			const [action, key] = String(i.value ?? "").split(":");
			if (!key) throw new LynxError("BAD_ARGUMENT", "Unknown job.");
			const c = await conf();
			const m = root.reserving(RENDER_CALLS);
			if (action === "cancel") {
				await cancelJob(m, key);
				return { ...(await overview(ctx)), toast: { type: "info", message: "Job cancelled. What it wrote so far stays and can be rolled back." } };
			}
			if (action === "rollback") {
				const job = await createRollbackJob(m, { source: await getJob(m, key), force: false, budget: budgetFor(c.stepSize), actor });
				if (m.has(stepCalls(job))) await runStep(m, job.jobKey);
				return { ...(await overview(ctx)), toast: { type: "success", message: "Rollback started." } };
			}
			let steps = 0;
			while (m.has(6)) {
				const r = await runStep(m, key);
				steps++;
				if (!r.job || r.job.state !== "running" || r.outcome.phase === "finishing") break;
			}
			return { ...(await overview(ctx)), toast: { type: "info", message: `Ran ${steps} step${steps === 1 ? "" : "s"}.` } };
		}
		if (i.type === "page_load") await ensureCron(ctx);
		return await overview(ctx);
	} catch (err) {
		const e = toErrorResult(err);
		return { ...(await overview(ctx, [banner("Nothing was changed", e.message, "error")])) };
	}
}
