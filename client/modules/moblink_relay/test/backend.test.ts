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
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
	makeMockIfaceRawSocket,
} from "../../../../shared/lib/gretap_relay";
import * as mod from "../backend";
import {
	knownEncoderIps,
	knownEncoders,
	noteEncoder,
	startAnnouncing,
	stopAnnouncing,
	sweepEncoders,
} from "../discovery";
import { MOBLINK_ANNOUNCE_TTL_MS } from "../../../../shared/moblink_discovery";

/** Expire every registry entry (the discovery registry is module-level and
 * TTL'd — a plain `sweepEncoders()` only drops already-expired entries). */
function clearEncoders(): void {
	for (const e of knownEncoders())
		noteEncoder({ ...e, lastSeen: Date.now() - MOBLINK_ANNOUNCE_TTL_MS - 1 });
	sweepEncoders();
}

type Iface = { name: string; addresses: string[] };

/** The `onChanged` handler the last `fakeInterfaces` registered (tests fire
 * it to simulate a network event, like the live monitor does). */
let interfaceHandler: (() => void) | undefined;

function fakeInterfaces(ifaces: Iface[]): NetworkInterfaces {
	return {
		list: () => ifaces.map((i) => ({ ...i })),
		onChanged: (h: () => void) => {
			interfaceHandler = h;
			return () => {
				if (interfaceHandler === h) interfaceHandler = undefined;
			};
		},
		ensureMonitoring: async () => {},
	};
}

/** Poll a condition until it holds or the deadline passes (the change
 * handlers run as un-awaited promises, like the production monitor does). */
async function until(cond: () => boolean, ms = 3000): Promise<void> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline && !cond()) await Bun.sleep(10);
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
				? {
						// The encoder's OWN id: the streamer reports its
						// hostname — deliberately different from the
						// control server's device label, which the relay
						// must NOT use as the registry key.
						encoderId: "rpi4",
						ip: "192.0.2.20",
						wsPort: 8123,
						token: "sekret",
					}
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
		nat: false,
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

	test("announcer falls back to an unbound socket when no segment is bindable", async () => {
		const logs: string[] = [];
		const origLog = console.log;
		console.log = (...a: unknown[]) => logs.push(a.join(" "));
		try {
			// TEST-NET addresses are never local → every per-segment bind
			// fails and the announcer must fall back to one unbound
			// (default-route) socket.
			startAnnouncing(() => ({
				id: "r",
				host: "192.0.2.1",
				proto: "",
				token: "",
				relayPort: 4000,
				websocketPort: 8732,
				interfaces: [
					{ name: "a", address: "192.0.2.1", listenPort: 4000 },
					{ name: "b", address: "192.0.2.2", listenPort: 4001 },
				],
			}));
			await new Promise((r) => setTimeout(r, 300));
			stopAnnouncing();
			expect(logs.some((l) => l.includes("via [default]"))).toBe(true);
			expect(
				logs.some((l) =>
					l.startsWith("moblink_relay: advertising host=192.0.2.1"),
				),
			).toBe(true);
		} finally {
			console.log = origLog;
		}
	});

	test("a failing interface is recorded, others keep running (no crash)", async () => {
		const base = 45210;
		const ifaces: Iface[] = [
			{ name: "lo", addresses: ["127.0.0.1"] },
			// GRETAP-era failure mode: the slot binds nothing, so a
			// per-interface failure is a rejected slot option (here: an
			// invalid interface name), not a busy bind.
			{ name: "bad/name", addresses: ["127.0.0.1"] },
		];
		provideCapability<NetworkInterfaces>(
			"network.interfaces",
			fakeInterfaces(ifaces),
		);

		cfg.bind?.(fakeCore({ listenPortBase: base }, false));
		// No throw: the failure is per-interface, never fatal to the client.
		const res = (await cfg.dispatch("moblink_relay.start", {})) as {
			moblink: {
				connected: boolean;
				relays: { interfaceName: string }[];
				failures: { interfaceName: string; reason: string }[];
			};
			failures: { interfaceName: string; reason: string }[];
		};

		// The healthy interface ran; the bad one was recorded, not thrown.
		expect(res.moblink.connected).toBe(true);
		expect(res.moblink.relays.map((r) => r.interfaceName)).toEqual(["lo"]);
		expect(res.failures.map((f) => f.interfaceName)).toEqual(["bad/name"]);
		expect(res.moblink.failures[0].reason).toMatch(/interfaceName/i);
	});
});

describe("GRETAP data plane: relay slots forward no user-space traffic", () => {
	// GRETAP cutover: the per-interface relay slot is a no-op. Data flows
	// through the kernel GRETAP tunnel (set up on the streamer side), so the
	// slot never installs vif forward-routes — sending an encoder frame to
	// its announced port must not trigger a single `ip rule`/`ip route`.
	test("a data frame to the relay port installs no vif forward-route", async () => {
		const base = 45410;
		const runCalls: Array<{ cmd: string; args: string[] }> = [];
		const coreWithRun = {
			...fakeCore({ listenPortBase: base, nat: false }, false),
			run: async (cmd: string, args: string[]) => {
				runCalls.push({ cmd, args });
				return "";
			},
		} as unknown as ModuleCore;

		cfg.bind?.(coreWithRun);
		await cfg.dispatch("moblink_relay.start", {});

		// An encoder data frame (carrying the vif IP in the header) to lo's
		// slot port.
		// The slot's port mapping exists (announced over WS as the tunnel
		// identity) — there is just nothing bound to it.
		const { config } = (
			await cfg.dispatch("moblink_relay.getConfig", {})
		) as { config: { portMap: Record<string, number> } };
		expect(config.portMap.lo).toBe(base);

		// The slot performs NO user-space forwarding and installs NO vif
		// forward-route — the GRETAP tunnel is kernel-side.
		await Bun.sleep(100);
		expect(runCalls.some((c) => c.cmd === "ip" && c.args[0] === "rule")).toBe(
			false,
		);
		expect(runCalls.some((c) => c.cmd === "ip" && c.args[0] === "route")).toBe(
			false,
		);

		await cfg.stop();
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

describe("immediate interface-change push via the encoder WS (protocol.md §4)", () => {
	// Full lifecycle: `start()` subscribes to the network monitor's
	// `onChanged`; the test fires the captured handler like `ip monitor`
	// would, and expects the interface events to reach the encoder channel
	// (`pushIfaceEvents`) right away — no `hello` / reconnect in between.
	async function startModule(
		ifaces: Iface[],
		data: Record<string, unknown> = { enabled: true, listenPortBase: 45800 },
	): Promise<void> {
		provideCapability<NetworkInterfaces>(
			"network.interfaces",
			fakeInterfaces(ifaces),
		);
		const core = fakeCore(data, true); // dry-run: no UDP/mDNS listeners
		cfg.bind?.(core);
		mod.reseedSeen();
		await cfg.start({ core } as never);
	}

	test("the startup snapshot is silent; a hot-plugged interface is pushed as interface_added", async () => {
		const live: Iface[] = [{ name: "eth0", addresses: ["127.0.0.1"] }];
		await startModule(live);
		expect(interfaceHandler).toBeDefined();
		// The startup sync is the silent snapshot (the WS `hello` carries it).
		expect(mod.lastWsPushEvents()).toEqual([]);

		// Hotplug: a new interface appears while encoders are connected.
		live.push({ name: "eth1", addresses: ["127.0.0.1"] });
		interfaceHandler?.();
		await until(() =>
			mod
				.lastWsPushEvents()
				.some(
					(e) => e.type === "interface_added" && e.iface.iface_name === "eth1",
				),
		);
		const added = mod
			.lastWsPushEvents()
			.find((e) => e.iface.iface_name === "eth1");
		expect(added?.type).toBe("interface_added");
		expect(added?.iface.state).toBe("up");
		await cfg.stop?.();
	});

	test("a carrier drop (IP kept) is pushed as interface_down, its return as interface_up", async () => {
		// Fixture sysfs: the "eth1" carrier can be flipped without touching
		// the machine, exactly like a pulled cable (the address lingers).
		const dir = join(tmpdir(), `irtctrl_sysfs_relay.${process.pid}`);
		rmSync(dir, { recursive: true, force: true });
		mkdirSync(join(dir, "eth1"), { recursive: true });
		const operstate = join(dir, "eth1", "operstate");
		writeFileSync(operstate, "up\n");
		mod.setSysfsNetForTest(dir);
		try {
			const live: Iface[] = [
				{ name: "eth0", addresses: ["127.0.0.1"] },
				{ name: "eth1", addresses: ["127.0.0.1"] },
			];
			await startModule(live, { enabled: true, listenPortBase: 45810 });
			// Keepalive ping: the relay is up before the cable drops.
			expect(
				(
					(await cfg.dispatch("moblink_relay.status", {})) as {
						moblink: { connected: boolean };
					}
				).moblink.connected,
			).toBe(true);

			// Cable pulled: operstate down, the IP is still there.
			writeFileSync(operstate, "down\n");
			interfaceHandler?.();
			await until(() =>
				mod
					.lastWsPushEvents()
					.some(
						(e) => e.type === "interface_down" && e.iface.iface_name === "eth1",
					),
			);

			// Cable back: the encoder must be told the path is usable again.
			writeFileSync(operstate, "up\n");
			interfaceHandler?.();
			await until(() =>
				mod
					.lastWsPushEvents()
					.some(
						(e) => e.type === "interface_up" && e.iface.iface_name === "eth1",
					),
			);
			await cfg.stop?.();
		} finally {
			mod.setSysfsNetForTest(null);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a disabled module ignores network events (no relays, no push)", async () => {
		const live: Iface[] = [{ name: "eth0", addresses: ["127.0.0.1"] }];
		await startModule(live, { enabled: false });
		live.push({ name: "eth1", addresses: ["127.0.0.1"] });
		interfaceHandler?.();
		// Drain any in-flight handler from a previous test, then fire the
		// (gated) handler: a disabled module neither syncs nor pushes.
		const mark = mod.lastWsPushEvents();
		await until(() => mod.lastWsPushEvents() !== mark, 50);
		const settled = mod.lastWsPushEvents();
		interfaceHandler?.();
		await Bun.sleep(50);
		expect(mod.lastWsPushEvents()).toBe(settled); // no new push happened
		const status = (await cfg.dispatch("moblink_relay.status", {})) as {
			moblink: { connected: boolean };
		};
		expect(status.moblink.connected).toBe(false);
		await cfg.stop?.();
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
			!knownEncoders().some((e) => e.encoderId === "rpi4")
		)
			await Bun.sleep(10);
		// It is keyed by the encoder's OWN id (`encoderInfo.encoderId`,
		// here "rpi4") — NOT by the control server's device label
		// ("enc-1"). Keying on both would list one physical encoder
		// twice (the "moblin-encoder"/"rpi4" duplicate).
		const ids = knownEncoders().map((e) => e.encoderId);
		expect(ids).toContain("rpi4");
		expect(ids).not.toContain("enc-1");
		const via = knownEncoders().find((e) => e.encoderId === "rpi4")
			?.discoveredAt;
		expect(via?.["control-server"]).toBeTypeOf("number");
		expect(Object.keys(via ?? {})).toEqual(["control-server"]);
	});

	test("the TTL sweep drops encoders that stop announcing", () => {
		noteEncoder({
			encoderId: "enc-ghost",
			ip: "10.0.0.99",
			wsPort: 8199,
			proto: 1,
			discoveredAt: { udp: Date.now() },
			lastSeen: Date.now() - 60_000, // older than the TTL
		});
		expect(knownEncoders().some((e) => e.encoderId === "enc-ghost")).toBe(true);
		expect(sweepEncoders()).toEqual(["enc-ghost"]);
		expect(knownEncoders().some((e) => e.encoderId === "enc-ghost")).toBe(
			false,
		);
	});

	test("knownEncoderIps lists the registry IPs for the unicast announce path", () => {
		noteEncoder({
			encoderId: "enc-a",
			ip: "10.1.1.1",
			wsPort: 8199,
			proto: 1,
			discoveredAt: { udp: Date.now() },
			lastSeen: Date.now(),
		});
		noteEncoder({
			encoderId: "enc-b",
			ip: "10.2.2.2",
			wsPort: 8199,
			proto: 1,
			discoveredAt: { udp: Date.now() },
			lastSeen: Date.now(),
		});
		const ips = knownEncoderIps();
		expect(ips).toContain("10.1.1.1");
		expect(ips).toContain("10.2.2.2");
	});

	test("a live WS channel refreshes the TTL and survives the sweep (protocol.md §3 keepalive)", () => {
		noteEncoder({
			encoderId: "enc-live",
			ip: "10.0.0.8",
			wsPort: 8199,
			proto: 1,
			discoveredAt: { udp: Date.now() },
			lastSeen: Date.now() - 60_000, // older than the TTL
		});
		// The channel's onopen/onmessage refresh (as startEncoderChannel does).
		noteEncoder({
			encoderId: "enc-live",
			ip: "10.0.0.8",
			wsPort: 8199,
			proto: 1,
			discoveredAt: { udp: Date.now() },
			lastSeen: Date.now(),
		});
		expect(sweepEncoders()).toEqual([]);
		expect(knownEncoders().some((e) => e.encoderId === "enc-live")).toBe(true);
	});

	test("discoveredAt keeps a per-path last-discovery timestamp", () => {
		const base = {
			encoderId: "enc-via",
			ip: "10.0.0.7",
			wsPort: 8199,
			proto: 1,
		};
		const udpAt = Date.now() - 5_000;
		noteEncoder({ ...base, discoveredAt: { udp: udpAt }, lastSeen: Date.now() });
		// A second path (mDNS) (re)announces the same encoder — both stay.
		const mdnsAt = Date.now();
		noteEncoder({ ...base, discoveredAt: { mdns: mdnsAt }, lastSeen: Date.now() });
		let entry = knownEncoders().find((e) => e.encoderId === "enc-via");
		expect(entry?.discoveredAt).toEqual({ udp: udpAt, mdns: mdnsAt });
		// A keptalive re-injects an entry captured BEFORE the mdns path
		// appeared — merging keeps the stored mdns stamp; the fresh udp
		// stamp wins for its own path.
		const udpAt2 = Date.now();
		noteEncoder({ ...base, discoveredAt: { udp: udpAt2 }, lastSeen: Date.now() });
		entry = knownEncoders().find((e) => e.encoderId === "enc-via");
		expect(entry?.discoveredAt).toEqual({ udp: udpAt2, mdns: mdnsAt });
	});
});

describe("directly-connected interfaces are not advertised", () => {
	// An encoder that sits on one of the relay's own segments reaches it
	// directly — that interface must never reach the encoder (no gretap
	// tunnel back through the relay). Only the routed paths stay.
	const ifaces: Iface[] = [
		{ name: "eno1", addresses: ["192.168.10.1"] },
		{ name: "eno2", addresses: ["192.168.1.136"] },
		{ name: "enx9a9a55564a44", addresses: ["172.21.254.109"] },
	];

	test("an encoder on a relay segment hides that interface; routed paths stay", async () => {
		clearEncoders();
		provideCapability<NetworkInterfaces>(
			"network.interfaces",
			fakeInterfaces(ifaces),
		);
		const coreWithRun = {
			...fakeCore({ listenPortBase: 4000, portMap: {} }),
			run: async (cmd: string, args: string[]) => {
				if (cmd === "ip" && args[0] === "route" && args[1] === "get") {
					if (args[2] === "192.168.10.101")
						return "192.168.10.101 dev eno1 src 192.168.10.1 uid 0";
					if (args[2] === "10.44.0.9")
						return "10.44.0.9 via 192.168.1.1 dev eno2 src 192.168.1.136 uid 0";
				}
				return "";
			},
		} as unknown as ModuleCore;
		cfg.bind?.(coreWithRun);
		noteEncoder({
			encoderId: "enc-direct",
			ip: "192.168.10.101",
			wsPort: 8123,
			proto: 1,
			discoveredAt: { udp: Date.now() },
			lastSeen: Date.now(),
		});
		noteEncoder({
			encoderId: "enc-routed",
			ip: "10.44.0.9",
			wsPort: 8123,
			proto: 1,
			discoveredAt: { udp: Date.now() },
			lastSeen: Date.now(),
		});
		await mod.refreshDirectIfaces();
		// eno1 is on-link to the encoder (no `via`) → filtered; eno2 + the
		// modem path are routed → still advertised.
		expect(mod.relayIfaceList().map((i) => i.iface_name)).toEqual([
			"eno2",
			"enx9a9a55564a44",
		]);
		const p = mod.announcePayload();
		expect(p?.interfaces.map((i) => i.name)).toEqual([
			"eno2",
			"enx9a9a55564a44",
		]);
	});

	test("no known encoders → the previous mapping is kept", async () => {
		clearEncoders();
		provideCapability<NetworkInterfaces>(
			"network.interfaces",
			fakeInterfaces(ifaces),
		);
		const coreWithRun = {
			...fakeCore({ listenPortBase: 4000, portMap: {} }),
			run: async (cmd: string, args: string[]) =>
				cmd === "ip" && args[0] === "route" && args[1] === "get"
					? `${args[2]} dev eno1 src 192.168.10.1 uid 0`
					: "",
		} as unknown as ModuleCore;
		cfg.bind?.(coreWithRun);

		// First: classify eno1 as directly connected while an encoder is
		// known on its segment.
		noteEncoder({
			encoderId: "enc-prev",
			ip: "192.168.10.50",
			wsPort: 8123,
			proto: 1,
			discoveredAt: { udp: Date.now() },
			lastSeen: Date.now(),
		});
		await mod.refreshDirectIfaces();
		expect(mod.relayIfaceList().map((i) => i.iface_name)).toEqual([
			"eno2",
			"enx9a9a55564a44",
		]);

		// Then: the encoder TTL-expires → nothing is classified, and the
		// previous mapping must be kept (no collapse to an empty set).
		clearEncoders();
		await mod.refreshDirectIfaces();
		expect(mod.relayIfaceList().map((i) => i.iface_name)).toEqual([
			"eno2",
			"enx9a9a55564a44",
		]);
	});

	test("events for a directly-connected interface are never pushed to the encoder", async () => {
		clearEncoders();
		provideCapability<NetworkInterfaces>(
			"network.interfaces",
			fakeInterfaces(ifaces),
		);
		const coreWithRun = {
			...fakeCore({ listenPortBase: 4000, portMap: {} }),
			run: async (cmd: string, args: string[]) => {
				if (cmd === "ip" && args[0] === "route" && args[1] === "get")
					return "192.168.10.101 dev eno1 src 192.168.10.1 uid 0";
				return "";
			},
		} as unknown as ModuleCore;
		cfg.bind?.(coreWithRun);
		noteEncoder({
			encoderId: "enc-direct",
			ip: "192.168.10.101",
			wsPort: 8123,
			proto: 1,
			discoveredAt: { udp: Date.now() },
			lastSeen: Date.now(),
		});
		await mod.refreshDirectIfaces();
		mod.pushIfaceEvents([
			{
				type: "interface_added",
				iface: {
					iface_name: "eno1",
					ip: "192.168.10.1",
					udp_port: 4000,
					state: "up",
					uplink: true,
				},
			},
			{
				type: "interface_added",
				iface: {
					iface_name: "eno2",
					ip: "192.168.1.136",
					udp_port: 4001,
					state: "up",
					uplink: true,
				},
			},
		]);
		// Only the routed interface's event survives the fan-out filter.
		expect(mod.lastWsPushEvents().map((e) => e.iface.iface_name)).toEqual([
			"eno2",
		]);
	});
});
