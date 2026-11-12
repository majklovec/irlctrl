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
import type { ModuleCore } from "../../../../client/backend/module_core";
import {
	clearCapabilities,
	provideCapability,
} from "../../../../shared/capabilities";
import type {
	NetworkInterfaces,
	Uplinks,
} from "../../../../shared/contracts/module_capabilities";
import {
	buildUdpIpPacket,
	encodeDataFrame,
	makeMockIfaceRawSocket,
} from "../../../../shared/lib/udp_relay";
import * as mod from "../backend";
import { knownEncoders, noteEncoder, sweepEncoders } from "../discovery";

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

function fakeCore(
	data: Record<string, unknown>,
	dryRun = false,
	devs: Array<{
		id: string;
		role?: string;
		online?: boolean;
		hostname?: string;
	}> = [],
): ModuleCore {
	return {
		state: { data: { moblink: data } },
		saveState: async () => {},
		config: {
			argv: [],
			DRY_RUN: dryRun,
			LOG_FILE: "/tmp/x",
			ROLE: "moblink_relay",
		},
		notifyStateChange: () => {},
		cancelAutostart: () => {},
		logEvent: () => {},
		// The control-server encoder lookup path: report which encoders the
		// (fake) control server knows and what their `encoderInfo` says.
		listDevices: async () =>
			devs.map((d) => ({
				id: d.id,
				online: d.online ?? true,
				...(d.role ? { role: d.role } : {}),
				...(d.hostname ? { hostname: d.hostname } : {}),
			})),
		requestDevice: async (_id: string, method: string): Promise<unknown> =>
			method === "moblink_streamer.encoderInfo"
				? { ip: "192.0.2.20", wsPort: 8123, token: "sekret" }
				: null,
	} as unknown as ModuleCore;
}

const cfg = mod.default as NonNullable<typeof mod.default>;
const LO: Iface[] = [{ name: "lo", addresses: ["127.0.0.1"] }];

beforeEach(() => {
	clearCapabilities();
	provideCapability<NetworkInterfaces>(
		"network.interfaces",
		fakeInterfaces(LO),
	);
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
		await cfg.dispatch("moblink_relay.setConfig", {
			announceHost: "203.0.113.50",
		});
		expect(mod.effectiveAnnounceHost()).toBe("203.0.113.50");
	});

	test("the override round-trips through the config", async () => {
		cfg.bind?.(fakeCore({}));
		await cfg.dispatch("moblink_relay.setConfig", {
			announceHost: "203.0.113.50",
		});
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
		provideCapability<NetworkInterfaces>(
			"network.interfaces",
			fakeInterfaces(wan),
		);
		cfg.bind?.(
			fakeCore({ announceHost: "203.0.113.50", listenPortBase: 4000 }),
		);
		const p = mod.announcePayload();
		expect(p?.v).toBe(1);
		expect(p?.host).toBe("203.0.113.50");
		// No sockets bound (module not started) → both paths report down;
		// the mapping is still advertised (protocol.md §1: down keeps the port).
		expect(p?.interfaces).toEqual([
			{
				name: "eth0",
				address: "203.0.113.50",
				listenPort: 4000,
				state: "down",
			},
			{
				name: "eth1",
				address: "203.0.113.50",
				listenPort: 4001,
				state: "down",
			},
		]);
	});

	test("without an override, each tunnel advertises its OWN interface IP (protocol.md §3/§5)", () => {
		provideCapability<NetworkInterfaces>(
			"network.interfaces",
			fakeInterfaces(wan),
		);
		cfg.bind?.(fakeCore({}));
		const p = mod.announcePayload();
		expect(p?.host).toBe("192.168.1.5");
		// No sockets bound (module not started) → both paths report down;
		// the mapping is still advertised (protocol.md §1: down keeps the port).
		expect(p?.interfaces).toEqual([
			{ name: "eth0", address: "192.168.1.5", listenPort: 4000, state: "down" },
			{ name: "eth1", address: "10.0.0.2", listenPort: 4001, state: "down" },
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
		portMap: {} as Record<string, number>,
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
		await expect(
			cfg.dispatch("moblink_relay.setConfig", { listenPortBase: 0 }),
		).rejects.toThrow();
	});

	test("setConfig rejects an invalid logLevel", async () => {
		cfg.bind?.(fakeCore({}));
		await expect(
			cfg.dispatch("moblink_relay.setConfig", { logLevel: "verbose" }),
		).rejects.toThrow();
	});

	test("setConfig rejects a non-absolute status file path", async () => {
		cfg.bind?.(fakeCore({}));
		await expect(
			cfg.dispatch("moblink_relay.setConfig", {
				runtimeStatusFile: "rel.json",
			}),
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
		provideCapability<NetworkInterfaces>(
			"network.interfaces",
			fakeInterfaces(ifaces),
		);
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

describe("relay installs a vif reply-route in a dedicated table", () => {
	test("onVifLearned → route + `to` rule in a dedicated table, never the main table", async () => {
		const base = 45410;
		const vifIp = "10.90.0.1";
		// `lo` is the first (only) eligible interface → dedicated table 200.
		const table = "200";
		// A core whose `run` records each (cmd, args) so we can assert the routing.
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
		interface TestSock {
			send(buf: Uint8Array, port: number, host: string): void;
			close(): void;
		}
		const sock = (await Bun.udpSocket({
			binaryType: "uint8array",
		} as unknown as Parameters<typeof Bun.udpSocket>[0])) as unknown as TestSock;
		sock.send(frame, base, "127.0.0.1");

		const deadline = Date.now() + 2000;
		while (
			Date.now() < deadline &&
			!runCalls.some(
				(c) => c.cmd === "ip" && c.args[0] === "rule" && c.args[1] === "add",
			)
		)
			await Bun.sleep(10);

		// The /32 lives in the dedicated table, addressed to the interface.
		const routeCall = runCalls.find(
			(c) => c.cmd === "ip" && c.args[0] === "route" && c.args[1] === "replace",
		);
		expect(routeCall?.args).toEqual([
			"route",
			"replace",
			`${vifIp}/32`,
			"dev",
			"lo",
			"table",
			table,
		]);
		// The reply path is a destination-scoped rule (`to <vif> lookup <table>`),
		// so forwarded traffic (source = vif IP) keeps the main-table default route.
		const ruleAdd = runCalls.find(
			(c) => c.cmd === "ip" && c.args[0] === "rule" && c.args[1] === "add",
		);
		expect(ruleAdd?.args).toEqual([
			"rule",
			"add",
			"to",
			vifIp,
			"lookup",
			table,
		]);
		// Nothing may land in the MAIN table: a main-table vif /32 makes the
		// kernel treat the vif IP as a local source and silently drop the
		// forwarded SRTLA traffic (the bug this whole fix targets).
		for (const c of runCalls) {
			if (c.cmd === "ip" && c.args[0] === "route")
				expect(c.args).toContain("table");
		}

		// Teardown removes the rule and flushes the dedicated table.
		sock.close();
		await cfg.stop();
		const ruleDel = runCalls.find(
			(c) => c.cmd === "ip" && c.args[0] === "rule" && c.args[1] === "del",
		);
		expect(ruleDel).toBeDefined();
		expect(ruleDel?.args).toContain(table);
		const flush = runCalls.find(
			(c) => c.cmd === "ip" && c.args[0] === "route" && c.args[1] === "flush",
		);
		expect(flush?.args).toEqual(["route", "flush", "table", table]);
	});
});

describe("port allocator (high-water mark, protocol.md §1)", () => {
	test("mapping wins; new interfaces take the next highest port", () => {
		cfg.bind?.(
			fakeCore({
				listenPortBase: 4000,
				portMap: { eth0: 4000, eth1: 4001 },
			}),
		);
		expect(mod.allocatePort("eth0")).toBe(4000);
		expect(mod.allocatePort("eth1")).toBe(4001);
		expect(mod.allocatePort("usb0")).toBe(4002); // high water + 1
		expect(mod.allocatePort("usb0")).toBe(4002); // stable
	});

	test("a removed interface frees its mapping without reindexing the rest", () => {
		cfg.bind?.(
			fakeCore({
				listenPortBase: 4000,
				portMap: { eth0: 4000, eth1: 4001 },
			}),
		);
		mod.freePort("eth0");
		expect(mod.allocatePort("eth1")).toBe(4001); // untouched
		// The freed slot is not the high-water mark, so a new interface
		// (protocol.md §1) takes high-water + 1 — 4002, never reindexing
		// eth1.
		expect(mod.allocatePort("new0")).toBe(4002);
	});
});

describe("syncRelays interface events (protocol.md §4)", () => {
	// Two fake uplinks, both on a loopback IP so the relays can bind without
	// real NICs (same trick as the lo/lo2 lifecycle test).
	const lan: Iface[] = [
		{ name: "eth0", addresses: ["127.0.0.1"] },
		{ name: "eth1", addresses: ["127.0.0.1"] },
	];

	test("the first bring-up is the silent snapshot (no duplicate events)", async () => {
		provideCapability<NetworkInterfaces>(
			"network.interfaces",
			fakeInterfaces(lan),
		);
		cfg.bind?.(fakeCore({ listenPortBase: 45500 }));
		mod.reseedSeen();
		const first = (await cfg.dispatch("moblink_relay.start", {})) as {
			started: string[];
			events: { type: string }[];
		};
		expect(first.started.sort()).toEqual(["eth0", "eth1"]);
		// An interface first seen THIS process goes out in the WS snapshot /
		// announce, not as `interface_added`.
		expect(first.events).toEqual([]);

		const second = (await cfg.dispatch("moblink_relay.start", {})) as {
			started: string[];
			events: { type: string }[];
		};
		expect(second.started).toEqual([]); // already running
		expect(second.events).toEqual([]); // no double fire
	});

	test("stop → start re-uses the KEPT port mappings (no reindex)", async () => {
		provideCapability<NetworkInterfaces>(
			"network.interfaces",
			fakeInterfaces(lan),
		);
		cfg.bind?.(fakeCore({ listenPortBase: 45510 }));
		mod.reseedSeen();
		await cfg.dispatch("moblink_relay.start", {});
		const ports1 = (
			(await cfg.dispatch("moblink_relay.getConfig", {})) as {
				config: { portMap: Record<string, number> };
			}
		).config.portMap;
		expect(ports1.eth0).toBe(45510);
		expect(ports1.eth1).toBe(45511);

		await cfg.dispatch("moblink_relay.stop", {});
		const resumed = (await cfg.dispatch("moblink_relay.start", {})) as {
			started: string[];
			stopped: string[];
			events: { type: string }[];
		};
		expect(resumed.started.sort()).toEqual(["eth0", "eth1"]);
		// Coming back on their KEPT ports is `interface_up`, not `added`.
		expect(resumed.events.map((e) => e.type).sort()).toEqual([
			"interface_up",
			"interface_up",
		]);
		const ports2 = (
			(await cfg.dispatch("moblink_relay.getConfig", {})) as {
				config: { portMap: Record<string, number> };
			}
		).config.portMap;
		expect(ports2).toEqual(ports1); // the mappings survived the stop
	});

	test("a removed interface fires interface_removed and frees its mapping", async () => {
		// Mutable list: the module holds the capability reference from
		// `bind()`, so the interface set is changed in place (not by
		// re-providing the capability).
		const live: Iface[] = [
			{ name: "eth0", addresses: ["127.0.0.1"] },
			{ name: "eth1", addresses: ["127.0.0.1"] },
		];
		provideCapability<NetworkInterfaces>(
			"network.interfaces",
			fakeInterfaces(live),
		);
		cfg.bind?.(fakeCore({ listenPortBase: 45700 }));
		mod.reseedSeen();
		await cfg.dispatch("moblink_relay.start", {});
		// eth1's path disappears (no address) — mark it down, keep the port.
		live.splice(
			live.findIndex((i) => i.name === "eth1"),
			0,
			{
				name: "eth1",
				addresses: [],
			},
		);
		const res = (await mod.syncRelays()) as {
			stopped: string[];
			events: { type: string; iface: { iface_name: string; state: string } }[];
		};
		const down = res.events.find(
			(e) => e.type === "interface_down" && e.iface.iface_name === "eth1",
		);
		expect(down).toBeDefined();
		expect(down?.iface.state).toBe("down");
		// The mapping survived (protocol.md §1).
		const { config } = (await cfg.dispatch("moblink_relay.getConfig", {})) as {
			config: { portMap: Record<string, number> };
		};
		expect(config.portMap.eth1).toBeDefined();
	});
});

describe("encoder discovery + WS channels (protocol.md §2–§5)", () => {
	test("the control-server path learns encoders and dials their WS server", async () => {
		const core = fakeCore({ listenPortBase: 45900 }, false, [
			{ id: "enc-1", role: "encoder", online: true, hostname: "enc-1" },
		]);
		provideCapability<NetworkInterfaces>(
			"network.interfaces",
			fakeInterfaces([{ name: "lo", addresses: ["127.0.0.1"] }]),
		);
		cfg.bind?.(core);
		mod.reseedSeen();
		mod.resetControlServerCheck(); // the 30 s poll throttle is shared state
		await cfg.dispatch("moblink_relay.start", {});
		// The (async) control-server lookup ran: the encoder is registered.
		const deadline = Date.now() + 2000;
		while (
			Date.now() < deadline &&
			!knownEncoders().some((e) => e.encoderId === "enc-1")
		)
			await Bun.sleep(10);
		expect(knownEncoders().map((e) => e.encoderId)).toContain("enc-1");
	});

	test("the TTL sweep drops encoders that stop announcing", () => {
		noteEncoder({
			encoderId: "enc-ghost",
			ip: "10.0.0.99",
			wsPort: 8199,
			proto: 1,
			lastSeen: Date.now() - 60_000, // older than the TTL
		});
		expect(knownEncoders().some((e) => e.encoderId === "enc-ghost")).toBe(true);
		expect(sweepEncoders()).toEqual(["enc-ghost"]);
		expect(knownEncoders().some((e) => e.encoderId === "enc-ghost")).toBe(
			false,
		);
	});
});
