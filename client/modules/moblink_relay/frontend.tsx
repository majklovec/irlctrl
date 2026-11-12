/**
 * MobLink LAN relay device card: per-interface relay rows and the
 * start / stop / refresh controls (spec 100-moblink §5.4). The relays
 * transparently bridge the shared interfaces' L3 traffic to the encoder;
 * there is no destination to configure (SRTLA lives on the encoder). The
 * device page composes it with the network module's interfaces card.
 */
import "./styles.css";
import {
	Actions,
	Badge,
	Button,
	Card,
	Field,
	Form,
	Input,
	Table,
} from "@ui/components/";
import { OutlineIcon } from "@ui/components/icons";
import { card, type DeviceCard } from "@ui/device/store";
import { t } from "@ui/i18n";
import m from "mithril";
import type {
	DeviceDashboardWidget,
	FrontendModule,
} from "../../../shared/contracts/frontend_module";
import log from "./log";
import type { MoblinkRuntimeStatus } from "./types";

/** The module's status fragment as pushed on the live card host. */
const moblinkRuntime = (host: DeviceCard): MoblinkRuntimeStatus =>
	(host.st.status?.state as { moblink?: MoblinkRuntimeStatus } | undefined)
		?.moblink ?? {
		connected: false,
		announceHost: "",
		availableInterfaces: [],
		relays: [],
		failures: [],
		downInterfaces: [],
	};

/** The role pictogram (bridging a hub to the shared interfaces). */
const moblinkRelayIcon = () => (
	<OutlineIcon class="role-icon role-icon-moblink-relay">
		<circle cx="12" cy="12" r="2.5" />
		<circle cx="4.5" cy="5" r="2" />
		<circle cx="19.5" cy="5" r="2" />
		<circle cx="4.5" cy="19" r="2" />
		<circle cx="19.5" cy="19" r="2" />
		<path d="m9.9 10.1-3.4-3.2M14.1 10.1l3.4-3.2M9.9 13.9l-3.4 3.2M14.1 13.9l3.4 3.2" />
	</OutlineIcon>
);

/**
 * The uplink mark (protocol.md §1: every relayed interface is an uplink,
 * marked in the UI). Colored by state — up = available path, down = path
 * lost (the port mapping is kept).
 */
const uplinkIcon = (state: "up" | "down") => (
	<OutlineIcon
		class={`uplink-mark${state === "down" ? " uplink-mark-down" : ""}`}
	>
		<path d="M12 19V5M6 11l6-6 6 6" />
		<path d="M5 21h14" />
	</OutlineIcon>
);

interface RelayCardState {
	announceHost: string;
}

const relayStates = new WeakMap<DeviceCard, RelayCardState>();
const relayState = (host: DeviceCard): RelayCardState => {
	let state = relayStates.get(host);
	if (!state) {
		state = { announceHost: "" };
		relayStates.set(host, state);
	}
	return state;
};

/**
 * Prefill only once, and never clobber the operator's focused field. The
 * "advertise IP" is always prefilled with the relay's effective IP (auto or
 * manual) so the operator sees what will be announced and can override it.
 */
function prefill(host: DeviceCard, status: MoblinkRuntimeStatus): void {
	const s = relayState(host);
	if (
		status.announceHost &&
		(document.activeElement as HTMLInputElement | null)?.name !==
			"moblink-announce-host"
	)
		s.announceHost = status.announceHost;
}

function moblinkStart(host: DeviceCard): void {
	const s = relayState(host);
	host.press("moblink-start", "moblink_relay.start", {
		announceHost: s.announceHost.trim(),
	});
}

const moblinkDashboardWidgets: DeviceDashboardWidget[] = [
	{
		type: "moblink_relay",
		available: (device) => device.role === "moblink_relay",
		defaultSize: { w: 4, h: 4 },
		minSize: { w: 3, h: 3 },
		body: ({ card: host, status }) => (status ? moblinkCardBody(host) : null),
		badge: ({ status }) => (
			<Badge
				text={status ? t("dev.badge.online") : t("dev.badge.offline")}
				kind={status ? "on" : "off"}
			/>
		),
	},
];

const moblinkRelayModule: FrontendModule = {
	id: "moblink_relay",
	kind: "device-card",
	title: "Relay",
	roleIcons: { moblink_relay: moblinkRelayIcon },
	order: 51,
	log,
	available: (status) => status.role === "moblink_relay",
	dashboardWidgets: moblinkDashboardWidgets,
	defaultSize: { w: 4, h: 4 },
	minSize: { w: 3, h: 3 },
	component: () => <Card>{moblinkCardBody(card)}</Card>,
	handleEvent(event, _data, host) {
		if (event === "status" && host && host.st.status)
			prefill(host, moblinkRuntime(host));
	},
};

function moblinkCardBody(host: DeviceCard): m.Children {
	const s = moblinkRuntime(host);
	const form = relayState(host);
	// One row per shared interface: name, its IP, UDP port, and the
	// uplink mark (protocol.md §1), colored by up/down state.
	const columns = [
		{ key: "iface", header: t("dev.moblink.col_iface") },
		{ key: "ip", header: t("dev.moblink.col_ip") },
		{ key: "port", header: t("dev.moblink.col_port") },
		{ key: "uplink", header: t("dev.moblink.uplink") },
	];
	return (
		<div class="moblink-relay">
			<p class="status" data-state={s.connected ? "online" : "offline"}>
				{s.connected
					? t("dev.moblink.status_running", {
							up: s.availableInterfaces.filter((i) => i.state === "up").length,
							down: s.availableInterfaces.filter((i) => i.state === "down")
								.length,
						})
					: t("dev.moblink.status_idle")}
			</p>
			<Table columns={columns} actions={false}>
				{s.availableInterfaces.map((i) => (
					<tr key={i.name}>
						<td>{i.name}</td>
						<td>{i.address || "—"}</td>
						<td>{i.listenPort}</td>
						<td>{uplinkIcon(i.state)}</td>
					</tr>
				))}
			</Table>
			{s.availableInterfaces.length === 0 ? (
				<p class="muted">{t("dev.moblink.no_interfaces")}</p>
			) : null}
			{s.failures.map((f) => (
				<p class="status" key={`fail:${f.interfaceName}`} data-state="error">
					{t("dev.moblink.iface_failed", {
						iface: f.interfaceName,
						reason: f.reason,
					})}
				</p>
			))}
			<p class="muted">{t("dev.moblink.help_hosts")}</p>
			<Form onSubmit={() => moblinkStart(host)}>
				<Field
					label={t("dev.moblink.announce_host")}
					control={
						<Input
							target={form}
							prop="announceHost"
							name="moblink-announce-host"
							placeholder={form.announceHost || "auto (detected)"}
						/>
					}
				/>
				<Actions>
					<Button
						type="submit"
						label={t("ui.start")}
						disabled={s.connected || host.pending("moblink-start")}
					/>
					<Button
						label={t("ui.stop")}
						type="button"
						disabled={!s.connected || host.pending("moblink-stop")}
						onclick={() => host.press("moblink-stop", "moblink_relay.stop")}
					/>
					<Button
						label={t("ui.reload")}
						type="button"
						disabled={host.pending("moblink-refresh")}
						onclick={() =>
							void host.act("moblink-refresh", "moblink_relay.status")
						}
					/>
				</Actions>
			</Form>
		</div>
	);
}

export default moblinkRelayModule;
