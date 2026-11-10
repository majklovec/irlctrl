# Handoff Document: Runtime Destination Switching for `srtla_send`

## 1. Project Context & Goal

**Project:** `irlserver/srtla_send` (Rust implementation of the SRTLA bonding sender).

**Objective:** Implement a new JSON-RPC method (e.g., `set_target`) that allows changing the destination SRTLA receiver address (host and port) at runtime **without restarting the process**. Alongside this, develop a monitoring script that uses this RPC method to switch the target from a primary gateway (SRTLA proxy) to a fallback public IP upon detecting a failure, and switch back when the gateway recovers.

**Additional goal:** Configure `srtla_send` with aggressive stall-detection parameters so that a failed uplink is dropped from traffic distribution within hundreds of milliseconds, independently of the RPC-driven target switch. This reduces the time during which packets are sent to a dead gateway, complementing the failover logic.

**Current State:** The JSON-RPC control interface (`--control-socket`) supports runtime changes for scheduling mode (`set_mode`), quality scoring (`set_quality`), and timeout parameters (`set_conn_timeout`), but **does not expose a method to change the target address**. The destination is provided as a positional argument at startup and remains fixed unless the automatic, conservative `rehome` mechanism triggers.

## 2. Relevant Codebase & Architecture

The implementing agent must work with the following components:

### 2.1 Control Interface (`control.rs` / `docs/CONTROL_PROTOCOL.md`)

-   The JSON-RPC server listens on a Unix socket (configured via `--control-socket`).
-   Existing methods are defined in `control.rs`. The reference document is `docs/CONTROL_PROTOCOL.md`.
-   The new method `set_target` must be added to the dispatcher and documented in `CONTROL_PROTOCOL.md`.

### 2.2 Runtime Configuration (`config.rs`)

-   The struct `DynamicConfig` holds runtime-modifiable parameters (e.g., `mode`, `conn_timeout_ms`).
-   The target address (`SocketAddr` or a tuple of `host: String` and `port: u16`) must be added to `DynamicConfig` as an atomic or lock-protected field so it can be read by the sender task and written by the RPC handler.
-   The config is read once at startup from a TOML file, but runtime changes are expected via RPC.

### 2.3 Automatic Re-home Logic (`sender/rehome.rs`)

-   This module contains the logic for relocating the entire bond to a new address when all uplinks fail and DNS resolves to a different IP.
-   **Key insight:** The automatic re-home is deliberately conservative (requires all links down for a prolonged period, rate-limited to one attempt per minute). The new RPC method should **reuse this re-home mechanism** but trigger it manually upon command, bypassing the conservative gating conditions.
-   The re-home process involves re-registering all uplinks with the new receiver (REG1/REG2/REG3 flow).

### 2.4 Sender Task (likely in `main.rs` or `sender/mod.rs`)

-   The main sender loop reads the current target from `DynamicConfig` when sending packets.
-   Upon receiving a `set_target` command, the RPC handler should update `DynamicConfig` and signal the sender task (e.g., via a `tokio::sync::watch` channel or an `AtomicBool` flag) to trigger the re-home process.

### 2.5 Stall Detection Configuration (`config.rs`, startup only)

-   `srtla_send` 4.x exposes a "stall gate" mechanism that deselects an uplink that holds a large unacknowledged backlog but delivers no fresh ACKs, provided another healthy uplink is available.
-   Relevant parameters (all **startup-only**, not modifiable via RPC):
    -   `--stall-ack-stale-ms` (default **3000**): time without a fresh ACK before a link is considered stalled.
    -   `--stall-min-in-flight` (default **32**): minimum in-flight packet count for stall evaluation.
    -   `--conn-timeout-ms` (default **5000**): overall connection timeout.
-   **Recommended values for this deployment:** `--stall-ack-stale-ms 400 --stall-min-in-flight 1 --conn-timeout-ms 1500`.
-   These values are tuned for the failover scenario: a dead gateway link is deselected within hundreds of milliseconds, while `srtla_send` continues sending over remaining uplinks. This is **complementary** to the RPC-driven target switch — it shortens the period during which packets are sent into a dead gateway even before the monitoring script reacts.

## 3. Implementation Steps for `set_target` RPC Method

### Step 1: Extend `DynamicConfig`

In `config.rs`:

-   Add a field `target_addr: Arc<RwLock<SocketAddr>>` (or `ArcSwap` for lock-free reads).
-   Ensure the field is initialized from the startup arguments.

### Step 2: Add RPC Dispatcher Entry

In `control.rs`:

-   Add a match arm for `"set_target"`.
-   Parse `params`: expect `{"host": "string", "port": 5000}`.
-   Validate the host (DNS resolution is **not** required at this stage; pass the string to the re-home logic, which will resolve it).
-   Update `DynamicConfig.target_addr`.
-   Signal the sender/re-home task to perform the switch.

**Example JSON-RPC request:**

```json
{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "set_target",
    "params": { "host": "192.168.1.1", "port": 5000 }
}
```

**Example success response:**

```json
{ "jsonrpc": "2.0", "result": { "host": "192.168.1.1", "port": 5000 }, "id": 1 }
```

### Step 3: Trigger Manual Re-home

-   Expose a function in `sender/rehome.rs` (e.g., `pub async fn trigger_manual_rehome(new_addr: SocketAddr)`) that performs the same steps as the automatic re-home but without the all-links-down and rate-limit guards.
-   The function should:
    1.  Stop accepting new packets for the old target.
    2.  Re-resolve the new host (if it is a hostname).
    3.  Re-register all active uplinks with the new receiver using the REG1/REG2/REG3 flow.
    4.  Update the internal bond ID and receiver state.
-   Call this function from the RPC handler (spawn a task to avoid blocking the RPC response).

### Step 4: Update Documentation

-   Add `set_target` to `docs/CONTROL_PROTOCOL.md` under the **Methods** section, with parameter and result schemas.
-   Explicitly document that `stall_ack_stale_ms`, `stall_min_in_flight`, and `conn_timeout_ms` are **startup-only** and cannot be modified via RPC (for clarity to operators).

## 4. Monitoring Script

### 4.1 Requirements

-   Periodically check the reachability of the primary target (gateway).
-   Upon failure, use the `set_target` RPC method to switch to the fallback public IP.
-   Upon recovery, switch back to the primary target.
-   Minimize interruption: avoid process restarts; rely solely on the RPC call.
-   The `srtla_send` process itself must be started with the aggressive stall-detection parameters from §2.5 so that it independently reacts to a dead gateway before the script does.

### 4.2 `srtla_send` Startup (reference)

```bash
/usr/bin/srtla_send \
    --control-socket /tmp/srtla.sock \
    --stall-ack-stale-ms 400 \
    --stall-min-in-flight 1 \
    --conn-timeout-ms 1500 \
    6000 192.168.1.1 5000 /etc/srtla/srtla_ips.txt
```

Note: `stall_ack_stale_ms`, `stall_min_in_flight`, and `conn_timeout_ms` are applied **at startup** and are **not** modifiable via RPC. Only the target address (via the new `set_target` method) is switched at runtime.

### 4.3 Sample Script (Bash)

```bash
#!/bin/bash
# /usr/local/bin/srtla_failover.sh
set -euo pipefail

CONTROL_SOCKET="/tmp/srtla.sock"
PRIMARY_HOST="192.168.1.1"       # Gateway LAN IP
PRIMARY_PORT=5000
FALLBACK_HOST="203.0.113.10"     # Public IP of the final receiver
FALLBACK_PORT=5000
CHECK_INTERVAL=3
PING_TIMEOUT=2

send_rpc() {
    local method="$1"
    local params="$2"
    local payload="{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$method\",\"params\":$params}"
    echo "$payload" | socat - UNIX-CONNECT:"$CONTROL_SOCKET" >/dev/null
}

is_primary_reachable() {
    ping -c 1 -W "$PING_TIMEOUT" "$PRIMARY_HOST" &>/dev/null
}

current_target="primary"

while true; do
    if is_primary_reachable; then
        if [[ "$current_target" != "primary" ]]; then
            send_rpc "set_target" "{\"host\":\"$PRIMARY_HOST\",\"port\":$PRIMARY_PORT}"
            current_target="primary"
            logger -t srtla-failover "Switched to primary target $PRIMARY_HOST"
        fi
    else
        if [[ "$current_target" != "fallback" ]]; then
            send_rpc "set_target" "{\"host\":\"$FALLBACK_HOST\",\"port\":$FALLBACK_PORT}"
            current_target="fallback"
            logger -t srtla-failover "Switched to fallback target $FALLBACK_HOST"
        fi
    fi
    sleep "$CHECK_INTERVAL"
done
```

### 4.4 Systemd Service

Create `/etc/systemd/system/srtla-failover.service`:

```ini
[Unit]
Description=SRTLA failover watchdog
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/srtla_failover.sh
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

## 5. Testing & Validation

1.  **Unit Tests:** Add tests for the new `set_target` method in `control_tests.rs` (if it exists) or create a new test module. Verify that the RPC handler correctly updates `DynamicConfig` and spawns the re-home task.
2.  **Integration Test:** Use the existing end-to-end test harness (if available) to:
    -   Start `srtla_send` with a mock receiver and the aggressive stall-detection flags (`--stall-ack-stale-ms 400 --stall-min-in-flight 1 --conn-timeout-ms 1500`).
    -   Issue a `set_target` RPC command via `socat`.
    -   Confirm that the sender re-registers with the new receiver address.
3.  **Stall-Gate Test:** Simulate a single uplink that stops delivering ACKs (e.g., `iptables` drop on one interface). Verify that the uplink is deselected within ~400 ms and that traffic continues on the remaining uplinks without a full bond teardown.
4.  **Failure Simulation:** Simulate a gateway failure (e.g., block traffic to the primary IP) and verify that:
    -   The stall gate deselects the dead gateway link within hundreds of milliseconds.
    -   The monitoring script triggers the fallback switch via `set_target`.
    -   The script switches back when the gateway is restored.

## 6. Important Cautions

-   **Address reachability (critical):** The primary target (`192.168.1.1` in this example) is a **private LAN address**. Only the encoder's Wi-Fi uplink can reach it directly. The encoder's USB modem, being on a separate cellular network, **cannot reach a private LAN IP** without a tunnel or a publicly routable address on the gateway. If the encoder's modem uplink is expected to participate in the primary (gateway-bound) SRTLA bond, this must be resolved beforehand (e.g., VPN tunnel between encoder and gateway, or a public IPv4 on the gateway). If the modem is only intended to serve as a fallback via the direct-to-public-IP path, this limitation is acceptable — but it must be validated against the intended topology.
-   **SRTLA is experimental:** The README explicitly states the tool is experimental and requires troubleshooting. Thorough testing is mandatory.
-   **Re-home consistency:** The manual re-home must move **all uplinks simultaneously** to avoid splitting the bond across two receivers.
-   **Control socket security:** The Unix socket should be protected by file permissions to prevent unauthorized configuration changes.
-   **Startup-only parameters:** `stall_ack_stale_ms`, `stall_min_in_flight`, and `conn_timeout_ms` cannot be changed at runtime. If the RPC method is extended in the future to modify them, it must be documented separately and explicitly. For now, they must be set at process start (via CLI or config file) and the monitoring script must not attempt to change them.
-   **Aggressive thresholds are scenario-specific:** The values `400 ms / 1 packet / 1500 ms` are tuned for low-latency failover between a local gateway and a public fallback. On high-latency (satellite) or lossy links, these thresholds may cause spurious deselection. Validate against the actual link characteristics before production use.
-   **Ping-based detection granularity:** The sample script uses `ping` to a single address with a 3-second polling interval. For sub-second failover, consider replacing or augmenting this with an event-driven trigger — for example, subscribing to `srtla_send`'s `get_stats` RPC and firing `set_target` when the primary uplink's ACK rate drops below a threshold.

## 7. References

-   Repository: `https://github.com/irlserver/srtla_send`
-   Control Protocol: `docs/CONTROL_PROTOCOL.md`
-   Re-home logic: `sender/rehome.rs` (automatic conservative re-home)
-   Dynamic configuration: `config.rs` (`DynamicConfig`)
-   Existing RPC methods: `set_mode`, `set_quality`, `get_status`, `get_stats`, `subscribe`, `unsubscribe`
-   Stall detection parameters: `--stall-ack-stale-ms`, `--stall-min-in-flight`, `--conn-timeout-ms` (startup-only; see `config.rs`)
