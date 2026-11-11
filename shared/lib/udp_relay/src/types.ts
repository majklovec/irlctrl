/* Shared types for @irlctrl/udp-relay.
 *
 * The library is a transport primitive: it moves UDP payloads between a TUN on
 * one host and a bound UDP socket on another. It knows nothing about SRTLA,
 * Moblink, auth, discovery, or configuration.
 */

/** A network endpoint: a host (IP or resolvable name) and a UDP port. */
export interface Endpoint {
    host: string;
    port: number;
}

/** Stats of a virtual interface (encoder side). */
export interface VifStats {
    /** Packets forwarded out of the TUN toward the relay. */
    txPackets: number;
    txBytes: number;
    /** Packets written into the TUN from relay replies. */
    rxPackets: number;
    rxBytes: number;
    /** Packets dropped on the way out (non-IPv4, oversized, not running). */
    txDropped: number;
    /** Packets dropped on the way in (wrong source, malformed). */
    rxDropped: number;
    lastError?: { at: number; message: string };
    startedAt?: number;
}

/** Stats of a transparent L3 relay (relay-box side). */
export interface RelayStats {
    /** IP packets received from the encoder (over the wire-protocol UDP socket). */
    encRxPackets: number;
    encRxBytes: number;
    /** IP packets forwarded out the bound physical interface. */
    ifaceTxPackets: number;
    ifaceTxBytes: number;
    /** IP packets received from the bound physical interface. */
    ifaceRxPackets: number;
    ifaceRxBytes: number;
    /** IP packets sent back toward the encoder (addressed to the vif IP). */
    encTxPackets: number;
    encTxBytes: number;
    /** Packets dropped (malformed frame, not addressed to the vif, oversized). */
    drops: number;
    lastError?: { at: number; message: string };
    /** Last time a frame from the encoder was seen (epoch ms). */
    lastEncoderSeen?: number;
    startedAt?: number;
}

/** A network interface and its IPv4 addresses (for tests / diagnostics). */
export interface InterfaceInfo {
    name: string;
    addresses: string[];
}
