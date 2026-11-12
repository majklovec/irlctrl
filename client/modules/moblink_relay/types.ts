/* Types for the moblink_relay module: config, runtime status, and the
 * frontend view. The transport types (VifStats, RelayStats, Endpoint) live in
 * `shared/lib/udp_relay`; only the module-specific envelopes are here. */

/** The persisted `ctx.state.moblink` config slice. */
export interface MoblinkRelayConfig {
	enabled: boolean;
	/**
	 * The LAN IP this relay advertises to encoders in its discovery announce.
	 * Empty = auto-detect (the first bound relay address). A manual value wins
	 * over the auto-detected one. Always shown (filled) in the UI.
	 */
	announceHost: string;
	/**
	 * The seed for the UDP port allocator (protocol.md §1). The FIRST relay
	 * gets this port; subsequent new interfaces take the high-water mark
	 * (highest assigned port + 1) — NEVER base+index, so adding/removing
	 * interfaces never reindexes the existing ones.
	 */
	listenPortBase: number;
	/**
	 * The persisted interface → UDP port mapping (protocol.md §1). A mapping
	 * always wins over the allocator; a downed interface keeps its mapping; a
	 * removed interface frees its slot. Written by the module, not edited in
	 * the UI.
	 */
	portMap: Record<string, number>;
	/** Regexes; empty = all interfaces. An interface matches if it matches ANY. */
	interfaceAllow: string[];
	/** Regexes; an interface is skipped if it matches ANY. */
	interfaceIgnore: string[];
	/** Map interface name → display name in the status / UI. */
	interfaceNameOverrides: Record<string, string>;
	/** Where the runtime status JSON is written on every state change. */
	runtimeStatusFile: string;
	logLevel: "trace" | "debug" | "info" | "warn" | "error";
}

/** An eligible interface a relay will run on — what the encoder connects to. */
export interface MoblinkAvailableInterface {
	/** The interface name (e.g. `eth0`). */
	name: string;
	/** The interface's IPv4 address — the relay bind address. */
	address: string;
	/** The UDP port this relay listens on (the persisted high-water-mark
	 * mapping, protocol.md §1). */
	listenPort: number;
	/** `up` = a relay is running on it; `down` = path lost/failed (the port
	 * mapping is KEPT, protocol.md §1). */
	state: "up" | "down";
}

/** One relay entry in the runtime status (§9.1, relay-box side). */
export interface MoblinkRelayStatusEntry {
	interfaceName: string;
	interfaceAddress: string;
	stats: {
		encRxPackets: number;
		encTxPackets: number;
		lastEncoderSeen?: number;
	};
}

/** An interface that currently has NO running relay (e.g. its port is busy). */
export interface MoblinkRelayFailure {
	interfaceName: string;
	reason: string;
}

/** The runtime status object (the status file and the `status` RPC). */
export interface MoblinkRuntimeStatus {
	connected: boolean;
	/**
	 * The LAN IP this relay is currently advertising to encoders (the manual
	 * override if set, else the auto-detected address). Prefills the card's
	 * "advertise IP" field.
	 */
	announceHost: string;
	/** Interfaces a relay will run on — the endpoints encoders connect to. */
	availableInterfaces: MoblinkAvailableInterface[];
	relays: MoblinkRelayStatusEntry[];
	/** Interfaces that failed to start (e.g. port in use) — shown on the card. */
	failures: MoblinkRelayFailure[];
	/**
	 * Interfaces that got a port mapping but currently have no live relay
	 * (no IP, carrier down, or a failed bind). Their mapping is kept
	 * (protocol.md §1) — they appear in `availableInterfaces` with
	 * `state: "down"`.
	 */
	downInterfaces: string[];
}

/** The status fragment the module contributes under `state.moblink`. */
export type MoblinkRelayState = MoblinkRuntimeStatus;

/** The settings-page view of the module's config slice. */
export interface MoblinkRelayView {
	enabled: boolean;
	announceHost: string;
	listenPortBase: number;
	portMap: Record<string, number>;
	interfaceAllow: string[];
	interfaceIgnore: string[];
	interfaceNameOverrides: Record<string, string>;
	logLevel: string;
}
