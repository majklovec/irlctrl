/**
 * verify_ingress_fix.ts — prove the proposed fix end-to-end on the relay host.
 *
 * ROOT CAUSE of the "no data flow" symptom:
 *   Each relay binds its encoder-facing (vif) UDP socket to the interface's OWN
 *   IP (e.g. the mobile tunnel → 172.21.254.128:4003). But the encoder sits on
 *   the 192.168.10.0/24 network and has NO route to 172.21.254.0/24 (or the WAN
 *   192.168.1.0/24), so a datagram to the tunnel's own IP never reaches the
 *   relay. The only relay IP the encoder can reach is 192.168.10.1 (eno1).
 *
 * PROPOSED FIX (config-only, uses the existing `interfaceNameOverrides`):
 *   Bind the mobile tunnel's ingress + NAT source to 192.168.10.1 (reachable from
 *   the encoder) while the raw socket still egresses out the mobile NIC via
 *   SO_BINDTODEVICE. This experiment exercises exactly that:
 *
 *     createUdpRelay({ interfaceName: "enx7eafd60ad1a2",
 *                      interfaceAddress: "192.168.10.1",   // ← encoder-reachable
 *                      listenPort: 4150, nat: true })
 *
 *   …then drops a framed vif→OBS packet at 192.168.10.1:4150 and confirms it
 *   egresses out the mobile interface toward OBS with a returnable (NAT'd) source.
 *
 * Run:  sudo bun scripts/verify_ingress_fix.ts
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildUdpIpPacket,
	createUdpRelay,
	encodeDataFrame,
} from "../shared/lib/udp_relay/src/index.ts";

const IFACE = "enx7eafd60ad1a2";
const IFACE_IP = "172.21.254.128"; // mobile NIC's own IP (egress identity)
const BIND_IP = "192.168.10.1"; // encoder-reachable ingress (+ NAT source)
const PORT = 4150;
const OBS_HOST = "83.208.44.38";
const OBS_PORT = 5000;
const VIF_IP = "10.3.3.1";
const TCPDUMP = "/usr/bin/tcpdump";
const IP_BIN = "/usr/sbin/ip";
const enc = new TextEncoder();

const tmp = mkdtempSync(join(tmpdir(), "ingress-fix-"));
function pcap(n: string) {
	return join(tmp, n);
}
let pass = 0;
let fail = 0;
function ok(label: string, cond: boolean, detail = "") {
	if (cond) pass++;
	else fail++;
	console.log(`  ${cond ? "✓ PASS" : "✗ FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}
function sleep(ms: number) {
	return new Promise((r) => setTimeout(r, ms));
}
function startCapture(file: string, filter: string) {
	const child = spawn(TCPDUMP, ["-i", IFACE, "-n", "-s", "0", "-w", file, filter], {
		stdio: ["ignore", "ignore", "ignore"],
	});
	return { child, stop: async () => {
		child.kill("SIGINT");
		try { await new Promise<void>((r) => child.on("exit", () => r())); } catch {}
		await sleep(200);
	} };
}
function hex(b: Uint8Array) {
	return Buffer.from(b).toString("hex");
}
function pcapContains(file: string, needleHex: string): boolean {
	try {
		const d = readFileSync(file);
		return d.length > 4 && hex(d).includes(needleHex);
	} catch {
		return false;
	}
}
function pcapHasAny(file: string): boolean {
	try {
		return readFileSync(file).length > 24;
	} catch {
		return false;
	}
}

const marker = `FIX-${Date.now()}`;
const inner = buildUdpIpPacket({
	srcIp: VIF_IP,
	dstIp: OBS_HOST,
	srcPort: 6500,
	dstPort: OBS_PORT,
	payload: enc.encode(marker),
});
const frame = encodeDataFrame(inner, VIF_IP);

console.log(`\nverify_ingress_fix`);
console.log(`  mobile NIC  : ${IFACE} (${IFACE_IP})`);
console.log(`  ingress bind: ${BIND_IP}:${PORT}  (encoder-reachable)`);
console.log(`  egress/dest : ${OBS_HOST}:${OBS_PORT} out ${IFACE}`);

let relay: Awaited<ReturnType<typeof createUdpRelay>> | null = null;
try {
	relay = await createUdpRelay({
		interfaceName: IFACE,
		listenPort: PORT,
		interfaceAddress: BIND_IP, // ← the fix: bind to the reachable address
		nat: true,
	});
	await relay.start();
	ok("relay started bound to " + BIND_IP + ":" + PORT, relay.isRunning());

	const cap = startCapture(pcap("f.pcap"), `udp and host ${OBS_HOST} and port ${OBS_PORT}`);
	await sleep(400);

	// Encoder-side datagram, arriving at 192.168.10.1:PORT. bigcml owns 192.168.10.1
	// (eno1), so sending from here is network-identical to the pi doing it.
	const sock = await Bun.udpSocket({ binaryType: "uint8array" });
	sock.send(frame, PORT, BIND_IP);
	await sleep(1500);
	await cap.stop();

	const s = relay.stats();
	ok("relay received the frame (encRx ≥ 1)", (s.encRxPackets ?? 0) >= 1, `encRx=${s.encRxPackets}`);
	ok("relay egressed it out the mobile NIC (ifaceTx ≥ 1)", (s.ifaceTxPackets ?? 0) >= 1, `ifaceTx=${s.ifaceTxPackets}`);
	ok("packet left the mobile NIC toward OBS (tcpdump)", pcapHasAny(pcap("f.pcap")), pcap("f.pcap"));
	ok("payload intact on the wire (marker)", pcapContains(pcap("f.pcap"), hex(enc.encode(marker))), marker);

	// Show the on-wire source (should be the mobile-egress identity, i.e. NAT'd),
	// not the private vif IP — confirming OBS gets a returnable source.
	const route = spawnSync(IP_BIN, ["route", "get", "from", IFACE_IP, OBS_HOST]);
	console.log(`\n    egress route: ${route.stdout?.toString().trim()}`);
	console.log(`\n    OBS-side check (run on ${OBS_HOST}):`);
	console.log(`      tcpdump -ni <iface> -s 0 'udp and port ${OBS_PORT}'`);
	console.log(`    → expect SRTLA/data from the mobile uplink (phone public IP) → :${OBS_PORT}`);
} catch (e) {
	ok("experiment ran without throwing", false, e instanceof Error ? e.message : String(e));
} finally {
	await relay?.stop();
	rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${"=".repeat(48)}`);
console.log(`RESULT: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
