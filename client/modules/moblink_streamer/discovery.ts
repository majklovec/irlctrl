/*
 * MobLink encoder-side discovery (receiver). Binds
 * `0.0.0.0:MOBLINK_DISCOVERY_PORT` (reuseAddr so several listeners can
 * coexist), parses `MoblinkAnnounce` datagrams from any relay on the LAN, and
 * maintains a TTL'd registry of the relays we hear. `onChange` fires when the
 * registry's shape changes (a relay appears, disappears, or its interface list
 * changes) so the streamer backend can reconcile its per-interface TUNs (spec
 * 100-moblink §5, §6.3).
 *
 * Uses `node:dgram` for a stable API across Bun versions. Independent of the
 * control server: this is pure LAN UDP.
 */
import dgram from "node:dgram";
import {
	isMoblinkAnnounce,
	MOBLINK_ANNOUNCE_INTERVAL_MS,
	MOBLINK_ANNOUNCE_TTL_MS,
	MOBLINK_BROADCAST_ADDR,
	MOBLINK_DISCOVERY_PORT,
	MOBLINK_ENCODER_ANNOUNCE_VERSION,
	type MoblinkDiscoveredRelay,
	type MoblinkEncoderAnnounce,
} from "../../../shared/moblink_discovery";

let socket: dgram.Socket | undefined;
let sweeper: ReturnType<typeof setInterval> | undefined;
/** Keyed by the relay's STABLE identity (see `relayKey`), not by the
 * announced IP — the same relay must occupy exactly one entry no matter
 * which discovery path learned it (UDP / mDNS / WS / control server) or
 * which (override) IP it announced under. */
let relays = new Map<string, MoblinkDiscoveredRelay>();
let lastSig = "";
/** Keys already announced in the "registered relay" log (once per relay). */
let loggedKeys = new Set<string>();
let onChange: ((relays: MoblinkDiscoveredRelay[]) => void) | undefined;

/**
 * The registry key for a relay: its identity (hostname, which the relay
 * carries in the WS `relay_id` and the mDNS `h=` field) when known, else
 * the announced IP. Keying by IP alone let one physical relay accumulate
 * several entries (e.g. an announced-override IP from UDP plus a WS peer
 * IP from the hello path) — each identity now maps to exactly one entry.
 */
export function relayKey(r: { host: string; hostname?: string }): string {
	return r.hostname && r.hostname.trim() !== "" ? r.hostname : r.host;
}

function signature(): string {
	const out: string[] = [];
	for (const r of [...relays.values()].sort((a, b) =>
		relayKey(a).localeCompare(relayKey(b)),
	)) {
		// `state` is part of the signature: an `interface_down` /
		// `interface_up` with no other shape change must still fire the
		// change callback (protocol.md §4–§5) so reconcile stops/starts the
		// TUN.
		out.push(
			`${relayKey(r)}|${r.interfaces
				.map((i) => `${i.name}:${i.address}:${i.listenPort}:${i.state ?? "up"}`)
				.join(",")}`,
		);
	}
	return out.join(";");
}

/** Compact one-line summary of a relay's shared interfaces (debug logs). */
function endpointSummary(eps: MoblinkDiscoveredRelay["interfaces"]): string {
	return eps.map((e) => `${e.name}=${e.address}:${e.listenPort}`).join(", ");
}

/** Fire `onChange` only when the registry shape changed since the last emit. */
function emitIfChanged(): void {
	const sig = signature();
	if (sig !== lastSig) {
		lastSig = sig;
		console.log(
			`moblink_streamer: discovered relays: ${relays.size} ${[
				...relays.values(),
			]
				.map((r) => `${r.host} [${endpointSummary(r.interfaces)}]`)
				.join(" | ")}`,
		);
		try {
			onChange?.([...relays.values()]);
		} catch {
			/* a consumer error must not kill the listener */
		}
	}
}

/**
 * Start listening for relay announces; `onChange(relays)` fires on every
 * shape change. Returns the current (known) relays.
 */
export function startDiscovering(
	onChangeCb: (relays: MoblinkDiscoveredRelay[]) => void,
	opts: {
		dryRun?: boolean;
		/** Registry hosts protected from the TTL sweep (relays with a live
		 * WS channel — the channel keeps itself fresh via keepalive). */
		protectedHosts?: () => Set<string>;
	} = {},
): MoblinkDiscoveredRelay[] {
	stopDiscovering();
	onChange = onChangeCb;
	if (opts.dryRun) {
		console.log("moblink_streamer: discovery listen skipped (dry-run)");
		return [...relays.values()];
	}
	try {
		const s = dgram.createSocket({ type: "udp4", reuseAddr: true });
		s.on("error", (e) =>
			console.warn(`moblink_streamer: discovery socket error: ${e.message}`),
		);
		s.on("message", (msg: Buffer): void => {
			let parsed: unknown;
			try {
				parsed = JSON.parse(msg.toString());
			} catch {
				return; // not JSON — ignore
			}
			if (!isMoblinkAnnounce(parsed)) return;
			registerRelay(
				{
					host: parsed.host,
					hostname: parsed.hostname,
					interfaces: parsed.interfaces,
					lastSeen: Date.now(),
				},
				"broadcast",
			);
		});
		s.bind(MOBLINK_DISCOVERY_PORT, "0.0.0.0");
		socket = s;
		console.log(
			`moblink_streamer: discovery listen started on 0.0.0.0:${MOBLINK_DISCOVERY_PORT}`,
		);
	} catch (e) {
		console.warn(`moblink_streamer: discovery listen failed: ${String(e)}`);
	}
	// Periodic TTL sweep: drop relays we stopped hearing (relays with a live
	// WS are protected — a connected relay must not be reaped on UDP silence).
	const sweep = setInterval(
		() => sweepStaleRelays(opts.protectedHosts),
		MOBLINK_ANNOUNCE_TTL_MS / 3,
	);
	// Don't keep the process alive solely for discovery.
	sweep.unref?.();
	sweeper = sweep;
	return [...relays.values()];
}

/**
 * The single entry point for the registry. Keyed by the relay's stable
 * identity (hostname, else IP — see `relayKey`), so the same physical relay
 * always occupies EXACTLY ONE entry no matter which path learned it (UDP
 * broadcast, mDNS, WS hello, control server). Before inserting, any stale
 * duplicate key for the same relay (learned earlier under a different key)
 * is merged away. Logs once per relay, not on every refresh.
 */
function registerRelay(relay: MoblinkDiscoveredRelay): void {
	const key = relayKey(relay);
	// Merge away a duplicate key for the SAME relay: an entry that shares the
	// identity (hostname) or that is the old IP-keyed entry for this very IP.
	for (const [k, e] of relays) {
		if (k === key) continue;
		const sameIdentity =
			(relay.hostname && e.hostname === relay.hostname) ||
			(!e.hostname && k === relay.host);
		if (sameIdentity) {
			relays.delete(k);
			loggedKeys.delete(k);
		}
	}
	// Honor a caller-supplied lastSeen (production callers stamp `now`); this
	// also lets tests backdate an entry to exercise the TTL sweep.
	relays.set(key, { ...relay, lastSeen: relay.lastSeen ?? Date.now() });
	if (!loggedKeys.has(key)) {
		loggedKeys.add(key);
		console.log(
			`moblink_streamer: registered relay ${relay.host}${relay.hostname ? ` (${relay.hostname})` : ""} ifaces=[${endpointSummary(relay.interfaces)}]`,
		);
	}
	emitIfChanged();
}

/**
 * Drop every relay not (re)announced within TTL, EXCEPT relays protected in
 * `protectedHosts` (relays with a live WebSocket — the channel keeps itself
 * fresh via keepalive, so UDP silence must not reap a connected relay). A
 * relay is protected when its key OR its dial host is in the set. Returns
 * the swept keys.
 */
export function sweepStaleRelays(protectedHosts?: () => Set<string>): string[] {
	const now = Date.now();
	const protectedNow = protectedHosts?.() ?? new Set<string>();
	const swept: string[] = [];
	for (const [key, r] of relays) {
		const protectedEntry = protectedNow.has(key) || protectedNow.has(r.host);
		if (now - r.lastSeen > MOBLINK_ANNOUNCE_TTL_MS && !protectedEntry) {
			relays.delete(key);
			loggedKeys.delete(key);
			swept.push(key);
		}
	}
	if (swept.length > 0) {
		console.log(`moblink_streamer: swept stale relay(s): ${swept.join(", ")}`);
		emitIfChanged();
	}
	return swept;
}

/**
 * Register a relay as if its announce had just been received. This is the
 * WS `hello` / control-server registration path (a relay can hand the
 * encoder its IP through the control plane instead of UDP) and is also what
 * tests use to seed a discovered relay. Fires the change callback on a
 * shape change; logs once per relay (subsequent refreshes are silent).
 */
export function noteRelay(relay: MoblinkDiscoveredRelay): void {
	registerRelay(relay);
}

/** True for a plain dotted-quad IPv4 literal (no hostname resolution). */
export function isIpv4Literal(x: string): boolean {
	return /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(x);
}

/** A registry entry keyed by (or hosted at) `keyOrHost`, if known. */
export function getKnownRelay(
	keyOrHost: string,
): MoblinkDiscoveredRelay | null {
	return (
		relays.get(keyOrHost) ??
		[...relays.values()].find(
			(r) => r.host === keyOrHost || r.hostname === keyOrHost,
		) ??
		null
	);
}

/** Drop a registry entry matched by key, host, or hostname. Fires the
 * change callback when the shape changed. */
export function forgetRelay(keyOrHost: string): void {
	const direct = relays.get(keyOrHost);
	if (direct) {
		relays.delete(keyOrHost);
		loggedKeys.delete(keyOrHost);
		emitIfChanged();
		return;
	}
	const match = [...relays.entries()].find(
		([, r]) => r.host === keyOrHost || r.hostname === keyOrHost,
	);
	if (match) {
		relays.delete(match[0]);
		loggedKeys.delete(match[0]);
		emitIfChanged();
	}
}

/**
 * Register/refresh a relay learned via mDNS (protocol.md §3). The mDNS TXT
 * endpoint list is compact (255 B) and may be TRUNCATED relative to the full
 * WS `hello` snapshot, so the endpoint set only ever grows: a shorter mDNS
 * list never shrinks a known relay's endpoint set (the full list comes back
 * with the next hello).
 */
export function noteMdnsRelay(
	host: string,
	hostname: string | undefined,
	endpoints: MoblinkSharedEndpoint[],
): void {
	const known = getKnownRelay(hostname ?? host) ?? getKnownRelay(host);
	const interfaces =
		endpoints.length > (known?.interfaces.length ?? 0)
			? endpoints
			: (known?.interfaces ?? endpoints);
	registerRelay({
		host,
		hostname: hostname ?? known?.hostname,
		interfaces,
		lastSeen: Date.now(),
	});
}

/** The currently-known relays (empty when none heard). */
export function knownRelays(): MoblinkDiscoveredRelay[] {
	return [...relays.values()];
}

// ----------------------------------------------------------------------
// Encoder announce (encoder → relay, protocol.md §2)
// ----------------------------------------------------------------------
/** The encoder's discoverable endpoint (its WS server + optional token). */
export interface EncoderInfo {
	/** Stable encoder identity (e.g. the hostname). */
	encoderId: string;
	/** The encoder LAN IP (reachable across the LAN). */
	ip: string;
	/** The encoder's WebSocket server port. */
	wsPort: number;
	/** The relay → encoder control-channel protocol version we serve. */
	proto: number;
	/** Optional auth token the relay must echo in the WS handshake. */
	token?: string;
}

let announceSocket: dgram.Socket | undefined;
let announceTimer: ReturnType<typeof setInterval> | undefined;
/** Epoch ms of the encoder's last UDP self-announce (so relays find it).
 * `undefined` until the first send; cleared on stop. Surfaced on the card. */
let encoderUdpAnnounceAt: number | undefined;

/** The encoder's last UDP self-announce timestamp, if any. */
export function lastEncoderUdpAnnounceAt(): number | undefined {
	return encoderUdpAnnounceAt;
}

/**
 * Broadcast `MoblinkEncoderAnnounce` datagrams on the well-known discovery
 * port so relays learn this encoder's WebSocket endpoint (protocol.md
 * §2.1). `buildInfo` is called every tick so the announce always reflects
 * the live config (a wsPort change is picked up without a restart).
 *
 * The limited broadcast (255.255.255.255) reaches relays we don't know yet,
 * but the kernel refuses it (EACCES) when the process lacks CAP_NET_ADMIN
 * (typical unprivileged container). Every tick we therefore ALSO unicast the
 * same payload to the registry endpoints of the relays we already know —
 * the relay's encoder-discovery listener binds 0.0.0.0 on the discovery
 * port, so unicast converges just as well.
 */
export function startEncoderAnnouncing(
	buildInfo: () => EncoderInfo | null,
	opts: { dryRun?: boolean } = {},
): void {
	stopEncoderAnnouncing();
	if (opts.dryRun) {
		console.log("moblink_streamer: encoder announce skipped (dry-run)");
		return;
	}
	try {
		const s = dgram.createSocket({ type: "udp4", reuseAddr: true });
		s.on("error", (e) =>
			console.warn(`moblink_streamer: announce socket error: ${e.message}`),
		);
		// Warn only once when the kernel denies the limited broadcast
		// (EACCES — no CAP_NET_ADMIN); the per-tick unicast fallback below
		// keeps discovery working, so the rest is noise.
		let broadcastDenied = false;
		// Per-target throttle: a permanently-unreachable relay IP must not
		// spam the log on every announce tick.
		const lastUnicastWarn = new Map<string, number>();
		const send = (): void => {
			const info = buildInfo();
			if (!info) return;
			const announce: MoblinkEncoderAnnounce = {
				v: MOBLINK_ENCODER_ANNOUNCE_VERSION,
				encoder_id: info.encoderId,
				ip: info.ip,
				ws_port: info.wsPort,
				proto: info.proto,
				token: info.token && info.token !== "" ? info.token : undefined,
				ts: Date.now(),
			};
			const payload = JSON.stringify(announce);
			encoderUdpAnnounceAt = Date.now();
			try {
				s.send(payload, MOBLINK_DISCOVERY_PORT, MOBLINK_BROADCAST_ADDR, (e) => {
					if (e && !broadcastDenied) {
						broadcastDenied = true;
						console.warn(
							`moblink_streamer: encoder announce broadcast denied (${e.code ?? e.message}); unicasting to known relays instead`,
						);
					}
				});
			} catch (e) {
				console.warn(`moblink_streamer: encoder announce failed: ${String(e)}`);
			}
			// Unicast to every known relay (host + each registry interface)
			// so relays learn this encoder even when the limited broadcast
			// is refused. Only routable IPv4 literals — a registry host may be
			// a hostname (WS hello carries `relay_id` = hostname), and dgram
			// would try to resolve it (ENOTFOUND).
			const targets = new Set<string>();
			for (const r of knownRelays()) {
				if (isIpv4Literal(r.host)) targets.add(r.host);
				for (const ep of r.interfaces)
					if (isIpv4Literal(ep.address)) targets.add(ep.address);
			}
			targets.delete(info.ip); // our own address — no relay lives there
			for (const ip of targets) {
				s.send(payload, MOBLINK_DISCOVERY_PORT, ip, (e) => {
					if (e && Date.now() - (lastUnicastWarn.get(ip) ?? 0) > 60_000) {
						lastUnicastWarn.set(ip, Date.now());
						console.warn(
							`moblink_streamer: encoder announce to ${ip} failed: ${e.message}`,
						);
					}
				});
			}
		};
		try {
			s.setBroadcast(true);
		} catch {
			/* best-effort — unicast relays on the same host still work */
		}
		s.bind(0, () => {
			console.log(
				`moblink_streamer: encoder announce started → ${MOBLINK_BROADCAST_ADDR}:${MOBLINK_DISCOVERY_PORT} every ${MOBLINK_ANNOUNCE_INTERVAL_MS}ms`,
			);
			send();
			announceTimer = setInterval(send, MOBLINK_ANNOUNCE_INTERVAL_MS);
			announceTimer.unref?.();
		});
		announceSocket = s;
	} catch (e) {
		console.warn(
			`moblink_streamer: encoder announce failed to start: ${String(e)}`,
		);
		stopEncoderAnnouncing();
	}
}

/** Stop encoding announcements; best-effort (never throws). */
export function stopEncoderAnnouncing(): void {
	if (announceTimer) {
		clearInterval(announceTimer);
		announceTimer = undefined;
	}
	encoderUdpAnnounceAt = undefined;
	const s = announceSocket;
	announceSocket = undefined;
	if (s) {
		try {
			s.close();
		} catch {
			/* already closed */
		}
	}
}

/**
 * Stop listening and clear the learned-relay registry. Discovered relays are
 * transient LAN state — they are re-learned from the next announce on start
 * — so clearing here gives a clean slate (and clean per-run state).
 */
export function stopDiscovering(): void {
	const had = sweeper !== undefined || socket !== undefined;
	const known = relays.size;
	if (sweeper) {
		clearInterval(sweeper);
		sweeper = undefined;
	}
	const s = socket;
	socket = undefined;
	if (had)
		console.log(
			`moblink_streamer: discovery listen stopped (dropped ${known} known relay(s))`,
		);
	if (s) {
		try {
			s.close();
		} catch {
			/* already closed */
		}
	}
	relays = new Map();
	loggedKeys = new Set();
	lastSig = "";
}
