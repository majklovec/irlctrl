/**
 * udp_bothways_relay.ts — start a MobLink UDP relay on the relay host (bigcml)
 * bound to the encoder-reachable ingress IP, egressing via the mobile NIC, and
 * keep it alive for a fixed window so the RPi4 → (relay) → server round-trip can
 * be observed. Prints relay stats at the end.
 *
 * Usage:
 *   sudo bun scripts/udp_bothways_relay.ts [iface] [bind_ip] [port] [seconds] [nat_ip]
 *
 * Optional nat_ip = the SNAT source. Without it the relay SNATs to bind_ip
 * (the old behaviour, which breaks the reply path when bind_ip is a LAN IP the
 * egress upstream can't route back). Pass the NIC's real IP to fix it.
 */
import { createUdpRelay } from "../shared/lib/gretap_relay/src/index.ts";

const IFACE = process.argv[2] ?? "enx7eafd60ad1a2";
const BIND_IP = process.argv[3] ?? "192.168.10.1";
const PORT = Number(process.argv[4] ?? 4150);
const SECONDS = Number(process.argv[5] ?? 40);
const NAT_IP = process.argv[6] ?? undefined;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

console.log(`[relay] iface=${IFACE} bind=${BIND_IP}:${PORT} nat=true natSrc=${NAT_IP ?? BIND_IP} window=${SECONDS}s`);
const relay = await createUdpRelay({
	interfaceName: IFACE,
	listenPort: PORT,
	interfaceAddress: BIND_IP,
	natAddress: NAT_IP,
	nat: true,
});
await relay.start();
console.log(`[relay] running (vif ip + port bound). Waiting ${SECONDS}s for traffic...`);
const t0 = Date.now();
while (Date.now() - t0 < SECONDS * 1000) {
	await sleep(5000);
	const s = relay.stats();
	console.log(
		`[relay] t=${Math.round((Date.now() - t0) / 1000)}s encRx=${s.encRxPackets} ifaceTx=${s.ifaceTxPackets} ifaceRx=${s.ifaceRxPackets} encTx=${s.encTxPackets} drops=${s.drops}`,
	);
}
const s = relay.stats();
console.log(`[relay] FINAL encRx=${s.encRxPackets} ifaceTx=${s.ifaceTxPackets} ifaceRx=${s.ifaceRxPackets} encTx=${s.encTxPackets} drops=${s.drops}`);
console.log(`[relay] bothways: ${s.encTxPackets >= 1 && s.ifaceRxPackets >= 1 ? "REPLY_RETURNED (encTx>=1)" : "no reply yet"}`);
await relay.stop();
process.exit(0);
