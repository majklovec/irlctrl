#!/usr/bin/env bun
/**
 * Persistent relay-slot runner (`@irlctrl/gretap-relay`) for the relay box.
 *
 * Note (GRETAP cutover): the data plane is now a kernel GRETAP tunnel (set
 * up on the streamer side); `createUdpRelay` is a no-op slot holder, so this
 * script keeps only the slot lifecycle/stats for the relay box.
 *
 * Bridges the encoder's virtual interface (TUN, e.g. 10.3.3.5/24) to one or
 * more physical uplink interfaces, egressing out each of them with SNAT
 * (NAT mode) so a remote SRTLA ingress can route replies back through the
 * tether / LAN:
 *
 *   rpi4 TUN (10.3.3.5) ──UDP:4010──▶ leg A: enx7eafd60ad1a2 (mobile, :4010)
 *   rpi4 TUN (10.3.3.5) ──UDP:4000──▶ leg B: eth0 (LAN, :4000)
 *
 * Every leg listens on its own interface IP:port and forwards to the same
 * destination (the SRTLA ingress). The encoder dials each leg with the
 * (interfaceAddress, listenPort) pair; `srtla_ips.txt` on the encoder lists
 * them.
 *
 * Usage (root — raw sockets + SO_BINDTODEVICE):
 *   sudo SRT_DST=83.208.44.38 SRT_PORT=5000 bun scripts/run_udp_relay.ts
 *
 * Env:
 *   SRT_DST    destination host (default 83.208.44.38)
 *   SRT_PORT   destination port (default 5000)
 *   LEGS       comma list of iface:port (default "enx7eafd60ad1a2:4010,eth0:4000")
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createUdpRelay, resolveInterfaceAddress } from "../shared/lib/gretap_relay/src/index";

const SRT_DST = process.env.SRT_DST ?? "83.208.44.38";
const SRT_PORT = Number(process.env.SRT_PORT ?? "5000");
// Each leg: iface:port. Port = the UDP port the vif (encoder TUN) dials, which
// for the SRTLA leg equals the ingress port (5000) so srtla_send's plain-IP
// uplinks work unchanged.
const LEGS = (process.env.LEGS ?? "enx7eafd60ad1a2:4010,eth0:4000")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
const VIF_IP = process.env.VIF_IP ?? "10.3.3.1";

/** Relay-leg owner duty: install the vif /32 route via this leg's NIC so the
 * relay's own reply/egress path resolves (the relay lib stays transport-only). */
function handleVifLearned(iface: string, vifIp: string) {
    try {
        execFileSync("/usr/sbin/ip", ["route", "replace", `${vifIp}/32`, "dev", iface]);
        console.log(`[relay ${iface}] route ${vifIp}/32 dev ${iface} installed`);
    } catch (e) {
        console.error(`[relay ${iface}] route install failed: ${e}`);
    }
}

const relays = [] as Awaited<ReturnType<typeof createUdpRelay>>[];

for (const spec of LEGS) {
    const [iface, portStr] = spec.split(":");
    const port = Number(portStr);
    if (!iface || !port) throw new Error(`bad LEGS entry: ${spec}`);
    const ip = resolveInterfaceAddress(iface);
    const leg = { address: ip, port };
    const relay = await createUdpRelay({
        interfaceName: iface,
        listenPort: port,
        interfaceAddress: ip,
        nat: true,
        natAddress: ip,
        onVifLearned: (vifIp) => {
            console.log(`[relay ${iface}:${port}] vif learned: ${vifIp}`);
            handleVifLearned(iface, vifIp);
        },
        onStats: (s) => {
            if (s.encRxPackets > 0 && s.encRxPackets % 500 === 0) {
                process.stderr.write(
                    `[relay ${iface}:${port}] encRx=${s.encRxPackets} encTx=${s.encTxPackets} ifaceRx=${s.ifaceRxPackets} ifaceTx=${s.ifaceTxPackets} drops=${s.drops}\n`
                );
            }
        },
    });
    await relay.start();
    relays.push(relay);
    console.log(`[relay] leg up: ${iface} (${ip}:${port}) -> ${SRT_DST}:${SRT_PORT} (nat)`);
}

setInterval(() => {
    for (const r of relays) {
        const s = r.stats();
        process.stderr.write(
            `[stats ${r.interfaceName}] encRx=${s.encRxPackets} encTx=${s.encTxPackets} ifaceRx=${s.ifaceRxPackets} ifaceTx=${s.ifaceTxPackets} drops=${s.drops}\n`
        );
    }
}, 15000);

for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, async () => {
        console.log(`[relay] ${sig}, stopping`);
        for (const r of relays) await r.stop();
        process.exit(0);
    });
}
console.log(`[relay] running ${relays.length} leg(s) -> ${SRT_DST}:${SRT_PORT}`);
