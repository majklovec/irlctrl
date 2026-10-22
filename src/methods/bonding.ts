import type { SrtlaState } from "../../public/types";
import { logEvent } from "../eventlog";
import { t } from "../i18n";
import {
    ApiError,
    oneOf,
    optionalStringList,
    requireBoolean,
    requireHost,
    requireModemIndex,
    requirePort,
    requireString,
} from "../params";
import type { ModemConfig } from "../routing";
import { type SrtlaOptions, type SrtlaOptionsResult, state } from "../state";
import { errorMessage } from "../util";
import {
    manualMethods,
    moduleDispatcher,
    type Method,
    type MethodContext,
    type MethodMap,
    startChecked,
} from "./shared";

export function bondingMethods(
    context: Pick<MethodContext, "services" | "routing" | "registry" | "stream">,
): MethodMap {
    const { modemServices, srtlaServices } = context.services;
    const { detectInterfaces, reconfigure, resolveSelection, setSelection } =
        context.routing;
    const moduleDispatch = moduleDispatcher(context.registry);
    const manual = manualMethods(context.stream.cancelAutostart);

    /** Reconfigure routing/uplinks and reload srtla_send if the uplinks changed. */
    async function reconfigureAndReload() {
        const result = await reconfigure();
        if (!result.ok)
            throw new ApiError(result.error ?? "reconfigure failed", 500);
        if (result.changed) await srtlaServices.reloadSrtla();
        return result;
    }

    async function applySelection(selection: ModemConfig) {
        await setSelection(selection);
        const { selected, ips, uplinksFile, changed } =
            await reconfigureAndReload();
        return { selection: state.selection, selected, ips, uplinksFile, changed };
    }

    const modemAction =
        (action: string, fn: (index: number) => Promise<boolean>): Method =>
        async (p) => {
            const index = requireModemIndex(p);
            return { modemIndex: index, action, ok: await fn(index) };
        };

    return {
        "interfaces.list": async () => ({ interfaces: await detectInterfaces() }),

        reconfigure: reconfigureAndReload,

        "modems.list": async () => {
            const modems = await modemServices.detect();
            const all = await detectInterfaces(modems);
            return {
                selection: state.selection,
                selected: resolveSelection(all),
                modems,
            };
        },

        "modems.select": async (p) => {
            const modems = optionalStringList(p, "modems");
            const ips = optionalStringList(p, "ips");
            const all = await detectInterfaces();
            const badIfaces =
                modems?.filter((m) => !all.some((i) => i.iface === m)) ?? [];
            if (badIfaces.length)
                throw new ApiError(`Unknown interfaces: ${badIfaces.join(", ")}`);
            const badIps = ips?.filter((ip) => !all.some((i) => i.ip === ip)) ?? [];
            if (badIps.length)
                throw new ApiError(`Unknown IPs: ${badIps.join(", ")}`);
            return applySelection(
                modems?.length ? { modems } : ips?.length ? { ips } : {},
            );
        },

        "modems.toggle": async (p) => {
            const name = requireString(p, "iface");
            const all = await detectInterfaces();
            if (!all.some((i) => i.iface === name))
                throw new ApiError(`Unknown interface: ${name}`, 404);
            const names = new Set(resolveSelection(all).map((i) => i.iface));
            if (!names.delete(name)) names.add(name);
            return applySelection({ modems: [...names] });
        },

        // Monitor picks up the resulting netlink events and pushes a status update
        "modems.enable": modemAction(
            "enable",
            (i) =>
                moduleDispatch("modems.enable", { index: i }) as Promise<boolean>,
        ),
        "modems.disable": modemAction(
            "disable",
            (i) =>
                moduleDispatch("modems.disable", { index: i }) as Promise<boolean>,
        ),
        "modems.reset": modemAction(
            "reset",
            (i) => moduleDispatch("modems.reset", { index: i }) as Promise<boolean>,
        ),
        "modems.connect": modemAction(
            "connect",
            (i) =>
                moduleDispatch("modems.connect", { index: i }) as Promise<boolean>,
        ),
        "modems.disconnect": modemAction(
            "disconnect",
            (i) =>
                moduleDispatch("modems.disconnect", {
                    index: i,
                }) as Promise<boolean>,
        ),

        "srtla.status": () => ({ srtla: srtlaServices.srtlaStatus() }),

        "srtla.start": manual(async (p) => {
            const listenPort = requirePort(p, "listenPort");
            const remoteHost = requireHost(p, "remoteHost");
            const remotePort = requirePort(p, "remotePort");
            try {
                return {
                    srtla: await startChecked(
                        () =>
                            moduleDispatch("srtla.start", {
                                listenPort,
                                remoteHost,
                                remotePort,
                            }) as Promise<SrtlaState>,
                    ),
                };
            } catch (e: unknown) {
                throw new ApiError(errorMessage(e), 409);
            }
        }),

        "srtla.stop": manual(async () => {
            await moduleDispatch("srtla.stop", {});
            return { srtla: srtlaServices.srtlaStatus() };
        }),

        "srtla.reload": async () => {
            await moduleDispatch("srtla.reload", {});
            return { srtla: srtlaServices.srtlaStatus() };
        },

        "srtla.stats": () => srtlaServices.latestStats(),

        "srtla.options": async (p) => {
            const opts: SrtlaOptions = {};
            if (p.mode !== undefined)
                opts.mode = oneOf(p.mode, "mode", srtlaServices.modes);
            if (p.quality !== undefined)
                opts.quality = requireBoolean(p, "quality");
            if (opts.mode === undefined && opts.quality === undefined)
                throw new ApiError("mode or quality is required");
            let result: SrtlaOptionsResult;
            try {
                result = (await moduleDispatch("srtla.options", {
                    mode: opts.mode,
                    quality: opts.quality,
                })) as SrtlaOptionsResult;
            } catch (e: unknown) {
                throw new ApiError(errorMessage(e), 502);
            }
            if (!result.applied && srtlaServices.srtlaStatus().running)
                logEvent("warn", "SRTLA", t("log.no_control_socket"));
            return result;
        },
    };
}
