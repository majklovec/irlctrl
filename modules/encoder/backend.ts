/*
 * Encoder module: belacoder / ceracoder management for encoder and combined
 * devices — the encoder process (./encoder), pipeline and audio-source
 * discovery (./sources), pipeline files and GitHub pipeline repositories
 * (./pipelines, ./pipeline-repos), and combined streaming: srtla_send (the
 * srtla module, through the `stream.srtla` capability) fed by the encoder.
 *
 * Persisted sections: `encoder` (last used config), `ceracoder`,
 * `pipelineRepositories`. Live process state is module-local.
 */
import type { ModuleCore } from "../../backend/client/module-core";
import type {
    BackendModule,
    ModuleStartContext,
    Params,
} from "../../shared/module-contract";
import {
    ApiError,
    optionalInt,
    requireHost,
    requirePort,
    requireString,
} from "../../shared/params";
import { errorMessage } from "../../shared/util";
import type { Role } from "../../shared/validate";
import { PIPELINES_DIR } from "./config";
import { bindCore, core, data } from "./core";
import { ceracoder, ceracoderConfig, encoder, stopEncoder } from "./encoder";
import log from "./log";
import { parseBitrates, parseEncoderConfig } from "./params";
import {
    removePipelineRepository,
    syncPipelineRepository,
} from "./pipeline-repos";
import {
    createPipelineFile,
    deletePipelineFile,
    pipelinesByPrefix,
    readPipelineFile,
    updatePipelineFile,
} from "./pipelines";
import { listAudioSources, listPipelines } from "./sources";
import type { EncoderConfig, SrtlaCapability, SrtlaTarget } from "./types";

const srtla = (): SrtlaCapability =>
    core.requireCapability<SrtlaCapability>("stream.srtla");

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

// ----------------------------------------------------------------------
// Combined streaming: srtla_send + the encoder pointed at it
// ----------------------------------------------------------------------

/** Bring up srtla_send (reusing it if already aimed at the same target), then the encoder into it. */
async function startCombined(
    target: SrtlaTarget,
    cfg: EncoderConfig,
): Promise<void> {
    if (encoder().status().running) throw new Error("already streaming");
    // Keep the requested config even when validation fails, so the UI can restore it.
    data().encoder = cfg;
    await core.saveState();
    await encoder().validate(cfg); // fail before touching srtla_send

    const { listenPort, remoteHost, remotePort } = target;
    const s = srtla().srtlaStatus();
    if (
        s.running &&
        (s.listenPort !== listenPort ||
            s.remoteHost !== remoteHost ||
            s.remotePort !== remotePort)
    )
        await srtla().stopSrtla();
    if (!srtla().srtlaStatus().running)
        await srtla().startSrtla(listenPort, remoteHost, remotePort);

    try {
        await encoder().start({ ...cfg, host: "127.0.0.1", port: listenPort });
    } catch (e: unknown) {
        await srtla().stopSrtla();
        throw e;
    }
}

async function stopCombined(): Promise<void> {
    await encoder().stop();
    await srtla().stopSrtla();
}

const streamView = () => ({
    srtla: srtla().srtlaStatus(),
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
        case "encoder.start": {
            core.cancelAutostart();
            const cfg = parseEncoderConfig(
                p,
                requireHost(p, "host"),
                requirePort(p, "port"),
            );
            return { encoder: await startChecked(() => encoder().start(cfg)) };
        }
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
            const remoteHost = requireHost(p, "remoteHost");
            const remotePort = requirePort(p, "remotePort");
            const listenPort = String(
                optionalInt(
                    p,
                    "listenPort",
                    Number(srtla().target()?.listenPort ?? 9000),
                    1,
                    65535,
                ),
            );
            const cfg = parseEncoderConfig(p, "127.0.0.1", listenPort);
            await startChecked(() =>
                startCombined({ listenPort, remoteHost, remotePort }, cfg),
            );
            return streamView();
        }
        case "stream.stop":
            core.cancelAutostart();
            await stopCombined();
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
        {
            id: "combined",
            titleKey: "role.combined",
            taglineKey: "setup.role.combined_tag",
            order: 30,
            setupSelectable: true,
        },
    ],
    secretFields: [],
    roles: ["encoder", "combined"],
    methodRoles: { "stream.start": ["combined"], "stream.stop": ["combined"] },
    dependencies: ["srtla"],
    methods: [
        "encoder.status",
        "encoder.start",
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
    },
    stop: stopEncoder,
    dispatch,

    /** Autostart: the last encoder config (combined: into the saved srtla target). */
    async resume() {
        const cfg = data().encoder;
        if (!cfg) return false;
        if (core.role() === "combined") {
            const target = srtla().target();
            if (!target) return false;
            if (!encoder().status().running) await startCombined(target, cfg);
            return true;
        }
        if (!encoder().status().running) await encoder().start(cfg);
        return true;
    },

    async status() {
        const state = encoder().status();
        return {
            state: {
                encoder: state,
                stream:
                    core.role() === "combined" ? srtla().target() : undefined,
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
    async setup(p: Params, role: Role) {
        let cfg: EncoderConfig;
        if (role === "combined")
            // Combined devices stream into their own srtla_send
            cfg = parseEncoderConfig(
                p,
                "127.0.0.1",
                requirePort(p, "listenPort"),
            );
        else if (role === "encoder")
            cfg = parseEncoderConfig(
                p,
                requireHost(p, "encoderHost"),
                requirePort(p, "encoderPort"),
            );
        else return undefined;
        return () => {
            data().encoder = cfg;
        };
    },

    pages: [
        { match: /^\/pipelines\/(new|edit\/[^/]+)\/?$/, page: "pipelineedit" },
    ],
    dashboardWidgets: [
        { type: "encoder", defaultSize: { w: 6, h: 5 } },
        { type: "combined", defaultSize: { w: 6, h: 10 } },
    ],
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
        // Needs `pipeline`, `host` and `port` — set them in the button's params override.
        {
            id: "start",
            label: "act.encoder.start",
            icon: "▶",
            method: "encoder.start",
        },
        // Combined boxes: stop the bonded stream (encoder + srtla) in one go.
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
