# @irlctrl/udp-relay

A transport primitive for irlctrl: move UDP payloads between a Linux **TUN**
device on one host and a bound **UDP socket** on another. It knows nothing
about SRTLA, Moblink, authentication, or configuration.

Two sides, one wire protocol:

| Side                 | Factory                   | Creates                                  |
| -------------------- | ------------------------- | ---------------------------------------- |
| Encoder (streamer)   | `createVirtualInterface`  | TUN + relay-facing UDP socket            |
| Relay box            | `createUdpRelay`          | Two UDP sockets bound to an interface IP |

## Wire protocol (big-endian)

- **Data frame** `0x01` + flags (1B) + reserved (2B) + payload.
  Flags/reserved are 0 on send, ignored on receive.
- **Keepalive frame** `0x02` + timestamp (8B).
- Max data payload = `mtu - 28` (default mtu 1400 → 1372 B). Oversized
  packets are dropped and counted.

There are **no IPs or ports in the frame** — flow state is out-of-band
(one TUN = one flow, tracked as `lastFlow`).

## API

```ts
import {
    createVirtualInterface,
    createUdpRelay,
    listInterfaces,
    // low-level: protocol, ip, tun-linux
} from "@irlctrl/udp-relay";

// Encoder side — creates a TUN, bridges it to the relay.
const vif = await createVirtualInterface({
    name: "moblink0",        // 1..15 chars
    localIp: "10.3.3.1",
    prefixLength: 24,
    relay: { host, port },   // the relay box's listen socket
    bindAddress?,            // default localIp (never 0.0.0.0)
    mtu?,                    // default 1400
    keepaliveIntervalMs?,    // default 5000
    onStats?,
    // tunDevice?,  // test seam: inject makeMockTunDevice().device
});
await vif.start();
// ... srtla_send targets 10.3.3.1 ...
await vif.stop(); // idempotent: close fd → ip link del → close socket

// Relay side — no TUN, just two sockets bound to the interface IP.
const relay = await createUdpRelay({
    interfaceName,
    listenPort,
    destination: { host, port }, // the shared srtla_rec
    interfaceAddress?,  // override resolved interface IP
    onStats?,
});
await relay.start();
await relay.stop();
```

`Factory throws only on obviously invalid input` (bad name, bad CIDR, port
out of range). Runtime failures (TUN open, socket bind) surface from
`start()`.

## Non-blocking TUN reads

`Bun.file(fd).stream()` — a TUN fd is a character device that never signals
EOF, so the stream emits one chunk per packet for the device's lifetime. With
`IFF_NO_PI`, each chunk is exactly one IPv4 packet (no 4-byte packet-info
prefix). The fd is opened with `node:fs.openSync`; the `ioctl(TUNSETIFF)` is
loaded from libc via FFI on first use and guarded so a build without the FFI
type API fails with a clear message from `start()`.

## Platform

Linux only. The factory throws on other platforms (unit tests can inject a
mock `tunDevice` to run the packet logic anywhere).

## Testing

```sh
bun test shared/lib/udp-relay/test
```

- `protocol.test.ts` / `ip.test.ts` — byte-exact framing & checksums.
- `relay.test.ts` — pure decisions + loopback round trip.
- `virtual-interface.test.ts` — packet logic via the mock TUN seam.
- `tun-linux.test.ts` — struct layout, no root required.
- `integration.test.ts` — full pipe on loopback + a real-TUN test gated by
  `IRLCTRL_TEST_NET_ADMIN=1` (needs root + NET_ADMIN).

## Pitfalls (from 100-moblink.md §12)

- **Never bind `0.0.0.0`** — packets leak out the default route.
- **`IFF_NO_PI` is mandatory** — without it the kernel prepends 4 bytes and
  every parse is garbage.
- `ip link del` while the fd is open is fine (Linux removes the interface on
  the last close); the library closes the fd first.
- Both sockets must not share a port (encoder `listenPort`, outbound `0`).
- There is no WebSocket Moblink relay protocol — UDP only.
