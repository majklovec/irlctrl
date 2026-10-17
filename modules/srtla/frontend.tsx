/* SRTLA card: srtla_send state, the receiver form and the scheduler options. */
import m from "mithril";
import type { SrtlaStats, Status } from "../../public/types";
import {
	Actions,
	Badge,
	Break,
	Button,
	Card,
	type Child,
	CheckField,
	DefinitionList,
	Field,
	FieldGroup,
	Form,
	Input,
	Options,
} from "../../public/ts/components/ui";
import { formatBitrate, since } from "../../public/ts/util";
import { t } from "../../public/ts/i18n";
import { card, type DeviceCard } from "../../public/ts/device/store";
import { encoderStart, streamButtons } from "../encoder/frontend";
import { modemsContent } from "../modems/frontend";
import type { BridgedModule } from "./types";

type SrtlaOptions = Status["state"]["srtlaOptions"];

function srtlaStart(host: DeviceCard): void {
	const { fields } = host;
	if (!fields.listenPort || !fields.remoteHost || !fields.remotePort) return;
	host.press("srtla-start", "srtla.start", {
		listenPort: fields.listenPort,
		remoteHost: fields.remoteHost,
		remotePort: fields.remotePort,
	});
}

async function setOption(host: DeviceCard, key: keyof SrtlaOptions, value: string | boolean): Promise<void> {
	const result = await host.act<{ options: SrtlaOptions }>(`srtla-${key}`, "srtla.options", { [key]: value });
	// The status push is debounced; do not flash the old value until it arrives
	if (result && host.st.status) host.st.status.state.srtlaOptions = result.options;
}

// Scheduler options: the saved settings, else what the running srtla_send reports, else its defaults
const liveStats = (host: DeviceCard) => (host.st.status?.state.srtla.running ? host.st.stats : null);
const modeValue = (host: DeviceCard): string =>
	host.st.status?.state.srtlaOptions?.mode ?? liveStats(host)?.mode ?? "enhanced";
const qualityValue = (host: DeviceCard): boolean =>
	host.st.status?.state.srtlaOptions?.quality ?? liveStats(host)?.quality_enabled ?? true;

function linkStats(stats: SrtlaStats | null): m.Children {
	if (!stats?.links.length) return <p class={"muted"}>{t("dev.badge.no_links")}</p>;
	return (
		<table class={"dash-table"}>
			<tbody>
				{stats.links.map((link) => (
					<tr key={link.ip}>
						<th>{link.label ?? link.ip}</th>
						<td>
							{link.connected ? (
								<Badge text={t("dev.link_up")} kind={"on"} />
							) : (
								<Badge text={t("dev.badge.offline")} kind={"off"} />
							)}{" "}
							<span class={"muted"}>
								{`${formatBitrate(link.bitrate_bytes_per_sec)} · ${link.rtt_ms} ms`}
							</span>
						</td>
					</tr>
				))}
			</tbody>
		</table>
	);
}

function controlBadge(status: Status): Child {
	const c = status.srtlaControl;
	if (c?.connected) return <Badge text={t("dev.connected")} kind={"on"} />;
	if (c?.supported) return <Badge text={t("dev.control_connecting")} kind={"warn"} />;
	return (
		<span class={"muted"} title={t("dev.control_unavailable_title")}>
			{t("dev.control_unavailable")}
		</span>
	);
}

export function srtlaCardBody(host: DeviceCard, status: Status): m.Vnode {
	const { fields, busy } = host;
	const s = status.state.srtla;
	const combined = status.role === "combined";
	return (
		<Card title={t("dev.card.srtla")} class={"mod-srtla"}>
			<DefinitionList
				rows={[
					[
						t("dev.row.state"),
						s.running ? <Badge text={t("dev.row_state_running")} kind={"on"} /> : <Badge text={t("dev.badge.stopped")} kind={"off"} />,
					],
					[t("dev.row.started"), s.running ? since(s.startedAt) : null],
					[
						t("dev.reloads"),
						t("dev.reloads_detail", s.reloadCount ?? 0, since(s.lastReloadAt), status.monitor.reloadMode),
					],
					[
						t("dev.monitor"),
						status.monitor.running ? <Badge text={t("dev.monitor_watching")} kind={"on"} /> : <Badge text={t("ui.off")} kind={"warn"} />,
					],
					[t("dev.control"), s.running ? controlBadge(status) : null],
				]}
			/>
			<h3>{t("dev.th.link")}</h3>
			{linkStats(host.st.stats)}
			{status.modules.modems.enabled && (
				<section class={"mod-modems"}>
					<h3>{t("dev.card.modems")}</h3>
					{modemsContent(host, status)}
				</section>
			)}
			<Form onSubmit={combined ? () => encoderStart(host) : () => srtlaStart(host)}>
				<FieldGroup legend={t("dev.group.connection")}>
					{!combined && (
						<>
							<Field
								label={t("dev.field.srt_listen_port")}
								control={<Input target={fields} prop="listenPort" placeholder={"6000"} required={true} />}
							/>
							<span> ⇨ </span>
						</>
					)}
					<Field
						label={t("dev.field.remote_host")}
						control={<Input target={fields} prop="remoteHost" placeholder={"rec.example.com"} required={true} />}
					/>
					<Field
						label={t("dev.field.remote_port")}
						control={<Input target={fields} prop="remotePort" placeholder={"5000"} required={true} />}
					/>
				</FieldGroup>
				<FieldGroup legend={t("dev.quality_scoring")}>
					<Field
						label={t("dev.scheduler")}
						control={
							<select
								disabled={busy.has("srtla-mode")}
								value={modeValue(host)}
								onchange={(e: Event) => void setOption(host, "mode", (e.target as HTMLSelectElement).value)}
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
								type={"checkbox"}
								checked={qualityValue(host)}
								disabled={busy.has("srtla-quality") || modeValue(host) === "classic"}
								onchange={(e: Event) =>
									void setOption(host, "quality", (e.target as HTMLInputElement).checked)
								}
							/>
						}
					/>
				</FieldGroup>
				<Break />
				{combined
					? streamButtons(host, "stream.stop")
					: (
						<Actions>
							<Button label={t("ui.start")} type={"submit"} disabled={!host.enabled("srtla-start")} />
							<Button
								label={t("ui.stop")}
								class={"danger"}
								disabled={!host.enabled("srtla-stop")}
								onclick={() => host.press("srtla-stop", "srtla.stop")}
							/>
							<Button
								label={t("ui.reload")}
								disabled={!host.enabled("srtla-reload")}
								onclick={() => host.press("srtla-reload", "srtla.reload")}
							/>
						</Actions>
					)}
			</Form>
		</Card>
	);
}

const srtlaModule: BridgedModule = {
	id: "srtla",
	kind: "device-card",
	title: "SRTLA",
	defaultSize: { w: 4, h: 4 },
	minSize: { w: 3, h: 3 },
	component: (status: Status) => srtlaCardBody(card, status),
	cardBody: (host, status) => srtlaCardBody(host as DeviceCard, status as Status),
};

export default srtlaModule;
