/**
 * MobLink LAN relay device card: per-interface relay rows and the
 * start / stop / refresh controls (spec 100-moblink §5.4). The relays
 * transparently bridge the shared interfaces' L3 traffic to the encoder;
 * there is no destination to configure (SRTLA lives on the encoder). The
 * device page composes it with the network module's interfaces card.
 */
import "./styles.css";
import { Actions, Badge, Button, Card, Form, Table } from "@ui/components/";
import { OutlineIcon } from "@ui/components/icons";
import { card, type DeviceCard } from "@ui/device/store";
import { t } from "@ui/i18n";
import { formatBitrate, since } from "@ui/util";
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
		encoders: [],
	};

/** i18n key per discovery method (the value carries a hyphen, so map it). */
const DISCOVERY_METHOD_KEYS = {
	udp: "dev.moblink.method_udp",
	mdns: "dev.moblink.method_mdns",
	"control-server": "dev.moblink.method_control_server",
} as const;

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

function moblinkStart(host: DeviceCard): void {
	// The advertised IP is auto-detected by the relay (effectiveAnnounceHost);
	// the card only shows it, so no override is sent on start.
	host.press("moblink-start", "moblink_relay.start");
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
};

function moblinkCardBody(host: DeviceCard): m.Children {
	const s = moblinkRuntime(host);
	// One row per shared interface: name, its IP, UDP port, its negotiated
	// link speed (same as the encoder's interfaces card), and the uplink mark
	// (protocol.md §1), colored by up/down state.
	const columns = [
		{ key: "iface", header: t("dev.moblink.col_iface") },
		{ key: "ip", header: t("dev.moblink.col_ip") },
		{ key: "port", header: t("dev.moblink.col_port") },
		{
			key: "speed",
			header: t("dev.moblink.col_speed"),
			title: t("dev.moblink.speed_note"),
		},
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
						<td className="num">
							{i.rxBytesPerSec !== undefined ||
							i.txBytesPerSec !== undefined ? (
								<span
									title={`↑ ${formatBitrate(
										i.txBytesPerSec ?? 0,
									)} · ↓ ${formatBitrate(
										i.rxBytesPerSec ?? 0,
									)}`}
								>
									{formatBitrate(
										(i.rxBytesPerSec ?? 0) +
											(i.txBytesPerSec ?? 0),
									)}
								</span>
							) : (
								"—"
							)}
						</td>
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
			{/* The advertised IP is auto-detected by the relay — show it,
			 * don't let the operator type into it (settings page still
			 * overrides it for NATted / multi-homed relays). */}
			<p class="announce-host">
				<span class="muted">{t("dev.moblink.announce_host")}</span>{" "}
				<strong>{s.announceHost || "—"}</strong>
			</p>
			{/* How recently we announced ourselves on each path (mDNS / UDP /
			 * WS control channel). A live path keeps a fresh timestamp. */}
			<p class="muted announce-times">
				{t("dev.moblink.last_self_announce")}:{" "}
				<span title={t("dev.moblink.last_mdns")}>
					{t("dev.moblink.last_mdns")} {since(s.lastMdnsAnnounceAt)}
				</span>
				{" · "}
				<span title={t("dev.moblink.last_udp")}>
					{t("dev.moblink.last_udp")} {since(s.lastUdpAnnounceAt)}
				</span>
				{" · "}
				<span title={t("dev.moblink.last_ws")}>
					{t("dev.moblink.last_ws")} {since(s.lastWsAdvertiseAt)}
				</span>
			</p>
			{/* The encoders this relay reached (discovery + live WS state). A
			 * green dot = the control-channel WebSocket to that encoder is
			 * open (protocol.md §3); the "via" tag = the discovery method(s)
			 * (UDP announce / mDNS / control server) that found the encoder. */}
			{(() => {
				const encs = s.encoders ?? [];
				if (encs.length === 0) return null;
				return (
					<p class="encoder-links">
						<span class="muted">{t("dev.moblink.encoders")}</span>
						<span class="encoder-links-list">
							{encs.map((enc) => {
								const via = (enc.discoveredBy ?? [])
									.map((method) => t(DISCOVERY_METHOD_KEYS[method]))
									.join(" · ");
								return (
									<span
										class={`encoder-link${enc.connected ? " is-on" : ""}`}
										key={`enc:${enc.id}`}
										title={
											enc.connected
												? t("dev.moblink.encoder_connected")
												: t("dev.moblink.encoder_offline")
										}
									>
										<span class="ws-dot" aria-hidden="true" />
										{enc.id}
										{via ? (
											<small class="muted enc-via">
												{`${t("dev.moblink.via")} ${via}`}
											</small>
										) : null}
										{enc.lastSeen ? (
											<small class="muted"> · {since(enc.lastSeen)}</small>
										) : null}
									</span>
								);
							})}
						</span>
					</p>
				);
			})()}
			<Form onSubmit={() => moblinkStart(host)}>
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
