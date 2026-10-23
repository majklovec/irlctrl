/* SRTLA card: srtla_send state, the receiver form and the scheduler options.
 * The SRTLA module is the relay device's single card: it composes the interfaces
 * table (with the live SRTLA link stats) and the modem panels (merged in from
 * the modems module), so the device page and the dashboard widgets show the
 * same content. */
import "./styles.css";
import m from "mithril";
import { icon } from "../../frontend/ts/components/icons";
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
	Input,
	numberAttrs,
	Options,
	Select,
} from "../../frontend/ts/components/ui";
import { card, type DeviceCard } from "../../frontend/ts/device/store";
import { t } from "../../frontend/ts/i18n";
import type { DeviceDashboardWidget } from "../../frontend/ts/module-contracts";
import {
	formatBitrate,
	formatSpeed,
	inRange,
	since,
} from "../../frontend/ts/util";
import type {
	DeviceSummary,
	ModemInfo,
	SetupInfo,
	SrtlaLinkStats,
	SrtlaStats,
	SrtlaStatsEvent,
	Status,
} from "../../shared/types";
import type { BridgedModule } from "./types";

type SrtlaOptions = Status["state"]["srtlaOptions"];
type EncoderStart = (
	host: DeviceCard,
	target: { remoteHost: string; remotePort: string },
) => void;
type EncoderStreamButtons = (
	host: DeviceCard,
	stopMethod: string,
) => m.Children;

function startCombinedStream(host: DeviceCard): void {
	const start = host.getCapability<EncoderStart>("encoder.start");
	if (!start)
		throw new Error("Encoder module did not provide its start capability");
	start(host, srtlaState(host).fields);
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
	const entry = host.st.events.get("srtla.stats");
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

interface SrtlaCardState {
	fields: {
		listenPort: string;
		remoteHost: string;
		remotePort: string;
	};
}

const srtlaStates = new WeakMap<DeviceCard, SrtlaCardState>();

function srtlaState(host: DeviceCard): SrtlaCardState {
	let state = srtlaStates.get(host);
	if (!state) {
		state = {
			fields: { listenPort: "", remoteHost: "", remotePort: "" },
		};
		srtlaStates.set(host, state);
	}
	return state;
}

function prefillString(current: string, value: unknown, field: string): string {
	if (current || value == null || value === "") return current;
	if ((document.activeElement as HTMLInputElement | null)?.name === field)
		return current;
	return String(value);
}

function syncSrtlaForm(host: DeviceCard, status: Status): void {
	status.state.srtla ??= { running: false };
	const { fields } = srtlaState(host);
	const combined = status.role === "combined";
	for (const key of ["listenPort", "remoteHost", "remotePort"] as const)
		fields[key] = prefillString(
			fields[key],
			status.state.srtla[key] ??
				(combined ? status.state.srtlaTarget?.[key] : undefined),
			key,
		);
}

const srtlaDashboardWidgets: DeviceDashboardWidget[] = [
	{
		type: "relay",
		available: (device) =>
			device.role === "relay" ||
			device.role === "custom" ||
			device.role === undefined,
		defaultSize: { w: 4, h: 4 },
		minSize: { w: 3, h: 3 },
		body: ({ card: host, status }) =>
			status ? srtlaComposite(host, status) : null,
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
			device.role === "combined" ||
			device.role === "custom" ||
			device.role === undefined,
		defaultSize: { w: 6, h: 10 },
		minSize: { w: 4, h: 8 },
		body: ({ card: host, status }) =>
			status ? srtlaComposite(host, status) : null,
	},
];

const srtlaSummaryColumns = [
	{
		id: "stream",
		order: 0,
		available: (device: DeviceSummary) =>
			device.role !== "encoder" && device.role !== "combined",
		header: () => t("mgmt.th.stream"),
		cell: (device: DeviceSummary) => {
			if (!device.online) return "—";
			if (!device.srtla?.running)
				return <Badge text={t("dev.badge.stopped")} kind="off" />;
			if (device.activeLinks === 0)
				return <Badge text={t("dev.badge.no_links")} kind="warn" />;
			return <Badge text={t("dev.badge.live")} kind="on" />;
		},
	},
	{
		id: "links",
		order: 20,
		available: () => true,
		header: () => t("mgmt.th.links"),
		cell: (device: DeviceSummary) =>
			device.online && device.totalLinks !== undefined
				? `${device.activeLinks ?? 0}/${device.totalLinks}`
				: "—",
	},
	{
		id: "relay",
		order: 40,
		available: (device: DeviceSummary) => device.role !== "encoder",
		header: () => [icon("relay"), ` ${t("setup.step.relay")}`],
		cell: (device: DeviceSummary) => {
			const srtla = device.srtla;
			if (!srtla) return "—";
			return srtla.running ? (
				<Badge text={`→ ${srtla.remoteHost}:${srtla.remotePort}`} kind="on" />
			) : (
				<Badge text={t("dev.badge.stopped")} kind="warn" />
			);
		},
	},
];

function srtlaStart(host: DeviceCard): void {
	const { fields } = srtlaState(host);
	if (!fields.listenPort || !fields.remoteHost || !fields.remotePort) return;
	host.press("srtla-start", "srtla.start", {
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
		"srtla.options",
		{ [key]: value },
	);
	// The status push is debounced; do not flash the old value until it arrives
	if (result && host.st.status)
		host.st.status.state.srtlaOptions = result.options;
}

// Scheduler options: the saved settings, else what the running srtla_send reports, else its defaults
const liveStats = (host: DeviceCard) =>
	host.st.status?.state.srtla.running
		? (statsFrame(host)?.value.stats ?? null)
		: null;
const modeValue = (host: DeviceCard): string =>
	host.st.status?.state.srtlaOptions?.mode ??
	liveStats(host)?.mode ??
	"enhanced";
const qualityValue = (host: DeviceCard): boolean =>
	host.st.status?.state.srtlaOptions?.quality ??
	liveStats(host)?.quality_enabled ??
	true;

function controlBadge(status: Status): Child {
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

export function srtlaCardBody(host: DeviceCard, status: Status): m.Vnode {
	const { fields } = srtlaState(host);
	const { busy } = host;
	const s = status.state.srtla;
	const combined = status.role === "combined";
	return (
		<Card title={t("dev.card.srtla")} class="mod-srtla">
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
							onclick={() => host.press("srtla-stop", "srtla.stop")}
						/>
						<Button
							label={t("ui.reload")}
							disabled={!s.running || host.pending("srtla-reload")}
							onclick={() => host.press("srtla-reload", "srtla.reload")}
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
 * placeholders until the first `srtla.stats` push). */
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

function interfacesCard(host: DeviceCard, status: Status): m.Vnode {
	const selected = new Set(status.selected.map((i) => i.iface));
	const frame = statsFrame(host);
	const live = frame?.value.stats ?? null;
	const stale = !!live && !!frame?.at && Date.now() - frame.at > STATS_STALE_MS;
	const links = new Map((live?.links ?? []).map((l) => [l.ip, l]));
	const total =
		live?.links.reduce((sum, l) => sum + (l.bitrate_bytes_per_sec || 0), 0) ??
		0;

	const rows = status.interfaces.map((i) => {
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
			<tr key={i.iface} class={selected.has(i.iface) ? "selected" : ""}>
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
				<Button
					label={t("ui.reconfigure")}
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

function modemAction(host: DeviceCard, method: string, index: number): void {
	if (method === "modems.reset" && !confirm(t("dev.reset_confirm", { index })))
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
				!!host.st.status?.state.srtla.running
			}
			onclick={() => modemAction(host, method, modem.index)}
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

function modemsCard(host: DeviceCard, status: Status): m.Vnode {
	return (
		<Card title={t("dev.card.modems")} class="mod-modems">
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
export function srtlaComposite(host: DeviceCard, status: Status): m.Vnode {
	return (
		<>
			{srtlaCardBody(host, status)}
			{interfacesCard(host, status)}
			{modemsCard(host, status)}
		</>
	);
}

const srtlaModule: BridgedModule = {
	id: "srtla",
	kind: "device-card",
	title: "SRTLA",
	order: 20,
	available: (status) => status.role !== "encoder" && status.role !== "obs",
	dashboardWidgets: srtlaDashboardWidgets,
	deviceSummaryColumns: srtlaSummaryColumns,
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
	component: (status: Status) => srtlaComposite(card, status),
	handleEvent(event, _data, host) {
		if (event === "status" && host?.st.status)
			syncSrtlaForm(host, host.st.status);
	},
};

export default srtlaModule;
