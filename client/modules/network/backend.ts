/*
 * Network module: the interface routing layer the `relay` and `encoder` roles
 * share — interface detection, the SRT bond selection, the source-routing
 * tables (`ip rule`/`ip route`), the srtla_send uplinks file and the live
 * netlink monitor that keeps it in sync with the machine's interfaces.
 *
 * The SRTLA leg owners (relay, encoder) don't touch any of that directly:
 * they pull the `network.uplinks` capability and point their `srtla_send` at
 * `uplinks.file()`, reloading (SIGHUP, restart fallback) on `uplinks.onChanged`.
 * The uplinks-changed handlers are registered by the consuming modules, so
 * one network module serves both roles without knowing which one is running.
 */

import { requireCapability } from "../../../shared/capabilities";
import type {
    BackendModule,
    Params,
} from "../../../shared/contracts/backend_module";
import { t } from "../../../shared/i18n";
import {
    ApiError,
    optionalStringList,
    requireString,
} from "../../../shared/params";
import type { ModuleCore } from "../../backend/module_core";
import log from "./log";
import {
    bindRouting,
    defaultRouteDetails,
    detectInterfaces,
    ensureUplinksFile,
    isMonitorRunning,
    onUplinksChanged,
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
import type { Iface, Modem, ModemConfig, ModemSource } from "./types";

/** Core bag, bound at discovery and re-filled at start (a module never imports the core). */
let core: ModuleCore;
let modemSource: ModemSource;

/** The interfaces chosen for the bond, enriched with the modem details from the modems module. */
async function modemStatus(): Promise<{
    interfaces: Iface[];
    selected: Iface[];
    modems: Modem[];
}> {
    const modems = await modemSource.detect();
    const interfaces = await detectInterfaces(modems);
    return { interfaces, selected: resolveSelection(interfaces), modems };
}

/**
 * Apply a bond selection: persist it, rewrite the routing tables and the
 * uplinks file, then notify the SRTLA leg owners so they reload `srtla_send`
 * when the file content changed.
 */
async function applySelection(next: ModemConfig) {
    await setSelection(next);
    const result = await reconfigure();
    if (!result.ok)
        throw new ApiError(result.error ?? "reconfigure failed", 500);
    return { selection: selection(), ...result };
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
    const badIps =
        ips?.filter((ip) => !all.some((iface) => iface.ip === ip)) ?? [];
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

/** The module's bond selection used to live in the relay section: adopt it once. */
function adoptSelection(c: ModuleCore): void {
    const data = c.state.data;
    const legacy = (data.relay as Record<string, unknown> | undefined)
        ?.selection;
    const net = (data.network ?? {}) as Record<string, unknown>;
    if (legacy !== undefined && net.selection === undefined) {
        data.network = { ...net, selection: legacy };
    }
}

const registration: BackendModule<ModuleCore> = {
    kind: "device",
    id: "network",
    title: "Network",
    roles: ["relay", "encoder"],
    dependencies: ["modems"],
    methods: [
        "interfaces.list",
        "reconfigure",
        "modems.select",
        "modems.toggle",
    ],
    events: [],
    dashboardActions: [
        {
            id: "reconfigure",
            label: "act.network.reconfigure",
            icon: "↻",
            method: "reconfigure",
        },
    ],
    log,
    bind(c) {
        core = c;
        adoptSelection(c);
        modemSource = requireCapability<ModemSource>("modems.source");
        bindRouting(c, modemSource);
    },
    async start(ctx) {
        core = ctx.core;
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
        startInterfaceMonitor();
        startDefaultRouteFailover();
    },
    async stop() {
        stopDefaultRouteFailover();
        await stopInterfaceMonitor();
    },
    async dispatch(method, p) {
        switch (method) {
            case "interfaces.list":
                return { interfaces: await detectInterfaces() };
            case "reconfigure":
                return reconfigure();
            case "modems.select":
                return selectModems(p);
            case "modems.toggle":
                return toggleModem(p);
        }
        throw new Error(`unknown method ${method}`);
    },
    async status() {
        const [modem, defaultRoute] = await Promise.all([
            modemStatus(),
            defaultRouteDetails(),
        ]);
        return {
            ...modem,
            selection: selection(),
            defaultRouteInterface: defaultRoute?.iface ?? null,
            defaultRouteSourceIp: defaultRoute?.ip ?? null,
            uplinksFile: UPLINKS_FILE,
            monitor: { running: isMonitorRunning() },
        };
    },
    dashboardWidgets: [{ type: "network", defaultSize: { w: 4, h: 5 } }],
    services: {
        capabilities: {
            "network.uplinks": {
                file: () => UPLINKS_FILE,
                ensure: ensureUplinksFile,
                onChanged: onUplinksChanged,
            },
        },
    },
};

export default registration;
