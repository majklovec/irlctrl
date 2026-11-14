/*
 * Speedtest module: run librespeed-cli against a LibreSpeed server and
 * stream the NDJSON progress to the card.
 *
 * - Server list: downloaded + cached (1 h TTL) in the data dir; the cache is
 *   the CLI's `--local-json` input and is never modified per run.
 * - Interfaces: /sys/class/net enumeration with an os fallback.
 * - Runs: single-flight, in-memory last result (no persistence), live
 *   `speedtest.run` event envelope per CLI line.
 *
 * Serves every role (no `roles` field): any box with an uplink can be
 * speed-tested.
 */
import type {
    BackendModule,
    Params,
} from "../../../shared/contracts/backend_module";
import { ApiError } from "../../../shared/params";
import type { ModuleCore } from "../../backend/module_core";
import log from "./log";
import { SPEEDTEST_CLI, SPEEDTEST_DIR } from "./config";
import { CliResolver } from "./cli";
import { ServerListCache } from "./server_list";
import { listInterfaces } from "./interfaces";
import {
    killStaleSpeedtestChildren,
    SpeedtestRunManager,
} from "./run";
import type {
    SpeedtestInterface,
    SpeedtestServers,
} from "./types";

let emit:
    | ((event: string, data: unknown, opts?: { retain?: boolean }) => void)
    | undefined;
let core: ModuleCore | undefined;
let list: ServerListCache | undefined;
let resolver: CliResolver | undefined;
let manager: SpeedtestRunManager | undefined;

const IFACE_RE = /^[A-Za-z0-9._:-]{1,64}$/;

/** The module's persisted slice (server + interface selections). */
function settings(): { serverId: number | null; interface: string | null } {
    const slice = core?.state.settings.modules?.speedtest as
        | { serverId?: number | null; interface?: string | null }
        | undefined;
    return {
        serverId:
            typeof slice?.serverId === "number" && Number.isInteger(slice.serverId)
                ? slice.serverId
                : null,
        interface:
            typeof slice?.interface === "string" && slice.interface
                ? slice.interface
                : null,
    };
}

/** A positive integer server id, or null ("Auto") for null / undefined. */
function serverId(p: Params): number | null {
    const v = p.serverId;
    if (v === undefined) return settings().serverId;
    if (v === null) return null;
    if (
        typeof v !== "number" ||
        !Number.isInteger(v) ||
        v < 1 ||
        v > 1_000_000
    )
        throw new ApiError("serverId must be a positive integer");
    return v;
}

/** An interface name, or null ("Auto"); validated so it cannot smuggle flags. */
function iface(p: Params): string | null {
    const v = p.interface;
    if (v === undefined) return settings().interface;
    if (v === null) return null;
    if (typeof v !== "string" || !IFACE_RE.test(v))
        throw new ApiError("interface must be a valid name");
    return v;
}

/** Optional phase duration override in seconds (default 15, range 5–300). */
function duration(p: Params): number | null {
    const v = p.duration;
    if (v === undefined || v === null) return null;
    if (
        typeof v !== "number" ||
        !Number.isInteger(v) ||
        v < 5 ||
        v > 300
    )
        throw new ApiError("duration must be an integer between 5 and 300");
    return v;
}

const registration: BackendModule<ModuleCore> = {
    kind: "device",
    id: "speedtest",
    title: "Speedtest",
    configDefaults: { serverId: null, interface: null },
    methods: [
        "speedtest.servers",
        "speedtest.interfaces",
        "speedtest.run",
        "speedtest.cancel",
        "speedtest.last",
        "speedtest.saveSettings",
    ],
    events: ["speedtest.run"],
    log,
    bind(c) {
        core = c;
        ensureObjects();
    },
    async start(ctx) {
        core = ctx.core;
        emit = ctx.emit;
        ensureObjects();
        void killStaleSpeedtestChildren((m) => ctx.log("speedtest", m));
        void list?.get(); // prime the cache (serves from disk when fresh)
    },
    async stop() {
        await manager?.stop();
    },
    async dispatch(method, params) {
        ensureObjects();
        const p = (params ?? {}) as Params;
        switch (method) {
            case "speedtest.servers":
                return (await list!.get(
                    p.refresh === true || p.refresh === "1",
                )) satisfies SpeedtestServers;
            case "speedtest.interfaces": {
                const interfaces =
                    (await listInterfaces()) satisfies SpeedtestInterface[];
                return { interfaces };
            }
            case "speedtest.run": {
                const opts = {
                    serverId: serverId(p),
                    interface: iface(p),
                    duration: duration(p),
                };
                const { runId } = await manager!.start(opts);
                core?.logEvent(
                    "info",
                    "speedtest",
                    `Speedtest started (server ${opts.serverId ?? "auto"}, interface ${opts.interface ?? "auto"})`,
                );
                return { runId };
            }
            case "speedtest.cancel": {
                if (typeof p.runId !== "string" || !p.runId)
                    throw new ApiError("runId is required");
                manager!.cancel(p.runId);
                return { ok: true };
            }
            case "speedtest.last":
                return manager!.lastResult ?? null;
            case "speedtest.saveSettings": {
                const slice = (core!.state.settings.modules ??= {})["speedtest"] ??=
                    { enabled: true };
                if (p.serverId !== undefined) slice.serverId = serverId(p);
                if (p.interface !== undefined) slice.interface = iface(p);
                await core!.saveState();
                return { settings: { ...settings() } };
            }
            default:
                throw new ApiError(`Unknown method: ${method}`, 404);
        }
    },
    async status() {
        const last = manager?.lastResult;
        return {
            speedtest: {
                running: manager?.activeRunId ?? null,
                last: last
                    ? {
                          download: last.result.download,
                          upload: last.result.upload,
                          ping: last.result.ping,
                          finishedAt: last.finishedAt,
                      }
                    : null,
            },
        };
    },
};

function ensureObjects(): void {
    if (!list)
        list = new ServerListCache({
            dir: SPEEDTEST_DIR,
            log: (m) => core?.logEvent("info", "speedtest", m),
        });
    if (!resolver)
        resolver = new CliResolver({
            dir: SPEEDTEST_DIR,
            explicit: SPEEDTEST_CLI || undefined,
            log: (m) => core?.logEvent("info", "speedtest", m),
        });
    if (!manager)
        manager = new SpeedtestRunManager({
            resolveBin: () => resolver!.resolve(),
            list: list!,
            emit: (event, data, opts) => emit?.(event, data, opts),
            log: (m) => core?.logEvent("info", "speedtest", m),
        });
}

void ensureObjects();

export default registration;
