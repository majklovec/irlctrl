/* Wire framing for the @irlctrl/udp-relay UDP datagrams.
 *
 * v2 — transparent L3 bridge. Big-endian. Two message types.
 *
 * Data frame (type 0x01):
 *   +------+-------+-----------+----------+-----------------------------+
 *   | 0x01 | flags | reserved  | vifIp    | ip_packet (variable)        |
 *   | 1B   | 1B    | 2B        | 4B       | N                          |
 *   +------+-------+-----------+----------+-----------------------------+
 * The frame carries the **full IPv4 packet** (header + payload) plus the
 * virtual-interface IPv4 address it belongs to. The relay forwards the packet
 * transparently out its bound physical interface and hands back packets
 * addressed to `vifIp`. There is no destination in the frame — the address
 * space is end-to-end between the encoder's SRTLA bond and the destination.
 * `flags`/`reserved` MUST be 0 on send, MUST be ignored on receive.
 *
 * Keepalive frame (type 0x02):
 *   +------+----------------------------+
 *   | 0x02 | timestamp_ms (8B, big-end) |
 *   +------+----------------------------+
 *
 * Malformed input (truncated header, unknown type, oversized payload) is
 * rejected as a `{ type: "malformed" }` result, never thrown.
 */

import { bytesToIp, ipToBytes } from "./ip";
import type { DecodedFrame } from "./frame_types";

export const DATA_FRAME_TYPE = 0x01;
export const KEEPALIVE_FRAME_TYPE = 0x02;
/** Length of a data frame's fixed header (type + flags + reserved[2] + vifIp[4]). */
export const DATA_HEADER_LEN = 8;
/** Length of a keepalive frame (type + 8-byte timestamp). */
export const KEEPALIVE_FRAME_LEN = 9;

/**
 * Encode a full IPv4 packet as a data frame, tagged with the virtual-interface
 * IPv4 address it belongs to.
 *
 * @param ipPacket the raw IPv4 datagram (header + payload) to forward
 * @param vifIp    the virtual-interface IPv4 address as a dotted string
 * (e.g. `10.0.0.2`)
 */
export function encodeDataFrame(ipPacket: Uint8Array, vifIp: string): Uint8Array {
    const out = new Uint8Array(DATA_HEADER_LEN + ipPacket.length);
    out[0] = DATA_FRAME_TYPE;
    // out[1..3] (flags + reserved) stay 0.
    out[4] = ipToBytes(vifIp)[0];
    out[5] = ipToBytes(vifIp)[1];
    out[6] = ipToBytes(vifIp)[2];
    out[7] = ipToBytes(vifIp)[3];
    out.set(ipPacket, DATA_HEADER_LEN);
    return out;
}

/** Encode the wall-clock timestamp (ms since epoch) as a keepalive frame. */
export function encodeKeepaliveFrame(timestampMs: number): Uint8Array {
    const out = new Uint8Array(KEEPALIVE_FRAME_LEN);
    out[0] = KEEPALIVE_FRAME_TYPE;
    // 8-byte big-endian unsigned timestamp.
    let value = BigInt(Math.max(0, Math.floor(timestampMs)));
    for (let i = 8; i >= 1; i--) {
        out[i] = Number(value & 0xffn);
        value >>= 8n;
    }
    return out;
}

/**
 * Decode a wire frame. Never throws: any structural problem (truncated header,
 * unknown type) or an oversized packet (when `maxPayload` is set) yields a
 * `{ type: "malformed" }` result.
 */
export function decodeFrame(
    buf: Uint8Array,
    maxPayload?: number,
): DecodedFrame {
    if (buf.length < 1) return { type: "malformed", reason: "empty" };
    const type = buf[0];
    if (type === DATA_FRAME_TYPE) {
        if (buf.length < DATA_HEADER_LEN)
            return { type: "malformed", reason: "truncated data header" };
        const vifIp = bytesToIp([buf[4], buf[5], buf[6], buf[7]]);
        const payload = buf.subarray(DATA_HEADER_LEN);
        if (maxPayload !== undefined && payload.length > maxPayload)
            return { type: "malformed", reason: "payload too large" };
        // Copy so the caller owns the buffer (the frame is often a scratch view).
        return { type: "data", vifIp, payload: payload.slice() };
    }
    if (type === KEEPALIVE_FRAME_TYPE) {
        if (buf.length < KEEPALIVE_FRAME_LEN)
            return { type: "malformed", reason: "truncated keepalive" };
        let value = 0n;
        for (let i = 1; i <= 8; i++) value = (value << 8n) | BigInt(buf[i]);
        return { type: "keepalive", timestampMs: Number(value) };
    }
    return { type: "malformed", reason: `unknown type 0x${type.toString(16)}` };
}
