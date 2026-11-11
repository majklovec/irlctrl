import { afterAll, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// The "uplinks file rewrite" block below must run before any other test that
// triggers a file write: the routing module's lastUplinksContent cache would
// then shadow the fixture file and the re-read under test would not happen.
import type { ModuleCore } from "../client/backend/module_core";
import {
    addProgrammaticUplink,
    bindRouting,
    defaultRouteDetails,
    isSelfGeneratedEvent,
    leaselessGateway,
    removeProgrammaticUplink,
    seedManagedTableCount,
    setRtTablesFileForTest,
    uplinksLines,
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

describe("uplinks file rewrite", () => {
    test("drops stale uplink ids an older build left in the file", async () => {
        const file = join(tmpdir(), "srtla_ips.txt");
        const saved = await Bun.file(file).text().catch(() => null);
        let written: string | null = null;
        try {
            writeFileSync(file, "192.168.1.136\nmoblink:relay0_eno2\n");
            bindRouting(
                {
                    config: { DRY_RUN: false },
                    writeFileAtomic: async (
                        _path: string,
                        content: string,
                    ) => {
                        written = content;
                    },
                } as unknown as ModuleCore,
                { detect: async () => [], modemIface: async () => null },
            );
            await addProgrammaticUplink(
                "moblink:relay0_eno2",
                "10.90.0.1",
            );
            expect(written).toContain("192.168.1.136");
            expect(written).toContain("10.90.0.1");
            expect(written).not.toContain("moblink:");
        } finally {
            if (saved === null) rmSync(file, { force: true });
            else writeFileSync(file, saved);
        }
    });
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

describe("uplinks file lines", () => {
    test("carries programmatic uplink sources as IPs, never their ids", async () => {
        // The file is consumed by srtla_send, which dials these as addresses.
        bindRouting(
            {
                config: { DRY_RUN: false },
                writeFileAtomic: async () => {},
            } as unknown as ModuleCore,
            { detect: async () => [], modemIface: async () => null },
        );
        await addProgrammaticUplink("moblink:relay0_eno2", "10.90.0.1");
        try {
            expect(uplinksLines(["192.168.8.153"])).toEqual([
                "192.168.8.153",
                "10.90.0.1",
            ]);
            // A source that is also a bonded IP is written once.
            expect(uplinksLines(["10.90.0.1"])).toEqual(["10.90.0.1"]);
        } finally {
            // Drop the test's uplink so later tests see a clean registry.
            await removeProgrammaticUplink("moblink:relay0_eno2");
        }
    });
});

describe("lease-less uplink gateway", () => {
    test("uses the subnet's first host for a lease-less RNDIS uplink", () => {
        expect(leaselessGateway("192.168.8.153", 24)).toBe("192.168.8.1");
    });

    test("has no via-address for a MobLink TUN (its IP is the first host)", () => {
        // TUN local IPs are 10.{90+x}.{y}.1 — the first host of their /24.
        expect(leaselessGateway("10.90.0.1", 24)).toBeNull();
        expect(leaselessGateway("10.91.3.1", 24)).toBeNull();
    });

    test("returns null for a malformed address", () => {
        expect(leaselessGateway("not-an-ip", 24)).toBeNull();
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

        test("seeds the managed table count from live ip rules after a restart", async () => {
            bindRouting(
                {
                    run: async () =>
                        [
                            "0:\tfrom all lookup local",
                            "32766:\tfrom all lookup main",
                            "32767:\tfrom all lookup default",
                            "10000:\tfrom 10.0.1.65 lookup 100",
                            "10001:\tfrom 10.214.189.184 lookup 101",
                            "10002:\tfrom 192.168.8.153 lookup 102",
                        ].join("\n"),
                } as unknown as ModuleCore,
                { detect: async () => [], modemIface: async () => null },
            );

            await seedManagedTableCount();

            // Events for tables the previous run left behind are recognised
            // right after a restart, not only after the next full re-apply.
            expect(
                await isSelfGeneratedEvent("default dev usb0 table 102"),
            ).toBe(true);
            expect(
                await isSelfGeneratedEvent("default dev usb0 table 103"),
            ).toBe(false);
        });

        test("re-reads rt_tables when the first read finds no entries", async () => {
            const rtTables = join(
                tmpdir(),
                `irtctrl_rt_tables_late.${process.pid}`,
            );
            setRtTablesFileForTest(rtTables);

            // No file yet: the name cannot be resolved — and the empty read
            // must not be cached, or the filter would stay blind forever.
            expect(
                await isSelfGeneratedEvent("default dev usb0 table usb0"),
            ).toBe(false);

            writeFileSync(rtTables, "100\tusb0\n");
            expect(
                await isSelfGeneratedEvent("default dev usb0 table usb0"),
            ).toBe(true);
            setRtTablesFileForTest(null);
            rmSync(rtTables, { force: true });
        });
});
