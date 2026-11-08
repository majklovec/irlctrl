/*
 * srtla module: srtla_send process management — start / stop / reload (SIGHUP
 * or restart), the scheduler options applied over the control socket
 * (control.ts) and the per-link stats push.
 *
 * The bonding / uplinks-file layer lives in the network module: this module
 * points `srtla_send` at the `network.uplinks` file and reloads on change.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { argEnv, argv, enumArgEnv, intArgEnv } from "../../../shared/args";
import type {
    BackendModule,
    Emit,
    Params,
} from "../../../shared/contracts/backend_module";
import { t } from "../../../shared/i18n";
import {
    ApiError,
    oneOf,
    requireBoolean,
    requireHost,
    requirePort,
    requireString,
} from "../../../shared/params";
import {
    srtlaRecArgs,
    srtlaSendCapabilities,
    srtlaSendFlags,
    waitForUdpPort,
} from "../../../shared/srtla";
import { errorMessage } from "../../../shared/util";
import { requireCapability } from "../../../shared/capabilities";
import type { ModuleCore } from "../../backend/module_core";
import type { Uplinks } from "../../../shared/contracts/module_capabilities";
import * as control from "./control";
import log from "./log";
import {
    type RelayConfig,
    SRTLA_MODES,
    type SrtlaOptions,
    type SrtlaOptionsResult,
    type SrtlaState,
    type SrtlaStatsEvent,
    type SrtlaTarget,
} from "./types";

const RESTART_DELAY_MS = 2_000;
/** How an uplinks change reaches srtla_send: SIGHUP (re-read) or a respawn. */
const RELOAD_MODE = enumArgEnv(
    "--srtla-reload",
    ["signal", "restart"] as const,
    "SRTLA_RELOAD_MODE",
    "signal",
);
/** srtla_send JSON-RPC control socket (link stats, mode / quality switching); "" disables it. */
const SRTLA_SOCKET = argEnv(
    "--srtla-socket",
    "SRTLA_CONTROL_SOCKET",
    join(tmpdir(), "srtla_send.sock"),
);
/** UDP port the inbound `srtla_rec` binds (the encoder → relay SRTLA hop). */
const SRTLA_LISTEN_PORT = intArgEnv(
    "--srtla-listen-port",
    "SRTLA_LISTEN_PORT",
    6000,
    1,
    65535,
);
/** Loopback SRT port between `srtla_rec` and `srtla_send` — never exposed. */
const SRT_INTERNAL_PORT = intArgEnv(
    "--srt-internal-port",
    "SRT_INTERNAL_PORT",
    5000,
    1,
    65535,
);

/** Core bag, bound at discovery and re-filled at start (a module never imports the core). */
let core: ModuleCore;
/** Push channel, available from start on. */
let emit: Emit | undefined;
/** The network module's uplinks layer (bonded file + change hook). */
let uplinks: Uplinks;
/** Unregister the uplinks-change handler on stop. */
let uplinksUnsub: (() => void) | undefined;

// ----------------------------------------------------------------------
/** The module was `srtla` until v2: a config file still carrying that section
 * is adopted under `relay` once (the module owns its own sections). */
function adoptLegacySection(c: ModuleCore): void {
    const data = c.state.data;
    if (data.srtla !== undefined && data.relay === undefined) {
        data.relay = data.srtla;
        delete data.srtla;
    }
}

// Persisted section (`state.data.relay`): receiver target + scheduler options
// ----------------------------------------------------------------------
const stored = (): Partial<RelayConfig> =>
    (core.state.data.relay ?? {}) as Partial<RelayConfig>;

function target(): SrtlaTarget | undefined {
    const { listenPort, remoteHost, remotePort } = stored();
    if (!listenPort && !remoteHost && !remotePort) return undefined;
    return {
        listenPort: listenPort ?? "",
        remoteHost: remoteHost ?? "",
        remotePort: remotePort ?? "",
    };
}

function options(): SrtlaOptions | undefined {
    const { mode, quality } = stored();
    return mode !== undefined || quality !== undefined
        ? { mode, quality }
        : undefined;
}

/** Merge `patch` into the section and write it out complete, for a stable config file. */
async function save(patch: Partial<RelayConfig>): Promise<void> {
    const s = { ...stored(), ...patch };
    core.state.data.relay = {
        listenPort: s.listenPort ?? "",
        mode: s.mode ?? "enhanced",
        quality: s.quality ?? false,
        remoteHost: s.remoteHost ?? "",
        remotePort: s.remotePort ?? "",
    } satisfies RelayConfig;
    await core.saveState();
}

// ----------------------------------------------------------------------
// Process
// ----------------------------------------------------------------------
let sup: InstanceType<ModuleCore["Supervisor"]> | undefined;
const supervisor = () =>
    (sup ??= new core.Supervisor("SRTLA", RESTART_DELAY_MS, onRelayExit));

let recSup: InstanceType<ModuleCore["Supervisor"]> | undefined;
const recSupervisor = () =>
    (recSup ??= new core.Supervisor("SRTLA_REC", RESTART_DELAY_MS, onRecExit));

/** The running (or last) srtla_send: pid, target, counters. */
let live: SrtlaState = { running: false };
let dryRunActive = false; // --dry-run has no process to track

const isRunning = (): boolean =>
    core.config.DRY_RUN ? dryRunActive : supervisor().running;

function relayStatus(): SrtlaState {
    if (isRunning()) return live;
    // Keep the last target so the UI can prefill the form after a stop
    const last = target() ?? {
        listenPort: live.listenPort ?? "",
        remoteHost: live.remoteHost ?? "",
        remotePort: live.remotePort ?? "",
    };
    return {
        running: false,
        ...last,
        reloadCount: live.reloadCount,
        lastReloadAt: live.lastReloadAt,
    };
}

/** Send SIGHUP to srtla_send (asking it to re-read the uplinks file); true when delivered. */
function signalRelayReload(): boolean {
    if (core.config.DRY_RUN) {
        console.log("[DRY-RUN] SIGHUP srtla_send");
        return true;
    }
    const pid = isRunning() ? supervisor().pid : undefined;
    if (!pid) return false;
    try {
        process.kill(pid, "SIGHUP");
        console.log(`Sent SIGHUP to srtla_send (pid ${pid})`);
        return true;
    } catch (err: unknown) {
        console.warn(`Failed to signal srtla_send: ${errorMessage(err)}`);
        return false;
    }
}

/** Reload srtla_send after an uplinks-file change: SIGHUP by default, restart as fallback / on request. */
async function reloadRelay(): Promise<void> {
    if (!isRunning()) return;

    if (RELOAD_MODE === "signal") {
        if (signalRelayReload()) {
            live = {
                ...live,
                lastReloadAt: Date.now(),
                reloadCount: (live.reloadCount ?? 0) + 1,
            };
            core.notifyStateChange();
            return;
        }
        console.warn("SIGHUP failed — falling back to restart");
    }

    const { listenPort, remoteHost, remotePort } = live;
    if (!listenPort || !remoteHost || !remotePort) {
        console.warn("No srtla_send args cached — cannot restart");
        return;
    }
    console.log("Restarting srtla_send to pick up new uplinks file...");
    await stopRelay();
    await Bun.sleep(200);
    await startRelay(listenPort, remoteHost, remotePort);
}

/**
 * Start the SRTLA→SRTLA bridge: `srtla_rec` on the SRTLA UDP port
 * (SRTLA_LISTEN_PORT env by default; `listenPort` overrides it — the encoder
 * passes the port it sends to, which is this same port) + `srtla_send` on the
 * loopback SRT port.
 */
async function startRelay(
    listenPort: string,
    remoteHost: string,
    remotePort: string,
): Promise<SrtlaState> {
    const srtlaPort = Number(listenPort) || SRTLA_LISTEN_PORT;
    const sendPort = String(SRT_INTERNAL_PORT);
    const bin = process.env.SRTLA_SEND_BIN ?? "srtla_send";
    const recBin = "srtla_rec";
    // Only pass flags this srtla_send build understands (the BELABOX C version has none of them).
    const caps = core.config.DRY_RUN ? null : await srtlaSendCapabilities(bin);
    if (isRunning() && target())
        throw new Error("srtla_send is already running");

    // Save the requested receiver before spawning so failed starts still
    // leave the UI with a complete target to restore.
    await save({ listenPort: String(srtlaPort), remoteHost, remotePort });
    await uplinks.ensure();
    const uplinksFile = uplinks.file();
    const recArgs = srtlaRecArgs(srtlaPort, "127.0.0.1", SRT_INTERNAL_PORT);
    console.log(`Starting ${recBin} ${recArgs.join(" ")}`);
    console.log(
        `Starting ${bin} ${[
            ...srtlaSendFlags(
                caps ?? { controlSocket: true, mode: true, quality: true },
                options() ?? {},
                SRTLA_SOCKET,
            ),
            sendPort,
            remoteHost,
            remotePort,
                uplinksFile,
        ].join(" ")}`,
    );

    const started = (pid?: number): SrtlaState => ({
        running: true,
        listenPort: String(srtlaPort),
        sendPort,
        remoteHost,
        remotePort,
        startedAt: Date.now(),
        ...(pid === undefined
            ? {}
            : { pid, reloadCount: live.reloadCount ?? 0 }),
    });
    if (caps) {
        // srtla_send first, then srtla_rec once its loopback SRT listener is up.
        await supervisor().start(() => {
            const flags = srtlaSendFlags(caps, options() ?? {}, SRTLA_SOCKET);
            const withControl = !!SRTLA_SOCKET && caps.controlSocket;
            control.prepareSrtlaControl(SRTLA_SOCKET, withControl);
            const proc = Bun.spawn(
                [bin, ...flags, sendPort, remoteHost, remotePort, uplinksFile],
                { stdout: "inherit", stderr: "inherit", stdin: "inherit" },
            );
            if (withControl) control.startSrtlaControl(SRTLA_SOCKET);
            live = started(proc.pid);
            return proc;
        });
        // The starter re-runs on supervisor restarts, so the readiness gate
        // (loopback SRT listener) is applied on every (re)spawn.
        await recSupervisor().start(async () => {
            const open = await waitForUdpPort(SRT_INTERNAL_PORT, 5_000);
            if (!open)
                console.warn(
                    `srtla_rec: loopback SRT port ${SRT_INTERNAL_PORT} did not open in 5s — starting anyway`,
                );
            return Bun.spawn([recBin, ...recArgs], {
                stdout: "inherit",
                stderr: "inherit",
                stdin: "inherit",
            });
        });
    } else {
        dryRunActive = true;
        live = started();
    }
    core.notifyStateChange();
    return live;
}

/** srtla_send died on its own (e.g. all uplinks lost): keep retrying like belaUI does. */
function onRelayExit(code: number | null): void {
    console.log(`srtla_send exited with code ${code}`);
    control.stopSrtlaControl();
    live = { ...live, running: false, pid: undefined };
    core.notifyStateChange();
    if (!supervisor().wanted) return;
    core.logEvent(
        "warn",
        "SRTLA",
        t("log.srtla_exited", { code, delay: RESTART_DELAY_MS / 1000 }),
    );
    supervisor().scheduleRestart();
}

/** srtla_rec died on its own: keep retrying like belaUI does. */
function onRecExit(code: number | null): void {
    console.log(`srtla_rec exited with code ${code}`);
    if (!recSupervisor().wanted) return;
    core.logEvent(
        "warn",
        "SRTLA_REC",
        t("log.srtla_exited", { code, delay: RESTART_DELAY_MS / 1000 }),
    );
    recSupervisor().scheduleRestart();
}

async function stopRelay(): Promise<void> {
    if (!sup && !recSup && !dryRunActive)
        return; // never started in this process — nothing to stop
    await recSup?.stop();
    await sup?.stop();
    control.stopSrtlaControl();
    dryRunActive = false;
    live = { ...live, running: false, pid: undefined };
    core.notifyStateChange();
}

/**
 * Persist scheduler settings and apply them to a running srtla_send over its control
 * socket. `applied` is false when they only take effect on the next start.
 */
async function setSrtlaOptions(
    opts: SrtlaOptions,
): Promise<SrtlaOptionsResult> {
    await save(opts);
    const result = (applied: boolean) => ({
        options: options() ?? {},
        applied,
    });
    if (core.config.DRY_RUN) {
        console.log(`[DRY-RUN] srtla_send options ${JSON.stringify(opts)}`);
        return result(isRunning());
    }
    if (!isRunning() || !control.srtlaControlState().connected)
        return result(false);
    if (opts.mode) await control.rpc("set_mode", { mode: opts.mode });
    if (opts.quality !== undefined)
        await control.rpc("set_quality", { enabled: opts.quality });
    return result(true);
}

/** Honor `--start-srtla <listenPort> <remoteHost> <remotePort>` if present. */
async function maybeStartRelay(): Promise<void> {
    const i = argv.indexOf("--start-srtla");
    if (i === -1) return;
    if (i + 3 >= argv.length) {
        console.warn(
            "--start-srtla requires <listenPort> <remoteHost> <remotePort>",
        );
        return;
    }
    await startRelay(argv[i + 1], argv[i + 2], argv[i + 3]);
}

// ----------------------------------------------------------------------
// Pushes: link stats (throttled, retained while flowing) + control up/down
// ----------------------------------------------------------------------
const statsSummary = ({ stats }: SrtlaStatsEvent) =>
    stats
        ? {
              bitrate: stats.links.reduce(
                  (sum, l) => sum + (l.bitrate_bytes_per_sec || 0),
                  0,
              ),
              activeLinks: stats.active_links,
              totalLinks: stats.total_links,
          }
        : {};

control.onRelayStats((ev) =>
    emit?.("relay.stats", ev, {
        throttle: true,
        retain: !!ev.stats,
        summary: statsSummary(ev),
    }),
);
control.onSrtlaControlChange(() => core.notifyStateChange());

// ----------------------------------------------------------------------
// Registration
// ----------------------------------------------------------------------
const capability = {
    relayStatus,
    startRelay,
    stopRelay,
    reloadRelay,
    target,
};

const registration: BackendModule<ModuleCore> = {
    kind: "device",
    id: "relay",
    title: "Relay",
    roleDefinitions: [
        {
            id: "relay",
            titleKey: "role.relay",
            taglineKey: "setup.role.relay_tag",
            order: 10,
            default: true,
            setupSelectable: true,
        },
    ],
    roles: ["relay"],
    /** The srtla_send uplinks file lives in the network module. */
    dependencies: ["network"],
    methods: [
        "relay.status",
        "relay.start",
        "relay.stop",
        "relay.reload",
        "relay.stats",
        "relay.options",
    ],
    events: ["relay.stats"],
    dashboardActions: [
        {
            id: "start",
            label: "act.relay.start",
            icon: "▶",
            method: "relay.start",
        },
        {
            id: "stop",
            label: "act.relay.stop",
            icon: "⏹",
            method: "relay.stop",
            confirm: true,
        },
        {
            id: "reload",
            label: "act.relay.reload",
            icon: "↻",
            method: "relay.reload",
        },
    ],
    log,
    bind(c) {
        core = c;
        adoptLegacySection(c);
        uplinks = requireCapability<Uplinks>("network.uplinks");
    },
    async start(ctx) {
        core = ctx.core;
        emit = ctx.emit;
        // Reload srtla_send whenever the network module rewrites the uplinks file.
        uplinksUnsub = uplinks.onChanged(async () => {
            console.log("Uplinks changed — reloading srtla_send");
            await reloadRelay();
        });
        await maybeStartRelay();
    },
    async stop() {
        uplinksUnsub?.();
        uplinksUnsub = undefined;
        await stopRelay();
    },
    /** Relay autostart: bring the bridge back with the saved target. */
    async resume() {
        const last = target();
        if (!last) return false;
        if (!isRunning())
            await startRelay(last.listenPort, last.remoteHost, last.remotePort);
        return true;
    },
    async dispatch(method, p) {
        switch (method) {
            case "relay.status":
                return { relay: relayStatus() };
            case "relay.start": {
                core.cancelAutostart();
                const listenPort = requirePort(p, "listenPort");
                const remoteHost = requireHost(p, "remoteHost");
                const remotePort = requirePort(p, "remotePort");
                try {
                    return {
                        relay: await startRelay(
                            listenPort,
                            remoteHost,
                            remotePort,
                        ),
                    };
                } catch (e: unknown) {
                    throw new ApiError(errorMessage(e), 409);
                }
            }
            case "relay.stop":
                core.cancelAutostart();
                await stopRelay();
                return { relay: relayStatus() };
            case "relay.reload":
                await reloadRelay();
                return { relay: relayStatus() };
            case "relay.stats":
                return control.latestSrtlaStats();
            case "relay.options": {
                const opts: SrtlaOptions = {};
                if (p.mode !== undefined)
                    opts.mode = oneOf(p.mode, "mode", SRTLA_MODES);
                if (p.quality !== undefined)
                    opts.quality = requireBoolean(p, "quality");
                if (opts.mode === undefined && opts.quality === undefined)
                    throw new ApiError("mode or quality is required");
                let result: SrtlaOptionsResult;
                try {
                    result = await setSrtlaOptions(opts);
                } catch (e: unknown) {
                    throw new ApiError(errorMessage(e), 502);
                }
                if (!result.applied && relayStatus().running)
                    core.logEvent("warn", "SRTLA", t("log.no_control_socket"));
                return result;
            }
        }
        throw new Error(`unknown method ${method}`);
    },
    async status() {
        return {
            state: {
                relay: relayStatus(),
                relayTarget: target(),
                relayOptions: options() ?? {},
                srtlaMonitor: { reloadMode: RELOAD_MODE },
            },
            srtlaControl: control.srtlaControlState(),
            summary: { relay: relayStatus() },
        };
    },
    /** Setup wizard (relay): the receiver target and scheduler options. */
    async setup(p) {
        const listenPort = requirePort(p, "listenPort");
        const remoteHost = requireHost(p, "srtlaRemoteHost");
        const remotePort = requirePort(p, "srtlaRemotePort");
        const mode = oneOf(
            requireString(p, "srtlaMode"),
            "srtlaMode",
            SRTLA_MODES,
        );
        const quality = requireBoolean(p, "srtlaQuality");
        return () => {
            core.state.data.relay = {
                listenPort,
                mode,
                quality,
                remoteHost,
                remotePort,
            } satisfies RelayConfig;
        };
    },
    dashboardWidgets: [{ type: "relay", defaultSize: { w: 4, h: 4 } }],
    services: { capabilities: { "stream.relay": capability } },
};

export default registration;
