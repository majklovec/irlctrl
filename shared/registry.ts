/**
 * Backend module registry — discovery only, no device-process dependencies.
 *
 * Every modules/<id>/backend.ts default-exports a BackendModule registration
 * (shared/module-contract.ts). Discovery has two modes:
 *
 *  - unbundled (bun backend/server/server.ts, bun test): a runtime directory
 *    scan anchored on import.meta.url — adding a module needs no edit here.
 *  - compiled binaries (bun build --compile): the build-time manifest
 *    generated/modules.backend.ts (scripts/gen-modules.ts); a compiled process
 *    cannot readdir (import.meta.url lives in Bun's virtual /$bunfs mount).
 *
 * Malformed registrations are rejected at load with the module id in the
 * message. Both processes share this file: the device lifecycle
 * (backend/client/modules.ts) drives start/stop/dispatch, the control server
 * uses the widget hubs, pages and widget declarations.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerLogWording } from "./logMessages";
import type {
	BackendModule,
	ChannelHub,
	ModulePage,
} from "./module-contract";
import type { ServerDashboard, WidgetConfigField } from "./types";
import { isCompiledBinary } from "./util";

const MODULES_DIR = fileURLToPath(new URL("../modules", import.meta.url));

export type { BackendModule } from "./module-contract";

/**
 * Deterministic order: topological over declared `dependencies` (a module comes
 * after the modules it depends on), ties broken by id. Unknown dependency ids
 * and cycles throw at load.
 */
function resolveOrder(mods: BackendModule[]): BackendModule[] {
	const byId = new Map(mods.map((m) => [m.id, m]));
	const order: BackendModule[] = [];
	const done = new Set<string>();
	const onStack = new Set<string>();
	const visit = (mod: BackendModule): void => {
		if (done.has(mod.id)) return;
		if (onStack.has(mod.id))
			throw new Error(`module dependency cycle at ${mod.id}`);
		onStack.add(mod.id);
		for (const dep of mod.dependencies ?? []) {
			const target = byId.get(dep);
			if (!target)
				throw new Error(`module ${mod.id} depends on unknown module ${dep}`);
			visit(target);
		}
		onStack.delete(mod.id);
		done.add(mod.id);
		order.push(mod);
	};
	for (const mod of [...mods].sort((a, b) => a.id.localeCompare(b.id)))
		visit(mod);
	return order;
}

const isStringArray = (v: unknown): v is string[] =>
	Array.isArray(v) && v.every((x) => typeof x === "string");

function validate(mod: unknown, file: string): asserts mod is BackendModule {
	if (typeof mod !== "object" || mod === null)
		throw new Error(`module registration in ${file} is not an object`);
	const m = mod as Record<string, unknown>;
	const id = typeof m.id === "string" ? m.id : null;
	if (m.kind !== "device" && m.kind !== "widget")
		throw new Error(`module ${id ?? file}: kind must be "device" or "widget"`);
	if (!id || typeof m.title !== "string")
		throw new Error(`module registration in ${file} needs a string id and title`);
	const fn = (name: string, required = false) => {
		if (m[name] === undefined ? required : typeof m[name] !== "function")
			throw new Error(`module ${id}: ${name} must be a method`);
	};
	const strings = (name: string, required = false) => {
		if (m[name] === undefined ? required : !isStringArray(m[name]))
			throw new Error(`module ${id}: ${name} must be a string array`);
	};
	if (m.kind === "device") {
		fn("start", true);
		fn("stop", true);
		fn("dispatch", true);
		strings("methods", true);
		strings("events", true);
	}
	for (const name of [
		"bind",
		"resume",
		"status",
		"settings",
		"setupInfo",
		"setup",
		"configure",
	])
		fn(name);
	strings("dependencies");
	strings("roles");
	strings("secretFields");
	if (m.pages !== undefined) {
		if (
			!Array.isArray(m.pages) ||
			m.pages.some(
				(p) =>
					!(p instanceof Object) ||
					!((p as ModulePage).match instanceof RegExp) ||
					typeof (p as ModulePage).page !== "string",
			)
		)
			throw new Error(`module ${id}: pages must be { match: RegExp, page }[]`);
	}
}

function acceptRegistration(mod: unknown, file: string): BackendModule {
	try {
		validate(mod, file);
	} catch (err) {
		throw new Error(
			`rejecting module backend ${file}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	return mod;
}

async function discover(): Promise<Map<string, BackendModule>> {
	const found = new Map<string, BackendModule>();
	const add = (mod: BackendModule) => {
		if (found.has(mod.id)) throw new Error(`duplicate module id ${mod.id}`);
		found.set(mod.id, mod);
	};
	if (isCompiledBinary()) {
		let manifest: unknown[];
		try {
			manifest = ((await import("../generated/modules.backend")) as {
				default: unknown[];
			}).default;
		} catch (err) {
			throw new Error(
				`compiled binary is missing the backend module manifest (generated/modules.backend.ts) — run \`bun run gen:modules\` before building: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
		}
		for (const entry of manifest)
			add(
				acceptRegistration(
					entry,
					`modules/${(entry as BackendModule).id}/backend.ts`,
				),
			);
		return found;
	}
	for (const entry of readdirSync(MODULES_DIR).sort()) {
		const backendPath = join(MODULES_DIR, entry, "backend.ts");
		if (!existsSync(backendPath)) continue;
		const file = `modules/${entry}/backend.ts`;
		let ns: { default?: unknown };
		try {
			ns = (await import(backendPath)) as { default?: unknown };
		} catch (err) {
			throw new Error(
				`failed to load module backend ${file}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		if (ns.default === undefined)
			throw new Error(`module backend ${file} has no default export`);
		add(acceptRegistration(ns.default, file));
	}
	return found;
}

/** Every registered module in start order (topological, id-tie-broken). */
export const ALL_MODULES: readonly BackendModule[] = resolveOrder([
	...(await discover()).values(),
]);

for (const mod of ALL_MODULES) if (mod.log) registerLogWording(mod.log);

const byId = new Map(ALL_MODULES.map((m) => [m.id, m]));
const byConfigKey = new Map(
	ALL_MODULES.map((m) => [m.configKey ?? m.id, m]),
);

/** A module by id or by its persisted settings key. */
export const moduleById = (id: string): BackendModule | undefined =>
	byId.get(id) ?? byConfigKey.get(id);

/** All registered modules (device + widget), for validation/status views. */
export const allModules = (): { id: string; title: string }[] =>
	ALL_MODULES.map((m) => ({ id: m.id, title: m.title }));

/** The module page that serves `path` (device-relative), if any. */
export function modulePage(path: string): string | undefined {
	for (const mod of ALL_MODULES)
		for (const page of mod.pages ?? [])
			if (page.match.test(path)) return page.page;
	return undefined;
}

/** Dashboard widget types with their default grid size: device widgets
 * (`dashboardWidgets`) plus one per channel-widget hub. */
export const WIDGET_SIZES: ReadonlyMap<string, { w: number; h: number }> =
	new Map(
		ALL_MODULES.flatMap((m) => [
			...(m.dashboardWidgets ?? []).map(
				(w) => [w.type, w.defaultSize] as const,
			),
			...(m.hub ? [[m.hub.widgetType, m.hub.defaultSize] as const] : []),
		]),
	);

// ---------------------------------------------------------------------------
// Dashboard widget hub (channel widgets — device-independent).
//
// One hub instance per widget type serves every widget of that type; wired
// generically from each widget module's `hub` field.
// ---------------------------------------------------------------------------

interface WidgetEntry {
	type: string;
	snapshotKey: string;
	configFields: readonly WidgetConfigField[];
	spec: (
		config: Record<string, string> | undefined,
	) => readonly (string | null)[];
	create: (publish: (msg: string) => void) => ChannelHub;
	hub: ChannelHub | null;
}

const WIDGETS: WidgetEntry[] = ALL_MODULES.flatMap((m) =>
	m.hub
		? [
				{
					type: m.hub.widgetType,
					snapshotKey: m.hub.snapshotKey,
					configFields: m.hub.configFields,
					spec: m.hub.channelSpec,
					create: m.hub.create,
					hub: null,
				},
			]
		: [],
);

/** Whether `type` is a device-independent (channel) widget type. */
export const isChannelWidgetType = (type: string): boolean =>
	WIDGETS.some((w) => w.type === type);

/** Config parameter names per widget type (server validation + dashboard editor). */
export const widgetConfigFields = (
	type: string,
): readonly WidgetConfigField[] =>
	WIDGETS.find((w) => w.type === type)?.configFields ?? [];

/** Wire the channel widget backends to the dashboard websocket topic. */
export function initWidgetHub(publish: (msg: string) => void): void {
	for (const w of WIDGETS) w.hub = w.create(publish);
}

/** Sync the widget backends with the dashboard configs (the dashboards write path). */
export function syncWidgetHub(dashboards: ServerDashboard[]): void {
	for (const w of WIDGETS) {
		const configs = dashboards.flatMap((dashboard) =>
			dashboard.widgets
				.filter((widget) => widget.type === w.type)
				.map((widget) => widget.config),
		);
		w.hub?.sync(widgetChannelSpecs(dashboards, w.type, w.spec), configs);
	}
}

/** Latest per-type samples for warm-starting a dashboard viewer. */
export function widgetHubSnapshot(): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const w of WIDGETS) out[w.snapshotKey] = w.hub?.snapshot() ?? {};
	return out;
}

/** Stop the widget hub (server shutdown). */
export function destroyWidgetHub(): void {
	for (const w of WIDGETS) {
		w.hub?.destroy();
		w.hub = null;
	}
}

/** Channels to keep attached, from one type's dashboard widgets. A widget can
 * contribute several (the merged chat widget, one spec per platform channel). */
export function widgetChannelSpecs(
	dashboards: ServerDashboard[],
	type: string,
	spec: (
		config: Record<string, string> | undefined,
	) => readonly (string | null)[],
): Set<string> {
	const channels = new Set<string>();
	for (const dash of dashboards)
		for (const w of dash.widgets) {
			if (w.type !== type) continue;
			for (const name of spec(w.config)) if (name) channels.add(name);
		}
	return channels;
}
