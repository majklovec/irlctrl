/* @irlctrl/udp-relay — transport primitive public API (grows as modules land). */
import { networkInterfaces } from "node:os";
export {
    buildUdpIpPacket,
    internetChecksum,
    ipToBytes,
    bytesToIp,
    ipDST,
    parseUdpPacket,
    udpChecksum,
} from "./ip";
export type {
    BuildUdpIpPacketOptions,
    ParsedUdpPacket,
} from "./ip";
export {
    decodeFrame,
    encodeDataFrame,
    encodeKeepaliveFrame,
    DATA_FRAME_TYPE,
    KEEPALIVE_FRAME_TYPE,
    DATA_HEADER_LEN,
} from "./protocol";
export type { DecodedFrame } from "./frame_types";
export {
    createUdpRelay,
    resolveInterfaceAddress,
    decideEncoderFrame,
    decideIfacePacket,
} from "./relay";
export type {
    UdpRelay,
    UdpRelayOptions,
    EncoderDecision,
    IfaceDecision,
} from "./relay";
export {
    openIfaceRawSocket,
    makeMockIfaceRawSocket,
} from "./net_linux";
export type { IfaceRawSocket, OpenIfaceRawSocketOptions } from "./net_linux";
export {
    createVirtualInterface,
    makeMockTunDevice,
} from "./virtual_interface";
export type {
    VirtualInterface,
    VirtualInterfaceOptions,
} from "./virtual_interface";
export {
    openTun,
    configureTun,
    deleteTun,
    IFF_TUN,
    IFF_NO_PI,
    TUNSETIFF,
} from "./tun_linux";
export type { TunDevice } from "./tun_linux";
/**
 * List the machine's network interfaces with their IPv4 addresses. Library
 * tests use this; production callers use the `network` module's capability.
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
export type {
    Endpoint,
    InterfaceInfo,
    RelayStats,
    VifStats,
} from "./types";
