/*
 * MobLink relay ↔ encoder discovery (both sides of the wire).
 *
 * SENDING (relay → encoder, v1 announce — spec 100-moblink §5): when a relay
 * runs, it periodically broadcasts a small JSON `MoblinkAnnounce` over UDP to
 * the limited-broadcast address (255.255.255.255) on the fixed well-known
 * `MOBLINK_DISCOVERY_PORT`. Encoders listening on that port learn the relay's
 * shared tunnel interfaces without any control server and without the user
 * having to type the relay's IP.
 *
 * RECEIVING (encoder → relay, protocol.md §2): encoders broadcast a JSON
 * `MoblinkEncoderAnnounce` on the SAME port carrying their id, IP, WebSocket
 * port and optional auth token. This module's listener keeps a TTL'd registry
 * of the encoders the relay hears and hands each (re)announce to a callback so
 * the backend can dial the encoder's WebSocket. Both announce shapes share the
 * port; the type guards (`isMoblinkAnnounce` / `isMoblinkEncoderAnnounce`)
 * keep each side's listener from misparsing the other.
 *
 * Uses `node:dgram` (Bun's `Bun.udp` does not expose `SO_BROADCAST` in 1.4.4):
 * the sender socket is bound, `setBroadcast(true)` is set, and the announce is
 * re-sent on an interval so remote TTL entries stay fresh. `buildPayload` is
 * called every tick so the announce always reflects the live interface set.
 */
import dgram from "node:dgram";
import {
	isMoblinkEncoderAnnounce,
	MOBLINK_ANNOUNCE_INTERVAL_MS,
	MOBLINK_ANNOUNCE_TTL_MS,
	MOBLINK_BROADCAST_ADDR,
	MOBLINK_DISCOVERY_PORT,
	type MoblinkAnnounce,
	type MoblinkDiscoveredEncoder,
} from "../../../shared/moblink_discovery";

/** The bound UDP socket used to broadcast announce datagrams. */
let socket: dgram.Socket | undefined;
/** The re-broadcast timer. */
let timer: ReturnType<typeof setInterval> | undefined;

/** Compact one-line summary of an announce's shared interfaces (debug logs). */
function endpointSummary(eps: MoblinkAnnounce["interfaces"]): string {
	return eps.map((e) => `${e.name}=${e.address}: ${e.listenPort}`).join(", ");
}

/** Per-target throttle: a permanently-unreachable encoder IP must not spam
 * the log on every announce tick (60 s). */
const lastUnicastWarn = new Map<string, number>();

function sendOnce(s: dgram.Socket, announce: MoblinkAnnounce): void {
	const payload = JSON.stringify(announce);
	console.log(
		`moblink_relay: advertising host=${announce.host} ifaces=[${endpointSummary(announce.interfaces)}] → ${MOBLINK_BROADCAST_ADDR}:${MOBLINK_DISCOVERY_PORT}`,
	);
	try {
		s.send(payload, MOBLINK_DISCOVERY_PORT, MOBLINK_BROADCAST_ADDR, (e) => {
			if (e)
				console.warn(`moblink_relay: discovery announce failed: ${e.message}`);
		});
	} catch (e) {
		console.warn(`moblink_relay: discovery announce failed: ${String(e)}`);
	}
	// Unicast to every KNOWN encoder as well: the limited broadcast does not
	// cross subnets (an encoder on a phone-hotspot / WireGuard link never
	// sees it) and mDNS is L2-only. Once the control server — or a same-L2
	// broadcast — seeds one entry, this keeps the pair alive across any
	// routed path. Symmetric mirror of the encoder's unicast fallback.
	for (const ip of knownEncoderIps()) {
		try {
			s.send(payload, MOBLINK_DISCOVERY_PORT, ip, (e) => {
				if (!e) return;
				const now = Date.now();
				if (now - (lastUnicastWarn.get(ip) ?? 0) < 60_000) return;
				lastUnicastWarn.set(ip, now);
				console.warn(
					`moblink_relay: encoder announce to ${ip} failed: ${e.message}`,
				);
			});
		} catch (e) {
			console.warn(
				`moblink_relay: encoder unicast announce failed: ${String(e)}`,
			);
		}
	}
}

/** Start broadcasting `buildPayload()` announcements until `stopAnnouncing`. */
export function startAnnouncing(
	buildPayload: () => MoblinkAnnounce | null,
	opts: { dryRun?: boolean } = {},
): void {
	stopAnnouncing();
	if (opts.dryRun) {
		console.log("moblink_relay: discovery advertise skipped (dry-run)");
		return;
	}
	try {
		const s = dgram.createSocket({ type: "udp4", reuseAddr: true });
		s.on("error", (e) =>
			console.warn(`moblink_relay: discovery socket error: ${e.message}`),
		);
		const begin = (): void => {
			try {
				s.setBroadcast(true);
			} catch {
				/* best-effort — unicast encoders on the same host still work */
			}
			console.log(
				`moblink_relay: discovery advertise started → ${MOBLINK_BROADCAST_ADDR}:${MOBLINK_DISCOVERY_PORT} every ${MOBLINK_ANNOUNCE_INTERVAL_MS}ms`,
			);
			const tick = (): void => {
				const announce = buildPayload();
				if (announce) sendOnce(s, announce);
			};
			tick();
			timer = setInterval(tick, MOBLINK_ANNOUNCE_INTERVAL_MS);
			timer.unref?.();
		};
		// Bind the socket to the announce host so the limited-broadcast
		// (255.255.255.255) egresses on the interface facing the encoders.
		// An unbound socket routes the broadcast out the default-route
		// interface, which may be a different subnet than the one encoders
		// actually reach the relay tunnels on (e.g. interconnect-only NIC).
		const bindHost = buildPayload()?.host ?? "";
		if (bindHost) s.bind(0, bindHost, begin);
		else s.bind(0, begin);
		socket = s;
	} catch (e) {
		console.warn(
			`moblink_relay: discovery announce failed to start: ${String(e)}`,
		);
		stopAnnouncing();
	}
}

/** Stop broadcasting; best-effort (never throws). */
export function stopAnnouncing(): void {
	const had = timer !== undefined || socket !== undefined;
	if (timer) {
		clearInterval(timer);
		timer = undefined;
	}
	const s = socket;
	socket = undefined;
	if (had) console.log("moblink_relay: discovery advertise stopped");
	if (s) {
		try {
			s.close();
		} catch {
			/* already closed */
		}
	}
}

// ----------------------------------------------------------------------
// Encoder registry (encoder → relay announces, protocol.md §2)
// ----------------------------------------------------------------------

/** A TTL'd registry of encoders this relay has heard (keyed by `encoder_id`).
 * Encoders re-announce periodically, so entries that stop being heard are
 * swept after `MOBLINK_ANNOUNCE_TTL_MS` (~3× the announce interval). */
const encoderRegistry = new Map<string, MoblinkDiscoveredEncoder>();

/**
 * Record or refresh an encoder (UDP announce or control-server lookup). The
 * entry's `lastSeen` is taken from `e` (the callers stamp it with the
 * announce time) so the TTL sweep can expire silent encoders.
 */
export function noteEncoder(e: MoblinkDiscoveredEncoder): void {
	encoderRegistry.set(e.encoderId, { ...e });
}

/** The current registry entries (a copy — safe to iterate freely). */
export function knownEncoders(): MoblinkDiscoveredEncoder[] {
	return [...encoderRegistry.values()];
}

/** The known encoders' IPs — unicast announce targets (protocol.md §2.1). */
export function knownEncoderIps(): string[] {
	return [...encoderRegistry.values()]
		.map((e) => e.ip)
		.filter((ip): ip is string => typeof ip === "string" && ip !== "");
}

/** Drop every entry not (re)announced within TTL; returns the dropped ids. */
export function sweepEncoders(): string[] {
	const now = Date.now();
	const dropped: string[] = [];
	for (const [id, e] of encoderRegistry) {
		if (now - e.lastSeen > MOBLINK_ANNOUNCE_TTL_MS) {
			encoderRegistry.delete(id);
			dropped.push(id);
		}
	}
	return dropped;
}

let encoderSocket: dgram.Socket | undefined;
let encoderSweepTimer: ReturnType<typeof setInterval> | undefined;
let encoderCb: ((e: MoblinkDiscoveredEncoder) => void) | undefined;

/**
 * Listen on the well-known discovery port for encoder announces (protocol.md
 * §2). Each parsed `MoblinkEncoderAnnounce` is recorded in the registry and
 * handed to `cb` so the backend can dial the encoder's WebSocket. Relay
 * announces (`{v:1, host, interfaces}`) share the port and are filtered out
 * by `isMoblinkEncoderAnnounce`. A TTL sweep drops encoders that stop
 * announcing.
 */
export function startListeningForEncoders(
	cb: (e: MoblinkDiscoveredEncoder) => void,
	opts: { dryRun?: boolean } = {},
): void {
	stopListeningForEncoders();
	if (opts.dryRun) {
		console.log("moblink_relay: encoder discovery listen skipped (dry-run)");
		return;
	}
	encoderCb = cb;
	try {
		const s = dgram.createSocket({ type: "udp4", reuseAddr: true });
		s.on("error", (e) =>
			console.warn(
				`moblink_relay: encoder-discovery socket error: ${e.message}`,
			),
		);
		s.on("message", (msg) => {
			let parsed: unknown;
			try {
				parsed = JSON.parse(msg.toString("utf8"));
			} catch {
				return; // not JSON — noise on a shared port
			}
			if (!isMoblinkEncoderAnnounce(parsed)) return;
			const e: MoblinkDiscoveredEncoder = {
				encoderId: parsed.encoder_id,
				ip: parsed.ip,
				wsPort: parsed.ws_port,
				proto: parsed.proto,
				token: parsed.token,
				lastSeen: Date.now(),
			};
			noteEncoder(e);
			encoderCb?.(e);
		});
		s.bind(MOBLINK_DISCOVERY_PORT, "0.0.0.0", () => {
			console.log(
				`moblink_relay: encoder discovery listening on :${MOBLINK_DISCOVERY_PORT}`,
			);
		});
		encoderSocket = s;
		const sweep = (): void => {
			for (const id of sweepEncoders())
				console.log(`moblink_relay: encoder ${id} expired (no announce)`);
		};
		encoderSweepTimer = setInterval(sweep, MOBLINK_ANNOUNCE_INTERVAL_MS);
		encoderSweepTimer.unref?.();
	} catch (e) {
		console.warn(
			`moblink_relay: encoder discovery listen failed: ${String(e)}`,
		);
		stopListeningForEncoders();
	}
}

/** Stop listening; best-effort (never throws). */
export function stopListeningForEncoders(): void {
	if (encoderSweepTimer) {
		clearInterval(encoderSweepTimer);
		encoderSweepTimer = undefined;
	}
	encoderCb = undefined;
	const s = encoderSocket;
	encoderSocket = undefined;
	if (s) {
		try {
			s.close();
		} catch {
			/* already closed */
		}
	}
}
