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
let relays = new Map<string, MoblinkDiscoveredRelay>();
let lastSig = "";
let onChange: ((relays: MoblinkDiscoveredRelay[]) => void) | undefined;

function signature(): string {
	const out: string[] = [];
	for (const [host, r] of [...relays].sort((a, b) =>
		a[0].localeCompare(b[0]),
	)) {
		// `state` is part of the signature: an `interface_down` /
		// `interface_up` with no other shape change must still fire the
		// change callback (protocol.md §4–§5) so reconcile stops/starts the
		// TUN.
		out.push(
			`${host}|${r.interfaces
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
	opts: { dryRun?: boolean } = {},
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
			relays.set(parsed.host, {
				host: parsed.host,
				hostname: parsed.hostname,
				interfaces: parsed.interfaces,
				lastSeen: Date.now(),
			});
			console.log(
				`moblink_streamer: registered relay ${parsed.host}${parsed.hostname ? ` (${parsed.hostname})` : ""} ifaces=[${endpointSummary(parsed.interfaces)}]`,
			);
			emitIfChanged();
		});
		s.bind(MOBLINK_DISCOVERY_PORT, "0.0.0.0");
		socket = s;
		console.log(
			`moblink_streamer: discovery listen started on 0.0.0.0:${MOBLINK_DISCOVERY_PORT}`,
		);
	} catch (e) {
		console.warn(`moblink_streamer: discovery listen failed: ${String(e)}`);
	}
	// Periodic TTL sweep: drop relays we stopped hearing.
	const sweep = setInterval(() => {
		const now = Date.now();
		const swept: string[] = [];
		for (const [host, r] of relays) {
			if (now - r.lastSeen > MOBLINK_ANNOUNCE_TTL_MS) {
				relays.delete(host);
				swept.push(host);
			}
		}
		if (swept.length > 0) {
			console.log(
				`moblink_streamer: swept stale relay(s): ${swept.join(", ")}`,
			);
			emitIfChanged();
		}
	}, MOBLINK_ANNOUNCE_TTL_MS / 3);
	// Don't keep the process alive solely for discovery.
	sweep.unref?.();
	sweeper = sweep;
	return [...relays.values()];
}

/**
 * Register a relay as if its announce had just been received. This is the
 * control-server registration path (a relay can hand the encoder its IP
 * through the control plane instead of UDP) and is also what tests use to
 * seed a discovered relay. Fires the change callback on a shape change.
 */
export function noteRelay(relay: MoblinkDiscoveredRelay): void {
	console.log(
		`moblink_streamer: registered relay (control-server) ${relay.host}${relay.hostname ? ` (${relay.hostname})` : ""} ifaces=[${endpointSummary(relay.interfaces)}]`,
	);
	relays.set(relay.host, { ...relay, lastSeen: Date.now() });
	emitIfChanged();
}

/** A registry entry for host (if known); null otherwise. */
export function getKnownRelay(host: string): MoblinkDiscoveredRelay | null {
	return relays.get(host) ?? null;
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
			// is refused.
			const targets = new Set<string>();
			for (const r of knownRelays()) {
				targets.add(r.host);
				for (const ep of r.interfaces) targets.add(ep.address);
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
	lastSig = "";
}
