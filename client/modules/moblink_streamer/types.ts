/** MobLink encoder-side (streamer) module types. Spec doc: TODO/100-moblink.md
 * §6, extended for the multi-relay / one-TUN-per-interface design (§6.3
 * extension).
 */
import type { MoblinkDiscoveredRelay } from "../../../shared/moblink_discovery";

/** The module's persisted config (`state.data.moblinkStreamer`). The module
 * runs permanently on encoders (no `enabled` toggle). */
export interface MoblinkStreamerConfig {
	/**
	 * Each TUN `relay{X}link{Y}` gets the local IP `10.{90+X}.{Y}.1` — derived
	 * from the relay ordinal X and the interface ordinal Y within that relay,
	 * so it is never a hand-typed base address.
	 */
	prefixLength: number;
	mtu: number;
	keepaliveIntervalMs: number;
	/** Register each TUN IP as a network uplink so srtla_send picks it up. */
	autoRegisterUplink: boolean;
	runtimeStatusFile: string;
	logLevel: MoblinkLogLevel;
	/**
	 * The encoder's WebSocket SERVER port (protocol.md §3: the encoder is the
	 * WS server, the relay dials in). Advertised to relays in the encoder
	 * announce as `ws_port`.
	 */
	wsPort: number;
	/**
	 * Optional auth token the relay must echo in the WS handshake
	 * (`?token=...`). Empty = open (LAN-internal; the relay learns it from
	 * the encoder announce).
	 */
	announceToken: string;
}

export type MoblinkLogLevel = "trace" | "debug" | "info" | "warn" | "error";

/** One TUN (one shared relay interface) in the runtime status. */
export interface MoblinkStreamerTunnelStatus {
	interfaceName: string;
	interfaceAddress: string;
	relayHost: string;
	relayPort: number;
	uplinkRegistered: boolean;
	stats: { txPackets: number; rxPackets: number };
	lastError?: string;
}

/** One relay entry in the runtime status file (§9.1). */
export type MoblinkStreamerRelayStatus = MoblinkStreamerTunnelStatus;

/** The runtime status file's shape (output only, never a config store). */
export interface MoblinkStreamerStatusFile {
	connected: boolean;
	relays: MoblinkStreamerRelayStatus[];
}

/** Live status pushed to the card + returned by `moblink_streamer.status`. */
export interface MoblinkStreamerRuntimeStatus {
	state: "idle" | "starting" | "running" | "error";
	running: boolean;
	/** The active TUNs (one per registered shared relay interface). */
	tunnels: MoblinkStreamerTunnelStatus[];
	txPackets: number;
	rxPackets: number;
	txBytes: number;
	rxBytes: number;
	lastError?: string;
	/** How recently this encoder announced ITSELF so relays keep finding it
	 * (epoch ms; `undefined` when that path isn't running). Shown on the
	 * Network card, mirroring the relay card's self-announce line. */
	lastMdnsAnnounceAt?: number;
	lastUdpAnnounceAt?: number;
}

/** The device `status` view contribution for `modules["moblink_streamer"]`. */
export interface MoblinkStreamerView {
	running: boolean;
	state: MoblinkStreamerRuntimeStatus["state"];
	config: MoblinkStreamerConfig;
	runtime: MoblinkStreamerRuntimeStatus;
	/** Relays learned via UDP announce (their shared interfaces). */
	discoveredRelays: MoblinkDiscoveredRelay[];
}
