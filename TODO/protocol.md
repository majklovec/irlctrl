## Detailed Relay–Encoder Behavior (English)

### 1. Relay creates one UDP relay per uplink interface

-   The relay service continuously tracks network interfaces.
-   For every **uplink** interface, it creates a separate UDP relay instance.
-   Each UDP relay instance is bound to:
    -   the IP address of that specific interface,
    -   its own UDP port.
-   In the relay UI interface list, these interfaces are marked with an **uplink icon**.
-   UDP ports are allocated sequentially from base `4000`:
    -   `eth0` → `4000`
    -   `eth1` → `4001`
    -   when `usb0` is added → `4002`
-   **Adding a new interface must not reindex existing UDP relay ports.**
-   The port allocator keeps a high-water mark of the highest assigned port. A new interface receives `highest_assigned_port + 1`.
-   Removing an interface also does not reindex other interfaces. Existing port mappings remain stable.
-   If an interface goes down, its UDP relay is marked down, but its port mapping is not reassigned.
-   If an interface is removed and later added again, it is treated as a new interface and receives the next highest port unless the UI explicitly preserves a mapping.

---

### 2. Encoder discovery by relay

The relay discovers encoders only through:

1. **UDP broadcast from the encoder**

    - The encoder periodically broadcasts its information on the network.
    - The broadcast contains at least:
        - `encoder_id`
        - encoder IP address
        - encoder WebSocket port
        - protocol version and optional auth token.
    - The relay listens on the configured UDP discovery port and learns the encoder WebSocket endpoint from this message.

2. **Control server**
    - The relay may ask the control server for available encoders.
    - The control server returns the same kind of information: encoder IP, WebSocket port, `encoder_id`, and optional token.

---

### 3. Relay connects directly to encoder over WebSocket

-   The **encoder runs a WebSocket server**.
-   The relay connects directly to the encoder as a **WebSocket client**.
-   After connecting, the relay sends:
    -   relay identity,
    -   protocol version,
    -   full list of its uplink interfaces.
-   For each interface, the relay sends:
    -   interface name, e.g. `eth0`,
    -   relay interface IP address, e.g. `192.168.1.10`,
    -   UDP relay port, e.g. `4000`.
-   **The IP address is the address of the relay interface that the encoder should use to reach the relay.** The encoder sends UDP data to this `IP:port`.

---

### 4. Interface changes are propagated to the encoder

The relay monitors interface changes and immediately sends updates to the encoder over the existing WebSocket connection.

Event types:

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

---

### 5. Data flow

-   The encoder receives the relay interface list over WebSocket.
-   For each active relay uplink interface, the encoder uses as UDP destination:
    -   `relay_interface_ip : relay_udp_port`.
-   The relay receives UDP data on the socket bound to that interface and forwards it further.
-   If the relay sends `interface_down` or `interface_removed`, the encoder stops using that path.
-   If the relay sends `interface_added` or `interface_up`, the encoder may start using that path.
