/* Modems card: the ModemManager modem panels — signal, operator, registration,
 * power — with the enable / disable / connect / disconnect / reset actions.
 */
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
	Input,
	Options,
	Select,
} from "@ui/components/";
import { confirmDialog } from "@ui/components/confirm";
import { card, type DeviceCard } from "@ui/device/store";
import { t } from "@ui/i18n";
import m from "mithril";
import type {
	DeviceDashboardWidget,
	FrontendModule,
} from "../../../shared/contracts/frontend_module";
import log from "./log";
import type { GsmProfile } from "./modems";
import { ratLabel } from "./modems";
import type { ModemInfo, ModemsStatus, ScannedNetwork } from "./types";

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

// ---------------------------------------------------------------------------
// Network scan / setup form state (module-owned, one entry per modem index)
// ---------------------------------------------------------------------------

interface ModemNetState {
	/** PLMNs from the last `modems.scan` (empty = not scanned yet). */
	networks: ScannedNetwork[];
	/** True while a `modems.scan` RPC is in flight. */
	scanning: boolean;
	/** Human-readable outcome of the last failed/empty scan, if any. */
	scanError?: string;
	/** Selected PLMN id ("50501"); "" = keep the automatic selection. */
	plmn: string;
	/** Long name of the selected PLMN (sent for the operator cache). */
	plmnName: string;
	/** APN to dial; "" = keep the profile's current APN. */
	apn: string;
	/** APN username; "" = keep the profile's current username. */
	username: string;
	/** APN password; "" = keep the profile's current password. */
	password: string;
	/** Allow roaming (belaUI `gsm.home-only` is the negation). */
	allowRoaming: boolean;
	/** Let NetworkManager auto-configure the APN (belaUI `gsm.auto-config`). */
	autoConfig: boolean;
	/** Allowed radio bands (RAT tokens); empty = auto (no fixed band). */
	allowedModes: string[];
	/** Preferred band among the allowed ones; "" = auto. */
	preferredMode: string;
	/** The profile the form was prefilled from, for "only send what changed". */
	profile?: Partial<GsmProfile>;
	/** The bands the form was prefilled from (the modem's current modes). */
	baseAllowedModes: string[];
	basePreferredMode: string;
	/** True while the `modems.profile` prefill RPC is in flight. */
	profileLoading: boolean;
	/** True once the profile has been prefilled (load once per modem). */
	profileLoaded: boolean;
}

const netState = new Map<number, ModemNetState>();
const netStateOf = (index: number): ModemNetState => {
	let state = netState.get(index);
	if (!state) {
		state = {
			networks: [],
			scanning: false,
			plmn: "",
			plmnName: "",
			apn: "",
			username: "",
			password: "",
			allowRoaming: true,
			autoConfig: false,
			allowedModes: [],
			preferredMode: "",
			baseAllowedModes: [],
			basePreferredMode: "",
			profileLoading: false,
			profileLoaded: false,
		};
		netState.set(index, state);
	}
	return state;
};

/**
 * Load the modem's persisted gsm profile into the form so the user edits the
 * actual settings, not blanks (belaUI keeps the config in the form). `profile`
 * remembers the original values so `applyNetworkSetup` only sends what changed.
 */
async function loadProfile(host: DeviceCard, modem: ModemInfo): Promise<void> {
	const index = modem.index;
	const state = netStateOf(index);
	state.profileLoading = true;
	m.redraw();
	const res = await host.act<{ profile?: Partial<GsmProfile> | null }>(
		`modem:modems.profile:${index}`,
		"modems.profile",
		{ index },
	);
	state.profileLoading = false;
	state.profileLoaded = true;
	const profile = res?.profile ?? {};
	state.profile = profile;
	state.plmn = profile.networkId ?? "";
	state.plmnName =
		state.networks.find((n) => n.plmnId === state.plmn)?.operatorName ?? "";
	state.apn = profile.apn ?? "";
	state.username = profile.username ?? "";
	state.password = ""; // never shown; empty = "unchanged"
	state.allowRoaming = profile.homeOnly === false;
	state.autoConfig = profile.autoConfig ?? false;
	// Prefill the band mode from the modem's current modes (belaUI shows the
	// active `network_type`); an empty `allowed` means the modem is in auto.
	const current = modem.currentModes;
	state.allowedModes = current ? [...current.allowed] : [];
	state.preferredMode =
		current && current.preferred.length ? current.preferred[0] : "";
	state.baseAllowedModes = [...state.allowedModes];
	state.basePreferredMode = state.preferredMode;
	m.redraw();
}

/** Run a 3GPP scan on one modem and remember its PLMNs. Failures land in the
 * device log as `modems.scan` errors (the store logs for us). */
async function scanNetworks(host: DeviceCard, index: number): Promise<void> {
	const state = netStateOf(index);
	state.scanning = true;
	state.scanError = undefined;
	m.redraw();
	// A 3GPP sweep has been measured up to >4 min (with a retry), so the
	// default 30 s RPC timeout would abort long before the call returns.
	const res = await host.act<{ networks?: ScannedNetwork[] }>(
		`modem:modems.scan:${index}`,
		"modems.scan",
		{ index },
		{ timeoutMs: 900_000 },
	);
	state.scanning = false;
	if (res?.networks) {
		state.networks = res.networks;
		state.scanError = res.networks.length ? undefined : t("dev.scan_empty");
	} else {
		// The RPC rejected (or timed out) — `act` swallows the error and
		// returns undefined. Surface an actionable hint; the root cause is
		// in the device log.
		state.scanError = t("dev.scan_failed");
	}
	m.redraw();
}

/**
 * Apply the form to one modem. Each field is sent only when it differs from
 * the profile the form was loaded from, so an untouched control leaves that
 * setting as-is (the backend treats `undefined` fields as "no change").
 */
/** Whether the chosen band mode differs from the modem's current mode. */
function modesChanged(state: ModemNetState): boolean {
	return (
		state.allowedModes.join("|") !== state.baseAllowedModes.join("|") ||
		state.preferredMode !== state.basePreferredMode
	);
}

function applyNetworkSetup(host: DeviceCard, index: number): void {
	const state = netStateOf(index);
	const prev = state.profile ?? {};
	const params: Record<string, unknown> = { index };
	if (state.plmn !== (prev.networkId ?? "")) {
		params.plmn = state.plmn || undefined;
		params.operatorName = state.plmnName || undefined;
	}
	if (state.apn.trim() !== (prev.apn ?? "")) params.apn = state.apn.trim();
	if (state.username.trim() !== (prev.username ?? ""))
		params.username = state.username.trim();
	// A non-empty password is always sent (blank = "unchanged" on the form).
	if (state.password) params.password = state.password;
	if (state.allowRoaming !== (prev.homeOnly ? false : true))
		params.allowRoaming = state.allowRoaming;
	if (state.autoConfig !== (prev.autoConfig ?? false))
		params.autoConfig = state.autoConfig;
	if (modesChanged(state)) {
		params.allowedModes = state.allowedModes;
		params.preferredMode = state.preferredMode || undefined;
	}
	void host.act<{ modes?: { allowed: string[]; preferred?: string } }>(
		`modem:modems.setup:${index}`,
		"modems.setup",
		params,
	).then((res) => {
		// A modem only accepts the combinations it publishes, so the backend
		// widens the request to the smallest accepted one — resync the form
		// checkboxes to what the modem actually has now.
		if (res?.modes) {
			state.allowedModes = [...res.modes.allowed];
			state.preferredMode = (res.modes.preferred ?? "") as string;
			state.baseAllowedModes = [...res.modes.allowed];
			state.basePreferredMode = state.preferredMode;
			m.redraw();
		}
	});
}

/** Whether the form differs from the profile it was loaded from. */
function setupDirty(state: ModemNetState): boolean {
	const prev = state.profile ?? {};
	if (state.plmn !== (prev.networkId ?? "")) return true;
	if (state.apn.trim() !== (prev.apn ?? "")) return true;
	if (state.username.trim() !== (prev.username ?? "")) return true;
	if (state.password) return true;
	if (state.allowRoaming !== (prev.homeOnly ? false : true)) return true;
	if (state.autoConfig !== (prev.autoConfig ?? false)) return true;
	return modesChanged(state);
}

/** The network / band-mode / APN setup form under the modem's action buttons. */
function netSetupRow(host: DeviceCard, modem: ModemInfo): m.Vnode {
	const state = netStateOf(modem.index);
	const options = state.networks.map((n): readonly [string, string] => [
		n.plmnId,
		`${n.operatorName ?? t("dev.network_unknown")} (${n.plmn}${n.accessTech ? ` · ${n.accessTech}` : ""} · ${n.status})`,
	]);
	const applyDisabled =
		host.busy.has(`modem:modems.setup:${modem.index}`) ||
		state.profileLoading ||
		!setupDirty(state);
	// Placeholder shown in the empty slot of the network select.
	const placeholder = state.scanning
		? t("dev.scan_running")
		: state.networks.length
			? t("dev.network_auto")
			: t("dev.network_no_scan");
	// One line of feedback for the scan: in-progress, failed, or empty.
	let status: { text: string; cls: string } | undefined;
	if (state.scanning) status = { text: t("dev.scan_running"), cls: "" };
	else if (state.scanError)
		status = {
			text: state.scanError,
			cls: state.networks.length ? "warn" : "error",
		};
	// The RATs the band-mode checkboxes offer — the modem's supported set,
	// falling back to the full ladder when ModemManager reports none.
	const rats = modem.supportedModes?.length
		? modem.supportedModes
		: ["gsm", "umts", "lte", "nr5g"];
	const toggleRat = (rat: string) => {
		const i = state.allowedModes.indexOf(rat);
		if (i >= 0) state.allowedModes.splice(i, 1);
		else state.allowedModes.push(rat);
		if (
			state.preferredMode &&
			!state.allowedModes.includes(state.preferredMode)
		)
			state.preferredMode = "";
		m.redraw();
	};
	return (
		<div class="net">
			<Field
				label={t("dev.network")}
				control={
					<Select
						target={state}
						prop="plmn"
						disabled={state.scanning}
						onChange={(value) => {
							state.plmnName =
								state.networks.find((n) => n.plmnId === value)?.operatorName ??
								"";
						}}
					>
						<option value="">{placeholder}</option>
						<Options pairs={options} />
					</Select>
				}
			/>
			<Break />
			<Field
				label={t("dev.apn")}
				control={
					<Input
						target={state}
						prop="apn"
						placeholder={t("dev.apn_hint")}
						disabled={state.autoConfig}
					/>
				}
			/>
			<Field
				label={t("dev.username")}
				control={
					<Input target={state} prop="username" disabled={state.autoConfig} />
				}
			/>
			<Field
				label={t("dev.password")}
				control={
					<Input
						target={state}
						prop="password"
						type="password"
						autoComplete="new-password"
						disabled={state.autoConfig}
					/>
				}
			/>
			<Break />
			<CheckField
				label={t("dev.roaming")}
				control={
					<Checkbox
						target={state}
						prop="allowRoaming"
						onChange={() => m.redraw()}
					/>
				}
			/>
			<CheckField
				label={t("dev.autoconfig")}
				control={
					<Checkbox
						target={state}
						prop="autoConfig"
						onChange={() => m.redraw()}
					/>
				}
			/>
			<Break />
			<Field
				label={t("dev.bands")}
				control={
					<div class="band">
						{rats.map((rat) => (
							<CheckField
								key={rat}
								class="band-opt"
								label={ratLabel(rat)}
								control={
									<input
										type="checkbox"
										checked={state.allowedModes.includes(rat)}
										onclick={() => toggleRat(rat)}
									/>
								}
							/>
						))}
					</div>
				}
			/>
			<Field
				label={t("dev.preferred_band")}
				control={
					<Select target={state} prop="preferredMode">
						<option value="">{t("dev.network_auto")}</option>
						{state.allowedModes.map((rat) => (
							<option key={rat} value={rat}>
								{ratLabel(rat)}
							</option>
						))}
					</Select>
				}
			/>
			<Break />
			<Button
				label={t("dev.apply")}
				class="primary"
				disabled={applyDisabled || state.scanning}
				onclick={() => applyNetworkSetup(host, modem.index)}
			/>
			{status && (
				<p class={`scan-status${status.cls ? ` ${status.cls}` : ""}`}>
					{status.text}
				</p>
			)}
		</div>
	);
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
	const control = (
		label: string,
		method: string,
		cls = "secondary",
		onclick?: () => void,
	) => (
		<Button
			label={label}
			class={cls}
			disabled={
				host.busy.has(`modem:${method}:${modem.index}`) ||
				!!(host.st.status as { state?: { relay?: { running?: boolean } } })
					?.state?.relay?.running
			}
			onclick={onclick ?? (() => void modemAction(host, method, modem.index))}
		/>
	);

	const name =
		[modem.manufacturer, modem.model].filter(Boolean).join(" ") ||
		t("dev.modem_fallback");
	// Prefill the setup form with the modem's persisted profile once, so the
	// user edits the real settings (belaUI keeps the config in the form).
	if (
		!netStateOf(modem.index).profileLoaded &&
		!netStateOf(modem.index).profileLoading
	)
		void loadProfile(host, modem);
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
				{control(
					t("dev.scan"),
					"modems.scan",
					"secondary",
					() => void scanNetworks(host, modem.index),
				)}
				{control(t("ui.reset"), "modems.reset", "danger")}
			</Actions>
			{netSetupRow(host, modem)}
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
			device.role === "moblink_relay" ||
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
		status.role === "relay" ||
		status.role === "encoder" ||
		status.role === "moblink_relay",
	dashboardWidgets: modemsDashboardWidgets,
	defaultSize: { w: 4, h: 4 },
	minSize: { w: 3, h: 3 },
	component: (status) => modemsCard(card, status as unknown as ModemsStatus),
};

export default modemsModule;
