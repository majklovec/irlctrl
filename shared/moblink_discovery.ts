/*
 * MobLink discovery + control-channel protocol (spec 100-moblink §5 and
 * TODO/protocol.md). Two complementary discovery paths, both without a
 * control server:
 *
 * 1. Relay announce (relay → encoder, v1): the `moblink_relay` device PUSHES
 *    its shared tunnel interfaces to every encoder on the LAN by broadcasting
 *    a small JSON `MoblinkAnnounce` over UDP to the limited-broadcast address
 *    on a fixed well-known port. The `moblink_streamer` (encoder) listens on
 *    that port, keeps a TTL'd registry of the relays it hears, and opens one
 *    TUN per shared interface (spec §6.3 multi-relay extension).
 *
 * 2. Encoder announce (encoder → relay, protocol.md §2): the encoder
 *    broadcasts a JSON `MoblinkEncoderAnnounce` on the same well-known port
 *    carrying its id, IP, WebSocket port and optional auth token. The relay
 *    listens on that port, keeps a TTL'd registry of the encoders it hears,
 *    and dials each one's WebSocket.
 *
 * 3. Relay → encoder control channel (protocol.md §3–§5): the ENCODER runs a
 *    WebSocket server; the RELAY connects to it as a client and sends its
 *    identity, protocol version and the full list of uplink interfaces with
 *    their UDP ports. Interface changes are propagated as events
 *    (`interface_added` / `interface_removed` / `interface_up` /
 *    `interface_down`); after every reconnect the relay re-sends a full
 *    snapshot. The encoder dials `interface_ip:udp_port` (protocol.md §5).
 *
 * The ports and message bodies are shared here so both sides can never drift
 * apart.
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

/**
 * Name pattern of an ENCODER-side MobLink tunnel interface (the
 * `moblink_streamer` names them `m${slot}_${relayIface}`, e.g. `m0_wg0`).
 * Pre-GRETAP these were TUNs (`relay0_wg0`, 15-char limit); after the cutover
 * the kernel device is `gretap<name>` (e.g. `gretapm0_wg0`). Both shapes are
 * tunnels to a relay's shared uplink, not the machine's own interfaces, so any
 * interface listing that means "the device's real interfaces" (the network
 * card's "Own interfaces" group, relay eligibility) must exclude them. This is
 * the single source of truth shared by the `network` backend
 * (`listNetworkInterfaces`) and the network card.
 */
export const MOBLINK_TUN_NAME_RE =
	/^(?:relay|gretapm)\d+_[a-z0-9]+$/u;

/** True when `name` is an encoder-side MobLink tunnel TUN (see the RE above). */
export const isMoblinkTun = (name: string): boolean =>
	MOBLINK_TUN_NAME_RE.test(name);

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
	/** Path state (protocol.md §4/§5): `down` = the encoder must stop using
	 * this path (the port mapping is kept on the relay); `up`/absent = usable. */
	state?: "up" | "down";
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

// ----------------------------------------------------------------------
// Encoder announce (encoder → relay, protocol.md §2)
// ----------------------------------------------------------------------

/** The encoder announce protocol version (receivers ignore unknown versions). */
export const MOBLINK_ENCODER_ANNOUNCE_VERSION = 1;

/**
 * The discoverable payload an encoder broadcasts on the discovery port so
 * relays learn its WebSocket endpoint (protocol.md §2).
 */
export interface MoblinkEncoderAnnounce {
	/** Protocol version — receivers ignore unknown versions. */
	v: typeof MOBLINK_ENCODER_ANNOUNCE_VERSION;
	/** Stable encoder identity (e.g. the hostname). */
	encoder_id: string;
	/** The encoder IP address (reachable across the LAN). */
	ip: string;
	/** The encoder's WebSocket server port. */
	ws_port: number;
	/** Protocol version (the relay sends the same in its WS hello). */
	proto: number;
	/** Optional auth token the relay must echo in the WS handshake. */
	token?: string;
	/** Epoch ms the encoder sent this. */
	ts: number;
}

/** A discovery path by which the relay learned an encoder (protocol.md
 * §2): the UDP-announce listener on the well-known port, the mDNS
 * encoder-service browser, or the control-server lookup. Not sent on the
 * wire — the relay derives it locally from which listener recorded the
 * entry. */
export type MoblinkDiscoveryMethod = "udp" | "mdns" | "control-server";

/** An encoder entry in the relay's TTL'd registry (an announce we've seen). */
export interface MoblinkDiscoveredEncoder {
	encoderId: string;
	ip: string;
	wsPort: number;
	proto: number;
	token?: string;
	/** Last observation per discovery path (epoch ms). The card renders a
	 * per-protocol "discovered … ago" line from these stamps. The WS
	 * keepalive does NOT add to this map (it only refreshes `lastSeen`),
	 * so the line stays honest about which path (re)announced the encoder
	 * and when — even when only the live channel keeps the entry alive. */
	discoveredAt: Partial<Record<MoblinkDiscoveryMethod, number>>;
	/** Epoch ms we last heard from this encoder. */
	lastSeen: number;
}

/**
 * Type-guard for an encoder announce parsed out of a UDP datagram. Filters
 * out random traffic on the discovery port (anything that is not our
 * `{v:1, encoder_id, ip, ws_port, proto}` shape). Relay announces
 * (`{v:1, host, interfaces}`) are rejected: they have no `encoder_id`.
 */
export function isMoblinkEncoderAnnounce(
	x: unknown,
): x is MoblinkEncoderAnnounce {
	if (!x || typeof x !== "object") return false;
	const o = x as Record<string, unknown>;
	if (o.v !== MOBLINK_ENCODER_ANNOUNCE_VERSION) return false;
	if (typeof o.encoder_id !== "string" || o.encoder_id.length === 0)
		return false;
	if (typeof o.ip !== "string" || o.ip.length === 0) return false;
	if (typeof o.ws_port !== "number") return false;
	if (typeof o.proto !== "number") return false;
	if (o.token !== undefined && typeof o.token !== "string") return false;
	return true;
}

// ----------------------------------------------------------------------
// Relay → encoder control channel (protocol.md §3–§5)
// ----------------------------------------------------------------------

/** The relay → encoder control-channel protocol version (the WS hello). */
export const MOBLINK_RELAY_WS_PROTOCOL = 1;

/** One relay uplink interface as the relay reports it to an encoder. */
export interface MoblinkRelayIface {
	/** Relay interface name, e.g. `eth0`. */
	iface_name: string;
	/** The IP of the relay interface the encoder should use to reach it. */
	ip: string;
	/** The UDP relay port for this interface. */
	udp_port: number;
	/** `up` = usable path; `down` = marked down (port mapping kept). */
	state: "up" | "down";
	uplink: true;
}

/** A relay → encoder control-channel message (protocol.md §3–§4). */
export type MoblinkRelayWsMessage =
	/** Relay identity + protocol version + full interface list. Sent on
	 * connect AND after every reconnect (the "full snapshot"). */
	| {
			type: "hello";
			relay_id: string;
			proto: number;
			interfaces: MoblinkRelayIface[];
	  }
	| { type: "interface_added"; iface: MoblinkRelayIface }
	| { type: "interface_removed"; iface: MoblinkRelayIface }
	| { type: "interface_up"; iface: MoblinkRelayIface }
	| { type: "interface_down"; iface: MoblinkRelayIface }
	/** WS keepalive (protocol.md §3): relay → encoder every 5 s while the
	 * channel is open; the encoder replies `pong`. Every message in both
	 * directions refreshes the peer's discovery-registry TTL, so a live
	 * channel is self-sustaining and discovery is only needed for the
	 * initial dial. */
	| { type: "ping" }
	| { type: "pong" };

/** The event types that apply to a single interface (no hello/keepalive). */
export type MoblinkRelayIfaceEventType = Exclude<
	MoblinkRelayWsMessage["type"],
	"hello" | "ping" | "pong"
>;

/** Type-guard for a parsed relay → encoder control-channel message. */
export function isMoblinkRelayWsMessage(
	x: unknown,
): x is MoblinkRelayWsMessage {
	if (!x || typeof x !== "object") return false;
	const o = x as Record<string, unknown>;
	const okIface = (i: unknown): boolean => {
		if (!i || typeof i !== "object") return false;
		const f = i as Record<string, unknown>;
		return (
			typeof f.iface_name === "string" &&
			f.iface_name.length > 0 &&
			typeof f.ip === "string" &&
			typeof f.udp_port === "number" &&
			(f.state === "up" || f.state === "down") &&
			f.uplink === true
		);
	};
	switch (o.type) {
		case "hello":
			return (
				typeof o.relay_id === "string" &&
				o.relay_id.length > 0 &&
				typeof o.proto === "number" &&
				Array.isArray(o.interfaces) &&
				(o.interfaces as unknown[]).every(okIface)
			);
		case "interface_added":
		case "interface_removed":
		case "interface_up":
		case "interface_down":
			return okIface(o.iface);
		case "ping":
		case "pong":
			return true;
		default:
			return false;
	}
}
