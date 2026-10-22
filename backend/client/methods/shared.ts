import { ROLE } from "../config";
import { ApiError, type Params } from "../../../shared/params";
import { state } from "../state";
import { errorMessage } from "../../../shared/util";
import type { Role } from "../../../shared/validate";

export type Method = (params: Params) => Promise<object> | object;
export type MethodMap = Record<string, Method>;

export interface MethodContext {
    services: typeof import("../services");
    routing: typeof import("../routing");
    moduleCore: Pick<
        typeof import("../module-core"),
        "configureModule" | "safeModules"
    >;
    registry: Pick<
        typeof import("../../../shared/registry"),
        "callModule" | "moduleStatuses" | "restartRegisteredModule"
    >;
    stream: Pick<
        typeof import("../stream"),
        "cancelAutostart" | "setAutostart" | "startCombined" | "stopCombined"
    >;
    applyRemoteSettings: typeof import("../remote").applyRemoteSettings;
}

export const moduleDispatcher =
    (registry: MethodContext["registry"]) =>
    (method: string, params: Params): Promise<unknown> =>
        registry.callModule(method, params);

/**
 * Saved settings take effect in the UI immediately; subprocess wiring follows
 * the process role on the next service restart.
 */
export const effectiveRole = (): Role => state.settings.role ?? ROLE;

/** Wrap a state-changing call that takes over from autostart. */
export const manualMethods =
    (cancelAutostart: () => void) =>
    (fn: Method): Method =>
    (p) => {
        cancelAutostart();
        return fn(p);
    };

/** Map a start failure to a status code: conflicts 409, bad pipeline / audio 400, else 500. */
export async function startChecked<T>(start: () => Promise<T>): Promise<T> {
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
