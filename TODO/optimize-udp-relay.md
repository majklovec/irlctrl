# Handoff: Refactor `irlctrl/shared/lib/udp_relay` to single-socket + high-performance design

**Audience:** Implementing AI agent (Claude, GPT, Cursor, Aider, etc.)
**Author of handoff:** Previous analysis pass
**Repository:** `https://github.com/majklovec/irlctrl`
**Target path:** `shared/lib/udp_relay`
**Reference project:** `https://github.com/datagutt/moblink-rust`

---

## 0. How to use this document

You are being asked to **rewrite the `udp_relay` library** in TypeScript/Bun. Read this handoff top to bottom before touching code. Then:

1. **Clone** `https://github.com/majklovec/irlctrl` locally.
2. **Clone** `https://github.com/datagutt/moblink-rust` as read-only reference.
3. **Read every file** in `shared/lib/udp_relay` and every consumer of it (search the repo for imports from `udp_relay`).
4. **Reconcile this handoff against the actual source.** This document was written from an architectural analysis, not line-by-line source. If any claim here contradicts the source, **trust the source** and update your plan — then flag the discrepancy in your final report.
5. Follow the **Implementation plan (§7)** in the given order. Do not batch changes; commit after each numbered step and run the acceptance tests (§11).

If something in this handoff is ambiguous, make the **minimal, conservative** choice, document it in a `DECISIONS.md` file inside `shared/lib/udp_relay`, and continue.

---

## 1. Project context

`irlctrl` is a project for controlling IRL (in-real-life) streaming hardware. The `shared/lib/udp_relay` library is the **networking core**: it relays UDP traffic between an encoder (phone/streamer device) and a physical network interface so that the encoder can appear as a normal host on that interface without requiring raw-socket privileges on the encoder side.

Today the relay works as follows (verify against source):

-   **Encoder side:** sends framed UDP packets to the relay over a vif (virtual interface) tunnel.
-   **Relay side:** terminates the tunnel, decompresses the framed payload, and forwards the inner IPv4 packet out of a physical interface.
-   **Relay also:** reads inbound packets from the physical interface (raw `AF_INET` socket), performs user-space DNAT/SNAT, and re-frames them for the encoder.

The `moblink-rust` project does the same job with **a single UDP socket bound to the interface** and lets the **kernel's netfilter** handle NAT. That's the model we're adopting.

---

## 2. Primary objective

**Reduce relay-side sockets from two to one per interface tunnel.**

Concretely:

-   **Remove** the raw `AF_INET` socket (`openIfaceRawSocket`, `IfaceRawSocket`, `readIfaceLoop`, `decideIfacePacket`).
-   **Remove** user-space SNAT/DNAT logic (`natPacketDestination`, `natPacketSource`).
-   **Bind a single `UdpSocket`** (via `Bun.udpSocket`) to `interfaceAddress:listenPort` per tunnel.
-   **Rely on kernel routing and netfilter** for packet forwarding and NAT. Document required `iptables`/`nftables` rules in the library README.
-   **Drop the root/CAP_NET_ADMIN requirement** on the relay host.

## 3. Secondary objective

**Maximize relay throughput and minimize per-packet latency.** The current design pays ~10-30× more CPU per packet than necessary due to per-packet allocation, async on the hot path, and user-space packet mangling.

Measured acceptance targets (see §11 for how to measure):

| Metric                        | Baseline to capture | Target             |
| ----------------------------- | ------------------- | ------------------ |
| CPU at 10k pps                | (measure)           | < 25 % of one core |
| GC scavenges / sec at 10k pps | (measure)           | < 1                |
| p99 relay latency             | (measure)           | < 60 µs            |
| Throughput per core           | (measure)           | ≥ 150 Mbps         |

---

## 4. Reference implementation — what to learn from `moblink-rust`

Open and read these files in `datagutt/moblink-rust`:

-   `src/main.rs` — socket setup, bind address, socket lifecycle
-   `src/relay.rs` (or equivalent) — packet loop
-   `README.md` — deployment notes, iptables rules

Extract these patterns (do not copy code, only concepts):

1. **Single `UdpSocket::bind(bind_addr)`** per tunnel. The same socket handles inbound replies and outbound forwards.
2. **Kernel routing is authoritative.** No `SO_BINDTODEVICE`, no raw socket, no `IP_HDRINCL`.
3. **NAT is not the relay's job.** `iptables`/`nftables` rules installed by the deployment layer handle SNAT/DNAT.
4. **Packet loop is allocation-free** on the fast path: a preallocated `BytesMut` scratch buffer, `recv_from` into it, `send_to` from it.
5. **No `await` per packet** in Rust either — the socket is polled.

Write a short `REFERENCE_NOTES.md` in the target library describing exactly which of these you adopted and where.

---

## 5. Current architecture (verify before acting)

### 5.1 Files to expect (from analysis, confirm against source)

```
shared/lib/udp_relay/
├── index.ts               # public exports
├── relay.ts               # UdpRelay class
├── framing.ts             # encodeDataFrame, decideEncoderFrame, sniff helpers
├── net_linux.ts           # openIfaceRawSocket (raw AF_INET)
├── nat.ts                 # natPacketDestination, natPacketSource
├── types.ts               # UdpRelayOptions, RelayStats, etc.
└── udp_relay.test.ts      # existing tests
```

If the actual layout differs, adapt §7 file-by-file accordingly and note the differences.

### 5.2 Expected hot path today

```
Encoder --UDP--> vifSocket.data(buf)
                     |
                     v decodeDataFrame(buf)      [allocates]
                     v decideEncoderFrame(buf)   [reads via Buffer.readUInt32BE]
                     v Buffer.concat([hdr,payload])   [allocation]
                     v ifaceSocket.send(pkt)     [raw socket, root]

Iface  --raw--> iface.read()  [readIfaceLoop, user-space filtering]
                     v decideIfacePacket(buf)
                     v natPacketDestination(buf)   [allocates new packet]
                     v Buffer.concat(...)
                     v vifSocket.send(...)
```

Confirm this shape by reading the source. The exact call names may differ.

### 5.3 Public API surface today

Confirm by reading `index.ts`. Expect at least:

```typescript
export class UdpRelay {
    constructor(options: UdpRelayOptions);
    start(): Promise<void>;
    stop(): Promise<void>;
    stats(): RelayStats;
}

export interface UdpRelayOptions {
    vifListenPort: number;
    interfaceName: string; // e.g. "eth0"
    interfaceAddress: string; // e.g. "192.168.1.10"
    destinationHost: string;
    destinationPort: number;
    vifIp: string; // e.g. "10.3.3.1"
    // ... possibly: mtus, timeouts, logger
}
```

**Any field named `*ifaceSocket*`, `*rawSocket*`, `*natAddress*` that is currently required will need to move or be documented as "handled by netfilter rules."**

---

## 6. Target architecture

### 6.1 Data plane

```
Encoder --UDP--> relaySocket.data(buf, rinfo)
                     |
                     | if rinfo is encoder:
                     v   parse frame header (in-place, no alloc)
                     v   forward payload via relaySocket.send(payload, destHost, destPort)
                     |
                     | else (reply from streamer, DNAT'd by kernel):
                     v   wrap in frame header (in-place, pre-allocated txBuf)
                     v   relaySocket.send(frame, encoderHost, encoderPort)
                     |
                     v stats: O(1) integer increments
```

**One socket. One rx buffer per worker. One tx buffer per worker. Zero allocations on the fast path.**

### 6.2 NAT (documented, not implemented)

Library ships a `NAT.md` with copy-paste rules, e.g.:

```bash
# Relay host, interface eth0 = 192.168.1.10, vif = 10.3.3.1
iptables -t nat -A POSTROUTING -o eth0 -s 10.3.3.1 -j SNAT --to-source 192.168.1.10
iptables -t nat -A PREROUTING  -i eth0 -d 192.168.1.10 -j DNAT --to-destination 10.3.3.1
iptables -A FORWARD -i eth0 -o eth0 -j ACCEPT
```

Provide both `iptables` and `nftables` variants. Provide a `verifyNatRules()` helper (optional, non-fatal) that logs a warning if the rules are absent.

### 6.3 Multi-worker

Provide `UdpRelayOptions.workers?: number` (default `1`). When `> 1`, spawn `workers` `Bun.spawn` children, each binding the same `interfaceAddress:listenPort` with `SO_REUSEPORT`. The kernel load-balances 5-tuples; each child handles a disjoint subset.

---

## 7. Implementation plan (execute in order)

Commit after each step. Run `bun test shared/lib/udp_relay` and the micro-benchmark (§11.2) after each step. **Revert any step that does not measurably improve or preserve both correctness and perf.**

### Step 1 — Baseline

1. `git checkout -b refactor/udp-relay-single-socket`
2. Build a micro-benchmark (`shared/lib/udp_relay/bench/bench.ts`) that:
    - Spawns a fake streamer UDP socket on localhost.
    - Spawns a fake encoder that sends N framed packets at max rate.
    - Runs the relay between them.
    - Measures pps, CPU (`process.cpuUsage()`), and GC count (`perf_hooks`).
3. Record baseline numbers in `bench/BASELINE.md`.

### Step 2 — Remove the raw socket (the primary change)

Files to edit:

-   **`relay.ts`**
    -   Delete the `iface` field and any `ifaceSocket` field.
    -   Delete `readIfaceLoop()` and any method that calls `iface.read()`.
    -   In `start()`: replace `openIfaceRawSocket(...)` + `vifSocket.bind(...)` with a single `Bun.udpSocket({ hostname: interfaceAddress, port: vifListenPort, socket: { recvBufferSize: 4<<20, sendBufferSize: 4<<20 } })`.
    -   In `stop()`: close only that one socket.
-   **`net_linux.ts`**
    -   Delete the entire file. Remove its export from `index.ts`.
-   **`nat.ts`**
    -   Delete `natPacketDestination`, `natPacketSource`, and any user-space packet-rewrite helpers.
    -   Keep (or add) a `verifyNatRules()` that shells out to `iptables -t nat -S` / `nft list ruleset` and logs a warning if the expected rules are missing. Non-fatal.
-   **`types.ts`**
    -   Remove any option field that referred to the raw socket or NAT address.
    -   Add `workers?: number` and `logger?: { warn, info, error }` if not present.
-   **`index.ts`**
    -   Remove `openIfaceRawSocket` and any related exports.
    -   Re-export only the new public surface.

After this step, `bun test` should still pass after you adjust the tests that assumed the raw socket. **Update tests to test behavior, not implementation**: assert that (a) encoder→streamer packets arrive at the fake streamer, (b) streamer→encoder packets arrive framed correctly at the fake encoder.

### Step 3 — Unified data handler

Replace the two read paths with one handler attached to the single socket:

```typescript
private onSocketData(buf: Uint8Array, rinfo: { address: string; port: number }) {
  if (this.encoderAddr !== null && rinfo.port === this.encoderAddr.port && rinfo.address === this.encoderAddr.address) {
    this.forwardToStreamer(buf);
  } else {
    this.forwardToEncoder(buf, rinfo);
  }
}
```

Fast path: the `forwardToStreamer` method should consist of **one header parse and one `send`** in the common case (see Step 6).

Encoder address discovery: the first datagram that arrives and successfully passes the frame-header parse is treated as the encoder. Store it. Log it once at info level. If no datagram arrives within 30 s of `start()`, log a warning (does not stop the relay).

### Step 4 — Remove `Buffer.concat` and `Buffer.from` from hot path

Introduce a per-instance (or per-worker) `PacketPipeline` (new file `pipeline.ts`) with:

-   `rxBuf: Uint8Array` of 65536 (max UDP payload)
-   `txBuf: Uint8Array` of 65536
-   `txLen: number`
-   `writeFrameHeader(vifIp: number, payloadLen: number): void` — writes 6-byte frame header at `txBuf[0..5]`
-   `copyPayload(src: Uint8Array, srcOff: number, len: number): void` — `txBuf.set(src.subarray(srcOff, srcOff + len), 6)`

Use `socket.send(txBuf.subarray(0, txLen), port, host)`. Bun ≥ 1.1 accepts `Uint8Array` directly.

**Do not** call `Buffer.concat`, `Buffer.from`, `Buffer.alloc`, or `new Uint8Array` inside `forwardToStreamer` or `forwardToEncoder`.

### Step 5 — Kill `async`/`await` on the hot path

`onSocketData` must be **synchronous**. `forwardToStreamer` and `forwardToEncoder` must be **synchronous**. Only lifecycle methods (`start`, `stop`) and optional NAT verification may be async.

If `socket.send()` returns a promise, do not await it. Attach an error handler at socket creation.

### Step 6 — Fast-path the common case

In `forwardToStreamer`:

```typescript
// Fast path: known-good frame, direct forward
const payloadOff = sniffFramePayloadOffset(buf); // pure function, no alloc
if (payloadOff < 0) {
    this.stats.framesDropped++;
    return;
}

if (payloadOff === 0 && this.encoderTrusted) {
    // Encoder already sent a raw payload (some encoder versions do this)
    this.socket.send(buf, this.destPort, this.destHost);
    this.stats.fastPath++;
    return;
}

// Slow path: reframe
this.pipeline.writeFrameHeader(this.vifIpU32, buf.length - payloadOff);
this.pipeline.copyPayload(buf, payloadOff, buf.length - payloadOff);
this.socket.send(
    this.pipeline.txBuf.subarray(0, this.pipeline.txLen),
    this.destPort,
    this.destHost,
);
this.stats.fastPath++;
```

`encoderTrusted` is a per-encoder boolean that flips to `true` after the first N successful frame decodes (N=10). Once trusted, prefer the raw-forward branch. **Verify against real encoder behavior** — if the encoder always frames, delete the fast-path branch entirely.

### Step 7 — Direct typed-array reads

In `framing.ts` (and any header parser), replace:

```typescript
buf.readUInt32BE(off)       →  (buf[off] << 24 | buf[off+1] << 16 | buf[off+2] << 8 | buf[off+3]) >>> 0
buf.readUInt16BE(off)       →  (buf[off] << 8) | buf[off+1]
buf.readUInt8(off)          →  buf[off]
```

`DataView` → `Uint8Array` direct indexing. Add a header comment in `framing.ts` explaining why.

### Step 8 — Zero-copy IP address handling

Pre-parse at construction:

```typescript
this.vifIpU32 = ipToU32(options.vifIp); // for frame header
this.destHostStr = options.destinationHost; // keep as string for Bun API
this.destPort = options.destinationPort;
```

Do not do `parseIp()` per packet.

### Step 9 — Optional: SO_REUSEPORT + workers

Implement `workers > 1` by spawning child processes with `Bun.spawn`, passing config via env. Each child runs the same `UdpRelay` with `workers: 1` and `reusePort: true`. Parent forwards SIGTERM/SIGINT to children. Add a `ParentProxyStats` that aggregates counters via a periodic IPC message (once per second, not per packet).

**Skip this step entirely if `bun test` and the bench show you're already under target CPU at 10k pps.** Do not add complexity without demonstrated benefit.

### Step 10 — Metrics

`RelayStats`:

```typescript
export interface RelayStats {
    framesIn: number;
    framesOut: number;
    framesDropped: number;
    bytesIn: number;
    bytesOut: number;
    fastPathHits: number;
    errors: number;
    encoderAddr: { address: string; port: number } | null;
}
```

-   All counters are plain `number`. Increment with `(x + 1) | 0` only if you're sure `x < 2^31`. Otherwise plain `x++` (V8/Bun handles these well).
-   No `performance.now()` per packet.
-   `stats()` returns a snapshot object built on demand — one allocation per call, that's fine.

### Step 11 — Documentation

Add to `shared/lib/udp_relay/`:

-   **`README.md`** — public API, deployment requirements (iptables/nftables), performance tuning notes, how to enable workers, how to verify with the bench.
-   **`NAT.md`** — the actual rules for iptables and nftables, with explanation.
-   **`REFERENCE_NOTES.md`** — which moblink-rust patterns you adopted and where.
-   **`DECISIONS.md`** — anything ambiguous you had to decide, with rationale.
-   **`bench/BASELINE.md`** — baseline vs final numbers from §11.2.

### Step 12 — Update every consumer

Search the repo:

```bash
rg "from ['\"].*udp_relay" -t ts
rg "openIfaceRawSocket|IfaceRawSocket|natPacket(Source|Destination)" -t ts
```

Update every call site:

-   Remove raw-socket-related options.
-   Add `NAT.md` reference to the caller's deployment docs (if any).
-   If the caller used `verifyNatRules`, wire it up.

---

## 8. Files: change summary

| File                 | Action                                                                   |
| -------------------- | ------------------------------------------------------------------------ |
| `index.ts`           | Update exports: remove raw-socket helpers, export new types              |
| `relay.ts`           | **Major rewrite** — single socket, unified handler, sync hot path        |
| `framing.ts`         | Replace `Buffer.readUInt*BE` with `Uint8Array` indexing; make pure       |
| `net_linux.ts`       | **Delete**                                                               |
| `nat.ts`             | Delete SNAT/DNAT helpers; keep/add `verifyNatRules`                      |
| `pipeline.ts`        | **New** — pre-allocated rx/tx buffers, `writeFrameHeader`, `copyPayload` |
| `types.ts`           | Remove raw-socket/NAT-address fields; add `workers`, `logger`            |
| `udp_relay.test.ts`  | Rewrite to test behavior, not implementation                             |
| `bench/bench.ts`     | **New**                                                                  |
| `bench/BASELINE.md`  | **New**                                                                  |
| `README.md`          | **Rewrite**                                                              |
| `NAT.md`             | **New**                                                                  |
| `REFERENCE_NOTES.md` | **New**                                                                  |
| `DECISIONS.md`       | **New**                                                                  |

---

## 9. Constraints and guardrails

**Do not:**

-   Add a dependency on `node:dgram`. Use `Bun.udpSocket` directly.
-   Add a dependency on any NAT library.
-   Perform per-packet `Buffer` allocation.
-   `await` inside `onSocketData` or any sync forward method.
-   Require root privileges for the library to function (as a library; the deployment may still need root for iptables — that's the deployment's problem).
-   Change the wire format. Encoders must not need to update.
-   Add a flow-tracking `Map` unless you demonstrate that the current flow set is nontrivial. The single-socket + kernel-NAT design usually removes the need entirely.

**Do:**

-   Prefer deleting code to adding code.
-   Prefer typed arrays to `Buffer` helpers on hot paths.
-   Add a comment on every micro-optimization explaining **why** (link to `bench/BASELINE.md` if you measured it).
-   Keep the public API as close to the current one as possible — only remove what's now dead.

---

## 10. Performance requirements

Non-negotiable, measured by `bench/bench.ts`:

| Requirement                               | Threshold                                                                                      |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Fast path allocates                       | 0 bytes per packet (verified with `process.memoryUsage().heapUsed` slope < 1 KB / 10k packets) |
| Fast path `await`s                        | 0                                                                                              |
| CPU at 10k pps, one core                  | < 25 % of one core on the CI machine                                                           |
| p99 latency at 10k pps                    | < 60 µs                                                                                        |
| Throughput (single core, 1400 B payloads) | ≥ 150 Mbps                                                                                     |
| Test suite                                | 100 % pass, and existing behavior preserved except where this handoff explicitly changes it    |

---

## 11. Acceptance tests

### 11.1 Unit + integration

Run `bun test shared/lib/udp_relay`. Must pass:

-   **Encoder → streamer:** framed packet from encoder arrives at fake streamer as expected payload.
-   **Streamer → encoder:** datagram from fake streamer arrives at encoder, correctly framed.
-   **Unknown source:** datagram from a random port after encoder established is treated as a streamer reply (must not be silently dropped) — assert framing occurs.
-   **Malformed frame:** dropped, `framesDropped++`.
-   **`start()`/`stop()` idempotency** — no leaks, no double-close errors.
-   **`stats()`** — counters reflect reality after N packets.
-   **Encoders on two ports** — the second port's traffic does not corrupt the first's state. (Document whichever behavior you implement.)

### 11.2 Benchmark

Run `bun bench/bench.ts`. Produce `bench/BASELINE.md` with:

```
Before (baseline from Step 1):
  pps: <n>
  CPU: <x>%
  GC scavenges/sec: <n>
  p99 latency: <n> µs

After (final):
  pps: <n>
  CPU: <x>%
  GC scavenges/sec: <n>
  p99 latency: <n> µs

Regression or improvement: <summary>
```

### 11.3 Manual smoke test

Document the exact commands in `bench/SMOKE.md`:

1. Start relay on a real interface with real netfilter rules from `NAT.md`.
2. `ping` the streamer's vif IP from an encoder-simulated socket.
3. `curl` an HTTP endpoint on the streamer through the tunnel.
4. Confirm no root requirement for the relay process itself (only for installing rules).

### 11.4 CI

Ensure `bun test` and `bun bench/bench.ts` run in CI. Store per-PR bench results as an artifact. Fail CI if CPU% or p99 latency regresses by more than 15 % from the last main branch run.

---

## 12. Risks and unknowns

| Risk                                                                         | Likelihood | Mitigation                                                                                                                                                   |
| ---------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Encoder currently relies on raw-socket behavior for some flows               | Medium     | Search encoder-side code for assumptions; test with real encoder hardware if possible; keep a feature flag `legacyRawSocket` if needed (but mark deprecated) |
| Kernel routing on relay host sends forwarded packets out the wrong interface | Medium     | Add a startup self-check: `ip route get <destHost>` and log the chosen interface; warn if it differs from `interfaceAddress`'s interface                     |
| Netfilter rules absent in user's deployment                                  | High       | `verifyNatRules()` logs a warning on start; `README.md` and `NAT.md` lead with the rules                                                                     |
| MTU issues on encapsulated path                                              | Medium     | Add `MTU.md` note: inner packet must be ≤ `interface MTU - 28`; document in README                                                                           |
| `Bun.udpSocket` API differences across versions                              | Low        | Pin a `bun` version in `package.json` `engines`; test in CI with that version                                                                                |
| Flow state was needed for reasons not obvious from code                      | Low        | If tests reveal you truly need per-encoder routing, reintroduce it as a minimal typed-array flow table (see §5 of the perf plan) — not a `Map<string>`       |

If any risk blocks a step, **stop and write a note in `DECISIONS.md`** rather than guessing.

---

## 13. Rollback plan

If after Step 4 (`Buffer.concat` removal) the tests fail and you cannot fix them within one focused session:

1. `git checkout main`
2. Open a PR containing only Steps 1–2 (raw-socket removal + NAT documentation) — that alone is the primary win.
3. File the perf work as a follow-up issue with `bench/BASELINE.md` attached.

The refactor is **strictly additive in value**: removing the raw socket is a win regardless of whether the perf work lands.

---

## 14. Final report (required deliverable)

When you are done, produce a file `HANDOFF_COMPLETE.md` at the repo root with:

1. **Summary** of what changed (bullet list, one line per file).
2. **Before/after benchmark table** (from `bench/BASELINE.md`).
3. **All deviations** from this handoff, with rationale.
4. **All open questions** that a human should resolve.
5. **Confidence level** (low / medium / high) that the change is production-safe, and why.
6. **One-paragraph "how to verify manually"** for the human merging the PR.

Do not mark the task complete without this report.

---

## 15. Summary for the implementing AI

You are removing one socket and a lot of user-space packet mangling, and replacing them with a single `Bun.udpSocket`, kernel netfilter, pre-allocated buffers, direct `Uint8Array` reads, and a fully synchronous hot path. You are **not** changing the wire format or the encoder. The reference implementation (`moblink-rust`) proves this design is both simpler and faster. Ship it in small, benchmarked, committed steps. When in doubt, delete code.
