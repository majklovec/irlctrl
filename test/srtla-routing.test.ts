import { describe, expect, test } from "bun:test";
import type { ModuleCore } from "../backend/client/module-core";
import { bindRouting, defaultRouteDetails } from "../modules/srtla/routing";
import { defaultRouteRowIndex } from "../modules/srtla/route-view";

describe("SRTLA default-route details", () => {
    test("reports the source address selected for the default route", async () => {
        bindRouting(
            {
                run: async () =>
                    "1.1.1.1 via 192.168.32.1 dev eth0 src 192.168.32.4",
            } as unknown as ModuleCore,
            { detect: async () => [], modemIface: async () => null },
        );

        expect(await defaultRouteDetails()).toEqual({
            iface: "eth0",
            ip: "192.168.32.4",
        });
    });

    test("returns null when the default route lookup has no usable interface", async () => {
        bindRouting(
            { run: async () => "" } as unknown as ModuleCore,
            { detect: async () => [], modemIface: async () => null },
        );

        expect(await defaultRouteDetails()).toBeNull();
    });

    test("marks only the address selected on a multi-address default interface", () => {
        const interfaces = [
            { iface: "eth0.10", ip: "10.0.10.55" },
            { iface: "eth0", ip: "192.168.32.4" },
            { iface: "eth0", ip: "192.168.111.55" },
        ];

        const marked = defaultRouteRowIndex(
            interfaces,
            "eth0",
            "192.168.32.4",
        );

        expect(marked).toBe(1);
        expect(interfaces.filter((_, index) => index === marked)).toEqual([
            { iface: "eth0", ip: "192.168.32.4" },
        ]);
    });
});
