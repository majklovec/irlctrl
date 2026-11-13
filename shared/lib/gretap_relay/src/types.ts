/* Shared types for @irlctrl/gretap-relay.
 *
 * The library is a transport primitive: it brings up a kernel GRETAP tunnel
 * (L2 over GRE, IP protocol 47) and bridges the tunnel device into the local
 * LAN. It knows nothing about SRTLA, Moblink, auth, discovery, or
 * configuration.
 */

/**
 * Tunnel statistics. Counter values are read from the tunneled interface's
 * kernel statistics; `drops` is the kernel's dropped-packets counter plus any
 * local drops the library notes.
 */
export interface Stats {
    rxBytes: number;
    rxPackets: number;
    txBytes: number;
    txPackets: number;
    drops: number;
}

/** A network endpoint: a host (IP or resolvable name) and a UDP port. */
export interface Endpoint {
    host: string;
    port: number;
}

/**
 * Stats of a virtual interface (both tunnel sides). The counters are the
 * kernel's GRETAP interface counters, so they count L2 frames — not the
 * userspace-packet counters of the legacy UDP transport.
 */
export interface VifStats {
    txPackets: number;
    txBytes: number;
    rxPackets: number;
    rxBytes: number;
    txDropped: number;
    rxDropped: number;
    drops: number;
    lastError?: { at: number; message: string };
    startedAt?: number;
}

/**
 * Stats of the relay-box side. Under GRETAP the box has no userspace relay
 * loop; the legacy per-plane counters stay zero and the tunneled traffic shows
 * on the `VifStats`-shaped counters below.
 */
export interface RelayStats {
    encRxPackets: number;
    encRxBytes: number;
    ifaceTxPackets: number;
    ifaceTxBytes: number;
    ifaceRxPackets: number;
    ifaceRxBytes: number;
    encTxPackets: number;
    encTxBytes: number;
    drops: number;
    /** GRETAP tunnel counters (kernel) for the box's own tunnel side. */
    rxPackets: number;
    rxBytes: number;
    txPackets: number;
    txBytes: number;
    lastError?: { at: number; message: string };
    lastEncoderSeen?: number;
    startedAt?: number;
}

/** A network interface and its IPv4 addresses (for tests / diagnostics). */
export interface InterfaceInfo {
    name: string;
    addresses: string[];
}
