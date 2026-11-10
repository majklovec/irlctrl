/* Types for the network module's interface-routing domain: bondable
 * interfaces, the bond selection, the uplinks file and the reconfigure
 * result. The cross-module capability contracts (modems.source,
 * network.uplinks) live in shared/ — re-exported so module-internal
 * imports can stay on `./types`. */

export type { Modem, ModemSource, Uplinks } from "../../../shared/contracts/module_capabilities";

/** IPv4 interface usable for bonding (enriched with modem details when bonded to one). */
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
    /** Carrier IPv4 gateway (modems only). Cellular gateways are not in the
     * main routing table, so the reconfigure plan uses this to build a
     * working per-uplink default route. */
    gateway?: string;
}

/** The persisted bond selection (by interface name, else by IP; empty = all). */
export interface ModemConfig {
    modems?: string[];
    ips?: string[];
}

/** The result of a routing + uplinks-file reconfigure. */
export interface ReconfigureResult {
    ok: boolean;
    selected: Iface[];
    uplinksFile: string;
    ips: string[];
    changed: boolean;
    error?: string;
}

/**
 * One srtla_send link of the SRTLA stats push (`relay.stats` / `stream.stats`)
 * — the fields the interfaces card renders (structural: the SRTLA modules
 * own the full event type).
 */
export interface SrtlaLinkStats {
	ip: string;
	label?: string;
	connected: boolean;
	timed_out: boolean;
	bitrate_bytes_per_sec: number;
	rtt_ms: number;
	rtt_min_ms: number;
	window: number;
	in_flight: number;
	nak_count: number;
	cc_loss_permille: number;
	quality_multiplier?: number;
	base_score?: number;
	weak?: boolean;
	weak_reason?: string;
	stall_gated?: boolean;
	sole_carrier?: boolean;
}

/** The network module's status fragment (deep-merged into the device status). */
export interface NetworkStatus {
	interfaces: Iface[];
	selected: Iface[];
	selection?: ModemConfig;
	modems?: import("../../../shared/contracts/module_capabilities").Modem[];
	uplinksFile?: string;
	defaultRouteInterface?: string | null;
	defaultRouteSourceIp?: string | null;
	monitor?: { running: boolean };
}

/**
 * Capability note: the `network.uplinks` contract is the `Uplinks` type
 * (shared/contracts/module_capabilities.ts, re-exported above) — the bonded
 * uplinks file plus a change hook; the consumers (relay, encoder) reload
 * their `srtla_send` (SIGHUP first, restart as fallback) when it fires.
 */
