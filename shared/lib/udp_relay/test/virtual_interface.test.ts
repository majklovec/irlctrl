import { describe, expect, test } from "bun:test";
import {
    createVirtualInterface,
    makeMockTunDevice,
} from "../src/virtual_interface";
import { buildUdpIpPacket, parseUdpPacket } from "../src/ip";
import { encodeDataFrame } from "../src/protocol";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
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

/**
 * A faithful transparent-bridge relay stub: it receives a 0x01 frame (8-byte
 * header + a full IP packet), and — standing in for the far end — replies with
 * the same IP datagram with the addresses/ports swapped (src<->dst), framed
 * again. Keepalives are counted, not echoed. Bound to 127.0.0.1.
 */
async function makeRelayStub(port: number) {
    type Recv = { kind: "data"; packet: Uint8Array } | { kind: "keepalive" } | { kind: "other" };
    const received: Recv[] = [];
    const sock = (await Bun.udpSocket({
        hostname: "127.0.0.1",
        port,
        binaryType: "uint8array",
        socket: {
            data: (s: any, buf: Uint8Array, rport: number, raddr: string) => {
                if (buf[0] === 0x01 && buf.length >= 8) {
                    const packet = buf.slice(8);
                    received.push({ kind: "data", packet });
                    const p = parseUdpPacket(packet);
                    if (p) {
                        const reply = buildUdpIpPacket({
                            srcIp: p.dstIp,
                            dstIp: p.srcIp,
                            srcPort: p.dstPort,
                            dstPort: p.srcPort,
                            payload: p.payload,
                        });
                        s.send(encodeDataFrame(reply, p.srcIp), rport, raddr);
                    }
                } else if (buf[0] === 0x02) {
                    received.push({ kind: "keepalive" });
                } else {
                    received.push({ kind: "other" });
                }
            },
        },
    } as unknown as Parameters<typeof Bun.udpSocket>[0])) as any;
    return { sock, received };
}

const enc = new TextEncoder();

describe("virtual_interface.ts — factory validation", () => {
    const base = {
        name: "moblink0",
        localIp: "10.3.3.1",
        prefixLength: 24,
        relay: { host: "127.0.0.1", port: 58901 },
        tunDevice: makeMockTunDevice().device,
    };

    test("rejects a bad name", async () => {
        await expect(createVirtualInterface({ ...base, name: "bad name!" })).rejects.toThrow(/name/);
    });

    test("rejects a bad localIp", async () => {
        await expect(createVirtualInterface({ ...base, localIp: "nope" })).rejects.toThrow(/localIp/);
    });

    test("rejects a bad prefixLength", async () => {
        await expect(createVirtualInterface({ ...base, prefixLength: 7 })).rejects.toThrow(/prefixLength/);
    });

    test("rejects a missing relay", async () => {
        await expect(
            createVirtualInterface({ ...base, relay: { host: "", port: 0 } }),
        ).rejects.toThrow(/relay/);
    });

    test("rejects a too-small mtu", async () => {
        await expect(createVirtualInterface({ ...base, mtu: 20 })).rejects.toThrow(/mtu/);
    });

    test("rejects off-Linux without a mock device", async () => {
        const real = process.platform;
        (process as any).platform = "darwin";
        try {
            await expect(
                createVirtualInterface({
                    name: "moblink0",
                    localIp: "10.3.3.1",
                    prefixLength: 24,
                    relay: { host: "127.0.0.1", port: 58901 },
                }),
            ).rejects.toThrow(/Linux/);
        } finally {
            (process as any).platform = real;
        }
    });
});

describe("virtual_interface.ts — packet logic (mock TUN)", () => {
    test("round trip: TUN → relay → TUN (transparent, no address swap)", async () => {
        const { device, pushPacket, written } = makeMockTunDevice();
        const relay = await makeRelayStub(58901);
        const vif = await createVirtualInterface({
            name: "virt0",
            localIp: "127.0.0.1",
            prefixLength: 8,
            relay: { host: "127.0.0.1", port: 58901 },
            bindAddress: "127.0.0.1",
            tunDevice: device,
        });
        await vif.start();
        expect(vif.isRunning()).toBe(true);

        // Outbound: a whole IP packet the kernel "sent" out of the TUN.
        const outbound = buildUdpIpPacket({
            srcIp: "127.0.0.1",
            dstIp: "127.0.0.2",
            srcPort: 5555,
            dstPort: 4444,
            payload: enc.encode("ping"),
        });
        pushPacket(outbound);
        await waitFor(() => relay.received.length >= 1);

        const got = relay.received[0];
        expect(got.kind).toBe("data");
        if (got.kind !== "data") return;
        // The relay received the whole IP packet (not just a UDP payload).
        expect(parseUdpPacket(got.packet)?.payload).toEqual(enc.encode("ping"));

        // Inbound: the far end's reply (src=127.0.0.2, dst=127.0.0.1) is written
        // back into the TUN *unchanged*.
        await waitFor(() => written.length >= 1);
        const back = parseUdpPacket(written[0]);
        expect(back).not.toBeNull();
        if (!back) return;
        expect(back.srcIp).toBe("127.0.0.2");
        expect(back.dstIp).toBe("127.0.0.1");
        expect(back.srcPort).toBe(4444);
        expect(back.dstPort).toBe(5555);
        expect(new TextDecoder().decode(back.payload)).toBe("ping");

        const st = vif.stats();
        expect(st.txPackets).toBe(1);
        expect(st.rxPackets).toBe(1);
        expect(st.txDropped).toBe(0);
        expect(st.rxDropped).toBe(0);

        await vif.stop();
        relay.sock.close();
        expect(vif.isRunning()).toBe(false);
    });

    test("short / non-IPv4 packets are dropped (txDropped)", async () => {
        const { device, pushPacket, written } = makeMockTunDevice();
        const vif = await createVirtualInterface({
            name: "virt1",
            localIp: "127.0.0.1",
            prefixLength: 8,
            relay: { host: "127.0.0.1", port: 58902 },
            bindAddress: "127.0.0.1",
            tunDevice: device,
        });
        await vif.start();
        pushPacket(new Uint8Array(12)); // < 20-byte IPv4 header
        await sleep(50);
        expect(vif.stats().txDropped).toBe(1);
        expect(written.length).toBe(0);
        await vif.stop();
    });

    test("oversized inbound frame is dropped (rxDropped)", async () => {
        const { device, written } = makeMockTunDevice();
        const vif = await createVirtualInterface({
            name: "virt2",
            localIp: "127.0.0.1",
            prefixLength: 8,
            relay: { host: "127.0.0.1", port: 58903 },
            bindAddress: "127.0.0.1",
            mtu: 60, // inbound decode cap
            tunDevice: device,
        });
        await vif.start();
        const stub = (await Bun.udpSocket({
            hostname: "127.0.0.1",
            port: 58903,
            binaryType: "uint8array",
        } as unknown as Parameters<typeof Bun.udpSocket>[0])) as any;
        const vifPort = vif.socketAddress?.port;
        expect(vifPort).toBeTypeOf("number");
        // A data frame carrying a 100-byte "packet" — exceeds the 60-byte cap.
        stub.send(encodeDataFrame(new Uint8Array(100), "127.0.0.1"), vifPort!, "127.0.0.1");
        await waitFor(() => vif.stats().rxDropped >= 1);
        expect(written.length).toBe(0);
        await vif.stop();
        stub.close();
    });

    test("a data frame is delivered to the TUN with no prior outbound", async () => {
        const { device, written } = makeMockTunDevice();
        const vif = await createVirtualInterface({
            name: "virt3",
            localIp: "127.0.0.1",
            prefixLength: 8,
            relay: { host: "127.0.0.1", port: 58904 },
            bindAddress: "127.0.0.1",
            tunDevice: device,
        });
        await vif.start();
        const stub = (await Bun.udpSocket({
            hostname: "127.0.0.1",
            port: 58904,
            binaryType: "uint8array",
        } as unknown as Parameters<typeof Bun.udpSocket>[0])) as any;
        const vifPort = vif.socketAddress?.port;
        expect(vifPort).toBeTypeOf("number");
        const packet = buildUdpIpPacket({
            srcIp: "127.0.0.2",
            dstIp: "127.0.0.1",
            srcPort: 1,
            dstPort: 2,
            payload: enc.encode("pong"),
        });
        stub.send(encodeDataFrame(packet, "127.0.0.1"), vifPort!, "127.0.0.1");
        await waitFor(() => written.length >= 1);
        expect(vif.stats().rxPackets).toBe(1);
        expect(vif.stats().rxDropped).toBe(0);
        await vif.stop();
        stub.close();
    });

    test("reply from the wrong host → rxDropped (source check)", async () => {
        const { device, written } = makeMockTunDevice();
        const vif = await createVirtualInterface({
            name: "virt4",
            localIp: "127.0.0.1",
            prefixLength: 8,
            relay: { host: "127.0.0.100", port: 58905 },
            bindAddress: "127.0.0.1",
            tunDevice: device,
        });
        await vif.start();
        const stub = (await Bun.udpSocket({
            hostname: "127.0.0.1",
            port: 58905,
            binaryType: "uint8array",
        } as unknown as Parameters<typeof Bun.udpSocket>[0])) as any;
        const vifPort = vif.socketAddress?.port;
        expect(vifPort).toBeTypeOf("number");
        stub.send(encodeDataFrame(enc.encode("reply"), "127.0.0.1"), vifPort!, "127.0.0.1");
        await waitFor(() => vif.stats().rxDropped >= 1);
        expect(written.length).toBe(0);
        expect(vif.stats().rxPackets).toBe(0);
        await vif.stop();
        stub.close();
    });

    test("keepalives are transmitted at the configured interval", async () => {
        const { device } = makeMockTunDevice();
        const relay = await makeRelayStub(58906);
        const vif = await createVirtualInterface({
            name: "virt5",
            localIp: "127.0.0.1",
            prefixLength: 8,
            relay: { host: "127.0.0.1", port: 58906 },
            bindAddress: "127.0.0.1",
            keepaliveIntervalMs: 20,
            tunDevice: device,
        });
        await vif.start();
        await waitFor(
            () => relay.received.filter((r) => r.kind === "keepalive").length >= 2,
            3000,
        );
        await vif.stop();
        relay.sock.close();
    });

    test("stop() is idempotent and clears running state", async () => {
        const { device } = makeMockTunDevice();
        const vif = await createVirtualInterface({
            name: "virt6",
            localIp: "127.0.0.1",
            prefixLength: 8,
            relay: { host: "127.0.0.1", port: 58907 },
            bindAddress: "127.0.0.1",
            tunDevice: device,
        });
        await vif.start();
        await vif.stop();
        expect(vif.isRunning()).toBe(false);
    });
});
