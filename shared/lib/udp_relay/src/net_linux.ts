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
 * A raw AF_INET / SOCK_RAW / IPPROTO_RAW socket transmits and receives full IP
 * datagrams (header included). This requires CAP_NET_ADMIN (or root), the same
 * privilege the TUN device needs.
 */

import { dlopen, FFIType, ptr } from "bun:ffi";
import { closeSync } from "node:fs";
import { ipToBytes } from "./ip";

// ---------------------------------------------------------------------------
// Linux constants
// ---------------------------------------------------------------------------

const AF_INET = 2;
const SOCK_RAW = 3;
const IPPROTO_RAW = 255;

const SOL_SOCKET = 1;
const SO_BINDTODEVICE = 25;
const SO_RCVBUF = 8;
// Without SO_RCVALL a SOCK_RAW socket only receives datagrams addressed to a
// LOCAL address. The relay's tap must observe the OBS→vif REPLY traffic (whose
// destination is the encoder's virtual-interface IP, not the relay's own), so
// the socket is put in "receive all" mode — every IP frame on the interface
// is delivered and filtered later by `decideIfacePacket` (vif-destined only).
const SO_RCVALL = 40;

/** Receive ring size for the raw socket (bytes). */
const IFACE_RCVBUF = 4 * 1024 * 1024;

// ---------------------------------------------------------------------------
// FFI
// ---------------------------------------------------------------------------

/** libc symbols as exposed by a `dlopen` handle (under `.symbols`). */
interface LibcHandle {
    symbols: {
        socket: (domain: number, type: number, protocol: number) => number;
        setsockopt: (fd: number, level: number, optname: number, optval: unknown, optlen: number) => number;
        sendto: (fd: number, buf: unknown, len: number, flags: number, addr: unknown, addrlen: number) => number;
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
        private fd: number,
    ) { }

    readStream(): ReadableStream<Uint8Array> {
        return Bun.file(this.fd).stream() as ReadableStream<Uint8Array>;
    }

    send(packet: Uint8Array, dstIp: string): number {
        const lib = loadLibc();
        if (!lib) throw new Error("net_linux: libc not available — cannot send");
        const dataBuf = toUint8Array(packet).buffer as ArrayBuffer;
        const addrBuf = buildSockaddrIn(dstIp);
        const written = lib.symbols.sendto(
            this.fd,
            ptr(dataBuf),
            dataBuf.byteLength,
            0, // flags
            ptr(addrBuf),
            addrBuf.byteLength,
        );
        if (written < 0) {
            throw new Error(`net_linux: sendto failed on fd ${this.fd} (errno ${-written})`);
        }
        return written;
    }

    close(): void {
        if (this.fd < 0) return;
        try {
            loadLibc()?.symbols.close(this.fd);
        } catch {
            // fall through
        }
        // Belt-and-suspenders: node:fs closeSync reliably closes on Bun.
        try {
            closeSync(this.fd);
        } catch {
            // already closed
        }
        this.fd = -1;
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

    const rcvbuf = opts.rcvbufBytes ?? IFACE_RCVBUF;

    const fd = lib.symbols.socket(AF_INET, SOCK_RAW, IPPROTO_RAW);
    if (fd < 0) {
        throw new Error(
            "openIfaceRawSocket: socket(AF_INET, SOCK_RAW, IPPROTO_RAW) failed — " +
            "requires CAP_NET_ADMIN (run as root)",
        );
    }

    // Set receive ring size.
    const rcvbufBuf = new ArrayBuffer(4);
    new DataView(rcvbufBuf).setUint32(0, rcvbuf, true);
    lib.symbols.setsockopt(fd, SOL_SOCKET, SO_RCVBUF, ptr(rcvbufBuf), 4);

    // Receive all IP frames on the interface (not just local-destined ones),
    // so the OBS→vif reply traffic is visible to the tap. Best-effort: if the
    // kernel rejects it (shouldn't happen with CAP_NET_ADMIN) the socket still
    // opens and forwards the encoder→iface direction.
    const rcvallBuf = new ArrayBuffer(4);
    new DataView(rcvallBuf).setUint32(0, 1, true);
    lib.symbols.setsockopt(fd, SOL_SOCKET, SO_RCVALL, ptr(rcvallBuf), 4);

    // Bind to the interface (SO_BINDTODEVICE takes a nul-terminated name).
    const nameBytes = new TextEncoder().encode(`${ifaceName}\0`);
    const nameBuf = nameBytes.buffer as ArrayBuffer;
    const bindRet = lib.symbols.setsockopt(
        fd,
        SOL_SOCKET,
        SO_BINDTODEVICE,
        ptr(nameBuf),
        nameBytes.length,
    );
    if (bindRet < 0) {
        lib.symbols.close(fd);
        throw new Error(
            `openIfaceRawSocket: SO_BINDTODEVICE failed for interface "${ifaceName}" ` +
            "(interface does not exist or lacks permission)",
        );
    }

    return new FDIfaceRawSocket(fd);
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
