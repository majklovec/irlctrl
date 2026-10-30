/* Types owned by the combined SRTLA, interface-routing and modem domain. */
import type { DeviceSummary, Status } from "../../shared/types";

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

export interface ModemConfig {
    modems?: string[];
    ips?: string[];
}

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

export interface ReconfigureResult {
    ok: boolean;
    selected: Iface[];
    uplinksFile: string;
    ips: string[];
    changed: boolean;
    error?: string;
}

export interface ModemSource {
    detect(): Promise<ModemInfo[]>;
    modemIface(modem: ModemInfo): Promise<string | null>;
}

export interface SrtlaTarget {
    listenPort: string;
    remoteHost: string;
    remotePort: string;
}

export interface SrtlaState {
    running: boolean;
    pid?: number;
    listenPort?: string;
    remoteHost?: string;
    remotePort?: string;
    startedAt?: number;
    lastReloadAt?: number;
    reloadCount?: number;
}

export type SrtlaMode = "classic" | "enhanced";
export const SRTLA_MODES: readonly SrtlaMode[] = ["classic", "enhanced"];

/** Scheduler options (`state.srtlaOptions`, the `srtla.setOption` params). */
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

/** The `srtla.stats` push. */
export interface SrtlaStatsEvent {
    at: number;
    stats: SrtlaStats | null;
}

/** The status envelope exposed by the SRTLA module. */
export type SrtlaStatus = Status & {
    state: {
        srtla: SrtlaState;
        srtlaTarget?: SrtlaTarget;
        srtlaOptions: SrtlaOptions;
        selection: ModemConfig;
        stream?: SrtlaTarget;
    };
    interfaces: Iface[];
    selected: Iface[];
    modems: ModemInfo[];
    uplinksFile: string;
    srtlaControl: SrtlaControlState;
    monitor: { running: boolean; reloadMode: string };
};

/** The device-list row with the srtla module's summary fields (status `summary` + live stats patches). */
export type SrtlaDeviceSummary = DeviceSummary & {
    srtla?: SrtlaState;
    /** Live srtla_send total, bytes/s across all links. */
    bitrate?: number;
    activeLinks?: number;
    totalLinks?: number;
};

/** The persisted `srtla` config section: receiver target plus scheduler options. */
export interface SrtlaConfig {
    listenPort: string;
    mode: SrtlaMode;
    quality: boolean;
    remoteHost: string;
    remotePort: string;
    selection?: ModemConfig;
}
