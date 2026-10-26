import { readableSummary } from "@realmag777/lynx-engine";
import { Badge, Banner, Button, Loader, Meter } from "@cloudflare/kumo";
import { ArrowCounterClockwise, Broom, CaretLeft, CaretRight, Robot, User } from "@phosphor-icons/react";
import * as React from "react";

import type { HistoryJob, JobAnswer, JobResult } from "../model/api.ts";
import { errorText, useApi, useGridApi, useNotify } from "./context.tsx";
import { ConfirmDialog, KSelect } from "./kit.tsx";
import { pageList } from "./MediaLibrary.tsx";
import { SlidePanel } from "./SlidePanel.tsx";

// Job progress, job results, the history panel (every job of the core: grid saves, bulk
// edits, agent changes, rollbacks) with rollback, and the empty-draft cleanup offered after a
// draft-mode job is rolled back.

const STATE_BADGE: Record<string, "success" | "info" | "neutral" | "warning"> = { completed: "success", running: "info", rolled_back: "neutral", cancelled: "warning" };

export function JobProgress({ job }: { job: JobAnswer }) {
	const pct = Math.max(0, Math.min(100, Math.round(job.percent_done)));
	return (
		<div className="lynx-job">
			<div className="lynx-job__head">
				<span className="lynx-strong">{readableSummary(job.summary)}</span>
				<Badge variant={STATE_BADGE[job.state] ?? "neutral"}>{job.state.replace("_", " ")}</Badge>
			</div>
			<Meter label={`${job.done.toLocaleString()} of ${job.total.toLocaleString()}${job.step?.phase === "terms" ? " · assigning terms" : job.step?.phase === "finishing" ? " · finishing" : ""}`} value={pct} />
			<JobResultLine result={job.result ?? null} />
			{job.step?.failures?.length ? (
				<ul className="lynx-failures">
					{job.step.failures.map((f) => (
						<li key={f.id}>
							<code>{f.id}</code>: {f.message}
						</li>
					))}
				</ul>
			) : null}
		</div>
	);
}

export function JobResultLine({ result }: { result: JobResult | null }) {
	if (!result) return null;
	const parts = [`${result.written.toLocaleString()} written`, `${result.unchanged.toLocaleString()} unchanged`];
	if (result.invalid) parts.push(`${result.invalid} invalid`);
	if (result.held) parts.push(`${result.held} held`);
	if (result.failed) parts.push(`${result.failed} failed`);
	if (result.conflicts) parts.push(`${result.conflicts} conflicts`);
	return <div className={`lynx-result ${result.failed || result.invalid ? "has-problems" : ""}`}>{parts.join(" · ")}</div>;
}

/** Discard a draft through the admin REST API, as the signed-in user (plugins cannot). */
async function discardDraft(collection: string, id: string): Promise<boolean> {
	const res = await fetch(`/_emdash/api/content/${encodeURIComponent(collection)}/${encodeURIComponent(id)}/discard-draft`, { method: "POST", credentials: "same-origin", headers: { "X-EmDash-Request": "1" } });
	return res.ok;
}

/**
 * After a draft-mode job is rolled back, its entries keep drafts equal to the published
 * version: they change nothing but make publish-mode jobs hold the entries back. The grid
 * finds them (its own read route compares draft and live values) and offers to remove them.
 */
export function EmptyDraftsCleanup({ collection, onDone }: { collection: string; onDone?: () => void }) {
	const grid = useGridApi();
	const notify = useNotify();
	const [ids, setIds] = React.useState<string[] | null>(null);
	const [busy, setBusy] = React.useState(false);
	React.useEffect(() => {
		let stale = false;
		grid.emptyDrafts(collection, [])
			.then((r) => !stale && setIds(r.empty))
			.catch(() => !stale && setIds([]));
		return () => {
			stale = true;
		};
	}, [grid, collection]);
	if (!ids?.length) return null;
	const run = async () => {
		setBusy(true);
		let done = 0;
		for (const id of ids) if (await discardDraft(collection, id).catch(() => false)) done++;
		setBusy(false);
		setIds([]);
		notify(done === ids.length ? "success" : "warning", `Removed ${done} empty ${done === 1 ? "draft" : "drafts"}`, done === ids.length ? "Publishing no longer holds these entries back." : `${ids.length - done} could not be removed.`);
		onDone?.();
	};
	return (
		<Banner
			variant="secondary"
			icon={<Broom />}
			title={`${ids.length} ${ids.length === 1 ? "entry keeps a draft" : "entries keep drafts"} identical to the published version`}
			description="They are left over from the rollback. They change nothing, but publish-mode edits skip entries with drafts."
			action={
				<Button size="sm" variant="primary" loading={busy} onClick={() => void run()}>
					Remove empty drafts ({ids.length})
				</Button>
			}
		/>
	);
}

function when(iso: string | null): string {
	if (!iso) return "";
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function HistoryPanel(props: { open: boolean; onClose: () => void; onChanged: () => void }) {
	const api = useApi();
	const notify = useNotify();
	const [jobs, setJobs] = React.useState<HistoryJob[] | null>(null);
	const [running, setRunning] = React.useState<JobAnswer | null>(null);
	const [problem, setProblem] = React.useState<string | null>(null);
	const [confirming, setConfirming] = React.useState<HistoryJob | null>(null);
	const [cleanup, setCleanup] = React.useState<string | null>(null);

	// Pages (2026-10-01). The core pages jobs by cursor: cursors[i] opens page i + 1, and a
	// page further on is reached by walking from the last cursor known.
	const [perPage, setPerPage] = React.useState(20);
	const [page, setPage] = React.useState(1);
	const [total, setTotal] = React.useState(0);
	const cursors = React.useRef<Array<string | undefined>>([undefined]);
	const load = React.useCallback(
		async (target: number) => {
			try {
				let i = Math.min(target, cursors.current.length) - 1;
				for (;;) {
					const res = await api.history(perPage, cursors.current[i]);
					if (res.cursor) cursors.current[i + 1] = res.cursor;
					if (i + 1 >= target || !res.cursor) {
						setJobs(res.jobs);
						setTotal(res.total ?? res.jobs.length);
						setPage(i + 1);
						return;
					}
					i++;
				}
			} catch (e) {
				setProblem(errorText(e));
			}
		},
		[api, perPage],
	);
	const go = (n: number) => {
		setJobs(null);
		void load(n);
	};

	React.useEffect(() => {
		if (props.open) {
			setJobs(null);
			setProblem(null);
			setCleanup(null);
			cursors.current = [undefined];
			void load(1);
		}
	}, [props.open, load]);
	const pages = Math.max(1, Math.ceil(total / perPage));

	const rollback = async (j: HistoryJob) => {
		setConfirming(null);
		setProblem(null);
		setCleanup(null);
		try {
			const first = await api.rollback(j.job_key);
			const end = await api.drive(first, setRunning);
			setRunning(null);
			notify("success", "Rolled back", end.summary);
			if (j.mode === "draft") setCleanup(j.collection);
			props.onChanged();
			// A roll back is a new job on top: start again from the first page.
			cursors.current = [undefined];
			await load(1);
		} catch (e) {
			setRunning(null);
			setProblem(errorText(e));
		}
	};

	return (
		<SlidePanel open={props.open} onClose={props.onClose} title="History" subtitle="Grid saves, bulk edits and AI-agent changes. Each can be rolled back." size="wide">
			{problem ? <Banner variant="error" description={problem} /> : null}
			{running ? <JobProgress job={running} /> : null}
			{cleanup ? <EmptyDraftsCleanup collection={cleanup} onDone={props.onChanged} /> : null}
			<div className="lynx-history__bar">
				<span className="lynx-hint">{total ? `${total.toLocaleString()} ${total === 1 ? "job" : "jobs"}` : ""}</span>
				<KSelect label="Jobs per page" size="xs" value={String(perPage)} onChange={(v) => setPerPage(Number(v))} options={[10, 20, 50].map((n) => ({ value: String(n), label: `${n} per page` }))} />
			</div>
			{jobs === null ? (
				<div className="lynx-center">
					<Loader size="lg" />
				</div>
			) : jobs.length === 0 ? (
				<p className="lynx-hint">Nothing has been changed through LYNX yet.</p>
			) : (
				<ul className="lynx-history">
					{jobs.map((j) => (
						<li key={j.job_key} className="lynx-history__item">
							<div className="lynx-history__top">
								<span className="lynx-strong">{readableSummary(j.summary)}</span>
								<Badge variant={STATE_BADGE[j.state] ?? "warning"}>{j.state.replace("_", " ")}</Badge>
							</div>
							<div className="lynx-history__meta">
								{j.via_mcp ? (
									<Badge variant="info" className="lynx-agent-chip">
										<Robot size={12} weight="bold" aria-hidden />
										AI agent
									</Badge>
								) : (
									<User size={13} aria-label="Person" />
								)}
								{j.author || !j.via_mcp ? <span>{j.author ?? "someone"}</span> : null}
								<span>·</span>
								<span>{when(j.started)}</span>
								<span>·</span>
								<span>{j.collection}</span>
								<span>·</span>
								<span>
									{j.total.toLocaleString()} {j.total === 1 ? "entry" : "entries"}
								</span>
								{j.mode === "draft" ? <Badge variant="outline">as drafts</Badge> : null}
								{j.rollback_of ? <Badge variant="outline">undo</Badge> : null}
							</div>
							<JobResultLine result={j.result ?? null} />
							{j.state === "completed" && !j.rolled_back_by && !j.rollback_of ? (
								<Button size="sm" variant="secondary" icon={<ArrowCounterClockwise />} disabled={Boolean(running)} onClick={() => setConfirming(j)}>
									Roll back
								</Button>
							) : null}
						</li>
					))}
				</ul>
			)}
			{pages > 1 ? (
				<nav className="lynx-library__pages" aria-label="History pages">
					<button type="button" className="lynx-icon-btn" aria-label="Newer jobs" disabled={page <= 1 || jobs === null} onClick={() => go(page - 1)}>
						<CaretLeft size={14} />
					</button>
					{pageList(page, pages).map((n, i) =>
						n === "gap" ? (
							<span key={`g${i}`} className="lynx-hint">
								…
							</span>
						) : (
							<button key={n} type="button" className={`lynx-library__page ${n === page ? "is-current" : ""}`} aria-current={n === page ? "page" : undefined} disabled={jobs === null} onClick={() => go(n)}>
								{n}
							</button>
						),
					)}
					<button type="button" className="lynx-icon-btn" aria-label="Older jobs" disabled={page >= pages || jobs === null} onClick={() => go(page + 1)}>
						<CaretRight size={14} />
					</button>
				</nav>
			) : null}
			<ConfirmDialog
				open={confirming !== null}
				title="Roll back this job?"
				text={confirming ? `“${readableSummary(confirming.summary)}”: the values from before the job are restored. Entries changed since then are left alone.` : ""}
				confirm="Roll back"
				onConfirm={() => confirming && void rollback(confirming)}
				onCancel={() => setConfirming(null)}
			/>
		</SlidePanel>
	);
}
