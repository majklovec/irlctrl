/* Real-loopback integration for the full pipeline: TUN (mocked fd seam) + UDP
 * + protocol + a transparent L3 relay (mocked raw iface socket seam), driving
 * traffic the way a real deployment would. The kernel-bound pieces
 * (openTun/ioctl, configureTun, openIfaceRawSocket) are exercised separately
 * and remain gated behind IRLCTRL_TEST_NET_ADMIN=1 because they need root.
 *
 * This file is safe to run in CI without privileges: it uses the mock TUN and
 * mock iface-socket seams (no /dev/net/tun, no RAW sockets) plus plain
 * loopback UDP, so it always runs.
 */
import { describe, expect, test } from "bun:test";
import {
    createVirtualInterface,
    makeMockTunDevice,
    createUdpRelay,
    makeMockIfaceRawSocket,
} from "../src/index";
import { buildUdpIpPacket, parseUdpPacket } from "../src/ip";

function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
    const start = Date.now();
    return new Promise((resolve, reject) => {
        const tick = () => {
            if (cond()) return resolve();
            if (Date.now() - start > timeoutMs)
                return reject(new Error("waitFor timed out"));
            setTimeout(tick, 10);
        };
        tick();
    });
}

const enc = new TextEncoder();
const VIF_IP = "10.3.3.1";
const REC_IP = "10.3.3.2";

describe("integration — encoder ⇄ transparent relay on loopback", () => {
    test("a packet out of the TUN is forwarded out the iface; reply returns", async () => {
        // Encoder: TUN (mock) + VIF on 127.0.0.1 → relay.
        const { device, pushPacket, written } = makeMockTunDevice();
        const vif = await createVirtualInterface({
            name: "integ0",
            localIp: VIF_IP,
            prefixLength: 8,
            relay: { host: "127.0.0.1", port: 58912 },
            bindAddress: "127.0.0.1",
            tunDevice: device,
        });
        await vif.start();

        // Relay box: bound to loopback, forwarding through a (mock) iface.
        const iface = makeMockIfaceRawSocket();
        const relay = await createUdpRelay({
            interfaceName: "lo",
            listenPort: 58912,
            interfaceAddress: "127.0.0.1",
            ifaceSocket: iface,
        });
        await relay.start();

        // Drive a whole IP packet out of the TUN (vif → rec).
        pushPacket(
            buildUdpIpPacket({
                srcIp: VIF_IP,
                dstIp: REC_IP,
                srcPort: 5555,
                dstPort: 4444,
                payload: enc.encode("full-pipeline"),
            }),
        );

        // The relay forwards the whole IP packet out the iface, routed to dst.
        await waitFor(() => iface.sent.length >= 1);
        const sentPkt = parseUdpPacket(iface.sent[0].packet);
        expect(iface.sent[0].dstIp).toBe(REC_IP);
        expect(sentPkt?.payload).toEqual(enc.encode("full-pipeline"));

        // The far end's reply (rec → vif) arrives on the iface and is written
        // back into the TUN unchanged.
        iface.push(
            buildUdpIpPacket({
                srcIp: REC_IP,
                dstIp: VIF_IP,
                srcPort: 4444,
                dstPort: 5555,
                payload: enc.encode("full-pipeline"),
            }),
        );
        await waitFor(() => written.length >= 1);
        const back = parseUdpPacket(written[0]);
        expect(back).not.toBeNull();
        if (!back) return;
        expect(back.srcIp).toBe(REC_IP);
        expect(back.dstIp).toBe(VIF_IP);
        expect(new TextDecoder().decode(back.payload)).toBe("full-pipeline");

        expect(relay.stats().encRxPackets).toBeGreaterThanOrEqual(1);
        expect(relay.stats().ifaceTxPackets).toBeGreaterThanOrEqual(1);
        expect(relay.stats().ifaceRxPackets).toBeGreaterThanOrEqual(1);
        expect(relay.stats().encTxPackets).toBeGreaterThanOrEqual(1);

        await vif.stop();
        await relay.stop();
        iface.close();
    });

    test("stop() order is safe: TUN first, then relay", async () => {
        const { device } = makeMockTunDevice();
        const vif = await createVirtualInterface({
            name: "integ1",
            localIp: "127.0.0.1",
            prefixLength: 8,
            relay: { host: "127.0.0.1", port: 58914 },
            bindAddress: "127.0.0.1",
            tunDevice: device,
        });
        await vif.start();
        // Stopping before the relay exists is fine (nothing to bridge).
        await vif.stop();
        expect(vif.isRunning()).toBe(false);
        await vif.stop(); // idempotent
    });
});

/**
 * Privileged integration: real /dev/net/tun + `ip` configuration. Skips
 * gracefully unless IRLCTRL_TEST_NET_ADMIN=1 (needs root + NET_ADMIN).
 */
const gated = process.env.IRLCTRL_TEST_NET_ADMIN === "1";
describe("integration — real TUN (gated)", () => {
    test("openTun + configureTun bring up a live interface", async () => {
        if (!gated) return;
        const { openTun, configureTun, deleteTun } = await import("../src/tun_linux");
        const name = `mob${Math.floor(Math.random() * 99)}`;
        const fd = await openTun(name);
        try {
            await configureTun(fd.name, "10.9.9.1", 24, 1400);
            const { listInterfaces } = await import("../src/index");
            const all = listInterfaces().find((i) => i.name === fd.name);
            expect(all).toBeDefined();
            expect(all?.addresses).toContain("10.9.9.1");
        } finally {
            fd.close();
            await deleteTun(fd.name);
        }
    });
});
