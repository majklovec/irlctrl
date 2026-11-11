/* The encoder side: a TUN device bridged to a remote UDP relay.
 *
 * One TUN = one virtual-interface IP (the SRTLA bond address). The encoder's
 * SRTLA bond sends packets to the vif IP; they are read off the TUN as whole
 * IPv4 packets, framed (0x01 data frame tagged with the vif IP) and sent to the
 * relay, which forwards each packet transparently out a physical interface.
 * Replies arriving back from the relay are already full IPv4 packets
 * addressed to the vif IP, so they are written straight into the TUN — no
 * per-address bookkeeping, no flow swap.
 *
 * The packet logic consumes a `TunDevice` (see `tun_linux.ts`), so the whole
 * module is unit-testable with `makeMockTunDevice()` — no root, no FFI.
 */
// @bun-only
import { decodeFrame, encodeDataFrame, encodeKeepaliveFrame } from "./protocol";
import { newVifStats, noteError } from "./stats";
import type { Endpoint, VifStats } from "./types";
import {
    deleteTun,
    makeMockTunDevice,
    openTun,
    configureTun,
    IFACE_NAME_RE,
} from "./tun_linux";

export interface VirtualInterfaceOptions {
    /** TUN interface name, 1..15 chars. Must not exist already. */
    name: string;
    /** The IPv4 address to configure on the TUN (e.g. 10.3.3.1). */
    localIp: string;
    /** Prefix length for the TUN address (e.g. 24). */
    prefixLength: number;
    /** The remote relay endpoint (createUdpRelay's listen socket). */
    relay: Endpoint;
    /** Address the UDP socket binds (default `localIp`). */
    bindAddress?: string;
    /** TUN MTU (default 1400). Max data payload = mtu − 28. */
    mtu?: number;
    /** How often to send keepalive frames (default 5000 ms). */
    keepaliveIntervalMs?: number;
    onStats?: (s: VifStats) => void;
    /**
     * Test seam: inject a `TunDevice` instead of opening a real one. When
     * provided, `start()`/`stop()` manage the mock (no `ip` calls).
     */
    tunDevice?: import("./tun_linux").TunDevice;
}

export interface VirtualInterface {
    readonly name: string;
    readonly localIp: string;
    /**
     * The relay-facing socket's bound {host, port}. Null before `start()`.
     * Diagnostic: what the relay (or a test) must send replies to.
     */
    readonly socketAddress: { host: string; port: number } | null;
    start(): Promise<void>;
    stop(): Promise<void>;
    stats(): VifStats;
    isRunning(): boolean;
}

/** Bind address + ephemeral port of the relay-facing socket. */
interface BoundSocket {
    address: { address: string; port: number };
    send(data: Uint8Array, port: number, host: string): void;
    close(): void;
}

const DEFAULT_MTU = 1400;
const DEFAULT_KEEPALIVE_MS = 5000;

/**
 * Construct a virtual interface. Cheap: validates input only. All runtime
 * failures (TUN open, socket bind) surface from `start()`.
 *
 * `tunDevice` is a test seam: pass `makeMockTunDevice().device` to exercise
 * the packet logic without a real TUN (unit tests do this on any platform).
 */
export async function createVirtualInterface(
    opts: VirtualInterfaceOptions,
): Promise<VirtualInterface> {
    // A mock device means "test mode" — allow the factory to run off-Linux.
    if (!opts.tunDevice && process.platform !== "linux")
        throw new Error(
            `@irlctrl/udp-relay requires Linux (running on ${
                process.platform
            }) — pass a mock tunDevice for unit tests`,
        );
    if (!IFACE_NAME_RE.test(opts.name))
        throw new Error(
            `name ${JSON.stringify(opts.name)} is not a valid interface name`,
        );
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(opts.localIp))
        throw new Error(`localIp ${JSON.stringify(opts.localIp)} is not IPv4`);
    if (
        !Number.isInteger(opts.prefixLength) ||
        opts.prefixLength < 8 ||
        opts.prefixLength > 32
    )
        throw new Error(`prefixLength ${opts.prefixLength} out of [8,32]`);
    if (
        typeof opts.relay.port !== "number" ||
        opts.relay.port < 1 ||
        opts.relay.port > 65535 ||
        !opts.relay.host
    )
        throw new Error("relay.host and relay.port are required");
    const mtu = opts.mtu ?? DEFAULT_MTU;
    if (!Number.isInteger(mtu) || mtu < 28 || mtu > 65535)
        throw new Error(`mtu ${mtu} out of [28,65535]`);
    const keepaliveIntervalMs = opts.keepaliveIntervalMs ?? DEFAULT_KEEPALIVE_MS;
    if (
        !Number.isInteger(keepaliveIntervalMs) ||
        keepaliveIntervalMs < 1
    )
        throw new Error(
            `keepaliveIntervalMs ${keepaliveIntervalMs} must be >= 1`,
        );
    return new VifImpl(opts, opts.localIp, mtu, keepaliveIntervalMs);
}

class VifImpl implements VirtualInterface {
    // NOTE: backing field is `_stats` — an own property named `stats` would
    // shadow the `stats()` method (same footgun relay.ts hit).
    private _stats: VifStats;
    private tun: import("./tun_linux").TunDevice | null = null;
    private socket: BoundSocket | null = null;
    private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
    private running = false;
    private readTask: Promise<void> | null = null;

    constructor(
        private opts: VirtualInterfaceOptions,
        readonly localIp: string,
        private mtu: number,
        private keepaliveIntervalMs: number,
    ) {
        this._stats = newVifStats();
    }

    get name(): string {
        return this.opts.name;
    }
    get socketAddress(): { host: string; port: number } | null {
        if (!this.socket) return null;
        return {
            host: this.socket.address.address,
            port: this.socket.address.port,
        };
    }
    isRunning(): boolean {
        return this.running;
    }
    stats(): VifStats {
        return { ...this._stats };
    }

    async start(): Promise<void> {
        if (this.running) return;

        // 1. TUN device (real fd via FFI ioctl, or the injected mock).
        if (this.opts.tunDevice) {
            this.tun = this.opts.tunDevice;
        } else {
            this.tun = await openTun(this.opts.name);
            await configureTun(
                this.tun.name,
                this.localIp,
                this.opts.prefixLength,
                this.mtu,
            );
        }
        const tun = this.tun;

        // 2. UDP socket to the relay. Bound to `bindAddress` (default our
        //    localIp) on an ephemeral port — never 0.0.0.0: replies must come
        //    back on the TUN's own address, and binding 0.0.0.0 would let the
        //    kernel answer from a different interface.
        type DataFn = (
            s: BoundSocket,
            buf: Uint8Array,
            port: number,
            addr: string,
        ) => void;
        this.socket = (await Bun.udpSocket({
            hostname: this.opts.bindAddress ?? this.localIp,
            port: 0,
            binaryType: "uint8array",
            socket: {
                data: ((
                    _s: any,
                    buf: Uint8Array,
                    _port: number,
                    addr: string,
                ) => this.onRelayData(buf, addr)) as DataFn,
                // Native network errors (e.g. an ICMP port-unreachable surfacing
                // via the UDP errqueue as ECONNREFUSED when the relay's port is
                // closed) are thrown from the socket, not delivered as data.
                // Without a handler they become uncaught and kill the process.
                // Consume + log: the vif keeps running.
                error: (err: unknown) =>
                    noteError(
                        this._stats,
                        `vif socket: ${err instanceof Error ? err.message : String(err)}`,
                    ),
            },
        } as unknown as Parameters<typeof Bun.udpSocket>[0])) as unknown as BoundSocket;

        // 3. Read loop (non-blocking: each stream chunk = one TUN packet).
        this._stats.startedAt = Date.now();
        this.running = true;
        this.opts.onStats?.(this.stats());
        const stream = tun.readStream();
        this.readTask = (async () => {
            const reader = stream.getReader();
            try {
                for (;;) {
                    const { value, done } = await reader.read();
                    if (done) return;
                    if (value) this.onTunPacket(value);
                }
            } catch (e) {
                noteError(
                    this._stats,
                    `tun read loop: ${e instanceof Error ? e.message : String(e)}`,
                );
            } finally {
                try {
                    reader.releaseLock();
                } catch {
                    // stream already released
                }
            }
        })();

        // 4. Keepalives.
        this.keepaliveTimer = setInterval(() => {
            if (!this.running || !this.socket) return;
            try {
                this.socket.send(
                    encodeKeepaliveFrame(Date.now()),
                    this.opts.relay.port,
                    this.opts.relay.host,
                );
            } catch (e) {
                noteError(
                    this._stats,
                    `keepalive send: ${e instanceof Error ? e.message : String(e)}`,
                );
            }
        }, this.keepaliveIntervalMs);
        // Don't keep the process alive just for keepalives.
        if (typeof (this.keepaliveTimer as any)?.unref === "function")
            (this.keepaliveTimer as any).unref();
    }

    async stop(): Promise<void> {
        if (!this.running) return;
        this.running = false;
        if (this.keepaliveTimer) {
            clearInterval(this.keepaliveTimer);
            this.keepaliveTimer = null;
        }
        // 1. Close the TUN fd (the kernel removes the interface on last close).
        try {
            this.tun?.close();
        } catch {
            // best effort
        }
        // 2. Best-effort `ip link del` (no-op for the mock).
        if (!this.opts.tunDevice && this.tun)
            await deleteTun(this.tun.name);
        // 3. Close the UDP socket.
        try {
            this.socket?.close();
        } catch {
            // best effort
        }
        this.tun = null;
        this.socket = null;
        this.opts.onStats?.(this.stats());
    }

    /** Outbound: TUN IP packet → data frame (tagged with the vif IP) → relay. */
    private onTunPacket(buf: Uint8Array): void {
        if (!this.socket) return;
        // Forward the whole IP packet. Anything that isn't a minimal IPv4
        // datagram is dropped and counted.
        if (buf.length < 20) {
            this._stats.txDropped++;
            return;
        }
        const frame = encodeDataFrame(buf, this.localIp);
        try {
            this.socket.send(frame, this.opts.relay.port, this.opts.relay.host);
        } catch (e) {
            noteError(
                this._stats,
                `relay send: ${e instanceof Error ? e.message : String(e)}`,
            );
            return;
        }
        this._stats.txPackets++;
        this._stats.txBytes += frame.length;
        this.opts.onStats?.(this.stats());
    }

    /** Inbound: relay reply (already a full IP packet) → straight into the TUN. */
    private onRelayData(buf: Uint8Array, addr: string): void {
        if (!this.tun) return;
        // Defence: only accept frames from the configured relay host.
        if (addr !== this.opts.relay.host) {
            this._stats.rxDropped++;
            return;
        }
        const frame = decodeFrame(buf, this.mtu);
        if (frame.type === "malformed" || frame.type === "keepalive") {
            this._stats.rxDropped++;
            return;
        }
        // The payload is already the complete IPv4 packet addressed to the vif
        // IP — write it into the TUN untouched.
        const pkt = frame.payload;
        try {
            this.tun.write(pkt);
        } catch (e) {
            noteError(
                this._stats,
                `tun write: ${e instanceof Error ? e.message : String(e)}`,
            );
            return;
        }
        this._stats.rxPackets++;
        this._stats.rxBytes += pkt.length;
        this.opts.onStats?.(this.stats());
    }
}

// Re-exported for tests and for callers that want the mock directly.
export { makeMockTunDevice };
