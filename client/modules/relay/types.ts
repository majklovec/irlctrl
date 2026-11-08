/* Types for the relay's SRTLA bridge. The interface/modem domain types live
 * in the network and modems modules. */
import type { DeviceSummary, Status } from "../../../shared/contracts/wire";

/**
 * The SRTLA target the relay bridges to. `listenPort` is the SRTLA UDP input
 * port `srtla_rec` binds (the encoder → relay hop); the destination is what
 * `srtla_send` sends to. The loopback SRT port between the two is a fixed
 * internal detail (`SRT_INTERNAL_PORT`), not part of the target.
 */
export interface SrtlaTarget {
    listenPort: string;
    remoteHost: string;
    remotePort: string;
}

export interface SrtlaState {
    running: boolean;
    pid?: number;
    /** SRTLA UDP input port (`srtla_rec`), or the local SRT port on the encoder. */
    listenPort?: string;
    /** The plain-SRT port `srtla_send` listens on (loopback internal port on the relay). */
    sendPort?: string;
    remoteHost?: string;
    remotePort?: string;
    startedAt?: number;
    lastReloadAt?: number;
    reloadCount?: number;
}

export type SrtlaMode = "classic" | "enhanced";
export const SRTLA_MODES: readonly SrtlaMode[] = ["classic", "enhanced"];

/** Scheduler options (`state.relayOptions`, the `relay.options` params). */
export interface SrtlaOptions {
    mode?: SrtlaMode;
    quality?: boolean;
}

export interface SrtlaOptionsResult {
    options: SrtlaOptions;
    applied: boolean;
}

/** The control socket (`srtlaControl` status fragment). */
export interface SrtlaControlState {
    supported: boolean;
    connected: boolean;
}

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
    cc_state?: string;
    cc_target_bps?: number;
    quality_multiplier?: number;
    base_score?: number;
    weak?: boolean;
    weak_reason?: string;
    stall_gated?: boolean;
    sole_carrier?: boolean;
}

export interface SrtlaStats {
    mode?: SrtlaMode;
    quality_enabled?: boolean;
    active_links: number;
    total_links: number;
    total_in_flight: number;
    total_window: number;
    negotiated_latency_ms?: number;
    links: SrtlaLinkStats[];
}

/** The `relay.stats` push. */
export interface SrtlaStatsEvent {
    at: number;
    stats: SrtlaStats | null;
}

/** The status envelope exposed by the relay module (the network and modems
 * modules contribute the interfaces / modems / monitor fragments themselves). */
export type RelayStatus = Status & {
    state: {
        relay: SrtlaState;
        relayTarget?: SrtlaTarget;
        relayOptions: SrtlaOptions;
        srtlaMonitor?: { reloadMode: string };
        stream?: SrtlaTarget;
    };
    srtlaControl: SrtlaControlState;
};

/** The device-list row with the relay module's summary fields (status `summary` + live stats patches). */
export type RelayDeviceSummary = DeviceSummary & {
    relay?: SrtlaState;
    /** Live srtla_send total, bytes/s across all links. */
    bitrate?: number;
    activeLinks?: number;
    totalLinks?: number;
};

/** The persisted `relay` config section: receiver target plus scheduler options. */
export interface RelayConfig {
    listenPort: string;
    mode: SrtlaMode;
    quality: boolean;
    remoteHost: string;
    remotePort: string;
}
