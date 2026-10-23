/**
 * Frontend module registry — the only module entry point frontend/ts (the device
 * store, dashboards) imports for module cards and event handling.
 *
 * Modules are discovered through a build-time generated manifest
 * (`generated/modules.frontend.ts`, emitted by `scripts/gen-modules.ts`): one
 * static import per frontend.tsx inside a modules subdirectory, in sorted path
 * order, default-exporting the array. The browser bundle therefore never uses
 * Glob and every module is statically resolved (see REFACTOR-modules.md §4.1).
 * Adding a module directory with a `frontend.tsx` default export registers it
 * here — no frontend-registry edits (regeneration happens automatically).
 *
 * Frontend-only file: the server never imports it (it mounts the device store
 * at module init). Kept in frontend/ts so the module code stays out of the core import
 * graph.
 */
import m from "mithril";
import MANIFEST from "../../generated/modules.frontend";
import type {
	DeviceSummary,
	Role,
	ServerDashboardWidget,
	Status,
	WidgetConfigField,
} from "../../shared/types";
import { type DeviceCard, setFrontendEventSink } from "./device/store";
import type {
	DeviceDashboardWidget,
	DeviceSummaryColumn,
	FrontendModuleContributions,
	ModuleSetupStep,
} from "./module-contracts";

/** Render context the core hands a widget module: the widget's normalized
 * channel key, the live state bag of its own device (undefined for
 * device-independent widgets) and its device info. Lets a module read the
 * device state it composes (e.g. srtla stats) without the core naming a
 * module's renderer. `deviceLive` is the core's per-device live data (its own
 * `DeviceLive` bag, read structurally); `device` is the device info. */
export interface WidgetContext {
	/** The widget's normalized channel key ("" when not configured). */
	channel: string;
	deviceLive?: Record<string, unknown> | null;
	device?: Record<string, unknown> | null;
}

/** Frontend descriptor of a self-contained widget module (local copy of the
 * documented shape; the core names the shape, modules never import it).
 *
 * The module owns its live state (its own per-channel map), fed by `onFrame`;
 * `body`/`badge` render from it plus, where relevant, the widget's device state
 * in `ctx`. `body`/`badge` take the widget only — no separate `live` argument —
 * so the core never has to resolve which live map a widget type reads. */
interface ChannelWidgetModule<TWidget = unknown> {
	id: string;
	kind: "widget";
	/** Widget types this module composes; the core routes by this, not by a
	 * hard-coded type→module table. */
	widgetTypes: readonly string[];
	/** Grid cell count for a widget of this module's types (grid policy). */
	defaultSize: { w: number; h: number };
	configFields: readonly WidgetConfigField[];
	body(w: TWidget, ctx: WidgetContext): unknown;
	badge(w: TWidget, ctx: WidgetContext): unknown;
	/** Optional: receive one dashboard-websocket frame and fold it into the
	 * module's own live state (chat modules are fed this way; device-liveness
	 * widgets read `ctx` instead and omit it). */
	onFrame?(event: string, data: unknown): void;
}

/** A browser-side module registration (device card). Local copy: the core
 * names the shape, modules never import across boundaries. */
export interface FrontendModule extends FrontendModuleContributions {
	id: string;
	title: string;
	icon?: string;
	kind: "device-card";
	order?: number;
	component: (status: Status) => m.Vnode;
	defaultSize: { w: number; h: number };
	minSize: { w: number; h: number };
	maxSize?: { w: number; h: number };
}

type FrontendRegistration =
	| FrontendModule
	| ChannelWidgetModule<ServerDashboardWidget>;

const isRegistration = (mod: unknown): mod is FrontendRegistration =>
	typeof mod === "object" &&
	mod !== null &&
	typeof (mod as FrontendRegistration).id === "string" &&
	typeof (mod as FrontendRegistration).kind === "string";

// The manifest default-exports each module's default export, which is a single
// registration or an array of them (a module can register a device-card plus one
// or more dashboard widgets); flatten to one registration per entry.
const registrations = (
	MANIFEST as unknown as (FrontendRegistration | FrontendRegistration[])[]
)
	.flat()
	.filter(isRegistration);

export const FRONTS = registrations;

export const FRONTEND_MODULES: FrontendModule[] = FRONTS.filter(
	(mod): mod is FrontendModule => mod.kind === "device-card",
) as FrontendModule[];

export function frontendModulesForStatus(status: Status): FrontendModule[] {
	return FRONTEND_MODULES.filter((mod) => mod.available?.(status) ?? true);
}

export interface RegisteredDeviceWidget {
	module: FrontendModule;
	widget: DeviceDashboardWidget;
}

export function deviceWidgetsForType(
	type: string,
	device: DeviceSummary,
): RegisteredDeviceWidget[] {
	return FRONTEND_MODULES.flatMap((module) =>
		(module.dashboardWidgets ?? [])
			.filter((widget) => widget.type === type && widget.available(device))
			.map((widget) => ({ module, widget })),
	);
}

export function deviceWidgetForType(
	type: string,
): DeviceDashboardWidget | undefined {
	return FRONTEND_MODULES.flatMap(
		(module) => module.dashboardWidgets ?? [],
	).find((widget) => widget.type === type);
}

export function destroyDeviceWidget(type: string, widgetId: string): void {
	for (const module of FRONTEND_MODULES)
		for (const widget of module.dashboardWidgets ?? [])
			if (widget.type === type) widget.destroy?.(widgetId);
}

export function deviceWidgetTypesFor(device: DeviceSummary): string[] {
	return [
		...new Set(
			FRONTEND_MODULES.flatMap((module) =>
				(module.dashboardWidgets ?? [])
					.filter((widget) => widget.available(device))
					.map((widget) => widget.type),
			),
		),
	];
}

export function setupStepsForRole(role: Role): ModuleSetupStep[] {
	return FRONTEND_MODULES.flatMap((module) =>
		(module.setupSteps ?? []).filter((step) => step.roles.includes(role)),
	);
}

export function deviceSummaryColumnsFor(
	device: DeviceSummary,
): DeviceSummaryColumn[] {
	const columns = new Map<string, DeviceSummaryColumn>();
	for (const module of FRONTEND_MODULES)
		for (const column of module.deviceSummaryColumns ?? [])
			if (column.available(device) && !columns.has(column.id))
				columns.set(column.id, column);
	return [...columns.values()].sort((left, right) => left.order - right.order);
}

export function deviceSummaryColumnDefinitions(): DeviceSummaryColumn[] {
	const columns = new Map<string, DeviceSummaryColumn>();
	for (const module of FRONTEND_MODULES)
		for (const column of module.deviceSummaryColumns ?? [])
			if (!columns.has(column.id)) columns.set(column.id, column);
	return [...columns.values()].sort((left, right) => left.order - right.order);
}

export const WIDGET_MODULES = FRONTS.filter(
	(mod): mod is ChannelWidgetModule<ServerDashboardWidget> =>
		mod.kind === "widget",
) as ChannelWidgetModule<ServerDashboardWidget>[];

export function widgetModule(
	id: string,
): ChannelWidgetModule<ServerDashboardWidget> | undefined {
	return WIDGET_MODULES.find((wm) => wm.id === id);
}

/** Widget type → the module that composes it, declared by the module's
 * `widgetTypes`. The core routes a widget type through this table — it names no
 * module itself. */
const WIDGET_TYPE_TO_MODULE = new Map<
	string,
	ChannelWidgetModule<ServerDashboardWidget>
>();
for (const wm of WIDGET_MODULES)
	for (const type of wm.widgetTypes ?? []) WIDGET_TYPE_TO_MODULE.set(type, wm);

export function widgetModuleForType(
	type: string,
): ChannelWidgetModule<ServerDashboardWidget> | undefined {
	return WIDGET_TYPE_TO_MODULE.get(type);
}

/** The widget types the registered modules compose. */
export function widgetModuleTypes(): string[] {
	return [...WIDGET_TYPE_TO_MODULE.keys()];
}

export function widgetConfigFieldsForType(
	type: string,
): readonly WidgetConfigField[] {
	const channelFields = widgetModuleForType(type)?.configFields;
	if (channelFields) return channelFields;
	return (
		FRONTEND_MODULES.flatMap((module) => module.dashboardWidgets ?? []).find(
			(widget) => widget.type === type,
		)?.configFields ?? []
	);
}

/** Forward one dashboard-websocket frame to every widget module's `onFrame`.
 * Each module folds the frames it cares into its own live state and ignores the
 * rest, so the core stays free of per-platform frame parsing. */
export function dispatchWidgetFrame(event: string, data: unknown): void {
	for (const wm of WIDGET_MODULES) wm.onFrame?.(event, data);
}

export function moduleCards(status: Status): m.Vnode[] {
	return frontendModulesForStatus(status)
		.sort((left, right) => (left.order ?? 0) - (right.order ?? 0))
		.map((mod) => mod.component(status));
}

// Dispatch a pushed event to every frontend module that handles it.
export function dispatchFrontendEvent(
	event: string,
	data: unknown,
	host?: DeviceCard,
): void {
	for (const mod of FRONTEND_MODULES) mod.handleEvent?.(event, data, host);
}

// Register this dispatcher with the device store. The store is imported from
// module frontends, so it cannot import this registry back (cycle); this is
// the one direction allowed.
setFrontendEventSink(dispatchFrontendEvent);
