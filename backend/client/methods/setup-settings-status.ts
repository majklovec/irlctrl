import { randomUUID } from "node:crypto";
import type {
    EncoderConfig,
    ModemInfo,
    SwitcherStatus,
} from "../../../shared/types";
import { RELOAD_MODE, UPLINKS_FILE } from "../config";
import { logEntries, logEvent } from "../eventlog";
import { LANGUAGES, setCurrentLanguage, t } from "../../../shared/i18n";
import {
    ApiError,
    checkColor,
    checkHostname,
    checkRemoteUrl,
    oneOf,
    optionalSettingString,
    type Params,
    requireBoolean,
    requireHost,
    requirePort,
    requireString,
} from "../../../shared/params";
import {
    completeSetup,
    type DeviceSettings,
    type SrtlaOptions,
    saveState,
    setupRequired,
    type SrtlaTarget,
    state,
    uiLanguage,
} from "../state";
import { DEFAULT_COLOR, ROLES } from "../../../shared/validate";
import { parseEncoderConfig } from "./encoder-config";
import { effectiveRole, type MethodContext, type MethodMap } from "./shared";

type Context = Pick<
    MethodContext,
    "services" | "routing" | "moduleCore" | "registry" | "applyRemoteSettings"
>;

export async function buildStatus(context: Context) {
    const { encoderServices, srtlaServices } = context.services;
    const { detectInterfaces, isMonitorRunning, resolveSelection } =
        context.routing;
    const { moduleStatuses } = context.registry;
    const { safeModules } = context.moduleCore;
    const role = effectiveRole();
    const enc = encoderServices.encoder();
    // One ModemManager scan serves both interface enrichment and the modem list.
    const modFragments = await moduleStatuses();
    const modems = modFragments.modems as ModemInfo[];
    const [interfaces, audioSources] = await Promise.all([
        detectInterfaces(modems),
        role !== "relay" ? encoderServices.listAudioSources() : [],
    ]);
    return {
        role,
        setupRequired,
        state: {
            selection: state.selection,
            srtla: srtlaServices.srtlaStatus(),
            encoder: enc.status(),
            stream: state.stream,
            srtlaTarget: state.srtlaTarget,
            srtlaOptions: state.srtlaOptions ?? {},
            autostart: !!state.autostart,
        },
        interfaces,
        // Encoder-only devices do no bonding and have no modems to manage
        selected: role !== "encoder" ? resolveSelection(interfaces) : [],
        modems: role !== "encoder" ? modems : [],
        audioSources,
        uplinksFile: UPLINKS_FILE,
        srtlaControl: srtlaServices.controlState(),
        monitor: { running: isMonitorRunning(), reloadMode: RELOAD_MODE },
        // null when the encoder binary is not ceracoder; the UI hides its settings then
        ceracoder: encoderServices.ceracoderConfig(),
        // null when the switcher is not running; the card shows "idle" then
        lowBitrateSwitcher:
            (modFragments.lowBitrateSwitcher as SwitcherStatus | null) ?? null,
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
        pipelineRepositories: s.pipelineRepositories ?? [],
        language: uiLanguage(),
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

/** Labels of the fields whose value differs between `a` and `b`. */
function compare<K extends string>(
    fields: ReadonlyArray<readonly [key: K, label: string]>,
    a: Partial<Record<K, unknown>>,
    b: Partial<Record<K, unknown>>,
): string[] {
    const changed: string[] = [];
    for (const [key, label] of fields) {
        if (a[key] !== b[key]) changed.push(label);
    }
    return changed;
}

export function setupSettingsStatusMethods(context: Context): MethodMap {
    const { applyRemoteSettings } = context;
    const { encoderServices, srtlaServices } = context.services;
    /** First-run wizard: validate all fields, write the initial state and bring the role up. */
    async function setupComplete(p: Params): Promise<object> {
        if (!setupRequired)
            throw new ApiError("Setup has already been completed", 409);
        const language =
            p.language === undefined
                ? "en"
                : oneOf(p.language, "language", LANGUAGES);
        const role = oneOf(requireString(p, "role"), "role", ROLES);
        const hostname = checkHostname(requireString(p, "hostname").trim());
        const color = checkColor(requireString(p, "color"));
        const remoteUrl = checkRemoteUrl(
            optionalSettingString(p, "remoteUrl", undefined),
        );
        const remoteToken = optionalSettingString(p, "remoteToken", undefined);

        let relayTarget: SrtlaTarget | undefined;
        let srtlaOptions: SrtlaOptions | undefined;
        if (role !== "encoder") {
            relayTarget = {
                listenPort: requirePort(p, "listenPort"),
                remoteHost: requireHost(p, "srtlaRemoteHost"),
                remotePort: requirePort(p, "srtlaRemotePort"),
            };
            srtlaOptions = {
                mode: oneOf(
                    requireString(p, "srtlaMode"),
                    "srtlaMode",
                    srtlaServices.modes,
                ),
                quality: requireBoolean(p, "srtlaQuality"),
            };
        }
        let encoderConfig: EncoderConfig | undefined;
        if (role === "combined") {
            // Combined devices stream into their own srtla_send
            encoderConfig = parseEncoderConfig(
                p,
                "127.0.0.1",
                relayTarget!.listenPort,
                encoderServices,
            );
        } else if (role === "encoder") {
            const port = requirePort(p, "encoderPort");
            encoderConfig = parseEncoderConfig(
                p,
                requireHost(p, "encoderHost"),
                port,
                encoderServices,
            );
        }

        // Everything is valid: apply
        if (relayTarget)
            Object.assign(state, { srtlaTarget: relayTarget, srtlaOptions });
        if (encoderConfig)
            state.encoder = { running: false, config: encoderConfig };
        if (role === "combined") state.stream = relayTarget;
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
        await completeSetup();
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
                : oneOf(roleValue, "role", ROLES);
        const remoteUrl = checkRemoteUrl(
            optionalSettingString(p, "remoteUrl", current.remoteUrl),
        );
        if (p.remoteToken !== undefined && typeof p.remoteToken !== "string") {
            throw new ApiError("remoteToken must be a string");
        }
        const remoteToken =
            p.remoteToken === undefined
                ? current.remoteToken
                : p.remoteToken.trim() || undefined;
        const color = checkColor(
            optionalSettingString(p, "color", current.color),
        );
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
        const changed = compare(settingFields, current, next);

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

    return {
        status: () => buildStatus(context),
        "setup.get": async () => ({
            required: setupRequired,
            hostname: state.settings.hostname ?? "",
            color: state.settings.color ?? DEFAULT_COLOR,
            language: uiLanguage(),
            pipelines: await encoderServices.listPipelines(),
            audioSources: await encoderServices.listAudioSources(),
        }),
        "setup.complete": setupComplete,
        "settings.get": () => ({
            settings: settingsView(),
            restartRequired: true,
        }),
        "settings.update": updateSettings,
        "log.list": () => ({ entries: logEntries() }),
    };
}
