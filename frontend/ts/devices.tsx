/* Control server device list — a Mithril view fed by the server's live device
 * list (devices.snapshot / devices.changed over the shared feed websocket). */
import m from "mithril";
import type { DeviceSummary } from "../types";
import { roleTag } from "./components/icons";
import { Badge, Card, Page, ServerNav } from "./components/ui";
import { i18nReady, t } from "./i18n";
import {
	deviceSummaryColumnDefinitions,
	deviceSummaryColumnsFor,
} from "./module-registry";
import { serverLive } from "./services/serverws";
import { mountPage, since } from "./util";

const state = {
	connected: false,
	devices: null as DeviceSummary[] | null, // null = before the first snapshot landed
};

serverLive.on({
	devices: (list) => {
		state.devices = list;
		m.redraw();
	},
	open: () => {
		state.connected = true;
		m.redraw();
	},
	close: () => {
		state.connected = false;
		m.redraw();
	},
});

/** Header badge: the socket state, then the online count once connected. */
function _connBadge(): m.Vnode {
	if (!state.connected)
		return <Badge text={t("dev.disconnected")} kind="off" />;
	const online = state.devices?.filter((d) => d.online).length ?? 0;
	return (
		<Badge
			text={t("dev.badge.online_count", {
				online,
				total: state.devices?.length ?? 0,
			})}
			kind={online ? "on" : "warn"}
		/>
	);
}

function row(
	d: DeviceSummary,
	columns: ReturnType<typeof deviceSummaryColumnDefinitions>,
): m.Vnode {
	const available = new Map(
		deviceSummaryColumnsFor(d).map((column) => [column.id, column]),
	);
	return (
		<tr key={d.id}>
			<td>
				<a class="device" href={`d/${encodeURIComponent(d.id)}/`} title={d.id}>
					<span
						class={["device-dot", d.online ? "online" : ""]
							.filter(Boolean)
							.join(" ")}
						style={d.color ? `background:${d.color};color:${d.color}` : ""}
					/>
					{d.hostname || d.id}
				</a>
			</td>
			<td class="muted">{d.role ? roleTag(d.role) : "—"}</td>
			<td>
				{d.online ? (
					<Badge text={t("dev.badge.online")} kind="on" />
				) : (
					<Badge text={t("dev.badge.offline")} kind="off" />
				)}
			</td>
			<td>
				{d.online
					? since(d.connectedAt)
					: t("mgmt.last_seen", { time: since(d.lastSeen) })}
			</td>
			{columns.map((column) => (
				<td>{available.get(column.id)?.cell(d) ?? "—"}</td>
			))}
		</tr>
	);
}

const columnHeaders = (
	columns: ReturnType<typeof deviceSummaryColumnDefinitions>,
): m.Children[] => [
	t("mgmt.th.device"),
	t("mgmt.th.role"),
	t("mgmt.th.status"),
	t("mgmt.th.connected"),
	...columns.map((column) => column.header()),
];

const App: m.Component = {
	view: () => {
		const columns = deviceSummaryColumnDefinitions();
		const headers = columnHeaders(columns);
		return (
			<Page nav={<ServerNav active="devices" />}>
				<Card>
					<table>
						<thead>
							<tr>
								{headers.map((h) => (
									<th>{h}</th>
								))}
							</tr>
						</thead>
						<tbody>
							{state.devices?.length ? (
								state.devices.map((device) => row(device, columns))
							) : (
								<tr>
									<td colspan={headers.length} class="muted">
										{state.devices ? t("mgmt.none") : t("mgmt.loading")}
									</td>
								</tr>
							)}
						</tbody>
					</table>
				</Card>
			</Page>
		);
	},
};

void mountPage(() => t("mgmt.title"), App);
// Redraw once the catalogs land so the first paint is already translated
void i18nReady.then(() => m.redraw());
