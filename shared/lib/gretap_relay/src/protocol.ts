/* The legacy udp_relay wire framing, carried over for API and tooling
 * compatibility. GRETAP itself carries native Ethernet (no framing): the
 * kernel GRE header is the whole overhead. `maxPayload` now sizes against the
 * GRETAP overhead (~38 B) instead of the old 28-B TUN+UDP accounting.
 */
import { bytesToIp, ipToBytes } from "./ip";
import type { DecodedFrame } from "./frame_types";

export const DATA_FRAME_TYPE = 0x01;
export const KEEPALIVE_FRAME_TYPE = 0x02;
/** Length of a data frame's fixed header (type + flags + reserved[2] + vifIp[4]). */
export const DATA_HEADER_LEN = 8;
/** Length of a keepalive frame (type + 8-byte timestamp). */
export const KEEPALIVE_FRAME_LEN = 9;
/** GRETAP overhead: GRE(4) + IPv4(20) + Ethernet(14), used for MTU sizing. */
export const GRETAP_OVERHEAD = 38;

/** Max data payload for a given MTU (GRETAP overhead). */
export function maxPayload(mtu: number): number {
    return mtu - GRETAP_OVERHEAD;
}

/**
 * Encode a full IPv4 packet as a data frame, tagged with the virtual-interface
 * IPv4 address it belongs to. (Legacy framing — kept for the dev scripts.)
 */
export function encodeDataFrame(ipPacket: Uint8Array, vifIp: string): Uint8Array {
    const out = new Uint8Array(DATA_HEADER_LEN + ipPacket.length);
    out[0] = DATA_FRAME_TYPE;
    // out[1..3] (flags + reserved) stay 0.
    out.set(ipToBytes(vifIp), 4);
    out.set(ipPacket, DATA_HEADER_LEN);
    return out;
}

/** Encode the wall-clock timestamp (ms since epoch) as a keepalive frame. */
export function encodeKeepaliveFrame(timestampMs: number): Uint8Array {
    const out = new Uint8Array(KEEPALIVE_FRAME_LEN);
    out[0] = KEEPALIVE_FRAME_TYPE;
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
