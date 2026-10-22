/*
 * WebSocket API methods and request dispatch. Transport-agnostic: the local server
 * (api.ts) and the remote control link (remote.ts) both pass raw frames to handleRequest().
 *
 * Client → server (request):
 *   { "id": 1, "method": "modems.toggle", "params": { "iface": "wwan0" } }
 *
 * Server → client (response to a request, `id` echoed back):
 *   { "type": "response", "id": 1, "method": "modems.toggle", "ok": true,  "result": { ... } }
 *   { "type": "response", "id": 1, "method": "modems.toggle", "ok": false, "error": "...", "code": 404 }
 *
 * Server → client (push, sent on connect and whenever state changes; see push.ts):
 *   { "type": "event", "event": "status", "data": { ...same as `status` result... } }
 *   { "type": "event", "event": "log", "data": { "reset"?: true, "entries": [LogEntry, ...] } }
 *     (full history with `reset` on connect, then each new or updated entry; see logMessages.ts)
 *   { "type": "event", "event": "srtla.stats", "data": { "at": <ms>, "stats": {...} | null } }
 *     (~1 Hz while srtla_send runs with a control socket; `null` when it stops)
 *
 * Methods:
 *   status, interfaces.list, reconfigure, log.list
 *   setup.get, setup.complete {...wizard answers}   (only while the device has no config file)
 *   settings.get, settings.update {hostname?, role?, color?, remoteUrl?, remoteToken?, language?}
 *   modems.list, modems.select {modems?|ips?}, modems.toggle {iface}
 *   modems.enable|disable|reset|connect|disconnect {index}
 *   srtla.status, srtla.start {listenPort, remoteHost, remotePort}, srtla.stop, srtla.reload
 *   srtla.stats   latest per-link telemetry from srtla_send's control socket
 *   srtla.options {mode? ("classic"|"enhanced"), quality? (bool)}   applied live when possible
 *   pipelines.list   (also `repositoryCounts`: per-repo pipeline counts)
 *   pipelines.get {id}, pipelines.create {id, content},
 *   pipelines.update {id, content}, pipelines.delete {id}
 *   pipelines.repositories.add {repository}, pipelines.repositories.remove {repository},
 *   pipelines.repositories.update {repository}, pipelines.repositories.updateAll
 *   encoder.status, encoder.start {pipeline, host, port, minBitrate?, maxBitrate?, latency?, delay?,
 *                                  streamid?, audioSource?, audioCodec? ("aac"|"opus"), bitrateOverlay?},
 *   encoder.stop, encoder.bitrate {maxBitrate?, minBitrate?}   (at least one; applied live)
 *   ceracoder.set {balancer? ("adaptive"|"fixed"|"aimd"), adaptive? {incrStep?,
 *                   decrStep?, incrInterval?, decrInterval?}, aimd? {incrStep?, decrMult?,
 *                   incrInterval?, decrInterval?}}   (ceracoder encoder only; applied live)
 *   stream.start {pipeline, remoteHost, remotePort, listenPort?, ...same encoder options},
 *   stream.stop   (combined devices: srtla_send + belacoder in one action)
 *   autostart.set {enabled}   resume the last stream when the service starts
 *
 * Methods are limited by the device role (--role): relay → modems/srtla/reconfigure,
 * encoder → pipelines/encoder, combined → everything plus stream.*.
 * Methods that change something are recorded in the event log (success or failure); their
 * responses carry `"logged": true` so clients do not log them a second time.
 */
import { logEvent } from "./eventlog";
import { t } from "../../shared/i18n";
import { isLoggedMethod, methodLog } from "../../shared/logMessages";
import { bondingMethods } from "./methods/bonding";
import { encoderStreamMethods } from "./methods/encoder-stream";
import { moduleObsMethods } from "./methods/modules-obs";
import { pipelineMethods } from "./methods/pipelines";
import {
    buildStatus as domainBuildStatus,
    setupSettingsStatusMethods,
} from "./methods/setup-settings-status";
import {
    effectiveRole,
    type MethodContext,
    type MethodMap,
} from "./methods/shared";
import * as moduleCore from "./module-core";
import { moduleEnabled } from "./module-core";
import { ApiError, type Params } from "../../shared/params";
import { applyRemoteSettings } from "./remote";
import * as registry from "../../shared/registry";
import * as routing from "./routing";
import * as services from "./services";
import { OBS_MODULE } from "./state";
import * as stream from "./stream";
import { errorMessage, textOf } from "../../shared/util";

const methodContext = (): MethodContext => ({
    services,
    routing,
    moduleCore,
    registry,
    stream,
    applyRemoteSettings,
});

export async function buildStatus() {
    return domainBuildStatus(methodContext());
}

// Registry discovery and the push/remote transports import this composition
// point too. Bind domain dependencies only once the first request arrives.
let methods: MethodMap | undefined;
function deviceMethods(): MethodMap {
    if (!methods) {
        const context = methodContext();
        methods = {
            ...setupSettingsStatusMethods(context),
            ...bondingMethods(context),
            ...pipelineMethods(context),
            ...encoderStreamMethods(context),
            ...moduleObsMethods(context),
        };
    }
    return methods;
}

function methodAllowed(name: string): boolean {
    const role = effectiveRole();
    if (name.startsWith("stream.")) return role === "combined";
    // Module-owned API surface: 409 when the owning module is disabled
    // (the low-bitrate switcher rides on the OBS module now)
    if (
        (name.startsWith("obs.") || name.startsWith("lowBitrateSwitcher.")) &&
        !moduleEnabled(OBS_MODULE)
    )
        return false;
    if (
        name.startsWith("encoder.") ||
        name.startsWith("ceracoder.") ||
        name.startsWith("pipelines.")
    )
        return role !== "relay";
    if (
        name.startsWith("modems.") ||
        name.startsWith("srtla.") ||
        name === "reconfigure"
    )
        return role !== "encoder";
    return true;
}

// ----------------------------------------------------------------------
// Dispatch
// ----------------------------------------------------------------------
/** Dispatch one request message; returns the serialized response. */
export async function handleRequest(
    raw: string | Buffer | ArrayBuffer | Uint8Array,
): Promise<string> {
    let id: unknown = null;
    let method = "";
    let logged = false;
    try {
        let msg: unknown;
        try {
            msg = JSON.parse(textOf(raw));
        } catch {
            throw new ApiError("Invalid JSON");
        }
        if (!msg || typeof msg !== "object" || Array.isArray(msg))
            throw new ApiError("Message must be a JSON object");
        const req = msg as { id?: unknown; method?: unknown; params?: unknown };
        id = req.id ?? null;
        if (typeof req.method !== "string")
            throw new ApiError("method is required");
        method = req.method;

        const handlers = deviceMethods();
        const handler = Object.hasOwn(handlers, method)
            ? handlers[method]
            : undefined;
        if (!handler) throw new ApiError(`Unknown method: ${method}`, 404);
        if (!methodAllowed(method))
            throw new ApiError(
                `${method} is not available on ${effectiveRole()} devices`,
                409,
            );

        const params: Params =
            req.params &&
            typeof req.params === "object" &&
            !Array.isArray(req.params)
                ? (req.params as Params)
                : {};
        logged = isLoggedMethod(method);
        const result = await handler(params);
        if (logged) {
            const { section, done } = methodLog(method);
            logEvent("info", section, done(params));
        }
        return JSON.stringify({
            type: "response",
            id,
            method,
            ok: true,
            result,
            ...(logged ? { logged } : {}),
        });
    } catch (err: unknown) {
        const code = err instanceof ApiError ? err.code : 500;
        if (code >= 500) console.error(`API error (${method || "?"}):`, err);
        if (logged) {
            const { section, action } = methodLog(method);
            logEvent(
                "error",
                section,
                t("mlog.failed", {
                    action,
                    reason: errorMessage(err),
                }),
            );
        }
        return JSON.stringify({
            type: "response",
            id,
            method,
            ok: false,
            error: errorMessage(err),
            code,
            ...(logged ? { logged } : {}),
        });
    }
}
