import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { buildStatus, handleRequest } from "../backend/client/methods";
import * as eventlog from "../backend/client/eventlog";
import { bondingMethods } from "../backend/client/methods/bonding";
import { parseBitrates, parseEncoderConfig } from "../backend/client/methods/encoder-config";
import { encoderStreamMethods } from "../backend/client/methods/encoder-stream";
import { moduleObsMethods } from "../backend/client/methods/modules-obs";
import { pipelineMethods } from "../backend/client/methods/pipelines";
import { setupSettingsStatusMethods } from "../backend/client/methods/setup-settings-status";
import { startChecked, type MethodContext } from "../backend/client/methods/shared";
import * as moduleCore from "../backend/client/module-core";
import type { Params } from "../shared/params";
import * as registry from "../shared/registry";
import * as routing from "../backend/client/routing";
import * as services from "../backend/client/services";
import { defaultModules, OBS_MODULE, state } from "../backend/client/state";
import * as stream from "../backend/client/stream";

const originalSettings = state.settings;
const originalEncoder = state.encoder;
const restores: (() => void)[] = [];

afterEach(() => {
    for (const restore of restores.splice(0).reverse()) restore();
    state.settings = originalSettings;
    state.encoder = originalEncoder;
});

function combinedDevice() {
    const modules = defaultModules("combined");
    modules[OBS_MODULE].enabled = true;
    state.settings = {
        ...originalSettings,
        role: "combined",
        language: "en",
        modules,
    };
    return modules;
}

interface RpcResponse {
    type: string;
    id: unknown;
    method: string;
    ok: boolean;
    result?: Record<string, unknown>;
    error?: string;
    code?: number;
    logged?: boolean;
}

async function request(method: string, params: Params = {}): Promise<RpcResponse> {
    return JSON.parse(
        await handleRequest(JSON.stringify({ id: "domain-test", method, params })),
    );
}

function silenceLog() {
    const log = spyOn(eventlog, "logEvent").mockImplementation(() => {});
    restores.push(() => log.mockRestore());
    return log;
}

describe("device RPC domain composition", () => {
    test("preserves the status export and every method without overlapping domains", () => {
        expect(typeof buildStatus).toBe("function");
        const context: MethodContext = {
            services,
            routing,
            registry,
            moduleCore,
            stream,
            applyRemoteSettings: () => {
                throw new Error("Unexpected remote settings change");
            },
        };
        const maps = [
            setupSettingsStatusMethods(context),
            bondingMethods(context),
            pipelineMethods(context),
            encoderStreamMethods(context),
            moduleObsMethods(context),
        ];
        const names = maps.flatMap(Object.keys);
        expect(new Set(names).size).toBe(names.length);
        expect(names.sort()).toEqual([
            "status", "setup.get", "setup.complete", "settings.get",
            "settings.update", "interfaces.list", "reconfigure", "modems.list",
            "modems.select", "modems.toggle", "modems.enable", "modems.disable",
            "modems.reset", "modems.connect", "modems.disconnect",
            "srtla.status", "srtla.start", "srtla.stop", "srtla.reload",
            "srtla.stats", "srtla.options", "pipelines.list", "pipelines.get",
            "pipelines.create", "pipelines.update", "pipelines.delete",
            "pipelines.repositories.add", "pipelines.repositories.remove",
            "pipelines.repositories.update", "pipelines.repositories.updateAll",
            "encoder.status", "encoder.start", "encoder.stop", "encoder.bitrate",
            "ceracoder.set", "stream.start", "stream.stop", "autostart.set",
            "log.list", "modules.list", "modules.enable", "modules.disable",
            "modules.configure", "obs.request", "obs.requestBatch",
            "obs.setEventSubscriptions", "lowBitrateSwitcher.save",
        ].sort());
    });

    test.each([
        "bonding", "encoder-config", "encoder-stream", "modules-obs",
        "pipelines", "setup-settings-status", "shared",
    ])("can import %s before the composition point", (domain) => {
        const child = Bun.spawnSync([
            process.execPath,
            "--eval",
            `import "./backend/client/methods/${domain}.ts";
             import { handleRequest } from "./backend/client/methods.ts";
             console.log(await handleRequest('{"method":"settings.get"}'));`,
        ], { cwd: new URL("../", import.meta.url).pathname });
        expect(child.stderr.toString()).toBe("");
        expect(child.exitCode).toBe(0);
        expect(JSON.parse(child.stdout.toString())).toMatchObject({
            method: "settings.get",
            ok: true,
            result: { restartRequired: true },
        });
    });

    test("keeps the read-only settings envelope and token redaction", async () => {
        combinedDevice();
        state.settings.remoteToken = "secret";
        expect(await request("settings.get")).toMatchObject({
            type: "response",
            id: "domain-test",
            method: "settings.get",
            ok: true,
            result: { restartRequired: true, settings: { hasRemoteToken: true } },
        });
        const response = await request("settings.get");
        expect(response).not.toHaveProperty("logged");
        expect(response.result?.settings).not.toHaveProperty("remoteToken");
    });

    test.each([
        ["relay", "encoder.start"],
        ["relay", "pipelines.list"],
        ["relay", "ceracoder.set"],
        ["relay", "stream.start"],
        ["encoder", "modems.enable"],
        ["encoder", "srtla.start"],
        ["encoder", "reconfigure"],
        ["encoder", "stream.stop"],
    ] as const)("authorizes %s before invoking %s or logging", async (role, method) => {
        state.settings = { ...originalSettings, role };
        const log = silenceLog();
        expect(await request(method)).toEqual({
            type: "response",
            id: "domain-test",
            method,
            ok: false,
            error: `${method} is not available on ${role} devices`,
            code: 409,
        });
        expect(log).not.toHaveBeenCalled();
    });

    test.each(["obs.request", "obs.requestBatch", "lowBitrateSwitcher.save"])(
        "gates %s on the OBS module before validation",
        async (method) => {
            const modules = combinedDevice();
            modules[OBS_MODULE].enabled = false;
            const response = await request(method);
            expect(response.code).toBe(409);
            expect(response).not.toHaveProperty("logged");
        },
    );

    test.each([
        ["settings.update", { uuid: "changed" }, "The device uuid can't be changed", false],
        ["modems.enable", {}, "index must be a non-negative integer", true],
        ["srtla.start", {}, "listenPort is required", true],
        ["srtla.options", {}, "mode or quality is required", true],
        ["pipelines.get", {}, "id is required", false],
        ["pipelines.create", {}, "id is required", true],
        ["encoder.start", {}, "host is required", true],
        ["encoder.bitrate", {}, "maxBitrate or minBitrate is required", true],
        ["stream.start", {}, "remoteHost is required", true],
        ["autostart.set", {}, "enabled must be a boolean", true],
        ["modules.enable", {}, "id is required", true],
        ["obs.request", {}, "requestType is required", false],
        ["obs.requestBatch", {}, "requests must be a non-empty array", false],
    ] satisfies [string, Params, string, boolean][])(
        "preserves %s validation and logged flags",
        async (method, params, error, logged) => {
            combinedDevice();
            // Always differ from the supplied update, regardless of local config.
            state.settings.uuid = "original";
            const log = silenceLog();
            expect(await request(method, params)).toEqual({
                type: "response",
                id: "domain-test",
                method,
                ok: false,
                error,
                code: 400,
                ...(logged ? { logged: true } : {}),
            });
            expect(log).toHaveBeenCalledTimes(logged ? 1 : 0);
        },
    );

    test("keeps modem dispatch arguments and the logged success envelope", async () => {
        combinedDevice();
        const log = silenceLog();
        const dispatch = spyOn(registry, "callModule").mockResolvedValue(false);
        restores.push(() => dispatch.mockRestore());
        expect(await request("modems.enable", { index: "2" })).toEqual({
            type: "response",
            id: "domain-test",
            method: "modems.enable",
            ok: true,
            result: { modemIndex: 2, action: "enable", ok: false },
            logged: true,
        });
        expect(dispatch).toHaveBeenCalledWith("modems.enable", { index: 2 });
        expect(log).toHaveBeenCalledTimes(1);
    });

    test("preserves OBS batch normalization and unmapped module responses", async () => {
        combinedDevice();
        const result = { requestId: "batch", results: [{ requestStatus: { code: 600 } }] };
        const dispatch = spyOn(registry, "callModule").mockResolvedValue(result);
        restores.push(() => dispatch.mockRestore());
        const response = await request("obs.requestBatch", {
            requestId: "batch",
            requests: [{ requestType: "GetVersion", requestId: "item", requestData: {} }],
            haltOnFailure: "false",
            executionType: 2,
        });
        expect(response.result).toEqual(result);
        expect(response).not.toHaveProperty("logged");
        expect(dispatch).toHaveBeenCalledWith("obs.requestBatch", {
            requestId: "batch",
            requests: [{ requestType: "GetVersion", requestId: "item", requestData: {} }],
            haltOnFailure: true,
            executionType: 2,
        });
    });
});

describe("shared encoder parsing and start errors", () => {
    test("preserves autostart cancellation before manual validation but after stream validation", async () => {
        let cancellations = 0;
        const context = {
            services,
            registry,
            routing,
            stream: {
                ...stream,
                cancelAutostart: () => { cancellations++; },
            },
        };
        const bonding = bondingMethods(context);
        const encoder = encoderStreamMethods(context);
        await expect(bonding["srtla.start"]({})).rejects.toThrow("listenPort is required");
        expect(cancellations).toBe(1);
        await expect(encoder["encoder.start"]({})).rejects.toThrow("host is required");
        expect(cancellations).toBe(2);
        await expect(encoder["stream.start"]({})).rejects.toThrow("remoteHost is required");
        expect(cancellations).toBe(2);
    });

    test("preserves bitrate validation order for start versus live updates", () => {
        const params = { minBitrate: "bad-min", maxBitrate: "bad-max" };
        expect(() => parseBitrates(params)).toThrow("maxBitrate must be an integer");
        expect(() => parseBitrates(params, true)).toThrow("minBitrate must be an integer");
        expect(() => parseBitrates({ minBitrate: 2000, maxBitrate: 1000 }))
            .toThrow("minBitrate must not exceed maxBitrate");
    });

    test("uses the same saved encoder defaults for setup and start", () => {
        const config = {
            pipeline: "saved", host: "old-host", port: "9000",
            minBitrate: 1000, maxBitrate: 4000, latency: 500, delay: -100,
            streamid: "old-stream", audioSource: "saved-source",
            audioCodec: "opus" as const, bitrateOverlay: true,
        };
        state.encoder = { running: false, config };
        expect(parseEncoderConfig(
            { pipeline: "new", streamid: "", audioSource: "" },
            "host",
            "1234",
            services.encoderServices,
        ))
            .toEqual({ ...config, pipeline: "new", host: "host", port: "1234", streamid: undefined });
    });

    test.each([
        ["already running", 409],
        ["Invalid pipeline", 400],
        ["Unknown audio source", 400],
        ["process exited", 500],
    ])("preserves the start error mapping for %s", async (message, code) => {
        await expect(startChecked(async () => {
            throw new Error(message);
        })).rejects.toMatchObject({ message, code });
    });
});
