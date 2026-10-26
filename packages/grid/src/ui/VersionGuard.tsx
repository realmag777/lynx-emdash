import { Toast } from "@cloudflare/kumo";
import * as React from "react";

import { DEDUPE_COMMAND, DEDUPE_CONFIG, fixCommand, PEERS, satisfies, versionProblems, type VersionProblem } from "../model/versions.ts";
import { useGridApi } from "./context.tsx";

// The version guard of the grid page. Everything that can render while React itself is the
// problem (a second copy, a version outside the peer range) is plain markup without hooks or
// Kumo, and the grid page sits in an error boundary: a mismatch shows a banner with the exact
// fix on this page and leaves the rest of the admin alone.

type Internals = { H?: unknown } | undefined;

/**
 * The React this module imported is not the one rendering it: two copies are loaded and every
 * hook would throw "Invalid hook call". Call during render, before any hook.
 */
export function foreignReact(): boolean {
	const internals = (React as unknown as { __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE?: Internals }).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
	return !internals || internals.H == null;
}

/** React outside the peer range, from what the browser runs (works on every host). */
export function reactProblem(): VersionProblem | null {
	return satisfies(React.version, PEERS.react!) ? null : { pkg: "react", found: React.version, range: PEERS.react! };
}

/** The admin's toast provider is reachable: false means a second copy of Kumo (or base-ui). */
export function useToastsReachable(): boolean {
	try {
		Toast.useToastManager();
		return true;
	} catch {
		return false;
	}
}

export interface GuardFindings {
	problems: VersionProblem[];
	/** Packages loaded twice (the grid got its own copy instead of the admin's). */
	duplicates: string[];
	/** A crash of the grid page, when the boundary caught one. */
	error?: string;
}

/** Plain markup only: this also renders when React or Kumo are the problem. */
export function VersionBanner({ problems, duplicates, error }: GuardFindings) {
	const title = problems.length ? "LYNX Grid does not match the admin's packages" : duplicates.length ? "LYNX Grid got its own copy of the admin's packages" : "LYNX Grid could not start";
	return (
		<div className="lynx-root lynx-guard" role="alert">
			<p className="lynx-guard__title">{title}</p>
			{problems.length ? (
				<>
					<ul className="lynx-guard__list">
						{problems.map((p) => (
							<li key={p.pkg}>
								<code>{p.pkg}</code>: {p.found ? `the admin has ${p.found}` : "not installed"}, the grid needs <code>{p.range}</code>
							</li>
						))}
					</ul>
					<p>Run this in the site folder, then restart the dev server or rebuild the site:</p>
					<pre className="lynx-guard__cmd">
						<code>{fixCommand(problems)}</code>
					</pre>
				</>
			) : null}
			{duplicates.length ? (
				<>
					<p>
						Two copies of {duplicates.map((d, i) => (
							<React.Fragment key={d}>
								{i ? ", " : ""}
								<code>{d}</code>
							</React.Fragment>
						))}{" "}
						are loaded: the grid has to use the admin&apos;s. Run <code>{DEDUPE_COMMAND}</code> in the site folder, or add this to <code>astro.config.mjs</code>, then restart:
					</p>
					<pre className="lynx-guard__cmd">
						<code>{DEDUPE_CONFIG}</code>
					</pre>
				</>
			) : null}
			{error ? (
				<p>
					The grid page stopped with: <code>{error}</code>
				</p>
			) : null}
			<p className="lynx-guard__note">Only this page is affected; the rest of the admin works as usual.</p>
		</div>
	);
}

/** Keeps a crash of the grid page on this page, with the guard's findings next to it. */
export class GridBoundary extends React.Component<{ children: React.ReactNode }, { error: string | null }> {
	override state = { error: null as string | null };
	static getDerivedStateFromError(err: unknown) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
	override render() {
		if (!this.state.error) return this.props.children;
		const react = reactProblem();
		const hooks = /invalid hook call|useToastManager|Toast.Provider/i.test(this.state.error);
		return <VersionBanner problems={react ? [react] : []} duplicates={hooks && !react ? ["react", "@cloudflare/kumo"] : []} error={this.state.error} />;
	}
}

/**
 * The check at load: React's version from the browser, the other peers from the site's
 * node_modules (Node hosts), and whether the admin's toast provider is reachable.
 */
export function VersionNotice() {
	const grid = useGridApi();
	const toasts = useToastsReachable();
	const [found, setFound] = React.useState<VersionProblem[]>([]);
	React.useEffect(() => {
		let stale = false;
		grid.versions()
			.then((r) => {
				if (stale || !r.available) return;
				setFound(versionProblems({ ...r.versions, react: React.version }));
			})
			.catch(() => undefined);
		return () => {
			stale = true;
		};
	}, [grid]);
	const react = reactProblem();
	const problems = react && !found.some((p) => p.pkg === "react") ? [react, ...found] : found;
	const duplicates = toasts ? [] : ["@cloudflare/kumo"];
	if (!problems.length && !duplicates.length) return null;
	return <VersionBanner problems={problems} duplicates={duplicates} />;
}
