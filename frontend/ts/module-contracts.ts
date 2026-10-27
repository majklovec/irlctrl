/**
 * Frontend module contracts — the shapes a modules/<id>/frontend.tsx
 * default-exports and the contribution interfaces the core pages compose.
 * Modules import these by type only; the registry (module-registry.ts)
 * discovers the registrations through the generated manifest.
 */
import type m from "mithril";
import type { LogWording } from "../../shared/logMessages";
import type {
    DeviceSummary,
    Role,
    ServerDashboardWidget,
    SetupInfo,
    Status,
    WidgetConfigField,
} from "../types";
import type { DeviceCard } from "./device/store";
import type { RpcClient } from "./services/rpc";

export interface ModuleSetupStep {
    id: string;
    title: string;
    subtitle: string;
    roles: readonly Role[];
    isValid(role: Role): boolean;
    render(role: Role, info: SetupInfo): m.Children;
    config(role: Role): Record<string, unknown>;
}

/** Live handle to one device the dashboard page is connected to. */
export interface DeviceLink {
    device: DeviceSummary;
    status?: Status;
    card: DeviceCard;
    rpc: Pick<RpcClient, "call" | "on" | "open">;
}

export interface DeviceDashboardContext extends DeviceLink {
    widget: ServerDashboardWidget;
}

/** Render context of a fleet widget: the user's devices and the live link of
 * each device the widget named (`devicesFor`), once the page connected to it. */
export interface FleetDashboardContext {
    widget: ServerDashboardWidget;
    devices: readonly DeviceSummary[];
    /** The live link of a device the widget names (`devicesFor`), once connected. */
    link(deviceId: string): DeviceLink | undefined;
    /** Open (and return) a live link to any of the user's devices on demand —
     * for the config editor's catalogue. Links no saved widget needs are
     * dropped when the editor closes; undefined for an unknown device. */
    connect(deviceId: string): DeviceLink | undefined;
}

export interface DeviceDashboardWidget {
    type: string;
    available(device: DeviceSummary): boolean;
    defaultSize: { w: number; h: number };
    minSize: { w: number; h: number };
    maxSize?: { w: number; h: number };
    configFields?: readonly WidgetConfigField[];
    body(context: DeviceDashboardContext): m.Children;
    badge?(context: DeviceDashboardContext): m.Children;
    destroy?(widgetId: string): void;
    /** Replace the generic per-field config form: render the widget's own
     * editor, mutating `values` (keyed by `configFields` names) in place. */
    configEditor?(
        context: DeviceDashboardContext,
        values: Record<string, string>,
    ): m.Children;
    /** Why the edited `values` cannot be saved yet (undefined when they can). */
    configError?(
        context: DeviceDashboardContext,
        values: Record<string, string>,
    ): string | undefined;
}

export interface DeviceSummaryColumn {
    id: string;
    order: number;
    available(device: DeviceSummary): boolean;
    header(): m.Children;
    cell(device: DeviceSummary): m.Children;
}

export interface FrontendModuleContributions {
    order?: number;
    available?(status: Status): boolean;
    dashboardWidgets?: readonly DeviceDashboardWidget[];
    setupSteps?: readonly ModuleSetupStep[];
    deviceSummaryColumns?: readonly DeviceSummaryColumn[];
    handleEvent?(event: string, data: unknown, host?: DeviceCard): void;
    /** Log wording for the module's methods (browser-side failure messages, labels). */
    log?: LogWording;
}

/** A device-card registration: the module's card on the device page plus its contributions. */
export interface FrontendModule extends FrontendModuleContributions {
    kind: "device-card";
    id: string;
    title: string;
    icon?: string;
    component: (status: Status) => m.Vnode;
    defaultSize: { w: number; h: number };
    minSize: { w: number; h: number };
    maxSize?: { w: number; h: number };
}

/** Render context the core hands a channel-widget module: the widget's
 * normalized channel key, the live state bag of its own device (undefined for
 * device-independent widgets) and its device info. */
export interface WidgetContext {
    /** The widget's normalized channel key ("" when not configured). */
    channel: string;
    deviceLive?: Record<string, unknown> | null;
    device?: Record<string, unknown> | null;
}

/** A channel-widget registration (device-independent dashboard widgets fed by
 * the dashboard websocket). The module owns its live state, folded by `onFrame`. */
export interface ChannelWidgetModule<TWidget = ServerDashboardWidget> {
    kind: "widget";
    id: string;
    /** Widget types this module composes; the core routes by this. */
    widgetTypes: readonly string[];
    defaultSize: { w: number; h: number };
    configFields: readonly WidgetConfigField[];
    body(w: TWidget, ctx: WidgetContext): m.Children;
    badge(w: TWidget, ctx: WidgetContext): m.Children;
    /** Receive one dashboard-websocket frame and fold it into the module's own live state. */
    onFrame?(event: string, data: unknown): void;
    log?: LogWording;
}

/** A dashboard widget offered once, not bound to one device: its config names
 * the devices it drives and the core keeps a live link to each of them. */
export interface FleetDashboardWidget {
    type: string;
    defaultSize: { w: number; h: number };
    minSize: { w: number; h: number };
    maxSize?: { w: number; h: number };
    configFields: readonly WidgetConfigField[];
    /** The devices the widget needs a live connection to, read from its config. */
    devicesFor(widget: ServerDashboardWidget): string[];
    body(context: FleetDashboardContext): m.Children;
    badge?(context: FleetDashboardContext): m.Children;
    configEditor(
        context: FleetDashboardContext,
        values: Record<string, string>,
    ): m.Children;
    configError?(
        context: FleetDashboardContext,
        values: Record<string, string>,
    ): string | undefined;
    destroy?(widgetId: string): void;
}

/** A dashboard-widgets-only registration: a module that adds widgets to the
 * dashboards without a card on the device page — device-bound ones
 * (`dashboardWidgets`) and/or fleet ones (`fleetWidgets`; the Buttons widget
 * composes other modules' actions across devices this way). */
export interface DashboardWidgetModule {
    kind: "dashboard";
    id: string;
    dashboardWidgets?: readonly DeviceDashboardWidget[];
    fleetWidgets?: readonly FleetDashboardWidget[];
    log?: LogWording;
}

export type FrontendRegistration =
    | FrontendModule
    | ChannelWidgetModule
    | DashboardWidgetModule;
