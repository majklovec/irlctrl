/* The tunnel side (both boxes): a kernel GRETAP tunnel bridged into the
 * local LAN.
 *
 * Replaces the legacy `@irlctrl/udp-relay` virtual interface: where one side
 * used to open a TUN and pump framed IP packets over UDP to a relay process,
 * each side now asks the kernel for a GRETAP device (`gretap<name>`), a
 * bridge (`br-<name>`) and attaches both the tunnel and the local LAN NIC to
 * it. All forwarding is in-kernel; this module only manages the topology and
 * reports the kernel's counters.
 *
 * The public surface (`createVirtualInterface` + `VirtualInterface`) matches
 * the legacy API so callers compile unchanged. Options the kernel supersedes
 * (`bindAddress`, `keepaliveIntervalMs`, `tunDevice`, `relay.port`) are
 * accepted and ignored.
 */
import { IFACE_NAME_RE, readIfaceStats, removeGretap, setUpGretap } from "./gretap";
import { noteError, newVifStats } from "./stats";
import type { Endpoint, VifStats } from "./types";

export interface VirtualInterfaceOptions {
    /** Tunnel device suffix, 1..15 chars (the kernel iface limit). */
    name: string;
    /**
     * The IPv4 address of this box's WDS-facing (tunnel-peer) interface —
     * used to find the LAN NIC to bridge in. Must be the IP on the link to
     * the peer, not the LAN IP the bridge will extend.
     */
    localIp: string;
    /** Prefix length (accepted for API compatibility; not applied). */
    prefixLength: number;
    /**
     * The peer box: `host` is its WDS-link IP (the GRETAP remote); `port`
     * is legacy and ignored (GRETAP is portless).
     */
    relay: Endpoint;
    /** Legacy: ignored (there is no userspace socket to bind). */
    bindAddress?: string;
    /**
     * GRE key shared by both tunnel ends (keyed demux: outer addresses are
     * ignored by the kernel, so the tunnel works across asymmetric subnets).
     * Derive it with `greKeyForEndpoints(peerIp, localIp)`. Default: none.
     */
    greKey?: number;
    /** Tunnel MTU (default 1500). */
    mtu?: number;
    /** Legacy: ignored (GRE keepalives are kernel-side). */
    keepaliveIntervalMs?: number;
    onStats?: (s: VifStats) => void;
    /**
     * The LAN NIC to bridge into `br-<name>` (default: auto-detected as the
     * interface holding `localIp`).
     */
    localIface?: string;
    /**
     * Legacy test seam: ignored. GRETAP is managed through `ip` — unit tests
     * inject a fake `ip` runner via `setIpRunner()` instead.
     */
    tunDevice?: unknown;
}

export interface VirtualInterface {
    readonly name: string;
    readonly localIp: string;
    /**
     * Legacy field: the old relay-facing UDP socket's bound address. GRETAP
     * has no userspace socket — always `null` (callers must not depend on it).
     */
    readonly socketAddress: { host: string; port: number } | null;
    start(): Promise<void>;
    stop(): Promise<void>;
    stats(): VifStats;
    isRunning(): boolean;
}

const DEFAULT_MTU = 1500;

/**
 * Construct a tunnel handle. Cheap: validates input only. Runtime failures
 * (`ip` calls, missing privileges) surface from `start()`.
 */
export async function createVirtualInterface(
    opts: VirtualInterfaceOptions,
): Promise<VirtualInterface> {
    if (process.platform !== "linux")
        throw new Error(
            `@irlctrl/gretap-relay requires Linux (running on ${
                process.platform
            })`,
        );
    if (!IFACE_NAME_RE.test(opts.name))
        throw new Error(
            `name ${JSON.stringify(opts.name)} is not a valid interface name`,
        );
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(opts.localIp))
        throw new Error(`localIp ${JSON.stringify(opts.localIp)} is not IPv4`);
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(opts.relay.host))
        throw new Error(
            `relay.host ${JSON.stringify(
                opts.relay.host,
            )} must be the peer's WDS-link IPv4 address`,
        );
    if (
        !Number.isInteger(opts.prefixLength) ||
        opts.prefixLength < 8 ||
        opts.prefixLength > 32
    )
        throw new Error(`prefixLength ${opts.prefixLength} out of [8,32]`);
    const mtu = opts.mtu ?? DEFAULT_MTU;
    if (!Number.isInteger(mtu) || mtu < 68 || mtu > 65535)
        throw new Error(`mtu ${mtu} out of [68,65535]`);
    return new VifImpl(opts, mtu);
}

class VifImpl implements VirtualInterface {
    readonly name: string;
    readonly localIp: string;
    readonly socketAddress: { host: string; port: number } | null = null;
    private running = false;
    private _stats: VifStats = newVifStats();

    constructor(
        private opts: VirtualInterfaceOptions,
        private mtu: number,
    ) {
        this.name = `gretap${opts.name}`;
        this.localIp = opts.localIp;
    }

    async start(): Promise<void> {
        if (this.running) return;
        try {
            await setUpGretap({
                name: this.opts.name,
                peerIp: this.opts.relay.host,
                localIp: this.localIp,
                localIface: this.opts.localIface,
                mtu: this.mtu,
                greKey: this.opts.greKey,
            });
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            noteError(this._stats, message);
            throw new Error(
                `gretap ${this.name} start failed: ${message}`,
            );
        }
        this.running = true;
        this._stats.startedAt = Date.now();
        this._stats.lastError = undefined;
        this.emitStats();
    }

    async stop(): Promise<void> {
        if (!this.running) return;
        this.running = false;
        try {
            await removeGretap(this.opts.name);
        } catch (e) {
            noteError(
                this._stats,
                `teardown: ${e instanceof Error ? e.message : String(e)}`,
            );
        }
        this.emitStats();
    }

    isRunning(): boolean {
        return this.running;
    }

    stats(): VifStats {
        if (this.running) this.refreshStats();
        return { ...this._stats };
    }

    private refreshStats(): void {
        try {
            const s = readIfaceStats(this.name);
            this._stats = {
                ...this._stats,
                txPackets: s.txPackets,
                txBytes: s.txBytes,
                rxPackets: s.rxPackets,
                rxBytes: s.rxBytes,
                drops: s.drops,
            };
        } catch {
            // Counters are best-effort; keep the last reading.
        }
    }

    private emitStats(): void {
        this.opts.onStats?.(this.stats());
    }
}
