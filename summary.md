# MobLink UDP Relay + SRTLA — Progress Summary

**STATUS: ✅ FULL CHAIN WORKING — video streaming end-to-end through the mobile leg**

## Topology

```
rpi4 (192.168.10.101)          bigcml (relay)                    egress
────────────────────────       ────────────────                    ─────────────────────
ceracoder ─SRT:9000─► srtla_send ──UDP/SRTLA──► TUN legs ───────────────────► VPS 144.91.123.190:5000
  (x264)          (enhanced, 4-IP bond)                              192.168.10.101 → 78.108.96.181 (home)
                                                                  10.90.0.1        → 78.108.96.181 (home)
                                                                  10.90.1.1 (mobile) → 46.135.163.163 (phone CGNAT) ✓
                                                                  10.90.2.1 (wg0)   → (no egress)
        VPS:5000 ─srtla_rec(host net)─► 127.0.0.1:1234 ─real SRT server─► file://con
Live OBS SRTLA ingress: 83.208.44.38:5000
```

## ✅ RESULTS (all verified)

### 1. Relay tunnel (both directions, all legs) — PASS
- Test suite `test_relay_chain.sh`: **13/13 checks green.**
- 294-byte data frames on bigcml `eno1` both ways; mobile TUN `relay0_enx7eafd` active both ways.

### 2. SRTLA to VPS (tcpdump) — PASS
- VPS receives UDP on :5000; `srtla_rec` container running.

### 3. srtla_send source routing — PASS
- 4-IP bond, 3 routing rules, 3 TUNs, srtla_send pid 216931.
- **Mobile leg proven end-to-end**: tagged packet from `10.90.1.1` arrived at VPS from
  `46.135.163.163` (phone CGNAT), NOT the home router.

### 4. Final test: `bardiir/srtla_rec` on VPS + `srtla_send` on rpi4 (all shared ifaces incl. mobile) — ✅ WORKING
- **Sustained 893 kbps video** (3,350,528 bytes / 30 s) delivered to the SRT sink on the VPS.
- SRT handshake completes; group is stable (no group termination, only normal SRT-LA conn rotation).
- ceracoder: `SRT connected to 127.0.0.1:9000. Negotiated latency: 2000 ms`.
- Mobile TUN throughput: 284 kbps up-from-TUN.

## ROOT CAUSES of the earlier SRT-layer deadlock (both fixed)

The chain (relay, routing, SRT-LA) was fine all along. The final blocker was in the **VPS test
sink setup**, two independent faults:

### Fault A — `srtla_rec` container on `bridge` network (isolated loopback)
- `bardiir/srtla_rec 5000 127.0.0.1 1234` opens `g->srt_sock` and `connect()`s it to
  `127.0.0.1:1234`. On `--network bridge` that is the **container's own loopback** — nothing
  listens there → `recv()` returns −1 (ECONNREFUSED) → `n < SRT_MIN_LEN (16)` →
  **`group_destroy`** in a loop.
- **Fix:** `docker run -d --network host bardiir/srtla_rec 5000 127.0.0.1 1234` so
  `127.0.0.1` == host loopback.

### Fault B — sink was a `socat /dev/null` black-hole
- The sink must be a **real SRT server** that completes the SRT handshake and sends ACKs back.
  `socat UDP-LISTEN:1234 /dev/null` silently drops, so the handshake never completes and any
  small/absent reply again triggers the `< SRT_MIN_LEN` group destroy.
- **Fix:** built `srt-live-transmit` (SRT v1.5.4) on the VPS and run it as the SRT listener:
  `/opt/srt/build/srt-live-transmit "srt://127.0.0.1:1234?mode=listener&srtconntimeout=30000" "file://con"`

With both fixed: egress link stabilizes → `srtla_send` (enhanced mode) opens its `:9000` intake →
ceracoder connects → **video flows** through all shared interfaces (incl. the mobile-tether leg).

## State of the world
- rpi4: client-arm 210630, ceracoder 210670, srtla_send 216931 (4-IP bond). enc.json → VPS 144.91.123.190:5000 (`enc.json.bak_obs` = OBS original).
- bigcml: relay `dev:client` pid 2369364, 3 `relay0_*` TUNs up, paired (mobile leg carries the stream).
- VPS: `srtla_rec_test` running **`--network host`** (:5000/udp); `srt-live-transmit` SRT listener on 127.0.0.1:1234 (pid 65328).

## To point at real OBS
1. rpi4: `cp /home/pi/app/enc.json.bak_obs /home/pi/app/enc.json` (or set `stream.remoteHost=83.208.44.38`), then `sudo -n pkill -x srtla_send` (client-arm relaunches).
2. Verify: `VPS_IP=83.208.44.38 bash test_relay_chain.sh all`.
3. OBS SRTLA ingress will receive the stream on 83.208.44.38:5000.

## Cleanup done
- VPS temp pcaps removed. rpi4 bond restored to 4 IPs. (Remaining throwaway: rpi4 `/tmp/srtla_ips.txt.all`, bigcml `/tmp/srtla_cap/`, `/tmp/relay_status.mjs`, VPS `/opt/srt` build tree.)
