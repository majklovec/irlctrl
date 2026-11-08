/* Modems card: the ModemManager modem panels — signal, operator, registration,
 * power — with the enable / disable / connect / disconnect / reset actions.
 */
import "./styles.css";
import {
	Actions,
	Badge,
	Button,
	Card,
	DefinitionList,
	type Child,
} from "@ui/components/";
import { confirmDialog } from "@ui/components/confirm";
import { card, type DeviceCard } from "@ui/device/store";
import { t } from "@ui/i18n";
import m from "mithril";
import type {
	FrontendModule,
	DeviceDashboardWidget,
} from "../../../shared/contracts/frontend_module";
import type { ModemInfo, ModemsStatus } from "./types";
import log from "./log";

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

function modemPanel(host: DeviceCard, modem: ModemInfo): m.Vnode {
	const control = (label: string, method: string, cls = "secondary") => (
		<Button
			label={label}
			class={cls}
			disabled={
				host.busy.has(`modem:${method}:${modem.index}`) ||
				!!(host.st.status as { state?: { relay?: { running?: boolean } } })
					?.state?.relay?.running
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

function modemsCard(host: DeviceCard, status: ModemsStatus): m.Vnode {
	return (
		<Card title={t("dev.card.modems")} class="mod-modems-card">
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

const modemsDashboardWidgets: DeviceDashboardWidget[] = [
	{
		type: "modems",
		available: (device) =>
			device.role === "relay" ||
			device.role === "encoder" ||
			device.role === undefined,
		defaultSize: { w: 4, h: 4 },
		minSize: { w: 3, h: 3 },
		body: ({ card: host, status }) =>
			status ? modemsCard(host, status as unknown as ModemsStatus) : null,
	},
];

const modemsModule: FrontendModule = {
	id: "modems",
	kind: "device-card",
	title: "Modems",
	order: 25,
	log,
	available: (status) =>
		status.role === "relay" || status.role === "encoder",
	dashboardWidgets: modemsDashboardWidgets,
	defaultSize: { w: 4, h: 4 },
	minSize: { w: 3, h: 3 },
	component: (status) => modemsCard(card, status as unknown as ModemsStatus),
};

export default modemsModule;
