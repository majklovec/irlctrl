import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as eventlog from "../backend/client/eventlog";
import { handleRequest } from "../backend/client/methods";
import {
    ALL_MODULES,
    defaultModules,
    moduleById,
} from "../backend/client/modules";
import { state } from "../backend/client/state";
import { parseBitrates, parseEncoderConfig } from "../modules/encoder/params";
import type { Params } from "../shared/params";

const OBS = "obs-controller";
const originalSettings = state.settings;
const originalData = state.data;
const restores: (() => void)[] = [];

afterEach(() => {
    for (const restore of restores.splice(0).reverse()) restore();
    state.settings = originalSettings;
    state.data = originalData;
});

function combinedDevice() {
    const modules = defaultModules("combined");
    modules[OBS].enabled = true;
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

async function request(
    method: string,
    params: Params = {},
): Promise<RpcResponse> {
    return JSON.parse(
        await handleRequest(JSON.stringify({ id: "rpc-test", method, params })),
    );
}

function silenceLog() {
    const log = spyOn(eventlog, "logEvent").mockImplementation(() => {});
    restores.push(() => log.mockRestore());
    return log;
}

/** The core methods plus every module's own, as exposed over the socket. */
const CORE_METHODS = [
    "status",
    "log.list",
    "setup.get",
    "setup.complete",
    "settings.get",
    "settings.update",
    "modules.list",
    "modules.enable",
    "modules.disable",
    "modules.configure",
    "autostart.set",
];

describe("device RPC surface", () => {
    test("every method has exactly one owner", () => {
        const names = ALL_MODULES.flatMap((m) => m.methods ?? []);
        for (const name of CORE_METHODS) expect(names).not.toContain(name);
        expect(new Set(names).size).toBe(names.length);
        expect([...names].sort()).toEqual(
            [
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
                "pipelines.list",
                "pipelines.get",
                "pipelines.create",
                "pipelines.update",
                "pipelines.delete",
                "pipelines.repositories.add",
                "pipelines.repositories.remove",
                "pipelines.repositories.update",
                "pipelines.repositories.updateAll",
                "encoder.status",
                "encoder.start",
                "encoder.stop",
                "encoder.bitrate",
                "ceracoder.set",
                "stream.start",
                "stream.stop",
                "obs.request",
                "obs.requestBatch",
                "obs.setEventSubscriptions",
                "lowBitrateSwitcher.save",
                "ssh.status",
                "ssh.start",
                "ssh.stop",
                "ssh.reset_password",
                "ssh.set_password",
            ].sort(),
        );
    });

    test("keeps the read-only settings envelope and token redaction", async () => {
        combinedDevice();
        state.settings.remoteToken = "secret";
        const response = await request("settings.get");
        expect(response).toMatchObject({
            type: "response",
            id: "rpc-test",
            method: "settings.get",
            ok: true,
            result: {
                restartRequired: true,
                settings: { hasRemoteToken: true },
            },
        });
        expect(response).not.toHaveProperty("logged");
        expect(response.result?.settings).not.toHaveProperty("remoteToken");
    });

    test("status composes the module fragments", async () => {
        combinedDevice();
        const response = await request("status");
        expect(response.ok).toBe(true);
        expect(response.result).toMatchObject({
            role: "combined",
            state: { autostart: false },
            modules: { relay: { enabled: true }, encoder: { enabled: true } },
        });
        expect(response.result).toHaveProperty("summary");
        expect(response.result?.state).toHaveProperty("srtla");
        expect(response.result?.state).toHaveProperty("encoder");
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
        ["obs", "ssh.status"],
    ] as const)(
        "rejects %s before invoking %s or logging",
        async (role, method) => {
            state.settings = { ...originalSettings, role };
            const log = silenceLog();
            expect(await request(method)).toEqual({
                type: "response",
                id: "rpc-test",
                method,
                ok: false,
                error: `${method} is not available on ${role} devices`,
                code: 409,
            });
            expect(log).not.toHaveBeenCalled();
        },
    );

    test.each(["obs.request", "obs.requestBatch", "lowBitrateSwitcher.save"])(
        "gates %s on the OBS module before validation",
        async (method) => {
            const modules = combinedDevice();
            modules[OBS].enabled = false;
            const response = await request(method);
            expect(response.code).toBe(409);
            expect(response).not.toHaveProperty("logged");
        },
    );

    test.each([
        [
            "settings.update",
            { uuid: "changed" },
            "The device uuid can't be changed",
            false,
        ],
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
        "validates %s in the owning module and keeps the logged flag",
        async (method, params, error, logged) => {
            combinedDevice();
            // Always differ from the supplied update, regardless of local config.
            state.settings.uuid = "original";
            const log = silenceLog();
            expect(await request(method, params)).toEqual({
                type: "response",
                id: "rpc-test",
                method,
                ok: false,
                error,
                code: 400,
                ...(logged ? { logged: true } : {}),
            });
            expect(log).toHaveBeenCalledTimes(logged ? 1 : 0);
        },
    );

    test("routes a module method to its owner's dispatch with the raw params", async () => {
        combinedDevice();
        const log = silenceLog();
        const modems = moduleById("modems");
        if (!modems) throw new Error("modems module missing");
        const dispatch = spyOn(modems, "dispatch").mockResolvedValue({
            modemIndex: 2,
            action: "enable",
            ok: false,
        });
        restores.push(() => dispatch.mockRestore());
        expect(await request("modems.enable", { index: "2" })).toEqual({
            type: "response",
            id: "rpc-test",
            method: "modems.enable",
            ok: true,
            result: { modemIndex: 2, action: "enable", ok: false },
            logged: true,
        });
        expect(dispatch).toHaveBeenCalledWith("modems.enable", { index: "2" });
        expect(log).toHaveBeenCalledTimes(1);
    });

    test("unknown methods and unknown module ids are rejected", async () => {
        combinedDevice();
        expect((await request("nope.method")).code).toBe(404);
        const response = await request("modules.enable", { id: "nope" });
        expect(response).toMatchObject({
            ok: false,
            error: "Unknown module: nope",
        });
    });
});

describe("encoder parameter parsing", () => {
    test("validates bitrates in start order versus live-update order", () => {
        combinedDevice();
        const params = { minBitrate: "bad-min", maxBitrate: "bad-max" };
        expect(() => parseBitrates(params)).toThrow(
            "maxBitrate must be an integer",
        );
        expect(() => parseBitrates(params, true)).toThrow(
            "minBitrate must be an integer",
        );
        expect(() =>
            parseBitrates({ minBitrate: 2000, maxBitrate: 1000 }),
        ).toThrow("minBitrate must not exceed maxBitrate");
    });

    test("uses the saved encoder config as the defaults", () => {
        combinedDevice();
        const config = {
            pipeline: "saved",
            host: "old-host",
            port: "9000",
            minBitrate: 1000,
            maxBitrate: 4000,
            latency: 500,
            delay: -100,
            streamid: "old-stream",
            audioSource: "saved-source",
            audioCodec: "opus" as const,
            bitrateOverlay: true,
        };
        state.data = { ...originalData, encoder: config };
        expect(
            parseEncoderConfig(
                { pipeline: "new", streamid: "", audioSource: "" },
                "host",
                "1234",
            ),
        ).toEqual({
            ...config,
            pipeline: "new",
            host: "host",
            port: "1234",
            streamid: undefined,
        });
    });
});
