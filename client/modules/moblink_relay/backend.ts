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
 */
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
import { t } from "../../../shared/i18n";
import {
    createUdpRelay,
    type IfaceRawSocket,
    type UdpRelay,
} from "../../../shared/lib/udp_relay";
import type { MoblinkAnnounce } from "../../../shared/moblink_discovery";
import {
    ApiError,
    optionalStringList,
    requireBoolean,
    requireHost,
} from "../../../shared/params";
import { errorMessage } from "../../../shared/util";
import type { ModuleCore } from "../../backend/module_core";
import { startAnnouncing, stopAnnouncing } from "./discovery";
import log from "./log";
import type {
    MoblinkAvailableInterface,
    MoblinkRelayConfig,
    MoblinkRelayFailure,
    MoblinkRelayState,
    MoblinkRuntimeStatus,
} from "./types";

// ----------------------------------------------------------------------
// Config (the `ctx.state.moblink` slice)
// ----------------------------------------------------------------------
const DEFAULTS: Required<Omit<MoblinkRelayConfig, "interfaceNameOverrides">> & {
    interfaceNameOverrides: Record<string, string>;
} = {
    enabled: false,
    announceHost: "",
    listenPortBase: 4000,
    interfaceAllow: [],
    interfaceIgnore: ["docker.*", "veth.*"],
    interfaceNameOverrides: {},
    runtimeStatusFile: join(tmpdir(), "moblink-status.json"),
    logLevel: "info",
};

let core: ModuleCore;
let emit: Parameters<BackendModule["start"]>[0]["emit"] | undefined;

let netIfaces: NetworkInterfaces;
let uplinks: Uplinks;
let netUnsub: (() => void) | undefined;

/** The running per-interface relays, keyed by interface name. */
const relays = new Map<string, UdpRelay>();
/** The last interface address each relay was created for (hotplug detection). */
const lastIfaceAddr = new Map<string, string>();
/** Interfaces that failed to start (name → reason), surfaced in status/card. */
const failures = new Map<string, string>();

/** Read the merged config slice (defaults backfilled on first read). */
function config(): Required<
    Omit<MoblinkRelayConfig, "interfaceNameOverrides">
> & { interfaceNameOverrides: Record<string, string> } {
    const raw = (core.state.data.moblink ?? {}) as Partial<MoblinkRelayConfig>;
    return {
        enabled: raw.enabled ?? DEFAULTS.enabled,
        announceHost: raw.announceHost ?? DEFAULTS.announceHost,
        listenPortBase: raw.listenPortBase ?? DEFAULTS.listenPortBase,
        interfaceAllow: raw.interfaceAllow ?? DEFAULTS.interfaceAllow,
        interfaceIgnore: raw.interfaceIgnore ?? DEFAULTS.interfaceIgnore,
        interfaceNameOverrides:
            raw.interfaceNameOverrides ?? DEFAULTS.interfaceNameOverrides,
        runtimeStatusFile: raw.runtimeStatusFile ?? DEFAULTS.runtimeStatusFile,
        logLevel: raw.logLevel ?? DEFAULTS.logLevel,
    };
}

/** Persist the full config slice (for a stable state file). */
function saveConfig(
    patch: Partial<MoblinkRelayConfig>,
): ReturnType<typeof config> {
    const next = { ...config(), ...patch };
    core.state.data.moblink = {
        ...next,
        relayIds: (core.state.data.moblink as Record<string, unknown>)
            ?.relayIds as Record<string, string> | undefined,
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

function buildStatus(): MoblinkRuntimeStatus {
    const cfg = config();
    const ifaces = netIfaces?.list() ?? [];
    const availableInterfaces = eligibleInterfaces(ifaces, cfg).map(
        (name, i) => ({
            name,
            address: ifaceAddress(name, ifaces, cfg) ?? "",
            listenPort: cfg.listenPortBase + i,
        }),
    );
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
    return {
        connected: relays.size > 0,
        announceHost: effectiveAnnounceHost(),
        availableInterfaces,
        relays: relaysArr,
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
    const ifaces = buildStatus().availableInterfaces;
    if (ifaces.length === 0) return null;
    // The advertised host: manual override if set, else the auto-detected LAN
    // address. The encoder dials this as the relay host.
    const host = effectiveAnnounceHost() || ifaces[0].address;
    if (!host) return null;
    // Every tunnel is advertised on the advertise IP (relayHost) with port
    // base+index — not the IP of the interface the relay binds to locally.
    return {
        v: 1,
        host,
        hostname: hostname(),
        interfaces: ifaces.map((i) => ({
            name: i.name,
            address: host,
            listenPort: i.listenPort,
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
    const relay = await createUdpRelay({
        interfaceName: name,
        listenPort,
        interfaceAddress: addr,
        ifaceSocket: ifaceSocketFactory?.(name),
        // When the relay learns the vif IP an encoder bridges through this
        // interface, install a `/32` route so any reply the local receiver
        // sends to that vif IP egresses through the same interface (the raw
        // tap only sees ingress, so host-local return traffic needs the route).
        // Best-effort: a routing failure must not break the relay itself.
        onVifLearned: (vifIp) => {
            void core
                .run("ip", ["route", "replace", `${vifIp}/32`, "dev", name], true)
                .catch((e: unknown) =>
                    core.logEvent(
                        "warn",
                        "Relay",
                        `vif route ${vifIp} dev ${name}: ${
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
}

/**
 * Bring every eligible interface's relay up to the current config. Idempotent.
 * A per-interface failure is logged and does not stop the others.
 */
export async function syncRelays(rollbackOnFailure = false): Promise<{
    started: string[];
    stopped: string[];
    failures: MoblinkRelayFailure[];
}> {
    const cfg = config();
    const ifaces = netIfaces.list();
    const eligible = eligibleInterfaces(ifaces, cfg);
    const started: string[] = [];
    const stopped: string[] = [];
    const failuresOut: MoblinkRelayFailure[] = [];
    /** Relays started by THIS pass — rolled back if a later one fails (spec §10.3). */
    const startedThisPass: string[] = [];

    // Stop relays for interfaces that are no longer eligible.
    for (const name of [...relays.keys()]) {
        if (!eligible.includes(name)) {
            await stopRelay(name);
            stopped.push(name);
        }
    }

    // Start / update relays for eligible interfaces.
    for (const [i, name] of eligible.entries()) {
        const addr = ifaceAddress(name, ifaces, cfg);
        if (!addr) {
            core.logEvent("warn", "Relay", `no IPv4 on ${name}`);
            continue;
        }
        const listenPort = cfg.listenPortBase + i;
        const existing = relays.get(name);
        const existingAddr = lastIfaceAddr.get(name);
        if (existing && existingAddr === addr) continue; // already correct
        if (existing) {
            // Interface address changed: restart with the new address.
            await stopRelay(name);
        }
        try {
            await startRelay(name, addr, listenPort);
            started.push(name);
            startedThisPass.push(name);
        } catch (e) {
            const reason = errorMessage(e);
            failures.set(name, reason);
            failuresOut.push({ interfaceName: name, reason });
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
                throw new ApiError(
                    `cannot start relay on ${name}: ${reason}`,
                    409,
                );
            }
            core.logEvent("error", "Relay", `start ${name}: ${reason}`);
        }
    }

    core.notifyStateChange();
    await writeStatusFile();
    return { started, stopped, failures: failuresOut };
}

async function stopAll(): Promise<void> {
    for (const name of [...relays.keys()]) await stopRelay(name);
    core.notifyStateChange();
    await writeStatusFile();
}

/** A network interface set changed: resync the affected relays. */
async function onNetworkChange(): Promise<void> {
    if (relays.size === 0) return;
    await syncRelays();
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
        uplinks = requireCapability<Uplinks>("network.uplinks");
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
        emit = ctx.emit;
        // Make sure the interface monitor is running (it may not be if the
        // network module's slice is disabled on this role).
        await netIfaces.ensureMonitoring();
        netUnsub = netIfaces.onChanged(() => void onNetworkChange());
        // Autostart if the slice is enabled. Best-effort: a single interface's
        // bind conflict must not crash the client on boot — the failed interface
        // is recorded in status (`failures`) and the others keep running.
        if (config().enabled) {
            const res = await syncRelays(false);
            if (res.started.length > 0)
                startAnnouncing(announcePayload, {
                    dryRun: core.config.DRY_RUN,
                });
        }
    },
    async stop() {
        netUnsub?.();
        netUnsub = undefined;
        stopAnnouncing();
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
                // Best-effort: never throw on a per-interface bind conflict — the
                // failed interface is surfaced in `moblink.failures`, others run.
                const result = await syncRelays(false);
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
                await stopAll();
                return { moblink: buildStatus() };
            case "moblink_relay.setConfig": {
                const patch: Partial<MoblinkRelayConfig> = {};
                if (p.enabled !== undefined)
                    patch.enabled = requireBoolean(p, "enabled");
                if (p.announceHost !== undefined) {
                    const ip = String(p.announceHost).trim();
                    patch.announceHost =
                        ip === "" ? "" : requireHost(p, "announceHost");
                }
                if (p.listenPortBase !== undefined) {
                    const base = Number(p.listenPortBase);
                    if (!Number.isInteger(base) || base < 1 || base > 65535)
                        throw new ApiError("listenPortBase out of range", 400);
                    patch.listenPortBase = base;
                }
                if (p.interfaceAllow !== undefined)
                    patch.interfaceAllow =
                        optionalStringList(p, "interfaceAllow") ?? [];
                if (p.interfaceIgnore !== undefined)
                    patch.interfaceIgnore =
                        optionalStringList(p, "interfaceIgnore") ?? [];
                if (p.interfaceNameOverrides !== undefined) {
                    const overrides = p.interfaceNameOverrides as Record<
                        string,
                        unknown
                    >;
                    if (typeof overrides !== "object" || overrides === null)
                        throw new ApiError(
                            "interfaceNameOverrides must be an object",
                            400,
                        );
                    patch.interfaceNameOverrides = Object.fromEntries(
                        Object.entries(overrides).map(([k, v]) => [
                            k,
                            String(v),
                        ]),
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
                    if (
                        !["trace", "debug", "info", "warn", "error"].includes(
                            level,
                        )
                    )
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
