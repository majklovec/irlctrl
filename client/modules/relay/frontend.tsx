/* SRTLA card: srtla_send state, the receiver form and the scheduler options.
 * The device page composes it with the network module's interfaces card and
 * the modems module's modem panels. */
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
	Input,
	numberAttrs,
	Options,
	Select,
} from "@ui/components/";
import { OutlineIcon } from "@ui/components/icons";
import { card, type DeviceCard } from "@ui/device/store";
import { t } from "@ui/i18n";
import { inRange, since } from "@ui/util";
import m from "mithril";
import type {
	DeviceDashboardWidget,
	FrontendModule,
} from "../../../shared/contracts/frontend_module";
import type { DeviceSummary, SetupInfo } from "../../../shared/contracts/wire";
import { attemptedSteps } from "../../../shared/setup_progress";
import log from "./log";
import type {
	RelayDeviceSummary,
	RelayStatus,
	SrtlaOptions,
	SrtlaStats,
	SrtlaStatsEvent,
} from "./types";

/** The role pictogram (the summary column header and the role tag share it). */
const relayIcon = () => (
	<OutlineIcon class="role-icon role-icon-relay">
		<circle cx="12" cy="9" r="2" />
		<path d="M12 11v11M9 22h6" />
		<path d="M8.5 5.5a5 5 0 0 0 0 7M15.5 5.5a5 5 0 0 1 0 7" />
		<path d="M5.6 2.6a9 9 0 0 0 0 12.8M18.4 2.6a9 9 0 0 1 0 12.8" />
	</OutlineIcon>
);

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
	srtlaRemotePort: "6000",
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
	for (const key of ["listenPort", "remoteHost", "remotePort"] as const)
		fields[key] = prefillString(fields[key], status.state.relay[key], key);
}

const relayDashboardWidgets: DeviceDashboardWidget[] = [
	{
		type: "relay",
		available: (device) => device.role === "relay" || device.role === undefined,
		defaultSize: { w: 4, h: 4 },
		minSize: { w: 3, h: 3 },
		body: ({ card: host, status }) =>
			status ? relayCardBody(host, status as RelayStatus) : null,
		badge: ({ status }) => (
			<Badge
				text={status ? t("dev.badge.online") : t("dev.badge.offline")}
				kind={status ? "on" : "off"}
			/>
		),
	},
];

const relaySummaryColumns = [
	{
		id: "stream",
		order: 0,
		available: (device: DeviceSummary) => device.role === "relay",
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
		available: (device: DeviceSummary) => device.role === "relay",
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
					[t("mlog.done.started"), s.running ? since(s.startedAt) : null],
					[
						t("dev.reloads"),
						t("dev.reloads_detail", {
							reloads: s.reloadCount ?? 0,
							last: since(s.lastReloadAt),
							mode: status.state.srtlaMonitor?.reloadMode ?? "signal",
						}),
					],
					[t("dev.control"), s.running ? controlBadge(status) : null],
				]}
			/>
			<Form onSubmit={() => srtlaStart(host)}>
				<FieldGroup legend={t("dev.group.connection")}>
					<Field
						label={t("dev.field.srtla_listen_port")}
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
								placeholder="6000"
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
			</Form>
		</Card>
	);
}

const relayModule: FrontendModule = {
	id: "relay",
	kind: "device-card",
	title: "Relay",
	roleIcons: { relay: relayIcon },
	order: 5,
	log,
	available: (status) => status.role === "relay",
	dashboardWidgets: relayDashboardWidgets,
	deviceSummaryColumns: relaySummaryColumns,
	setupSteps: [
		{
			id: "relay",
			title: "setup.step.relay",
			subtitle: "setup.step.relay_sub",
			roles: ["relay"],
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
							label={t("dev.field.srtla_listen_port")}
							required={true}
							invalid={
								attemptedSteps.has("relay") &&
								!inRange(setupFields.listenPort, 1, 65535)
							}
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
							required={true}
							invalid={
								attemptedSteps.has("relay") && !setupFields.srtlaRemoteHost
							}
							control={
								<Input
									target={setupFields}
									prop="srtlaRemoteHost"
									placeholder="rec.example.com"
									required={true}
								/>
							}
						/>
						<Field
							label={t("dev.field.remote_port")}
							required={true}
							invalid={
								attemptedSteps.has("relay") &&
								!inRange(setupFields.srtlaRemotePort, 1, 65535)
							}
							control={
								<Input
									target={setupFields}
									prop="srtlaRemotePort"
									{...numberAttrs(1, 65535)}
									required={true}
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
	component: (status) => relayCardBody(card, status as RelayStatus),
	handleEvent(event, _data, host) {
		const status = host ? currentStatus(host) : null;
		if (event === "status" && host && status) syncRelayForm(host, status);
	},
};

export default relayModule;
