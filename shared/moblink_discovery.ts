/*
 * MobLink relay discovery protocol (spec 100-moblink §5, extension to the v1
 * single-relay module). The `moblink_relay` device PUSHES its shared tunnel
 * interfaces to every encoder on the LAN by broadcasting a small JSON
 * `MoblinkAnnounce` over UDP to the limited-broadcast address on a fixed
 * well-known port. The `moblink_streamer` (encoder) listens on that port,
 * keeps a TTL'd registry of the relays it hears, and opens one TUN per shared
 * interface (spec §6.3 multi-relay extension). Works with no control server.
 *
 * The port and the announce body are shared here so the relay (sender) and the
 * streamer (receiver) can never drift apart.
 */

/** Fixed UDP port encoders listen on / relays broadcast to. */
export const MOBLINK_DISCOVERY_PORT = 10_333;

/** Relay re-broadcast interval — frequent enough that a relay appearing/moving
 * converges quickly; cheap enough to send every few seconds. */
export const MOBLINK_ANNOUNCE_INTERVAL_MS = 5_000;

/** Drop a registered relay not re-announced within this window (~3× interval). */
export const MOBLINK_ANNOUNCE_TTL_MS = 15_000;

/** Limited-broadcast destination for the announce datagrams. */
export const MOBLINK_BROADCAST_ADDR = "255.255.255.255";

/** One tunnel interface the relay offers to encoders. */
export interface MoblinkSharedEndpoint {
    /** The relay-side TUN name (e.g. `moblink0`). */
    name: string;
    /** The relay's advertise IP (relayHost) the encoder dials for this tunnel
     * (the advertise IP override if set, else the auto-detected LAN address) —
     * not necessarily the IP of the interface the relay binds to. */
    address: string;
    /** The UDP relay port for this interface. */
    listenPort: number;
}

/** The discoverable payload a relay broadcasts. */
export interface MoblinkAnnounce {
    /** Protocol version — receivers ignore unknown versions. */
    v: 1;
    /** The relay's primary LAN address (stable identity + dial host). */
    host: string;
    /** The relay's hostname, for display. */
    hostname?: string;
    /** The shared tunnel interfaces this relay offers. */
    interfaces: MoblinkSharedEndpoint[];
    /** Epoch ms the relay sent this. */
    ts: number;
}

/** A relay entry in the encoder's registry (an announce we've seen, TTL'd). */
export interface MoblinkDiscoveredRelay {
    /** The relay address — registry key. */
    host: string;
    hostname?: string;
    interfaces: MoblinkSharedEndpoint[];
    /** Epoch ms we last heard from this relay. */
    lastSeen: number;
}

/**
 * Type-guard for an announce parsed out of a UDP datagram. Filters out random
 * traffic on the discovery port (anything that isn't our `{v:1, host,
 * interfaces: [...]}` shape).
 */
export function isMoblinkAnnounce(x: unknown): x is MoblinkAnnounce {
    if (!x || typeof x !== "object") return false;
    const o = x as Record<string, unknown>;
    if (o.v !== 1) return false;
    if (typeof o.host !== "string" || o.host.length === 0) return false;
    if (!Array.isArray(o.interfaces)) return false;
    return (o.interfaces as unknown[]).every((e) => {
        if (!e || typeof e !== "object") return false;
        const ep = e as Record<string, unknown>;
        return (
            typeof ep.name === "string" &&
            typeof ep.address === "string" &&
            typeof ep.listenPort === "number"
        );
    });
}
