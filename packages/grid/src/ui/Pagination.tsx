import { Button } from "@cloudflare/kumo";
import { CaretLeft, CaretRight } from "@phosphor-icons/react";

import { pageItems } from "../model/pagination.ts";
import { PAGE_SIZES } from "../model/view.ts";
import { KSelect } from "./kit.tsx";

// Botoscope pagination (← 1 2 3 … 10 11 12 →) above and below the grid, drawn with Kumo buttons.

/** approx: total is the count found last time, while the exact one is being counted ("of ≈50,030"). */
export function Pagination(props: { page: number; pageSize: number; total: number; approx?: boolean; onPage: (p: number) => void; onPageSize?: (n: number) => void; label: string }) {
	const { page, pageSize, total, approx, onPage, onPageSize, label } = props;
	const pages = Math.max(1, Math.ceil(total / pageSize));
	const from = total === 0 ? 0 : page * pageSize + 1;
	const to = Math.min(total, (page + 1) * pageSize);
	return (
		<nav className="lynx-pager" aria-label={label}>
			<span className="lynx-pager__range">
				{from.toLocaleString()}–{to.toLocaleString()} of {approx ? "≈" : ""}
				{total.toLocaleString()}
			</span>
			{onPageSize ? <KSelect label="Rows per page" value={String(pageSize)} onChange={(v) => onPageSize(Number(v))} options={PAGE_SIZES.map((n) => ({ value: String(n), label: `${n} / page` }))} /> : null}
			<ul className="lynx-pager__list">
				{pageItems(page, pages).map((it) =>
					it.type === "dots" ? (
						<li key={it.key} className="lynx-pager__dots" aria-hidden>
							…
						</li>
					) : it.type === "page" ? (
						<li key={`p${it.page}`}>
							<Button size="sm" variant={it.current ? "secondary" : "ghost"} className={it.current ? "lynx-pager__current" : undefined} aria-current={it.current ? "page" : undefined} aria-label={`Page ${it.page + 1}`} onClick={() => onPage(it.page)}>
								{it.page + 1}
							</Button>
						</li>
					) : (
						<li key={it.type}>
							<Button size="sm" variant="ghost" shape="square" disabled={it.page === null} aria-label={it.type === "prev" ? "Previous page" : "Next page"} icon={it.type === "prev" ? <CaretLeft /> : <CaretRight />} onClick={() => it.page !== null && onPage(it.page)} />
						</li>
					),
				)}
			</ul>
		</nav>
	);
}
