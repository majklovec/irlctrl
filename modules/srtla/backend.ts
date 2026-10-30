/*
 * srtla module: srtla_send process management — start / stop / reload (SIGHUP
 * or restart), the scheduler options applied over the control socket
 * (control.ts) and the per-link stats push.
 *
 * Also owns the relay's interface routing and ModemManager integration;
 * those implementations are internal parts of this module.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModuleCore } from "../../backend/client/module-core";
import { argEnv, argv, enumArgEnv } from "../../shared/args";
import { t } from "../../shared/i18n";
import type { BackendModule, Emit, Params } from "../../shared/module-contract";
import {
    ApiError,
    oneOf,
    optionalStringList,
    requireBoolean,
    requireHost,
    requireIndex,
    requirePort,
    requireString,
} from "../../shared/params";
import { errorMessage } from "../../shared/util";
import * as control from "./control";
import log from "./log";
import {
    bindModemManager,
    detectModems,
    modemSource,
    performModemAction,
} from "./modems";
import {
    bindRouting,
    defaultRouteDetails,
    detectInterfaces,
    isMonitorRunning,
    reconfigure,
    resolveSelection,
    selection,
    setSelection,
    startDefaultRouteFailover,
    startInterfaceMonitor,
    stopDefaultRouteFailover,
    stopInterfaceMonitor,
    UPLINKS_FILE,
} from "./routing";
import {
    SRTLA_MODES,
    type Iface,
    type ModemConfig,
    type ModemInfo,
    type ReconfigureResult,
    type SrtlaConfig,
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

/** Core bag, bound at discovery and re-filled at start (a module never imports the core). */
let core: ModuleCore;
/** Push channel, available from start on. */
let emit: Emit | undefined;

const uplinksFile = (): string => UPLINKS_FILE;

/** Reconfigure routing / uplinks and reload srtla_send if the file changed. */
async function reconfigureAndReload(): Promise<ReconfigureResult> {
    const result = await reconfigure();
    if (!result.ok)
        throw new ApiError(result.error ?? "reconfigure failed", 500);
    if (result.changed) await reloadSrtla();
    return result;
}

async function applySelection(next: ModemConfig) {
    await setSelection(next);
    const { selected, ips, uplinksFile, changed } =
        await reconfigureAndReload();
    return { selection: selection(), selected, ips, uplinksFile, changed };
}

async function selectModems(p: Params) {
    const names = optionalStringList(p, "modems");
    const ips = optionalStringList(p, "ips");
    const all = await detectInterfaces();
    const badIfaces =
        names?.filter((name) => !all.some((iface) => iface.iface === name)) ??
        [];
    if (badIfaces.length)
        throw new ApiError(`Unknown interfaces: ${badIfaces.join(", ")}`);
    const badIps = ips?.filter((ip) => !all.some((iface) => iface.ip === ip)) ?? [];
    if (badIps.length) throw new ApiError(`Unknown IPs: ${badIps.join(", ")}`);
    return applySelection(
        names?.length ? { modems: names } : ips?.length ? { ips } : {},
    );
}

async function toggleModem(p: Params) {
    const name = requireString(p, "iface");
    const all = await detectInterfaces();
    if (!all.some((iface) => iface.iface === name))
        throw new ApiError(`Unknown interface: ${name}`, 404);
    const names = new Set(resolveSelection(all).map((iface) => iface.iface));
    if (!names.delete(name)) names.add(name);
    return applySelection({ modems: [...names] });
}

async function modemStatus(): Promise<{
    interfaces: Iface[];
    selected: Iface[];
    modems: ModemInfo[];
}> {
    const modems = await detectModems();
    const interfaces = await detectInterfaces(modems);
    return { interfaces, selected: resolveSelection(interfaces), modems };
}

// ----------------------------------------------------------------------
// Persisted section (`state.data.srtla`): receiver target + scheduler options
// ----------------------------------------------------------------------
const stored = (): Partial<SrtlaConfig> =>
    (core.state.data.srtla ?? {}) as Partial<SrtlaConfig>;

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
async function save(patch: Partial<SrtlaConfig>): Promise<void> {
    const s = { ...stored(), ...patch };
    core.state.data.srtla = {
        listenPort: s.listenPort ?? "",
        mode: s.mode ?? "enhanced",
        quality: s.quality ?? false,
        remoteHost: s.remoteHost ?? "",
        remotePort: s.remotePort ?? "",
        selection: s.selection,
    } satisfies SrtlaConfig;
    await core.saveState();
}

// ----------------------------------------------------------------------
// Process
// ----------------------------------------------------------------------
let sup: InstanceType<ModuleCore["Supervisor"]> | undefined;
const supervisor = () =>
    (sup ??= new core.Supervisor("SRTLA", RESTART_DELAY_MS, onSrtlaExit));

/** The running (or last) srtla_send: pid, target, counters. */
let live: SrtlaState = { running: false };
let dryRunActive = false; // --dry-run has no process to track

const isRunning = (): boolean =>
    core.config.DRY_RUN ? dryRunActive : supervisor().running;

function srtlaStatus(): SrtlaState {
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
function signalSrtlaReload(): boolean {
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
async function reloadSrtla(): Promise<void> {
    if (!isRunning()) return;

    if (RELOAD_MODE === "signal") {
        if (signalSrtlaReload()) {
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
    await stopSrtla();
    await Bun.sleep(200);
    await startSrtla(listenPort, remoteHost, remotePort);
}

async function startSrtla(
    listenPort: string,
    remoteHost: string,
    remotePort: string,
): Promise<SrtlaState> {
    const bin = process.env.SRTLA_SEND_BIN ?? "srtla_send";
    // Only pass flags this srtla_send build understands (the BELABOX C version has none of them).
    // Probed before the running check so check → spawn stays free of awaits.
    const caps = core.config.DRY_RUN
        ? null
        : await control.srtlaCapabilities(bin);
    if (isRunning()) throw new Error("srtla_send is already running");

    // Save the requested receiver before spawning so failed starts still
    // leave the UI with a complete target to restore.
    await save({ listenPort, remoteHost, remotePort });
    const uplinks = uplinksFile();
    console.log(
        `Starting ${bin} listen: ${listenPort} target: ${remoteHost}:${remotePort} ${uplinks}`,
    );

    const started = (pid?: number): SrtlaState => ({
        running: true,
        listenPort,
        remoteHost,
        remotePort,
        startedAt: Date.now(),
        ...(pid === undefined
            ? {}
            : { pid, reloadCount: live.reloadCount ?? 0 }),
    });
    if (caps) {
        // The starter runs again on supervisor restarts, so the record follows every spawn.
        await supervisor().start(() => {
            const opts = options() ?? {};
            const withControl = !!SRTLA_SOCKET && caps.controlSocket;
            const flags: string[] = [];
            if (withControl) flags.push("--control-socket", SRTLA_SOCKET);
            if (caps.mode && opts.mode) flags.push("--mode", opts.mode);
            if (caps.quality && opts.quality === false)
                flags.push("--no-quality");
            control.prepareSrtlaControl(SRTLA_SOCKET, withControl);
            const proc = Bun.spawn(
                [bin, ...flags, listenPort, remoteHost, remotePort, uplinks],
                { stdout: "inherit", stderr: "inherit", stdin: "inherit" },
            );
            if (withControl) control.startSrtlaControl(SRTLA_SOCKET);
            live = started(proc.pid);
            return proc;
        });
    } else {
        dryRunActive = true;
        live = started();
    }
    core.notifyStateChange();
    return live;
}

/** srtla_send died on its own (e.g. all uplinks lost): keep retrying like belaUI does. */
function onSrtlaExit(code: number | null): void {
    console.log(`srtla_send exited with code ${code}`);
    control.stopSrtlaControl();
    live = { running: false, reloadCount: live.reloadCount };
    core.notifyStateChange();
    if (!supervisor().wanted) return;
    core.logEvent(
        "warn",
        "SRTLA",
        t("log.srtla_exited", { code, delay: RESTART_DELAY_MS / 1000 }),
    );
    supervisor().scheduleRestart();
}

async function stopSrtla(): Promise<void> {
    if (!sup && !dryRunActive) return; // never started in this process — nothing to stop
    await sup?.stop();
    control.stopSrtlaControl();
    dryRunActive = false;
    live = { ...live, running: false };
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
async function maybeStartSrtla(): Promise<void> {
    const i = argv.indexOf("--start-srtla");
    if (i === -1) return;
    if (i + 3 >= argv.length) {
        console.warn(
            "--start-srtla requires <listenPort> <remoteHost> <remotePort>",
        );
        return;
    }
    await startSrtla(argv[i + 1], argv[i + 2], argv[i + 3]);
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

control.onSrtlaStats((ev) =>
    emit?.("srtla.stats", ev, {
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
    srtlaStatus,
    startSrtla,
    stopSrtla,
    reloadSrtla,
    target,
};

const registration: BackendModule<ModuleCore> = {
    kind: "device",
    id: "srtla",
    title: "SRTLA",
    configKey: "relay",
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
    roles: ["relay", "combined"],
    methods: [
        "interfaces.list",
        "reconfigure",
        "modems.list",
        "modems.select",
        "modems.toggle",
        "modems.enable",
        "modems.disable",
        "modems.reset",
        "modems.connect",
        "modems.disconnect",
        "srtla.status",
        "srtla.start",
        "srtla.stop",
        "srtla.reload",
        "srtla.stats",
        "srtla.options",
    ],
    events: ["srtla.stats"],
    dashboardActions: [
        {
            id: "reconfigure",
            label: "act.srtla.reconfigure",
            icon: "↻",
            method: "reconfigure",
        },
        {
            id: "start",
            label: "act.srtla.start",
            icon: "▶",
            method: "srtla.start",
        },
        {
            id: "stop",
            label: "act.srtla.stop",
            icon: "⏹",
            method: "srtla.stop",
            confirm: true,
        },
        {
            id: "reload",
            label: "act.srtla.reload",
            icon: "↻",
            method: "srtla.reload",
        },
    ],
    log,
    bind(c) {
        core = c;
        bindModemManager(c);
        bindRouting(c, modemSource);
    },
    async start(ctx) {
        core = ctx.core;
        emit = ctx.emit;
        bindModemManager(core);
        bindRouting(core, modemSource);
        const result = await reconfigure();
        if (!result.ok) {
            console.error("Initial reconfigure failed:", result.error);
            core.logEvent(
                "error",
                "Interfaces",
                t("log.reconfigure_failed", { error: result.error }),
            );
            throw new Error(`Initial reconfigure failed: ${result.error}`);
        }
        console.log(`Initial uplinks: ${result.ips.join(", ")}`);
        startInterfaceMonitor(reloadSrtla);
        startDefaultRouteFailover();
        await maybeStartSrtla();
    },
    async stop() {
        stopDefaultRouteFailover();
        await stopInterfaceMonitor();
        await stopSrtla();
    },
    /** Relay autostart: bring srtla_send back with the saved target (combined devices resume via the encoder module). */
    async resume() {
        if (core.role() !== "relay") return false;
        const last = target();
        if (!last) return false;
        if (!isRunning())
            await startSrtla(last.listenPort, last.remoteHost, last.remotePort);
        return true;
    },
    async dispatch(method, p) {
        switch (method) {
            case "interfaces.list":
                return { interfaces: await detectInterfaces() };
            case "reconfigure":
                return reconfigureAndReload();
            case "modems.list": {
                const status = await modemStatus();
                return { selection: selection(), ...status };
            }
            case "modems.select":
                return selectModems(p);
            case "modems.toggle":
                return toggleModem(p);
            case "srtla.status":
                return { srtla: srtlaStatus() };
            case "srtla.start": {
                core.cancelAutostart();
                const listenPort = requirePort(p, "listenPort");
                const remoteHost = requireHost(p, "remoteHost");
                const remotePort = requirePort(p, "remotePort");
                try {
                    return {
                        srtla: await startSrtla(
                            listenPort,
                            remoteHost,
                            remotePort,
                        ),
                    };
                } catch (e: unknown) {
                    throw new ApiError(errorMessage(e), 409);
                }
            }
            case "srtla.stop":
                core.cancelAutostart();
                await stopSrtla();
                return { srtla: srtlaStatus() };
            case "srtla.reload":
                await reloadSrtla();
                return { srtla: srtlaStatus() };
            case "srtla.stats":
                return control.latestSrtlaStats();
            case "srtla.options": {
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
                if (!result.applied && srtlaStatus().running)
                    core.logEvent("warn", "SRTLA", t("log.no_control_socket"));
                return result;
            }
        }
        if (method.startsWith("modems.")) {
            const action = method.slice("modems.".length);
            if (
                action !== "enable" &&
                action !== "disable" &&
                action !== "reset" &&
                action !== "connect" &&
                action !== "disconnect"
            )
                throw new Error(`unknown method ${method}`);
            const modemIndex = requireIndex(p);
            return {
                modemIndex,
                action,
                ok: await performModemAction(action, modemIndex),
            };
        }
        throw new Error(`unknown method ${method}`);
    },
    async status() {
        const [modem, defaultRoute] = await Promise.all([
            modemStatus(),
            defaultRouteDetails(),
        ]);
        return {
            state: {
                srtla: srtlaStatus(),
                srtlaTarget: target(),
                srtlaOptions: options() ?? {},
                selection: selection(),
            },
            ...modem,
            defaultRouteInterface: defaultRoute?.iface ?? null,
            defaultRouteSourceIp: defaultRoute?.ip ?? null,
            uplinksFile: UPLINKS_FILE,
            srtlaControl: control.srtlaControlState(),
            monitor: {
                running: isMonitorRunning(),
                reloadMode: RELOAD_MODE,
            },
            summary: { srtla: srtlaStatus() },
        };
    },
    /** Setup wizard (relay / combined): the receiver target and scheduler options. */
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
            core.state.data.srtla = {
                listenPort,
                mode,
                quality,
                remoteHost,
                remotePort,
                selection: stored().selection,
            } satisfies SrtlaConfig;
        };
    },
    dashboardWidgets: [{ type: "relay", defaultSize: { w: 4, h: 4 } }],
    services: { capabilities: { "stream.srtla": capability } },
};

export default registration;
