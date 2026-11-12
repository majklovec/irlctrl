import { describe, expect, test } from "bun:test";
import {
    createUdpRelay,
    decideIfacePacket,
    decideEncoderFrame,
    resolveInterfaceAddress,
} from "../src/relay";
import { parseUdpPacket } from "../src/ip";
import { decodeFrame, encodeDataFrame, encodeKeepaliveFrame } from "../src/protocol";
import { buildUdpIpPacket } from "../src/ip";
import { makeMockIfaceRawSocket } from "../src/net_linux";

const enc = new TextEncoder();
const VIF_IP = "10.0.0.2";
const REC_IP = "203.0.113.10";
const msgStr = "hello-moblink";

describe("relay.ts — decideEncoderFrame", () => {
    test("valid data frame → forward with packet + vifIp", () => {
        const pkt = buildUdpIpPacket({
            srcIp: VIF_IP,
            dstIp: REC_IP,
            srcPort: 1000,
            dstPort: 2000,
            payload: enc.encode("payload"),
        });
        const d = decideEncoderFrame(encodeDataFrame(pkt, VIF_IP));
        expect(d.action).toBe("forward");
        if (d.action === "forward") {
            expect(d.vifIp).toBe(VIF_IP);
            expect(d.packet.length).toBe(pkt.length);
        }
    });

    test("keepalive → liveness (not forwarded)", () => {
        expect(decideEncoderFrame(encodeKeepaliveFrame(1234)).action).toBe("liveness");
    });

    test("malformed (unknown type) → drop", () => {
        expect(decideEncoderFrame(new Uint8Array([0x7f, 0, 0, 0, 1])).action).toBe("drop");
    });
});

describe("relay.ts — decideIfacePacket", () => {
    test("packet addressed to the vif → forward", () => {
        const pkt = buildUdpIpPacket({
            srcIp: REC_IP,
            dstIp: VIF_IP,
            srcPort: 2000,
            dstPort: 1000,
            payload: enc.encode("reply"),
        });
        const d = decideIfacePacket(pkt, VIF_IP);
        expect(d.action).toBe("forward");
        if (d.action === "forward") expect(d.packet.length).toBe(pkt.length);
    });

    test("packet NOT addressed to the vif → drop", () => {
        const pkt = buildUdpIpPacket({
            srcIp: REC_IP,
            dstIp: "198.51.100.7",
            srcPort: 2000,
            dstPort: 1000,
            payload: enc.encode("x"),
        });
        expect(decideIfacePacket(pkt, VIF_IP).action).toBe("drop");
    });

    test("no vif learned yet → drop", () => {
        const pkt = buildUdpIpPacket({
            srcIp: REC_IP,
            dstIp: VIF_IP,
            srcPort: 2000,
            dstPort: 1000,
            payload: enc.encode("x"),
        });
        expect(decideIfacePacket(pkt, null).action).toBe("drop");
    });

    test("non-IPv4 (keepalive) → drop", () => {
        expect(decideIfacePacket(encodeKeepaliveFrame(1), VIF_IP).action).toBe("drop");
    });
});

describe("relay.ts — factory validation", () => {
    test("rejects a bad listen port", async () => {
        await expect(
            createUdpRelay({ interfaceName: "lo", listenPort: 0, interfaceAddress: "127.0.0.1" }),
        ).rejects.toThrow(/listenPort/);
    });

    test("rejects a bad interface name", async () => {
        await expect(
            createUdpRelay({
                interfaceName: "eth0; rm -rf /",
                listenPort: 5000,
                interfaceAddress: "127.0.0.1",
            }),
        ).rejects.toThrow(/interfaceName/);
    });
});

describe("relay.ts — end-to-end bridge (mock iface socket)", () => {
    test("encoder packet → iface; vif-addressed reply returns framed", async () => {
        const listenPort = 57712;
        const iface = makeMockIfaceRawSocket();
        const relay = await createUdpRelay({
            interfaceName: "lo",
            listenPort,
            interfaceAddress: "127.0.0.1",
            ifaceSocket: iface,
        });
        await relay.start();
        expect(relay.isRunning()).toBe(true);

        // Outbound: the encoder's SRTLA packet (vif → rec), carried in a frame.
        const outPacket = buildUdpIpPacket({
            srcIp: VIF_IP,
            dstIp: REC_IP,
            srcPort: 1030,
            dstPort: 700,
            payload: enc.encode(msgStr),
        });
        const outFrame = encodeDataFrame(outPacket, VIF_IP);

        const replies: Uint8Array[] = [];
        const BunUdp: typeof Bun.udpSocket = Bun.udpSocket;
        const encSock = (await BunUdp({
            binaryType: "uint8array",
            socket: {
                data: (s: any, buf: Uint8Array) => {
                    replies.push(buf);
                    s.close();
                },
            },
        } as unknown as Parameters<typeof BunUdp>[0])) as any;
        encSock.send(outFrame, listenPort, "127.0.0.1");

        // The relay forwards the whole IP packet out the iface, routed to its dst.
        await waitFor(
            () => relay.stats().encRxPackets === 1 && iface.sent.length === 1,
        );
        expect(iface.sent[0].dstIp).toBe(REC_IP);
        expect(iface.sent[0].packet.length).toBe(outPacket.length);

        // Reverse: a reply addressed to the vif arrives on the iface.
        const replyPacket = buildUdpIpPacket({
            srcIp: REC_IP,
            dstIp: VIF_IP,
            srcPort: 700,
            dstPort: 1030,
            payload: enc.encode("pong"),
        });
        iface.push(replyPacket);

        await waitFor(() => replies.length === 1 && relay.stats().encTxPackets === 1);
        expect(replies[0][0]).toBe(0x01);
        const dec = decodeFrame(replies[0]);
        expect(dec.type).toBe("data");
        if (dec.type === "data") expect(dec.vifIp).toBe(VIF_IP);

        const st = relay.stats();
        expect(st.encRxPackets).toBe(1);
        expect(st.ifaceTxPackets).toBe(1);
        expect(st.ifaceRxPackets).toBe(1);
        expect(st.encTxPackets).toBe(1);
        expect(st.lastEncoderSeen).toBeTypeOf("number");

        await relay.stop();
        encSock.close();
        expect(relay.isRunning()).toBe(false);
    });
});

describe("relay.ts — NAT (SNAT) mode, mock iface socket", () => {
    const RELAY_IP = "127.0.0.1";

    test("outbound source → relay ip; inbound reply de-SNATed back to the vif", async () => {
        const listenPort = 57801;
        const iface = makeMockIfaceRawSocket();
        const relay = await createUdpRelay({
            interfaceName: "lo",
            listenPort,
            interfaceAddress: RELAY_IP,
            ifaceSocket: iface,
            nat: true,
        });
        await relay.start();

        const replies: Array<{ vifIp: string; inner: ReturnType<typeof parseUdpPacket> | null }> = [];
        const BunUdp: typeof Bun.udpSocket = Bun.udpSocket;
        const encSock = (await BunUdp({
            binaryType: "uint8array",
            socket: {
                data: (_s: any, buf: Uint8Array) => {
                    const d = decodeFrame(buf);
                    if (d.type === "data")
                        replies.push({ vifIp: d.vifIp, inner: parseUdpPacket(d.payload) });
                },
            },
        } as unknown as Parameters<typeof BunUdp>[0])) as any;
        encSock.send(encodeDataFrame(
            buildUdpIpPacket({
                srcIp: VIF_IP, dstIp: REC_IP, srcPort: 1030, dstPort: 700, payload: enc.encode("srt"),
            }),
            VIF_IP,
        ), listenPort, RELAY_IP);
        await waitFor(() => iface.sent.length === 1);

        // Outbound: source rewritten to the relay's interface address, ports kept.
        const outParsed = parseUdpPacket(iface.sent[0].packet)!;
        expect(outParsed.srcIp).toBe(RELAY_IP);
        expect(outParsed.dstIp).toBe(REC_IP);
        expect(outParsed.srcPort).toBe(1030);
        expect(outParsed.dstPort).toBe(700);

        // Inbound: the destination (OBS) answered the NATed source, i.e. the
        // reply is addressed to the RELAY ip. The relay de-SNATs it back to the
        // vif before handing it to the encoder.
        iface.push(buildUdpIpPacket({
            srcIp: REC_IP, dstIp: RELAY_IP, srcPort: 700, dstPort: 1030, payload: enc.encode("pong"),
        }));
        await waitFor(() => replies.length >= 1);
        expect(replies[0].vifIp).toBe(VIF_IP);
        expect(replies[0].inner!.dstIp).toBe(VIF_IP); // de-SNATed, not RELAY_IP
        expect(replies[0].inner!.srcIp).toBe(REC_IP);

        encSock.close();
        await relay.stop();
    });
});

describe("relay.ts — onVifLearned callback", () => {
    test("fires once per vif IP, not on refresh", async () => {
        const listenPort = 57901;
        const iface = makeMockIfaceRawSocket();
        const learned: string[] = [];
        const relay = await createUdpRelay({
            interfaceName: "lo",
            listenPort,
            interfaceAddress: "127.0.0.1",
            ifaceSocket: iface,
            onVifLearned: (vifIp) => learned.push(vifIp),
        });
        await relay.start();

        const frame = encodeDataFrame(
            buildUdpIpPacket({
                srcIp: VIF_IP,
                dstIp: REC_IP,
                srcPort: 1000,
                dstPort: 2000,
                payload: enc.encode("hello"),
            }),
            VIF_IP,
        );
        const BunUdp: typeof Bun.udpSocket = Bun.udpSocket;
        const encSock = (await BunUdp({
            binaryType: "uint8array",
            socket: { data: () => {} },
        } as unknown as Parameters<typeof BunUdp>[0])) as any;

        // Two identical data frames → vif learned once, refreshed (not re-fired).
        encSock.send(frame, listenPort, "127.0.0.1");
        encSock.send(frame, listenPort, "127.0.0.1");
        await waitFor(() => relay.stats().encRxPackets === 2);
        expect(learned).toEqual([VIF_IP]);

        // A different vif IP → fires again.
        const frame2 = encodeDataFrame(
            buildUdpIpPacket({
                srcIp: "10.0.0.9",
                dstIp: REC_IP,
                srcPort: 1000,
                dstPort: 2000,
                payload: enc.encode("hi2"),
            }),
            "10.0.0.9",
        );
        encSock.send(frame2, listenPort, "127.0.0.1");
        await waitFor(() => relay.stats().encRxPackets === 3);
        expect(learned).toEqual([VIF_IP, "10.0.0.9"]);

        await relay.stop();
        encSock.close();
    });
});

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

describe("relay.ts — resolveInterfaceAddress", () => {
    test("an IP override is returned as-is", () => {
        expect(resolveInterfaceAddress("eth0", "192.168.1.20")).toBe("192.168.1.20");
    });

    test("a non-IPv4 override is rejected", () => {
        expect(() => resolveInterfaceAddress("eth0", "not-an-ip")).toThrow(/IPv4/);
    });

    test("loopback resolves to 127.0.0.1", () => {
        expect(resolveInterfaceAddress("lo")).toBe("127.0.0.1");
    });
});
