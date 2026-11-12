/**
 * Linux AF_INET raw socket bound to a single interface (SO_BINDTODEVICE) —
 * for transparently forwarding whole IPv4 packets out a chosen physical
 * interface.
 *
 * The MobLink relay is a transparent L3 bridge: it receives whole IP packets
 * from the encoder (over the wire-protocol UDP channel) and sends them out one
 * of its own physical interfaces, forcing egress with SO_BINDTODEVICE so the
 * packets leave that specific NIC with the *original* source address (the
 * encoder's virtual-interface IP), not the relay's own. The reverse direction
 * reads packets arriving on the same interface and hands back the ones
 * addressed to the virtual interface.
 *
 * Two sockets are used (this family split is deliberate, not incidental):
 *   - **Send:** `AF_INET / SOCK_RAW / IPPROTO_RAW` + SO_BINDTODEVICE. Proven
 *     to inject full IPv4 datagrams out the interface.
 *   - **Receive (tap):** `AF_PACKET / SOCK_RAW` on the interface, filtering
 *     for IPv4 frames. An `AF_INET/SOCK_RAW` socket transmits but does NOT
 *     receive the frames on a live link — only the L2 `AF_PACKET` capture
 *     socket (what tcpdump uses) delivers them. `readStream()` strips the
 *     Ethernet (+ VLAN) header so callers see IPv4 datagrams at offset 0.
 * Both require CAP_NET_ADMIN (or root), the same privilege the TUN device needs.
 */

import { dlopen, FFIType, ptr } from "bun:ffi";
import { closeSync } from "node:fs";
import { ipToBytes } from "./ip";

// ---------------------------------------------------------------------------
// Linux constants
// ---------------------------------------------------------------------------

const AF_INET = 2;
/** Host-to-network short (16-bit) byte swap. */
function htons(x: number): number {
    return ((x & 0xff) << 8) | ((x >> 8) & 0xff);
}

const AF_PACKET = 17;
const SOCK_RAW = 3;
const IPPROTO_RAW = 255;
// AF_PACKET receive-all link type, htons(ETH_P_ALL) little-endian.
const ETH_P_ALL_HW = 0x0300;
// Ethernet EtherTypes (big-endian on the wire).
const ETH_P_IPV4 = 0x0800;
const ETH_P_QINQ = 0x88a8;
const ETH_P_VLAN = 0x8100;

const SOL_SOCKET = 1;
const SO_BINDTODEVICE = 25;
const SO_RCVBUF = 8;

/** Receive ring size for the sockets (bytes). */
const IFACE_RCVBUF = 4 * 1024 * 1024;

// ---------------------------------------------------------------------------
// L2 → L3 framing
// ---------------------------------------------------------------------------

/**
 * Strip the Ethernet (and any 802.1Q/QinQ VLAN) header from a link-layer frame
 * and forward only IPv4 datagrams. The AF_PACKET tap yields whole L2 frames;
 * the relay's IP-layer logic expects the IPv4 header at offset 0, so the L2
 * header is removed here and non-IPv4 frames are dropped.
 */
function stripL2(src: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
    const ts = new TransformStream<Uint8Array, Uint8Array>({
        transform(frame, controller) {
            if (frame.length < 14) return;
            let type = (frame[12] << 8) | frame[13];
            let off = 14;
            while ((type === ETH_P_VLAN || type === ETH_P_QINQ) && frame.length >= off + 4) {
                off += 4;
                type = (frame[off + 2] << 8) | frame[off + 3];
            }
            if (type !== ETH_P_IPV4) return; // IPv4 only (SRT is UDP-over-IP).
            controller.enqueue(frame.slice(off));
        },
    });
    void src.pipeTo(ts.writable).catch(() => {
        // The tap socket is read to completion by the relay's read loop; if it
        // is cancelled the pipe simply ends.
    });
    return ts.readable;
}

// ---------------------------------------------------------------------------
// FFI
// ---------------------------------------------------------------------------

/** libc symbols as exposed by a `dlopen` handle (under `.symbols`). */
interface LibcHandle {
    symbols: {
        socket: (domain: number, type: number, protocol: number) => number;
        setsockopt: (fd: number, level: number, optname: number, optval: unknown, optlen: number) => number;
        sendto: (fd: number, buf: unknown, len: number, flags: number, addr: unknown, addrlen: number) => number;
        bind: (fd: number, addr: unknown, addrlen: number) => number;
        if_nametoindex: (name: unknown) => number;
        close: (fd: number) => number;
    };
}

let libc: LibcHandle | null = null;
let libcAttempted = false;

function loadLibc(): LibcHandle | null {
    if (libcAttempted) return libc;
    libcAttempted = true;
    try {
        libc = dlopen("libc.so.6", {
            socket: {
                args: [FFIType.i32, FFIType.i32, FFIType.i32],
                returns: FFIType.i32,
            },
            setsockopt: {
                args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.u32],
                returns: FFIType.i32,
            },
            sendto: {
                args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.u32],
                returns: FFIType.i32,
            },
            bind: {
                args: [FFIType.i32, FFIType.ptr, FFIType.u32],
                returns: FFIType.i32,
            },
            if_nametoindex: {
                args: [FFIType.ptr],
                returns: FFIType.u32,
            },
            close: {
                args: [FFIType.i32],
                returns: FFIType.i32,
            },
        }) as unknown as LibcHandle;
    } catch {
        libc = null;
    }
    return libc;
}

/**
 * Build a `struct sockaddr_in` (16 bytes, network byte order) for the given
 * IPv4 address, port 0 (raw IP sockets ignore the port).
 */
function buildSockaddrIn(dstIp: string): ArrayBuffer {
    const buf = new ArrayBuffer(16);
    const view = new DataView(buf);
    // sin_family = AF_INET (little-endian u16, x86_64)
    view.setUint16(0, AF_INET, true);
    // sin_port = 0 (bytes 2..3)
    // sin_addr = 4 octets, network byte order (bytes 4..7)
    const octets = ipToBytes(dstIp);
    for (let i = 0; i < 4; i++) view.setUint8(4 + i, octets[i]);
    // sin_zero = 8 zero bytes (bytes 8..15) — already zero
    return buf;
}

function toUint8Array(buf: ArrayBuffer | Uint8Array): Uint8Array {
    return buf instanceof Uint8Array ? buf : new Uint8Array(buf);
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A single physical interface carrying raw IP packets. */
export interface IfaceRawSocket {
    /** Readable stream of incoming raw IP datagrams (header included). */
    readStream(): ReadableStream<Uint8Array>;
    /** Send a full IPv4 packet out the bound interface. Returns bytes written. */
    send(packet: Uint8Array, dstIp: string): number;
    /** Release the underlying fd. */
    close(): void;
}

export interface OpenIfaceRawSocketOptions {
    /** Receive ring size to request via SO_RCVBUF (bytes). */
    rcvbufBytes?: number;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

class FDIfaceRawSocket implements IfaceRawSocket {
    constructor(
        private sendFd: number,
        private tapFd: number,
    ) { }

    readStream(): ReadableStream<Uint8Array> {
        // The tap is an AF_PACKET link-level socket: it delivers whole Ethernet
        // frames. Strip the L2 header so callers see IPv4 datagrams at offset 0
        // (what the relay's IP-layer logic expects).
        const stream = Bun.file(this.tapFd).stream() as ReadableStream<Uint8Array>;
        return stripL2(stream);
    }

    send(packet: Uint8Array, dstIp: string): number {
        const lib = loadLibc();
        if (!lib) throw new Error("net_linux: libc not available — cannot send");
        const dataBuf = toUint8Array(packet).buffer as ArrayBuffer;
        const addrBuf = buildSockaddrIn(dstIp);
        const written = lib.symbols.sendto(
            this.sendFd,
            ptr(dataBuf),
            dataBuf.byteLength,
            0, // flags
            ptr(addrBuf),
            addrBuf.byteLength,
        );
        if (written < 0) {
            throw new Error(`net_linux: sendto failed on fd ${this.sendFd} (errno ${-written})`);
        }
        return written;
    }

    close(): void {
        for (const fd of [this.sendFd, this.tapFd]) {
            if (fd < 0) continue;
            try {
                loadLibc()?.symbols.close(fd);
            } catch {
                // fall through
            }
            // Belt-and-suspenders: node:fs closeSync reliably closes on Bun.
            try {
                closeSync(fd);
            } catch {
                // already closed
            }
        }
        this.sendFd = -1;
        this.tapFd = -1;
    }
}

/**
 * Open a raw AF_INET socket bound to `ifaceName` for transparent IP forwarding.
 *
 * @throws {Error} when the platform is unsupported, the socket cannot be
 * created (typically missing CAP_NET_ADMIN / not root), or the interface name
 * is invalid.
 */
export function openIfaceRawSocket(
    ifaceName: string,
    opts: OpenIfaceRawSocketOptions = {},
): IfaceRawSocket {
    const lib = loadLibc();
    if (!lib) {
        throw new Error(
            "openIfaceRawSocket: libc FFI unavailable — raw IP forwarding is not supported on this platform",
        );
    }
    if (!ifaceName) throw new Error("openIfaceRawSocket: interface name is required");

    // Send socket: AF_INET/SOCK_RAW/IPPROTO_RAW + SO_BINDTODEVICE. Proven to
    // inject full IPv4 datagrams out the interface.
    const sendFd = lib.symbols.socket(AF_INET, SOCK_RAW, IPPROTO_RAW);
    if (sendFd < 0) {
        throw new Error(
            "openIfaceRawSocket: socket(AF_INET, SOCK_RAW, IPPROTO_RAW) failed — " +
            "requires CAP_NET_ADMIN (run as root)",
        );
    }
    // Bind the send socket to the interface (SO_BINDTODEVICE takes a
    // nul-terminated name).
    const nameBytes = new TextEncoder().encode(`${ifaceName}\0`);
    const nameBuf = nameBytes.buffer as ArrayBuffer;
    const bindRet = lib.symbols.setsockopt(
        sendFd,
        SOL_SOCKET,
        SO_BINDTODEVICE,
        ptr(nameBuf),
        nameBytes.length,
    );
    if (bindRet < 0) {
        lib.symbols.close(sendFd);
        throw new Error(
            `openIfaceRawSocket: SO_BINDTODEVICE failed for interface "${ifaceName}" ` +
            "(interface does not exist or lacks permission)",
        );
    }

    // Tap socket: AF_PACKET/SOCK_RAW on the interface, filtering for IPv4
    // frames. This is a true L2 capture (what tcpdump uses) and — unlike the
    // AF_INET/SOCK_RAW family — it actually *receives* the frames on the wire,
    // so the OBS→vif replies become visible to the relay.
    const idx = lib.symbols.if_nametoindex(ptr(nameBuf));
    if (idx === 0) {
        lib.symbols.close(sendFd);
        throw new Error(`openIfaceRawSocket: interface "${ifaceName}" not found`);
    }
    const tapFd = lib.symbols.socket(AF_PACKET, SOCK_RAW, htons(ETH_P_IPV4));
    if (tapFd < 0) {
        lib.symbols.close(sendFd);
        throw new Error(
            "openIfaceRawSocket: socket(AF_PACKET, SOCK_RAW, ETH_P_IPV4) failed — " +
            "requires CAP_NET_ADMIN (run as root)",
        );
    }
    // Bind the tap to the specific interface. struct sockaddr_ll is 20 bytes:
    //   [sll_family u16][sll_protocol u16][sll_ifindex u32][sll_hatype u16]
    //   [sll_halen  u8 ][sll_addr    8B]
    const ll = new ArrayBuffer(20);
    const llView = new DataView(ll);
    llView.setUint16(0, AF_PACKET, true);       // sll_family
    llView.setUint16(2, htons(ETH_P_IPV4), true); // sll_protocol
    llView.setUint32(4, idx, true);             // sll_ifindex
    // sll_hatype / sll_halen / sll_addr = 0 (bytes 8..19) — already zero
    const tapBindRet = lib.symbols.bind(tapFd, ptr(ll), 20);
    if (tapBindRet < 0) {
        lib.symbols.close(sendFd);
        lib.symbols.close(tapFd);
        throw new Error(`openIfaceRawSocket: bind(AF_PACKET) failed for interface "${ifaceName}"`);
    }
    // Larger receive ring for the tap.
    const rcvbuf = opts.rcvbufBytes ?? IFACE_RCVBUF;
    const rcvbufBuf = new ArrayBuffer(4);
    new DataView(rcvbufBuf).setUint32(0, rcvbuf, true);
    lib.symbols.setsockopt(tapFd, SOL_SOCKET, SO_RCVBUF, ptr(rcvbufBuf), 4);

    return new FDIfaceRawSocket(sendFd, tapFd);
}

// ---------------------------------------------------------------------------
// Test double
// ---------------------------------------------------------------------------

export interface MockIfaceRawSocket extends IfaceRawSocket {
    /** Packets sent via `send`, with their destination IP. */
    sent: Array< { packet: Uint8Array; dstIp: string } >;
    closed: boolean;
    /** Queue of packets pending delivery from `readStream()`. */
    inbound: Uint8Array[];
    /** Deliver a packet to the read loop (resolves any waiting pull). */
    push(packet: Uint8Array): void;
}

/**
 * In-memory raw-socket used by tests and previews: records sends and lets
 * tests push inbound packets (delivered on demand to the read loop) without a
 * real NIC.
 */
export function makeMockIfaceRawSocket(): MockIfaceRawSocket {
    const sent: Array<{ packet: Uint8Array; dstIp: string }> = [];
    const queue: Uint8Array[] = [];
    let waiter: (() => void) | null = null;
    let closed = false;

    return {
        sent,
        /** Pre-queued inbound packets (satisfies the `inbound` field). */
        inbound: queue,
        get closed() { return closed; },
        readStream(): ReadableStream<Uint8Array> {
            return new ReadableStream<Uint8Array>({
                async pull(controller) {
                    if (queue.length > 0) {
                        controller.enqueue(queue.shift()!);
                        return;
                    }
                    if (closed) {
                        controller.close();
                        return;
                    }
                    await new Promise<void>((resolve) => {
                        waiter = resolve;
                    });
                    if (closed) {
                        controller.close();
                        return;
                    }
                    controller.enqueue(queue.shift()!);
                },
                cancel() {
                    closed = true;
                },
            });
        },
        /** Queue a packet to deliver to the next read in the read loop. */
        push(packet: Uint8Array): void {
            queue.push(packet);
            const w = waiter;
            waiter = null;
            w?.();
        },
        send(packet: Uint8Array, dstIp: string): number {
            if (closed) throw new Error("IfaceRawSocket is closed");
            sent.push({ packet, dstIp });
            return packet.length;
        },
        close(): void {
            closed = true;
        },
    };
}
