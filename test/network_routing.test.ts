import { afterAll, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModuleCore } from "../client/backend/module_core";
import {
    bindRouting,
    defaultRouteDetails,
    isSelfGeneratedEvent,
    setRtTablesFileForTest,
} from "../client/modules/network/routing";
import { defaultRouteRowIndex } from "../client/modules/network/route_view";

// The tests below bind stub bags into the module singleton; hand the real
// process bag back so later test files see the device as discovery left it.
const rtTablesFixture = join(tmpdir(), `irtctrl_rt_tables.${process.pid}`);
afterAll(() => {
    rmSync(rtTablesFixture, { force: true });
    setRtTablesFileForTest(null);
});
afterAll(async () => {
    const { bindModules } = await import("../client/backend/modules");
    bindModules();
});

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

describe("self-generated route event filtering", () => {
        test("matches managed tables by numeric ID or by rt_tables name", async () => {
            // belabox images name table 100 in /etc/iproute2/rt_tables ("100 usb0"),
            // and `ip monitor` then prints "table usb0" — both must be recognised.
            writeFileSync(
                rtTablesFixture,
                ["# reserved kernel routing tables", "255\tlocal", "254\tmain", "100\tusb0"].join("\n"),
            );
            setRtTablesFileForTest(rtTablesFixture);

            expect(
                await isSelfGeneratedEvent(
                    "default via 10.0.1.138 dev eth0 table 100",
                ),
            ).toBe(true);
            expect(
                await isSelfGeneratedEvent(
                    "default via 10.0.1.138 dev eth0 table usb0",
                ),
            ).toBe(true);

            // Main-table and foreign-table events stay relevant (failover etc.).
            expect(
                await isSelfGeneratedEvent("default via 10.0.1.138 dev eth0"),
            ).toBe(false);
            expect(
                await isSelfGeneratedEvent(
                    "default via 10.0.1.138 dev eth0 table local",
                ),
            ).toBe(false);
            setRtTablesFileForTest(null);
        });
});
