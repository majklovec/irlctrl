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
 */
import { writeFileSync } from "node:fs";
import { requireCapability } from "../../../shared/capabilities";
import type { BackendModule, Params } from "../../../shared/contracts/backend_module";
import type {
    MoblinkRegistry,
    Uplinks,
} from "../../../shared/contracts/module_capabilities";
import { errorMessage } from "../../../shared/util";
import { createVirtualInterface, type VirtualInterface } from "@irlctrl/udp-relay";
import { defaultSourceIp } from "../../../shared/srtla";
import {
    ApiError,
    oneOf,
    optionalInt,
    requireBoolean,
    requireString,
} from "../../../shared/params";
import type { ModuleCore } from "../../backend/module_core";
import {
    knownRelays,
    startDiscovering,
    stopDiscovering,
} from "./discovery";
import log from "./log";
import {
    type MoblinkLogLevel,
    type MoblinkStreamerConfig,
    type MoblinkStreamerRelayStatus,
    type MoblinkStreamerRuntimeStatus,
    type MoblinkStreamerStatusFile,
    type MoblinkStreamerTunnelStatus,
    type MoblinkStreamerView,
} from "./types";
import type { MoblinkDiscoveredRelay } from "../../../shared/moblink_discovery";

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
function slotFor(key: string, relayHost: string, ifaceName: string): {
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
        writeFileSync(config().runtimeStatusFile, JSON.stringify(statusFile(), null, 2));
    } catch (e) {
        console.warn(`moblink_streamer: status file write failed: ${errorMessage(e)}`);
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
    const c = config();
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
        for (const ep of r.interfaces)
            add(ep.address || r.host, ep.listenPort, r.host, ep.name);
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
    tunSlots.delete(key);
    if (t.uplinkId) {
        try {
            await uplinks.remove(t.uplinkId);
        } catch (e) {
            console.warn(`moblink_streamer: uplink remove failed: ${errorMessage(e)}`);
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
                console.warn(`moblink_streamer: stop ${key} failed: ${errorMessage(e)}`);
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
    // begins at relay0link0 again (individual stops in reconcile must NOT).
    // `tunSlots` is emptied per-stop in `stopTunnel`, so clear only the counters.
    relayOrdinal.clear();
    relayIfcSeen.clear();
    relaySeq = 0;
    core.notifyStateChange();
    writeStatusFile();
}

// ----------------------------------------------------------------------
// Discovery wiring
// ----------------------------------------------------------------------
/** Mirror the discovered relays to the network card's per-relay grouping. */
function syncRegistry(relays: MoblinkDiscoveredRelay[]): void {
    try {
        const seen = new Set(relays.map((r) => r.host));
        // Drop stale registry entries no longer present.
        for (const r of moblinkReg.listRelays()) {
            if (!seen.has(r.host)) moblinkReg.dropRelay(r.host);
        }
        for (const r of relays) {
            moblinkReg.upsertRelay({
                host: r.host,
                hostname: r.hostname,
                interfaces: r.interfaces,
            });
        }
    } catch (e) {
        console.warn(`moblink_streamer: registry sync failed: ${errorMessage(e)}`);
    }
}

/** A discovery shape change: re-sync the registry + reconcile the TUNs.
 *
 * The card must list discovered relays as soon as they appear, so the state
 * is pushed immediately — `reconcile()` already notifies when running, so
 * only the idle path needs its own push.
 */
async function onDiscoveredRelays(relays: MoblinkDiscoveredRelay[]): Promise<void> {
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

function ensureDiscovery(): void {
    // Always wire the change callback: it also serves as the registration
    // path for relays handed over via the control server (`noteRelay`). In
    // dry-run the UDP socket is skipped, but relaying still converges.
    startDiscovering((rels) => void onDiscoveredRelays(rels), { dryRun: core.config.DRY_RUN });
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
    ],
    events: [],
    log,
    /**
     * `modules.configure`: persist the settings-page fields to the module
     * section. The core then restarts the module, so a relay/endpoint change
     * re-reconciles the TUNs (spec §6.3). Only present fields are touched.
     */
    configure(patch, s) {
        const c = config();
        const next: MoblinkStreamerConfig = { ...c };
        if (typeof patch.prefixLength === "number") next.prefixLength = patch.prefixLength;
        if (typeof patch.mtu === "number") next.mtu = patch.mtu;
        if (typeof patch.keepaliveIntervalMs === "number")
            next.keepaliveIntervalMs = patch.keepaliveIntervalMs;
        if (typeof patch.autoRegisterUplink === "boolean")
            next.autoRegisterUplink = patch.autoRegisterUplink;
        if (typeof patch.runtimeStatusFile === "string")
            next.runtimeStatusFile = patch.runtimeStatusFile;
        if (typeof patch.logLevel === "string") next.logLevel = patch.logLevel as MoblinkLogLevel;
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
        try {
            await reconcile();
        } catch (e) {
            core.logEvent("warn", "Relay tunnels", `autostart failed: ${errorMessage(e)}`);
        }
    },
    async stop() {
        stopDiscovering();
        await stopAllTunnels();
    },
    /** Resume the TUNs across process restarts. */
    async resume() {
        ensureDiscovery();
        syncRegistry(knownRelays());
        if (!isRunning()) await reconcile();
        return true;
    },
    async dispatch(method: string, p: Params) {
        switch (method) {
            case "moblink_streamer.status":
                return view();
            case "moblink_streamer.getConfig":
                return { config: config() };
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
