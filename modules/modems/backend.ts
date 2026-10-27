/*
 * modems module: ModemManager (mmcli) integration — enumeration, per-modem
 * details and control actions — plus the bonding side of a relay: interface
 * detection, the bond selection, source routing, the uplinks file and the
 * netlink monitor (routing.ts).
 *
 * Self-contained: the core bag is bound at discovery; srtla_send reloads go
 * through the `stream.srtla` capability when a module provides it.
 */
import type { ModuleCore } from "../../backend/client/module-core";
import { t } from "../../shared/i18n";
import type { BackendModule, Params } from "../../shared/module-contract";
import {
	ApiError,
	optionalStringList,
	requireIndex,
	requireString,
} from "../../shared/params";
import log from "./log";
import {
	bindRouting,
	detectInterfaces,
	isMonitorRunning,
	reconfigure,
	resolveSelection,
	selection,
	setSelection,
	startInterfaceMonitor,
	stopInterfaceMonitor,
	UPLINKS_FILE,
} from "./routing";
import type {
	ModemConfig,
	ModemInfo,
	ReconfigureResult,
	UplinksCapability,
} from "./types";

/** Core bag, bound at discovery and re-filled at start (a module never imports the core). */
let core: ModuleCore;

// ----------------------------------------------------------------------
// ModemManager
// ----------------------------------------------------------------------
const mmcli = (...args: string[]) => core.run("mmcli", args, true);

/** `mmcli -m <n>` labels of the plain-text fields we keep. */
const DETAIL_FIELDS = {
	state: "state",
	powerState: "power state",
	model: "model",
	manufacturer: "manufacturer",
	imei: "imei",
	primaryPort: "primary port",
	deviceId: "device id",
	simPath: "sim",
	operatorName: "operator name",
	registrationState: "registration",
	accessTech: "access tech",
} as const satisfies Record<string, string>;

async function scanModems(): Promise<ModemInfo[]> {
	const list = [...(await mmcli("-L")).matchAll(/Modem\/(\d+)\s+(.*)$/gm)];
	// Query the details of all modems in parallel; list order is preserved.
	return Promise.all(
		list.map(([, index, label]) => modemDetails(Number(index), label.trim())),
	);
}

let scanning: Promise<ModemInfo[]> | null = null;

/** Enumerate the modems; concurrent callers share one mmcli scan. */
function detectModems(): Promise<ModemInfo[]> {
	scanning ??= scanModems().finally(() => {
		scanning = null;
	});
	return scanning;
}

async function modemDetails(index: number, label: string): Promise<ModemInfo> {
	const detail = await mmcli("-m", String(index));
	const grab = (name: string) =>
		detail.match(new RegExp(`^\\s*${name}:\\s*(.+)$`, "m"))?.[1].trim();
	const info: ModemInfo = {
		index,
		path: `/org/freedesktop/ModemManager1/Modem/${index}`,
		state: "unknown",
		powerState: "unknown",
	};
	for (const [key, name] of Object.entries(DETAIL_FIELDS)) {
		const value = grab(name);
		if (value !== undefined)
			(info as unknown as Record<string, string>)[key] = value;
	}
	info.model ??= label;
	const signal = grab("signal quality")?.match(/(\d+)/);
	if (signal) info.signalQuality = Number(signal[1]);
	return info;
}

async function modemNetworkIface(modem: ModemInfo): Promise<string | null> {
	for (const [, bearer] of (
		await mmcli("-m", String(modem.index), "-b")
	).matchAll(/Bearer\/(\d+)/g)) {
		const iface = (await mmcli("-b", bearer)).match(/interface:\s*(\S+)/);
		if (iface) return iface[1];
	}
	const wwan = (await core.run("ip", ["-o", "-4", "addr", "show"], true)).match(
		/wwan\d+/g,
	);
	if (!wwan) return null;
	return wwan.find((n) => n === `wwan${modem.index}`) ?? wwan[0];
}

async function setModemEnabled(
	idx: number,
	enabled: boolean,
): Promise<boolean> {
	await mmcli("-m", String(idx), enabled ? "-e" : "-d");
	return true;
}

async function resetModem(idx: number): Promise<boolean> {
	if (await mmcli("-m", String(idx), "--reset")) return true;
	await setModemEnabled(idx, false);
	await Bun.sleep(2000);
	await setModemEnabled(idx, true);
	return true;
}

const connectModem = async (idx: number) =>
	(await mmcli("-m", String(idx), "--simple-connect=apn=internet")).length > 0;
const disconnectModem = async (idx: number) =>
	(await mmcli("-m", String(idx), "--simple-disconnect")).length > 0;

const MODEM_ACTIONS: Record<string, (index: number) => Promise<boolean>> = {
	enable: (i) => setModemEnabled(i, true),
	disable: (i) => setModemEnabled(i, false),
	reset: resetModem,
	connect: connectModem,
	disconnect: disconnectModem,
};

// ----------------------------------------------------------------------
// Bonding
// ----------------------------------------------------------------------
/** Ask srtla_send (when a module runs it) to re-read the uplinks file. */
async function reloadSrtla(): Promise<void> {
	if (core.hasCapability("stream.srtla"))
		await core
			.requireCapability<{ reloadSrtla(): Promise<void> }>("stream.srtla")
			.reloadSrtla();
}

/** Reconfigure routing / uplinks and reload srtla_send if the uplinks changed. */
async function reconfigureAndReload(): Promise<ReconfigureResult> {
	const result = await reconfigure();
	if (!result.ok) throw new ApiError(result.error ?? "reconfigure failed", 500);
	if (result.changed) await reloadSrtla();
	return result;
}

async function applySelection(next: ModemConfig) {
	await setSelection(next);
	const { selected, ips, uplinksFile, changed } = await reconfigureAndReload();
	return { selection: selection(), selected, ips, uplinksFile, changed };
}

async function selectModems(p: Params) {
	const names = optionalStringList(p, "modems");
	const ips = optionalStringList(p, "ips");
	const all = await detectInterfaces();
	const badIfaces = names?.filter((m) => !all.some((i) => i.iface === m)) ?? [];
	if (badIfaces.length)
		throw new ApiError(`Unknown interfaces: ${badIfaces.join(", ")}`);
	const badIps = ips?.filter((ip) => !all.some((i) => i.ip === ip)) ?? [];
	if (badIps.length) throw new ApiError(`Unknown IPs: ${badIps.join(", ")}`);
	return applySelection(
		names?.length ? { modems: names } : ips?.length ? { ips } : {},
	);
}

async function toggleModem(p: Params) {
	const name = requireString(p, "iface");
	const all = await detectInterfaces();
	if (!all.some((i) => i.iface === name))
		throw new ApiError(`Unknown interface: ${name}`, 404);
	const names = new Set(resolveSelection(all).map((i) => i.iface));
	if (!names.delete(name)) names.add(name);
	return applySelection({ modems: [...names] });
}

const uplinks: UplinksCapability = { file: UPLINKS_FILE, reconfigure };

function bind(c: ModuleCore): void {
	core = c;
	bindRouting(c, { detect: detectModems, modemIface: modemNetworkIface });
}

const registration: BackendModule<ModuleCore> = {
	kind: "device",
	id: "modems",
	title: "Modems",
	roles: ["relay", "combined"],
	methods: [
		"interfaces.list",
		"reconfigure",
		"modems.list",
		"modems.select",
		"modems.toggle",
		"modems.enable",
		"modems.disable",
		"modems.reset",
		"modems.connect",
		"modems.disconnect",
	],
	events: [],
	log,
	bind,
	/** Prime routing + the uplinks file, then watch netlink for changes. */
	async start(ctx) {
		bind(ctx.core);
		const result = await reconfigure();
		if (!result.ok) {
			console.error("Initial reconfigure failed:", result.error);
			core.logEvent(
				"error",
				"Interfaces",
				t("log.reconfigure_failed", { error: result.error }),
			);
			throw new Error(`Initial reconfigure failed: ${result.error}`);
		}
		console.log(`Initial uplinks: ${result.ips.join(", ")}`);
		startInterfaceMonitor(reloadSrtla);
	},
	async stop() {
		await stopInterfaceMonitor();
	},
	async dispatch(method, params) {
		switch (method) {
			case "interfaces.list":
				return { interfaces: await detectInterfaces() };
			case "reconfigure":
				return reconfigureAndReload();
			case "modems.list": {
				const modems = await detectModems();
				const all = await detectInterfaces(modems);
				return {
					selection: selection(),
					selected: resolveSelection(all),
					modems,
				};
			}
			case "modems.select":
				return selectModems(params);
			case "modems.toggle":
				return toggleModem(params);
		}
		// Modem actions: the monitor picks up the resulting netlink events and pushes a status update
		const action = method.replace(/^modems\./, "");
		const fn = Object.hasOwn(MODEM_ACTIONS, action)
			? MODEM_ACTIONS[action]
			: undefined;
		if (!fn) throw new Error(`unknown method ${method}`);
		const modemIndex = requireIndex(params);
		return { modemIndex, action, ok: await fn(modemIndex) };
	},
	async status() {
		const modems = await detectModems();
		const interfaces = await detectInterfaces(modems);
		return {
			state: { selection: selection() },
			interfaces,
			selected: resolveSelection(interfaces),
			modems,
			uplinksFile: UPLINKS_FILE,
			monitor: { running: isMonitorRunning() },
		};
	},
	services: { capabilities: { "net.uplinks": uplinks } },
};

export default registration;
