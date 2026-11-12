import { beforeEach, describe, expect, test } from "bun:test";
import type { ModuleCore } from "../../../../client/backend/module_core";
import {
	clearCapabilities,
	provideCapability,
} from "../../../../shared/capabilities";
import type {
	MoblinkRegistry,
	UplinkEntry,
	Uplinks,
} from "../../../../shared/contracts/module_capabilities";
import type {
	MoblinkDiscoveredRelay,
	MoblinkSharedEndpoint,
} from "../../../../shared/moblink_discovery";
import * as mod from "../backend";
import {
	knownRelays,
	noteMdnsRelay,
	noteRelay,
	sweepStaleRelays,
} from "../discovery";
import type { MoblinkStreamerView } from "../types";

/** A fake uplinks capability that records add/remove and a live list. */
function fakeUplinks() {
	const added: UplinkEntry[] = [];
	const removed: string[] = [];
	let failAdd = false;
	return {
		added,
		removed,
		setFailAdd: (b: boolean) => {
			failAdd = b;
		},
		file: () => "/tmp/uplinks.txt",
		ensure: async () => {},
		onChanged: () => () => {},
		add: async (e: UplinkEntry) => {
			if (failAdd) throw new Error("uplink add rejected");
			const i = added.findIndex((x) => x.id === e.id);
			if (i >= 0) added[i] = e;
			else added.push(e);
		},
		remove: async (id: string) => {
			removed.push(id);
			const i = added.findIndex((x) => x.id === id);
			if (i >= 0) added.splice(i, 1);
		},
		list: () => [...added],
	};
}

/** A fake MobLink relays registry (surfaced on the network card). */
function fakeMoblinkRegistry() {
	const relays = new Map<string, CapRelay>();
	return {
		relays,
		upsertRelay: (r: CapRelay) => {
			relays.set(r.host, r);
		},
		dropRelay: (host: string) => {
			relays.delete(host);
		},
		listRelays: () => [...relays.values()],
	};
}
type CapRelay = Parameters<MoblinkRegistry["upsertRelay"]>[0];

/** `section` is the content of `state.data.moblinkStreamer`. */
function fakeCore(section: Record<string, unknown> | null = null): ModuleCore {
	return {
		state: { data: section ? { moblinkStreamer: section } : {} },
		saveState: async () => {},
		config: { argv: [], DRY_RUN: true, LOG_FILE: "/tmp/x", ROLE: "encoder" },
		notifyStateChange: () => {},
		cancelAutostart: () => {},
		logEvent: () => {},
	} as unknown as ModuleCore;
}

const up = () => mod.default as NonNullable<typeof mod.default>;

/** Build a discovered relay (as a relay would announce it / control server). */
function relay(
	host: string,
	ifaces: Array<[name: string, address: string, port: number]>,
): MoblinkDiscoveredRelay {
	const interfaces: MoblinkSharedEndpoint[] = ifaces.map(
		([name, address, listenPort]) => ({
			name,
			address,
			listenPort,
		}),
	);
	return { host, hostname: host, interfaces, lastSeen: Date.now() };
}

/** Seed a relay as if its announce arrived, and let the async reconcile settle. */
async function announce(r: MoblinkDiscoveredRelay): Promise<void> {
	noteRelay(r);
	await Bun.sleep(10);
}

beforeEach(() => {
	clearCapabilities();
});

/** Bind a fresh core + fake uplinks + registry, flush leftover state and start
 * the module the way the device process does (it runs always on encoders). */
async function setup(data: Record<string, unknown> = {}) {
	const core = fakeCore(data);
	const uplinks = fakeUplinks();
	const moblink = fakeMoblinkRegistry();
	provideCapability<Uplinks>("network.uplinks", uplinks);
	provideCapability<MoblinkRegistry>("network.moblink", moblink);
	up().bind?.(core);
	await up().stop(); // idempotent: clears TUNs/uplinks + the discovery registry
	await up().start({ config: {}, emit: () => {}, log: () => {}, core });
	return { core, uplinks, moblink };
}

const view = async (): Promise<MoblinkStreamerView> =>
	(await up().dispatch("moblink_streamer.status", {})) as MoblinkStreamerView;

describe("moblink_streamer", () => {
	test("starts one TUN per announced shared interface and registers the uplink", async () => {
		const { uplinks } = await setup();
		await announce(relay("203.0.113.10", [["eth0", "203.0.113.10", 4000]]));
		expect(uplinks.added).toEqual([
			{
				id: "moblink:relay0_eth0",
				source: "10.90.0.1",
				label: "Moblink (relay0_eth0)",
			},
		]);
		const v = await view();
		expect(v.runtime.running).toBe(true);
		expect(v.runtime.tunnels[0]).toMatchObject({
			interfaceName: "relay0_eth0",
			interfaceAddress: "10.90.0.1",
			relayHost: "203.0.113.10",
			relayPort: 4000,
			uplinkRegistered: true,
		});
		// The learned relay is mirrored to the network card registry.
		await up().stop();
		expect(uplinks.removed).toContain("moblink:relay0_eth0");
		expect(uplinks.list()).toEqual([]);
	});

	test("multiple shared interfaces → one TUN each, IPs derived from the ordinals", async () => {
		const { uplinks } = await setup();
		await announce(
			relay("203.0.113.10", [
				["eth0", "203.0.113.10", 4000],
				["eth1", "203.0.113.10", 4001],
			]),
		);
		const v = await view();
		expect(v.runtime.tunnels.map((t) => t.interfaceAddress)).toEqual([
			"10.90.0.1",
			"10.90.1.1",
		]);
		expect(v.runtime.tunnels.map((t) => t.relayPort)).toEqual([4000, 4001]);
		expect(
			uplinks
				.list()
				.map((e) => e.id)
				.sort(),
		).toEqual(["moblink:relay0_eth0", "moblink:relay0_eth1"]);
		await up().stop();
	});

	test("no discovered relays → nothing running and no uplinks", async () => {
		const { uplinks } = await setup();
		expect(uplinks.added).toEqual([]);
		const v = await view();
		expect(v.runtime.running).toBe(false);
		expect(v.runtime.tunnels).toEqual([]);
	});

	test("a relay announced while running re-reconciles and adds a TUN", async () => {
		const { uplinks } = await setup();
		await announce(relay("203.0.113.10", [["eth0", "203.0.113.10", 4000]]));
		expect(uplinks.list().map((e) => e.id)).toEqual(["moblink:relay0_eth0"]);

		await announce(relay("198.51.100.7", [["eth0", "198.51.100.7", 4000]]));
		const v = await view();
		expect(
			uplinks
				.list()
				.map((e) => e.id)
				.sort(),
		).toEqual(["moblink:relay0_eth0", "moblink:relay1_eth0"]);
		expect(v.runtime.tunnels.some((t) => t.relayHost === "198.51.100.7")).toBe(
			true,
		);
		await up().stop();
	});

	test("a failed uplink add leaves nothing running for that tunnel", async () => {
		const { uplinks } = await setup();
		uplinks.setFailAdd(true);
		await announce(relay("203.0.113.10", [["eth0", "203.0.113.10", 4000]]));
		const v = await view();
		expect(v.runtime.running).toBe(false);
		expect(v.runtime.tunnels).toEqual([]);
		expect(uplinks.list()).toEqual([]);
		await up().stop();
		expect(uplinks.list()).toEqual([]);
	});

	test("teardown removes the uplinks and leaves nothing registered", async () => {
		const { uplinks } = await setup();
		await announce(relay("203.0.113.10", [["eth0", "203.0.113.10", 4000]]));
		expect(uplinks.list().map((e) => e.id)).toEqual(["moblink:relay0_eth0"]);
		await up().stop();
		expect(uplinks.list()).toEqual([]);
		expect(uplinks.removed).toContain("moblink:relay0_eth0");
	});

	test("the learned relays are reported in the view's discoveredRelays", async () => {
		const { moblink } = await setup();
		await announce(relay("203.0.113.10", [["eth0", "203.0.113.10", 4000]]));
		const v = await view();
		expect(v.discoveredRelays.map((r) => r.host)).toEqual(["203.0.113.10"]);
		expect(moblink.relays.get("203.0.113.10")?.interfaces).toHaveLength(1);
		await up().stop();
	});

	test("an interface_down in the ANNOUNCE is not tunnelled (protocol.md §5)", async () => {
		const { uplinks } = await setup();
		await announce({
			host: "203.0.113.20",
			hostname: "203.0.113.20",
			interfaces: [
				{
					name: "eth0",
					address: "203.0.113.20",
					listenPort: 4000,
					state: "down",
				},
			],
			lastSeen: Date.now(),
		});
		expect(uplinks.list()).toEqual([]);
		const v = await view();
		expect(v.runtime.tunnels).toEqual([]);
		// The endpoint is still tracked (the port mapping must survive).
		expect(v.discoveredRelays[0]?.interfaces[0]?.state).toBe("down");
		await up().stop();
	});
});

describe("relay WS control channel (protocol.md §3–§5)", () => {
	const iface = (
		name: string,
		ip: string,
		port: number,
		state: "up" | "down" = "up",
	) => ({
		iface_name: name,
		ip,
		udp_port: port,
		state,
		uplink: true as const,
	});

	test("a hello snapshot registers the relay and starts its TUNs", async () => {
		const { uplinks } = await setup();
		mod.onRelayWsMessage("wan-relay", {
			type: "hello",
			relay_id: "wan-relay",
			proto: 1,
			interfaces: [iface("eth0", "198.51.100.9", 4000)],
		});
		await Bun.sleep(10);
		const v = await view();
		expect(v.discoveredRelays.map((r) => r.host)).toContain("wan-relay");
		expect(uplinks.list().map((e) => e.id)).toEqual(["moblink:relay0_eth0"]);
		// The TUN dials the INTERFACE address the relay advertised, not its id.
		expect(v.runtime.tunnels[0]).toMatchObject({
			interfaceName: "relay0_eth0",
			relayHost: "198.51.100.9",
			relayPort: 4000,
		});
		await up().stop();
	});

	test("a hello with a peer IP keys the registry by IP (no UDP announce yet)", async () => {
		await setup();
		mod.onRelayWsMessage(
			"bigcml",
			{
				type: "hello",
				relay_id: "bigcml",
				proto: 1,
				interfaces: [iface("eno2", "192.0.2.10", 4000)],
			},
			"192.0.2.10",
		);
		await Bun.sleep(10);
		const v = await view();
		// The registry key is the routable peer IP, not the hostname (dgram
		// performs no hostname resolution — an ENOTFOUND dial target).
		expect(v.discoveredRelays.map((r) => r.host)).toEqual(["192.0.2.10"]);
		expect(v.discoveredRelays[0].hostname).toBe("bigcml");
		await up().stop();
	});

	test("a live WS marks the relay wsConnected on the network-card registry", async () => {
		const { moblink } = await setup();
		mod.onRelayWsMessage(
			"bigcml",
			{
				type: "hello",
				relay_id: "bigcml",
				proto: 1,
				interfaces: [iface("eno2", "192.0.2.10", 4000)],
			},
			"192.0.2.10",
		);
		await Bun.sleep(10);
		// The relay lands in the network-card registry flagged as WS-connected
		// (protocol.md §3) — the card renders the green dot from this flag.
		const entry = moblink.relays.get("192.0.2.10");
		expect(entry).toBeDefined();
		expect(entry?.wsConnected).toBe(true);
		await up().stop();
	});

	test("a later hello with a peer IP migrates the hostname-keyed registry entry", async () => {
		await setup();
		const hello = {
			type: "hello" as const,
			relay_id: "bigcml",
			proto: 1,
			interfaces: [iface("eno2", "192.0.2.10", 4000)],
		};
		mod.onRelayWsMessage("bigcml", hello);
		await Bun.sleep(10);
		expect((await view()).discoveredRelays.map((r) => r.host)).toEqual([
			"bigcml",
		]);
		mod.onRelayWsMessage("bigcml", hello, "192.0.2.10");
		await Bun.sleep(10);
		const v = await view();
		// One entry, re-keyed from the hostname to the peer IP.
		expect(v.discoveredRelays.map((r) => r.host)).toEqual(["192.0.2.10"]);
		expect(v.discoveredRelays[0].hostname).toBe("bigcml");
		await up().stop();
	});

	test("interface_down stops the TUN; interface_up reuses the same slot (protocol.md §1)", async () => {
		const { uplinks } = await setup();
		mod.onRelayWsMessage("wan-relay", {
			type: "hello",
			relay_id: "wan-relay",
			proto: 1,
			interfaces: [iface("eth0", "198.51.100.9", 4000)],
		});
		await Bun.sleep(10);
		const before = (await view()).runtime.tunnels[0];
		expect(before).toMatchObject({
			interfaceName: "relay0_eth0",
			interfaceAddress: "10.90.0.1",
		});

		mod.onRelayWsMessage("wan-relay", {
			type: "interface_down",
			iface: iface("eth0", "198.51.100.9", 4000, "down"),
		});
		await Bun.sleep(10);
		expect((await view()).runtime.tunnels).toEqual([]);
		expect(uplinks.list()).toEqual([]);
		// The (down) endpoint stays in the registry → the port mapping keeps.
		expect(
			(await view()).discoveredRelays.find((r) => r.host === "wan-relay")
				?.interfaces,
		).toEqual([
			expect.objectContaining({
				name: "eth0",
				listenPort: 4000,
				state: "down",
			}),
		]);

		mod.onRelayWsMessage("wan-relay", {
			type: "interface_up",
			iface: iface("eth0", "198.51.100.9", 4000),
		});
		await Bun.sleep(10);
		const after = (await view()).runtime.tunnels[0];
		expect(after).toMatchObject({
			interfaceName: "relay0_eth0",
			interfaceAddress: "10.90.0.1",
		});
		expect(after).toEqual(before);
		await up().stop();
	});

	test("interface_added opens a new TUN; interface_removed stops it (protocol.md §4.2)", async () => {
		const { uplinks } = await setup();
		mod.onRelayWsMessage("wan-relay", {
			type: "hello",
			relay_id: "wan-relay",
			proto: 1,
			interfaces: [iface("eth0", "198.51.100.9", 4000)],
		});
		await Bun.sleep(10);
		expect(uplinks.list().map((e) => e.id)).toEqual(["moblink:relay0_eth0"]);

		mod.onRelayWsMessage("wan-relay", {
			type: "interface_added",
			iface: iface("eth1", "198.51.100.9", 4001),
		});
		await Bun.sleep(10);
		expect(
			uplinks
				.list()
				.map((e) => e.id)
				.sort(),
		).toEqual(["moblink:relay0_eth0", "moblink:relay0_eth1"]);
		expect(
			(await view()).runtime.tunnels.map((t) => t.interfaceAddress),
		).toEqual(["10.90.0.1", "10.90.1.1"]);

		mod.onRelayWsMessage("wan-relay", {
			type: "interface_removed",
			iface: iface("eth1", "198.51.100.9", 4001),
		});
		await Bun.sleep(10);
		expect(uplinks.list().map((e) => e.id)).toEqual(["moblink:relay0_eth0"]);
		expect(
			(await view()).discoveredRelays
				.find((r) => r.host === "wan-relay")
				?.interfaces.map((e) => e.name),
		).toEqual(["eth0"]);
		await up().stop();
	});

	test("a hello for an UNKNOWN relay is ignored until its identity is known", async () => {
		const { uplinks } = await setup();
		// No hello → no wsRelayHosts entry → single-interface events drop.
		mod.onRelayWsMessage("ghost-relay", {
			type: "interface_up",
			iface: iface("eth0", "198.51.100.9", 4000),
		});
		await Bun.sleep(10);
		expect(uplinks.list()).toEqual([]);
		await up().stop();
	});
});

describe("TTL sweep + WS keepalive (protocol.md §3 self-sustaining channel)", () => {
	test("sweepStaleRelays drops silent relays but spares live-WS peers", async () => {
		await setup();
		const backdated = {
			host: "192.0.2.10",
			hostname: "bigcml",
			interfaces: [{ name: "eno2", address: "192.0.2.10", listenPort: 4000 }],
			lastSeen: Date.now() - 20_000, // beyond the 15 s TTL
		};
		noteRelay(backdated as MoblinkDiscoveredRelay);
		// The registry is keyed by the relay's identity (hostname), so the
		// swept key is "bigcml", not the IP.
		expect(sweepStaleRelays()).toEqual(["bigcml"]);
		// Re-seed the SAME relay, now with a live WS → protected from the sweep.
		noteRelay(backdated as MoblinkDiscoveredRelay);
		expect(sweepStaleRelays(() => new Set(["192.0.2.10"]))).toEqual([]);
		expect(knownRelays().some((r) => r.host === "192.0.2.10")).toBe(true);
		await up().stop();
	});

	test("a ping frame refreshes the registry TTL (no log spam, quiet path)", async () => {
		await setup();
		mod.onRelayWsMessage(
			"bigcml",
			{
				type: "hello",
				relay_id: "bigcml",
				proto: 1,
				interfaces: [
					{
						iface_name: "eno2",
						ip: "192.0.2.10",
						udp_port: 4000,
						state: "up",
						uplink: true,
					},
				],
			},
			"192.0.2.10",
		);
		await Bun.sleep(10);
		// Age the entry past the TTL, then let a keepalive frame refresh it.
		noteRelay({
			host: "192.0.2.10",
			hostname: "bigcml",
			interfaces: [{ name: "eno2", address: "192.0.2.10", listenPort: 4000 }],
			lastSeen: Date.now() - 20_000,
		} as MoblinkDiscoveredRelay);
		mod.onRelayWsMessage("bigcml", { type: "ping" }, "192.0.2.10");
		// Unprotected sweep: the ping refreshed lastSeen → relay survives.
		expect(sweepStaleRelays()).toEqual([]);
		expect(knownRelays().some((r) => r.host === "192.0.2.10")).toBe(true);
		await up().stop();
	});
});

describe("registry dedupe (one entry per relay)", () => {
	test("the same relay learned via UDP, mDNS and WS stays a single entry", async () => {
		await setup();
		// 1) UDP broadcast announce (identity = hostname "bigcml").
		noteRelay({
			host: "192.0.2.10",
			hostname: "bigcml",
			interfaces: [{ name: "eno2", address: "192.0.2.10", listenPort: 4000 }],
			lastSeen: Date.now(),
		} as MoblinkDiscoveredRelay);
		expect(knownRelays()).toHaveLength(1);
		// 2) mDNS for the SAME relay → merged into the existing entry, and
		// the longer endpoint set wins (mDNS may carry more endpoints).
		noteMdnsRelay("192.0.2.10", "bigcml", [
			{ name: "eno2", address: "192.0.2.10", listenPort: 4000 },
			{ name: "wg0", address: "192.0.2.11", listenPort: 4002 },
		]);
		expect(knownRelays()).toHaveLength(1);
		expect(knownRelays()[0].interfaces).toHaveLength(2);
		// 3) WS hello from the same relay → no new entry; the hello snapshot
		// replaces the interface set wholesale (protocol.md §4).
		mod.onRelayWsMessage(
			"bigcml",
			{
				type: "hello",
				relay_id: "bigcml",
				proto: 1,
				interfaces: [
					{
						iface_name: "eno2",
						ip: "192.0.2.10",
						udp_port: 4000,
						state: "up",
						uplink: true,
					},
				],
			},
			"192.0.2.10",
		);
		expect(knownRelays()).toHaveLength(1);
		expect(knownRelays()[0].host).toBe("192.0.2.10");
		expect(knownRelays()[0].hostname).toBe("bigcml");
		expect(knownRelays()[0].interfaces).toHaveLength(1);
		await up().stop();
	});

	test("a hostname-less relay stays one entry when its announce IP is stable", async () => {
		await setup();
		noteRelay({
			host: "192.0.2.20",
			interfaces: [{ name: "eno2", address: "192.0.2.20", listenPort: 4000 }],
			lastSeen: Date.now(),
		} as MoblinkDiscoveredRelay);
		noteMdnsRelay("192.0.2.20", undefined, [
			{ name: "eno2", address: "192.0.2.20", listenPort: 4000 },
		]);
		noteRelay({
			host: "192.0.2.20",
			interfaces: [{ name: "eno2", address: "192.0.2.20", listenPort: 4000 }],
			lastSeen: Date.now(),
		} as MoblinkDiscoveredRelay);
		expect(knownRelays()).toHaveLength(1);
		expect(knownRelays()[0].host).toBe("192.0.2.20");
		await up().stop();
	});
});

describe("encoderInfo (protocol.md §2 relay lookup)", () => {
	test("reports id / IP / WS port / protocol version", async () => {
		await setup();
		const info = (await up().dispatch("moblink_streamer.encoderInfo", {})) as {
			encoderId: string;
			ip: string;
			wsPort: number;
			proto: number;
		} | null;
		// `defaultSourceIp` shells out to `ip route get`; on test hosts it may
		// resolve a real LAN IP — assert the shape, not the address.
		expect(info).not.toBeNull();
		expect(info?.encoderId.length).toBeGreaterThan(0);
		expect(info?.wsPort).toBe(8190);
		expect(info?.proto).toBe(1);
		await up().stop();
	});
});
