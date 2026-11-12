/*
 * Moblink relay module: the per-interface UDP relays that transparently
 * bridge full IP packets between this machine's LAN interfaces and the
 * encoders. SRTLA lives only on the encoder; the relay forwards the shared
 * interfaces' L3 traffic so the encoder can reach the LAN as local peers.
 *
 * This module is the relay-box side of the Moblink transport. It enumerates
 * the machine's eligible network interfaces (via the `network.interfaces`
 * capability, filtered by the `interfaceAllow` / `interfaceIgnore` config),
 * and for each one starts a `createUdpRelay()` from `@irlctrl/udp-relay`
 * bound to that interface's IP. It owns no TUN, no routing, and no config
 * file beyond `ctx.state.moblink`: the relay IDs live in
 * `ctx.state.moblink.relayIds` and the runtime status is written to
 * `runtimeStatusFile` on every state change.
 *
 * Protocol (TODO/protocol.md):
 *  - §1  one UDP relay per uplink interface; ports allocated from
 *      `listenPortBase` by a persisted HIGH-WATER-MARK allocator
 *      (`ctx.state.moblink.portMap`): adding an interface never reindexes
 *      existing ports, a removed interface frees its slot, and a downed
 *      interface keeps its mapping (marked `state: "down"`).
 *  - §2  the relay discovers ENCODERS: it listens for the encoder's UDP
 *      announces (id, IP, WebSocket port, optional token) on the discovery
 *      port, and may also ask the control server for registered encoders.
 *  - §3–§5  for every discovered encoder the relay connects to the
 *      encoder's WebSocket server as a CLIENT, sends its identity, the
 *      protocol version and the full uplink interface list (interface IP +
 *      UDP port), and propagates `interface_added` / `interface_removed` /
 *      `interface_up` / `interface_down` events; after every reconnect it
 *      re-sends a full snapshot. The encoder sends UDP data to
 *      `interface_ip:udp_port`.
 */
import { readFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { requireCapability } from "../../../shared/capabilities";
import type {
	BackendModule,
	Params,
} from "../../../shared/contracts/backend_module";
import type {
	NetworkInterfaces,
	Uplinks,
} from "../../../shared/contracts/module_capabilities";
import {
	createUdpRelay,
	resolveInterfaceAddress,
	type IfaceRawSocket,
	type UdpRelay,
} from "../../../shared/lib/udp_relay";
import {
	MOBLINK_ANNOUNCE_INTERVAL_MS,
	MOBLINK_RELAY_WS_PROTOCOL,
	type MoblinkAnnounce,
	type MoblinkDiscoveredEncoder,
	type MoblinkRelayIface,
	type MoblinkRelayIfaceEventType,
	type MoblinkRelayWsMessage,
} from "../../../shared/moblink_discovery";
import {
	ApiError,
	optionalStringList,
	requireBoolean,
	requireHost,
} from "../../../shared/params";
import { errorMessage } from "../../../shared/util";
import type { ModuleCore } from "../../backend/module_core";
import {
	knownEncoders,
	noteEncoder,
	startAnnouncing,
	startListeningForEncoders,
	stopAnnouncing,
	stopListeningForEncoders,
	sweepEncoders,
} from "./discovery";
import log from "./log";
import type {
	MoblinkRelayConfig,
	MoblinkRelayFailure,
	MoblinkRelayState,
	MoblinkRuntimeStatus,
} from "./types";

// ----------------------------------------------------------------------
// Config (the `ctx.state.moblink` slice)
// ----------------------------------------------------------------------
const DEFAULTS: Required<
	Omit<MoblinkRelayConfig, "interfaceNameOverrides" | "portMap">
> & {
	interfaceNameOverrides: Record<string, string>;
	portMap: Record<string, number>;
} = {
	enabled: false,
	nat: true,
	announceHost: "",
	listenPortBase: 4000,
	interfaceAllow: [],
	interfaceIgnore: ["docker.*", "veth.*"],
	interfaceNameOverrides: {},
	runtimeStatusFile: join(tmpdir(), "moblink-status.json"),
	logLevel: "info",
	portMap: {},
};

let core: ModuleCore;

let netIfaces: NetworkInterfaces;
let netUnsub: (() => void) | undefined;
/** TTL sweeper for the encoder registry (drops encoders we stopped hearing). */
let encoderSweep: ReturnType<typeof setInterval> | undefined;
/** Timestamp of the last control-server encoder lookup. */
let lastControlServerCheck = 0;

/** The running per-interface relays, keyed by interface name. */
const relays = new Map<string, UdpRelay>();
/**
 * Interfaces marked DOWN (present in the mapping, no live relay): their port
 * mapping is kept (protocol.md §1) and the encoder is told `interface_down`.
 * `reason` distinguishes "downed" (no IP / no carrier) from "failed" (the
 * relay socket could not be bound, e.g. port in use).
 */
const downIfaces = new Map<string, { reason?: string }>();
/** The last interface address each relay was created for (hotplug detection). */
const lastIfaceAddr = new Map<string, string>();
/** Interfaces that failed to start (name → reason), surfaced in status/card. */
const failures = new Map<string, string>();
/**
 * Vif reply-path routes this relay installed, keyed by interface name. We keep
 * the learned vif IP and the dedicated table number so `stopRelay` can tear the
 * rule + route back down (a stale table entry would keep the reply route alive
 * after the relay is gone, mirroring the stale main-table routes the old code
 * left behind).
 */
const vifRoutes = new Map<string, { vifIp: string; table: number }>();
/**
 * Base of the dedicated routing-table range for vif reply paths. Kept in a
 * range the streamer's per-source tables (base 100) never touch, and the rule
 * priority stays well below NetworkManager's per-interface rules (~32760) so
 * ours are consulted first.
 */
const VIF_TABLE_BASE = 200;

type ResolvedConfig = Required<
	Omit<MoblinkRelayConfig, "interfaceNameOverrides" | "portMap">
> & {
	interfaceNameOverrides: Record<string, string>;
	portMap: Record<string, number>;
};

/** Read the merged config slice (defaults backfilled on first read). */
function config(): ResolvedConfig {
	const raw = (core.state.data.moblink ?? {}) as Partial<MoblinkRelayConfig>;
	const portMap: Record<string, number> = {};
	for (const [name, port] of Object.entries(raw.portMap ?? {}))
		if (Number.isInteger(port) && port >= 1 && port <= 65_535)
			portMap[name] = port;
	return {
		enabled: raw.enabled ?? DEFAULTS.enabled,
		nat: raw.nat ?? DEFAULTS.nat,
		announceHost: raw.announceHost ?? DEFAULTS.announceHost,
		listenPortBase: raw.listenPortBase ?? DEFAULTS.listenPortBase,
		interfaceAllow: raw.interfaceAllow ?? DEFAULTS.interfaceAllow,
		interfaceIgnore: raw.interfaceIgnore ?? DEFAULTS.interfaceIgnore,
		interfaceNameOverrides:
			raw.interfaceNameOverrides ?? DEFAULTS.interfaceNameOverrides,
		runtimeStatusFile: raw.runtimeStatusFile ?? DEFAULTS.runtimeStatusFile,
		logLevel: raw.logLevel ?? DEFAULTS.logLevel,
		portMap,
	};
}

/** Persist the full config slice (for a stable state file). */
function saveConfig(
	patch: Partial<MoblinkRelayConfig>,
): ReturnType<typeof config> {
	const next = { ...config(), ...patch };
	core.state.data.moblink = {
		...next,
		relayIds: (core.state.data.moblink as Record<string, unknown>)?.relayIds as
			| Record<string, string>
			| undefined,
	};
	core.saveState();
	return next;
}

/**
 * Which interfaces a relay should run on, given the config. Pure and
 * unit-testable: takes the interface list and a config, returns the
 * eligible names (already filtered and sorted).
 */
export function eligibleInterfaces(
	ifaces: Array<{ name: string; addresses: string[] }>,
	cfg: ReturnType<typeof config>,
): string[] {
	const allow = cfg.interfaceAllow.map((r) => new RegExp(r, "i"));
	const ignore = cfg.interfaceIgnore.map((r) => new RegExp(r, "i"));
	return ifaces
		.filter((i) => i.addresses.length > 0)
		.filter((i) =>
			allow.length > 0
				? allow.some((re) => re.test(i.name))
				: !ignore.some((re) => re.test(i.name)),
		)
		.map((i) => i.name)
		.sort();
}

/** The interface address a relay should bind to (first IPv4, or the override). */
function ifaceAddress(
	name: string,
	ifaces: Array<{ name: string; addresses: string[] }>,
	cfg: ReturnType<typeof config> = config(),
): string | undefined {
	const override = cfg.interfaceNameOverrides[name];
	if (override) return override;
	return ifaces.find((i) => i.name === name)?.addresses[0];
}

// ----------------------------------------------------------------------
// Port allocator (protocol.md §1: high-water mark, stable mappings)
// ----------------------------------------------------------------------
/**
 * Resolve `name`'s UDP port. A persisted mapping always wins — adding
 * interfaces never reindexes existing ports and a downed interface keeps its
 * port. A NEW interface receives `highest_assigned_port + 1` (the port
 * high-water mark; `listenPortBase` seeds the very first allocation) and the
 * mapping is persisted immediately.
 */
export function allocatePort(name: string): number {
	const cfg = config();
	const existing = cfg.portMap[name];
	if (existing !== undefined) return existing;
	const ports = Object.values(cfg.portMap);
	const highWater =
		ports.length > 0 ? Math.max(...ports) : cfg.listenPortBase - 1;
	let port = highWater + 1;
	// Defense against a corrupted map: never hand out a taken port.
	while (ports.includes(port)) port += 1;
	if (port > 65_535)
		throw new ApiError(
			`no free relay port for ${name} (high water ${highWater})`,
			409,
		);
	saveConfig({ portMap: { ...cfg.portMap, [name]: port } });
	return port;
}

/** Free a removed interface's port mapping (the other mappings stay put). */
export function freePort(name: string): void {
	const cfg = config();
	if (cfg.portMap[name] === undefined) return;
	const next = { ...cfg.portMap };
	delete next[name];
	saveConfig({ portMap: next });
}

/**
 * Carrier state of a machine interface: `false` only when the OS explicitly
 * reports it down. Read failures (missing sysfs entry, e.g. a test-only
 * interface name) are lenient and report `up` — a relay that cannot bind is
 * surfaced as a failure, not a carrier loss.
 */
export function carrierUp(name: string): boolean {
	try {
		return (
			readFileSync(join("/sys/class/net", name, "operstate"), "utf8").trim() !==
			"down"
		);
	} catch {
		return true;
	}
}

// ----------------------------------------------------------------------
// Runtime status (the status file + the `moblink_relay.status` RPC)
// ----------------------------------------------------------------------
/**
 * The LAN IP this relay advertises to encoders: the manual `announceHost`
 * override if set, else the auto-detected address (the first running relay's
 * bound address, else the first eligible interface). Empty when there is
 * nothing to advertise.
 */
export function effectiveAnnounceHost(): string {
	const cfg = config();
	const manual = cfg.announceHost.trim();
	if (manual) return manual;
	const ifaces = netIfaces?.list() ?? [];
	const auto =
		[...relays.values()][0]?.interfaceAddress ??
		eligibleInterfaces(ifaces, cfg)
			.map((name) => ifaceAddress(name, ifaces, cfg))
			.find(Boolean);
	return auto ?? "";
}

/**
 * The relay's uplink interfaces as reported to the encoder (protocol.md
 * §3/§4): name, the interface's own IP (the address the encoder dials), the
 * allocated UDP port, and the up/down state. `uplink: true` marks every
 * entry (this list IS the relay's uplink set).
 */
export function relayIfaceList(): MoblinkRelayIface[] {
	const cfg = config();
	const ifaces = netIfaces?.list() ?? [];
	return eligibleInterfaces(ifaces, cfg).map((name) => ({
		iface_name: name,
		ip: ifaceAddress(name, ifaces, cfg) ?? "",
		udp_port: allocatePort(name),
		state: relays.has(name) ? ("up" as const) : ("down" as const),
		uplink: true,
	}));
}

function buildStatus(): MoblinkRuntimeStatus {
	const cfg = config();
	const ifaces = netIfaces?.list() ?? [];
	const availableInterfaces = eligibleInterfaces(ifaces, cfg).map((name) => ({
		name,
		address: ifaceAddress(name, ifaces, cfg) ?? "",
		// High-water-mark mapping (protocol.md §1) — never base+index.
		listenPort: allocatePort(name),
		state: relays.has(name) ? ("up" as const) : ("down" as const),
	}));
	const relaysArr = [...relays.entries()].map(([name, relay]) => {
		const st = relay.stats();
		return {
			interfaceName: name,
			interfaceAddress: relay.interfaceAddress,
			stats: {
				encRxPackets: st.encRxPackets,
				encTxPackets: st.encTxPackets,
				lastEncoderSeen: st.lastEncoderSeen,
			},
		};
	});
	const downList = [...downIfaces.keys()].filter((name) =>
		availableInterfaces.some((i) => i.name === name),
	);
	return {
		connected: relays.size > 0,
		announceHost: effectiveAnnounceHost(),
		availableInterfaces,
		relays: relaysArr,
		downInterfaces: downList,
		failures: [...failures.entries()].map(([interfaceName, reason]) => ({
			interfaceName,
			reason,
		})),
	};
}

/**
 * The discoverable payload this relay broadcasts to encoders (UDP broadcast
 * on the well-known discovery port). Returns null when there is nothing to
 * offer (no eligible interfaces), so the announce tick is skipped.
 */
export function announcePayload(): MoblinkAnnounce | null {
	const cfg = config();
	const ifaces = buildStatus().availableInterfaces;
	if (ifaces.length === 0) return null;
	// The announced relay identity: manual override if set, else the
	// auto-detected LAN address (the first eligible interface).
	const host = effectiveAnnounceHost() || ifaces[0].address;
	if (!host) return null;
	// A manual announceHost covers every tunnel (NATted / interconnect-only
	// NIC). In auto mode the encoder dials each interface's OWN IP
	// (protocol.md §3/§5: "the IP address is the address of the relay
	// interface that the encoder should use to reach the relay").
	const perIfaceAddress = cfg.announceHost.trim() === "";
	return {
		v: 1,
		host,
		hostname: hostname(),
		interfaces: ifaces.map((i) => ({
			name: i.name,
			address: perIfaceAddress ? i.address || host : host,
			listenPort: i.listenPort,
			// Down paths stay advertised (port kept) so the encoder keeps the
			// mapping and reuses it when the path returns (protocol.md §1/§5).
			state: i.state,
		})),
		ts: Date.now(),
	};
}

/** Write the runtime status file (best-effort, never throws). */
async function writeStatusFile(): Promise<void> {
	const cfg = config();
	try {
		const status = buildStatus();
		await core.writeFileAtomic(
			cfg.runtimeStatusFile,
			JSON.stringify(status, null, 2),
		);
	} catch (e) {
		core.logEvent("warn", "Relay", `status file: ${errorMessage(e)}`);
	}
}

// ----------------------------------------------------------------------
// Relay lifecycle
// ----------------------------------------------------------------------
/**
 * Inject the per-interface raw socket (tests run without CAP_NET_ADMIN and
 * supply a mock). Production leaves this undefined → the relay opens a real
 * raw socket. `setIfaceSocketFactory` is exported only so the test module can
 * override it (the binding itself is not exported for assignment).
 */
let ifaceSocketFactory: ((name: string) => IfaceRawSocket) | undefined;
export function setIfaceSocketFactory(
	factory: ((name: string) => IfaceRawSocket) | undefined,
): void {
	ifaceSocketFactory = factory;
}

async function startRelay(
	name: string,
	addr: string,
	listenPort: number,
): Promise<UdpRelay> {
	// SNAT source = the egress NIC's *own* IP, not the (possibly overridden)
	// vif bind address. Once a packet leaves the tether, the reply must come
	// back to an address the egress upstream (phone / carrier NAT) can route
	// into that NIC — which is the NIC's real IP. The vif bind address may be
	// an encoder-reachable LAN override that the phone can't route back, in
	// which case replies vanish (forward-only traffic). Best-effort: if the
	// NIC IP can't be resolved (tests, fake iface), fall back to interfaceAddress.
	let natAddress: string | undefined;
	try {
		natAddress = resolveInterfaceAddress(name);
	} catch {
		natAddress = undefined;
	}
	const relay = await createUdpRelay({
		interfaceName: name,
		listenPort,
		interfaceAddress: addr,
		natAddress,
		ifaceSocket: ifaceSocketFactory?.(name),
		// SNAT to the relay's own IP (default on) so a *remote* destination
		// can receive the stream and reply to the relay, not the private vif
		// IP the transparent bridge can't route back through.
		nat: config().nat,
		// When the relay learns the vif IP an encoder bridges through this
		// interface, park a FORWARD-path route in a DEDICATED table (never the
		// main one): the relay egresses whole packets with the vif IP as their
		// SOURCE, but the host's default route is source-pinned
		// (`... src <relayIp>`), so the kernel can't route vif-sourced traffic
		// and emits ICMP host-unreachable (SRT handshake dies, leg 0 kbps). A
		// `from <vif>` rule + source-agnostic `default dev <iface>` in a
		// dedicated table gives that traffic a real egress. Best-effort: a
		// routing failure must not break the relay itself.
		//
		// NAT mode: not needed — the relay SNATs the source to its own IP, so
		// outbound traffic already routes normally through the host default
		// route. Only the transparent bridge (nat=false) egresses vif-sourced
		// packets, which is the case that needs this route.
		onVifLearned: (vifIp) => {
			if (config().nat) return;
			void installVifRoute(name, vifIp).catch((e: unknown) =>
				core.logEvent(
					"warn",
					"Relay",
					`vif reply-route ${vifIp} dev ${name}: ${
						e instanceof Error ? e.message : String(e)
					}`,
				),
			);
		},
	});
	await relay.start();
	relays.set(name, relay);
	lastIfaceAddr.set(name, addr);
	failures.delete(name);
	return relay;
}

async function stopRelay(name: string): Promise<void> {
	const relay = relays.get(name);
	if (!relay) return;
	await relay.stop();
	relays.delete(name);
	lastIfaceAddr.delete(name);
	failures.delete(name);
	downIfaces.delete(name);
	void removeVifRoute(name);
}

// ----------------------------------------------------------------------
// Vif forward-path routing (dedicated table, never the main table)
// ----------------------------------------------------------------------
/**
 * Assign the dedicated routing table for `name`'s vif forward path. Derived
 * from the interface's position in the current eligible list — stable for the
 * life of a relay, and cleaned up on stop, so a later interface shift is
 * harmless.
 */
function vifTableFor(name: string): number {
	const ifaces = netIfaces?.list() ?? [];
	const eligible = eligibleInterfaces(ifaces, config());
	const idx = Math.max(0, eligible.indexOf(name));
	return VIF_TABLE_BASE + idx;
}

/**
 * Install the FORWARD-path route for a learned vif IP so the packets the relay
 * egresses *on behalf of* that vif (source = vif IP) are actually routable:
 *   - `${table}`: a source-AGNOSTIC `default dev <name>` route.
 *   - a `from <vifIp> lookup ${table}` rule.
 *
 * Why: the relay forwards whole IP packets out its physical interface with the
 * ORIGINAL (vif) source address intact. The host's normal default route is
 * source-pinned by DHCP (`... src <relayIp>`), so the kernel refuses to route
 * packets sourced `vifIp` — "Network is unreachable" → ICMP host-unreachable,
 * which kills the SRT handshake and leaves the leg at 0 kbps. A dedicated table
 * with a source-agnostic default plus a `from <vifIp>` rule gives vif-sourced
 * traffic a real egress without touching the main table. The reverse (OBS→vif)
 * needs no route: the raw tap (SO_RCVALL) captures it straight off the
 * interface. Best-effort throughout.
 */
async function installVifRoute(name: string, vifIp: string): Promise<void> {
	// Re-learn of a changed vif: tear down the previous one first.
	const prev = vifRoutes.get(name);
	if (prev && prev.vifIp !== vifIp) await removeVifRoute(name, prev);
	const table = vifTableFor(name);
	vifRoutes.set(name, { vifIp, table });
	const tableStr = String(table);
	// Source-agnostic default out this interface (on-link): works for a routed
	// NIC (nearest-hop / proxy-ARP) and for a WireGuard tunnel (single peer).
	await core
		.run(
			"ip",
			["route", "replace", "default", "dev", name, "table", tableStr],
			true,
		)
		.catch(routeWarn(name, vifIp, "route"));
	// `rule` has no `replace`: del the old one (idempotent) then add.
	await core
		.run("ip", ["rule", "del", "from", vifIp, "lookup", tableStr], true)
		.catch(routeWarn(name, vifIp, "rule-del"));
	await core
		.run("ip", ["rule", "add", "from", vifIp, "lookup", tableStr], true)
		.catch(routeWarn(name, vifIp, "rule-add"));
}

/** Tear down a vif forward-path route + rule. Best-effort, never throws. */
async function removeVifRoute(
	name: string,
	entry?: { vifIp: string; table: number },
): Promise<void> {
	const e = entry ?? vifRoutes.get(name);
	if (!e) return;
	vifRoutes.delete(name);
	const tableStr = String(e.table);
	await core
		.run("ip", ["rule", "del", "from", e.vifIp, "lookup", tableStr], true)
		.catch(routeWarn(name, e.vifIp, "rule-del"));
	await core
		.run("ip", ["route", "flush", "table", tableStr], true)
		.catch(routeWarn(name, e.vifIp, "flush"));
}

/** Build a consistent, non-fatal warning logger for a vif routing failure. */
function routeWarn(name: string, vifIp: string, what: string) {
	return (e: unknown) =>
		core.logEvent(
			"warn",
			"Relay",
			`vif ${what} ${vifIp} dev ${name}: ${
				e instanceof Error ? e.message : String(e)
			}`,
		);
}

/**
 * Interfaces this relay has OFFERED before: ever mapped a port, or ever ran a
 * relay. Drives which `interface_added` / `interface_removed` events fire —
 * an interface first announced for the snapshot is not re-announced as
 * "added" (protocol.md §4).
 */
const seenIfaces = new Set<string>();
function markSeen(name: string): void {
	seenIfaces.add(name);
}

/** Rebuild the "seen" set after a process restart (from persisted mappings).
 * Exported for tests (to reset the history between cases). */
export function reseedSeen(): void {
	seenIfaces.clear();
	for (const name of Object.keys(config().portMap)) seenIfaces.add(name);
}

const ifaceInfo = (
	name: string,
	ifaces: Array<{ name: string; addresses: string[] }>,
): { addr: string; port: number } => ({
	addr: ifaceAddress(name, ifaces) ?? "",
	port: allocatePort(name),
});

/**
 * Bring every eligible interface's relay up to the current config. Idempotent.
 * A per-interface failure is logged and does not stop the others.
 *
 * Port and state semantics (protocol.md §1/§4):
 *  - ports come from the persisted high-water-mark mapping (`allocatePort`)
 *    — an added interface never reindexes the existing ones;
 *  - an ABSENT interface that was offered before is removed (mapping freed,
 *    `interface_removed`);
 *  - a PRESENT interface with no usable path (no IPv4, carrier down, or a
 *    failed bind) is marked DOWN — its mapping is kept, `interface_down`;
 *  - a DOWN interface whose path returned is started on its KEEP port and
 *    reported `interface_up`;
 *  - an interface first seen THIS process is started silently (it goes out
 *    in the WS snapshot / announce, not as `interface_added`).
 *
 * The emitted events are returned (and must be forwarded to the connected
 * encoders by the caller — see `startEncoderChannels`).
 */
export async function syncRelays(rollbackOnFailure = false): Promise<{
	started: string[];
	stopped: string[];
	failures: MoblinkRelayFailure[];
	events: Array<{ type: MoblinkRelayIfaceEventType; iface: MoblinkRelayIface }>;
}> {
	const cfg = config();
	const ifaces = netIfaces.list();
	const eligible = new Set(eligibleInterfaces(ifaces, cfg));
	const started: string[] = [];
	const stopped: string[] = [];
	const failuresOut: MoblinkRelayFailure[] = [];
	const events: Array<{
		type: MoblinkRelayIfaceEventType;
		iface: MoblinkRelayIface;
	}> = [];
	/** Relays started by THIS pass — rolled back if a later one fails (spec §10.3). */
	const startedThisPass: string[] = [];

	// Interfaces no longer eligible: stop the relay, free the mapping
	// (protocol.md §1: removals do not reindex the other ports).
	for (const name of [...relays.keys(), ...downIfaces.keys()]) {
		if (!eligible.has(name)) {
			await stopRelay(name);
			stopped.push(name);
			if (seenIfaces.has(name)) {
				const { addr, port } = ifaceInfo(name, ifaces);
				events.push({
					type: "interface_removed",
					iface: {
						iface_name: name,
						ip: addr,
						udp_port: port,
						state: "down",
						uplink: true,
					},
				});
			}
			freePort(name);
			failures.delete(name);
			seenIfaces.delete(name);
		}
	}

	// Start / update relays for eligible interfaces.
	for (const name of [...eligible]) {
		const addr = ifaceAddress(name, ifaces, cfg);
		const port = allocatePort(name);
		const existed = seenIfaces.has(name);
		markSeen(name);
		if (!addr) {
			// No IPv4: mark down (mapping kept), report the transition.
			failures.set(name, "no IPv4 address");
			failuresOut.push({ interfaceName: name, reason: "no IPv4 address" });
			if (existed) {
				await stopRelay(name);
				downIfaces.set(name, {});
				events.push({
					type: "interface_down",
					iface: {
						iface_name: name,
						ip: "",
						udp_port: port,
						state: "down",
						uplink: true,
					},
				});
			}
			core.logEvent("warn", "Relay", `no IPv4 on ${name}`);
			continue;
		}
		// Carrier down: mark down (mapping kept), report the transition.
		if (!carrierUp(name)) {
			failures.set(name, "interface is down");
			failuresOut.push({ interfaceName: name, reason: "interface is down" });
			if (existed) {
				await stopRelay(name);
				downIfaces.set(name, {});
				events.push({
					type: "interface_down",
					iface: {
						iface_name: name,
						ip: addr,
						udp_port: port,
						state: "down",
						uplink: true,
					},
				});
			}
			core.logEvent("warn", "Relay", `${name} is down — port ${port} kept`);
			continue;
		}
		const existing = relays.get(name);
		const existingAddr = lastIfaceAddr.get(name);
		if (existing && existingAddr === addr) continue; // already correct
		const wasDown = !existing && (existed || downIfaces.has(name));
		if (existing) {
			// Interface address changed: restart on the SAME (kept) port.
			await stopRelay(name);
		}
		try {
			await startRelay(name, addr, port);
			started.push(name);
			startedThisPass.push(name);
			if (wasDown)
				events.push({
					type: "interface_up",
					iface: {
						iface_name: name,
						ip: addr,
						udp_port: port,
						state: "up",
						uplink: true,
					},
				});
			else if (existed)
				events.push({
					type: "interface_added",
					iface: {
						iface_name: name,
						ip: addr,
						udp_port: port,
						state: "up",
						uplink: true,
					},
				});
		} catch (e) {
			const reason = errorMessage(e);
			failures.set(name, reason);
			failuresOut.push({ interfaceName: name, reason });
			if (existed) {
				downIfaces.set(name, { reason });
				events.push({
					type: "interface_down",
					iface: {
						iface_name: name,
						ip: addr,
						udp_port: port,
						state: "down",
						uplink: true,
					},
				});
			}
			if (rollbackOnFailure) {
				// A start is atomic: a failure stops the relays this pass brought up.
				for (const s of startedThisPass) await stopRelay(s);
				startedThisPass.length = 0;
				started.length = 0;
				// stopRelay() clears the rolled-back entries; re-record this one.
				failures.set(name, reason);
				core.logEvent(
					"error",
					"Relay",
					`start ${name} failed — rolled back: ${reason}`,
				);
				core.notifyStateChange();
				await writeStatusFile();
				throw new ApiError(`cannot start relay on ${name}: ${reason}`, 409);
			}
			core.logEvent("error", "Relay", `start ${name}: ${reason}`);
		}
	}

	core.notifyStateChange();
	await writeStatusFile();
	return { started, stopped, failures: failuresOut, events };
}

async function stopAll(): Promise<void> {
	for (const name of [...relays.keys()]) await stopRelay(name);
	// Sweep any vif reply-routes whose relay left the map (defensive: stopRelay
	// already clears most of these, a re-learn race can linger).
	for (const name of [...vifRoutes.keys()]) await removeVifRoute(name);
	downIfaces.clear();
	failures.clear();
	core.notifyStateChange();
	await writeStatusFile();
}

/** A network interface set changed: resync + forward the interface events. */
async function onNetworkChange(): Promise<void> {
	if (relays.size === 0 && downIfaces.size === 0) return;
	const { events } = await syncRelays();
	pushIfaceEvents(events);
}

// ----------------------------------------------------------------------
// Encoder discovery + relay → encoder WebSocket channels (protocol.md §2–§5)
// ----------------------------------------------------------------------
/** The relay identity sent in the WS hello (hostnames change when the
 * box is renamed; that is acceptable — encoders track the session, not us). */
const RELAY_ID = hostname() || "irlctrl-relay";

/** Reconnect backoff for a dropped relay → encoder WebSocket. */
const ENCODER_WS_RECONNECT_MS = 5_000;

interface EncoderChannel {
	ws: WebSocket;
	gen: number;
	timer?: ReturnType<typeof setTimeout>;
}
/** The live relay → encoder channels, keyed by `encoder_id` (announces are
 * re-sent periodically, so the key is stable). */
const encoderChannels = new Map<string, EncoderChannel>();
/** A pending connect (so overlapping reconciles never open two sockets). */
const pendingConnects = new Set<string>();

/** The full snapshot message (protocol.md §3/§4: sent on every (re)connect). */
function helloMessage(): MoblinkRelayWsMessage {
	return {
		type: "hello",
		relay_id: RELAY_ID,
		proto: MOBLINK_RELAY_WS_PROTOCOL,
		interfaces: relayIfaceList(),
	};
}

function closeEncoderChannel(key: string, gen: number): void {
	const st = encoderChannels.get(key);
	if (!st || st.gen !== gen) return; // already replaced / stopped
	if (st.timer) clearTimeout(st.timer);
	encoderChannels.delete(key);
	try {
		st.ws.close();
	} catch {
		/* already closed */
	}
}

function stopEncoderChannel(key: string): void {
	const st = encoderChannels.get(key);
	if (st) closeEncoderChannel(key, st.gen);
	pendingConnects.delete(key);
}

/**
 * Dial the encoder's WebSocket server (protocol.md §3: the encoder is the
 * server, the relay the client) and send the full snapshot. Failed connects
 * retry with a backoff while the encoder is still known.
 */
function startEncoderChannel(e: MoblinkDiscoveredEncoder): void {
	if (pendingConnects.has(e.encoderId)) return;
	pendingConnects.add(e.encoderId);
	const gen = (encoderChannels.get(e.encoderId)?.gen ?? 0) + 1;
	const url = `ws://${e.ip}:${e.wsPort}/moblink${
		e.token ? `?token=${encodeURIComponent(e.token)}` : ""
	}`;
	let ws: WebSocket;
	try {
		ws = new WebSocket(url);
	} catch {
		pendingConnects.delete(e.encoderId);
		return;
	}
	const st: EncoderChannel = { ws, gen };
	encoderChannels.set(e.encoderId, st);
	ws.onopen = (): void => {
		pendingConnects.delete(e.encoderId);
		// Full snapshot on (re)connect — the encoder has a consistent view.
		st.ws.send(JSON.stringify(helloMessage()));
		console.log(
			`moblink_relay: WS connected to encoder ${e.encoderId} — snapshot sent (${relayIfaceList().length} iface(s))`,
		);
	};
	const fail = (why: string): void => {
		if (encoderChannels.get(e.encoderId) !== st) return; // replaced
		closeEncoderChannel(e.encoderId, st.gen);
		if (knownEncoders().some((x) => x.encoderId === e.encoderId)) {
			console.warn(
				`moblink_relay: WS to encoder ${e.encoderId} lost (${why}) — retrying in ${ENCODER_WS_RECONNECT_MS / 1000}s`,
			);
			st.timer = setTimeout(
				() => startEncoderChannel(e),
				ENCODER_WS_RECONNECT_MS,
			);
			st.timer.unref?.();
		}
	};
	ws.onerror = (): void => {}; // the close handler carries the reason
	ws.onclose = (ev): void => fail(ev.reason || "closed");
}

/**
 * Reconcile the channel set to the known encoders: start missing, stop the
 * ones we stopped hearing (or that left the registry).
 */
function reconcileEncoderChannels(): void {
	for (const enc of knownEncoders()) startEncoderChannel(enc);
	for (const key of [...encoderChannels.keys()]) {
		if (!knownEncoders().some((e) => e.encoderId === key))
			stopEncoderChannel(key);
	}
}

/**
 * Control-server path (protocol.md §2.2): ask the control server for
 * registered encoders and hand them to the encoder registry. Best-effort —
 * a down / unreachable control server must never block UDP discovery.
 * Throttled to one poll per 30 s.
 */
const CONTROL_SERVER_INTERVAL_MS = 30_000;
/** Reset the control-server poll throttle (tests — the timestamp persists across cases). */
export function resetControlServerCheck(): void {
	lastControlServerCheck = 0;
}
async function ensureControlServerEncoders(): Promise<void> {
	if (Date.now() - lastControlServerCheck < CONTROL_SERVER_INTERVAL_MS) return;
	lastControlServerCheck = Date.now();
	if (core.config.DRY_RUN) return;
	try {
		const devs = await core.listDevices();
		for (const d of devs) {
			if (d.role !== "encoder" || !d.online) continue;
			const id = d.hostname ?? d.id;
			if (knownEncoders().some((x) => x.encoderId === id)) continue;
			const info = (await core.requestDevice(
				d.id,
				"moblink_streamer.encoderInfo",
			)) as { ip?: string; wsPort?: number; token?: string } | null;
			if (!info?.ip || !info.wsPort) continue;
			noteEncoder({
				encoderId: id,
				ip: info.ip,
				wsPort: info.wsPort,
				proto: MOBLINK_RELAY_WS_PROTOCOL,
				token: info.token,
				lastSeen: Date.now(),
			});
			const enc = knownEncoders().find((x) => x.encoderId === id);
			if (enc) startEncoderChannel(enc);
		}
	} catch {
		/* control server down or link closed — UDP discovery keeps working */
	}
}

/** Forward interface change events to every connected encoder (§4). */
export function pushIfaceEvents(
	events: Array<{ type: MoblinkRelayIfaceEventType; iface: MoblinkRelayIface }>,
): void {
	for (const ev of events) {
		const msg = JSON.stringify({ type: ev.type, iface: ev.iface });
		for (const [key, st] of encoderChannels) {
			try {
				if (st.ws.readyState === WebSocket.OPEN) st.ws.send(msg);
			} catch (e) {
				console.warn(
					`moblink_relay: WS send to ${key} failed: ${errorMessage(e)}`,
				);
			}
		}
	}
}

/**
 * An encoder (re-)announced itself (UDP discovery) — dial it if new.
 * Exposed for tests.
 */
export function onEncoderAnnounced(e: MoblinkDiscoveredEncoder): void {
	if (!encoderChannels.has(e.encoderId) && !pendingConnects.has(e.encoderId))
		startEncoderChannel(e);
}

/** Stop all relay → encoder channels (module stop). */
export function stopEncoderChannels(): void {
	for (const key of [...encoderChannels.keys()]) stopEncoderChannel(key);
	pendingConnects.clear();
}

/**
 * Start encoder discovery (protocol.md §2): the UDP-announce listener on the
 * well-known port + the TTL sweep / control-server reconciler. Idempotent.
 */
function startDiscovery(): void {
	startListeningForEncoders(onEncoderAnnounced, {
		dryRun: core.config.DRY_RUN,
	});
	if (!encoderSweep) {
		encoderSweep = setInterval(() => {
			sweepEncoders();
			reconcileEncoderChannels();
			void ensureControlServerEncoders();
		}, MOBLINK_ANNOUNCE_INTERVAL_MS);
		encoderSweep.unref?.();
	}
}

/** Stop encoder discovery and tear down every relay → encoder channel. */
function stopDiscovery(): void {
	stopListeningForEncoders();
	if (encoderSweep) {
		clearInterval(encoderSweep);
		encoderSweep = undefined;
	}
	stopEncoderChannels();
}

// ----------------------------------------------------------------------
// Registration
// ----------------------------------------------------------------------
const registration: BackendModule<ModuleCore> = {
	kind: "device",
	id: "moblink_relay",
	title: "Moblink Relay",
	roleDefinitions: [
		{
			id: "moblink_relay",
			titleKey: "role.moblink_relay",
			taglineKey: "setup.role.moblink_relay_tag",
			order: 50,
			default: false,
			setupSelectable: true,
		},
	],
	roles: ["moblink_relay"],
	/** Opt-in: never auto-forward on devices upgrading (spec §7.4). */
	enabledByDefault: false,
	/** Depends on the network module for the interface list + uplinks file. */
	dependencies: ["network"],
	methods: [
		"moblink_relay.start",
		"moblink_relay.stop",
		"moblink_relay.status",
		"moblink_relay.getConfig",
		"moblink_relay.setConfig",
	],
	events: ["moblink_relay.stats"],
	configDefaults: {
		enabled: false,
		listenPortBase: 4000,
		interfaceAllow: [],
		interfaceIgnore: ["docker.*", "veth.*"],
		interfaceNameOverrides: {},
		logLevel: "info",
	},
	log,
	bind(c) {
		core = c;
		netIfaces = requireCapability<NetworkInterfaces>("network.interfaces");
		// Bind-time validation only: the relay needs the network uplinks
		// capability to exist (TUN IPs surface through it) but never calls it.
		requireCapability<Uplinks>("network.uplinks");
	},
	/**
	 * `modules.configure`: persist the settings-page fields to the module slice.
	 * Without this hook the settings page would only save `enabled`. The core
	 * restarts the module afterwards, so a port-base change
	 * re-syncs the relays (spec §5.4).
	 */
	configure(patch, s) {
		const next: Partial<MoblinkRelayConfig> = {};
		if (typeof patch.enabled === "boolean") {
			next.enabled = patch.enabled;
			s.enabled = patch.enabled;
		}
		if (typeof patch.nat === "boolean") next.nat = patch.nat;
		if (typeof patch.announceHost === "string")
			next.announceHost = patch.announceHost.trim();
		if (typeof patch.listenPortBase === "number")
			next.listenPortBase = patch.listenPortBase;
		if (Array.isArray(patch.interfaceAllow))
			next.interfaceAllow = (patch.interfaceAllow as string[]).filter(
				(v) => typeof v === "string",
			);
		if (Array.isArray(patch.interfaceIgnore))
			next.interfaceIgnore = (patch.interfaceIgnore as string[]).filter(
				(v) => typeof v === "string",
			);
		if (typeof patch.logLevel === "string")
			next.logLevel = patch.logLevel as MoblinkRelayConfig["logLevel"];
		if (Object.keys(next).length > 0) saveConfig(next);
	},
	async start(ctx) {
		core = ctx.core;
		// Make sure the interface monitor is running (it may not be if the
		// network module's slice is disabled on this role).
		await netIfaces.ensureMonitoring();
		netUnsub = netIfaces.onChanged(() => void onNetworkChange());
		// Interface history: an interface that got a port mapping before this
		// process started must not be re-announced as `interface_added` — it
		// goes out in the WS snapshot (protocol.md §4).
		reseedSeen();
		// Learn encoders (protocol.md §2): UDP announces on the discovery
		// port + a throttled control-server lookup. The listener callback
		// dials each new encoder's WebSocket; the sweep drops encoders that
		// stop announcing and reconciles the channel set.
		if (config().enabled) startDiscovery();
		// Autostart if the slice is enabled. Best-effort: a single interface's
		// bind conflict must not crash the client on boot — the failed interface
		// is recorded in status (`failures`) and the others keep running.
		if (config().enabled) {
			const res = await syncRelays(false);
			pushIfaceEvents(res.events);
			if (res.started.length > 0)
				startAnnouncing(announcePayload, {
					dryRun: core.config.DRY_RUN,
				});
			void ensureControlServerEncoders();
		}
	},
	async stop() {
		netUnsub?.();
		netUnsub = undefined;
		stopAnnouncing();
		stopDiscovery();
		await stopAll();
	},
	async status() {
		return {
			state: {
				moblink: buildStatus() as unknown as MoblinkRelayState,
			},
		};
	},
	async dispatch(method: string, p: Params) {
		switch (method) {
			case "moblink_relay.status":
				return { moblink: buildStatus() };
			case "moblink_relay.getConfig":
				return { config: config() };
			case "moblink_relay.start": {
				core.cancelAutostart();
				const patch: Partial<MoblinkRelayConfig> = {};
				if (p.announceHost !== undefined && p.announceHost !== "") {
					patch.announceHost = requireHost(p, "announceHost");
				}
				if (Object.keys(patch).length > 0) saveConfig(patch);
				saveConfig({ enabled: true });
				startDiscovery();
				void ensureControlServerEncoders();
				// Best-effort: never throw on a per-interface bind conflict — the
				// failed interface is surfaced in `moblink.failures`, others run.
				const result = await syncRelays(false);
				pushIfaceEvents(result.events);
				if (result.started.length > 0)
					startAnnouncing(announcePayload, {
						dryRun: core.config.DRY_RUN,
					});
				return { moblink: buildStatus(), ...result };
			}
			case "moblink_relay.stop":
				core.cancelAutostart();
				saveConfig({ enabled: false });
				stopAnnouncing();
				stopDiscovery();
				await stopAll();
				return { moblink: buildStatus() };
			case "moblink_relay.setConfig": {
				const patch: Partial<MoblinkRelayConfig> = {};
				if (p.enabled !== undefined)
					patch.enabled = requireBoolean(p, "enabled");
				if (p.announceHost !== undefined) {
					const ip = String(p.announceHost).trim();
					patch.announceHost = ip === "" ? "" : requireHost(p, "announceHost");
				}
				if (p.listenPortBase !== undefined) {
					const base = Number(p.listenPortBase);
					if (!Number.isInteger(base) || base < 1 || base > 65535)
						throw new ApiError("listenPortBase out of range", 400);
					patch.listenPortBase = base;
				}
				if (p.interfaceAllow !== undefined)
					patch.interfaceAllow = optionalStringList(p, "interfaceAllow") ?? [];
				if (p.interfaceIgnore !== undefined)
					patch.interfaceIgnore =
						optionalStringList(p, "interfaceIgnore") ?? [];
				if (p.interfaceNameOverrides !== undefined) {
					const overrides = p.interfaceNameOverrides as Record<string, unknown>;
					if (typeof overrides !== "object" || overrides === null)
						throw new ApiError("interfaceNameOverrides must be an object", 400);
					patch.interfaceNameOverrides = Object.fromEntries(
						Object.entries(overrides).map(([k, v]) => [k, String(v)]),
					);
				}
				if (p.runtimeStatusFile !== undefined) {
					const path = String(p.runtimeStatusFile);
					if (!path.startsWith("/"))
						throw new ApiError(
							"runtimeStatusFile must be an absolute path",
							400,
						);
					patch.runtimeStatusFile = path;
				}
				if (p.logLevel !== undefined) {
					const level = String(p.logLevel);
					if (!["trace", "debug", "info", "warn", "error"].includes(level))
						throw new ApiError("invalid logLevel", 400);
					patch.logLevel = level as MoblinkRelayConfig["logLevel"];
				}
				saveConfig(patch);
				// Restart affected relays if the config that affects them changed.
				if (
					patch.listenPortBase !== undefined ||
					patch.interfaceAllow !== undefined ||
					patch.interfaceIgnore !== undefined ||
					patch.interfaceNameOverrides !== undefined
				) {
					if (config().enabled) await syncRelays();
					else await stopAll();
				}
				return { config: config(), moblink: buildStatus() };
			}
			default:
				throw new ApiError(`unknown method ${method}`, 404);
		}
	},
};

export default registration;
