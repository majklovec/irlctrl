/* Shared dashboard parts: the live widget preview is used both by the dashboards
 * management page and by the read-only dashboard view page. The device list is
 * pushed live over the shared feed websocket, and live widget data flows over the
 * control server's per-device viewer websockets (d/<id>/ws). */
import m from "mithril";
import type {
	DeviceInfo,
	DeviceSummary,
	GridSize,
	ServerDashboard,
	ServerDashboardWidget,
	Status,
	WidgetType,
} from "../types";
import { configFieldName, visibleWidgetConfigFields } from "../types";
import { Badge, Button } from "./components/ui";
import { createCardHost, type DeviceCard } from "./device/store";
import { t } from "./i18n";
import type {
	DeviceDashboardContext,
	DeviceLink,
	FleetDashboardContext,
} from "./module-contracts";
import {
	destroyDeviceWidget,
	deviceWidgetForType,
	deviceWidgetsForType,
	deviceWidgetTypesFor,
	dispatchWidgetFrame,
	fleetWidgetForType,
	fleetWidgetTypes,
	type WidgetContext,
	widgetConfigFieldsForType,
	widgetModuleForType,
	widgetModuleTypes,
} from "./module-registry";
import { RpcClient, socketUrl } from "./services/rpc";
import { serverLive } from "./services/serverws";
import { configSelectField } from "./widget-config-select";

/** Device-independent widget types — offered once, with no device of their
 * own: the channel widgets (their data is fetched by the control server) and
 * the fleet widgets (their config names the devices they drive). The modules
 * declare their own types; the core routes through the registry. */
const INDEPENDENT: ReadonlySet<WidgetType> = new Set<WidgetType>([
	...widgetModuleTypes(),
	...fleetWidgetTypes(),
] as WidgetType[]);
export const isIndependent = (type: WidgetType): boolean =>
	INDEPENDENT.has(type);

/** Live data for one device, accumulated from its viewer websocket (or a 409). */
interface DeviceLive {
	device?: DeviceInfo;
	status?: Status;
}
interface Connection {
	rpc: RpcClient;
	live: DeviceLive;
	card: DeviceCard;
}

let rpcConn: RpcClient | null = null;

/** One server websocket for the dashboard pages: the live device list,
 * cross-client dashboard sync, and the channel widgets' frames — every frame
 * the core does not own itself is forwarded to the widget modules, which fold
 * the ones they care about into their own per-channel live state. */
function ensureDashboardsConn(): void {
	if (rpcConn) return;
	rpcConn = serverLive.rpc;
	rpcConn.onAny((event, data) => {
		// Cross-client sync: the control server broadcasts `dashboards.changed`
		// here whenever any client saves a dashboard; the owning page rebases.
		if (event === "dashboards.changed") return onDashboardsChanged(data);
		// Live device list: feeds widget titles / badges without HTTP polling.
		if (event === "devices.snapshot" || event === "devices.changed") {
			applyDeviceList(data as DeviceSummary[]);
			return;
		}
		dispatchWidgetFrame(event, data);
		m.redraw();
	});
	// The feed socket connects at module load, so the server's `widget.snapshot`
	// can arrive before this handler exists; the chat module's connection badges
	// (fed only by that snapshot until a reconnect frame) would stay stuck
	// offline without the replay.
	if (serverLive.widgetSnapshot !== null)
		dispatchWidgetFrame("widget.snapshot", serverLive.widgetSnapshot);
}

/** Open the dashboards websocket so the page can listen for
 * `dashboards.changed` broadcasts, even when it has no channel widget. */
export function ensureDashboardsWs(): void {
	ensureDashboardsConn();
}

/** A channel widget's normalized channel key ("" when not configured) — the
 * universal `channel` config parameter shared by the channel widgets. */
export const widgetChannel = (w: ServerDashboardWidget): string =>
	(w.config?.channel ?? "").trim().toLowerCase();

/** The render context the core hands a widget module: its normalized channel,
 * its device's live bag (null for device-independent widgets) plus the device
 * info — the module reads what it composes structurally. */
export const widgetCtx = (w: ServerDashboardWidget): WidgetContext => ({
	channel: widgetChannel(w),
	deviceLive: (connectionFor(effectiveDeviceId(w))?.live ?? null) as Record<
		string,
		unknown
	> | null,
	device: (deviceById(effectiveDeviceId(w)) ?? null) as Record<
		string,
		unknown
	> | null,
});

// ---------------------------------------------------------------------- devices

export const devices: { list: DeviceSummary[] | null } = { list: null };

// One fetch per navigation; afterwards the feed's devices.changed pushes
// keep the list (and the widgets' titles / badges) live.
export async function refreshDevices(): Promise<void> {
	try {
		const res = await fetch("/api/devices", { cache: "no-store" });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		applyDeviceList((await res.json()) as DeviceSummary[]);
	} catch {
		// keep the last known list; connectivity is also visible in the live widgets
	}
}

/** Apply a devices.snapshot / devices.changed push to the shared list. */
function applyDeviceList(list: DeviceSummary[]): void {
	devices.list = list;
	m.redraw();
}

export const deviceById = (deviceId: string): DeviceSummary | undefined =>
	devices.list?.find((d) => d.id === deviceId);

export const deviceLabel = (d: DeviceSummary): string => d.hostname || d.id;

export const typeLabel = (type: WidgetType): string =>
	t(`wtype.${type.replace("-", "_")}`);

/** Widget types a device offers, declared by its frontend modules. */
export function widgetTypesFor(d: DeviceSummary): WidgetType[] {
	return deviceWidgetTypesFor(d);
}

/** Widget types that are not tied to a device: always offered — channel
 * widgets (their data is fetched by the server) and fleet widgets. */
export function independentTypes(): WidgetType[] {
	return [...widgetModuleTypes(), ...fleetWidgetTypes()] as WidgetType[];
}

/** The device a widget's data comes from — its own for device-bound widgets;
 * channel widgets are device-independent and don't open a device connection. */
export function effectiveDeviceId(w: ServerDashboardWidget): string {
	return isIndependent(w.type) ? "" : w.deviceId;
}

// ------------------------------------------------------------------- connections

const connections = new Map<string, Connection>();
const activeDeviceWidgets = new Map<string, string>();
/** The dashboard the connections were last synced for (see `pruneConnections`). */
let syncedDash: ServerDashboard | undefined;

/** Open the viewer websocket of one device (no-op when already open). */
function openConnection(id: string): Connection {
	const existing = connections.get(id);
	if (existing) return existing;
	const live: DeviceLive = {};
	const rpc = new RpcClient(() => socketUrl(`/d/${encodeURIComponent(id)}/ws`));
	const conn: Connection = { rpc, live, card: createCardHost({ rpc }) };
	connections.set(id, conn);
	rpc.on("device", (data) => {
		const info = data as DeviceInfo;
		live.device = info;
		if (!info.online) conn.card.clearEvents();
	});
	rpc.on("status", (data) => {
		live.status = data as Status;
		conn.card.applyStatus(live.status!);
	});
	rpc.onAny((event, data) => {
		if (event !== "status" && event !== "open" && event !== "close")
			conn.card.handleEvent(event, data);
		m.redraw();
	});
	rpc.on("close", () => conn.card.clearEvents());
	// Warm start: pull last snapshots once the socket is open (a 409 means the
	// module is not enabled there). `call` rejects before the socket is OPEN, so
	// this must run from the "open" event — initial connect and every reconnect.
	rpc.on("open", () => {
		conn.card.handleEvent("open", undefined);
		void rpc.call("status").catch(() => undefined);
	});
	return conn;
}

/** One viewer websocket per device referenced by the dashboard's widgets. */
export function syncConnectionsFor(dash: ServerDashboard | undefined): void {
	syncedDash = dash;
	const nextWidgets = new Map(
		(dash?.widgets ?? [])
			.filter((w) => !isIndependent(w.type) || fleetWidgetForType(w.type))
			.map((w) => [widgetKey(w), w.type]),
	);
	for (const [id, type] of activeDeviceWidgets)
		if (nextWidgets.get(id) !== type) destroyDeviceWidget(type, id);
	activeDeviceWidgets.clear();
	for (const [id, type] of nextWidgets) activeDeviceWidgets.set(id, type);

	// Device widgets need their own device; fleet widgets every device they name.
	const wanted = new Set(
		(dash?.widgets ?? []).flatMap((w) => [
			effectiveDeviceId(w),
			...(fleetWidgetForType(w.type)?.devicesFor(w) ?? []),
		]),
	);
	for (const [id, conn] of connections) {
		if (!wanted.has(id) || !id) {
			conn.rpc.destroy();
			connections.delete(id);
		}
	}
	for (const id of wanted) if (id) openConnection(id);
	if ((dash?.widgets ?? []).some((w) => isIndependent(w.type)))
		ensureDashboardsConn();
}

/** Drop the connections a fleet widget's editor opened on demand (`connect`)
 * that no saved widget needs — run when the editor closes. */
const pruneConnections = (): void => syncConnectionsFor(syncedDash);

const connectionFor = (deviceId: string): Connection | undefined =>
	connections.get(deviceId);

// ---------------------------------------------------------------------- widgets

function deviceLink(device: DeviceSummary): DeviceLink | undefined {
	const conn = connectionFor(device.id);
	if (!conn) return undefined;
	return {
		device,
		status: conn.card.st.status ?? undefined,
		card: conn.card,
		rpc: conn.rpc,
	};
}

function deviceWidgetContext(
	w: ServerDashboardWidget,
	device: DeviceSummary,
): DeviceDashboardContext | undefined {
	const link = deviceLink(device);
	return link ? { widget: w, ...link } : undefined;
}

/** The render context of a fleet widget: the user's devices plus a live link
 * per device the widget named (once the page connected to it). `connect`
 * opens a link to any other device of the user on demand (the editor's
 * catalogue); those extra links are pruned when the editor closes. */
function fleetContext(w: ServerDashboardWidget): FleetDashboardContext {
	return {
		widget: w,
		devices: devices.list ?? [],
		link(deviceId) {
			const device = deviceById(deviceId);
			return device ? deviceLink(device) : undefined;
		},
		connect(deviceId) {
			const device = deviceById(deviceId);
			if (!device) return undefined;
			openConnection(deviceId);
			return deviceLink(device);
		},
	};
}

function deviceWidget(w: ServerDashboardWidget): m.Children {
	const device = deviceById(w.deviceId);
	if (!device) return <p class="muted">{t("dash.widget_missing")}</p>;
	const conn = connectionFor(device.id);
	if (!conn) return <p class="muted">{t("dev.badge.offline")}</p>;
	if (!conn.card.st.status)
		return <p class="muted">{t("dash.widget_waiting")}</p>;
	const context = deviceWidgetContext(w, device);
	const contributions = deviceWidgetsForType(w.type, device);
	if (!context || contributions.length === 0)
		return <p class="muted">{t("dash.widget_missing")}</p>;
	const bodies = contributions.map(({ module, widget }) => (
		<div class={`mod-${module.id}`}>{widget.body(context)}</div>
	));
	return bodies.length === 1 ? bodies[0] : <div>{bodies}</div>;
}

/** Widget modules own their badges; otherwise the shell shows device presence. */
function widgetBadge(w: ServerDashboardWidget): m.Children {
	const channelModule = widgetModuleForType(w.type);
	if (channelModule) return channelModule.badge(w, widgetCtx(w)) as m.Children;
	const fleet = fleetWidgetForType(w.type);
	if (fleet) return fleet.badge?.(fleetContext(w)) ?? null;

	const device = deviceById(w.deviceId);
	if (!device) return <Badge text={t("dash.widget_missing")} kind="warn" />;
	const context = deviceWidgetContext(w, device);
	const contribution = deviceWidgetsForType(w.type, device)[0];
	if (context && contribution?.widget.badge)
		return contribution.widget.badge(context);
	return (
		<Badge
			text={device.online ? t("dev.badge.online") : t("dev.badge.offline")}
			kind={device.online ? "on" : "off"}
		/>
	);
}

/** Per-widget state of the inline config editor (pencil icon). The field
 * names are the widget module's `configFields`; the core keeps them opaque. */
interface WidgetConfigState {
	editing: boolean;
	values: Record<string, string>;
}
const widgetConfigState = new Map<string, WidgetConfigState>();

/** Registered by the page rendering the dashboard; persists the in-place
 * widget mutation (PUT the dashboard) when the inline editor saves. */
let widgetConfigSaver: ((w: ServerDashboardWidget) => void) | null = null;
export function setWidgetConfigSaver(
	fn: ((w: ServerDashboardWidget) => void) | null,
): void {
	widgetConfigSaver = fn;
}

/** Registered by the page owning the grid; called when the server broadcasts
 * a `dashboards.changed` event (this dashboard was saved elsewhere). */
let dashboardChangedSink:
	| ((
			data: {
				id: string;
				widgets: ServerDashboardWidget[];
				version: number;
			} | null,
	  ) => void)
	| null = null;
export function setDashboardChangedSink(
	fn:
		| ((
				data: {
					id: string;
					widgets: ServerDashboardWidget[];
					version: number;
				} | null,
		  ) => void)
		| null,
): void {
	dashboardChangedSink = fn;
}
export function onDashboardsChanged(data: unknown): void {
	dashboardChangedSink?.(
		data as {
			id: string;
			widgets: ServerDashboardWidget[];
			version: number;
		} | null,
	);
}

/** A device widget's own config editor (its module's `configEditor` hook), or
 * null when the type uses the generic per-field form. */
function customConfigEditor(
	w: ServerDashboardWidget,
	values: Record<string, string>,
): { editor: m.Children; error?: string } | null {
	const fleet = fleetWidgetForType(w.type);
	if (fleet) {
		const context = fleetContext(w);
		return {
			editor: fleet.configEditor(context, values),
			error: fleet.configError?.(context, values),
		};
	}
	const widget = isIndependent(w.type)
		? undefined
		: deviceWidgetForType(w.type);
	if (!widget?.configEditor) return null;
	const device = deviceById(w.deviceId);
	const context = device ? deviceWidgetContext(w, device) : undefined;
	if (!context) {
		const error = t("dash.widget_missing");
		return { editor: <p class="muted">{error}</p>, error };
	}
	return {
		editor: widget.configEditor(context, values),
		error: widget.configError?.(context, values),
	};
}

/** The inline editor that opens from the pencil icon on a configurable widget.
 * One field per parameter in the widget module's `configFields` (labels and
 * placeholders come from `dash.widget_<name>` i18n keys), unless the widget
 * brings its own editor. */
function configEditorForm(w: ServerDashboardWidget): m.Vnode {
	const fields = widgetConfigFieldsForType(w.type);
	const key = widgetKey(w);
	const s = widgetConfigState.get(key) ?? {
		editing: true,
		values: { ...(w.config ?? {}) },
	};
	const custom = customConfigEditor(w, s.values);
	const visibleFields = custom ? [] : visibleWidgetConfigFields(fields);
	return (
		// Keyed so Mithril replaces it wholesale when the widget swaps
		// between body (`key="buttons-live"` & co.) and config form — an
		// in-place patch would repurpose a live GridStack host node.
		<div class="dash-config-form" key="dash-config-form">
			{[
				...(custom
					? [
							<div class="dash-config-custom" key="custom">
								{custom.editor}
							</div>,
						]
					: []),
				...visibleFields.map((field) => {
					const name = configFieldName(field);
					const isSelect = typeof field !== "string" && field.type === "select";
					const select = isSelect
						? configSelectField(
								field,
								widgetModuleForType(w.type),
								s.values[name] ?? "",
							)
						: undefined;
					return (
						<label key={name}>
							{[
								<span>{t(`dash.widget_${name}`)}</span>,
								isSelect ? (
									<select
										class="dash-config-input"
										value={select?.value ?? ""}
										onchange={(e: Event) => {
											s.values[name] = (e.target as HTMLSelectElement).value;
										}}
									>
										{select?.options ?? []}
									</select>
								) : (
									<input
										class="dash-config-input"
										value={s.values[name] ?? ""}
										placeholder={t(`dash.widget_${name}`)}
										oninput={(e: Event) => {
											s.values[name] = (e.target as HTMLInputElement).value;
										}}
									/>
								),
							]}
						</label>
					);
				}),
				<div class="dash-config-actions" key="actions">
					{[
						custom?.error ? (
							<span class="dash-config-error">{custom.error}</span>
						) : null,
						<Button
							label={t("ui.save")}
							disabled={!!custom?.error}
							onclick={(e: Event) => {
								e.preventDefault();
								if (custom?.error) return;
								w.config = Object.fromEntries(
									fields.map((field) => {
										const nm = configFieldName(field);
										let v = (s.values[nm] ?? "").trim();
										if (
											typeof field !== "string" &&
											field.type === "select" &&
											v === ""
										) {
											v = field.options[0] ?? "";
										}
										return [nm, v];
									}),
								);
								widgetConfigState.delete(key);
								widgetConfigSaver?.(w);
								pruneConnections();
								m.redraw();
							}}
						/>,
						<Button
							label={t("ui.cancel")}
							onclick={() => {
								widgetConfigState.delete(widgetKey(w));
								pruneConnections();
								m.redraw();
							}}
						/>,
					]}
				</div>,
			]}
		</div>
	);
}

const widgetKey = (w: ServerDashboardWidget): string =>
	w.id || `${w.type}:${w.name}`;

/** Channel widgets are device-independent: the server fetches the widget's
 * channel and pushes the data over the dashboard websocket. */
/** Card title: "device · type" for device widgets, just "type" for the channel ones. */
export function widgetTitle(w: ServerDashboardWidget): string {
	const d = deviceById(w.deviceId);
	const prefix = isIndependent(w.type) || !d ? "" : `${deviceLabel(d)} · `;
	return prefix + t(`wtype.${w.type.replace("-", "_")}`);
}

/** The app build a device reports in its hello, shown next to the title so a box
 * stuck on an old build (no `pipelines.list`, no stats pushes) is visible here
 * instead of as a silently empty widget. */
function widgetVersion(w: ServerDashboardWidget): m.Vnode | null {
	if (isIndependent(w.type)) return null;
	const d = deviceById(w.deviceId);
	const version = connectionFor(w.deviceId)?.live.device?.version ?? d?.version;
	if (version)
		return (
			<span class="dash-widget-version" title={version}>
				{version}
			</span>
		);
	// A device that answers (hello without a version field) runs a pre-version
	// build: its widget data (pipelines, stats) simply does not exist yet there.
	return d?.online ? (
		<span class="dash-widget-version stale" title={t("dash.version_stale")}>
			old app
		</span>
	) : null;
}

/** Live body for an independent widget or a module-contributed device widget. */
function bodyFor(w: ServerDashboardWidget): m.Children {
	const mod = widgetModuleForType(w.type);
	if (mod) return mod.body(w, widgetCtx(w)) as m.Children;
	const fleet = fleetWidgetForType(w.type);
	if (fleet) return fleet.body(fleetContext(w));
	return deviceWidget(w);
}

/** Default/min/max `{w, h}` for a widget type — the module's own grid
 * contract, used when adding a widget or constraining a resize. */
export function widgetSize(type: WidgetType): {
	default: GridSize;
	min: GridSize;
	max?: GridSize;
} {
	const wm = widgetModuleForType(type);
	if (wm) return { default: wm.defaultSize, min: wm.defaultSize };
	const widget = fleetWidgetForType(type) ?? deviceWidgetForType(type);
	if (widget)
		return {
			default: widget.defaultSize,
			min: widget.minSize,
			max: widget.maxSize,
		};
	return { default: { w: 4, h: 4 }, min: { w: 3, h: 3 } };
}

export interface WidgetActions {
	remove: (w: ServerDashboardWidget) => void;
	hide: (w: ServerDashboardWidget) => void;
}

/** The live grid content for one widget: a slim persistent header (title, and
 * in edit mode a drag grip plus remove/hide/config actions) above the live body.
 * GridStack owns the surrounding `.grid-stack-item`; this is what fills it. */
export function widgetInner(
	w: ServerDashboardWidget,
	editMode: boolean,
	actions: WidgetActions,
): m.Vnode {
	const key = widgetKey(w);
	const configurable = widgetConfigFieldsForType(w.type).length > 0;
	const editing =
		configurable && editMode && (widgetConfigState.get(key)?.editing ?? false);
	return (
		<div
			key={key}
			class={[
				"dash-widget",
				editMode ? "is-edit-mode" : undefined,
				editing ? "is-editing" : undefined,
			]
				.filter(Boolean)
				.join(" ")}
		>
			{[
				<div class="dash-widget-head">
					{[
						<span class="dash-grip">
							{[
								editMode ? <span class="dash-grip-icon">⠿</span> : null,
								<span class="dash-widget-title">{widgetTitle(w)}</span>,
								// The status badge sits right next to the title (hidden while the config form is open).
								editing
									? null
									: [
											widgetVersion(w),
											<span class="dash-widget-badge">{widgetBadge(w)}</span>,
										],
							]}
						</span>,
						editMode ? (
							<span class="dash-widget-actions">
								{[
									configurable && !editing ? (
										<button
											class="icon-btn dash-widget-config"
											title={t("dash.widget_settings")}
											aria-label={t("dash.widget_settings")}
											onclick={(e: Event) => {
												e.stopPropagation();
												const s = widgetConfigState.get(key) ?? {
													editing: false,
													values: {
														...(w.config ?? {}),
													},
												};
												s.editing = !s.editing;
												widgetConfigState.set(key, s);
												if (!s.editing) pruneConnections();
												m.redraw();
											}}
										>
											⚙
										</button>
									) : null,
									<button
										class="icon-btn dash-widget-remove"
										title={t("dash.remove")}
										aria-label={t("dash.remove")}
										onclick={(e: Event) => {
											e.stopPropagation();
											actions.remove(w);
										}}
									>
										×
									</button>,
								]}
							</span>
						) : null,
					]}
				</div>,
				<div class="dash-widget-body">
					{editing ? configEditorForm(w) : bodyFor(w)}
				</div>,
			]}
		</div>
	);
}
