import { carsPreset, fetchClient, installPreset, realEstatePreset, type InstallProgress, type InstallResult, type Preset, type PresetImage } from "@realmag777/lynx-presets";
import { PRESET_PHOTOS } from "@realmag777/lynx-presets/photos";
import { Badge, Banner, Button, Checkbox, Meter } from "@cloudflare/kumo";
import { Warning } from "@phosphor-icons/react";
import * as React from "react";

import { errorText } from "./context.tsx";
import { SlidePanel } from "./SlidePanel.tsx";

// Demo data wizard: installs a LYNX preset (collection, fields, taxonomies, terms, and
// optionally demo entries with photos). This is the ONE place where the grid does not talk
// to the core: creating collections and fields needs the site's schema API, and the core
// plugin deliberately has no schema:write capability. It runs as the signed-in admin.

/** Photos bundled by the site's Vite build, from the presets package (works from node_modules too). */
const PHOTOS: Record<string, string> = PRESET_PHOTOS;

async function loadImage(dir: string, img: PresetImage): Promise<Blob> {
	const hit = Object.entries(PHOTOS).find(([path]) => path.endsWith(`/${dir}/${img.file}`));
	if (hit) {
		const res = await fetch(hit[1]);
		if (res.ok) return res.blob();
	}
	return placeholder(img.alt || img.file);
}

/** A plain placeholder picture when the photo is not bundled (e.g. outside the monorepo). */
function placeholder(text: string): Promise<Blob> {
	const c = document.createElement("canvas");
	c.width = 960;
	c.height = 640;
	const g = c.getContext("2d")!;
	g.fillStyle = "#d6dde6";
	g.fillRect(0, 0, c.width, c.height);
	g.fillStyle = "#44505e";
	g.font = "28px system-ui, sans-serif";
	g.textAlign = "center";
	g.fillText(text.slice(0, 60), c.width / 2, c.height / 2);
	return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error("Could not draw a placeholder image"))), "image/jpeg", 0.85));
}

export const PRESETS: Preset[] = [carsPreset, realEstatePreset];

export function PresetWizard(props: { open: boolean; onClose: () => void; existing: string[]; onInstalled: (collection: string) => void }) {
	const [choice, setChoice] = React.useState(PRESETS[0]!.id);
	const [withEntries, setWithEntries] = React.useState(true);
	const [progress, setProgress] = React.useState<InstallProgress | null>(null);
	const [result, setResult] = React.useState<InstallResult | null>(null);
	const [problem, setProblem] = React.useState<string | null>(null);
	const preset = PRESETS.find((p) => p.id === choice)!;
	const busy = progress !== null && progress.step !== "done" && !problem;

	React.useEffect(() => {
		if (props.open) {
			setProgress(null);
			setResult(null);
			setProblem(null);
		}
	}, [props.open]);

	const run = async () => {
		setProblem(null);
		setResult(null);
		setProgress({ step: "schema", message: "Starting" });
		try {
			const res = await installPreset(fetchClient(window.location.origin), preset, { loadImage, onProgress: setProgress, schemaOnly: !withEntries });
			setResult(res);
			props.onInstalled(preset.collection.slug);
		} catch (e) {
			setProblem(errorText(e));
		}
	};

	return (
		<SlidePanel
			open={props.open}
			onClose={props.onClose}
			title="Install demo data"
			subtitle="A ready collection to try LYNX on. Existing collections, fields, terms and entries are kept."
			size="md"
			footer={
				<>
					<span className="lynx-grow" />
					<Button variant="secondary" onClick={props.onClose}>
						{result ? "Close" : "Cancel"}
					</Button>
					{!result ? (
						<Button variant="primary" loading={busy} onClick={() => void run()}>
							Install {preset.name}
						</Button>
					) : null}
				</>
			}
		>
			<section className="lynx-section">
				<div className="lynx-cards" role="radiogroup" aria-label="Preset">
					{PRESETS.map((p) => (
						<button key={p.id} type="button" role="radio" aria-checked={choice === p.id} className={`lynx-card lynx-card--choice ${choice === p.id ? "is-on" : ""}`} onClick={() => setChoice(p.id)} disabled={busy}>
							<span className="lynx-strong">{p.name}</span>
							{props.existing.includes(p.collection.slug) ? <Badge variant="neutral">installed</Badge> : null}
							<span className="lynx-hint">{p.description}</span>
							<span className="lynx-hint">
								{p.collection.fields.length} fields · {p.taxonomies.length} taxonomies · {p.entries.length} demo entries
							</span>
						</button>
					))}
				</div>
				<Checkbox label={`Add ${preset.entries.length} demo entries with photos (AI-generated, no real brands)`} checked={withEntries} disabled={busy} onCheckedChange={(c) => setWithEntries(Boolean(c))} />
				<p className="lynx-hint">This step uses the site's schema and content API as you, because the LYNX core plugin cannot change the schema.</p>
			</section>
			{progress ? (
				<section className="lynx-section" aria-live="polite">
					<Meter label={`${progress.step}: ${progress.message}${progress.total ? ` (${(progress.done ?? 0) + 1}/${progress.total})` : ""}`} value={progressPct(progress)} />
				</section>
			) : null}
			{result ? (
				<Banner
					variant="secondary"
					description={`${result.collection.created ? "Collection created" : "Collection already there"}; ${result.collection.fieldsCreated.length} fields, ${result.taxonomies.created.length} taxonomies, ${result.terms.created} terms, ${result.media.uploaded} photos, ${result.entries.created} entries added (${result.entries.skipped} already there).`}
				/>
			) : null}
			{problem ? (
				<Banner variant="error" icon={<Warning weight="fill" />} description={problem} />
			) : null}
		</SlidePanel>
	);
}

const STEP_BASE: Record<InstallProgress["step"], number> = { schema: 5, taxonomies: 15, terms: 25, media: 35, entries: 70, done: 100 };
const STEP_SPAN: Record<InstallProgress["step"], number> = { schema: 10, taxonomies: 10, terms: 10, media: 35, entries: 30, done: 0 };

function progressPct(p: InstallProgress): number {
	const within = p.total ? (p.done ?? 0) / p.total : 0;
	return Math.round(STEP_BASE[p.step] + STEP_SPAN[p.step] * within);
}
