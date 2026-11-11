import { describe, expect, test } from "bun:test";
import {
    buildUdpIpPacket,
    bytesToIp,
    internetChecksum,
    ipToBytes,
    parseUdpPacket,
    udpChecksum,
} from "../src/ip";
import { encodeDataFrame, encodeKeepaliveFrame, decodeFrame } from "../src/protocol";

const enc = new TextEncoder();

describe("ip.ts — IP/UDP address helpers", () => {
    test("ipToBytes round-trips a literal", () => {
        expect(ipToBytes("10.3.3.1")).toEqual([10, 3, 3, 1]);
        expect(bytesToIp([10, 3, 3, 1])).toBe("10.3.3.1");
    });

    test("ipToBytes rejects non-IPv4", () => {
        expect(() => ipToBytes("10.3.3")).toThrow();
        expect(() => ipToBytes("256.0.0.1")).toThrow();
        expect(() => ipToBytes("1.2.3.4.5")).toThrow();
    });
});

describe("ip.ts — internet checksum", () => {
    test("one's-complement sum against an independently computed value", () => {
        const buf = new Uint8Array([
            0x12, 0x34, 0x56, 0x78, 0x90, 0xab, 0xcd, 0xef, 0x01, 0x23, 0x45,
            0x67, 0x79, 0x89, 0xab, 0xcd, 0xfe, 0x01, 0x23, 0x45,
        ]);
        expect(internetChecksum(buf)).toBe(0xab8f);
    });

    test("a buffer whose words sum to 0x10000 folds and complements to 0xfffe", () => {
        // 0x1234 + 0xedcc = 0x10000 -> fold 0x1 -> ~ -> 0xfffe
        const buf = new Uint8Array([0x12, 0x34, 0xed, 0xcc]);
        expect(internetChecksum(buf)).toBe(0xfffe);
    });
});

describe("ip.ts — buildUdpIpPacket (byte-exact)", () => {
    // Reference packet produced independently (RFC 1071 / RFC 768 checksums):
    //   src 10.3.3.1:50001 -> dst 203.0.113.10:5000, payload "MOBLINK-TEST-PAYLOAD"
    const REF_HEX =
        "4500003000000000401131af0a030301cb00710ac3511388001c17e04d4f424c" +
        "494e4b2d544553542d5041594c4f4144";

    test("matches a hard-coded reference packet exactly", () => {
        const pkt = buildUdpIpPacket({
            srcIp: "10.3.3.1",
            dstIp: "203.0.113.10",
            srcPort: 50001,
            dstPort: 5000,
            payload: enc.encode("MOBLINK-TEST-PAYLOAD"),
        });
        const hex = [...pkt].map((b) => b.toString(16).padStart(2, "0")).join("");
        expect(hex).toBe(REF_HEX);
    });

    test("total length and UDP length are consistent", () => {
        const payload = enc.encode("hello world");
        const pkt = buildUdpIpPacket({
            srcIp: "1.2.3.4",
            dstIp: "5.6.7.8",
            srcPort: 1,
            dstPort: 2,
            payload,
        });
        expect(pkt.length).toBe(20 + 8 + payload.length);
        expect((pkt[2] << 8) | pkt[3]).toBe(20 + 8 + payload.length); // IP total
        expect((pkt[24] << 8) | pkt[25]).toBe(8 + payload.length); // UDP length
        expect(pkt[9]).toBe(17); // protocol UDP
        expect(pkt[0] >> 4).toBe(4); // version
        expect(pkt[0] & 0x0f).toBe(5); // IHL
    });

    test("UDP checksum validates to zero over pseudo-header", () => {
        const pkt = buildUdpIpPacket({
            srcIp: "10.3.3.1",
            dstIp: "203.0.113.10",
            srcPort: 50001,
            dstPort: 5000,
            payload: enc.encode("MOBLINK-TEST-PAYLOAD"),
        });
        // Pseudo-header: srcIp(4) + dstIp(4) + 0(1) + protocol(1) + udpLen(2).
        const pseudo = new Uint8Array(12);
        pseudo.set(pkt.subarray(12, 16), 0);
        pseudo.set(pkt.subarray(16, 20), 4);
        pseudo[8] = 0;
        pseudo[9] = 17;
        pseudo.set(pkt.subarray(24, 26), 10);
        // The full checksum (pseudo + UDP header + payload) folds to 0.
        expect(internetChecksum(udpConcat(pseudo, pkt.subarray(20)))).toBe(0);
    });
});

function udpConcat(a: Uint8Array, b: Uint8Array): Uint8Array {
    const out = new Uint8Array(a.length + b.length);
    out.set(a);
    out.set(b, a.length);
    return out;
}

describe("ip.ts — parseUdpPacket", () => {
    test("parse the reference packet and rebuild it identically", () => {
        const bytes = hexToBytes(
            "4500003000000000401131af0a030301cb00710ac3511388001c17e04d4f424c" +
                "494e4b2d544553542d5041594c4f4144",
        );
        const parsed = parseUdpPacket(bytes)!;
        expect(parsed).not.toBeNull();
        expect(parsed.srcIp).toBe("10.3.3.1");
        expect(parsed.dstIp).toBe("203.0.113.10");
        expect(parsed.srcPort).toBe(50001);
        expect(parsed.dstPort).toBe(5000);
        expect(new TextDecoder().decode(parsed.payload)).toBe(
            "MOBLINK-TEST-PAYLOAD",
        );
        expect(parsed.ihl).toBe(20);
        expect(parsed.protocol).toBe(17);

        const rebuilt = buildUdpIpPacket({
            srcIp: parsed.srcIp,
            dstIp: parsed.dstIp,
            srcPort: parsed.srcPort,
            dstPort: parsed.dstPort,
            payload: parsed.payload,
        });
        expect(equals(rebuilt, bytes)).toBe(true);
    });

    test("rejects non-IPv4 (version 6)", () => {
        const bytes = hexToBytes(
            "60000030000000004011000000000000000000000000c0a80001",
        );
        expect(parseUdpPacket(bytes)).toBeNull();
    });

    test("rejects non-UDP protocol (TCP)", () => {
        const bytes = hexToBytes(
            "4500003000000000400600000a030301cb00710ac3511388001c0000",
        );
        expect(parseUdpPacket(bytes)).toBeNull();
    });

    test("rejects a truncated buffer", () => {
        expect(parseUdpPacket(new Uint8Array(10))).toBeNull();
    });
});

function hexToBytes(hex: string): Uint8Array {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++)
        out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out;
}
function equals(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

describe("protocol.ts — data frame round-trip", () => {
    test("encode/decode round-trips a payload + vifIp", () => {
        const payload = enc.encode("hello relay");
        const frame = encodeDataFrame(payload, "10.0.0.2");
        expect(frame[0]).toBe(0x01);
        expect(frame[1]).toBe(0);
        // vifIp occupies bytes 4..8
        expect([frame[4], frame[5], frame[6], frame[7]]).toEqual([10, 0, 0, 2]);
        const dec = decodeFrame(frame)!;
        expect(dec.type).toBe("data");
        if (dec.type === "data") {
            expect(dec.vifIp).toBe("10.0.0.2");
            expect(new TextDecoder().decode(dec.payload)).toBe("hello relay");
        }
    });

    test("decode rejects a truncated data header", () => {
        const r = decodeFrame(new Uint8Array([0x01, 0x00]));
        expect(r.type).toBe("malformed");
    });

    test("decode rejects an oversized payload when a limit is set", () => {
        const frame = encodeDataFrame(new Uint8Array(100), "10.0.0.2");
        expect(decodeFrame(frame, 50).type).toBe("malformed");
        expect(decodeFrame(frame, 200).type).toBe("data");
    });

    test("decode rejects an unknown type (not thrown)", () => {
        expect(decodeFrame(new Uint8Array([0x7f, 0, 0, 0, 1])).type).toBe(
            "malformed",
        );
    });

    test("empty buffer is malformed", () => {
        expect(decodeFrame(new Uint8Array(0)).type).toBe("malformed");
    });
});

describe("protocol.ts — keepalive frame round-trip", () => {
    test("encodes a big-endian 8-byte timestamp and decodes it back", () => {
        const ts = 1_731_234_567_890;
        const frame = encodeKeepaliveFrame(ts);
        expect(frame[0]).toBe(0x02);
        expect(frame.length).toBe(9);
        const dec = decodeFrame(frame)!;
        expect(dec.type).toBe("keepalive");
        if (dec.type === "keepalive") expect(dec.timestampMs).toBe(ts);
    });

    test("rejects a truncated keepalive", () => {
        expect(decodeFrame(new Uint8Array([0x02, 1, 2, 3])).type).toBe(
            "malformed",
        );
    });
});

// Silence unused-import for encodeKeepaliveFrame when tree-shaken.
void encodeKeepaliveFrame;
