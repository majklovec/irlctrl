# Project Specification: IRLCTRL Mobile — SRTLA Streaming Encoder for Android

**Document type:** Handoff specification for an implementing AI agent
**Target repository:** `majklovec/irlctrl`
**Proposed module name:** `android-encoder` (native Android client)
**Status:** Draft for implementation
**Revision:** 2 — adds implementation-language decision (§2.4, §7.2)

---

## 1. Executive Summary

IRLCTRL is a Bun-based controller for BELABOX-style bonded streaming. It exposes four device roles — `relay`, `encoder`, `obs`, and `broadcaster` — and an optional control server that manages devices over an outbound WebSocket connection. Today the `encoder` role runs on Linux-class devices with GStreamer pipelines and a local `srtla_send` process.

This project adds **a native Android application** that fulfils the **`encoder` role on a mobile device**. The Android app will:

1. Capture video/audio from the phone’s camera and microphone.
2. Encode using hardware-accelerated MediaCodec.
3. Bond multiple network interfaces (Wi‑Fi + cellular) using SRTLA.
4. Send the bonded SRTLA stream to an IRLCTRL `relay` (or directly to an SRTLA receiver).
5. Register with the IRLCTRL control server as a first-class device, exposing the same RPC methods and status events that the control server and dashboards already understand for the `encoder` role.

The deliverable is a new Android module (Gradle project) inside the `irlctrl` repository, plus the minimal shared-contract additions needed so the control server recognises the mobile encoder without core changes. **The application is implemented in Kotlin**, with the SRTLA bonding engine kept behind a clean Kotlin interface so it can be swapped to a native (C/C++ or Rust) implementation via JNI if pure-Kotlin performance is measured to be insufficient (see §7.2).

---

## 2. Goals and Non-Goals

### 2.1 Goals

| #   | Goal                                                                                                                                                                                |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1  | Implement an Android foreground service that captures, encodes, and streams SRTLA-bonded video/audio.                                                                               |
| G2  | Bond Wi‑Fi and cellular interfaces simultaneously; fall back gracefully when one link disappears.                                                                                   |
| G3  | Integrate with the IRLCTRL control server over the existing WebSocket JSON protocol (`{ id, method, params }` → `{ type: "response", id, ok }` + `{ type: "event", event, data }`). |
| G4  | Expose encoder RPC methods (`encoder.start`, `encoder.stop`, `encoder.setBitrate`, etc.) so dashboards and the virtual StreamDeck work unchanged.                                   |
| G5  | Persist device identity (UUID, hostname, role, control-server URL/token) in local storage so the device re-registers after reboot.                                                  |
| G6  | Provide a minimal on-device UI for setup, start/stop, and live link statistics.                                                                                                     |

### 2.2 Non-Goals

-   Implementing `relay`, `obs`, or `broadcaster` roles on Android.
-   Replacing the existing Bun-based device client on Linux.
-   Building a full belacoder/ceracoder pipeline editor for mobile; the Android encoder uses a fixed, hardware-appropriate encoding profile (configurable via settings).
-   Acting as an SRTLA receiver; the app is a sender only.
-   Adding native code to the build **before** the pure-Kotlin SRTLA engine is measured and found insufficient.

### 2.3 Language and Runtime Summary

| Layer                                                                            | Language                                                                                           | Rationale                                                                        |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Android UI, foreground service, capture, encoding, control client, config, stats | **Kotlin**                                                                                         | Standard for modern Android; Compose; coroutines for camera/WebSocket pipelines. |
| SRT transport                                                                    | **Kotlin** via `srtdroid` (JNI wrapper around native SRT)                                          | Avoid re-implementing SRT.                                                       |
| SRTLA bonding engine                                                             | **Kotlin first**, behind a `SrtlaBond` interface; **native (C/C++ or Rust) via JNI as a fallback** | Isolates the only component likely to need native speed.                         |
| Wire-protocol contracts                                                          | **Kotlin data classes** mirroring TypeScript contracts                                             | Type-safe RPC router; drift caught by contract tests.                            |
| Build / tooling                                                                  | Kotlin DSL Gradle 8.x, AGP 8.x, JDK 17, Compose BOM, `kotlinx.serialization`                       | Standard Android stack.                                                          |

**Target split:** ~85% Kotlin, ~15% native — and the native portion is confined to exactly one module (`srtla-core`) with a fixed, small API surface.

### 2.4 Language Selection — Detailed Rationale

**Kotlin as the primary language** is chosen because:

-   The Android toolchain (Compose, CameraX, MediaCodec, `ConnectivityManager`, foreground services) is Kotlin-first.
-   Coroutines + `Flow` map directly onto IRLCTRL’s event model: each incoming `{ type: "event", … }` becomes an emission on a `SharedFlow<DeviceEvent>`; each `{ id, method, params }` becomes a `suspend fun` return.
-   `srtdroid` — the maintained SRT JNI wrapper — exposes a Kotlin API. No bridging code needed for the SRT layer.
-   Kotlin data classes diff cleanly against the TypeScript types in `shared/contracts/`, which makes the wire contract reviewable by the same maintainers who own the Bun code.

**The SRTLA bonding engine is the one component that must stay swappable.** It processes every packet on the wire (thousands of packets/second) and must avoid GC-induced jitter. Three strategies, in order of preference:

-   **Option A — Pure Kotlin (default).** `DatagramChannel`/`DatagramSocket` per link, non-blocking, dedicated thread (not a coroutine dispatcher), pre-allocated and reused `ByteBuffer`s, allocation-free hot path. This is the starting point. Brix demonstrates pure Kotlin/Java SRT/SRTLA is workable on Android.
-   **Option B — C/C++ via JNI (production fallback).** Compile the BELABOX `srtla_send` C reference with the NDK. Expose a thin JNI shim; Kotlin owns the direct `ByteBuffer` pool and the native side does zero-copy `sendto()` per link. Crossed once per packet, not per byte.
-   **Option C — Rust via JNI (modern alternative).** Bridge via the `jni` crate, build with `cargo-ndk`. Adds a Rust toolchain to CI; only chosen if the Rust `srtla_send` reference is the preferred upstream.

**Promotion rule:** Ship Option A in milestone M4. If measured loss/retransmit rate exceeds the §10 acceptance criteria at the target bitrate, promote to Option B _without changing the Kotlin-facing `SrtlaBond` API_. The native build stays out of the CI pipeline until then.

**Do not push into native code:** capture, MediaCodec configuration, muxing/packetisation, WebSocket control client, RPC router, settings persistence, Compose UI, or statistics aggregation. Those belong in Kotlin.

---

## 3. System Context and Integration Points

### 3.1 Where the Android app sits in IRLCTRL

```
Android Encoder  ──SRTLA (bonded)──▶  IRLCTRL Relay  ──SRTLA/SRT──▶  Receiver
       │                                    │
       │  WebSocket (outbound)              │
       ▼                                    ▼
                 IRLCTRL Control Server
```

The Android app is a **device client** that connects to the control server at `wss://ctl.example.com/device` with a bearer token. The control server assigns the device to the token owner and relays RPC commands from the browser UI.

### 3.2 Control-server protocol (must be matched exactly)

-   **Request:** `{ "id": <string|number>, "method": "<namespace>.<action>", "params": { … } }`
-   **Response:** `{ "type": "response", "id": <same>, "ok": <bool>, … }`
-   **Push event:** `{ "type": "event", "event": "<event-name>", "data": { … } }`

The Android client must implement the **`encoder` module’s RPC surface** as declared in `client/modules/encoder`. At minimum:

| Method               | Parameters                                | Behaviour                                      |
| -------------------- | ----------------------------------------- | ---------------------------------------------- |
| `encoder.start`      | `{ pipeline?: string, bitrate?: number }` | Start capture + encoding + SRTLA send.         |
| `encoder.stop`       | `{}`                                      | Stop the stream and release camera/mic.        |
| `encoder.setBitrate` | `{ bitrate: number }`                     | Adjust encoding bitrate live.                  |
| `encoder.status`     | `{}`                                      | Return current status (also emitted as event). |

Status events must include at least: `streaming` (bool), `bitrate` (current), `uplinks` (array of link stats), `srtla` (bond health). The control server merges these into its device status and dashboards.

### 3.3 Authentication and identity

-   The Android app receives a **device token** from the user (entered in setup or provisioned via QR code). It sends `Authorization: Bearer <token>` when opening the WebSocket.
-   The device UUID is generated once on first launch and persisted. It is the fixed identity on the control server.
-   The app must re-dial the control server whenever settings change, exactly like the Bun client does.

---

## 4. Android Application Architecture

### 4.1 Module / package layout

```
android-encoder/
├── app/                          # Android application module
│   ├── src/main/java/net/irlctrl/encoder/
│   │   ├── core/                 # Foreground service, lifecycle
│   │   ├── capture/              # CameraX + AudioRecord
│   │   ├── encode/               # MediaCodec wrappers
│   │   ├── control/              # WebSocket client + RPC router
│   │   ├── config/               # Persistent settings (DataStore)
│   │   ├── ui/                   # Compose screens
│   │   └── stats/                # Link stats collection
│   └── build.gradle.kts
├── srtla-core/                   # SrtlaBond interface + pure-Kotlin impl (+ optional JNI)
├── shared-contracts/             # Kotlin copies of irlctrl wire types
└── DEVIATIONS.md                 # Any deviations from this spec, with reasons
```

Modules are co-located like irlctrl device modules (`client/modules/<name>`). The Android project lives under `android-encoder/` at the repository root.

### 4.2 Capture layer

-   **Video:** CameraX `Preview` + `VideoCapture` with `SurfaceTexture` → `MediaCodec` surface input. Use `CameraSelector.DEFAULT_BACK_CAMERA` by default; allow front/back switch in settings.
-   **Audio:** `AudioRecord` with 48 kHz mono/stereo PCM → `MediaCodec` AAC encoder.
-   **Permissions:** `CAMERA`, `RECORD_AUDIO`, `INTERNET`, `ACCESS_NETWORK_STATE`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_CAMERA`, `FOREGROUND_SERVICE_MICROPHONE`, `POST_NOTIFICATIONS` (API 33+).

### 4.3 Encoding layer

| Stream | Codec                            | Container / transport                         |
| ------ | -------------------------------- | --------------------------------------------- |
| Video  | H.264 AVC, hardware `MediaCodec` | SRT payload (MPEG-TS or raw H.264 — see §5.2) |
| Audio  | AAC-LC                           | SRT payload                                   |

-   Bitrate range: 500 kbps – 8 Mbps (configurable).
-   Resolution: 720p default; 1080p optional if device supports.
-   Frame rate: 30 fps target; 60 fps optional.
-   **Key requirement:** encoding runs on a dedicated thread/`HandlerThread`; nothing blocks the main thread.

### 4.4 SRTLA bonding engine (the core challenge)

The bonding engine sits between the encoder output and the network sockets. It is behind a **Kotlin interface** so it can be swapped to a native implementation later:

```kotlin
// srtla-core/src/main/kotlin/net/irlctrl/encoder/srtla/SrtlaBond.kt
interface SrtlaBond {
    fun addLink(networkHandle: Long, remoteHost: String, remotePort: Int): LinkId
    fun removeLink(id: LinkId)
    fun submit(packet: ByteBuffer, len: Int): Int        // called from encoder thread
    fun poll(out: ByteBuffer): Int                       // called from reader thread
    fun stats(): List<LinkStats>
    fun close()
}
```

Two implementations live behind this interface:

-   `KotlinSrtlaBond` — pure Kotlin, the default shipped in M4.
-   `NativeSrtlaBond` — JNI-backed (C/C++ or Rust), added only if the promotion rule in §2.4 triggers.

The rest of the app must only reference `SrtlaBond`, never the implementations.

#### 4.4.1 Socket management

-   Use Android `ConnectivityManager` to enumerate active networks (Wi‑Fi, cellular).
-   For each bondable network, create a `DatagramChannel` **bound to that network** via `Network.bindSocket()`.
-   Maintain a `Map<LinkId, Link>` where each `Link` tracks: socket, packets-in-flight, RTT estimate, loss estimate, and enabled/disabled state.

#### 4.4.2 SRTLA protocol responsibilities

Implement the **sender side** of SRTLA as documented in the BELABOX/IRLToolkit `srtla` project and the Rust `srtla_send` reference. Required behaviours:

1. **Connection group registration:** Send `SRTLA_REG1` / `SRTLA_REG2` handshake packets to the receiver (`srtla_rec` on the relay) over each link.
2. **Packet distribution:** Take SRT packets (or encoded media chunks packaged as SRT) and distribute them across enabled links using a **weighted round-robin / least-in-flight** strategy. Do not exceed each link’s estimated capacity.
3. **ACK/NAK forwarding:** Listen for SRT control packets from the receiver and forward them back to the local SRT sender (inside the app) **over all links**. This is how the SRT congestion control sees the aggregated path.
4. **Link keepalive and failure detection:** Send periodic keepalives on idle links; mark a link dead after N missed responses and remove it from rotation.

> **Implementation note:** There is no drop-in Android SRTLA bonding library. Brix implements SRT and SRTLA “from scratch” in Kotlin/Java and is the primary reference for Option A. The `srtdroid` library provides SRT transport but **not** bonding; bonding logic must be layered on top.

#### 4.4.3 Interaction with SRT transport

The app uses an SRT sender (via `srtdroid`). The bonding engine intercepts the sender’s outgoing packets and sends them over the bonded sockets, while feeding received control packets back into the SRT sender. The destination address for the SRT sender is the **relay’s SRTLA receiver port** (default UDP 6000 on the relay, per irlctrl’s relay role).

### 4.5 Control client (WebSocket)

-   Use OkHttp `WebSocket` or Ktor `WebSocket`.
-   On connect: send the bearer token in the HTTP upgrade request (verify against `client/backend/client.ts`).
-   Register the device, then publish `status` events and respond to RPC methods.
-   Reconnect with exponential backoff (1 s → 30 s max).
-   Wire the router with `kotlinx.serialization` and Kotlin `Flow` so each incoming event becomes a `SharedFlow` emission.

### 4.6 UI (Jetpack Compose)

Minimum screens:

1. **Setup / Settings:** control-server URL, device token, hostname, header colour, encoding preset (resolution/bitrate), preferred camera.
2. **Live:** camera preview, Start/Stop button, live status (streaming, bitrate, per-link stats, SRTLA bond health).
3. **Diagnostics:** log of recent events (connection changes, errors).

The UI must reflect the same status fields the control server displays for a Linux encoder, so dashboards need no special-casing.

---

## 5. Data Flow and Media Packaging

### 5.1 High-level pipeline

```
CameraX ──▶ MediaCodec (H.264) ──┐
                                  ├──▶ Muxer / Packetizer ──▶ SRT sender ──▶ SrtlaBond ──▶ Bonded sockets
AudioRecord ──▶ MediaCodec (AAC) ┘
```

### 5.2 Muxing / packetisation

Choose **one** of the following and document the choice in the implementation:

-   **Option A (recommended):** MPEG-TS muxer inside the app (`MediaMuxer` with `MUXER_OUTPUT_MPEG_TS` is not universally available; a lightweight TS writer or a library like `mp4parser` adapted for TS is acceptable). Feed the TS stream into SRT as payload.
-   **Option B:** Raw H.264/AAC with a custom framing header, matching what the IRLCTRL relay/broadcaster expects. **This must be verified against the relay’s `srtla_rec` configuration** — a relay that expects TS will fail on raw frames.

> **Handoff instruction:** Before implementing the packetiser, read `client/modules/relay` and `client/modules/broadcaster` in irlctrl to determine the exact SRT payload format the relay forwards. Align the Android encoder with that format.

### 5.3 Clock and timestamping

Use `System.nanoTime()` for monotonic timestamps. SRT requires a 32-bit timestamp with microsecond resolution; convert carefully and handle wrap-around.

---

## 6. Configuration and State

### 6.1 Persistent settings (DataStore / SharedPreferences)

| Key                  | Type   | Default           | Notes                   |
| -------------------- | ------ | ----------------- | ----------------------- |
| `device.uuid`        | String | generated         | Fixed identity          |
| `device.hostname`    | String | `android-encoder` | User-editable           |
| `device.role`        | String | `encoder`         | Read-only               |
| `control.url`        | String | —                 | `wss://…/device`        |
| `control.token`      | String | —                 | Bearer token            |
| `encoder.resolution` | String | `1280x720`        |                         |
| `encoder.bitrate`    | Int    | `2500000`         | bps                     |
| `encoder.fps`        | Int    | `30`              |                         |
| `encoder.camera`     | String | `back`            | `back` / `front`        |
| `srtla.relayHost`    | String | —                 | Relay hostname/IP       |
| `srtla.relayPort`    | Int    | `6000`            | Relay SRTLA port        |
| `srtla.links`        | JSON   | auto              | Enabled network handles |

### 6.2 State machine

```
IDLE → STARTING → STREAMING → STOPPING → IDLE
         │            │
         └─ error ────┘
```

On `encoder.start`, transition through `STARTING` (camera open, encoder configured, SRTLA registration) to `STREAMING`. On `encoder.stop`, drain encoders, close sockets, return to `IDLE`. Any unrecoverable error emits an event and returns to `IDLE`.

---

## 7. Build, Tooling, and Repository Integration

### 7.1 Build system

-   Gradle Kotlin DSL, Android Gradle Plugin 8.x, `minSdk 29`, `targetSdk 34`, JDK 17 for the build.
-   Kotlin 1.9+ (or 2.0+), Jetpack Compose BOM, Material 3.
-   Coroutines + `Flow` for async; `kotlinx.serialization` for JSON.
-   OkHttp `WebSocket` (or Ktor) for the control client.
-   `srtdroid` for SRT transport.
-   Hilt optional; manual DI acceptable for v1.
-   Tests: JUnit 5 + Turbine + Compose UI Test.
-   **No native build** until the promotion rule in §2.4 triggers. When it does, CMake + NDK r26+ live under `srtla-core/src/main/cpp/` and are isolated to that module.
-   Build output: `.apk` / `.aab` artefacts published by CI.

### 7.2 Language and Interop Conventions

-   All Android-side code is Kotlin. No Java sources except generated stubs.
-   The only place Java/Kotlin interacts with native code is `srtla-core`. The JNI shim must be minimal — one `external fun` per operation listed in the `SrtlaBond` interface, no per-byte callbacks.
-   Kotlin direct `ByteBuffer`s are owned by the Kotlin caller; the native side must not retain references after `submit()`/`poll()` return.
-   Kotlin/JVM unit tests must be able to run against both `KotlinSrtlaBond` and a test double, without an NDK toolchain.
-   Wire-contract Kotlin types live in `shared-contracts/` with a header comment pointing at the TypeScript source of truth. A contract test serialises Kotlin objects and compares against fixtures generated from the Bun client.

### 7.3 Repository integration

-   Add `android-encoder/` at the repository root.
-   Add a `Makefile` or `justfile` target: `make android` → `./gradlew :app:assembleRelease`.
-   Update the root `README.md` to mention the Android encoder as an additional device option under the `encoder` role.
-   Shared wire types live in `android-encoder/shared-contracts/`; add a comment pointing to `shared/contracts/` as the source of truth.
-   **Do not modify `client/backend/methods.ts` or the core module registry** unless the Android encoder requires a new method that Linux encoders also need. The goal is to be a drop-in `encoder` device.

### 7.4 CI

Add a GitHub Actions workflow:

-   `./gradlew lint test`
-   `./gradlew assembleDebug`
-   Publish APK as an artefact on tags.
-   Native build steps (NDK) **only** if `srtla-core` native is enabled.

---

## 8. Testing and Validation

### 8.1 Unit tests

-   `SrtlaBond` implementations: simulate links with different RTT/loss and assert fair allocation; run against both `KotlinSrtlaBond` and (when present) `NativeSrtlaBond` for parity.
-   RPC router: every `encoder.*` method returns the correct response envelope.
-   Timestamp conversion (SRT microsecond wrap-around).
-   Contract tests: Kotlin wire types vs fixtures generated from the Bun client.

### 8.2 Instrumented tests

-   Camera → encoder → SRTLA loopback (send to a local `srtla_rec` container).
-   Control-server handshake against a local `bun run dev` server with `--no-auth`.

### 8.3 End-to-end validation (definition of done)

1. Flash the APK on a physical Android device with both Wi‑Fi and cellular active.
2. Configure it to point at an IRLCTRL relay and control server.
3. Start the stream from the IRLCTRL browser dashboard (`encoder.start` button).
4. Verify that the relay receives a bonded SRTLA stream and forwards SRT to the configured output.
5. Disable Wi‑Fi mid-stream; the stream must continue over cellular without session teardown (SRTLA bonding failover).
6. The control-server dashboard shows live link stats and bitrate identical to the fields produced by the Linux encoder.
7. **Bonding performance gate:** at the configured target bitrate (default 2.5 Mbps, test up to 5 Mbps), sustained loss + retransmit rate < 1% over a 10-minute run. If the pure-Kotlin `KotlinSrtlaBond` fails this gate, invoke the promotion rule in §2.4 and replace it with `NativeSrtlaBond`.

---

## 9. Milestones and Deliverables

| Milestone                                | Deliverable                                                                                                                             | Estimated effort |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| **M1 — Skeleton + control client**       | Android project (Kotlin) builds; WebSocket connects to `bun run dev` server; `encoder.status` returns a static payload.                 | 3–5 days         |
| **M2 — Capture + encode**                | CameraX preview, MediaCodec H.264/AAC output to a local file (no network).                                                              | 4–6 days         |
| **M3 — SRT transport**                   | Encoded stream sent over a single SRT socket (`srtdroid`) to a local receiver.                                                          | 3–4 days         |
| **M4 — SRTLA bonding (pure Kotlin)**     | `KotlinSrtlaBond` implementing the `SrtlaBond` interface; multi-socket bonding with `srtla_send`-compatible handshake; failover tested. | 7–10 days        |
| **M4b — Native promotion (conditional)** | `NativeSrtlaBond` via JNI (C/C++ `srtla_send` or Rust) behind the same interface. Triggered only if §8.3 gate fails.                    | +5–8 days        |
| **M5 — Control-server RPC surface**      | Full `encoder.*` method set, status events, reconnection, settings persistence.                                                         | 4–6 days         |
| **M6 — UI + polish**                     | Compose UI for setup/live/diagnostics; foreground service notification; APK signing.                                                    | 5–7 days         |

**Total:** ~26–38 developer-days for the Kotlin baseline; +5–8 days if native promotion is needed.

---

## 10. Key Risks and Mitigations

| Risk                                                    | Impact                                          | Mitigation                                                                                                                                             |
| ------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| No Android SRTLA library exists                         | High — bonding must be written from scratch     | Ship pure-Kotlin `KotlinSrtlaBond` first (Brix reference, `srtla_send` Rust reference); keep it behind `SrtlaBond` so native replacement is a drop-in. |
| Pure-Kotlin bonding misses the performance gate (§8.3)  | High — stream quality degrades at high bitrate  | Pre-allocate buffers, dedicated thread, no per-packet allocations; promote to native via §2.4.                                                         |
| Relay expects a specific SRT payload format (TS vs raw) | Medium — stream may not be accepted             | Inspect `client/modules/relay` and `broadcaster` before choosing a packetiser.                                                                         |
| Android restricts simultaneous Wi‑Fi + cellular use     | Medium — bonding may be impossible on some OEMs | Use `ConnectivityManager` request-network APIs correctly; provide a “single-link mode” fallback and document OEM limitations.                          |
| Control-server protocol drift                           | Medium — RPC mismatch                           | Copy method signatures from `client/modules/encoder`; add a contract test that runs against `bun run dev`.                                             |
| Battery / thermal throttling                            | Medium — stream degrades                        | Expose thermal status in diagnostics; allow automatic bitrate/fps reduction.                                                                           |
| JNI bugs in native bonding                              | Medium — hard crashes on the streaming path     | Only added if needed; interface parity tests against `KotlinSrtlaBond`; aggressive `ByteBuffer` lifetime tests.                                        |

---

## 11. Handoff Instructions for the Implementing Agent

1. **Read the IRLCTRL module contract first.** Open `shared/contracts/backend_module.ts` and `client/modules/encoder/backend.ts` to see exactly what an `encoder` module must implement. Your Kotlin classes should mirror that surface, even if the underlying implementation is native Android rather than Bun.
2. **Write Kotlin, not Java.** All Android-side code is Kotlin; the only exception is generated stubs.
3. **Build `srtla-core` as a standalone library.** Keep it free of Android UI dependencies so it is unit-testable on the JVM. Ship `KotlinSrtlaBond` first; do not start `NativeSrtlaBond` until the performance gate in §8.3 actually fails.
4. **Do not change the control-server protocol.** The Android app is a new device on the same wire protocol. If you need a method that does not exist, propose it as an additive change to `methods.ts` and update both the Bun encoder and the Android encoder.
5. **Use Brix as the primary Android reference.** It is an AGPL-3.0 Android app that implements SRT and SRTLA from scratch and runs on Android 10+. Respect its licence when consulting it.
6. **Validate against a real IRLCTRL relay early.** Spin up the Docker Compose stack (`docker compose up relay server`) and point the emulator/device at the relay’s SRTLA port. This catches payload-format issues before the UI is polished.
7. **Keep the JNI surface small.** If native promotion is triggered, the JNI boundary is _only_ the `SrtlaBond` methods — one `external fun` per operation, `ByteBuffer`-based, no per-byte callbacks. Never call native from the UI thread.
8. **Document every deviation.** If you cannot implement a behaviour exactly as specified (e.g. an Android API limitation), record it in `android-encoder/DEVIATIONS.md` with the reason and the workaround.

---

## 12. Open Questions to Resolve at Implementation Time

1. **SRT payload format:** Does the IRLCTRL relay `srtla_rec` accept MPEG-TS only, or can it forward raw H.264/AAC? (Check `client/modules/relay` and the `srtla_rec` startup args.)
2. **Token provisioning:** Should the Android app support QR-code provisioning of the control-server URL and token, or is manual entry sufficient for v1?
3. **Background operation:** Android may restrict camera/mic access in the background. Confirm that a foreground service with `FOREGROUND_SERVICE_CAMERA` + `FOREGROUND_SERVICE_MICROPHONE` is sufficient on target OEMs.
4. **Adaptive bitrate:** Should the Android encoder react to SRTLA link stats by lowering bitrate automatically, or is manual `encoder.setBitrate` enough for v1?
5. **Native promotion trigger:** Agree the exact bitrate/loss threshold at which `KotlinSrtlaBond` → `NativeSrtlaBond` promotion is decided (the current proposal is §8.3: < 1% loss+retransmit at 5 Mbps over 10 minutes).

---

\*This specification is intended to be self-contained. The implementing agent should treat the cited IRLCTRL README sections and the `client/modules/encoder` source as the authoritative reference for protocol and module behaviour, and the Brix / `srtla_send` projects as the authoritative reference for SRTLA bonding semantics. The language decision (§2.4, §7.2) is final for v1: **Kotlin for the app, `srtla-core` behind a swap-friendly interface, native only if measured necessary.\***
