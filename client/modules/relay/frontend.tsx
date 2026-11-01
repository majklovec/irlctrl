/* SRTLA card: srtla_send state, the receiver form and the scheduler options.
 * The SRTLA module is the relay device's single card: it composes the interfaces
 * table (with the live SRTLA link stats) and the modem panels, so the device
 * page and dashboard widgets show the same content. */
import "./styles.css";
import {
	Actions,
	Badge,
	Break,
	Button,
	Card,
	Checkbox,
	CheckField,
	type Child,
	DefinitionList,
	Field,
	FieldGroup,
	Form,
	IconButton,
	Input,
	numberAttrs,
	Options,
	Select,
} from "@ui/components/";
import m from "mithril";
import type {
	DeviceDashboardWidget,
	FrontendModule,
} from "../../../shared/contracts/frontend_module";
import type { DeviceSummary, SetupInfo } from "../../../shared/contracts/wire";
import { confirmDialog } from "../../../shared/ui/components/confirm";
import { Icon, OutlineIcon } from "../../../shared/ui/components/icons";
import { card, type DeviceCard } from "../../../shared/ui/device/store";
import { t } from "../../../shared/ui/i18n";
import {
	formatBitrate,
	formatSpeed,
	inRange,
	since,
} from "../../../shared/ui/util";
import log from "./log";
import { defaultRouteRowIndex } from "./route_view";
import type {
	ModemInfo,
	RelayDeviceSummary,
	RelayStatus,
	SrtlaLinkStats,
	SrtlaOptions,
	SrtlaStats,
	SrtlaStatsEvent,
} from "./types";

type EncoderStart = (
	host: DeviceCard,
	target: { remoteHost: string; remotePort: string },
) => void;
type EncoderStreamButtons = (
	host: DeviceCard,
	stopMethod: string,
) => m.Children;

/** The role pictogram (the summary column header and the role tag share it). */
const relayIcon = () => (
	<OutlineIcon class="role-icon role-icon-relay">
		<circle cx="12" cy="9" r="2" />
		<path d="M12 11v11M9 22h6" />
		<path d="M8.5 5.5a5 5 0 0 0 0 7M15.5 5.5a5 5 0 0 1 0 7" />
		<path d="M5.6 2.6a9 9 0 0 0 0 12.8M18.4 2.6a9 9 0 0 1 0 12.8" />
	</OutlineIcon>
);

function startCombinedStream(host: DeviceCard): void {
	const start = host.getCapability<EncoderStart>("encoder.start");
	if (!start)
		throw new Error("Encoder module did not provide its start capability");
	start(host, relayState(host).fields);
}

function combinedStreamButtons(
	host: DeviceCard,
	stopMethod: string,
): m.Children {
	const render = host.getCapability<EncoderStreamButtons>(
		"encoder.streamButtons",
	);
	if (!render)
		throw new Error("Encoder module did not provide its stream controls");
	return render(host, stopMethod);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

function isSrtlaStats(value: unknown): value is SrtlaStats {
	return (
		isRecord(value) &&
		typeof value.active_links === "number" &&
		typeof value.total_links === "number" &&
		typeof value.total_in_flight === "number" &&
		typeof value.total_window === "number" &&
		Array.isArray(value.links)
	);
}

function isSrtlaStatsEvent(value: unknown): value is SrtlaStatsEvent {
	return (
		isRecord(value) &&
		typeof value.at === "number" &&
		(value.stats === null || isSrtlaStats(value.stats))
	);
}

const statsFrame = (host: DeviceCard) => {
	const entry = host.st.events.get("relay.stats");
	return entry && isSrtlaStatsEvent(entry.data)
		? { ...entry, value: entry.data }
		: undefined;
};

const setupFields = {
	listenPort: "6000",
	srtlaRemoteHost: "",
	srtlaRemotePort: "5000",
	srtlaMode: "enhanced",
	srtlaQuality: true,
};

interface RelayCardState {
	fields: {
		listenPort: string;
		remoteHost: string;
		remotePort: string;
	};
}

const relayStates = new WeakMap<DeviceCard, RelayCardState>();

function relayState(host: DeviceCard): RelayCardState {
	let state = relayStates.get(host);
	if (!state) {
		state = {
			fields: { listenPort: "", remoteHost: "", remotePort: "" },
		};
		relayStates.set(host, state);
	}
	return state;
}

function prefillString(current: string, value: unknown, field: string): string {
	if (current || value == null || value === "") return current;
	if ((document.activeElement as HTMLInputElement | null)?.name === field)
		return current;
	return String(value);
}

function syncRelayForm(host: DeviceCard, status: RelayStatus): void {
	status.state.relay ??= { running: false };
	const { fields } = relayState(host);
	const combined = status.role === "combined";
	for (const key of ["listenPort", "remoteHost", "remotePort"] as const)
		fields[key] = prefillString(
			fields[key],
			status.state.relay[key] ??
				(combined ? status.state.relayTarget?.[key] : undefined),
			key,
		);
}

const relayDashboardWidgets: DeviceDashboardWidget[] = [
	{
		type: "relay",
		available: (device) => device.role === "relay" || device.role === undefined,
		defaultSize: { w: 4, h: 4 },
		minSize: { w: 3, h: 3 },
		body: ({ card: host, status }) =>
			status ? srtlaComposite(host, status as RelayStatus) : null,
		badge: ({ status }) => (
			<Badge
				text={status ? t("dev.badge.online") : t("dev.badge.offline")}
				kind={status ? "on" : "off"}
			/>
		),
	},
	{
		type: "combined",
		available: (device) =>
			device.role === "combined" || device.role === undefined,
		defaultSize: { w: 6, h: 10 },
		minSize: { w: 4, h: 8 },
		body: ({ card: host, status }) =>
			status ? srtlaComposite(host, status as RelayStatus) : null,
	},
];

const relaySummaryColumns = [
	{
		id: "stream",
		order: 0,
		available: (device: DeviceSummary) =>
			device.role !== "encoder" && device.role !== "combined",
		header: () => t("mgmt.th.stream"),
		cell: (device: DeviceSummary) => {
			if (!device.online) return "—";
			const { relay, activeLinks } = device as RelayDeviceSummary;
			if (!relay?.running)
				return <Badge text={t("dev.badge.stopped")} kind="off" />;
			if (activeLinks === 0)
				return <Badge text={t("dev.badge.no_links")} kind="warn" />;
			return <Badge text={t("dev.badge.live")} kind="on" />;
		},
	},
	{
		id: "links",
		order: 20,
		available: () => true,
		header: () => t("mgmt.th.links"),
		cell: (device: DeviceSummary) => {
			const { activeLinks, totalLinks } = device as RelayDeviceSummary;
			return device.online && totalLinks !== undefined
				? `${activeLinks ?? 0}/${totalLinks}`
				: "—";
		},
	},
	{
		id: "relay",
		order: 40,
		available: (device: DeviceSummary) => device.role !== "encoder",
		header: () => [relayIcon(), ` ${t("setup.step.relay")}`],
		cell: (device: DeviceSummary) => {
			const { relay } = device as RelayDeviceSummary;
			if (!relay) return "—";
			return relay.running ? (
				<Badge text={`→ ${relay.remoteHost}:${relay.remotePort}`} kind="on" />
			) : (
				<Badge text={t("dev.badge.stopped")} kind="warn" />
			);
		},
	},
];

function srtlaStart(host: DeviceCard): void {
	const { fields } = relayState(host);
	if (!fields.listenPort || !fields.remoteHost || !fields.remotePort) return;
	host.press("srtla-start", "relay.start", {
		listenPort: fields.listenPort,
		remoteHost: fields.remoteHost,
		remotePort: fields.remotePort,
	});
}

async function setOption(
	host: DeviceCard,
	key: keyof SrtlaOptions,
	value: string | boolean,
): Promise<void> {
	const result = await host.act<{ options: SrtlaOptions }>(
		`srtla-${key}`,
		"relay.options",
		{ [key]: value },
	);
	// The status push is debounced; do not flash the old value until it arrives
	const status = currentStatus(host);
	if (result && status) status.state.relayOptions = result.options;
}

/** The card's last status push, as the srtla module reads it. */
const currentStatus = (host: DeviceCard): RelayStatus | null =>
	host.st.status as RelayStatus | null;

// Scheduler options: the saved settings, else what the running srtla_send reports, else its defaults
const liveStats = (host: DeviceCard) =>
	currentStatus(host)?.state.relay.running
		? (statsFrame(host)?.value.stats ?? null)
		: null;
const modeValue = (host: DeviceCard): string =>
	currentStatus(host)?.state.relayOptions?.mode ??
	liveStats(host)?.mode ??
	"enhanced";
const qualityValue = (host: DeviceCard): boolean =>
	currentStatus(host)?.state.relayOptions?.quality ??
	liveStats(host)?.quality_enabled ??
	true;

function controlBadge(status: RelayStatus): Child {
	const c = status.srtlaControl;
	if (c?.connected) return <Badge text={t("dev.connected")} kind="on" />;
	if (c?.supported)
		return <Badge text={t("dev.control_connecting")} kind="warn" />;
	return (
		<span class="muted" title={t("dev.control_unavailable_title")}>
			{t("dev.control_unavailable")}
		</span>
	);
}

export function relayCardBody(host: DeviceCard, status: RelayStatus): m.Vnode {
	const { fields } = relayState(host);
	const { busy } = host;
	const s = status.state.relay;
	const combined = status.role === "combined";
	return (
		<Card title={t("dev.card.relay")} class="mod-relay">
			<DefinitionList
				rows={[
					[
						t("dev.row.state"),
						s.running ? (
							<Badge text={t("dev.row_state_running")} kind="on" />
						) : (
							<Badge text={t("dev.badge.stopped")} kind="off" />
						),
					],
					[t("dev.row.started"), s.running ? since(s.startedAt) : null],
					[
						t("dev.reloads"),
						t("dev.reloads_detail", {
							reloads: s.reloadCount ?? 0,
							last: since(s.lastReloadAt),
							mode: status.monitor.reloadMode,
						}),
					],
					[
						t("dev.monitor"),
						status.monitor.running ? (
							<Badge text={t("dev.monitor_watching")} kind="on" />
						) : (
							<Badge text={t("ui.off")} kind="warn" />
						),
					],
					[t("dev.control"), s.running ? controlBadge(status) : null],
				]}
			/>
			<Form
				onSubmit={
					combined ? () => startCombinedStream(host) : () => srtlaStart(host)
				}
			>
				<FieldGroup legend={t("dev.group.connection")}>
					{!combined && (
						<>
							<Field
								label={t("dev.field.srt_listen_port")}
								control={
									<Input
										target={fields}
										prop="listenPort"
										placeholder="6000"
										required={true}
									/>
								}
							/>
							<span> ⇨ </span>
						</>
					)}
					<Field
						label={t("dev.field.remote_host")}
						control={
							<Input
								target={fields}
								prop="remoteHost"
								placeholder="rec.example.com"
								required={true}
							/>
						}
					/>
					<Field
						label={t("dev.field.remote_port")}
						control={
							<Input
								target={fields}
								prop="remotePort"
								placeholder="5000"
								required={true}
							/>
						}
					/>
				</FieldGroup>
				<FieldGroup legend={t("dev.quality_scoring")}>
					<Field
						label={t("dev.scheduler")}
						control={
							<select
								disabled={busy.has("srtla-mode")}
								value={modeValue(host)}
								onchange={(e: Event) =>
									void setOption(
										host,
										"mode",
										(e.target as HTMLSelectElement).value,
									)
								}
							>
								<Options
									pairs={[
										["enhanced", t("dev.scheduler_enhanced")],
										["classic", t("dev.scheduler_classic")],
									]}
								/>
							</select>
						}
					/>
					<CheckField
						label={t("dev.quality_scoring")}
						title={t("dev.quality_scoring_title")}
						control={
							<input
								type="checkbox"
								checked={qualityValue(host)}
								disabled={
									busy.has("srtla-quality") || modeValue(host) === "classic"
								}
								onchange={(e: Event) =>
									void setOption(
										host,
										"quality",
										(e.target as HTMLInputElement).checked,
									)
								}
							/>
						}
					/>
				</FieldGroup>
				<Break />
				{combined ? (
					combinedStreamButtons(host, "stream.stop")
				) : (
					<Actions>
						<Button
							label={t("ui.start")}
							type="submit"
							disabled={s.running || host.pending("srtla-start")}
						/>
						<Button
							label={t("ui.stop")}
							class="danger"
							disabled={!s.running || host.pending("srtla-stop")}
							onclick={() => host.press("srtla-stop", "relay.stop")}
						/>
						<Button
							label={t("ui.reload")}
							disabled={!s.running || host.pending("srtla-reload")}
							onclick={() => host.press("srtla-reload", "relay.reload")}
						/>
					</Actions>
				)}
			</Form>
		</Card>
	);
}

// -------------------------------------------------------------- interfaces card

/* Interfaces: bond selection per interface, with the live srtla_send link
 * stats matched to interfaces by source IP (the `no-stats` class shows muted
 * placeholders until the first `relay.stats` push). */
const STATS_STALE_MS = 5_000;
const LINK_COLUMNS = 7;

/** Signal-quality meter with its percentage. */
function signal(quality?: number): Child {
	if (quality === undefined) return "—";
	return (
		<span>
			<meter
				min={0}
				max={100}
				low={30}
				high={60}
				optimum={100}
				value={quality}
			/>
			{` ${quality}%`}
		</span>
	);
}

function linkState(l: SrtlaLinkStats): m.Vnode {
	if (l.timed_out) return <Badge text={t("dev.link_timed_out")} kind="off" />;
	if (!l.connected)
		return <Badge text={t("dev.control_connecting")} kind="warn" />;
	if (l.stall_gated) return <Badge text={t("dev.link_stalled")} kind="warn" />;
	if (l.weak)
		return (
			<span title={l.weak_reason ?? ""}>
				<Badge text={t("dev.link_weak")} kind="warn" />
			</span>
		);
	return (
		<Badge
			text={l.sole_carrier ? t("dev.link_sole") : t("dev.link_up")}
			kind="on"
		/>
	);
}

function linkCells(l: SrtlaLinkStats | undefined, total: number): m.Vnode[] {
	const cell = (child: Child, cls = "", title?: string): m.Vnode => (
		<td class={`link-col ${cls}`.trim()} title={title}>
			{child}
		</td>
	);
	if (!l) return Array.from({ length: LINK_COLUMNS }, () => cell("—", "muted"));
	const share = total ? l.bitrate_bytes_per_sec / total : 0;
	return [
		cell(linkState(l), "", l.label ?? ""),
		cell(
			<span>
				<meter
					class="share"
					min={0}
					max={1}
					value={share}
					title={t("dev.link_share_title", {
						percentage: Math.round(share * 100),
						rtt: Math.round(l.rtt_min_ms),
					})}
				/>
				{formatBitrate(l.bitrate_bytes_per_sec)}
			</span>,
			"num",
		),
		cell(
			l.connected ? `${Math.round(l.rtt_ms)} ms` : "—",
			"num is-rtt",
			t("dev.link_min_rtt", { rtt: Math.round(l.rtt_min_ms) }),
		),
		cell(`${l.in_flight} / ${l.window}`, "num is-inflight"),
		cell(l.nak_count, "num is-naks"),
		cell(`${((l.cc_loss_permille ?? 0) / 10).toFixed(1)}%`, "num is-loss"),
		cell(
			l.quality_multiplier !== undefined
				? `×${l.quality_multiplier.toFixed(2)}`
				: "—",
			"num is-quality",
			l.base_score !== undefined
				? t("dev.link_score", { score: l.base_score })
				: "",
		),
	];
}

function linkHeader(): m.Vnode {
	const th = (text: string, title?: string, cls?: string) => (
		<th class={`link-col ${cls ?? ""}`.trim()} title={title}>
			{text}
		</th>
	);
	return (
		<thead>
			<tr>
				<th>{t("dev.th.bond")}</th>
				<th class="is-iface">{t("dev.th.interface")}</th>
				<th class="is-signal">{t("dev.signal")}</th>
				<th class="is-network">{t("dev.th.network")}</th>
				{th(t("dev.th.link"))}
				{th(t("mgmt.th_bitrate"))}
				{th("RTT", undefined, "is-rtt")}
				{th(t("dev.th.in_flight"), t("dev.th.in_flight_title"), "is-inflight")}
				{th(t("dev.th.naks"), undefined, "is-naks")}
				{th(t("dev.th.loss"), undefined, "is-loss")}
				{th(t("dev.th.quality"), undefined, "is-quality")}
			</tr>
		</thead>
	);
}

function interfacesCard(host: DeviceCard, status: RelayStatus): m.Vnode {
	const selected = new Set(status.selected.map((i) => i.iface));
	const frame = statsFrame(host);
	const live = frame?.value.stats ?? null;
	const stale = !!live && !!frame?.at && Date.now() - frame.at > STATS_STALE_MS;
	const links = new Map((live?.links ?? []).map((l) => [l.ip, l]));
	const total =
		live?.links.reduce((sum, l) => sum + (l.bitrate_bytes_per_sec || 0), 0) ??
		0;
	const defaultRouteRow = defaultRouteRowIndex(
		status.interfaces,
		status.defaultRouteInterface,
		status.defaultRouteSourceIp,
	);

	const rows = status.interfaces.map((i, index) => {
		const isDefaultRoute = index === defaultRouteRow;
		const sub = [
			i.cidr,
			i.modemIndex !== undefined
				? t("dev.iface_modem", { index: i.modemIndex })
				: null,
		]
			.filter(Boolean)
			.join(" · ");
		const network = [i.operatorName, i.accessTech].filter(Boolean).join(" · ");
		const busyKey = `iface:${i.iface}`;
		return (
			<tr
				key={`${i.iface}:${i.ip}`}
				class={[
					selected.has(i.iface) ? "selected" : "",
					isDefaultRoute ? "default-route" : "",
				]
					.filter(Boolean)
					.join(" ")}
			>
				<td>
					<input
						type="checkbox"
						checked={selected.has(i.iface)}
						disabled={host.busy.has(busyKey)}
						title={t("dev.include_in_bond")}
						onchange={() =>
							void host.act(busyKey, "modems.toggle", {
								iface: i.iface,
							})
						}
					/>
				</td>
				<td class="is-iface">
					{i.iface}
					{isDefaultRoute ? (
						<span class="default-route-label">{t("dev.default_route")}</span>
					) : null}
					{i.speed ? (
						<small class="muted">{` · ${formatSpeed(i.speed)}`}</small>
					) : null}
					{sub ? <span class="iface-sub muted">{sub}</span> : null}
				</td>
				<td class="is-signal">{signal(i.signalQuality)}</td>
				<td class="is-network">{network || "—"}</td>
				{linkCells(links.get(i.ip), total)}
			</tr>
		);
	});

	return (
		<Card
			title={t("dev.card.interfaces")}
			headActions={[
				stale && (
					<Badge
						text={t("dev.stale", {
							time: since(frame?.at ?? 0),
						})}
						kind="warn"
					/>
				),
				<IconButton
					label={t("ui.reconfigure")}
					icon={<Icon name="sync" class="role-icon" />}
					disabled={host.busy.has("reconfigure")}
					onclick={() => void host.act("reconfigure", "reconfigure")}
				/>,
			]}
		>
			<table class={live ? "" : "no-stats"}>
				{linkHeader()}
				{rows.length ? (
					rows
				) : (
					<tr>
						<td colspan={4 + LINK_COLUMNS} class="muted">
							{t("dev.no_interfaces")}
						</td>
					</tr>
				)}
			</table>
		</Card>
	);
}

// ----------------------------------------------------------------- modem panels

async function modemAction(
	host: DeviceCard,
	method: string,
	index: number,
): Promise<void> {
	if (
		method === "modems.reset" &&
		!(await confirmDialog(t("dev.reset_confirm", { index }), { danger: true }))
	)
		return;
	void host.act(`modem:${method}:${index}`, method, { index });
}

const stateKind = (state: string) =>
	state === "connected"
		? "on"
		: state === "disabled" || state === "failed"
			? "off"
			: "warn";

function modemPanel(host: DeviceCard, modem: ModemInfo): m.Vnode {
	const control = (label: string, method: string, cls = "secondary") => (
		<Button
			label={label}
			class={cls}
			disabled={
				host.busy.has(`modem:${method}:${modem.index}`) ||
				!!currentStatus(host)?.state.relay.running
			}
			onclick={() => void modemAction(host, method, modem.index)}
		/>
	);
	const connected = modem.state === "connected";
	const name =
		[modem.manufacturer, modem.model].filter(Boolean).join(" ") ||
		t("dev.modem_fallback");
	return (
		<article class="modem" key={modem.index}>
			<h3>
				<span>{`#${modem.index} ${name}`}</span>
				<Badge text={modem.state} kind={stateKind(modem.state)} />
			</h3>
			<DefinitionList
				rows={[
					[t("dev.signal"), signal(modem.signalQuality)],
					[t("dev.operator"), modem.operatorName],
					[t("dev.tech"), modem.accessTech],
					[t("dev.registration"), modem.registrationState],
					[t("dev.power"), modem.powerState],
					[t("dev.imei"), modem.imei],
				]}
			/>
			<Actions>
				{control(t("ui.enable"), "modems.enable")}
				{control(t("ui.disable"), "modems.disable")}
				{connected
					? control(t("ui.disconnect"), "modems.disconnect")
					: control(t("ui.connect"), "modems.connect")}
				{control(t("ui.reset"), "modems.reset", "danger")}
			</Actions>
		</article>
	);
}

function modemsCard(host: DeviceCard, status: RelayStatus): m.Vnode {
	return (
		<Card title={t("dev.card.modems")} class="mod-relay-modems">
			{status.modems.length ? (
				<div class="grid">
					{status.modems.map((modem) => modemPanel(host, modem))}
				</div>
			) : (
				<p class="muted">{t("dev.no_modems")}</p>
			)}
		</Card>
	);
}

/** The relay device's full card set (device page and dashboard widgets): the
 * SRTLA state card, the interfaces table with the live link stats, and the
 * modem panels. */
export function srtlaComposite(host: DeviceCard, status: RelayStatus): m.Vnode {
	return (
		<>
			{relayCardBody(host, status)}
			{interfacesCard(host, status)}
			{modemsCard(host, status)}
		</>
	);
}

const relayModule: FrontendModule = {
	id: "relay",
	kind: "device-card",
	title: "Relay",
	roleIcons: { relay: relayIcon },
	order: 20,
	log,
	available: (status) => status.role === "relay" || status.role === "combined",
	dashboardWidgets: relayDashboardWidgets,
	deviceSummaryColumns: relaySummaryColumns,
	setupSteps: [
		{
			id: "relay",
			title: "setup.step.relay",
			subtitle: "setup.step.relay_sub",
			roles: ["relay", "combined"],
			isValid() {
				const { listenPort, srtlaRemoteHost, srtlaRemotePort } = setupFields;
				return (
					inRange(listenPort, 1, 65535) &&
					!!srtlaRemoteHost &&
					inRange(srtlaRemotePort, 1, 65535)
				);
			},
			render(_role, _info: SetupInfo) {
				return (
					<>
						<Field
							label={t("dev.field.srt_listen_port")}
							control={
								<Input
									target={setupFields}
									prop="listenPort"
									{...numberAttrs(1, 65535)}
									required={true}
								/>
							}
						/>
						<Field
							label={t("dev.field.remote_host")}
							control={
								<Input
									target={setupFields}
									prop="srtlaRemoteHost"
									placeholder="rec.example.com"
									required={_role !== "encoder"}
								/>
							}
						/>
						<Field
							label={t("dev.field.remote_port")}
							control={
								<Input
									target={setupFields}
									prop="srtlaRemotePort"
									{...numberAttrs(1, 65535)}
									required={_role !== "encoder"}
								/>
							}
						/>
						<Field
							label={t("dev.scheduler")}
							control={
								<Select target={setupFields} prop="srtlaMode">
									<Options
										pairs={[
											["enhanced", t("dev.scheduler_enhanced")],
											["classic", t("dev.scheduler_classic")],
										]}
									/>
								</Select>
							}
						/>
						<CheckField
							label={t("dev.quality_scoring")}
							control={<Checkbox target={setupFields} prop="srtlaQuality" />}
						/>
					</>
				);
			},
			config() {
				return {
					listenPort: Number(setupFields.listenPort),
					srtlaRemoteHost: setupFields.srtlaRemoteHost,
					srtlaRemotePort: Number(setupFields.srtlaRemotePort),
					srtlaMode: setupFields.srtlaMode,
					srtlaQuality: setupFields.srtlaQuality,
				};
			},
		},
	],
	defaultSize: { w: 4, h: 4 },
	minSize: { w: 3, h: 3 },
	component: (status) => srtlaComposite(card, status as RelayStatus),
	handleEvent(event, _data, host) {
		const status = host ? currentStatus(host) : null;
		if (event === "status" && host && status) syncRelayForm(host, status);
	},
};

export default relayModule;
