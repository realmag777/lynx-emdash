import { createPluginRuntimeTestHost, type PluginRuntimeTestHost } from "@emdash-cms/plugin-test";

export type Host = PluginRuntimeTestHost;

export const MCP_URL = "http://localhost/_emdash/api/mcp";

/** Invoke a route through the sandbox transport and return its payload. */
export async function call<T = Record<string, unknown>>(host: Host, route: string, input: unknown = {}, url?: string): Promise<T> {
	return (await host.transport.invokeRoute(route, input, {
		url: url ?? `http://localhost/_emdash/api/plugins/lynx/${route}`,
		method: "POST",
		user: { id: "user-editor", email: "editor@example.com", name: "Eda Editor", role: 40, createdAt: "2026-01-01T00:00:00Z" },
	} as never)) as T;
}

export interface Seeded {
	host: Host;
	ids: string[];
	prices: Map<string, number>;
	terms: Record<string, string>;
}

/**
 * A cars collection with revisions, 12 published entries, a unique VIN, and a flat
 * fuel taxonomy; plus a properties collection without revisions.
 */
export async function seed(count = 12): Promise<Seeded> {
	const host = await createPluginRuntimeTestHost();
	await host.fixtures.collection({
		slug: "cars",
		label: "Cars",
		supports: ["drafts", "revisions"],
		fields: [
			{ slug: "title", label: "Title", type: "string", required: true },
			{ slug: "price", label: "Price", type: "number", indexed: true, validation: { min: 0 } },
			{ slug: "year", label: "Year", type: "integer", indexed: true, validation: { min: 1950, max: 2030 } },
			{ slug: "vin", label: "VIN", type: "string", indexed: true, unique: true },
			{ slug: "color", label: "Colour", type: "select", indexed: true, validation: { options: ["Black", "White", "Blue"] } },
		],
	});
	await host.fixtures.collection({
		slug: "properties",
		label: "Properties",
		supports: ["drafts"],
		fields: [
			{ slug: "title", label: "Title", type: "string", required: true },
			{ slug: "price", label: "Price", type: "number", indexed: true },
		],
	});
	await host.fixtures.taxonomyDefinition({ name: "fuel", label: "Fuel", hierarchical: false, collections: ["cars"] });
	const diesel = await host.fixtures.taxonomy({ name: "fuel", slug: "diesel", label: "Diesel" });
	const petrol = await host.fixtures.taxonomy({ name: "fuel", slug: "petrol", label: "Petrol" });

	const ids: string[] = [];
	const prices = new Map<string, number>();
	for (let i = 0; i < count; i++) {
		const price = 10000 + i * 1000;
		const item = await host.fixtures.content("cars", {
			slug: `car-${i}`,
			status: "draft",
			data: { title: `Car ${i}`, price, year: 2010 + i, vin: `VIN${String(i).padStart(14, "0")}`, color: i % 2 ? "Black" : "White" },
		});
		await host.actions.content.publish("cars", item.id);
		ids.push(item.id);
		prices.set(item.id, price);
	}
	for (let i = 0; i < 3; i++) {
		const item = await host.fixtures.content("properties", { slug: `p-${i}`, status: "draft", data: { title: `Flat ${i}`, price: 1000 + i } });
		await host.actions.content.publish("properties", item.id);
	}
	return { host, ids, prices, terms: { diesel: diesel.id, petrol: petrol.id } };
}

/** Drive a job to the end the way an agent does: job_status until finished. */
export async function drive(host: Host, jobKey: string, maxSteps = 60) {
	const steps: Array<Record<string, unknown>> = [];
	for (let i = 0; i < maxSteps; i++) {
		const r = await call(host, "job", { job_key: jobKey });
		steps.push(r);
		if (r.finished) return { last: r, steps };
	}
	throw new Error(`job ${jobKey} did not finish in ${maxSteps} steps`);
}

export async function livePrice(host: Host, id: string): Promise<number | undefined> {
	const item = await host.inspect.content.get("cars", id);
	return item?.data.price as number | undefined;
}
