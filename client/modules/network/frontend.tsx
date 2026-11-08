/* Network card: interface detection, bond selection per interface, and the
 * live srtla_send link stats matched to interfaces by source IP (shown on
 * the roles that push `relay.stats` — the relay; on the encoder the link
 * columns sit muted until/unless stats arrive).
 */
import "./styles.css";
import { Badge, Card, type Child, IconButton } from "@ui/components/";
import { Icon } from "@ui/components/icons";
import { card, type DeviceCard } from "@ui/device/store";
import { t } from "@ui/i18n";
import { formatBitrate, formatSpeed, since } from "@ui/util";
import m from "mithril";
import type {
	DeviceDashboardWidget,
	FrontendModule,
} from "../../../shared/contracts/frontend_module";
import log from "./log";
import { defaultRouteRowIndex } from "./route_view";
import type { Iface, NetworkStatus, SrtlaLinkStats } from "./types";

const STATS_STALE_MS = 5_000;
const LINK_COLUMNS = 7;

/** The `relay.stats` push frame with its payload, once validated. */
function statsFrame(
	host: DeviceCard,
):
	| { at: number; data: { stats: { links?: SrtlaLinkStats[] } | null } }
	| undefined {
	const entry = host.st.events.get("relay.stats");
	if (!entry) return undefined;
	const data = entry.data as
		| { stats?: { links?: SrtlaLinkStats[] } | null }
		| undefined;
	if (!data || (data.stats && !Array.isArray(data.stats.links)))
		return undefined;
	return { at: entry.at, data: { stats: data.stats ?? null } };
}

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

function interfacesCard(host: DeviceCard, status: NetworkStatus): m.Vnode {
	const selected = new Set((status.selected ?? []).map((i: Iface) => i.iface));
	const frame = statsFrame(host);
	const live = frame?.data.stats ?? null;
	const stale = !!live && frame?.at && Date.now() - frame.at > STATS_STALE_MS;
	const links = new Map((live?.links ?? []).map((l) => [l.ip, l]));
	const total = (live?.links ?? []).reduce(
		(sum, l) => sum + (l.bitrate_bytes_per_sec || 0),
		0,
	);
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
				status.monitor?.running ? (
					<Badge text={t("dev.monitor_watching")} kind="on" />
				) : (
					<Badge text={t("ui.off")} kind="warn" />
				),
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

const networkDashboardWidgets: DeviceDashboardWidget[] = [
	{
		type: "network",
		available: (device) =>
			device.role === "relay" ||
			device.role === "encoder" ||
			device.role === undefined,
		defaultSize: { w: 4, h: 5 },
		minSize: { w: 3, h: 3 },
		body: ({ card: host, status }) =>
			status ? interfacesCard(host, status as unknown as NetworkStatus) : null,
	},
];

const networkModule: FrontendModule = {
	id: "network",
	kind: "device-card",
	title: "Network",
	order: 15,
	log,
	available: (status) => status.role === "relay" || status.role === "encoder",
	dashboardWidgets: networkDashboardWidgets,
	defaultSize: { w: 4, h: 5 },
	minSize: { w: 3, h: 3 },
	component: (status) =>
		interfacesCard(card, status as unknown as NetworkStatus),
};

export default networkModule;
