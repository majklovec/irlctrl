/*
 * @irlctrl/gretap-relay — transport primitive public API.
 *
 * Kernel GRETAP (L2-over-GRE) tunnel replacing the legacy `@irlctrl/udp-relay`
 * userspace TUN + UDP transport. Same public surface, so callers compile
 * unchanged: `createVirtualInterface` now brings up the tunnel + bridge;
 * `createUdpRelay` is a no-op (the kernel owns the data path).
 */
import { networkInterfaces } from "node:os";

// --- Core factories ---------------------------------------------------------
export {
    createVirtualInterface,
} from "./virtual_interface";
export type {
    VirtualInterface,
    VirtualInterfaceOptions,
} from "./virtual_interface";
export {
    createUdpRelay,
} from "./relay";
export type {
    UdpRelay,
    UdpRelayOptions,
} from "./relay";

// --- Low-level: gretap topology / `ip` --------------------------------------
export {
    runIp,
    ipRunner,
    setIpRunner,
    resolveInterfaceAddress,
    egressIface,
    greKeyForEndpoints,
    gretapSetupCommands,
    gretapTeardownCommands,
    setUpGretap,
    removeGretap,
    readIfaceStats,
    listGretapInterfaces,
    ifaceWithAddress,
    DEFAULT_GRETAP_MTU,
    IFACE_NAME_RE,
} from "./gretap";

// --- Low-level: test seam (mock raw socket) ---------------------------------
export { makeMockIfaceRawSocket } from "./net_linux";
export type {
    IfaceRawSocket,
    OpenIfaceRawSocketOptions,
} from "./net_linux";

// --- Wire framing (legacy compat) -------------------------------------------
export {
    decodeFrame,
    encodeDataFrame,
    encodeKeepaliveFrame,
    maxPayload,
    GRETAP_OVERHEAD,
    DATA_FRAME_TYPE,
    KEEPALIVE_FRAME_TYPE,
    DATA_HEADER_LEN,
} from "./protocol";
export type { DecodedFrame } from "./frame_types";

// --- IPv4 / UDP helpers (legacy compat) -------------------------------------
export {
    buildUdpIpPacket,
    internetChecksum,
    ipToBytes,
    bytesToIp,
    ipDST,
    parseUdpPacket,
    udpChecksum,
    isValid,
    natPacketSource,
    natPacketDestination,
} from "./ip";
export type {
    BuildUdpIpPacketOptions,
    ParsedUdpPacket,
} from "./ip";

// --- Types ------------------------------------------------------------------
export type {
    Endpoint,
    InterfaceInfo,
    Stats,
    RelayStats,
    VifStats,
} from "./types";

/**
 * List the machine's network interfaces with their IPv4 addresses (unchanged
 * from the legacy library — diagnostics / tests use this).
 */
export function listInterfaces(): Array<{
    name: string;
    addresses: string[];
}> {
    const out: Array<{ name: string; addresses: string[] }> = [];
    for (const [name, addrs] of Object.entries(networkInterfaces())) {
        const ipv4 = (addrs ?? []).filter((a) => a.family === "IPv4")
            .map((a) => a.address);
        if (name) out.push({ name, addresses: [...ipv4].sort() });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * List the GRETAP tunnel interfaces present on this host
 * (`ip -o link show type gretap`).
 */
export { listGretapInterfaces as listGretap } from "./gretap";
