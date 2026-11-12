/*
 * moblink_streamer module (encoder side). Creates one TUN per registered
 * shared relay interface (`createVirtualInterface` from @irlctrl/udp-relay),
 * and, with `autoRegisterUplink` on, registers each TUN IP as a
 * `network.uplinks` entry so `srtla_send` picks the extra paths up without
 * user intervention (spec 100-moblink §6, §7.2, §8.3, §6.3 multi-relay
 * extension).
 *
 * The module runs permanently on encoders: discovery listens for relay
 * announces and TUNs reconcile to the discovered set as it changes, so the
 * encoder is always able to pick up relay interface updates. There is no
 * start/stop — the module starts with the device process.
 *
 * Relays are learned by UDP announce (discovery.ts) — the encoder listens on
 * the well-known discovery port, keeps a TTL'd registry of the relays it
 * hears, and reconciles its TUNs to one-per-shared-interface. A manual
 * `relay` config is an additional (or, with no discovery, the only) endpoint.
 * The learned relays are mirrored to the `network.moblink` capability so the
 * network card groups the shared interfaces per relay.
 *
 * Control plane (TODO/protocol.md): discovery is bidirectional. The encoder
 * ALSO broadcasts an `encoder_id` announce so relays find us, and runs a
 * small WebSocket server (ws_server.ts) on the configured `wsPort`: each
 * relay connects, sends a `hello` snapshot + `interface_added` /
 * `interface_removed` / `interface_up` / `interface_down` events, which are
 * merged into the same registry (onRelayWsMessage) so the TUN reconcile
 * reacts to interface state — down paths stop their TUNs (the port mapping
 * survives), re-up paths reuse their TUN slot, and TUN local IPs are stable
 * per endpoint.
 */
import { writeFileSync } from "node:fs";
import { hostname } from "node:os";
import {
	createVirtualInterface,
	type VirtualInterface,
} from "@irlctrl/udp-relay";
import { requireCapability } from "../../../shared/capabilities";
import type {
	BackendModule,
	Params,
} from "../../../shared/contracts/backend_module";
import type {
	MoblinkRegistry,
	Uplinks,
} from "../../../shared/contracts/module_capabilities";
import {
	MOBLINK_RELAY_WS_PROTOCOL,
	type MoblinkDiscoveredRelay,
	type MoblinkRelayWsMessage,
	type MoblinkSharedEndpoint,
} from "../../../shared/moblink_discovery";
import {
	MDNS_ENCODER_SERVICE,
	MDNS_RELAY_SERVICE,
	type MdnsFound,
	startMdnsAdvertiser,
	startMdnsBrowser,
} from "../../../shared/moblink_mdns";
import {
	ApiError,
	oneOf,
	optionalInt,
	requireBoolean,
	requireString,
} from "../../../shared/params";
import { defaultSourceIp } from "../../../shared/srtla";
import { errorMessage } from "../../../shared/util";
import type { ModuleCore } from "../../backend/module_core";
import {
	type EncoderInfo,
	forgetRelay,
	isIpv4Literal,
	knownRelays,
	lastEncoderUdpAnnounceAt,
	noteMdnsRelay,
	noteRelay,
	startDiscovering,
	startEncoderAnnouncing,
	stopDiscovering,
	stopEncoderAnnouncing,
} from "./discovery";
import log from "./log";
import {
	type MoblinkLogLevel,
	type MoblinkStreamerConfig,
	type MoblinkStreamerRuntimeStatus,
	type MoblinkStreamerStatusFile,
	type MoblinkStreamerTunnelStatus,
	type MoblinkStreamerView,
} from "./types";
import { type RelayWsConn, startRelayWsServer } from "./ws_server";

const LOG_LEVELS: readonly MoblinkLogLevel[] = [
	"trace",
	"debug",
	"info",
	"warn",
	"error",
];

/** Core bag, bound at discovery and re-filled at start. */
let core: ModuleCore;
/** The network module's uplinks layer (bonded file + programmatic add/remove). */
let uplinks: Uplinks;
/** The network module's Moblink relays registry (surfaced on the network card). */
let moblinkReg: MoblinkRegistry;

/** The active TUNs, keyed by relay endpoint `${host}:${port}`. */
interface TunnelVif {
	vif: VirtualInterface;
	uplinkId: string | undefined;
	target: TunnelTarget;
}
const tunnels = new Map<string, TunnelVif>();

/**
 * Stable (relay ordinal X, interface ordinal Y) per endpoint, assigned on
 * first sight and never renumbered. This keeps the TUN names
 * (`relay{X}_{ifaceName}`) and their IPs (`10.{90+X}.{Y}.1`) stable while the
 * discovered relay set grows — a new relay sorts to the next unused ordinal
 * and its interfaces start at the next unused Y for that relay.
 */
const tunSlots = new Map<
	string,
	{ x: number; y: number; name: string; localIp: string }
>();
const relayOrdinal = new Map<string, number>();
const relayIfcSeen = new Map<string, number>();
let relaySeq = 0;
function slotFor(
	key: string,
	relayHost: string,
	ifaceName: string,
): {
	x: number;
	y: number;
	name: string;
	localIp: string;
} {
	const existing = tunSlots.get(key);
	if (existing) return existing;
	let x = relayOrdinal.get(relayHost);
	if (x === undefined) {
		x = relaySeq++;
		relayOrdinal.set(relayHost, x);
	}
	const y = relayIfcSeen.get(relayHost) ?? 0;
	relayIfcSeen.set(relayHost, y + 1);
	const slot = {
		x,
		y,
		name: `relay${x}_${ifaceName}`.slice(0, 15),
		localIp: `10.${90 + x}.${y}.1`,
	};
	tunSlots.set(key, slot);
	return slot;
}

/** A desired tunnel: one shared relay interface → one TUN. */
interface TunnelTarget {
	key: string;
	tunName: string;
	localIp: string;
	relayHost: string;
	relayPort: number;
}

// ----------------------------------------------------------------------
// Config (persisted as `state.data.moblinkStreamer`; §6.4)
// ----------------------------------------------------------------------
function defaultConfig(): MoblinkStreamerConfig {
	return {
		prefixLength: 24,
		mtu: 1400,
		keepaliveIntervalMs: 5_000,
		autoRegisterUplink: true,
		runtimeStatusFile: "/tmp/moblink-status.json",
		logLevel: "info",
		wsPort: 8190,
		announceToken: "",
	};
}

const stored = (): Partial<MoblinkStreamerConfig> =>
	(core.state.data.moblinkStreamer ?? {}) as Partial<MoblinkStreamerConfig>;

/** Defaults + stored values; never throws on missing config. */
function config(): MoblinkStreamerConfig {
	return { ...defaultConfig(), ...stored() };
}

/** Merge `patch` into the section and persist it complete (stable file). */
async function save(patch: Partial<MoblinkStreamerConfig>): Promise<void> {
	const s = { ...config(), ...patch };
	core.state.data.moblinkStreamer = { ...s } satisfies MoblinkStreamerConfig;
	await core.saveState();
}

// ----------------------------------------------------------------------
// Runtime status file (§9.1) — output only, best-effort.
// ----------------------------------------------------------------------
function statusFile(): MoblinkStreamerStatusFile {
	const entry = tunnelStatuses();
	return {
		connected: entry.some((e) => e.uplinkRegistered),
		relays: entry,
	};
}

function writeStatusFile(): void {
	if (core.config.DRY_RUN) return;
	try {
		writeFileSync(
			config().runtimeStatusFile,
			JSON.stringify(statusFile(), null, 2),
		);
	} catch (e) {
		console.warn(
			`moblink_streamer: status file write failed: ${errorMessage(e)}`,
		);
	}
}

// ----------------------------------------------------------------------
// Runtime status
// ----------------------------------------------------------------------
function tunnelStatuses(): MoblinkStreamerTunnelStatus[] {
	const out: MoblinkStreamerTunnelStatus[] = [];
	for (const t of tunnels.values()) {
		const st = t.vif.stats();
		out.push({
			interfaceName: t.vif.name,
			interfaceAddress: t.vif.localIp,
			relayHost: t.target.relayHost,
			relayPort: t.target.relayPort,
			uplinkRegistered: t.uplinkId !== undefined,
			stats: { txPackets: st.txPackets, rxPackets: st.rxPackets },
			lastError: st.lastError?.message,
		});
	}
	return out;
}

function runtimeStatus(): MoblinkStreamerRuntimeStatus {
	const statuses = tunnelStatuses();
	const running = statuses.length > 0;
	const anyError = statuses.some((s) => s.lastError);
	const agg = statuses.reduce(
		(acc, s) => {
			acc.txPackets += s.stats.txPackets;
			acc.rxPackets += s.stats.rxPackets;
			return acc;
		},
		{ txPackets: 0, rxPackets: 0 },
	);
	// Bytes: sum directly from the live VIF stats (statuses carry only packets).
	const bytes = [...tunnels.values()].reduce(
		(acc, t) => {
			const st = t.vif.stats();
			acc.txBytes += st.txBytes;
			acc.rxBytes += st.rxBytes;
			return acc;
		},
		{ txBytes: 0, rxBytes: 0 },
	);
	return {
		state: running ? (anyError ? "error" : "running") : "idle",
		running,
		tunnels: statuses,
		txPackets: agg.txPackets,
		rxPackets: agg.rxPackets,
		txBytes: bytes.txBytes,
		rxBytes: bytes.rxBytes,
		lastError: statuses.find((s) => s.lastError)?.lastError,
		// How recently this encoder announced itself so relays stay in touch.
		lastMdnsAnnounceAt,
		lastUdpAnnounceAt: lastEncoderUdpAnnounceAt(),
	};
}

const isRunning = (): boolean => tunnels.size > 0;

// ----------------------------------------------------------------------
// Desired targets + reconcile (one TUN per registered shared interface)
// ----------------------------------------------------------------------
/**
 * Compute the ordered set of tunnel targets from the discovered relays. The
 * encoder has no notion of a relay by hand — each relay announces itself, so
 * the targets are exactly the discovered relays' shared interfaces: sorted by
 * host, each interface in announced order, deduped by `${host}:${port}`.
 */
function desiredTargets(): TunnelTarget[] {
	/** Endpoint → (order index for stable sort ordering + owning relay). */
	const byKey = new Map<
		string,
		{
			host: string;
			port: number;
			order: number;
			relayHost: string;
			iface: string;
		}
	>();
	let order = 0;
	const add = (
		host: string,
		port: number,
		relayHost: string,
		iface: string,
	): void => {
		if (!host || !port) return;
		const key = `${host}:${port}`;
		if (byKey.has(key)) return;
		byKey.set(key, { host, port, order: order++, relayHost, iface });
	};
	for (const r of knownRelays().sort((a, b) => a.host.localeCompare(b.host))) {
		for (const ep of r.interfaces) {
			// A downed relay path is NOT a target (protocol.md §5): the relay
			// keeps advertising it (its port mapping survives), so when the
			// path returns no re-detection is needed — reconcile just
			// re-creates the TUN for the SAME endpoint.
			if (ep.state === "down") continue;
			add(ep.address || r.host, ep.listenPort, r.host, ep.name);
		}
	}
	// Assign a stable name + local IP per endpoint (stable across set growth).
	return [...byKey.values()]
		.sort((a, b) => a.order - b.order)
		.map((t) => {
			const key = `${t.host}:${t.port}`;
			const slot = slotFor(key, t.relayHost, t.iface);
			return {
				key,
				tunName: slot.name,
				localIp: slot.localIp,
				relayHost: t.host,
				relayPort: t.port,
			};
		});
}

async function startTunnel(target: TunnelTarget): Promise<void> {
	const c = config();
	// Bind the wire-protocol UDP socket to the LAN egress IP, not the TUN IP.
	// Binding to `localIp` (the TUN address) makes the per-source routing rule
	// send the frame back into our own TUN (self-encapsulation loop). The LAN
	// IP reaches the relay via the normal default route (spec 100-moblink §4.6).
	const created = await createVirtualInterface({
		name: target.tunName,
		localIp: target.localIp,
		bindAddress: defaultSourceIp() ?? undefined,
		prefixLength: c.prefixLength,
		mtu: c.mtu,
		keepaliveIntervalMs: c.keepaliveIntervalMs,
		relay: { host: target.relayHost, port: target.relayPort },
	});
	if (!core.config.DRY_RUN) await created.start();
	let uplinkId: string | undefined;
	if (c.autoRegisterUplink) {
		const id = `moblink:${target.tunName}`;
		await uplinks.add({
			id,
			source: created.localIp,
			label: `Moblink (${target.tunName})`,
		});
		uplinkId = id;
	}
	tunnels.set(target.key, { vif: created, uplinkId, target });
	console.log(
		`moblink_streamer: started ${created.name} (${created.localIp}) → ${target.relayHost}:${target.relayPort}`,
	);
}

async function stopTunnel(key: string): Promise<void> {
	const t = tunnels.get(key);
	if (!t) return;
	tunnels.delete(key);
	// The slot (TUN name + local IP) deliberately SURVIVES: a downed path
	// that re-comes-up must reuse the same TUN name/IP (protocol.md §1
	// stable mapping); the map is only cleared on a full stop.
	if (t.uplinkId) {
		try {
			await uplinks.remove(t.uplinkId);
		} catch (e) {
			console.warn(
				`moblink_streamer: uplink remove failed: ${errorMessage(e)}`,
			);
		}
	}
	if (!core.config.DRY_RUN) {
		try {
			await t.vif.stop();
		} catch (e) {
			console.warn(`moblink_streamer: vif stop failed: ${errorMessage(e)}`);
		}
	}
}

/**
 * Bring the TUN set in line with the discovered + configured relays. Creates
 * new TUNs, stops removed ones; per-target failures are logged and do not
 * abort the rest (the next discovery/refresh retries).
 */
async function reconcile(): Promise<void> {
	// Remove TUNs whose target is no longer desired.
	const desired = desiredTargets();
	const desiredKeys = new Set(desired.map((d) => d.key));
	for (const key of [...tunnels.keys()]) {
		if (!desiredKeys.has(key)) {
			try {
				await stopTunnel(key);
			} catch (e) {
				console.warn(
					`moblink_streamer: stop ${key} failed: ${errorMessage(e)}`,
				);
			}
		}
	}
	// Create TUNs not yet present.
	for (const target of desired) {
		if (tunnels.has(target.key)) continue;
		try {
			await startTunnel(target);
		} catch (e) {
			core.logEvent(
				"error",
				"Relay tunnels",
				`start ${target.tunName} → ${target.relayHost}:${target.relayPort} failed: ${errorMessage(e)}`,
			);
		}
	}
	core.notifyStateChange();
	writeStatusFile();
}

async function stopAllTunnels(): Promise<void> {
	for (const key of [...tunnels.keys()]) {
		try {
			await stopTunnel(key);
		} catch (e) {
			console.warn(`moblink_streamer: stop ${key} failed: ${errorMessage(e)}`);
		}
	}
	// Full teardown: reset the relay/interface ordinal state so the next start
	// begins at relay0_eth0 again (individual stops in reconcile must NOT).
	tunSlots.clear();
	relayOrdinal.clear();
	relayIfcSeen.clear();
	relaySeq = 0;
	core.notifyStateChange();
	writeStatusFile();
}

// ----------------------------------------------------------------------
// Discovery wiring
// ----------------------------------------------------------------------
/** Mirror the discovered relays to the network card's per-relay grouping.
 * `wsConnected` marks the relays with a live control-channel WebSocket so the
 * card can show a green "connected" dot (protocol.md §3). */
function syncRegistry(relays: MoblinkDiscoveredRelay[]): void {
	try {
		const seen = new Set(relays.map((r) => r.host));
		// Registry keys inside the hello→close WS window (protocol.md §3).
		const wsConnectedHosts = new Set(wsRelayHosts.values());
		// Drop stale registry entries no longer present.
		for (const r of moblinkReg.listRelays()) {
			if (!seen.has(r.host)) moblinkReg.dropRelay(r.host);
		}
		for (const r of relays) {
			moblinkReg.upsertRelay({
				host: r.host,
				hostname: r.hostname,
				interfaces: r.interfaces,
				lastSeen: r.lastSeen,
				wsConnected: wsConnectedHosts.has(r.host),
			});
		}
	} catch (e) {
		console.warn(`moblink_streamer: registry sync failed: ${errorMessage(e)}`);
	}
}

/**
 * Re-publish the network-card relay registry with fresh `wsConnected` flags.
 * Called when a control-channel WebSocket CLOSES: the relay entry stays in the
 * registry until its TTL sweeps it, but the green "connected" dot must go away
 * immediately. (The OPEN path needs no extra call — the relay's `hello`
 * re-registers it, which re-syncs with the flag already set.)
 */
function pushWsStatus(): void {
	syncRegistry(knownRelays());
	core.notifyStateChange();
}

/** A discovery shape change: re-sync the registry + reconcile the TUNs.
 *
 * The card must list discovered relays as soon as they appear, so the state
 * is pushed immediately — `reconcile()` already notifies when running, so
 * only the idle path needs its own push.
 */
async function onDiscoveredRelays(
	relays: MoblinkDiscoveredRelay[],
): Promise<void> {
	syncRegistry(relays);
	// Push immediately so the card lists the discovered relays. This is a
	// display update and must NOT be gated behind TUN reconciliation, which
	// creates TUNs and can be slow (a stuck create would otherwise block the
	// whole status push).
	console.log(
		`moblink_streamer: ${relays.length} relays discovered — notifying + reconciling`,
	);
	core.notifyStateChange();
	// Reconcile the TUN set in the background. It notifies on completion and
	// contains per-target errors, so a stuck/failed TUN never blocks the UI.
	void reconcile().catch((error) => {
		console.warn(
			`moblink_streamer: reconcile after discovery failed: ${errorMessage(error)}`,
		);
		core.notifyStateChange();
	});
}

let mdnsBrowseStop: (() => void) | undefined;
let mdnsAdvertiseStop: (() => void) | undefined;
/** Epoch ms of the encoder's last mDNS self-advertise (so relays find it).
 * The UDP one lives in `discovery.lastEncoderUdpAnnounceAt()`. Both surface
 * on the Network card (encoder role). */
let lastMdnsAnnounceAt: number | undefined;

function ensureDiscovery(): void {
	// Always wire the change callback: it also serves as the registration
	// path for relays handed over via the control server (`noteRelay`). In
	// dry-run the UDP socket is skipped, but relaying still converges.
	startDiscovering((rels) => void onDiscoveredRelays(rels), {
		dryRun: core.config.DRY_RUN,
		protectedHosts: () => wsLivePeers,
	});
	// mDNS path (protocol.md §3): browse for relay services. TXT is compact
	// (≤255 B) and may truncate the endpoint list, so `noteMdnsRelay` keeps
	// the longer of the known / seen endpoint sets (the WS hello stays
	// authoritative).
	mdnsBrowseStop?.();
	mdnsBrowseStop = startMdnsBrowser({
		service: MDNS_RELAY_SERVICE,
		dryRun: core.config.DRY_RUN,
		onFound: (f: MdnsFound): void => {
			const host = f.fields.get("ip");
			if (!host || !isIpv4Literal(host)) return;
			const endpoints: MoblinkSharedEndpoint[] = [];
			for (const part of (f.fields.get("i") ?? "").split(";")) {
				const m = /^(.+)=([0-9.]+):(\d+)$/u.exec(part.trim());
				if (m && isIpv4Literal(m[2]))
					endpoints.push({
						name: m[1],
						address: m[2],
						listenPort: Number(m[3]),
					});
			}
			noteMdnsRelay(host, f.fields.get("h") ?? undefined, endpoints);
		},
	});
}

// ----------------------------------------------------------------------
// Encoder → relay control plane (protocol.md §2–§5)
// ----------------------------------------------------------------------
/**
 * The encoder's discoverable endpoint for the announce broadcast (protocol.md
 * §2.1): id, IP, WS port, protocol version + optional token. The IP is the
 * machine's LAN egress address (`defaultSourceIp`) — the address a relay
 * reaches this box on. Returns null when there is nothing to advertise.
 */
export function encoderInfo(): EncoderInfo | null {
	const c = config();
	const ip = defaultSourceIp() ?? undefined;
	if (!ip) return null;
	return {
		encoderId: hostname() || "irlctrl-encoder",
		ip,
		wsPort: c.wsPort,
		proto: MOBLINK_RELAY_WS_PROTOCOL,
		token: c.announceToken || undefined,
	};
}

/** The relay WS server (stopped on port/token change at module restart). */
let wsServer: Bun.Server<RelayWsConn> | null = null;

/**
 * Start (or restart) the relay WebSocket server + the encoder announce
 * broadcast. The WS server's message callback merges relay interface state
 * into the discovered-relay registry, so the TUN reconcile reacts to
 * `interface_down` / `interface_removed` / `interface_added` / `interface_up`
 * (protocol.md §4–§5) — and a full `hello` snapshot replaces the relay's
 * known interface set wholesale.
 */
function ensureControlPlane(): void {
	const c = config();
	wsServer?.stop(true);
	wsServer = null;
	// A stopped server has no peers — never sweep-protect a stale IP, and no
	// relay is WS-connected across the restart (its channel is gone).
	wsLivePeers.clear();
	wsRelayHosts.clear();
	if (core.config.DRY_RUN) return;
	wsServer = startRelayWsServer({
		port: c.wsPort,
		token: c.announceToken,
		onMessage: (conn, msg: MoblinkRelayWsMessage) => {
			onRelayWsMessage(conn.relayId, msg, conn.remoteAddress);
		},
		onOpen: (conn) => {
			if (conn.remoteAddress && isIpv4Literal(conn.remoteAddress))
				wsLivePeers.add(conn.remoteAddress);
		},
		onClose: (conn) => {
			if (conn.relayId) wsRelayHosts.delete(conn.relayId);
			if (conn.remoteAddress) wsLivePeers.delete(conn.remoteAddress);
			// Drop the green "connected" dot now, before the TTL sweep reaps
			// the registry entry (protocol.md §3).
			pushWsStatus();
		},
	});
	startEncoderAnnouncing(() => encoderInfo(), { dryRun: core.config.DRY_RUN });
	// mDNS advertise (protocol.md §3): relays browse for us.
	mdnsAdvertiseStop?.();
	mdnsAdvertiseStop = startMdnsAdvertiser({
		instance: hostname() || "irlctrl-encoder",
		service: MDNS_ENCODER_SERVICE,
		servicePort: c.wsPort,
		dryRun: core.config.DRY_RUN,
		onAdvertise: (ts) => {
			lastMdnsAnnounceAt = ts;
		},
		buildTxt: (): string[] | null => {
			const info = encoderInfo();
			if (!info) return null;
			const fields = [
				`id=${info.encoderId}`,
				`ip=${info.ip}`,
				`port=${info.wsPort}`,
				`proto=${info.proto}`,
			];
			if (info.token) fields.push(`tok=${info.token}`);
			return fields;
		},
	});
}

/** Relay WS identity (`relay_id`) → discovered-relay registry host. */
const wsRelayHosts = new Map<string, string>();
/** Registry hosts with a LIVE relay WS (peer IP). The TTL sweep must not
 * reap these: the live channel keeps itself fresh via keepalive, and reaping
 * a connected relay is what caused the sweep→reconnect churn. */
const wsLivePeers = new Set<string>();

/**
 * A validated relay → encoder control-channel message (protocol.md §4).
 * Merges the relay's interface state into the discovered-relay registry so
 * `reconcile()` reacts: down/removed endpoints → TUN stopped, added/up →
 * TUN (re)started. The `hello` (full snapshot) replaces the relay's
 * interface list wholesale.
 */
export function onRelayWsMessage(
	relayId: string | undefined,
	msg: MoblinkRelayWsMessage,
	/** The relay's WS peer address (encoder-side source IP), if known. */
	remoteAddress?: string,
): void {
	if (!relayId) return; // before the (required) hello — nothing to match
	if (msg.type === "hello") {
		// The announce `host` (IP) and the WS `relay_id` (hostname) describe
		// the SAME relay; the WS channel is the authoritative, newer source,
		// so it owns the registry entry (key = the announce IP if known).
		// When no UDP announce ever arrived, the key would be the `relay_id`
		// hostname — prefer the routable peer IP instead (the hostname is
		// unusable for UDP dials; dgram performs no resolution).
		const known = knownRelays().find(
			(r) => r.hostname === relayId || r.host === relayId,
		);
		const host =
			known && isIpv4Literal(known.host)
				? known.host
				: remoteAddress && isIpv4Literal(remoteAddress)
					? remoteAddress
					: relayId;
		// Identity keying: `noteRelay` merges any old IP-keyed duplicate for
		// this relay; this explicit drop covers a STALE entry whose host and
		// hostname both differ from the live channel (relay moved subnets).
		if (known && known.host !== host && known.hostname !== relayId)
			forgetRelay(known.host);
		wsRelayHosts.set(relayId, host);
		noteRelay({
			host,
			hostname: relayId,
			interfaces: msg.interfaces.map((f) => ({
				name: f.iface_name,
				address: f.ip,
				listenPort: f.udp_port,
				state: f.state,
			})),
			lastSeen: Date.now(),
		});
		// Publish the green "connected" dot now. A relay re-announcing the
		// SAME interface set over WS leaves the registry shape unchanged, so
		// `noteRelay` alone would not re-sync the network card's flag.
		pushWsStatus();
		return;
	}
	// Keepalive frame (protocol.md §3): proof the channel is live → refresh
	// the TTL (every 5 s; the registry logs once per relay, never per frame).
	if (msg.type === "ping" || msg.type === "pong") {
		const host = wsRelayHosts.get(relayId);
		if (!host) return;
		const relay = knownRelays().find((r) => r.host === host);
		if (relay) noteRelay({ ...relay, lastSeen: Date.now() });
		return;
	}
	// A single-interface event: patch the owning relay's endpoint set
	// (insert on added, drop on removed, replace on up/down).
	const host = wsRelayHosts.get(relayId);
	if (!host) return; // unknown relay (no hello yet)
	const relay = knownRelays().find((r) => r.host === host);
	if (!relay) return;
	const next = [...relay.interfaces];
	const idx = next.findIndex((e) => e.name === msg.iface.iface_name);
	const ep: MoblinkSharedEndpoint = {
		name: msg.iface.iface_name,
		address: msg.iface.ip,
		listenPort: msg.iface.udp_port,
		state: msg.iface.state,
	};
	if (msg.type === "interface_removed") {
		if (idx >= 0) next.splice(idx, 1);
	} else if (idx >= 0) {
		next[idx] = ep;
	} else {
		next.push(ep);
	}
	noteRelay({
		host,
		hostname: relay.hostname,
		interfaces: next,
		lastSeen: Date.now(),
	});
}

// ----------------------------------------------------------------------
// Set config (persist + reconcile when the endpoint set may have changed)
// ----------------------------------------------------------------------
async function setRuntimeConfig(
	patch: Partial<MoblinkStreamerConfig>,
): Promise<MoblinkStreamerView> {
	await save(patch);
	core.notifyStateChange();
	return view();
}

function view(): MoblinkStreamerView {
	return {
		running: isRunning(),
		state: runtimeStatus().state,
		config: config(),
		runtime: runtimeStatus(),
		discoveredRelays: knownRelays(),
	};
}

// ----------------------------------------------------------------------
// Registration
// ----------------------------------------------------------------------
const registration: BackendModule<ModuleCore> = {
	kind: "device",
	id: "moblink_streamer",
	title: "Relay tunnels",
	roles: ["encoder"],
	/** Runs always on encoders: it must keep listening for relay interface
	 * updates and reconciling TUNs without any manual start (spec §7.4). */
	enabledByDefault: true,
	/** TUN IPs register through the network module; relays through its registry. */
	dependencies: ["network"],
	methods: [
		"moblink_streamer.status",
		"moblink_streamer.getConfig",
		"moblink_streamer.setConfig",
		"moblink_streamer.encoderInfo",
	],
	events: [],
	log,
	/**
	 * `modules.configure`: persist the settings-page fields to the module
	 * section. The core then restarts the module, so a relay/endpoint change
	 * re-reconciles the TUNs (spec §6.3). Only present fields are touched.
	 */
	configure(patch, _s) {
		const c = config();
		const next: MoblinkStreamerConfig = { ...c };
		if (typeof patch.prefixLength === "number")
			next.prefixLength = patch.prefixLength;
		if (typeof patch.mtu === "number") next.mtu = patch.mtu;
		if (typeof patch.keepaliveIntervalMs === "number")
			next.keepaliveIntervalMs = patch.keepaliveIntervalMs;
		if (typeof patch.autoRegisterUplink === "boolean")
			next.autoRegisterUplink = patch.autoRegisterUplink;
		if (typeof patch.runtimeStatusFile === "string")
			next.runtimeStatusFile = patch.runtimeStatusFile;
		if (typeof patch.wsPort === "number") next.wsPort = patch.wsPort;
		if (typeof patch.announceToken === "string")
			next.announceToken = patch.announceToken;
		if (typeof patch.logLevel === "string")
			next.logLevel = patch.logLevel as MoblinkLogLevel;
		core.state.data.moblinkStreamer = next;
	},
	bind(c) {
		core = c;
		uplinks = requireCapability<Uplinks>("network.uplinks");
		moblinkReg = requireCapability<MoblinkRegistry>("network.moblink");
	},
	async start(ctx) {
		core = ctx.core;
		uplinks = requireCapability<Uplinks>("network.uplinks");
		moblinkReg = requireCapability<MoblinkRegistry>("network.moblink");
		// Always: listen for relay announces and reconcile the TUN set, so
		// relay interface updates are picked up without a manual start.
		ensureDiscovery();
		syncRegistry(knownRelays());
		ensureControlPlane();
		try {
			await reconcile();
		} catch (e) {
			core.logEvent(
				"warn",
				"Relay tunnels",
				`autostart failed: ${errorMessage(e)}`,
			);
		}
	},
	async stop() {
		stopDiscovering();
		stopEncoderAnnouncing();
		mdnsBrowseStop?.();
		mdnsBrowseStop = undefined;
		mdnsAdvertiseStop?.();
		mdnsAdvertiseStop = undefined;
		wsServer?.stop(true);
		wsServer = null;
		await stopAllTunnels();
	},
	/** Resume the TUNs across process restarts. */
	async resume() {
		ensureDiscovery();
		syncRegistry(knownRelays());
		ensureControlPlane();
		if (!isRunning()) await reconcile();
		return true;
	},
	async dispatch(method: string, p: Params) {
		switch (method) {
			case "moblink_streamer.status":
				return view();
			case "moblink_streamer.getConfig":
				return { config: config() };
			/** The relay's control-server path queries this for the encoder's
			 * IP + WS port after its announce TTL expires (protocol.md §2.1). */
			case "moblink_streamer.encoderInfo":
				return encoderInfo();
			case "moblink_streamer.setConfig": {
				const patch: Partial<MoblinkStreamerConfig> = {};
				if (p.prefixLength !== undefined)
					patch.prefixLength = optionalInt(
						p,
						"prefixLength",
						config().prefixLength,
						0,
						32,
					);
				if (p.mtu !== undefined)
					patch.mtu = optionalInt(p, "mtu", config().mtu, 1, 65_535);
				if (p.keepaliveIntervalMs !== undefined)
					patch.keepaliveIntervalMs = optionalInt(
						p,
						"keepaliveIntervalMs",
						config().keepaliveIntervalMs,
						1,
						3_600_000,
					);
				if (p.autoRegisterUplink !== undefined)
					patch.autoRegisterUplink = requireBoolean(p, "autoRegisterUplink");
				if (p.runtimeStatusFile !== undefined)
					patch.runtimeStatusFile = requireString(p, "runtimeStatusFile");
				if (p.wsPort !== undefined)
					patch.wsPort = optionalInt(p, "wsPort", config().wsPort, 1, 65_535);
				if (p.announceToken !== undefined)
					patch.announceToken = requireString(p, "announceToken");
				if (p.logLevel !== undefined)
					patch.logLevel = oneOf(p.logLevel, "logLevel", LOG_LEVELS);
				if (Object.keys(patch).length === 0)
					throw new ApiError("no config fields provided");
				return setRuntimeConfig(patch);
			}
		}
		throw new Error(`unknown method ${method}`);
	},
	async status() {
		return { state: { moblinkStreamer: view() } };
	},
};

export default registration;
