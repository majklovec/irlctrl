/**
 * The relay-box side of the MobLink transparent L3 bridge.
 *
 * The relay has **no destination** and does **not use SRT**. It forwards whole
 * IPv4 packets:
 *   - inbound: whole IP packets arrive from the encoder over the wire-protocol
 *     UDP socket (`interfaceAddress:listenPort`). Each frame carries the vif IP
 *     plus a full IP packet; the relay learns the vif IP, then sends the packet
 *     out the bound physical interface (SO_BINDTODEVICE) so it leaves that NIC
 *     with the original (encoder/vif) source address, not the relay's own.
 *   - outbound: packets arriving on the bound interface are read; only those
 *     addressed to the learned vif IP are re-framed and sent back to the
 *     encoder, so the local SRTLA bond sees them from its own vif IP.
 *
 * Two transports:
 *   vifSocket = UDP bound to (interfaceAddress, listenPort) — to the encoder
 *   iface     = raw AF_INET socket bound to the physical interface (needs root)
 *
 * Drop/skip decisions live in the pure `decideEncoderFrame` / `decideIfacePacket`
 * functions so the forwarding policy is unit-testable without sockets / root.
 *
 * The library hotplugs nothing: the caller (module) restarts the relay when the
 * interface's IP changes.
 */

import { networkInterfaces } from "node:os";
import { decodeFrame, encodeDataFrame } from "./protocol";
import {
    ipDST,
    natPacketDestination,
    natPacketSource,
    parseUdpPacket,
    type ParsedUdpPacket,
} from "./ip";
import { openIfaceRawSocket, type IfaceRawSocket } from "./net_linux";
import type { RelayStats } from "./types";
import { newRelayStats, noteError } from "./stats";

/** A bound UDP socket the relay reads from and writes to (the vif socket). */
interface UdpSocket {
    address: { address: string; port: number };
    send(data: Uint8Array, port: number, host: string): void;
    close(): void;
}

export interface UdpRelayOptions {
    /** The physical interface to bind and forward through (e.g. "eth0"). */
    interfaceName: string;
    /** UDP port the encoder connects to on this interface. */
    listenPort: number;
    /** Override the resolved interface IPv4 (skips os.networkInterfaces()). */
    interfaceAddress?: string;
    /** Inject a raw interface socket (tests / previews). */
    ifaceSocket?: IfaceRawSocket;
    onStats?: (s: RelayStats) => void;
    /**
     * Invoke when the vif IP this relay bridges is learned (or changes).
     * The caller installs a route for it (e.g. `/32 dev <iface>`); the relay
     * stays transport-only and never touches the host routing table.
     */
    onVifLearned?: (vifIp: string) => void;
    /**
     * NAT mode (default false = transparent L3 bridge). When true, outbound
     * packets are source-NATed to this relay's `interfaceAddress` before
     * egress, and inbound replies addressed to that address are de-SNATed back
     * to the vif. This is what lets the destination be *remote* (not on the
     * relay's LAN): the reply path no longer depends on the destination
     * routing back to the private vif IP.
     *
     * Only UDP/IP packets are NATed (SRT is UDP); anything else is passed
     * through untouched. A small per-flow table (keyed by the 5-tuple) bounds
     * de-SNAT to packets that are genuine replies to a NATed flow, so ordinary
     * traffic addressed to the relay's own IP is never hijacked.
     */
    nat?: boolean;
}

export interface UdpRelay {
    readonly interfaceName: string;
    readonly interfaceAddress: string;
    readonly listenPort: number;
    start(): Promise<void>;
    stop(): Promise<void>;
    stats(): RelayStats;
    isRunning(): boolean;
}

const InterfaceRe = /^[a-zA-Z0-9_.-]{1,15}$/;

/** Resolve `interfaceName` → its first IPv4 address via os.networkInterfaces(). */
export function resolveInterfaceAddress(
    interfaceName: string,
    override?: string,
): string {
    if (override) {
        if (!/^\d+\.\d+\.\d+\.\d+$/.test(override))
            throw new Error(`interfaceAddress ${override} is not IPv4`);
        return override;
    }
    const all = networkInterfaces();
    const addresses = all[interfaceName] ?? [];
    const ipv4s = addresses.filter((a) => a.family === "IPv4");
    // Prefer a non-internal address (real NIC); fall back to loopback (`lo`).
    const ipv4 =
        ipv4s.find((a) => !a.internal) ?? ipv4s.find((a) => a.internal) ?? null;
    if (!ipv4)
        throw new Error(`no IPv4 address on interface ${interfaceName} to bind`);
    return ipv4.address;
}

// --- Pure forwarding decisions (unit-testable, no sockets / root) ------------

export type EncoderDecision =
    | { action: "forward"; vifIp: string; packet: Uint8Array }
    | { action: "liveness" } // keepalive, nothing to forward
    | { action: "drop"; reason: string };

/** What to do with a frame the ENCODER sent. Pure: no side effects. */
export function decideEncoderFrame(buf: Uint8Array): EncoderDecision {
    const frame = decodeFrame(buf);
    if (frame.type === "malformed") return { action: "drop", reason: frame.reason };
    if (frame.type === "keepalive") return { action: "liveness" };
    return { action: "forward", vifIp: frame.vifIp, packet: frame.payload };
}

export type IfaceDecision =
    | { action: "forward"; packet: Uint8Array }
    | { action: "drop"; reason: string };

/**
 * What to do with a raw IP packet read from the bound interface. Only packets
 * addressed to the learned vif IP are forwarded back to the encoder. Pure.
 */
export function decideIfacePacket(
    buf: Uint8Array,
    vifIp: string | null,
): IfaceDecision {
    if (!vifIp) return { action: "drop", reason: "no vif learned" };
    const dst = ipDST(buf);
    if (dst === null) return { action: "drop", reason: "not IPv4" };
    if (dst !== vifIp) return { action: "drop", reason: "not for vif" };
    return { action: "forward", packet: buf };
}

// --- The relay ----------------------------------------------------------------

/**
 * Construct a transparent L3 relay. Cheap: validates input and resolves the
 * interface address. Sockets are created in `start()`.
 */
export async function createUdpRelay(opts: UdpRelayOptions): Promise<UdpRelay> {
    if (process.platform !== "linux")
        throw new Error(
            `@irlctrl/udp-relay requires Linux (running on ${process.platform})`,
        );
    if (!InterfaceRe.test(opts.interfaceName))
        throw new Error(`bad interfaceName ${JSON.stringify(opts.interfaceName)}`);
    if (
        !Number.isInteger(opts.listenPort) ||
        opts.listenPort < 1 ||
        opts.listenPort > 65535
    )
        throw new Error(`listenPort ${opts.listenPort} out of range`);
    const interfaceAddress = resolveInterfaceAddress(
        opts.interfaceName,
        opts.interfaceAddress,
    );
    return new RelayImpl(opts, interfaceAddress);
}

class RelayImpl implements UdpRelay {
    // NOTE: backing field is `_stats`, not `stats` — an own property named
    // `stats` would shadow the `stats()` method (see the same note in vif).
    private _stats: RelayStats;
    private vifSocket: UdpSocket | null = null;
    private iface: IfaceRawSocket | null = null;
    private encoderAddr: { host: string; port: number } | null = null;
    private vifIp: string | null = null;
    private readTask: Promise<void> | null = null;
    private running = false;
    // NAT-mode flow table: outbound 5-tuple keys of NATed packets, so the
    // return path de-SNATs only genuine replies (not ordinary traffic to this
    // relay's own IP). Bounded; expired entries are dropped opportunistically.
    private natFlows = new Map<string, number>();

    constructor(
        private opts: UdpRelayOptions,
        readonly interfaceAddress: string,
    ) {
        this._stats = newRelayStats();
    }

    get interfaceName(): string {
        return this.opts.interfaceName;
    }
    get listenPort(): number {
        return this.opts.listenPort;
    }
    isRunning(): boolean {
        return this.running;
    }
    stats(): RelayStats {
        return { ...this._stats };
    }

    async start(): Promise<void> {
        if (this.running) return;
        this.vifIp = null;
        this.encoderAddr = null;

        // 1. Raw interface socket (SO_BINDTODEVICE) — root / CAP_NET_ADMIN.
        this.iface = this.opts.ifaceSocket ?? openIfaceRawSocket(this.interfaceName);

        // 2. UDP socket to the encoder, bound to the interface address.
        type DataFn = (
            s: UdpSocket,
            buf: Uint8Array,
            port: number,
            addr: string,
        ) => void;
        const BunUdp: typeof Bun.udpSocket = Bun.udpSocket;
        this.vifSocket = (await BunUdp({
            hostname: this.interfaceAddress,
            port: this.listenPort,
            binaryType: "uint8array",
            socket: {
                data: ((s: any, buf: Uint8Array, port: number, addr: string) =>
                    this.onEncoderData(buf, port, addr)) as DataFn,
                // Native network errors (e.g. an ICMP port-unreachable surfacing
                // via the UDP errqueue as ECONNREFUSED) are thrown from the
                // socket, not delivered as data. Without a handler they become
                // uncaught and kill the process. Consume + log: the relay keeps
                // serving subsequent frames.
                error: (err: unknown) =>
                    noteError(
                        this._stats,
                        `vif socket: ${
                            err instanceof Error ? err.message : String(err)
                        }`,
                    ),
            },
        } as unknown as Parameters<typeof BunUdp>[0])) as unknown as UdpSocket;

        this._stats.startedAt = Date.now();
        this.running = true;

        // 3. Read loop: interface packets → (vif-addressed only) → encoder.
        this.readTask = this.readIfaceLoop();

        this.opts.onStats?.(this.stats());
    }

    async stop(): Promise<void> {
        if (!this.running) return;
        this.running = false;
        this.vifIp = null;
        this.encoderAddr = null;
        try {
            this.vifSocket?.close();
        } catch {
            // best effort
        }
        try {
            this.iface?.close();
        } catch {
            // best effort
        }
        this.vifSocket = null;
        this.iface = null;
        this.readTask = null;
        this.opts.onStats?.(this.stats());
    }

    /** Continuous read on the raw interface socket. */
    private async readIfaceLoop(): Promise<void> {
        const iface = this.iface;
        if (!iface) return;
        try {
            for await (const chunk of iface.readStream()) {
                if (!this.running) break;
                this.onIfacePacket(chunk);
            }
        } catch (e) {
            if (this.running) {
                noteError(
                    this._stats,
                    `iface read: ${e instanceof Error ? e.message : String(e)}`,
                );
                this.opts.onStats?.(this.stats());
            }
        }
    }

    /** Encoder → interface: learn the vif, forward the whole IP packet. */
    private onEncoderData(buf: Uint8Array, port: number, addr: string): void {
        this._stats.lastEncoderSeen = Date.now();
        this.encoderAddr = { host: addr, port };
        const d = decideEncoderFrame(buf);
        if (d.action === "drop") {
            this._stats.drops++;
            return;
        }
        if (d.action === "liveness") return;
        // Learn / refresh which vif this relay bridges; notify only on change
        // so the caller can install a route (reply-path egress) once.
        if (this.vifIp !== d.vifIp) {
            this.vifIp = d.vifIp;
            this.opts.onVifLearned?.(d.vifIp);
        }
        this._stats.encRxPackets++;
        this._stats.encRxBytes += buf.length;
        const iface = this.iface;
        if (!iface) {
            this._stats.drops++;
            return;
        }
        // NAT mode: SNAT source (vif private IP) → this relay's own IP so a
        // *remote* destination can reach us and reply to our address.
        const outbound = this.maybeNatOutbound(d.packet);
        try {
            // The raw socket routes from the packet's own destination field
            // (the post-NAT destination, i.e. the real remote host).
            iface.send(outbound, ipDST(outbound) ?? "255.255.255.255");
            this._stats.ifaceTxPackets++;
            this._stats.ifaceTxBytes += outbound.length;
        } catch (e) {
            noteError(
                this._stats,
                `iface send: ${e instanceof Error ? e.message : String(e)}`,
            );
            this.opts.onStats?.(this.stats());
        }
    }

    /** Interface → encoder: forward packets for the vif (de-SNATed in NAT mode). */
    private onIfacePacket(buf: Uint8Array): void {
        this._stats.ifaceRxPackets++;
        this._stats.ifaceRxBytes += buf.length;
        const vif = this.vifIp;
        if (!vif) return;
        // NAT mode: replies return addressed to *this relay's* IP, so the
        // transparent "only forward packets for the vif" rule would drop them.
        // Decide with the NAT flow table instead and de-SNAT the destination.
        const packet = this.opts.nat && this.interfaceAddress
            ? this.decideNatReply(buf, vif)
            : (() => {
                const d = decideIfacePacket(buf, vif);
                return d.action === "drop" ? null : d.packet;
            })();
        if (!packet) {
            this._stats.drops++;
            return;
        }
        const encoder = this.encoderAddr;
        const vifSocket = this.vifSocket;
        if (!encoder || !vifSocket) return;
        const frame = encodeDataFrame(packet, vif);
        vifSocket.send(frame, encoder.port, encoder.host);
        this._stats.encTxPackets++;
        this._stats.encTxBytes += frame.length;
    }

    /**
     * NAT-mode inbound decision. Forwards (de-SNATed to the vif) a reply that
     * is addressed to this relay's own IP and matches a NATed outbound flow;
     * also forwards packets already addressed to the vif as-is. Returns null
     * for anything else, so we never hijack ordinary traffic to the relay IP.
     */
    private decideNatReply(buf: Uint8Array, vif: string): Uint8Array | null {
        const p = parseUdpPacket(buf);
        if (!p) return null;
        if (p.dstIp === vif) return buf; // already addressed to the vif.
        if (p.dstIp !== this.interfaceAddress) return null; // not for us.
        if (!this.natMatchFlow(p.protocol, vif, p.dstPort, p.srcIp, p.srcPort)) {
            return null; // not a reply to a NATed flow — don't hijack.
        }
        return natPacketDestination(buf, vif);
    }

    /**
     * Outbound SNAT (NAT mode only). For a UDP/IP packet with a known vif
     * source, rewrite the source to this relay's own IP and record the flow
     * for the return path. Non-UDP/non-IP packets and anything not matching
     * the vif pass through untouched (the bridge's job is SRT-over-UDP).
     */
    private maybeNatOutbound(packet: Uint8Array): Uint8Array {
        if (!this.opts.nat || !this.interfaceAddress) return packet;
        const p = parseUdpPacket(packet);
        if (!p) return packet; // not UDP/IP — leave for the bridge as-is.
        if (p.srcIp !== this.vifIp) return packet;
        // natPacketSource returns a new buffer (it does not mutate the input).
        const out = natPacketSource(packet, this.interfaceAddress);
        if (out) this.natRecordFlow(p.protocol, p.srcIp, p.srcPort, p.dstIp, p.dstPort);
        return out ?? packet;
    }

    private natKey(
        proto: number,
        a: string,
        ap: number,
        b: string,
        bp: number,
    ): string {
        return `${proto}|${a}:${ap}>${b}:${bp}`;
    }

    private natRecordFlow(
        proto: number,
        src: string,
        sp: number,
        dst: string,
        dp: number,
    ): void {
        const now = Date.now();
        // Opportunistic GC of flows idle > 30s.
        if (this.natFlows.size > 256) {
            for (const [k, t] of this.natFlows) {
                if (now - t > 30_000) this.natFlows.delete(k);
            }
        }
        this.natFlows.set(this.natKey(proto, src, sp, dst, dp), now);
    }

    private natMatchFlow(
        proto: number,
        vif: string,
        replyDstPort: number,
        replySrc: string,
        replySrcPort: number,
    ): boolean {
        // Reverse of the outbound flow: vif:replyDstPort <--> replySrc:replySrcPort
        return this.natFlows.has(
            this.natKey(proto, vif, replyDstPort, replySrc, replySrcPort),
        );
    }
}
