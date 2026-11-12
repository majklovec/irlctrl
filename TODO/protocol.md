## Full Detailed Summary: Relay–Encoder Architecture (Final Version)

This is the complete, consolidated specification of the relay–encoder behavior, incorporating all clarifications from the conversation:
-   Discovery via UDP broadcast/unicast, **mDNS**, and/or the control server (three redundant paths; see §3).
-   No CLI parameters; all configuration is done through the UI.
-   The term “streamer” is replaced by **encoder**.
-   The encoder creates a **TUN interface** to aggregate relay paths into a single logical network adapter.
-   Port allocation for UDP relays never reindexes existing interfaces.

---

### 1. Core Architecture

-   **Relay side**: A device with multiple uplink interfaces (e.g., `eth0`, `eth1`, `usb0`). For each uplink interface, the relay creates a dedicated UDP relay instance bound to that interface’s IP address and a unique UDP port.
-   **Encoder side**: Receives UDP packets from one or more relays and writes them into a **TUN (virtual) interface**. Local applications (e.g., an SRTLA sender) read from this TUN interface as if it were a single logical network adapter. The encoder also handles the reverse path: packets written by local apps to the TUN interface are read by the encoder and sent back over UDP to the correct relay.
-   **Purpose**: Make physical network paths from a remote box (relay) appear as a single virtual interface on the local box (encoder), enabling aggregation and failover without modifying the local application.

---

### 2. UDP Relay Creation and Port Allocation (Relay Side)

-   The relay continuously tracks network interfaces.
-   For every **uplink** interface, it creates a separate UDP relay instance bound to:
    -   the IP address of that specific interface,
    -   its own UDP port.
-   In the relay UI, uplink interfaces are marked with an **uplink icon**.
-   UDP ports are allocated sequentially from base `4000`:
    -   `eth0` → `4000`
    -   `eth1` → `4001`
    -   when `usb0` is added → `4002`
-   **No reindexing on interface addition**: Adding a new interface does not change existing port assignments. The allocator keeps a high-water mark; a new interface gets `highest_assigned_port + 1`.
-   Removing an interface does not reindex other interfaces. Port mappings remain stable.
-   If an interface goes down, its UDP relay is marked down, but the port mapping is not reassigned.
-   If an interface is removed and later re-added, it is treated as a new interface and receives the next highest port (unless the UI explicitly preserves a mapping).

---

### 3. Discovery

Both sides discover each other through **three redundant paths** (any one of them
keeps the registry's TTL fresh, so a single blocked path — e.g. a Docker bridge
that filters multicast — no longer flaps the link). The discovered-relay
registry is keyed by the relay's STABLE identity (`relay_id`/hostname, falling
back to the announced IP when none is known), so one physical relay occupies
exactly ONE entry no matter how many paths learn it (and a later path for the
same identity merges into the existing entry instead of duplicating it);
registration is logged once per relay, not on every refresh:
1. **UDP broadcast + unicast** (discovery port `10333`)
   - The encoder periodically broadcasts its information on the network, and
     additionally unicasts the same payload every tick to the addresses of the
     relays it already knows.
     - The payload contains at least:
       - `encoder_id`
       - encoder IP address
       - encoder WebSocket port
       - protocol version and optional auth token.
       - The relay listens on `10333` (bound to `0.0.0.0`) and learns the encoder
         WebSocket endpoint from this message.
         - The limited broadcast (`255.255.255.255`) is refused with `EACCES` when the
           encoder runs without `CAP_NET_ADMIN` (unprivileged container); the unicast
           fallback converges identically because the listener is not broadcast-bound.
           - Symmetric for the relay: it announces its uplink interfaces the same way.
             Its announcer opens ONE SOCKET PER ATTACHED SEGMENT (bound to each
             interface's own IP with `setBroadcast(true)`): a limited broadcast
             (`255.255.255.255`) only egresses on the bind address's subnet, so a
             multi-homed relay (e.g. facing an encoder on 192.168.10.x via a second
             NIC) would be silent on every segment except the bound one with a single
             socket. A manual `announceHost` override changes the ANNOUNCED tunnel
             IPs, not where the discovery datagrams are sent.
             - AND the relay unicasts the same payload every tick to every KNOWN
               encoder's IP (from one socket — routing picks its egress): the
               limited broadcast does not cross subnets (an encoder on a
               phone-hotspot / WireGuard link never sees it), so once ANY path
               (same-L2 broadcast, mDNS, or the control server) seeds one entry,
               the unicast keeps the pair alive across any routed path. The
               encoder's listener learns/refreshes the relay from those messages
               (plus the WS control channel, which remains the authoritative source
               for the full interface list).
             - Note: a Docker **bridge** network does not forward these datagrams between
               the container and the LAN — publish `10333:10333/udp` (done in
               `docker-compose.yaml`) or run the relay with `network_mode: host`.

2. **mDNS (DNS-SD over multicast `224.0.0.251:5353`)** (path added 2025 —
   overrides the original "no mDNS" constraint)
   - The relay advertises the instance `_irlctrl-relay._udp.local`
     (`instance.hostname.local`, SRV → discovery port) with a compact TXT
     record: `h=<hostname>;ip=<primary host>;i=<iface=addr:port;…>` (truncated
     at the 255-byte TXT limit; the encoder keeps the _longer_ endpoint set
     across sources, so truncation never shrinks a WS-learned list).
     - The encoder advertises `_irlctrl-encoder._udp.local`
       (`instance.hostname.local`, SRV → its WebSocket port) with TXT
       `id=;ip=;port=;proto=;tok=`.
       - Both sides run a browser for the _other_ service (re-query + re-advertise
         every 10 s). Discovered instances refresh the same TTL registries as the
         UDP path; the WS `hello` (full interface snapshot) stays authoritative.
         - The mDNS path is best-effort: if multicast is filtered (Docker bridge),
           paths 1 and 3 still carry discovery. Requires no configuration.

3. **Control server**
   - The relay may query the control server for available encoders.
     - The control server returns the same kind of information: encoder IP,
       WebSocket port, `encoder_id`, and optional token.

-   All settings are configured in the UI, **no CLI parameters**.

---

### 4. WebSocket Connection and Interface Propagation

-   The **encoder runs a WebSocket server**.
-   The relay connects directly to the encoder as a **WebSocket client**.
-   After connecting, the relay sends:
    -   relay identity,
    -   protocol version,
    -   full list of its uplink interfaces.
-   For each interface, the relay sends:
    -   interface name (e.g., `eth0`),
    -   relay interface IP address (e.g., `192.168.1.10`),
    -   UDP relay port (e.g., `4000`).
-   **The IP address is the relay interface address that the encoder should use to reach the relay.** The encoder sends UDP data to this `IP:port`.

**Interface change events** (sent over the existing WebSocket):
-   `interface_added` — a new interface was added and received the highest port.
-   `interface_removed` — an interface was removed.
-   `interface_up` — an interface became available.
-   `interface_down` — an interface became unavailable.

Each event contains at least:
-   `iface_name`
-   `ip`
-   `udp_port`
-   `state` (`up` / `down`)
-   `uplink: true`

After any WebSocket reconnect, the relay always sends a **full snapshot of all interfaces** so the encoder has a consistent view.

**Keepalive (self-sustaining channel):** the relay sends `{type:"ping"}` every
5 s while the channel is open; the encoder replies `{type:"pong"}`. Every
frame in both directions refreshes the peer's discovery-registry TTL, so a
live WebSocket is self-sustaining — discovery (UDP/mDNS/control server) is
only needed for the initial dial. Additionally:
- the relay never stops an OPEN/CONNECTING channel during reconcile (a dead
  peer closes itself; the close handler owns the re-dial/cleanup);
- the encoder's TTL sweep never reaps a relay with a live WebSocket.

---

### 5. Data Flow (with TUN Interface on Encoder)

**Forward path (relay → encoder → local app):**
1. Relay receives data from its local source and sends it as UDP packets through the physical interface bound to that relay instance.
2. Encoder receives UDP packets from various relay paths.
3. Encoder writes the received packets into the **TUN interface** (e.g., `tun0`), which has an IP address from a defined network (e.g., `10.3.3.0/24`).
4. Local applications (e.g., SRTLA sender) read from this TUN interface as if it were a single logical network adapter.

**Reverse path (local app → encoder → relay):**
1. Local application writes response packets to the TUN interface.
2. Encoder reads these packets from the TUN interface.
3. Encoder sends them back over UDP to the appropriate relay (using the relay’s IP and UDP port).
4. Relay forwards them to its local network.

-   If the relay sends `interface_down` or `interface_removed`, the encoder stops using that path.
-   If the relay sends `interface_added` or `interface_up`, the encoder may start using that path.

---

### 6. Alignment with Moblink

The design matches Moblink as follows:
-   Moblink relay-service creates a relay instance per interface.
-   Each relay instance has its own UDP socket bound to a specific interface.
-   The encoder acts as a WebSocket server; the relay acts as a WebSocket client.
-   The relay sends interface information to the encoder over WebSocket.
-   The encoder uses the relay interface IP and port for UDP communication.
-   **Key clarification**: The encoder creates a **TUN interface** to aggregate all relay paths into a single virtual network adapter. Local applications see one interface, not multiple physical paths.
-   The control server can be used as an alternative to UDP discovery.

Items that need to be made explicit or added compared with standard Moblink behavior:
-   The rule **“no port reindexing”** and allocation by `max_assigned + 1`.
-   UI marking of uplink interfaces with an uplink icon.
-   A defined UDP broadcast format for encoder discovery, plus the mDNS
    (DNS-SD) discovery path with compact TXT payloads.
-   WebSocket events `interface_added`, `interface_removed`, `interface_up`, `interface_down`, plus full-state snapshot after reconnect.
-   Configuration only in the UI, with no CLI parameters.
-   Discovery via UDP broadcast/unicast **and** mDNS (DNS-SD) and/or the
    control server — redundant, all refreshing the same TTL registries.
-   Explicit description of TUN interface creation on the encoder side and the bidirectional data flow through it.

---

### 7. Summary of Key Clarifications

-   The relay is a **pure UDP relay** whose job is to make physical interfaces from one box (relay) available on another box (encoder).
-   The encoder **creates a virtual TUN interface** to aggregate all relay paths; this was a crucial missing piece in the initial understanding.
-   Data flow is bidirectional: relay → UDP → encoder → TUN → local app, and local app → TUN → encoder → UDP → relay.
-   Port allocation is stable and never reindexes existing interfaces.
-   Discovery uses UDP broadcast/unicast, mDNS (DNS-SD), and/or the control server.
-   All configuration is done via UI, not CLI parameters.
-   WebSocket is used for control and interface state propagation, not for data transport.
-   **Terminology correction**: The term “streamer” is not used; the correct term is **encoder**.
