import type { Iface } from "./types";

export function defaultRouteRowIndex(
    interfaces: Pick<Iface, "iface" | "ip">[],
    routeInterface: string | null | undefined,
    routeSourceIp: string | null | undefined,
): number {
    if (!routeInterface) return -1;
    return interfaces.findIndex(
        ({ iface, ip }) =>
            iface === routeInterface && (!routeSourceIp || ip === routeSourceIp),
    );
}
