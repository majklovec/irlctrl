# Handoff Document: Moblink Support for `irlctrl`

**Target repository:** https://github.com/majklovec/irlctrl
**Reference implementations:**

-   `moblink-rust` — https://github.com/datagutt/moblink-rust (auth + WebSocket protocol)
-   Moblin iOS app — https://github.com/eerimoq/moblin (original concept)

**This document covers three deliverables:**

| #     | Deliverable                  | Type             | Location                           |
| ----- | ---------------------------- | ---------------- | ---------------------------------- |
| **A** | `@irlctrl/udp-relay` library | Shared primitive | `shared/lib/udp-relay/`            |
| **B** | `moblink-relay` role         | Role + module    | `client/modules/moblink-relay/`    |
| **C** | `moblink-streamer` module    | Module           | `client/modules/moblink-streamer/` |

The library (A) is the transport primitive. The modules (B, C) build on it and own all config, UI, supervision, auth (if applicable), and integration with the rest of `irlctrl`.

---

## 1. Goal

Extend an encoder's SRTLA bond with the uplinks of a separate relay box — **without** the relay box needing a public IP or creating duplicate streams.

```
[ ENCODER (role: encoder) ]
   │
   ├─ srtla_send  ──▶  TUN (10.3.3.1)  ──▶  moblink-streamer module
   │                                              │
   │                                              │ (UDP tunnel via @irlctrl/udp-relay)
   │                                              ▼
[ RELAY BOX (role: moblink-relay) ]
   │
   ├─ Relay on eth0 ──▶  srtla_rec (public IP:5000)
   ├─ Relay on usb0 ──▶  srtla_rec
   └─ Relay on usb1 ──▶  srtla_rec
```

The encoder sees extra "uplinks" in its SRTLA bond. The relay box makes them physically traverse its own interfaces. Neither side terminates SRTLA — the connection to `srtla_rec` stays transparent.

---

## 2. Critical Design Decisions (read first)

These override any older specs, CLI flags in `moblink-rust`, or hints in the source material.

### 2.1 No CLI flags

**Only** `--role` selects behaviour. Everything else — password, streamer URL(s), interface allow/ignore regexes, TUN network, destination address/port, paths — lives in the standard config store (`ctx.state` / `ctx.saveState`) and is edited in the Settings UI.

```bash
# Correct
bun client/backend/client.ts --role moblink-relay
bun client/backend/client.ts --role encoder

# WRONG — do not add these
--moblink-password ...
--moblink-streamer-url ...
--moblink-database ...
```

### 2.2 No separate database file

Relay identity (`interfaceName → UUID`) lives inside `ctx.state.moblink.relayIds`. **Do not** create `moblink-relay-service.json` or any equivalent. One config store, one source of truth.

### 2.3 Automatic uplink registration

Do **not** make the user hand-edit the uplinks file. When `moblink-streamer` brings a TUN up, it **automatically registers** the TUN IP as an uplink via the `network` module's capability. On stop, it removes it. See §7.2 and §8.3.

### 2.4 The library is the transport; the modules are the features

`@irlctrl/udp-relay` (deliverable A) knows nothing about SRTLA, Moblink, auth, discovery, or config. It moves UDP payloads between a TUN on one host and a bound UDP socket on another. Deliverables B and C are the features that use it.

Do **not** add Moblink protocol messages, auth, or discovery to the library. Do **not** import the library from `moblink-relay`'s CLI parsing. The library is a primitive.

### 2.5 Transport mode

The modules use the **UDP transport** provided by `@irlctrl/udp-relay`. Do **not** implement the WebSocket-based Moblink relay protocol (challenge–response, `Hello`/`Identify`/`startTunnel`) in v1 — it belongs to a future transport mode and is out of scope for this document. If you find yourself porting `moblink-rust/src/protocol.rs`, stop: that code is **not** part of this task.

---

## 3. Repository Orientation (read before coding)

| File                                 | Why                                                                                                          |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `client/backend/module_core.ts`      | Services bag: `ctx.state`, `ctx.saveState`, `ctx.logEvent`, `ctx.supervisor`, `ctx.run`, `ctx.capabilities`. |
| `shared/contracts/backend_module.ts` | The module contract.                                                                                         |
| `client/modules/relay/backend.ts`    | Canonical example of a module with long-running processes, RPC, status.                                      |
| `client/modules/network/backend.ts`  | Interface enumeration + uplinks capability (to be extended per §7.2).                                        |
| `shared/registry.ts`                 | Module + role discovery — new modules auto-register from `client/modules/<name>/`.                           |
| `client/modules/README.md`           | Dashboard / settings / i18n conventions.                                                                     |

**Role vs module:** role = entrypoint selector (`--role`), module = discoverable unit under `client/modules/`, with `backend.ts`, `frontend.tsx`, `settings.tsx`, `types.ts`, optional `styles.css`.

---

## 4. Deliverable A — `@irlctrl/udp-relay` Library

### 4.1 Purpose

Two primitives for tunnelling UDP across a network hop:

| Primitive                  | Side      | What it does                                                                                                                                                                         |
| -------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `createVirtualInterface()` | Encoder   | Creates a Linux **TUN** device. Reads IP/UDP packets from the TUN, strips headers, sends the UDP payloads to the relay via a UDP socket. Rebuilds IP/UDP headers for return traffic. |
| `createUdpRelay()`         | Relay box | Binds a UDP socket to a **specific interface IP**, forwards received UDP payloads to a configured destination, forwards responses back to the sender.                                |

Together: encoder's TUN ↔ encoder's UDP socket ↔ wire ↔ relay's UDP socket ↔ relay's physical interface.

The library is **protocol-agnostic** (moves payloads, no SRTLA), **auth-agnostic** (no handshake, no password — module handles auth separately), **discovery-agnostic** (caller supplies endpoints).

### 4.2 Package layout

```
shared/lib/udp-relay/
├── package.json                 # { "name": "@irlctrl/udp-relay" }
├── tsconfig.json                # extends repo root
├── src/
│   ├── index.ts                 # public exports
│   ├── types.ts                 # shared types
│   ├── protocol.ts              # wire framing (encode/decode)
│   ├── ip.ts                    # IPv4/UDP header parse & build
│   ├── tun-linux.ts             # TUN open/close/read/write
│   ├── relay.ts                 # createUdpRelay
│   ├── virtual-interface.ts     # createVirtualInterface
│   └── stats.ts                 # counters
└── test/
    ├── protocol.test.ts
    ├── ip.test.ts
    ├── relay.test.ts
    ├── virtual-interface.test.ts
    └── integration.test.ts      # gated by IRLCTRL_TEST_NET_ADMIN=1
```

No new runtime dependencies. No CLI binary. Bun-only files marked `// @bun-only`.

### 4.3 Public API

#### Encoder side

```ts
import { createVirtualInterface } from "@irlctrl/udp-relay";

const vif = await createVirtualInterface({
    name: "moblink0", // <= 15 chars
    localIp: "10.3.3.1",
    prefixLength: 24,
    relay: { host: "192.168.1.50", port: 5000 },
    bindAddress: "0.0.0.0", // optional, default "0.0.0.0"
    mtu: 1400, // optional, default 1400
    keepaliveIntervalMs: 5000, // optional, default 5000
    onStats: (s) => {
        /* ... */
    }, // optional
});

await vif.start();
// srtla_send now targets 10.3.3.1:5000
await vif.stop(); // idempotent

interface VirtualInterface {
    readonly name: string;
    readonly localIp: string;
    start(): Promise<void>;
    stop(): Promise<void>;
    stats(): VifStats;
    isRunning(): boolean;
}

interface VifStats {
    txPackets: number;
    txBytes: number;
    rxPackets: number;
    rxBytes: number;
    txDropped: number;
    rxDropped: number;
    lastError?: { at: number; message: string };
    startedAt?: number;
}
```

#### Relay side

```ts
import { createUdpRelay } from "@irlctrl/udp-relay";

const relay = await createUdpRelay({
    interfaceName: "eth0",
    listenPort: 5000,
    destination: { host: "203.0.113.10", port: 5000 },
    socketBufferSize: 4 * 1024 * 1024, // optional
    onStats: (s) => {
        /* ... */
    },
});

await relay.start();
await relay.stop();

interface UdpRelay {
    readonly interfaceName: string;
    readonly interfaceAddress: string;
    readonly listenPort: number;
    start(): Promise<void>;
    stop(): Promise<void>;
    stats(): RelayStats;
    isRunning(): boolean;
}

interface RelayStats {
    encRxPackets: number;
    encRxBytes: number;
    dstTxPackets: number;
    dstTxBytes: number;
    dstRxPackets: number;
    dstRxBytes: number;
    encTxPackets: number;
    encTxBytes: number;
    drops: number;
    lastError?: { at: number; message: string };
    lastEncoderSeen?: number;
    startedAt?: number;
}
```

#### Utility

```ts
export function listInterfaces(): Array<{ name: string; addresses: string[] }>;
```

Only for the library's own tests; production callers use the `network` module's capability.

**Construction vs start:** factories throw only on obviously invalid input (bad CIDR, name too long, port out of range). Runtime failures (bind, TUN open) surface from `start()`.

**Platform:** `process.platform !== "linux"` → throw immediately in the factory with a clear message.

### 4.4 Wire protocol

UDP datagrams between the two sides. Big-endian. Two message types.

**Data frame (type `0x01`):**

```
+------+-------+---------------+-----------------------------+
| 0x01 | flags | reserved (2B) | udp_payload (variable)      |
+------+-------+---------------+-----------------------------+
```

-   `flags`/`reserved` MUST be 0 on send, MUST be ignored on receive.
-   No IPs or ports in the frame — flow state is out-of-band (§4.6, §4.7).

**Keepalive frame (type `0x02`):**

```
+------+----------------------------+
| 0x02 | timestamp_ms (8B, big-end) |
+------+----------------------------+
```

**Size:** header 4 B; max payload = `mtu - 28` (IPv4 + UDP headers). Oversized payloads dropped and counted.

### 4.5 Encoder side — TUN lifecycle

1. Open `/dev/net/tun` with `O_RDWR`.
2. `ioctl(TUNSETIFF)` with `IFF_TUN | IFF_NO_PI` and padded name. Capture the actual assigned name.
3. Assign IP and bring up — prefer netlink; shelling out to `ip addr add` + `ip link set up` is acceptable for v1 (marked `TODO: netlink`).
4. Store fd, start read loop.
5. **`stop()`:** close fd (Linux removes the interface), then best-effort `ip link del`. Close UDP socket. Idempotent.

**`IFF_NO_PI` is mandatory** — without it the kernel prepends 4 bytes to every packet and the parser corrupts everything.

### 4.6 Encoder side — read loop and flow tracking

Each `read(fd, buf)` returns one complete IPv4 packet.

1. Parse IPv4 header. Reject non-IPv4.
2. **Reject non-UDP** (`protocol != 17`) — count `txDropped`. This is a UDP relay, not a general IP tunnel.
3. Read `ihl`, skip IP header, parse UDP header, extract `payload`.
4. Validate size ≤ `mtu - 28`. Drop otherwise.
5. Record flow: `lastFlow = { srcIp, srcPort, dstIp, dstPort, updatedAt }`.
6. Encode data frame, `udpSocket.send(frame, relay.host, relay.port)`.
7. Counters.

**Inbound:** decode frame, construct an IP packet with swapped `lastFlow` addresses (src = original dst, dst = original src) via `buildUdpIpPacket()`, `write(fd, ...)`. If `lastFlow === null`, drop and count `rxDropped`.

**Single-flow assumption:** one TUN = one flow. Documented. Moblink uses one TUN per relay; SRTLA uses one sender socket per path. If a future need arises, add conntrack keyed by 5-tuple.

**UDP socket:** `Bun.udpSocket({ hostname: bindAddress, port: 0 })`. `connect()` if available, else `send(payload, host, port)` per packet. Drop packets from unexpected `remote`. `close()` on stop.

**Non-blocking read:** `read(2)` must not block Bun's event loop. Use a worker thread, `Bun.file(fd).stream()`, or `O_NONBLOCK` + poll. Document the chosen approach in `tun-linux.ts`.

### 4.7 Relay side — two sockets, two directions

The relay does **not** create a TUN. It forwards raw UDP payloads.

1. Resolve `interfaceName → IPv4` via `os.networkInterfaces()`. Allow explicit `interfaceAddress` override.
2. **`encoderSocket`** = `Bun.udpSocket({ hostname: interfaceAddress, port: listenPort })` — receives from encoder, sends responses back.
3. **`outboundSocket`** = `Bun.udpSocket({ hostname: interfaceAddress, port: 0 })` — sends to `srtla_rec`, receives responses.
4. **Never bind to `0.0.0.0`.** That is the #1 bug — packets leak out the wrong interface.

**Encoder → destination:**

-   On data: decode frame, remember `encoderAddr = remote`, `outboundSocket.send(payload, destination.host, destination.port)`. Counters.

**Destination → encoder:**

-   On data: reject if `remote.host !== destination.host` (defence). Reject if `encoderAddr === null`. Encode frame, `encoderSocket.send(frame, encoderAddr.host, encoderAddr.port)`. Counters.

**Hotplug:** the library does **not** watch interfaces. The caller (module) restarts the relay when an interface's IP changes.

### 4.8 `buildUdpIpPacket(opts)` — `ip.ts`

Construct a full IPv4/UDP packet from scratch:

-   IPv4: version 4, IHL 5, TOS 0, total length, ID 0, flags 0, fragment 0, TTL 64, protocol 17, **computed checksum**, src/dst.
-   UDP: src port, dst port, length = 8 + payload, **computed checksum**.
-   Return contiguous `Uint8Array`.

**Must be unit-tested** against reference packets (e.g. generated with `scapy`, or a captured packet from `tcpdump`).

### 4.9 Security (library level)

-   **No auth on the wire.** Caller must implement policy if needed (the module can inspect `encoderAddr` from stats and enforce an allowlist — the library exposes what's needed but does not enforce).
-   **No encryption.** Documented: use WireGuard or similar for untrusted links.
-   **Root required for TUN.** Use minimum capabilities.
-   **No shell injection.** Pass `ip` args as an array; validate interface names against `^[a-zA-Z0-9_.-]{1,15}$`.
-   **Not safe for public internet exposure** without an outer tunnel. Document in README.

---

## 5. Deliverable B — Role `moblink-relay`

### 5.1 Purpose

A new role available alongside `relay | encoder | obs | broadcaster`. Runs on a multi-uplink box. It enumerates eligible interfaces, and for each starts a `createUdpRelay()` from `@irlctrl/udp-relay`, forwarding to a shared remote `srtla_rec`.

### 5.2 Module layout

```
client/modules/moblink-relay/
├── backend.ts        # supervisor, per-interface relays, RPC
├── frontend.tsx      # device card
├── settings.tsx      # settings page
├── types.ts
└── styles.css
```

Role registration: add `"moblink-relay"` to the role list in `shared/registry.ts` (or wherever `--role` is parsed). The role's module set includes at least: `network`, `moblink-relay`, plus common modules (auth, logging, web UI). **Excludes** the SRTLA bridge `relay` module — a relay box does not terminate SRTLA.

### 5.3 Backend responsibilities

1. **Enumerate interfaces** via the `network` module's capability. Apply `interfaceAllow` / `interfaceIgnore` regexes from config.
2. **Persistent relay IDs:** `ctx.state.moblink.relayIds` is a `Record<interfaceName, uuid>`. Generate on first sight, reuse thereafter.
3. **One relay per interface** using `createUdpRelay({ interfaceName, listenPort, destination })`. Track `listenPort` per interface in config (default 5000, sequential for multiples).
4. **No hotplug in the library** — the module subscribes to interface changes (via `network` module capability if available) and `stop()`s + recreates the affected relay.
5. **Runtime status file** (path from config, default `/tmp/moblink-status.json`) written on every state change. Format in §9.1.
6. **Logs** via `ctx.logEvent`.

### 5.4 Config schema (`ctx.state.moblink`)

```ts
interface MoblinkRelayConfig {
    enabled: boolean; // default false
    destination: { host: string; port: number }; // REQUIRED to start
    listenPortBase: number; // default 5000
    interfaceAllow: string[]; // regex, empty → all
    interfaceIgnore: string[]; // regex, default ["docker.*","veth.*"]
    interfaceNameOverrides: Record<string, string>; // { "eth0": "WAN" }
    runtimeStatusFile: string; // default "/tmp/moblink-status.json"
    logLevel: "trace" | "debug" | "info" | "warn" | "error"; // default "info"
}
```

No `moblink-relay-service.json`. Relay IDs live in `ctx.state.moblink.relayIds`. No password (this transport has no auth — see §4.9).

### 5.5 RPC methods

-   `moblink-relay.start`
-   `moblink-relay.stop`
-   `moblink-relay.status` → runtime status object (same shape as status file)
-   `moblink-relay.getConfig`
-   `moblink-relay.setConfig` — apply, restart affected relays

### 5.6 Frontend

-   **Device card:** relay count, per-relay row (interface name, address, destination, stats), start/stop toggle.
-   **Settings page:** destination host + port (validated as IP-or-hostname), listen-port base, allow/ignore regex (validated), name overrides, runtime status path, log level.

Follow `client/modules/relay/frontend.tsx` and `settings.tsx` patterns.

---

## 6. Deliverable C — Module `moblink-streamer`

### 6.1 Purpose

Encoder-side module. Creates a TUN interface via `createVirtualInterface()` from `@irlctrl/udp-relay`, and **auto-registers the resulting IP as an uplink** with the `network` module so `srtla_send` picks it up without user intervention.

### 6.2 Module layout

```
client/modules/moblink-streamer/
├── backend.ts        # TUN lifecycle, uplink registration, RPC
├── frontend.tsx      # device card
├── settings.tsx      # settings page
├── types.ts
└── styles.css
```

Registration:

```ts
export default defineBackendModule({
    id: "moblink-streamer",
    roles: ["encoder"], // encoder ONLY
    // ...
});
```

### 6.3 Backend responsibilities

1. **Create virtual interface** with `createVirtualInterface({ name, localIp, prefixLength, relay, ... })`.
2. **Auto-register uplink** via `network` module capability (§8.3). Immediately on start of the interface; remove on stop.
3. **Restart on relay address change:** if the config's relay endpoint changes, stop the VIF, recreate it with the new endpoint, re-register the uplink.
4. **Runtime status file** (§9.1).
5. **Teardown:** `vif.stop()`, deregister uplink, idempotent.

The module owns only one VIF in v1 (single relay endpoint). Multi-relay (one VIF per relay) is an extension — the library supports it (one `createVirtualInterface` per relay), but the module ships single-relay.

### 6.4 Config schema (`ctx.state.moblinkStreamer`)

```ts
interface MoblinkStreamerConfig {
    enabled: boolean; // default false
    interfaceName: string; // default "moblink0"
    localIp: string; // default "10.3.3.1"
    prefixLength: number; // default 24
    relay: { host: string; port: number }; // REQUIRED to start
    mtu: number; // default 1400
    keepaliveIntervalMs: number; // default 5000
    autoRegisterUplink: boolean; // default TRUE — §2.3
    runtimeStatusFile: string; // default "/tmp/moblink-status.json"
    logLevel: "trace" | "debug" | "info" | "warn" | "error"; // default "info"
}
```

### 6.5 RPC methods

-   `moblink-streamer.start`
-   `moblink-streamer.stop`
-   `moblink-streamer.status`
-   `moblink-streamer.getConfig`
-   `moblink-streamer.setConfig`

### 6.6 Frontend

-   **Device card:** TUN up/down, TUN IP, relay endpoint, packet counters, uplink-registered indicator.
-   **Settings page:** all fields from §6.4 with inline validation. Show clear error if `relay.host` is empty (module cannot start). Warn if `autoRegisterUplink` is off (manual mode).

---

## 7. Integration Points

### 7.1 Module contract

Both modules implement `shared/contracts/backend_module.ts`. Model `onStart`/`onStop`/`dispatch`/`status` on `client/modules/relay/backend.ts`.

### 7.2 Extend `network` module — uplinks capability

If `network` does **not** already expose a programmatic uplinks API, add:

```ts
// capability exposed via ctx.capabilities
interface NetworkUplinks {
    add(entry: { id: string; source: string; label?: string }): Promise<void>;
    remove(id: string): Promise<void>;
    list(): Promise<Array<{ id: string; source: string; label?: string }>>;
}
```

Wire it to the same mechanism that already produces the uplinks file. Then:

```ts
// moblink-streamer backend.ts
await ctx.capabilities.network.uplinks.add({
    id: `moblink:${vif.name}`,
    source: vif.localIp,
    label: `Moblink (${relayName ?? vif.name})`,
});
```

On stop, `remove(id)`. This is the **whole point** of §2.3 — do not skip it, and never fall back to direct file editing from the moblink module.

### 7.3 Coexistence with `relay` module

`moblink-streamer` runs **alongside** the existing SRTLA bridge. With `autoRegisterUplink: true` (default), `srtla_send` sees the extra path automatically. `autoRegisterUplink: false` exists only for debugging.

### 7.4 Config migration

Users upgrading from an older `irlctrl` have no `ctx.state.moblink*`. Initialise defaults on first read; **disabled by default**. Never crash on missing config. On start, sweep any stale `moblink:*` entries from the uplinks list before re-adding.

### 7.5 Library is a transport primitive; do not pollute it

If you find yourself adding auth, discovery, WebSocket, or Moblink messages to `shared/lib/udp-relay/`, stop. Those belong in the modules or in a future transport layer, not the library.

---

## 8. Protocol Summary

### 8.1 Wire protocol (`@irlctrl/udp-relay`)

See §4.4. Two frame types (`0x01` data, `0x02` keepalive), 4-byte header. No auth, no encryption. **This is the only protocol in scope.**

### 8.2 Moblink WebSocket protocol

**Out of scope for v1.** Do not port `moblink_rust/src/protocol.rs`, `Hello`/`Identify`/`startTunnel`, or challenge–response hashing. That is a future transport mode.

### 8.3 Uplink registration contract

The `moblink-streamer` module calls `network.uplinks.add/remove` (§7.2). Nothing else.

---

## 9. Runtime Status File (both modules)

Path configured per module; default `/tmp/moblink-status.json`. Format shared:

```json
{
    "connected": true,
    "relays": [
        {
            "interfaceName": "eth0",
            "interfaceAddress": "192.168.1.20",
            "destinationHost": "203.0.113.10",
            "destinationPort": 5000,
            "stats": {
                "encRxPackets": 12345,
                "encTxPackets": 12340,
                "lastEncoderSeen": 1731234567890
            }
        }
    ]
}
```

On the encoder side, `relays[0]` describes the single VIF:

```json
{
    "connected": true,
    "relays": [
        {
            "interfaceName": "moblink0",
            "interfaceAddress": "10.3.3.1",
            "relayHost": "192.168.1.50",
            "relayPort": 5000,
            "uplinkRegistered": true,
            "stats": { "txPackets": 12345, "rxPackets": 12300 }
        }
    ]
}
```

Written on every state change (connect, disconnect, uplink add/remove, config change). Not a config store — output only.

---

## 10. Testing Strategy

### 10.1 Library unit tests (`bun test` under `shared/lib/udp-relay/test/`)

-   **`protocol.test.ts`** — encode/decode round-trips for data + keepalive. Malformed (truncated header, unknown type) rejected, not thrown. Oversized payload rejected.
-   **`ip.test.ts`** — `buildUdpIpPacket` byte-exact against a hard-coded reference (checksum, length, addresses). Parse-then-rebuild a captured packet and assert equality.
-   **`relay.test.ts`** — with mocked `Bun.udpSocket` or real localhost sockets:
    -   encoder → destination forwarding;
    -   destination → encoder response forwarded;
    -   non-`0x01` frames dropped;
    -   responses from wrong source dropped;
    -   counters increment correctly.
-   **`virtual-interface.test.ts`** — with a mocked TUN fd:
    -   outbound IP packet → UDP payload forwarded as data frame;
    -   non-UDP packet dropped, counter increments;
    -   inbound frame → correct IP packet built with swapped addresses and written to fd;
    -   inbound before any outbound → dropped;
    -   `stop()` idempotent.
-   **`tun-linux.test.ts`** — `TUNSETIFF` struct layout and name padding vs known values. Gated by root capability.

### 10.2 Library integration test

Gated by `IRLCTRL_TEST_NET_ADMIN=1`. Creates a `dummy0` interface, one `createUdpRelay()` and one `createVirtualInterface()` on it. Sends UDP packets through the tunnel end to end and asserts arrival; checks `ip link show` after `stop()`.

### 10.3 Module tests

-   **`moblink-relay`:** interface filtering (allow/ignore), per-interface relay lifecycle (start/stop), runtime status serialization, config validation.
-   **`moblink-streamer`:** uplink add/remove called with correct args on start/stop; restart on relay endpoint change; teardown leaves no stale uplink.
-   Both modules: rollback on partial failure (one relay starts, second fails → first is stopped).

### 10.4 Manual validation

-   Two VMs on the same subnet. VM A runs `--role encoder` with `moblink-streamer` enabled and pointing at VM B. VM B runs `--role moblink-relay` with destination = an external `srtla_rec`. Start an `srtla_send` on VM A. Confirm:
    -   `srtla_send` shows the extra uplink automatically.
    -   Traffic leaves VM B through the intended physical interface (`tcpdump`).
    -   Stopping either module removes the uplink and frees all ports; `ip link show` shows no residual `moblink0`.
    -   Restart encoder without restarting relay — new flow is accepted.

---

## 11. Deliverables Checklist

### Library (`shared/lib/udp-relay/`)

-   [ ] `package.json` (`"name": "@irlctrl/udp-relay"`), `tsconfig.json`, `README.md`
-   [ ] `src/index.ts` exporting `createUdpRelay`, `createVirtualInterface`, `listInterfaces`, and all types
-   [ ] `src/protocol.ts`, `ip.ts`, `tun-linux.ts`, `relay.ts`, `virtual-interface.ts`, `stats.ts`, `types.ts`
-   [ ] Factory throws only on invalid input; runtime errors surface from `start()`
-   [ ] Platform guard: `process.platform !== "linux"` → clear throw
-   [ ] Idempotent `stop()`, no unhandled rejections, no leaked fds
-   [ ] Unit tests (§10.1) + integration test (§10.2)
-   [ ] No new runtime dependencies
-   [ ] No CLI binary; library import only
-   [ ] README documents: API, wire protocol, Linux requirements, security, integration with modules

### Role `moblink-relay`

-   [ ] `client/modules/moblink-relay/` with `backend.ts`, `frontend.tsx`, `settings.tsx`, `types.ts`, `styles.css`
-   [ ] `"moblink-relay"` added to role registry
-   [ ] Config in `ctx.state.moblink` (§5.4) — no CLI flags, no DB file
-   [ ] Relay IDs in `ctx.state.moblink.relayIds` — **not** a separate JSON file
-   [ ] Runtime status file per §9.1
-   [ ] Uses `createUdpRelay()` from `@irlctrl/udp-relay`
-   [ ] Interface list from `network` module capability (not re-implemented)
-   [ ] Tests (§10.3)

### Module `moblink-streamer`

-   [ ] `client/modules/moblink-streamer/` with the same file set
-   [ ] `roles: ["encoder"]`
-   [ ] Config in `ctx.state.moblinkStreamer` (§6.4) — no CLI flags
-   [ ] Uses `createVirtualInterface()` from `@irlctrl/udp-relay`
-   [ ] **Auto-registers uplink via `network.uplinks.add/remove`** (§7.2, §2.3)
-   [ ] Runtime status file per §9.1
-   [ ] Stale-uplink sweep on start
-   [ ] Tests (§10.3)

### Cross-cutting

-   [ ] `network` module extended with `uplinks` capability if not already present
-   [ ] `client/modules/README.md` updated with a section on `moblink-relay` and `moblink-streamer` (enable via UI; only `--role` on CLI)
-   [ ] Manual validation (§10.4) documented in the PR description

---

## 12. Pitfalls

1. **Binding UDP to `0.0.0.0` on the relay.** Packets leave through the default route. Always bind to the interface IP resolved from `interfaceName`.
2. **Blocking the event loop with TUN reads.** Use a worker thread, `Bun.file(fd).stream()`, or `O_NONBLOCK` + poll. Document the choice.
3. **Forgetting `IFF_NO_PI`.** Kernel prepends 4 bytes to every read. Round-trip a known packet to prove it's off.
4. **Assuming IPv4 IHL = 5.** Always read `ihl` and multiply by 4.
5. **UDP checksum zero.** Legal in IPv4 but strict receivers drop it. Compute the checksum in `buildUdpIpPacket`.
6. **Not restarting on interface IP change.** The library does not watch. The module must `stop()` and recreate on DHCP renew or reconnect.
7. **`ip link del` while fd is open.** Close fd first; Linux removes the TUN on last close.
8. **Assuming `srtla_send` binds to the TUN IP.** It may bind `0.0.0.0`. Read `src_ip` from the actual packet.
9. **Both relay sockets on the same port.** `encoderSocket` on `listenPort`, `outboundSocket` on `0`. Don't confuse them.
10. **Porting the Moblink WebSocket protocol.** Not in scope. No `Hello`/`Identify`/`startTunnel`, no challenge–response. §2.5.
11. **Adding `--moblink-*` CLI flags.** Forbidden. §2.1.
12. **Creating `moblink-relay-service.json`.** Forbidden. §2.2.
13. **Manually editing the uplinks file from the Moblink module.** Use the `network` capability. §7.2, §2.3.
14. **Two `srtla_send` instances fighting over the same TUN.** Document the single-flow assumption. If user needs multiple paths, they need multiple TUNs (one per relay) and multiple SRTLA senders — that is a module-level concern, not the library's.
15. **Skipping rollback on partial start.** If relay #2 fails after relay #1 started, stop #1. Same for VIF + uplink registration: if uplink add fails, stop the VIF.

---

## 13. Suggested Implementation Order

Ship each layer green before moving on.

1. **Library scaffolding** — `package.json`, `tsconfig.json`, empty `index.ts`, passing `bun test`.
2. **`protocol.ts` + `ip.ts`** with unit tests — no sockets, no TUN. This is the foundation.
3. **`relay.ts`** — two sockets, forwarding, unit tests on `127.0.0.1`.
4. **`tun-linux.ts`** — open/close/read helpers, struct tests against known values.
5. **`virtual-interface.ts`** — wire TUN + UDP + protocol + ip, unit tests with mocked fd.
6. **Library integration test** — dummy interface, real end-to-end, gated by env var.
7. **`network` module uplinks capability** — add if missing.
8. **`moblink-streamer` module** — backend only, wire VIF + uplink registration, then frontend + settings.
9. **`moblink-relay` role + module** — backend only (supervisor over `createUdpRelay`), then frontend + settings.
10. **Manual two-VM validation.**
11. **Docs + README updates.**

---

## 14. References

-   `irlctrl` — https://github.com/majklovec/irlctrl
-   `moblink-rust` — https://github.com/datagutt/moblink-rust (for future transport mode; **not** to be ported in v1)
-   Moblin iOS — https://github.com/eerimoq/moblin (conceptual only)
-   BELABOX / SRTLA — https://github.com/BELABOX
-   Bun UDP — https://bun.sh/docs/api/udp
-   Linux TUN — `Documentation/networking/tuntap.rst` in the kernel source
-   `ioctl(TUNSETIFF)` — `linux/if_tun.h`

---

**Note for the implementing agent:** the library is the hard part; the modules are wiring. Do not invert this. Build, test, and ship the library in isolation before touching `client/modules/`. If a module needs a library feature that doesn't exist, add it to the library with a test — not inline in the module.
