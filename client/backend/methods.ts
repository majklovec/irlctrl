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
 *   { "type": "event", "event": "<module event>", "data": {...}, "module": "<id>" }
 *
 * Core methods:
 *   status, log.list
 *   setup.get, setup.complete {...wizard answers}   (only while the device has no config file)
 *   settings.get, settings.update {hostname?, role?, color?, remoteUrl?, remoteToken?, language?}
 *   modules.list, modules.enable {id}, modules.disable {id}, modules.configure {id, config}
 *   autostart.set {enabled}   resume the last run when the service starts
 *
 * Every other method belongs to a module (modules/<id>/backend.ts `methods`)
 * and is routed to its `dispatch` — which validates the parameters itself.
 * A module's methods are rejected with 409 outside the roles it serves (and,
 * when it says so, while it is disabled). Methods that change something are
 * recorded in the event log (success or failure); their responses carry
 * `"logged": true` so clients do not log them a second time.
 */

import { randomUUID } from "node:crypto";
import { LANGUAGES, setCurrentLanguage, t } from "../../shared/i18n";
import { isLoggedMethod, methodLog } from "../../shared/logMessages";
import type { Params } from "../../shared/module-contract";
import {
    ApiError,
    checkColor,
    checkHostname,
    checkRemoteUrl,
    oneOf,
    optionalSettingString,
    requireBoolean,
    requireString,
} from "../../shared/params";
import { errorMessage, textOf } from "../../shared/util";
import { DEFAULT_COLOR } from "../../shared/validate";
import { registeredRoleIds, roleDefinitions } from "../../shared/registry";
import { setAutostart } from "./autostart";
import { logEntries, logEvent } from "./eventlog";
import {
    callModule,
    configureModule,
    effectiveRole,
    finishSetup,
    methodAllowed,
    methodOwner,
    moduleById,
    moduleSettings,
    moduleSetupInfo,
    moduleStatuses,
    restartModule,
    safeModules,
    setModuleEnabled,
    setupModules,
} from "./modules";
import { applyRemoteSettings } from "./remote";
import {
    type DeviceSettings,
    saveState,
    setupRequired,
    state,
    uiLanguage,
} from "./state";

type Method = (params: Params) => Promise<object> | object;

/** The `status` payload: the core fields plus every applicable module's fragment. */
export async function buildStatus(): Promise<Record<string, unknown>> {
    const fragments = await moduleStatuses();
    return {
        role: effectiveRole(),
        setupRequired,
        ...fragments,
        state: { ...(fragments.state as object), autostart: !!state.autostart },
        modules: safeModules(),
    };
}

const settingsView = () => {
    const s = state.settings;
    return {
        uuid: s.uuid ?? "",
        hostname: s.hostname ?? "",
        role: s.role ?? "",
        remoteUrl: s.remoteUrl ?? "",
        hasRemoteToken: !!s.remoteToken,
        color: s.color ?? DEFAULT_COLOR,
        language: uiLanguage(),
        ...moduleSettings(),
        roleDefinitions: roleDefinitions().filter((role) => role.setupSelectable !== false),
    };
};

/** [field, label] pairs for the settings re-registered & logged on change. */
const settingFields: ReadonlyArray<
    readonly [key: keyof DeviceSettings, label: string]
> = [
    ["hostname", "name"],
    ["role", "role"],
    ["remoteUrl", "remote URL"],
    ["remoteToken", "remote token"],
    ["color", "color"],
];

/** First-run wizard: validate all fields, write the initial state and bring the role up. */
async function setupComplete(p: Params): Promise<object> {
    if (!setupRequired)
        throw new ApiError("Setup has already been completed", 409);
    const language =
        p.language === undefined
            ? "en"
            : oneOf(p.language, "language", LANGUAGES);
    const role = oneOf(requireString(p, "role"), "role", registeredRoleIds());
    const hostname = checkHostname(requireString(p, "hostname").trim());
    const color = checkColor(requireString(p, "color"));
    const remoteUrl = checkRemoteUrl(
        optionalSettingString(p, "remoteUrl", undefined),
    );
    const remoteToken = optionalSettingString(p, "remoteToken", undefined);
    const applyModules = await setupModules(p, role);

    // Everything is valid: apply
    await applyModules();
    state.autostart = p.autostart === true;
    // The uuid is auto-assigned from the start and never changes afterwards.
    state.settings = {
        ...state.settings,
        uuid: state.settings.uuid ?? randomUUID(),
        hostname,
        role,
        color,
        remoteUrl,
        remoteToken,
        language,
    };
    setCurrentLanguage(language);
    await finishSetup(role);
    if (remoteUrl) applyRemoteSettings(remoteUrl, remoteToken);
    return { completed: true, restartRequired: true };
}

/** Partial update of the persisted settings; the device uuid is immutable. */
async function updateSettings(p: Params): Promise<object> {
    const current = state.settings;
    if (p.uuid !== undefined && p.uuid !== current.uuid)
        throw new ApiError("The device uuid can't be changed");
    const hostname = checkHostname(
        optionalSettingString(p, "hostname", current.hostname),
    );
    const roleValue = optionalSettingString(p, "role", current.role);
    const role =
        roleValue === undefined
            ? undefined
            : oneOf(roleValue, "role", registeredRoleIds());
    const remoteUrl = checkRemoteUrl(
        optionalSettingString(p, "remoteUrl", current.remoteUrl),
    );
    if (p.remoteToken !== undefined && typeof p.remoteToken !== "string")
        throw new ApiError("remoteToken must be a string");
    const remoteToken =
        p.remoteToken === undefined
            ? current.remoteToken
            : p.remoteToken.trim() || undefined;
    const color = checkColor(optionalSettingString(p, "color", current.color));
    const language =
        p.language === undefined
            ? uiLanguage()
            : oneOf(p.language, "language", LANGUAGES);
    const next: DeviceSettings = {
        ...current,
        hostname,
        role,
        remoteUrl,
        remoteToken,
        color,
        language,
    };
    // Labels of the settings that moved from their saved value. A non-empty
    // list means the box must re-register with the control server (new
    // name / dot color / endpoint); an empty remote url stops the link.
    const changed = settingFields
        .filter(([key]) => current[key] !== next[key])
        .map(([, label]) => label);

    state.settings = next;
    setCurrentLanguage(language);
    await saveState();
    if (changed.length > 0) applyRemoteSettings(remoteUrl ?? "", remoteToken);
    logEvent(
        "info",
        "Settings",
        changed.length > 0
            ? t("log.settings_saved_fields", { fields: changed.join(", ") })
            : t("mlog.done.settings_saved"),
    );
    return { settings: settingsView(), restartRequired: true };
}

const requireModule = (p: Params) => {
    const id = requireString(p, "id");
    const mod = moduleById(id);
    if (!mod || mod.kind !== "device")
        throw new ApiError(`Unknown module: ${id}`);
    return mod;
};

const CORE_METHODS: Record<string, Method> = {
    status: buildStatus,
    "log.list": () => ({ entries: logEntries() }),
    "setup.get": async () => ({
        required: setupRequired,
        hostname: state.settings.hostname ?? "",
        color: state.settings.color ?? DEFAULT_COLOR,
        language: uiLanguage(),
        ...(await moduleSetupInfo()),
        roleDefinitions: roleDefinitions().filter((role) => role.setupSelectable !== false),
    }),
    "setup.complete": setupComplete,
    "settings.get": () => ({ settings: settingsView(), restartRequired: true }),
    "settings.update": updateSettings,
    "modules.list": () => ({ modules: safeModules() }),
    "modules.enable": async (p) => {
        const mod = requireModule(p);
        setModuleEnabled(mod, true);
        await saveState();
        void restartModule(mod);
        return { ok: true, modules: safeModules() };
    },
    "modules.disable": async (p) => {
        const mod = requireModule(p);
        setModuleEnabled(mod, false);
        await saveState();
        void restartModule(mod);
        return { ok: true, modules: safeModules() };
    },
    "modules.configure": async (p) => {
        const mod = requireModule(p);
        const config =
            p.config && typeof p.config === "object" && !Array.isArray(p.config)
                ? (p.config as Params)
                : {};
        configureModule(mod, config);
        await saveState();
        void restartModule(mod);
        return { ok: true, modules: safeModules() };
    },
    "autostart.set": async (p) => {
        await setAutostart(requireBoolean(p, "enabled"));
        return { autostart: !!state.autostart };
    },
};

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

        const core = Object.hasOwn(CORE_METHODS, method)
            ? CORE_METHODS[method]
            : undefined;
        const owner = core ? undefined : methodOwner(method);
        if (!core && !owner)
            throw new ApiError(`Unknown method: ${method}`, 404);
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
        const result = core
            ? await core(params)
            : await callModule(method, params);
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
                t("mlog.failed", { action, reason: errorMessage(err) }),
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
