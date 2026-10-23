import type m from "mithril";
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
}
