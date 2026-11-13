# Handoff Document — Replacing `udp_relay` with a GRETAP‑Based Library

| Field                 | Value                                                                                                |
| :-------------------- | :--------------------------------------------------------------------------------------------------- |
| **Project**           | `irlctrl` / `moblink` shared libraries                                                               |
| **Scope**             | Replace `shared/lib/udp_relay` (userspace TUN + UDP relay) with a kernel‑level GRETAP tunnel library |
| **Target deployment** | Two Ubuntu boxes connected via a **Loco M5 WDS bridge** (point‑to‑point, direct L2 link, no NAT)     |
| **Status**            | Design + reference implementation complete; integration pending                                      |
| **Owner**             | _[assign]_                                                                                           |
| **Last updated**      | _[date]_                                                                                             |

---

## 1. Context & Motivation

The existing `shared/lib/udp_relay` creates a **TUN device** on each endpoint and forwards L3 IP packets over a **custom UDP protocol** (frame types `0x01` data / `0x02` keepalive) via a userspace Node/Bun process. It works, but it has three drawbacks for our deployment:

1. **Userspace data path** — every packet crosses the kernel↔userspace boundary twice, adding latency and CPU cost.
2. **Layer 3 only** — broadcast, ARP, DHCP, and non‑IP EtherTypes have to be handled manually or are simply not carried.
3. **Custom framing** — our own wire format must be maintained and documented.

The replacement library uses the Linux kernel’s **GRETAP** driver (`ip link add … type gretap`) to carry **Layer‑2 Ethernet frames** inside GRE (IP protocol 47). It is:

-   **Kernel‑accelerated** — no userspace forwarding loop.
-   **Lower overhead** — ~38 bytes vs. 50 bytes (VXLAN) plus our custom framing.
-   **Transparent** — bridges natively carry ARP, DHCP, IPv6, and broadcast traffic.
-   **A perfect fit for the WDS scenario** — a direct, NAT‑free L2 link is exactly the case where GRETAP shines.

Full technical justification is in the accompanying analysis document (GRETAP vs. VXLAN, MTU considerations, broadcast‑domain notes).

---

## 2. Architecture Change at a Glance

```
BEFORE (udp_relay)                          AFTER (GRETAP library)

  app  ──►  TUN dev  ──►  userspace  ──►     app  ──►  bridge br-<name>
              (L3)          relay                       │
                           (UDP)                       ├── gretap<name>  (L2 over GRE)
                                                       │        │
                                                       │        └──► IP proto 47 ──► WDS link
                                                       │
                                                       └── local LAN NIC (eth1)
```

Key consequences:

| Area            | Before                      | After                                        |
| :-------------- | :-------------------------- | :------------------------------------------- |
| Data path       | Userspace relay process     | Kernel (bridge + gretap)                     |
| Layer           | L3 (IP)                     | L2 (Ethernet)                                |
| Traffic carried | IPv4/IPv6 only              | All EtherTypes (ARP, DHCP, LLDP, IPv6 ND, …) |
| Config point    | Library constructor         | `ip` commands (executed by library)          |
| User‑space deps | `bun`/`node`, socket layer  | Only `iproute2` (`ip`), `CAP_NET_ADMIN`      |
| MTU             | 1500 (tunnel), 1600 (outer) | same recommendation: 1500 / 1600             |

---

## 3. Prerequisites

Both Ubuntu boxes must satisfy the following before integration begins.

### 3.1 System

-   **Ubuntu 22.04 LTS or newer** (kernel ≥ 5.15 — GRETAP is available in all modern kernels).
-   `iproute2` installed (`sudo apt install iproute2` — usually present by default).
-   The `gretap` module is either built‑in or loadable:
    ```bash
    sudo modprobe gretap && lsmod | grep gretap
    ```

### 3.2 Network

-   Both boxes have a **physical interface connected to the Loco M5 WDS bridge**, with an IP in the same subnet on both sides.
    -   Example: Box A `192.168.1.1/24`, Box B `192.168.1.2/24` on `eth0`.
-   Each box has a **separate local LAN interface** (e.g. `eth1`) which will be bridged into the tunnel. This is the interface whose traffic you want to extend across the WDS link.
-   Physical MTU on the WDS‑facing interface raised to **1600**:
    ```bash
    sudo ip link set dev eth0 mtu 1600
    ```
    Confirmed safe on Loco M5 (supports jumbo frames up to 2024 B).
-   **Firewall**: allow **IP protocol 47 (GRE)** between the two WDS‑link addresses. If `ufw` is enabled:
    ```bash
    sudo ufw allow proto gre from 192.168.1.2 to 192.168.1.1
    sudo ufw allow proto gre from 192.168.1.1 to 192.168.1.2
    ```

### 3.3 Privileges

-   The process running the library needs `CAP_NET_ADMIN` (or to run as root / under `sudo`) — the same requirement the original `udp_relay` had for opening a TUN device.

### 3.4 Tooling

-   TypeScript ≥ 5.0, Node ≥ 20 or Bun (unchanged from the original library).
-   `node:child_process` — the library shells out to `ip`; no other npm dependency is required.

---

## 4. Library Reference

The replacement library exports the **same public API surface** as `shared/lib/udp_relay`. See the full source provided with this handoff (`gretap_relay/index.ts`). The summary:

### 4.1 Exported types

```typescript
interface Stats {
    rxBytes;
    txBytes;
    rxPackets;
    txPackets;
    drops;
}

interface VirtualInterfaceOptions {
    name: string; // gretap iface name (≤ 15 chars)
    localIp: string; // IP on the WDS link, this side
    prefixLength: number;
    relay: { host: string; port: number }; // host = peer IP on WDS link; port unused
    bindAddress?: string; // ignored (kept for API compat)
    mtu?: number; // default 1500
    keepaliveIntervalMs?: number; // ignored (kernel handles GRE keepalives if enabled)
    onStats?: (s: Stats) => void; // reserved; not emitted yet
    tunDevice?: unknown; // test seam, ignored
}

interface UdpRelayOptions {
    interfaceName: string;
    listenPort: number;
    destination: { host: string; port: number };
    interfaceAddress?: string;
    onStats?: (s: Stats) => void;
}

interface VirtualInterface {
    start(): Promise<void>;
    stop(): Promise<void>;
}
interface UdpRelay {
    start(): Promise<void>;
    stop(): Promise<void>;
}
```

### 4.2 Exported functions

| Function                       | Behaviour (new implementation)                                                                                                                                                                                                                       |
| :----------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createVirtualInterface(opts)` | Returns a handle. `start()` creates `gretap<name>`, sets MTU 1500, creates bridge `br-<name>`, attaches the gretap **and** the interface holding `localIp` to the bridge, and brings everything up. `stop()` tears everything down in reverse order. |
| `createUdpRelay(opts)`         | **No‑op** — returns an object whose `start()`/`stop()` do nothing. Kept so downstream code compiles unchanged.                                                                                                                                       |
| `listInterfaces()`             | Lists existing GRETAP interfaces on the host (`ip -o link show type gretap`).                                                                                                                                                                        |
| `protocol.maxPayload(mtu)`     | Returns `mtu - 38` (GRETAP overhead).                                                                                                                                                                                                                |
| `ip.isValid(s)`                | IPv4 format check (unchanged).                                                                                                                                                                                                                       |

### 4.3 Behavioural differences to be aware of

| Behaviour             | Before                             | After                                        |
| :-------------------- | :--------------------------------- | :------------------------------------------- |
| `relay.port`          | Real UDP port on the relay side    | **Ignored** — GRETAP is portless             |
| `keepaliveIntervalMs` | Sent `0x02` frames                 | **Ignored** — GRE keepalives are kernel‑side |
| `onStats` callback    | Periodic stats from the relay loop | **Not emitted** (planned follow‑up; see §9)  |
| `bindAddress`         | Bound UDP socket source            | **Ignored**                                  |
| `tunDevice`           | Injected TUN for tests             | Accepted but **ignored**                     |

Every caller that compiled against the old API will **still compile** against the new one, provided it does not rely on the ignored options (see §7 checklist).

---

## 5. Integration Steps

Follow these in order. Steps 1–3 can be done per‑endpoint in any sequence; steps 4–7 must be validated together.

### Step 1 — Drop in the new library

1. Create the new package directory: `shared/lib/gretap_relay/`.
2. Copy `index.ts` (provided with this handoff) into it.
3. Add `package.json`, `tsconfig.json` mirroring `shared/lib/udp_relay` so the build pipeline and workspace resolution are unchanged.
4. In the workspace root (`package.json` / `tsconfig.base.json` / `bun.lockb` or `pnpm-workspace.yaml`), register the new package **alongside** the old one. Do **not** delete `udp_relay` yet — keep it as a fallback during cutover.

### Step 2 — Update imports (mechanical)

Search the repo for imports of `udp_relay`:

```bash
rg "from ['\"].*udp_relay" -l
rg "require\(['\"].*udp_relay" -l
```

For each hit, change the import path to `gretap_relay`. Because the exported names and signatures are identical, no call‑site logic changes should be needed at this step.

> **Suggested commit:** `chore: switch imports from udp_relay to gretap_relay (behaviour unchanged, not yet wired)`.

### Step 3 — Update runtime configuration

Anywhere the app builds a `VirtualInterfaceOptions` object, verify the following:

| Config field | Required change                                                                                              |
| :----------- | :----------------------------------------------------------------------------------------------------------- |
| `relay.host` | Must be the **peer’s IP on the WDS link** (was the relay’s UDP host — usually the same address, confirm).    |
| `relay.port` | Set to `0` or leave as‑is; **it is ignored**.                                                                |
| `localIp`    | Must be the **IP assigned to the WDS‑facing interface** on _this_ box (not the LAN IP that will be bridged). |
| `mtu`        | Leave at 1500 unless the LAN requires a smaller value.                                                       |
| `name`       | ≤ 15 characters (kernel interface name limit). Check existing names; rename if any are longer.               |

Document each real deployment (Box A and Box B) with the actual addresses in the deployment runbook (see §6).

### Step 4 — Prepare both endpoints (one‑time, per box)

On **Box A** and **Box B**:

```bash
# 1. Outer MTU on the WDS-facing interface (substitute your iface name)
sudo ip link set dev <wds-iface> mtu 1600

# 2. Load gretap if not built-in
sudo modprobe gretap

# 3. Firewall — allow IP protocol 47 in both directions between WDS IPs
sudo ufw allow proto gre from <peer-ip> to <local-ip>
```

Confirm before proceeding:

```bash
ip -d link show <wds-iface> | grep mtu      # expect: mtu 1600
ping -c3 <peer-ip>                          # basic L3 reachability
```

### Step 5 — Bring up the tunnel and validate

Start the application (or a short test harness) that calls `createVirtualInterface(...).start()` on **both** boxes.

Immediately on both boxes check:

```bash
ip -d link show gretap<name>      # state UP, mtu 1500
ip -d link show br-<name>         # state UP
bridge link show                  # gretap<name> and the LAN NIC as ports
bridge fdb show br br-<name> | head
```

Then validate the data plane from **Box A’s LAN side**:

```bash
# From a host plugged into Box A's LAN interface:
ping <a-host-on-Box-B-lan>
arping -I <lan-iface> <b-host-on-Box-B-lan>
```

If ARP and ping succeed across the bridge **without any NAT or routing on the boxes**, the tunnel is working.

### Step 6 — Port the caller’s lifecycle

If the caller previously did:

```typescript
const relay = await createUdpRelay({ ... });
await relay.start();
// ...
await relay.stop();
```

…then that code can stay untouched (it’s a no‑op). But if the caller relied on the relay object for **anything other than start/stop** (e.g. reading `relay.stats`), replace that dependency with the documented follow‑up in §9 before deleting the old package.

### Step 7 — Delete the old library

Only after both endpoints run through GRETAP in the target environment for a full soak window (suggest **72 h** with production traffic):

1. Remove all remaining references:
    ```bash
    rg "udp_relay"    # should return nothing
    ```
2. Delete `shared/lib/udp_relay/`.
3. Remove its entry from workspace manifests.
4. Commit: `chore: remove legacy udp_relay (superseded by gretap_relay)`.

---

## 6. Deployment Runbook (fill‑in per site)

Record concrete values for each installation.

| Field                   | Box A                             | Box B                             |
| :---------------------- | :-------------------------------- | :-------------------------------- |
| WDS‑facing interface    | `eth0`                            | `eth0`                            |
| WDS‑link IP (this side) | `192.168.1.___/24`                | `192.168.1.___/24`                |
| Local LAN interface     | `eth1`                            | `eth1`                            |
| LAN subnet (bridged)    | `10.3.3.0/24`                     | `10.3.3.0/24`                     |
| `gretap` interface name | `moblink0`                        | `moblink0`                        |
| Bridge name             | `br-moblink0`                     | `br-moblink0`                     |
| Tunnel MTU              | 1500                              | 1500                              |
| Outer (WDS) MTU         | 1600                              | 1600                              |
| GRE firewall rule       | `ufw allow proto gre from <peer>` | `ufw allow proto gre from <peer>` |

**Verification commands to record in the site’s runbook:**

```bash
# Tunnel health
ip -d link show gretap<name> | grep -E 'state|mtu'
bridge fdb show br br-<name> | wc -l     # non-zero = MACs learning

# Data-plane reachability (from LAN side)
ping -c5  <peer-side-lan-host>
arping -c3 -I <lan-iface> <peer-side-lan-host>

# MTU / fragmentation check
ping -M do -s 1472 <peer-side-lan-host>   # must succeed
```

---

## 7. Migration Checklist

Copy this list into the tracking ticket and tick each item.

-   [ ] `gretap` kernel module available on both boxes
-   [ ] `iproute2` installed; `ip` works without sudo on the service user (or the service runs with `CAP_NET_ADMIN`)
-   [ ] Physical WDS‑facing MTU raised to 1600 on both boxes
-   [ ] Firewall allows IP protocol 47 between the two WDS IPs
-   [ ] All imports of `udp_relay` changed to `gretap_relay`
-   [ ] `relay.host` reviewed on every call site — must equal the peer WDS IP
-   [ ] `relay.port` reviewed — value ignored, no code depends on it
-   [ ] Any use of `onStats` accounted for (currently unsupported — see §9)
-   [ ] Any use of `relay` object beyond `start()` / `stop()` accounted for
-   [ ] Interface names ≤ 15 characters
-   [ ] Both endpoints bring the tunnel up cleanly
-   [ ] ARP + ping across the bridge from LAN→LAN validated
-   [ ] MTU end‑to‑end validated with `ping -M do -s 1472`
-   [ ] Soak test run for ≥ 72 h
-   [ ] `udp_relay` removed from workspace
-   [ ] Runbook updated with real site values (§6)

---

## 8. Troubleshooting

| Symptom                                                    | Likely cause                                               | Fix                                                                                                                                               |
| :--------------------------------------------------------- | :--------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------ |
| `RTNETLINK answers: File exists` on `start()`              | Leftover `gretap`/bridge from a previous run               | `ip link del gretap<name>; ip link del br-<name>` then retry                                                                                      |
| `Operation not permitted`                                  | Missing `CAP_NET_ADMIN`                                    | Run the service as root or grant `CAP_NET_ADMIN` to the binary/unit                                                                               |
| `ping` works between WDS IPs but **not** across the bridge | Bridge not up, or LAN NIC missing                          | `bridge link show` — confirm both ports present; `ip link set br-<name> up`                                                                       |
| Intermittent drops on large packets                        | Outer MTU too low / path fragmentation                     | Confirm `mtu 1600` on the WDS interface on both sides; test with `ping -M do -s 1472`                                                             |
| No GRE packets arrive                                      | Firewall blocking IP protocol 47                           | `sudo tcpdump -ni <wds-iface> proto gre` on both boxes; open firewall                                                                             |
| Bridge shows `state DOWN`                                  | Bridge created but never brought up                        | The library does `ip link set br-<name> up` in `start()`; if you see this, `start()` did not complete — check exit codes                          |
| Tunnel comes up but duplicate MACs / loop                  | Both sides bridged into a domain that is already connected | Ensure the two LANs are only joined by the GRETAP tunnel; disable STP or enable it deliberately (`ip link set br-<name> type bridge stp_state 1`) |
| After reboot, no tunnel                                    | Library state is not persisted                             | Wire `start()` into a systemd unit or a network‑online hook — persistence is the integrator’s responsibility (out of scope for this library)      |

For deeper debugging, capture on both boxes simultaneously:

```bash
sudo tcpdump -ni <wds-iface> proto gre -w /tmp/gre-$(hostname).pcap
```

---

## 9. Known Limitations & Follow‑ups

-   **`onStats` is not emitted.** The original relay emitted periodic counters from its userspace loop. The GRETAP implementation has no loop to report from. A follow‑up task should read counters from `ip -s link show <gretap>` and `/sys/class/net/<gretap>/statistics/{rx,tx}_{bytes,packets,dropped}` and invoke `onStats` on the configured interval. Track as a separate ticket.
-   **No persistence.** The library creates interfaces at runtime; it does not install systemd units or Netplan configs. If persistence is required, wrap `start()`/`stop()` in a systemd unit (`Type=oneshot` + `RemainAfterExit=yes`) or an equivalent. The analysis document contains a Netplan example if that path is preferred.
-   **No encryption.** GRETAP itself does not encrypt traffic. If the radio link is not trusted, run the tunnel over WireGuard or IPsec, accepting additional overhead. This matches the original `udp_relay` (also unencrypted).
-   **Broadcast‑domain extension.** Safe for two boxes; revisit if the topology grows.
-   **Linux‑only.** Like the original library, this requires a Linux host (`ip` command, `gretap` driver).
-   **`bindAddress`, `keepaliveIntervalMs`, `tunDevice` ignored.** Accepted for API compatibility; behaviour is defined by the kernel.

---

## 10. Rollback Plan

If GRETAP must be backed out:

1. Stop the application on both boxes.
2. Run `virtualInterface.stop()` (or manually: `ip link del br-<name>; ip link del gretap<name>`).
3. Revert the import changes from Step 2 (single commit).
4. Re‑enable the `udp_relay` package in the workspace.
5. Restart the application with the original config.

The old library is **not deleted until §7 soak passes**, so rollback is a single‑commit revert at any time before that point.

---

## 11. References

-   **Original library:** `shared/lib/udp_relay` — https://github.com/majklovec/irlctrl/tree/main/shared/lib/udp_relay
-   **Reference for the relay pattern:** `moblink-rust` — https://github.com/datagutt/moblink-rust
-   **Kernel GRETAP docs:** https://www.kernel.org/doc/Documentation/networking/ip-tunnel.txt (see “GRETAP”)
-   **`ip link` manpage (gretap section):** `man ip-link`
-   **MTU / Loco M5 notes:** see accompanying analysis document (GRETAP vs. VXLAN, MTU 1600/1500 recommendation)
-   **New library source:** `shared/lib/gretap_relay/index.ts` (attached to this handoff)

---

**Please acknowledge receipt and open the tracking ticket with the §7 checklist. Questions on the library internals → [library owner]. Questions on the WDS / Loco M5 side → [network owner].**
