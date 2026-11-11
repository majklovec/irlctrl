/* Linux TUN device open / read / write / close.
 *
 * Non-blocking approach: the TUN fd is opened `O_NONBLOCK` and read through
 * `node:fs` `createReadStream(null, { fd })`, a libuv-driven stream that
 * integrates the fd with the event loop's poller. With `IFF_NO_PI` each read
 * yields exactly one IPv4 packet. `node:fs` also supplies write/close of the
 * fd; the only syscall that cannot be expressed without a FFI binding is the
 * `ioctl(TUNSETIFF)`, loaded from libc on first use and guarded so a build
 * without the FFI type API fails with a clear, actionable message from
 * `start()` rather than at import time.
 *
 * Why NOT `Bun.file(fd).stream()`: it performs a blocking `pread` on the fd.
 * A TUN has no data most of the time, so that read blocks the entire Bun
 * event loop — the web server, all timers, and signal handling freeze whenever
 * the TUN drains (verified with `strace`: main thread parked in `pread64` on
 * the TUN fd). `createReadStream` keeps the loop responsive and delivers
 * packets the instant they arrive (verified: 24 live ping frames through the
 * TUN while a 500 ms timer kept firing).
 *
 * This file is `// @bun-only`: it is the only piece of the library with a real
 * Linux system surface. The packet logic that consumes a TUN lives in
 * `virtual_interface.ts` and is fully testable against `makeMockTunDevice()`.
 */
// @bun-only
import {
    accessSync,
    closeSync,
    constants,
    createReadStream,
    openSync,
    writeSync,
} from "node:fs";
import type { Readable } from "node:stream";
import { dlopen, FFIType, ptr } from "bun:ffi";

/** IFF_TUN (2): use a TUN device (layer 3, no link header). */
export const IFF_TUN = 0x0001;
/** IFF_NO_PI (0x1000): no 4-byte packet-info prefix on each read. Mandatory. */
export const IFF_NO_PI = 0x1000;
/** The combined flags a TUN is opened with (IFF_TUN|IFF_NO_PI, 0x1001). */
export const TUN_OPEN_FLAGS = IFF_TUN | IFF_NO_PI;
/** TUNSETIFF = _IOW('T', 202, int) → 0x400454ca (from <linux/if_tun.h>). */
export const TUNSETIFF = 0x400454ca;
/** Length of `struct ifreq.ifr_name` (the interface-name field). */
export const IF_NAME_LEN = 16;
/** `ifr_flags` is the first member of `ifr_data`, at this offset. */
export const IFREQ_FLAGS_OFFSET = IF_NAME_LEN;
/**
 * Buffer handed to `ioctl(TUNSETIFF)`. The kernel copies in
 * `sizeof(struct ifreq)` (40 on x86-64); a larger buffer is fine and portable,
 * so we use 64 to be safe on every architecture.
 */
export const IFREQ_LEN = 64;

/** Interface names we allow to reach `ip`: letters, digits, `_.-`, 1–15 chars. */
export const IFACE_NAME_RE = /^[a-zA-Z0-9_.-]{1,15}$/;

/** Guard `ip` argv against injection: every name we pass must match IFACE_NAME_RE. */
export function assertIfaceName(name: string): string {
    if (!IFACE_NAME_RE.test(name))
        throw new Error(
            `refusing to use a non-conforming interface name ${JSON.stringify(name)}`,
        );
    return name;
}

/**
 * Assign the virtual IP and bring the link up. The library shells out to `ip`
 * with an argv array (never a shell string) for this v1 step.
 * TODO: replace with a netlink RTM_NEWADDR/RTM_NEWLINK implementation.
 */
export async function configureTun(
    name: string,
    localIp: string,
    prefixLength: number,
    mtu: number,
): Promise<void> {
    assertIfaceName(name);
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(localIp))
        throw new Error(`localIp ${JSON.stringify(localIp)} is not IPv4`);
    if (!Number.isInteger(prefixLength) || prefixLength < 8 || prefixLength > 32)
        throw new Error(`prefixLength ${prefixLength} out of [8,32]`);
    await runCmd("ip", ["addr", "add", `${localIp}/${prefixLength}`, "dev", name]);
    await runCmd("ip", ["link", "set", "dev", name, "mtu", String(mtu), "up"]);
}

/**
 * Best-effort `ip link del`. Linux normally tears the TUN down on the last fd
 * close; this is a belt-and-braces cleanup that never throws.
 */
export async function deleteTun(name: string): Promise<void> {
    try {
        assertIfaceName(name);
    } catch {
        return;
    }
    try {
        await runCmd("ip", ["link", "del", "dev", name]);
    } catch {
        // best-effort cleanup — never throws
    }
}

/**
 * Resolve a command binary to an absolute path. `spawn` only searches `PATH`,
 * and a restricted `sudo` `secure_path` can drop the directory where `ip`
 * lives (`/usr/sbin`) — so we walk `PATH` ourselves and, failing that, probe
 * the usual sbin/bin locations directly. Returns the first executable match,
 * or the bare name (which then surfaces as a clear spawn error).
 */
export function resolveBinary(name: string): string {
    // 1. `PATH` search (honours whatever the process was started with).
    const pathDirs = (process.env.PATH ?? "").split(":").filter(Boolean);
    const candidates: string[] = [];
    for (const dir of pathDirs) candidates.push(`${dir}/${name}`);
    // 2. Belt-and-braces: the standard system locations, in priority order.
    for (const dir of ["/usr/sbin", "/sbin", "/usr/bin", "/bin"])
        candidates.push(`${dir}/${name}`);
    for (const p of candidates) {
        try {
            accessSync(p, constants.X_OK);
            return p;
        } catch {
            // keep looking
        }
    }
    return name;
}

/**
 * Run a command with an argv array (never a shell string). Resolves with stdout
 * on exit 0; rejects on a non-zero exit OR a spawn failure (`error` event —
 * e.g. the binary is not on `PATH`, such as under a restricted `sudo`
 * secure_path).
 *
 * The `error` handler is essential: with only a `close` listener, a failed
 * spawn (ENOENT) never fires `close`, so the promise would hang forever and
 * the caller's RPC would time out.
 */
export async function runCmd(binary: string, args: string[]): Promise<string> {
    const { spawn } = await import("node:child_process");
    const binPath = resolveBinary(binary);
    return new Promise<string>((resolve, reject) => {
        let settled = false;
        let out = "";
        let err = "";
        const child = spawn(binPath, args, { stdio: ["ignore", "pipe", "pipe"] });
        child.stdout?.on("data", (d: Buffer) => {
            out += String(d);
        });
        child.stderr?.on("data", (d: Buffer) => {
            err += String(d);
        });
        child.on("error", (e: Error) => {
            if (settled) return;
            settled = true;
            reject(
                new Error(
                    `${binary} failed to start: ${e.message} ` +
                        `(is "${binary}" on PATH?)`,
                ),
            );
        });
        child.on("close", (code: number | null) => {
            if (settled) return;
            settled = true;
            const detail = (err || out).trim();
            if (code === 0) resolve(out);
            else
                reject(
                    new Error(
                        `${binary} ${args.join(" ")} exited ${code}` +
                            (detail ? `: ${detail}` : ""),
                    ),
                );
        });
    });
}

/** A byte buffer the caller can read the assigned name back from. */
export interface TunSetIffResult {
    /** The kernel-assigned interface name (trimmed). */
    name: string;
}

/**
 * Pad an interface name into a `struct ifreq.ifr_name` (16 bytes, NUL-
 * terminated). Exported for the struct-layout unit test; the caller supplies
 * the surrounding struct when issuing the ioctl.
 */
export function buildTunsetName(name: string): Uint8Array {
    const buf = new Uint8Array(IF_NAME_LEN);
    const bytes = new TextEncoder().encode(name);
    if (bytes.length >= IF_NAME_LEN)
        throw new Error(
            `TUN name ${JSON.stringify(name)} is ${bytes.length} bytes; max is ${
                IF_NAME_LEN - 1
            }`,
        );
    buf.set(bytes, 0);
    // buf[bytes.length] stays 0 (NUL terminator); the rest stay 0.
    return buf;
}

/**
 * Read the assigned name back out of a `struct ifreq` buffer after the
 * TUNSETIFF ioctl.
 */
export function readTunsetName(ifr: Uint8Array): string {
    const end = ifr.indexOf(0);
    return new TextDecoder().decode(ifr.subarray(0, end === -1 ? IF_NAME_LEN : end));
}

/** A minimal TUN device handle: a fd plus non-blocking read stream and write. */
export interface TunDevice {
    readonly fd: number;
    readonly name: string;
    /** Non-blocking reader: each chunk is one full IPv4 packet (IFF_NO_PI). */
    readStream(): ReadableStream<Uint8Array>;
    write(packet: Uint8Array): void;
    close(): void;
}

type LibcIoctl = (fd: number, request: number, arg: Uint8Array) => number;

let cachedIoctl: LibcIoctl | null = null;
let ioctlLoadAttempted = false;

/** libc `ioctl` as exposed by a `dlopen` handle (under `.symbols`). */
interface LibcHandle {
    symbols: { ioctl: (fd: number, request: number, arg: unknown) => number };
}

/** Load the libc `ioctl` via the public `bun:ffi` API. Returns null on failure. */
function loadLibcIoctl(): LibcIoctl | null {
    if (ioctlLoadAttempted) return cachedIoctl;
    ioctlLoadAttempted = true;
    try {
        const libc = dlopen(
            "libc.so.6",
            // `int ioctl(int fd, unsigned long request, ...)`. TUNSETIFF fits u32
            // (0x4008741a) and is zero-extended to 64 bits on x86-64.
            { ioctl: { args: [FFIType.i32, FFIType.u32, FFIType.ptr], returns: FFIType.i32 } },
        ) as unknown as LibcHandle;
        // `dlopen` wraps the bound functions under `.symbols`. `ptr(buf)` views the
        // caller's Uint8Array in place, so the kernel's TUNSETIFF write-back (the
        // assigned ifr_name) is read from the same buffer.
        const ioctl = libc.symbols.ioctl;
        cachedIoctl = (fd, request, arg) => ioctl(fd, request, ptr(arg));
        return cachedIoctl;
    } catch {
        cachedIoctl = null;
        return null;
    }
}

/**
 * Open a Linux TUN device with IFF_TUN | IFF_NO_PI and a padded name. Returns
 * the `TunDevice` with the kernel-assigned name. Throws on any failure (the
 * caller — `createVirtualInterface` — surfaces this from `start()`).
 */
export async function openTun(name: string): Promise<TunDevice> {
    if (process.platform !== "linux")
        throw new Error(
            `@irlctrl/udp-relay TUN support requires Linux (running on ${process.platform})`,
        );
    if (name.length > IF_NAME_LEN - 1)
        throw new Error(
            `TUN name ${JSON.stringify(name)} longer than ${IF_NAME_LEN - 1} chars`,
        );
    const ioctl = loadLibcIoctl();
    if (!ioctl)
        throw new Error(
            "cannot open TUN: this Bun build exposes no working `bun:ffi` — " +
                "run under a standard Bun build that includes FFI",
        );
    const fd = openTunFd();
    // `struct ifreq` for TUNSETIFF: `ifr_name` at 0, `ifr_flags` (IFF_TUN|
    // IFF_NO_PI) at offset 16. Build a full 64-byte buffer — the kernel copies
    // a real `struct ifreq` (40 bytes on x86-64) in, so the flags must sit in
    // bounds, which a bare 16-byte name buffer cannot provide.
    const nameBuf = buildTunsetName(name);
    const ifr = new Uint8Array(IFREQ_LEN);
    ifr.set(nameBuf, 0);
    new DataView(ifr.buffer).setUint16(IFREQ_FLAGS_OFFSET, TUN_OPEN_FLAGS, true);
    const ret = ioctl(fd, TUNSETIFF, ifr);
    if (ret < 0) {
        closeSync(fd);
        throw new Error(
            `ioctl(TUNSETIFF) failed for ${name} (requires CAP_NET_ADMIN/root)`,
        );
    }
    const assigned = readTunsetName(ifr);
    return new FdTunDevice(fd, assigned);
}

/**
 * The TUN fd is opened `O_NONBLOCK` — see {@link openTunFd}. A blocking TUN fd read hangs the thread
 * forever when no packet is queued; the read stream relies on the event loop
 * noticing the fd become readable. `r+` maps to `O_RDWR`; combined with
 * `O_NONBLOCK` the fd is read/write and non-blocking.
 */
function openTunFd(): number {
    return openSync("/dev/net/tun", "r+", constants.O_NONBLOCK);
}

/** A `TunDevice` backed by a real fd: read via stream, write/close via node:fs. */
class FdTunDevice implements TunDevice {
    constructor(
        readonly fd: number,
        readonly name: string,
    ) {}
    readStream(): ReadableStream<Uint8Array> {
        // Non-blocking read through the libuv poller. The TUN fd is `O_RDWR |
        // O_NONBLOCK` (see openTunFd), so this stream yields to the event loop
        // when idle and emits exactly one IPv4 packet per chunk (IFF_NO_PI).
        // `autoClose: false` — close() closes the fd itself (the kernel tears
        // the interface down on the last close), not the stream.
        // `null` path + `fd` option selects the fd-reading overload (there is
        // no file to open); the cast only satisfies the PathLike parameter type.
        const source: Readable = createReadStream(null as unknown as string, {
            fd: this.fd,
            autoClose: false,
        });
        return new ReadableStream<Uint8Array>({
            start(controller) {
                // `readable` fires when the fd becomes readable after an EAGAIN;
                // drain it fully (loop until `read()` returns null) so back-
                //logged packets are never dropped between events.
                source.on("readable", () => {
                    let chunk: Buffer | null;
                    while ((chunk = source.read()) !== null)
                        controller.enqueue(new Uint8Array(chunk));
                });
                source.on("error", (e) => controller.error(e));
                // The TUN never signals EOF for its lifetime, so no `end`
                // handler is needed; the fd close on stop() tears it down.
            },
        });
    }
    write(packet: Uint8Array): void {
        writeSync(this.fd, packet);
    }
    close(): void {
        try {
            closeSync(this.fd);
        } catch {
            // Already closed; idempotent.
        }
    }
}

/**
 * A TUN device without a real fd (no root, no ioctl) for unit tests:
 * `pushPacket()` plays the role of the kernel delivering a packet to the TUN
 * read loop, and `written` captures everything `write()` sends. Lets the
 * virtual_interface packet logic be tested without a TUN device.
 */
export function makeMockTunDevice(opts?: { name?: string }): {
    device: TunDevice;
    pushPacket: (p: Uint8Array) => void;
    written: Uint8Array[];
} {
    const written: Uint8Array[] = [];
    let controller: ReadableStreamController<Uint8Array> | null = null;
    let preRead: Uint8Array[] = [];
    const device: TunDevice = {
        fd: -1,
        name: opts?.name ?? "mock0",
        readStream() {
            const stream = new ReadableStream<Uint8Array>({
                start(c) {
                    controller = c;
                    for (const ch of preRead.splice(0)) c.enqueue(ch);
                },
            });
            return stream;
        },
        write(p) {
            written.push(p);
        },
        close() {
            try {
                controller?.close();
            } catch {
                // already closed
            }
            controller = null;
        },
    };
    const pushPacket = (p: Uint8Array): void => {
        if (controller) controller.enqueue(p as any);
        else preRead.push(p);
    };
    return { device, pushPacket, written };
}
