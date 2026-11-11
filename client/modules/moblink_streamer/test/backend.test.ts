import { beforeEach, describe, expect, test } from "bun:test";
import {
	clearCapabilities,
	provideCapability,
} from "../../../../shared/capabilities";
import type {
	MoblinkRegistry,
	Uplinks,
	UplinkEntry,
} from "../../../../shared/contracts/module_capabilities";
import type { ModuleCore } from "../../../../client/backend/module_core";
import * as mod from "../backend";
import { noteRelay } from "../discovery";
import type {
	MoblinkDiscoveredRelay,
	MoblinkSharedEndpoint,
} from "../../../../shared/moblink_discovery";
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

const up = () => mod.default!;

/** Build a discovered relay (as a relay would announce it / control server). */
function relay(
	host: string,
	ifaces: Array<[name: string, address: string, port: number]>,
): MoblinkDiscoveredRelay {
	const interfaces: MoblinkSharedEndpoint[] = ifaces.map(([name, address, listenPort]) => ({
		name,
		address,
		listenPort,
	}));
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
			{ id: "moblink:relay0_eth0", source: "10.90.0.1", label: "Moblink (relay0_eth0)" },
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
		expect(uplinks.list().map((e) => e.id).sort()).toEqual([
			"moblink:relay0_eth0",
			"moblink:relay0_eth1",
		]);
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
		expect(uplinks.list().map((e) => e.id).sort()).toEqual([
			"moblink:relay0_eth0",
			"moblink:relay1_eth0",
		]);
		expect(
			v.runtime.tunnels.some((t) => t.relayHost === "198.51.100.7"),
		).toBe(true);
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
});
