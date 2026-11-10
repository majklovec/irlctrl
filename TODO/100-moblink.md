Toto řešení stojí na tom, že **`moblink-rust` nepředstírá, že je `srtla_rec`**. Místo toho vytváří **paralelní dopravní tunel** mezi proxy a encoderem, kterým protékají **stejné SRTLA/UDP pakety**, jako by šly fyzickou linkou. Proxy se tak nestává novým koncovým bodem SRTLA, ale **další síťovou cestou**, kterou encoder vidí jako součást svého existujícího bondingu.

### 🧩 Dva komponenty, které musí běžet

Řešení vyžaduje dvě strany:

**Na encoderu** musí běžet **`moblink-streamer`** (nebo aplikace Moblin, která tuto roli plní). Ten vytváří:

-   **WebSocket server** na lokální IP (`--websocket-server-address`, výchozí port `7777`), ke kterému se proxy připojuje.
-   **TUN rozhraní** ze sítě definované pomocí `--tun-ip-network` (výchozí `10.3.3.0/24`). Přes toto TUN rozhraní encoder odesílá SRTLA/UDP pakety, které `moblink-streamer` distribuuje do websocketových tunelů.
-   Cílovou adresu a port vzdáleného `srtla_rec` (`--destination-address`, `--destination-port`), kam mají data po průchodu všemi tunely dorazit.

**Na proxy** běží **`moblink-relay-service`**. Ten automaticky sleduje všechna způsobilá síťová rozhraní a pro každé spustí jeden relay proces. Každé rozhraní (`eth0`, `usb0`, `usb1`) se tak stane **samostatnou bondingovou cestou**.

### 🔄 Přesný tok paketů

1. **Encoder** vyšle SRTLA/UDP paket na TUN IP adresu, kterou spravuje `moblink-streamer` (např. `10.3.3.1`).
2. `moblink-streamer` tento paket **zabalí do websocketové zprávy** a odešle jej všem připojeným relayům na proxy.
3. **Každý relay na proxy** přijme paket, **rozbalí jej** a odešle jako **běžný UDP datagram** přes své přiřazené fyzické rozhraní (`eth0`, `usb0` nebo `usb1`) na **veřejnou IP vzdáleného `srtla_rec`**.
4. Zpětná vazba (SRT ACK/NAK) od `srtla_rec` putuje **opačným směrem**: dorazí na některé rozhraní proxy, relay ji zabalí do websocketu a pošle zpět `moblink-streameru`, který ji předá na TUN rozhraní encoderu.
5. `srtla_send` na encoderu (nebo samotný GStreamer, pokud používáte `srtsink` s bondingem) tak **dostává ACK/NAK ze všech linek současně** a může dynamicky vyvažovat zátěž.

### ⚙️ Konkrétní konfigurace

#### Na encoderu (spuštění `moblink-streamer`)

```bash
./moblink-streamer \
  --websocket-server-address 192.168.1.10 \   # IP encoderu na wlan0 (viditelná z proxy)
  --websocket-server-port 7777 \
  --password "secret123" \
  --tun-ip-network 10.3.3.0/24 \
  --destination-address <VEŘEJNÁ_IP_SRTLA_REC> \
  --destination-port 5000
```

Poté vaše GStreamer pipeline (nebo `srtla_send`) odesílá na TUN IP adresu streameru, např. `srtla_send 6000 10.3.3.1 5000 ...`. `moblink-streamer` se postará o distribuci přes relaye.

#### Na proxy (spuštění `moblink-relay-service`)

```bash
./moblink-relay-service \
  --password "secret123" \
  --streamer-url ws://192.168.1.10:7777 \    # WebSocket encoderu (lokální IP)
  --interface-name-override eth0=Starlink \
  --interface-name-override usb0=Modem1 \
  --interface-name-override usb1=Modem2 \
  --runtime-status-file /tmp/moblink-status.json
```

Služba automaticky vytvoří **tři relaye**, každý navázaný na jedno rozhraní. Pokud by některé rozhraní nemělo být použito, lze jej vyloučit pomocí `--network-interfaces-to-ignore` (např. `docker.*`).

### 🔑 Klíčové předpoklady a omezení

-   **Dostupnost WebSocket serveru**: Proxy se připojuje k encoderu přes `--streamer-url`. Encoder tedy musí mít na `wlan0` IP adresu, která je z proxy dosažitelná. Ve vaší topologii (proxy i encoder ve stejné lokální síti přes `wlan0`) to splněno je. Veřejná IP encoderu není potřeba.
-   **Autentizace**: Obě strany musí mít stejné `--password`. Komunikace používá challenge-response mechanismus odvozený z Androidího Moblink klienta.
-   **TUN rozhraní na encoderu**: `moblink-streamer` vytváří TUN zařízení. Vaše GStreamer pipeline ani `srtla_send` o něm nemusí vědět – stačí, že směrují SRTLA/UDP provoz na IP adresu z `--tun-ip-network`. Tím se **veškerý provoz encoderu, který má jít přes proxy, automaticky rozdělí mezi všechny linky proxy**.
-   **Není to náhrada `srtla_rec`**: Proxy stále **není** SRTLA přijímač. `moblink-rust` funguje jako **dopravní vrstva**, která rozšiřuje existující SRTLA bonding encoderu o další fyzické cesty. Vzdálený `srtla_rec` na konci vidí **jedno souvislé SRTLA spojení**, jehož pakety k němu přich bud z encoderova modemu (`usb0`), nebo z proxy přes `eth0`/`usb0`/`usb1`.

Tímto způsobem je dosaženo přesně toho, co požadujete: **transparentní rozšíření bondingu encoderu o všechny linky proxy**, aniž by proxy potřebovala veřejnou IP nebo aby vznikaly duplicitní streamy.

# Handoff Document: Moblink Relay Implementation in Bun/TypeScript for `irlctrl`

## 1. Context and Goal

The goal is to implement **Moblink relay functionality** in **Bun/TypeScript** as a native part of the [`majklovec/irlctrl`](https://github.com/majklovec/irlctrl) project. The implementation should allow an `irlctrl` device (e.g., a router or a multi-uplink box) to act as a **Moblink relay**, contributing additional independent bonding paths to an SRTLA stream via the Moblink protocol.

The reference implementation is the Rust project [`datagutt/moblink-rust`](https://github.com/datagutt/moblink-rust), which provides:

-   A **relay** that connects to a Moblink streamer (e.g., Moblin on iOS or a Belabox running `moblink-streamer`) over WebSocket, authenticates via challenge–response, and forwards UDP traffic.
-   A **relay-service** supervisor that automatically starts one relay instance per eligible network interface, so each uplink becomes a separate bonding path.

Your task is to replicate this behavior in TypeScript using Bun’s native WebSocket, UDP (`Bun.udpSocket`), and process‑management APIs, and integrate it into `irlctrl`’s existing module system and role‑based architecture.

---

## 2. Repository Overview: `irlctrl`

`irlctrl` is a **Bun‑based controller for BELABOX‑style bonded streaming**. It is split into:

-   **`client/`** – the device side (backend + web UI + device modules).
-   **`server/`** – the optional control server (fleet management, dashboards).
-   **`shared/`** – dependency‑free helpers, contracts, UI kit.

### Key architectural points

-   **Roles** are selected via `--role`: `relay` (default), `encoder`, `obs`, `broadcaster`.
-   **Everything is a module** under `client/modules/`. The core discovers modules by directory scan and routes RPC calls, status fragments, settings, and UI cards through a contract.
-   A module typically ships:
    -   `backend.ts` – backend registration, RPC methods, status, settings, lifecycle hooks.
    -   `frontend.tsx` – Mithril components for the device card / settings page.
    -   `types.ts` – wire types.
    -   Optional `settings.tsx`, `log.ts`, `i18n/`, `styles.css`.
-   Modules communicate via a **capability bus** (`ctx.capabilities`) – never by direct import.
-   The `network` module already handles **interface discovery, policy routing, and uplinks file generation** for SRTLA bonding. Reuse its capabilities rather than re‑implementing interface enumeration.
-   The `relay` module already runs `srtla_rec` + `srtla_send` and manages the SRTLA→SRTLA bridge. Your Moblink module should be **additive**, not a replacement.

**Relevant files to study before coding:**

-   `client/modules/relay/backend.ts` – lifecycle of a long‑running process, RPC methods.
-   `client/modules/network/backend.ts` – interface list, uplinks capability.
-   `shared/contracts/backend_module.ts` – the module contract.
-   `client/backend/module_core.ts` – the services bag (Supervisor, `run`, `logEvent`, etc.).
-   `client/backend/methods.ts` – global RPC method list (for reference only; module methods live in the module’s own dispatch).

---

## 3. Moblink Protocol Specification (to implement)

Create new roles -

-   **MoblinkRelay** – responsible for establishing and maintaining the SRTLA bridge, handling incoming and outgoing streams.
-   **Moblink** module– used in encoder, responsible for managing device cards, settings, and communication with the MoblinkRelay via the capability bus.

The Rust implementation exposes the following behavior. Your TypeScript implementation must mirror it.

### 3.1 Relay CLI arguments

| Argument                                | Description                                                                                    | Default     |
| --------------------------------------- | ---------------------------------------------------------------------------------------------- | ----------- |
| `--name`                                | Relay name (shown to the streamer)                                                             | Hostname    |
| `--id`                                  | UUID to identify the relay                                                                     | Generated   |
| `--streamer-url`                        | WebSocket URL of the streamer (e.g., `ws://192.168.1.2:7777`). If omitted, use mDNS discovery. | none (mDNS) |
| `--password`                            | Password for challenge–response auth                                                           | `1234`      |
| `--bind-address`                        | Local IP to bind the UDP socket                                                                | `0.0.0.0`   |
| `--status-executable` / `--status-file` | Source of status JSON (e.g., `{"batteryPercentage":93}`)                                       | none        |
| `--log-level`                           | Log verbosity                                                                                  | `info`      |

### 3.2 Relay‑service (supervisor) CLI arguments

| Argument                                     | Description                                   | Default                      |
| -------------------------------------------- | --------------------------------------------- | ---------------------------- |
| `--password`                                 | Password for all relays                       | `1234`                       |
| `--network-interfaces-to-allow` / `--ignore` | Regex filters for interface names             | allow all, ignore none       |
| `--streamer-url` (repeatable)                | Fixed streamer URLs (bypass mDNS)             | none                         |
| `--interface-name-override`                  | Rename a relay per interface (`eth0=WAN`)     | none                         |
| `--runtime-status-file`                      | Path to write JSON status of relays/streamers | none                         |
| `--database`                                 | File storing per‑interface relay identities   | `moblink-relay-service.json` |
| `--status-executable` / `--status-file`      | Same as relay                                 | none                         |
| `--log-level`                                | Log verbosity                                 | `info`                       |

### 3.3 WebSocket connection flow

1. **Connect** to `streamer_url` (or discover via mDNS).
2. Receive a **`Hello`** message from the streamer containing a challenge and salt.
3. Compute the **authentication hash** using the password, challenge, and salt (same algorithm as the Android client; see `moblink_rust/protocol.rs` for reference).
4. Send an **`Identify`** message with the computed authentication, relay name, and ID.
5. Upon receiving a **`startTunnel`** request, spawn two asynchronous forwarding tasks:
    - **`relay_to_destination`**: streamer → local destination.
    - **`relay_to_streamer`**: destination → streamer.
6. Bind a **UDP socket** to the specified `--bind-address` (or the main interface). This socket is used for both directions.
7. Optionally, periodically send **status** (battery percentage) if a status source is configured.

### 3.4 mDNS discovery

The relay should attempt to discover Moblink streamers on the local network using mDNS (`_moblink._udp` or the service name used by the Rust implementation). If `--streamer-url` is provided, skip mDNS.

### 3.5 Multiple interfaces (supervisor)

The supervisor must:

-   Enumerate eligible network interfaces (respecting allow/ignore regexes).
-   For each interface, start a separate relay instance with:
    -   `--bind-address` set to that interface’s IP.
    -   A persistent relay ID (stored in `--database`).
    -   The same streamer URL(s) and password.
-   Write a **runtime status file** whenever relays or streamers change, in the format:
    ```json
    {
      "connected": true,
      "manual_streamer": "ws://...",
      "streamers": [ ... ],
      "relays": [
        {
          "interfaceName": "eth0",
          "interfaceAddress": "192.168.1.10",
          "streamerName": "...",
          "streamerUrl": "...",
          "streamerHost": "..."
        }
      ]
    }
    ```

---

## 4. Integration Plan for `irlctrl`

### 4.1 Choose the integration point

You have two viable approaches:

**Option A – New module `moblink`** (recommended)

Create `client/modules/moblink/` with:

-   `backend.ts` – implements relay‑service supervisor, RPC methods (`moblink.start`, `moblink.stop`, `moblink.status`), uses the `network` module’s capability to get interfaces.
-   `frontend.tsx` – a device card showing connected relays, streamer list, and a settings form for password, streamer URL, interface filters.
-   `types.ts` – wire types.
-   `settings.tsx` – settings page card.

Register the module with `roles: ["relay", "encoder", "broadcaster"]` (any role that has network access). It can coexist with the existing `relay` module (SRTLA bridge) – the Moblink module adds **additional paths** that the SRTLA bonding can use. The `network` module’s uplinks file can be extended to include the UDP sockets created by Moblink, but that is a deeper integration; start with a standalone Moblink relay that works alongside the existing SRTLA bridge.

**Option B – Extend the existing `relay` module**

Add Moblink functionality into `client/modules/relay/backend.ts`. This is riskier because the `relay` module already has a clear SRTLA responsibility; mixing concerns may violate the module boundary.

**Recommendation:** Option A. It keeps the code clean and lets users enable Moblink independently.

### 4.2 Leverage existing capabilities

-   **Network interfaces**: Use the `network` module’s capability (`network.interfaces` or similar) to get the list of eligible interfaces. Do not re‑implement `ip link` parsing.
-   **Persistence**: Use `ctx.state` and `ctx.saveState` (from `module_core.ts`) to store relay IDs, passwords, and runtime status, following the pattern of other modules.
-   **Logging**: Use `ctx.logEvent` to emit structured log events that the web UI can display.
-   **Supervisor**: The Rust supervisor is a separate binary. In Bun you can implement it as a single `backend.ts` that spawns **child processes** (one per interface) using `Bun.spawn`, or as a single process with multiple async relay tasks (one per interface). The latter is simpler and avoids process‑management overhead. Use `Bun.udpSocket` for each interface’s UDP socket.
-   **WebSocket**: Use Bun’s native `WebSocket` client (`new WebSocket(url)`). For mDNS, you may need a lightweight dependency (e.g., `bonjour-service`) or implement a minimal mDNS query using `Bun.dgram`.

### 4.3 RPC methods to expose

Expose at least:

-   `moblink.start` – start the supervisor (and all relays).
-   `moblink.stop` – stop all relays.
-   `moblink.status` – return the runtime status (same shape as the Rust `--runtime-status-file`).
-   `moblink.setConfig` – update password, streamer URLs, interface filters.

Add these to the module’s `methods` array in `backend.ts`.

### 4.4 Frontend requirements

-   A device card showing:
    -   Number of active relays.
    -   Per‑relay status: interface name, address, connected streamer.
    -   Battery percentage (if status source is configured).
-   A settings form with fields for password, streamer URL(s), interface allow/ignore regexes, and status source.

Use the existing UI kit (`shared/ui/`) and follow the patterns of `client/modules/relay/frontend.tsx`.

### 4.5 Role compatibility

The Moblink module should be available in roles that have network access: `relay`, `encoder`, `broadcaster`. It does not need to run in the `obs` role. Declare `roles: ["relay", "encoder", "broadcaster"]` in the backend registration.

---

## 5. Key Files and Code References

| File / Directory                           | Why it matters                                                                                            |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `client/modules/relay/backend.ts`          | Example of a module that owns long‑running network processes, RPC methods, and status.                    |
| `client/modules/network/backend.ts`        | Source of interface enumeration and uplinks capability – reuse it.                                        |
| `shared/contracts/backend_module.ts`       | The contract your `backend.ts` must implement.                                                            |
| `client/backend/module_core.ts`            | The services bag: `Supervisor`, `run`, `logEvent`, `saveState`, etc.                                      |
| `client/modules/README.md`                 | How to declare dashboard actions, settings, i18n.                                                         |
| `shared/registry.ts`                       | Module discovery – your module will be picked up automatically if placed under `client/modules/moblink/`. |
| `moblink-rust/src/protocol.rs`             | Authentication algorithm reference.                                                                       |
| `moblink-rust/src/relay.rs` (if available) | Rust relay loop for reference.                                                                            |

---

## 6. Testing and Validation

### Unit tests

-   Test the **authentication hash** computation against known vectors from the Rust implementation.
-   Test **interface filtering** logic (allow/ignore regexes).
-   Test **runtime status serialization**.

### Integration tests

-   Spin up a **mock WebSocket streamer** (using Bun’s `Bun.serve` with a WebSocket handler) that implements the `Hello` → `Identify` → `startTunnel` flow. Verify that the relay connects, authenticates, and starts UDP forwarding.
-   Use `Bun.udpSocket` on both ends to send a packet through the relay and assert it arrives.

### Manual validation

-   Run the module on a device with multiple interfaces (e.g., Ethernet + Wi‑Fi) and point it to a Belabox running `moblink-streamer`. Confirm that the streamer sees two independent bonding paths.
-   Verify the runtime status file matches the expected JSON schema.

---

## 7. Potential Pitfalls

-   **UDP binding per interface**: Each relay must bind to the **specific interface IP** (`--bind-address`), not `0.0.0.0`, otherwise the OS may route packets out the wrong interface. Use `Bun.udpSocket({ hostname: interfaceAddress })`.
-   **Challenge–response auth**: The algorithm is not standard HTTP auth; it uses a custom hash. Copy the logic from `moblink-rust/src/protocol.rs` exactly.
-   **mDNS**: Bun does not have built‑in mDNS. Use a lightweight npm package or implement a minimal querier. If mDNS is unreliable in the target environment, rely on `--streamer-url` (fixed URLs) as the primary method.
-   **Supervisor lifecycle**: If you spawn child processes, ensure they are killed on module stop. If you use in‑process async tasks, use `AbortController` to cancel them cleanly.
-   **Compatibility with existing SRTLA bonding**: The Moblink relay creates **its own UDP tunnels**. To actually bond them with the existing SRTLA stream, the `srtla_send` process must be aware of these extra paths. The simplest first step is to run Moblink **in parallel** with the existing SRTLA bridge; users can manually add the Moblink‑provided IPs to the uplinks file. A deeper integration (auto‑registering Moblink sockets as uplinks) can be a follow‑up.
-   **Security**: The default password `1234` is weak. Enforce a minimum length or warn in the UI. The WebSocket connection should support `wss://` for production.

---

## 8. Deliverables

A successful handoff should produce:

1. **Source code** under `client/modules/moblink/`:
    - `backend.ts` (supervisor + relay logic + RPC methods)
    - `frontend.tsx` (device card)
    - `settings.tsx` (settings page)
    - `types.ts`
    - `styles.css` (if needed)
2. **Unit tests** in `test/` covering auth, interface filtering, and status serialization.
3. **Integration test** with a mock WebSocket streamer.
4. **Documentation** update in the module’s README or in `client/modules/README.md` describing how to enable and configure Moblink.
5. **A runtime status file** writer that matches the Rust schema, so external UIs (e.g., Moblin) can display relay state.

---

## 9. References

-   `irlctrl` repository: https://github.com/majklovec/irlctrl
-   `moblink-rust` repository: https://github.com/datagutt/moblink-rust
-   Moblin iOS app (original feature): https://github.com/eerimoq/moblin
-   BELABOX / SRTLA: https://github.com/BELABOX
-   Bun WebSocket client: https://bun.sh/docs/api/websockets
-   Bun UDP sockets: https://bun.sh/docs/api/udp

---

**Note for the implementing agent:** Start by creating the module skeleton (`backend.ts` with a minimal RPC method), verify that `bun run dev` picks it up, then implement the WebSocket handshake against a mock server. Once the handshake works, add UDP forwarding, then the supervisor logic for multiple interfaces. Test each layer in isolation before integrating with a real Belabox.
