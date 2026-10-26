/**
 * LYNX Grid — admin entry (loaded by the EmDash admin through the site's Vite build).
 *
 * One page: the spreadsheet-style grid. Controls outside the table are Kumo components (the
 * admin's own library); the table and the side panels use `.lynx-` classes on Kumo tokens, so
 * the page follows the admin's light and dark themes.
 *
 * The page first checks that it shares the admin's React, Kumo, icons and admin package in
 * matching versions (VersionGuard); a mismatch shows a banner with the fix on this page only.
 */

import type { PluginAdminExports } from "emdash";
import * as React from "react";

import "./grid.css";
import "./vendor/calendar23.css";
import { CoreApi, GridApi } from "./model/api.ts";
import { ApiContext, GridApiContext } from "./ui/context.tsx";
import { GridPage } from "./ui/GridPage.tsx";
import { foreignReact, GridBoundary, reactProblem, VersionBanner, VersionNotice } from "./ui/VersionGuard.tsx";

const api = new CoreApi();
const grid = new GridApi();

function LynxGridPage() {
	// No hooks before these checks: with a second React copy or React 18 they would throw.
	if (foreignReact()) return <VersionBanner problems={[]} duplicates={["react"]} />;
	const react = reactProblem();
	if (react) return <VersionBanner problems={[react]} duplicates={[]} />;
	return (
		<ApiContext.Provider value={api}>
			<GridApiContext.Provider value={grid}>
				<GridBoundary>
					<VersionNotice />
					<GridPage />
				</GridBoundary>
			</GridApiContext.Provider>
		</ApiContext.Provider>
	);
}

export const pages: PluginAdminExports["pages"] = {
	"/": LynxGridPage,
};
