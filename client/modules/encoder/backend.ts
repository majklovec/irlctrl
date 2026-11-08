/*
 * Encoder module: belacoder / ceracoder management — the encoder process
 * (./encoder), pipeline and audio-source discovery (./sources), pipeline files
 * and GitHub pipeline repositories (./pipelines, ./pipeline-repos), and SRTLA
 * streaming: a local srtla_send fed by the encoder, sending the SRTLA stream
 * to the relay (or a direct destination).
 *
 * Persisted sections: `encoder` (last used config), `ceracoder`,
 * `pipelineRepositories`. Live process state is module-local.
 */
import type { ModuleCore } from "../../backend/module_core";
import type {
    BackendModule,
    ModuleStartContext,
    Params,
} from "../../../shared/contracts/backend_module";
import {
    ApiError,
    optionalInt,
    requireHost,
    requireString,
} from "../../../shared/params";
import { argEnv, intArgEnv } from "../../../shared/args";
import { errorMessage } from "../../../shared/util";
import type { Role } from "../../../shared/validate";
import { PIPELINES_DIR } from "./config";
import { bindCore, core, data } from "./core";
import { ceracoder, ceracoderConfig, encoder } from "./encoder";
import log from "./log";
import { parseBitrates, parseEncoderConfig } from "./params";
import {
    removePipelineRepository,
    syncPipelineRepository,
} from "./pipeline_repos";
import {
    createPipelineFile,
    deletePipelineFile,
    pipelinesByPrefix,
    readPipelineFile,
    updatePipelineFile,
} from "./pipelines";
import { listAudioSources, listPipelines } from "./sources";
import type {
    EncoderConfig,
    SrtlaState,
    SrtlaTarget,
} from "./types";
import { srtlaSendCapabilities, srtlaSendFlags } from "../../../shared/srtla";
import { requireCapability } from "../../../shared/capabilities";
import type { Uplinks } from "../../../shared/contracts/module_capabilities";

/** Map a start failure to a status code: conflicts 409, bad pipeline / audio 400, else 500. */
async function startChecked<T>(start: () => Promise<T>): Promise<T> {
    try {
        return await start();
    } catch (e: unknown) {
        const msg = errorMessage(e);
        throw new ApiError(
            msg,
            /already/.test(msg) ? 409 : /pipeline|audio/i.test(msg) ? 400 : 500,
        );
    }
}

/**
 * SRTLA destination for the encoder's outbound leg. The request's `remoteHost`
 * / `remotePort` win (so the UI can aim at a final destination directly);
 * otherwise the `ENCODER_DESTINATION_HOST` / `ENCODER_DESTINATION_PORT` env vars
 * apply, defaulting to the relay on UDP 6000.
 */
function encoderDestination(p: Params): {
    remoteHost: string;
    remotePort: string;
} {
    const hostParam =
        typeof p.remoteHost === "string" ? p.remoteHost.trim() : "";
    const host =
        hostParam ||
        argEnv("--encoder-destination-host", "ENCODER_DESTINATION_HOST", "relay");
    const remotePort = String(
        optionalInt(
            p,
            "remotePort",
            intArgEnv(
                "--encoder-destination-port",
                "ENCODER_DESTINATION_PORT",
                6000,
                1,
                65535,
            ),
            1,
            65535,
        ),
    );
    requireHost({ remoteHost: host }, "remoteHost"); // validate host shape
    return { remoteHost: host, remotePort };
}

// ----------------------------------------------------------------------
// SRTLA streaming: the local srtla_send + the encoder pointed at it
// ----------------------------------------------------------------------

const SRTLA_RESTART_DELAY_MS = 2_000;
const srtlaSendBin = () => process.env.SRTLA_SEND_BIN ?? "srtla_send";
/** The network module's bonded uplinks file + change hook. */
let uplinks: Uplinks;
/** Unregister the uplinks-change handler on stop. */
let uplinksUnsub: (() => void) | undefined;

let srtlaSup: InstanceType<ModuleCore["Supervisor"]> | undefined;
const srtlaSupervisor = () =>
    (srtlaSup ??= new core.Supervisor("SRTLA_SEND", SRTLA_RESTART_DELAY_MS, onSrtlaExit));

/** The running (or last) srtla_send: target, pid, startedAt. */
let srtlaLive: SrtlaState = { running: false };

const srtlaRunning = (): boolean =>
    core.config.DRY_RUN ? srtlaLive.running : srtlaSupervisor().running;

function srtlaState(): SrtlaState {
    return srtlaRunning() ? srtlaLive : { ...srtlaLive, running: false, pid: undefined };
}

/** srtla_send died on its own: keep retrying like the relay does. */
function onSrtlaExit(code: number | null): void {
    console.log(`srtla_send exited with code ${code}`);
    if (!srtlaSupervisor().wanted) return;
    core.logEvent(
        "warn",
        "SRTLA_SEND",
        `srtla_send exited (code ${code}); restarting in ${SRTLA_RESTART_DELAY_MS / 1000}s`,
    );
    srtlaSupervisor().scheduleRestart();
}

async function startSrtlaSend(target: SrtlaTarget): Promise<void> {
    const bin = srtlaSendBin();
    if (srtlaRunning()) {
        const s = srtlaLive;
        if (
            s.listenPort === target.listenPort &&
            s.remoteHost === target.remoteHost &&
            s.remotePort === target.remotePort
        )
            return; // already aimed at the same target
        await stopSrtlaSend();
    }

    // The bonded uplinks file from the network module (same file the relay reloads on).
    await uplinks.ensure();
    const uplinksFile = uplinks.file();
    if (core.config.DRY_RUN) {
        console.log(
            `[DRY-RUN] Would start ${bin} ${target.listenPort} ${target.remoteHost} ${target.remotePort} ${uplinksFile}`,
        );
        srtlaLive = { running: true, ...target, startedAt: Date.now() };
        return;
    }
    // No control socket on the encoder leg; only the flags this build knows.
    const flags = srtlaSendFlags(await srtlaSendCapabilities(bin), {});
    const args = [
        ...flags,
        target.listenPort,
        target.remoteHost,
        target.remotePort,
        uplinksFile,
    ];
    console.log(`Starting ${bin} ${args.join(" ")}`);
    await srtlaSupervisor().start(() =>
        Bun.spawn([bin, ...args], {
            stdout: "inherit",
            stderr: "inherit",
            stdin: "inherit",
        }),
    );
    srtlaLive = {
        running: true,
        ...target,
        pid: srtlaSupervisor().pid,
        startedAt: Date.now(),
    };
}

async function stopSrtlaSend(): Promise<void> {
    if (!srtlaSup && !srtlaLive.running) return; // never started — nothing to stop
    await srtlaSup?.stop();
    srtlaLive = { ...srtlaLive, running: false, pid: undefined };
}

/** Ask srtla_send to re-read the uplinks file; true when the signal was delivered. */
function signalSrtlaReload(): boolean {
    if (core.config.DRY_RUN) {
        console.log("[DRY-RUN] SIGHUP srtla_send");
        return true;
    }
    const pid = srtlaRunning() ? srtlaSupervisor().pid : undefined;
    if (!pid) return false;
    try {
        process.kill(pid, "SIGHUP");
        return true;
    } catch {
        return false;
    }
}

/** Reload srtla_send after an uplinks-file change: SIGHUP, restart as fallback. */
async function reloadSrtlaSend(): Promise<void> {
    if (!srtlaRunning()) return;
    if (signalSrtlaReload()) {
        console.log("srtla_send sent SIGHUP (re-read uplinks)");
        return;
    }
    console.warn("SIGHUP failed — restarting srtla_send");
    const { listenPort, remoteHost, remotePort } = srtlaLive;
    if (!listenPort || !remoteHost || !remotePort) {
        console.warn("No srtla_send target cached — cannot restart");
        return;
    }
    await stopSrtlaSend();
    await startSrtlaSend({ listenPort, remoteHost, remotePort });
}

/** Bring up srtla_send (reusing it if already aimed at the same target), then the encoder into it. */
async function startStream(
    target: SrtlaTarget,
    cfg: EncoderConfig,
): Promise<void> {
    if (encoder().status().running) throw new Error("already streaming");
    // Keep the requested config even when validation fails, so the UI can restore it.
    data().encoder = cfg;
    data().streamTarget = target;
    await core.saveState();
    await encoder().validate(cfg); // fail before touching srtla_send

    const { listenPort } = target;
    try {
        await startSrtlaSend(target);
    } catch (e: unknown) {
        throw new ApiError(errorMessage(e), 409);
    }
    try {
        await encoder().start({ ...cfg, host: "127.0.0.1", port: listenPort });
    } catch (e: unknown) {
        await stopSrtlaSend();
        throw e;
    }
}

async function stopStream(): Promise<void> {
    await encoder().stop();
    await stopSrtlaSend();
}

const streamView = () => ({
    srtla: srtlaState(),
    encoder: encoder().status(),
});

// ----------------------------------------------------------------------
// Pipeline files and repositories
// ----------------------------------------------------------------------

const repositories = (): string[] => data().pipelineRepositories ?? [];

/**
 * Fresh pipeline list plus per-repository file counts, returned by every
 * pipeline mutation so the settings card can re-render from one payload.
 */
async function pipelinesPayload() {
    const pipelines = await listPipelines();
    return {
        pipelines,
        repositoryCounts: pipelinesByPrefix(
            pipelines.map((p) => p.id),
            repositories(),
        ),
    };
}

const pipelineId = (p: Params): string => requireString(p, "id").trim();
const repositoryParam = (p: Params): string =>
    requireString(p, "repository").trim();

async function pipelineMethod(method: string, p: Params): Promise<unknown> {
    switch (method) {
        case "pipelines.list":
            return { dir: PIPELINES_DIR, ...(await pipelinesPayload()) };
        case "pipelines.get": {
            const id = pipelineId(p);
            return { id, content: await readPipelineFile(id, PIPELINES_DIR) };
        }
        case "pipelines.create": {
            const id = pipelineId(p);
            await createPipelineFile(
                id,
                requireString(p, "content"),
                PIPELINES_DIR,
            );
            return { id, ...(await pipelinesPayload()) };
        }
        case "pipelines.update": {
            const id = pipelineId(p);
            await updatePipelineFile(
                id,
                requireString(p, "content"),
                PIPELINES_DIR,
            );
            return { id, ...(await pipelinesPayload()) };
        }
        case "pipelines.delete": {
            const id = pipelineId(p);
            await deletePipelineFile(id, PIPELINES_DIR);
            return { id, ...(await pipelinesPayload()) };
        }
        case "pipelines.repositories.add": {
            const repository = repositoryParam(p);
            const result = await syncPipelineRepository(
                repository,
                PIPELINES_DIR,
            );
            data().pipelineRepositories = [
                ...new Set(repositories()).add(repository),
            ].sort();
            await core.saveState();
            return {
                repositories: repositories(),
                result,
                ...(await pipelinesPayload()),
            };
        }
        case "pipelines.repositories.remove": {
            const repository = repositoryParam(p);
            await removePipelineRepository(repository, PIPELINES_DIR);
            data().pipelineRepositories = repositories().filter(
                (r) => r !== repository,
            );
            await core.saveState();
            return {
                repositories: repositories(),
                ...(await pipelinesPayload()),
            };
        }
        case "pipelines.repositories.update": {
            const repository = repositoryParam(p);
            if (!repositories().includes(repository))
                throw new ApiError(
                    `Repository not configured: ${repository}`,
                    404,
                );
            const result = await syncPipelineRepository(
                repository,
                PIPELINES_DIR,
            );
            return {
                repositories: repositories(),
                result,
                ...(await pipelinesPayload()),
            };
        }
        case "pipelines.repositories.updateAll": {
            const results = [];
            for (const repository of repositories())
                results.push(
                    await syncPipelineRepository(repository, PIPELINES_DIR),
                );
            return {
                repositories: repositories(),
                results,
                ...(await pipelinesPayload()),
            };
        }
        default:
            throw new ApiError(`Unknown method: ${method}`, 404);
    }
}

// ----------------------------------------------------------------------
// RPC
// ----------------------------------------------------------------------

async function dispatch(method: string, p: Params): Promise<unknown> {
    switch (method) {
        case "encoder.status":
            return { encoder: encoder().status() };
        case "encoder.stop":
            core.cancelAutostart();
            await encoder().stop();
            return { encoder: encoder().status() };
        case "encoder.bitrate": {
            if (p.minBitrate === undefined && p.maxBitrate === undefined)
                throw new ApiError("maxBitrate or minBitrate is required");
            const { minBitrate, maxBitrate } = parseBitrates(p, true);
            return {
                encoder: await encoder().setBitrate(minBitrate, maxBitrate),
            };
        }
        case "ceracoder.set": {
            const cera = ceracoder();
            if (!cera)
                throw new ApiError("The device encoder is not ceracoder");
            try {
                return { ceracoder: await cera.update(p) };
            } catch (e: unknown) {
                throw new ApiError(errorMessage(e));
            }
        }
        case "stream.start": {
            core.cancelAutostart();
            const { remoteHost, remotePort } = encoderDestination(p);
            const listenPort = String(
                optionalInt(
                    p,
                    "listenPort",
                    Number(data().streamTarget?.listenPort ?? 9000),
                    1,
                    65535,
                ),
            );
            const cfg = parseEncoderConfig(p, "127.0.0.1", listenPort);
            await startChecked(() =>
                startStream({ listenPort, remoteHost, remotePort }, cfg),
            );
            return streamView();
        }
        case "stream.stop":
            core.cancelAutostart();
            await stopStream();
            return streamView();
        default:
            return pipelineMethod(method, p);
    }
}

// ----------------------------------------------------------------------
// Registration
// ----------------------------------------------------------------------

const encoderModule: BackendModule<ModuleCore> = {
    kind: "device",
    id: "encoder",
    title: "Encoder",
    roleDefinitions: [
        {
            id: "encoder",
            titleKey: "role.encoder",
            taglineKey: "setup.role.encoder_tag",
            order: 20,
            setupSelectable: true,
        },
    ],
    secretFields: [],
    roles: ["encoder"],
    /** srtla_send points at the network module's bonded uplinks file. */
    dependencies: ["network"],
    methods: [
        "encoder.status",
        "encoder.stop",
        "encoder.bitrate",
        "ceracoder.set",
        "stream.start",
        "stream.stop",
        "pipelines.list",
        "pipelines.get",
        "pipelines.create",
        "pipelines.update",
        "pipelines.delete",
        "pipelines.repositories.add",
        "pipelines.repositories.remove",
        "pipelines.repositories.update",
        "pipelines.repositories.updateAll",
    ],
    events: [],
    log,
    bind: bindCore,
    async start(ctx: ModuleStartContext<ModuleCore>) {
        bindCore(ctx.core);
        uplinks = requireCapability<Uplinks>("network.uplinks");
        // Reload srtla_send whenever the network module rewrites the uplinks file.
        uplinksUnsub = uplinks.onChanged(async () => {
            console.log("Uplinks changed — reloading srtla_send");
            await reloadSrtlaSend();
        });
    },
    stop: async () => {
        uplinksUnsub?.();
        uplinksUnsub = undefined;
        await stopStream();
    },
    dispatch,

    /** Autostart: the last encoder config into the saved SRTLA target. */
    async resume() {
        const cfg = data().encoder;
        const target = data().streamTarget;
        if (!cfg || !target) return false;
        if (!encoder().status().running) await startStream(target, cfg);
        return true;
    },

    async status() {
        const state = encoder().status();
        return {
            state: {
                encoder: state,
                stream: data().streamTarget,
            },
            audioSources: await listAudioSources(),
            // null when the encoder binary is not ceracoder; the UI hides its settings then
            ceracoder: ceracoderConfig(),
            summary: { encoder: state, maxBitrate: state.config?.maxBitrate },
        };
    },
    settings: () => ({ pipelineRepositories: repositories() }),
    async setupInfo() {
        return {
            pipelines: await listPipelines(),
            audioSources: await listAudioSources(),
        };
    },
    /** Setup wizard (encoder): the SRTLA destination and the local listen port. */
    async setup(p: Params, role: Role) {
        if (role !== "encoder") return undefined;
        const listenPort = String(optionalInt(p, "listenPort", 9000, 1, 65535));
        const cfg = parseEncoderConfig(p, "127.0.0.1", listenPort);
        const { remoteHost, remotePort } = encoderDestination(p);
        return () => {
            data().encoder = cfg;
            data().streamTarget = { listenPort, remoteHost, remotePort };
        };
    },

    pages: [
        { match: /^\/pipelines\/(new|edit\/[^/]+)\/?$/, page: "pipelineedit" },
    ],
    dashboardWidgets: [{ type: "encoder", defaultSize: { w: 6, h: 5 } }],
    dashboardActions: [
        {
            id: "stop",
            label: "act.encoder.stop",
            icon: "⏹",
            method: "encoder.stop",
            confirm: true,
        },
        {
            id: "bitrate-low",
            label: "act.encoder.bitrate_low",
            icon: "▽",
            method: "encoder.bitrate",
            params: { maxBitrate: 1500 },
        },
        {
            id: "bitrate-high",
            label: "act.encoder.bitrate_high",
            icon: "△",
            method: "encoder.bitrate",
            params: { maxBitrate: 6000 },
        },
        // The SRTLA start: encoder → srtla_send → relay (or direct destination).
        // Destination defaults to relay:6000 (ENCODER_DESTINATION_* env).
        {
            id: "start",
            label: "act.encoder.start",
            icon: "▶",
            method: "stream.start",
        },
        // Stop the bonded stream (encoder + srtla_send) in one go.
        {
            id: "stream-stop",
            label: "act.encoder.stream_stop",
            icon: "⏹",
            method: "stream.stop",
            confirm: true,
        },
    ],
};

export default encoderModule;
