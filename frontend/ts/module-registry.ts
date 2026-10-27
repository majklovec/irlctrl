/**
 * Frontend module registry — the only module entry point frontend/ts (the device
 * store, dashboards) imports for module cards and event handling.
 *
 * Modules are discovered through a build-time generated manifest
 * (`generated/modules.frontend.ts`, emitted by `scripts/gen-modules.ts`): one
 * static import per frontend.tsx inside a modules subdirectory, in sorted path
 * order, default-exporting the array. The browser bundle therefore never uses
 * Glob and every module is statically resolved.
 * Adding a module directory with a `frontend.tsx` default export registers it
 * here — no frontend-registry edits (regeneration happens automatically).
 *
 * Frontend-only file: the server never imports it (it mounts the device store
 * at module init). Kept in frontend/ts so the module code stays out of the core import
 * graph.
 */
import type m from "mithril";
import MANIFEST from "../../generated/modules.frontend";
import { registerLogWording } from "../../shared/logMessages";
import type {
    DeviceSummary,
    Role,
    ServerDashboardWidget,
    Status,
    WidgetConfigField,
} from "../../shared/types";
import { type DeviceCard, setFrontendEventSink } from "./device/store";
import type {
    ChannelWidgetModule,
    DashboardWidgetModule,
    DeviceDashboardWidget,
    DeviceSummaryColumn,
    FleetDashboardWidget,
    FrontendModule,
    FrontendRegistration,
    ModuleSetupStep,
} from "./module-contracts";

export type { FrontendModule, WidgetContext } from "./module-contracts";

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

// Module log wording (browser-side failure messages, section labels)
for (const reg of FRONTS) if (reg.log) registerLogWording(reg.log);

export const FRONTEND_MODULES: FrontendModule[] = FRONTS.filter(
    (mod): mod is FrontendModule => mod.kind === "device-card",
) as FrontendModule[];

export function frontendModulesForStatus(status: Status): FrontendModule[] {
    return FRONTEND_MODULES.filter((mod) => mod.available?.(status) ?? true);
}

/** Every registration that contributes device-bound dashboard widgets: the
 * device cards plus the widgets-only (`dashboard`) registrations. */
const DEVICE_WIDGET_SOURCES: (FrontendModule | DashboardWidgetModule)[] =
    FRONTS.filter(
        (mod): mod is FrontendModule | DashboardWidgetModule =>
            mod.kind === "device-card" || mod.kind === "dashboard",
    );

export interface RegisteredDeviceWidget {
    module: FrontendModule | DashboardWidgetModule;
    widget: DeviceDashboardWidget;
}

export function deviceWidgetsForType(
    type: string,
    device: DeviceSummary,
): RegisteredDeviceWidget[] {
    return DEVICE_WIDGET_SOURCES.flatMap((module) =>
        (module.dashboardWidgets ?? [])
            .filter(
                (widget) => widget.type === type && widget.available(device),
            )
            .map((widget) => ({ module, widget })),
    );
}

export function deviceWidgetForType(
    type: string,
): DeviceDashboardWidget | undefined {
    return DEVICE_WIDGET_SOURCES.flatMap(
        (module) => module.dashboardWidgets ?? [],
    ).find((widget) => widget.type === type);
}

export function destroyDeviceWidget(type: string, widgetId: string): void {
    for (const module of DEVICE_WIDGET_SOURCES)
        for (const widget of module.dashboardWidgets ?? [])
            if (widget.type === type) widget.destroy?.(widgetId);
    fleetWidgetForType(type)?.destroy?.(widgetId);
}

/** Fleet widgets (offered once, not bound to one device) by type. */
const FLEET_WIDGETS = new Map<string, FleetDashboardWidget>();
for (const mod of FRONTS)
    if (mod.kind === "dashboard")
        for (const widget of mod.fleetWidgets ?? [])
            FLEET_WIDGETS.set(widget.type, widget);

export function fleetWidgetForType(
    type: string,
): FleetDashboardWidget | undefined {
    return FLEET_WIDGETS.get(type);
}

export function fleetWidgetTypes(): string[] {
    return [...FLEET_WIDGETS.keys()];
}

export function deviceWidgetTypesFor(device: DeviceSummary): string[] {
    return [
        ...new Set(
            DEVICE_WIDGET_SOURCES.flatMap((module) =>
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
    return [...columns.values()].sort(
        (left, right) => left.order - right.order,
    );
}

export function deviceSummaryColumnDefinitions(): DeviceSummaryColumn[] {
    const columns = new Map<string, DeviceSummaryColumn>();
    for (const module of FRONTEND_MODULES)
        for (const column of module.deviceSummaryColumns ?? [])
            if (!columns.has(column.id)) columns.set(column.id, column);
    return [...columns.values()].sort(
        (left, right) => left.order - right.order,
    );
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
    for (const type of wm.widgetTypes ?? [])
        WIDGET_TYPE_TO_MODULE.set(type, wm);

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
        fleetWidgetForType(type)?.configFields ??
        deviceWidgetForType(type)?.configFields ??
        []
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
