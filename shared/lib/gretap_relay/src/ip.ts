/* IPv4 / UDP header parse & build, with correct checksums.
 *
 * Byte-exact port of the legacy `@irlctrl/udp-relay` IP helpers — the dev
 * scripts and the relay module's tests still build the old wire packets with
 * them. GRETAP itself carries no such framing (the kernel GRE header is the
 * whole overhead); this module exists so call sites keep compiling unchanged.
 *
 * `isValid` is the GRETAP-era addition: a dotted-quad format check.
 */

// --- IP address helpers ------------------------------------------------------

/** "a.b.c.d" → [a, b, c, d] (throws on a non-IPv4 literal). */
export function ipToBytes(ip: string): [number, number, number, number] {
    const parts = ip.split(".").map((p) => Number(p));
    if (
        parts.length !== 4 ||
        parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)
    )
        throw new Error(`not an IPv4 literal: ${ip}`);
    return [parts[0], parts[1], parts[2], parts[3]];
}

/** [a, b, c, d] → "a.b.c.d". */
export function bytesToIp(b: [number, number, number, number]): string {
    return `${b[0]}.${b[1]}.${b[2]}.${b[3]}`;
}

/** True when `s` is a well-formed dotted-quad IPv4 address. */
export function isValid(s: string): boolean {
    const parts = s.split(".");
    if (parts.length !== 4) return false;
    return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

// --- Checksum ----------------------------------------------------------------

/**
 * One's-complement internet checksum (RFC 1071) over `buf`. Returns the 16-bit
 * checksum to store (i.e. the one's-complement of the sum).
 */
export function internetChecksum(buf: Uint8Array): number {
    let sum = 0;
    for (let i = 0; i + 1 < buf.length; i += 2)
        sum += (buf[i] << 8) | buf[i + 1];
    if (buf.length % 2 === 1) sum += buf[buf.length - 1] << 8;
    // Fold the 32-bit sum into 16 bits, then one's-complement.
    while (sum >> 16) sum = (sum & 0xffff) + (sum >> 16);
    return (~sum) & 0xffff;
}

/**
 * UDP checksum (RFC 768) with the IPv4 pseudo-header. `pseudoHeader` must be
 * the 12-byte pseudo-header: srcIp(4) + dstIp(4) + zero(1) + protocol(1) +
 * udpLength(2 big-endian).
 */
export function udpChecksum(
    udpHeaderAndPayload: Uint8Array,
    pseudoHeader: Uint8Array,
): number {
    const combined = new Uint8Array(
        pseudoHeader.length + udpHeaderAndPayload.length,
    );
    combined.set(pseudoHeader);
    combined.set(udpHeaderAndPayload, pseudoHeader.length);
    let cksum = internetChecksum(combined);
    // A UDP checksum that computes to zero is transmitted as all ones.
    return cksum === 0 ? 0xffff : cksum;
}

// --- Parse -------------------------------------------------------------------

export interface ParsedUdpPacket {
    /** IPv4 header length in bytes (ihl * 4), >= 20. */
    ihl: number;
    protocol: number;
    srcIp: string;
    dstIp: string;
    srcPort: number;
    dstPort: number;
    /** The UDP payload (bytes after the 8-byte UDP header). */
    payload: Uint8Array;
}

/**
 * Read the destination IPv4 address from a raw IPv4 datagram (header present).
 * Returns `null` when the buffer is not a well-formed IPv4 header (shorter than
 * 20 bytes, or not version 4). No checksum validation — used to route packets
 * at the transport layer, not to deliver them.
 */
export function ipDST(buf: Uint8Array): string | null {
    if (buf.length < 20) return null;
    const version = buf[0] >> 4;
    if (version !== 4) return null;
    return bytesToIp([buf[16], buf[17], buf[18], buf[19]]);
}

/**
 * Parse an IPv4 packet that carries a UDP payload. Returns `null` when the
 * buffer is too short, is not IPv4, is not UDP (protocol != 17), or the UDP
 * header is truncated. Never throws.
 */
export function parseUdpPacket(buf: Uint8Array): ParsedUdpPacket | null {
    if (buf.length < 28) return null; // min IPv4(20) + UDP(8)
    const versionAndIhl = buf[0];
    const version = versionAndIhl >> 4;
    if (version !== 4) return null;
    const ihl = (versionAndIhl & 0x0f) * 4;
    if (ihl < 20 || buf.length < ihl + 8) return null;
    const protocol = buf[9];
    if (protocol !== 17) return null;
    const srcIp = bytesToIp([buf[12], buf[13], buf[14], buf[15]]);
    const dstIp = bytesToIp([buf[16], buf[17], buf[18], buf[19]]);
    const udp = ihl;
    const srcPort = (buf[udp] << 8) | buf[udp + 1];
    const dstPort = (buf[udp + 2] << 8) | buf[udp + 3];
    const udpLength = (buf[udp + 4] << 8) | buf[udp + 5];
    const payloadStart = udp + 8;
    const payloadEnd = udpLength >= 8 ? udp + udpLength : buf.length;
    if (payloadEnd > buf.length) return null;
    return {
        ihl,
        protocol,
        srcIp,
        dstIp,
        srcPort,
        dstPort,
        payload: buf.subarray(payloadStart, payloadEnd).slice(),
    };
}

// --- Build -------------------------------------------------------------------

export interface BuildUdpIpPacketOptions {
    srcIp: string;
    dstIp: string;
    srcPort: number;
    dstPort: number;
    payload: Uint8Array;
    /** Time-to-live (default 64). */
    ttl?: number;
}

/**
 * Construct a full IPv4/UDP packet from scratch: an IPv4 header (version 4,
 * IHL 5, TOS 0, computed total length, ID 0, flags 0, fragment 0, the given
 * TTL, protocol 17, computed header checksum) plus a UDP header (ports,
 * length = 8 + payload, computed checksum) and the payload. Returns one
 * contiguous `Uint8Array`.
 */
export function buildUdpIpPacket(o: BuildUdpIpPacketOptions): Uint8Array {
    const src = ipToBytes(o.srcIp);
    const dst = ipToBytes(o.dstIp);
    const udpLength = 8 + o.payload.length;
    const totalLength = 20 + udpLength;
    const out = new Uint8Array(totalLength);

    // IPv4 header.
    out[0] = 0x45; // version 4, IHL 5 (20 bytes)
    out[1] = 0x00; // TOS
    out[2] = (totalLength >> 8) & 0xff;
    out[3] = totalLength & 0xff;
    out[4] = 0x00; // ID high
    out[5] = 0x00; // ID low
    out[6] = 0x00; // flags / fragment
    out[7] = 0x00;
    out[8] = o.ttl ?? 64; // TTL
    out[9] = 17; // protocol: UDP
    // out[10..11] header checksum filled below.
    out[12] = src[0];
    out[13] = src[1];
    out[14] = src[2];
    out[15] = src[3];
    out[16] = dst[0];
    out[17] = dst[1];
    out[18] = dst[2];
    out[19] = dst[3];
    const ipCksum = internetChecksum(out.subarray(0, 20));
    out[10] = (ipCksum >> 8) & 0xff;
    out[11] = ipCksum & 0xff;

    // UDP header.
    out[20] = (o.srcPort >> 8) & 0xff;
    out[21] = o.srcPort & 0xff;
    out[22] = (o.dstPort >> 8) & 0xff;
    out[23] = o.dstPort & 0xff;
    out[24] = (udpLength >> 8) & 0xff;
    out[25] = udpLength & 0xff;
    // out[26..27] UDP checksum, then payload.
    out.set(o.payload, 28);

    // UDP checksum over pseudo-header + UDP header + payload.
    const pseudo = new Uint8Array([
        src[0],
        src[1],
        src[2],
        src[3],
        dst[0],
        dst[1],
        dst[2],
        dst[3],
        0x00,
        17,
        (udpLength >> 8) & 0xff,
        udpLength & 0xff,
    ]);
    const udpCksum = udpChecksum(out.subarray(20), pseudo);
    out[26] = (udpCksum >> 8) & 0xff;
    out[27] = udpCksum & 0xff;
    return out;
}

/**
 * Rewrite one IPv4 address field of a whole IPv4 packet (source at offset 12,
 * destination at offset 16) and recompute the IP header checksum. For UDP, the
 * UDP checksum is recomputed too (it covers the pseudo-header, which carries
 * both addresses). Returns a new buffer; the input is not mutated. Returns
 * `null` for a non-IPv4/truncated header (shorter than the 20-byte fixed part)
 * or a bad address literal.
 */
function natIpAddress(
    buf: Uint8Array,
    newAddr: string,
    offset: 12 | 16,
): Uint8Array | null {
    if (buf.length < 20) return null;
    if ((buf[0] >> 4) !== 4) return null;
    const ihl = (buf[0] & 0x0f) * 4;
    if (ihl < 20) return null;
    const addr = ipToBytes(newAddr);

    const out = new Uint8Array(buf);
    out[offset] = addr[0];
    out[offset + 1] = addr[1];
    out[offset + 2] = addr[2];
    out[offset + 3] = addr[3];

    // Zero the checksum fields first: the copy carries the packet's *old*
    // checksums, and the one's-complement sum must be taken over a zeroed field.
    out[10] = 0;
    out[11] = 0;
    const ipCksum = internetChecksum(out.subarray(0, ihl));
    out[10] = (ipCksum >> 8) & 0xff;
    out[11] = ipCksum & 0xff;

    if (out[9] === 17 && out.length >= ihl + 8) {
        const udpLen = (out[ihl + 4] << 8) | out[ihl + 5];
        const pseudo = new Uint8Array([
            out[12], out[13], out[14], out[15],
            out[16], out[17], out[18], out[19],
            0x00, 17,
            (udpLen >> 8) & 0xff, udpLen & 0xff,
        ]);
        out[ihl + 6] = 0;
        out[ihl + 7] = 0;
        const udpCk = udpChecksum(out.subarray(ihl), pseudo);
        out[ihl + 6] = (udpCk >> 8) & 0xff;
        out[ihl + 7] = udpCk & 0xff;
    }
    return out;
}

/**
 * SNAT: rewrite the source address of a whole IPv4 packet to `newSrc` (leaving
 * the destination untouched), recomputing the IP + UDP checksums.
 */
export function natPacketSource(
    buf: Uint8Array,
    newSrc: string,
): Uint8Array | null {
    return natIpAddress(buf, newSrc, 12);
}

/**
 * Rewrite the destination address of a whole IPv4 packet to `newDst` (leaving
 * the source untouched), recomputing the IP + UDP checksums. Used to de-SNAT a
 * reply back to the virtual-interface address.
 */
export function natPacketDestination(
    buf: Uint8Array,
    newDst: string,
): Uint8Array | null {
    return natIpAddress(buf, newDst, 16);
}
