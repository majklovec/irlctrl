import { ROLE } from "../config";
import {
    ApiError,
    oneOf,
    optionalStringList,
    requireString,
} from "../params";
import {
    ALL_MODULES,
    defaultModules,
    OBS_MODULE,
    saveState,
    state,
} from "../state";
import { moduleDispatcher, type MethodContext, type MethodMap } from "./shared";

export function moduleObsMethods(
    context: Pick<MethodContext, "services" | "registry" | "moduleCore">,
): MethodMap {
    const { obsServices } = context.services;
    const { configureModule, safeModules } = context.moduleCore;
    const moduleDispatch = moduleDispatcher(context.registry);
    const { restartRegisteredModule } = context.registry;
    return {
        "modules.list": () => ({ modules: safeModules() }),
        "modules.enable": (p) => {
            const id = oneOf(requireString(p, "id"), "id", ALL_MODULES);
            const modules = (state.settings.modules ??= defaultModules(ROLE));
            modules[id].enabled = true;
            saveState();
            // relay has no running state to re-apply; real modules go through the registry
            void restartRegisteredModule(id);
            return { ok: true, modules: safeModules() };
        },
        "modules.disable": (p) => {
            const id = oneOf(requireString(p, "id"), "id", ALL_MODULES);
            const modules = (state.settings.modules ??= defaultModules(ROLE));
            modules[id].enabled = false;
            saveState();
            // relay has no running state to re-apply; real modules go through the registry
            void restartRegisteredModule(id);
            return { ok: true, modules: safeModules() };
        },
        "modules.configure": (p) => {
            const id = oneOf(requireString(p, "id"), "id", ALL_MODULES);
            const config =
                p.config && typeof p.config === "object" && !Array.isArray(p.config)
                    ? (p.config as Record<string, unknown>)
                    : {};
            state.settings.modules ??= defaultModules(ROLE);
            if (id === OBS_MODULE) {
                // The obs module applies its slice, then re-applies
                obsServices.configure(config);
                saveState();
                void restartRegisteredModule(id);
            } else {
                configureModule(id, config);
                saveState();
            }
            return { ok: true, modules: safeModules() };
        },

        "obs.request": (p) => {
            const requestType = requireString(p, "requestType");
            const requestId =
                typeof p.requestId === "string" && p.requestId
                    ? p.requestId
                    : crypto.randomUUID();
            const requestData =
                p.requestData &&
                typeof p.requestData === "object" &&
                !Array.isArray(p.requestData)
                    ? (p.requestData as Record<string, unknown>)
                    : {};
            // op7 passthrough: the obs-websocket v5 response `d`, statuses unmapped
            return moduleDispatch("obs.request", {
                requestType,
                requestId,
                requestData,
            });
        },
        "obs.requestBatch": (p) => {
            const requests = p.requests;
            if (!Array.isArray(requests) || !requests.length)
                throw new ApiError("requests must be a non-empty array");
            for (const r of requests) {
                if (
                    !r ||
                    typeof r !== "object" ||
                    typeof (r as Record<string, unknown>).requestType !== "string"
                ) {
                    throw new ApiError("Each request needs a string requestType");
                }
            }
            const requestId =
                typeof p.requestId === "string" && p.requestId
                    ? p.requestId
                    : crypto.randomUUID();
            // op9 passthrough: the obs-websocket v5 batch response `d`
            return moduleDispatch("obs.requestBatch", {
                requestId,
                requests: requests.map((r) => {
                    const it = r as Record<string, unknown>;
                    return {
                        requestType: it.requestType as string,
                        requestId:
                            typeof it.requestId === "string" && it.requestId
                                ? it.requestId
                                : crypto.randomUUID(),
                        ...(it.requestData
                            ? {
                                  requestData: it.requestData as Record<
                                      string,
                                      unknown
                                  >,
                              }
                            : {}),
                    };
                }),
                ...(p.haltOnFailure !== undefined
                    ? { haltOnFailure: !!p.haltOnFailure }
                    : {}),
                ...(p.executionType !== undefined
                    ? { executionType: p.executionType as 0 | 1 | 2 }
                    : {}),
            });
        },
        "obs.setEventSubscriptions": (p) => {
            const names = optionalStringList(p, "eventSubscriptions") ?? [];
            const intents = obsServices.subscriptionMask(names);
            return moduleDispatch("obs.setEventSubscriptions", {
                eventSubscriptions: intents,
            });
        },

        "lowBitrateSwitcher.save": (p) => {
            return moduleDispatch("lowBitrateSwitcher.save", p);
        },
    };
}
