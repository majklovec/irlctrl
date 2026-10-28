/* SRTLA → RTMP card: the stream lifecycle (srtla_rec + ffmpeg) on this
 * device and the start / stop actions. The RTMP destination and ffmpeg output
 * profile are edited on the Settings page (this card shows them). */
import m from "mithril";
import {
	Actions,
	Badge,
	Button,
	Card,
	DefinitionList,
} from "../../frontend/ts/components/ui";
import { card, type DeviceCard } from "../../frontend/ts/device/store";
import { t } from "../../frontend/ts/i18n";
import type { FrontendModule } from "../../frontend/ts/module-contracts";
import log from "./log";
import "./styles.css";
import type { Srtla2PlatformStatus } from "./types";

function srtla2platformCardBody(host: DeviceCard, status: Srtla2PlatformStatus): m.Vnode {
	const s = status.state;
	const running = s.stream === "running";
	const transitional = s.stream === "starting" || s.stream === "stopping";
	return (
		<Card title={t("dev.card.srtla2platform")} class="mod-srtla2platform">
			<DefinitionList
				rows={[
					[
						t("dev.row.state"),
						running ? (
							<Badge text={t("dev.row_state_running")} kind="on" />
						) : transitional ? (
							<Badge text={t("dev.badge.starting")} kind="warn" />
						) : (
							<Badge text={t("dev.badge.stopped")} kind="off" />
						),
					],
					[
						t("dev.row.rtmp"),
						s.rtmp ? (
							<code class="srtla2platform-rtmp">{s.rtmp}</code>
						) : (
							<span class="muted">{t("set.srtla2platform_desc")}</span>
						),
					],
					// The selected ffmpeg output profile (always present;
					// "copy" is the default stream-copy profile).
					...(s.profile
						? [
								[
									t("set.srtla2platform_profile"),
									<code class="srtla2platform-rtmp">
										{s.profile}
									</code>,
								] as [string, m.Vnode],
							]
						: []),
					...(s.restarts > 0
						? [
								[
									t("dev.row.auto_restarts"),
									<span class={running ? "muted" : "error"}>
										{s.restarts}
									</span>,
								] as [string, m.Vnode],
							]
						: []),
				]}
			/>
			<Actions>
				<Button
					label={t("ui.start")}
					disabled={running || transitional || !s.rtmp || host.pending("srtla2platform-start")}
					onclick={() => host.press("srtla2platform-start", "start")}
				/>
				<Button
					label={t("ui.stop")}
					class="danger"
					disabled={!running || transitional || host.pending("srtla2platform-stop")}
					onclick={() => host.press("srtla2platform-stop", "stop")}
				/>
			</Actions>
		</Card>
	);
}

const srtla2platformModule: FrontendModule = {
	id: "srtla2platform",
	kind: "device-card",
	title: "SRTLA → RTMP",
	order: 20,
	available: (status) => status.role === "srtla2platform",
	defaultSize: { w: 4, h: 4 },
	minSize: { w: 3, h: 3 },
	component: (status) =>
		srtla2platformCardBody(card, status as Srtla2PlatformStatus),
	log,
};

export default srtla2platformModule;
