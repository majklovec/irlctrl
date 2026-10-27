/* Local types of the modems module (never imported by the core or other modules). */

/** One usable network interface (the `interfaces` / `selected` status fragments). */
export interface Iface {
	iface: string;
	ip: string;
	prefix: number;
	cidr: string;
	speed?: number;
	modemIndex?: number;
	modemPath?: string;
	signalQuality?: number;
	operatorName?: string;
	accessTech?: string;
	registered?: boolean;
	connectionState?: string;
}

/** The persisted uplink selection (`state.selection`): modem paths and/or interface IPs. */
export interface ModemConfig {
	modems?: string[];
	ips?: string[];
}

/** ModemManager modem as reported by `mmcli` (routing, the `modems` status fragment, the UI). */
export interface ModemInfo {
	index: number;
	path: string;
	state: string;
	powerState: string;
	signalQuality?: number;
	accessTech?: string;
	operatorName?: string;
	registrationState?: string;
	model?: string;
	manufacturer?: string;
	imei?: string;
	primaryPort?: string;
	deviceId?: string;
	simPath?: string;
}

/** Outcome of one routing + uplinks-file reconcile (`reconfigure`, the `net.uplinks` capability). */
export interface ReconfigureResult {
	ok: boolean;
	selected: Iface[];
	uplinksFile: string;
	ips: string[];
	/** The uplinks file content actually changed (srtla_send needs a reload). */
	changed: boolean;
	error?: string;
}

/** The `net.uplinks` capability: where the uplinks file is and how to rebuild it. */
export interface UplinksCapability {
	file: string;
	reconfigure(): Promise<ReconfigureResult>;
}

/** ModemManager lookups routing.ts enriches the interface list with. */
export interface ModemSource {
	detect(): Promise<ModemInfo[]>;
	modemIface(modem: ModemInfo): Promise<string | null>;
}
