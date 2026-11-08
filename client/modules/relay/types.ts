/* Types for the relay's SRTLA bridge. The SRTLA leg types (target, state,
 * options, stats, control) live in shared/srtla.ts, shared with the encoder;
 * only the status envelopes are relay-specific. The interface/modem domain
 * types live in the network and modems modules. */
import type { DeviceSummary, Status } from "../../../shared/contracts/wire";
export type {
    SrtlaConfig,
    SrtlaControlState,
    SrtlaLinkStats,
    SrtlaMode,
    SrtlaOptions,
    SrtlaOptionsResult,
    SrtlaSendLaunch,
    SrtlaState,
    SrtlaStats,
    SrtlaStatsEvent,
    SrtlaTarget,
} from "../../../shared/srtla";
export { SRTLA_MODES } from "../../../shared/srtla";
import type {
    SrtlaConfig,
    SrtlaControlState,
    SrtlaOptions,
    SrtlaState,
    SrtlaTarget,
} from "../../../shared/srtla";

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
export type RelayConfig = SrtlaConfig;
