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

export interface DeviceDashboardContext {
	widget: ServerDashboardWidget;
	device: DeviceSummary;
	status?: Status;
	card: DeviceCard;
	rpc: Pick<RpcClient, "call" | "on" | "open">;
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

export type FrontendRegistration = FrontendModule | ChannelWidgetModule;
