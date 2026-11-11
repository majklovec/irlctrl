/**
 * moblink_relay backend tests (spec 100-moblink §10.3): interface filtering
 * (allow/ignore), runtime status serialization, config validation, per-interface
 * relay lifecycle, and per-interface failure handling (a busy port is recorded
 * in `failures` without crashing the client; the other interfaces keep running).
 *
 * The pure filtering + validation + serialization tests run without sockets.
 * The lifecycle and rollback tests bind real loopback UDP sockets (the relay's
 * vif socket) but inject a mock raw interface socket (the transparent bridge
 * would otherwise need CAP_NET_ADMIN / root to open one).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
    clearCapabilities,
    provideCapability,
} from "../../../../shared/capabilities";
import type {
    NetworkInterfaces,
    Uplinks,
} from "../../../../shared/contracts/module_capabilities";
import type { ModuleCore } from "../../../../client/backend/module_core";
import {
    makeMockIfaceRawSocket,
    buildUdpIpPacket,
    encodeDataFrame,
} from "../../../../shared/lib/udp_relay";
import * as mod from "../backend";

type Iface = { name: string; addresses: string[] };

function fakeInterfaces(ifaces: Iface[]): NetworkInterfaces {
    return {
        list: () => ifaces.map((i) => ({ ...i })),
        onChanged: () => () => {},
        ensureMonitoring: async () => {},
    };
}

const fakeUplinks: Uplinks = {
    file: () => "/tmp/uplinks.txt",
    ensure: async () => {},
    onChanged: () => () => {},
    add: async () => {},
    remove: async () => {},
    list: () => [],
};

function fakeCore(data: Record<string, unknown>, dryRun = false): ModuleCore {
    return {
        state: { data: { moblink: data } },
        saveState: async () => {},
        config: { argv: [], DRY_RUN: dryRun, LOG_FILE: "/tmp/x", ROLE: "moblink_relay" },
        notifyStateChange: () => {},
        cancelAutostart: () => {},
        logEvent: () => {},
    } as unknown as ModuleCore;
}

const cfg = mod.default!;
const LO: Iface[] = [{ name: "lo", addresses: ["127.0.0.1"] }];

beforeEach(() => {
    clearCapabilities();
    provideCapability<NetworkInterfaces>("network.interfaces", fakeInterfaces(LO));
    provideCapability<Uplinks>("network.uplinks", fakeUplinks);
    // The transparent bridge needs a raw interface socket (root) in production;
    // the lifecycle tests inject a mock so they run without CAP_NET_ADMIN.
    mod.setIfaceSocketFactory(() => makeMockIfaceRawSocket());
});

describe("effectiveAnnounceHost (advertise IP)", () => {
    test("auto-detects the local address when not overridden", () => {
        cfg.bind?.(fakeCore({}));
        expect(mod.effectiveAnnounceHost()).toBe("127.0.0.1");
    });

    test("a manual override wins over auto-detection", async () => {
        cfg.bind?.(fakeCore({}));
        await cfg.dispatch("moblink_relay.setConfig", { announceHost: "203.0.113.50" });
        expect(mod.effectiveAnnounceHost()).toBe("203.0.113.50");
    });

    test("the override round-trips through the config", async () => {
        cfg.bind?.(fakeCore({}));
        await cfg.dispatch("moblink_relay.setConfig", { announceHost: "203.0.113.50" });
        const { config } = (await cfg.dispatch("moblink_relay.getConfig", {})) as {
            config: { announceHost: string };
        };
        expect(config.announceHost).toBe("203.0.113.50");
    });
});

describe("announcePayload (tunnels advertised on the advertise IP)", () => {
    const wan: Iface[] = [
        { name: "eth0", addresses: ["192.168.1.5"] },
        { name: "eth1", addresses: ["10.0.0.2"] },
    ];

    test("a manual announceHost is advertised for every tunnel (port base+index)", async () => {
        provideCapability<NetworkInterfaces>("network.interfaces", fakeInterfaces(wan));
        cfg.bind?.(fakeCore({ announceHost: "203.0.113.50", listenPortBase: 4000 }));
        const p = mod.announcePayload();
        expect(p?.v).toBe(1);
        expect(p?.host).toBe("203.0.113.50");
        expect(p?.interfaces).toEqual([
            { name: "eth0", address: "203.0.113.50", listenPort: 4000 },
            { name: "eth1", address: "203.0.113.50", listenPort: 4001 },
        ]);
    });

    test("without an override, the auto-detected LAN address is advertised for every tunnel", () => {
        provideCapability<NetworkInterfaces>("network.interfaces", fakeInterfaces(wan));
        cfg.bind?.(fakeCore({}));
        const p = mod.announcePayload();
        expect(p?.host).toBe("192.168.1.5");
        expect(p?.interfaces).toEqual([
            { name: "eth0", address: "192.168.1.5", listenPort: 4000 },
            { name: "eth1", address: "192.168.1.5", listenPort: 4001 },
        ]);
    });
});

afterEach(async () => {
    mod.setIfaceSocketFactory(undefined);
    cfg.bind?.(fakeCore({}));
    await cfg.stop();
});

describe("eligibleInterfaces (allow/ignore filtering)", () => {
    const sample: Iface[] = [
        { name: "lo", addresses: ["127.0.0.1"] },
        { name: "eth0", addresses: ["192.168.1.5"] },
        { name: "docker0", addresses: ["172.17.0.1"] },
        { name: "veth0", addresses: ["10.0.0.2"] },
        { name: "noaddr", addresses: [] },
    ];
    const base = {
        enabled: true,
        announceHost: "",
        listenPortBase: 5000,
        runtimeStatusFile: "/tmp/moblink-status.json",
        logLevel: "info" as const,
    };

    test("default ignore drops docker/veth and interfaces without an address", () => {
        const names = mod.eligibleInterfaces(sample, {
            ...base,
            interfaceAllow: [],
            interfaceIgnore: ["docker.*", "veth.*"],
            interfaceNameOverrides: {},
        });
        expect(names).toEqual(["eth0", "lo"]);
    });

    test("an allow list restricts to matching interfaces", () => {
        const names = mod.eligibleInterfaces(sample, {
            ...base,
            interfaceAllow: ["^eth"],
            interfaceIgnore: ["docker.*", "veth.*"],
            interfaceNameOverrides: {},
        });
        expect(names).toEqual(["eth0"]);
    });

    test("allow takes precedence over ignore", () => {
        const names = mod.eligibleInterfaces(sample, {
            ...base,
            interfaceAllow: ["docker"],
            interfaceIgnore: ["docker.*"],
            interfaceNameOverrides: {},
        });
        expect(names).toEqual(["docker0"]);
    });
});

describe("config + status", () => {
    test("getConfig backfills defaults on first read", async () => {
        cfg.bind?.(fakeCore({}));
        const { config } = (await cfg.dispatch("moblink_relay.getConfig", {})) as {
            config: Record<string, unknown>;
        };
        expect(config.enabled).toBe(false);
        expect(config.listenPortBase).toBe(4000);
        expect(config.interfaceIgnore).toEqual(["docker.*", "veth.*"]);
        expect(config.destination).toBeUndefined();
    });

    test("status serializes an idle relay set", async () => {
        cfg.bind?.(fakeCore({}));
        const { moblink } = (await cfg.dispatch("moblink_relay.status", {})) as {
            moblink: { connected: boolean; relays: unknown[] };
        };
        expect(moblink.connected).toBe(false);
        expect(moblink.relays).toEqual([]);
    });

    test("setConfig validates listenPortBase range", async () => {
        cfg.bind?.(fakeCore({}));
        await expect(cfg.dispatch("moblink_relay.setConfig", { listenPortBase: 0 })).rejects.toThrow();
    });

    test("setConfig rejects an invalid logLevel", async () => {
        cfg.bind?.(fakeCore({}));
        await expect(cfg.dispatch("moblink_relay.setConfig", { logLevel: "verbose" })).rejects.toThrow();
    });

    test("setConfig rejects a non-absolute status file path", async () => {
        cfg.bind?.(fakeCore({}));
        await expect(
            cfg.dispatch("moblink_relay.setConfig", { runtimeStatusFile: "rel.json" }),
        ).rejects.toThrow();
    });

    test("configure persists settings-page fields (advertise IP, port base)", async () => {
        cfg.bind?.(fakeCore({}));
        const slice = { enabled: false };
        cfg.configure?.(
            {
                enabled: true,
                listenPortBase: 6000,
                announceHost: "203.0.113.99",
            },
            slice,
        );
        expect(slice.enabled).toBe(true);
        const { config } = (await cfg.dispatch("moblink_relay.getConfig", {})) as {
            config: {
                announceHost: string;
                listenPortBase: number;
            };
        };
        expect(config.announceHost).toBe("203.0.113.99");
        expect(config.listenPortBase).toBe(6000);
    });
});

describe("relay lifecycle (real loopback UDP)", () => {
    test("start brings up one relay, stop tears it down", async () => {
        cfg.bind?.(fakeCore({ listenPortBase: 45300 }));
        await cfg.dispatch("moblink_relay.start", {});
        const up = (
            (await cfg.dispatch("moblink_relay.status", {})) as {
                moblink: { connected: boolean; relays: { interfaceName: string }[] };
            }
        ).moblink;
        expect(up.connected).toBe(true);
        expect(up.relays.map((r) => r.interfaceName)).toEqual(["lo"]);

        await cfg.dispatch("moblink_relay.stop", {});
        const down = (
            (await cfg.dispatch("moblink_relay.status", {})) as {
                moblink: { connected: boolean };
            }
        ).moblink;
        expect(down.connected).toBe(false);
    });

    test("a failing interface is recorded, others keep running (no crash)", async () => {
        const base = 45210;
        const ifaces: Iface[] = [
            { name: "lo", addresses: ["127.0.0.1"] },
            { name: "lo2", addresses: ["127.0.0.1"] },
        ];
        provideCapability<NetworkInterfaces>("network.interfaces", fakeInterfaces(ifaces));
        // Occupy the second relay's port (base+1) so its bind fails.
        const blocker = await Bun.udpSocket({
            hostname: "127.0.0.1",
            port: base + 1,
            binaryType: "uint8array",
        });

        cfg.bind?.(fakeCore({ listenPortBase: base }, false));
        // No throw: the conflict is per-interface, never fatal to the client.
        const res = (await cfg.dispatch("moblink_relay.start", {})) as {
            moblink: {
                connected: boolean;
                relays: { interfaceName: string }[];
                failures: { interfaceName: string; reason: string }[];
            };
            failures: { interfaceName: string; reason: string }[];
        };

        // The healthy interface ran; the busy one was recorded, not thrown.
        expect(res.moblink.connected).toBe(true);
        expect(res.moblink.relays.map((r) => r.interfaceName)).toEqual(["lo"]);
        expect(res.failures.map((f) => f.interfaceName)).toEqual(["lo2"]);
        expect(res.moblink.failures[0].reason).toMatch(/bind|EADDRINUSE|use/i);
        await blocker.close();
    });
});

describe("relay installs a /32 route for the learned vif IP", () => {
    test("onVifLearned → `ip route replace <vifIp>/32 dev <iface>`", async () => {
        const base = 45410;
        const vifIp = "10.90.0.1";
        // A core whose `run` records each (cmd, args) so we can assert the route.
        const runCalls: Array<{ cmd: string; args: string[] }> = [];
        const coreWithRun = {
            ...fakeCore({ listenPortBase: base }, false),
            run: async (cmd: string, args: string[]) => {
                runCalls.push({ cmd, args });
                return "";
            },
        } as unknown as ModuleCore;

        cfg.bind?.(coreWithRun);
        await cfg.dispatch("moblink_relay.start", {});

        // An encoder data frame (carrying the vif IP in the header) to lo's relay.
        const frame = encodeDataFrame(
            buildUdpIpPacket({
                srcIp: vifIp,
                dstIp: "203.0.113.10",
                srcPort: 1000,
                dstPort: 2000,
                payload: new TextEncoder().encode("hi"),
            }),
            vifIp,
        );
        const sock = (await Bun.udpSocket({
            binaryType: "uint8array",
        } as unknown as Parameters<typeof Bun.udpSocket>[0])) as any;
        sock.send(frame, base, "127.0.0.1");

        const deadline = Date.now() + 2000;
        while (
            Date.now() < deadline &&
            !runCalls.some((c) => c.cmd === "ip" && c.args[0] === "route")
        )
            await Bun.sleep(10);

        const routeCall = runCalls.find((c) => c.cmd === "ip" && c.args[0] === "route");
        expect(routeCall).toBeDefined();
        expect(routeCall?.args).toEqual(["route", "replace", `${vifIp}/32`, "dev", "lo"]);

        sock.close();
        await cfg.stop();
    });
});
