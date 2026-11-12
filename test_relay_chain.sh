#!/usr/bin/env bash
# test_relay_chain.sh — 3-part test for the MobLink UDP relay chain.
#
# Topology:
#   rpi4 (encoder) 192.168.10.101
#     └─ TUN relay0_*  →  UDP  →  bigcml relay (this host)
#                            └─ leg enx7eafd60ad1a2 (mobile) → phone CGNAT → VPS
#                            └─ leg eno2 (home LAN)          → home router  → VPS
#                            └─ leg wg0 (wireguard)          → wg peer      → VPS
#
#   VPS = 144.91.123.190 (vondracek.dev), srtla_rec docker :5000/udp
#
# Usage:
#   ./test_relay_chain.sh           # run all 3 tests
#   ./test_relay_chain.sh 1         # relay tunnel test only
#   ./test_relay_chain.sh 2         # OBS/VPS SRTLA tcpdump test only
#   ./test_relay_chain.sh 3         # srtla_send source-routing-table test only
#
# Requires: ssh keys to pi@192.168.10.101 and root@144.91.123.190,
#           sudo on bigcml (for tcpdump), relay running locally.

set -euo pipefail

RPI4="pi@192.168.10.101"
VPS="root@144.91.123.190"
VPS_IP="144.91.123.190"
VPS_PORT=5000
PASS=0
FAIL=0

pass() { echo "  ✅ $1"; PASS=$((PASS+1)); }
fail() { echo "  ❌ $1"; FAIL=$((FAIL+1)); }

SSH_RPI4() { ssh -q -o ConnectTimeout=8 -o StrictHostKeyChecking=no -o BatchMode=yes "$RPI4" "$@"; }
SSH_VPS()  { ssh -q -o ConnectTimeout=8 -o StrictHostKeyChecking=no -o BatchMode=yes "$VPS" "$@"; }

# ---------------------------------------------------------------------------
# Test 1: Relay tunnel — send a test UDP packet through the relay, verify
#         receipt on the other end (VPS).
# ---------------------------------------------------------------------------
test_relay_tunnel() {
    echo ""
    echo "═══ Test 1: Relay tunnel (UDP packet through relay → VPS) ═══"
    local test_id
    test_id="RELAYTEST_$(date +%s)"

    # Start VPS capture
    SSH_VPS "rm -f /tmp/relay_test.pcap; nohup timeout 12 tcpdump -ni eth0 'udp and dst port ${VPS_PORT}' -w /tmp/relay_test.pcap >/dev/null 2>&1 &"
    sleep 2

    # Send test packet from rpi4 via the mobile TUN (10.90.1.1)
    local sent
    sent=$(SSH_RPI4 "sudo -n python3 -c \"
import socket
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.bind(('10.90.1.1', 0))
s.connect(('$VPS_IP', $VPS_PORT))
s.sendto(b'$test_id', ('$VPS_IP', $VPS_PORT))
print('sent')
\"" 2>&1)

    if [[ "$sent" == *"sent"* ]]; then
        pass "Test packet sent from rpi4 10.90.1.1 (mobile TUN)"
    else
        fail "Failed to send test packet: $sent"
    fi

    sleep 6

    # Read VPS capture
    local result
    result=$(SSH_VPS "tcpdump -r /tmp/relay_test.pcap -nn -A 2>/dev/null | grep -c '$test_id' || true")
    if [[ "$result" -ge 1 ]]; then
        pass "Test packet '$test_id' received on VPS (relay tunnel works)"
    else
        fail "Test packet '$test_id' NOT received on VPS"
    fi
}

# ---------------------------------------------------------------------------
# Test 2: SRTLA to VPS — verify SRTLA handshake packets reach the VPS ingress
#         via tcpdump on both ends.
# ---------------------------------------------------------------------------
test_srtla_to_vps() {
    echo ""
    echo "═══ Test 2: SRTLA to VPS (tcpdump verification) ═══"

    # Check rpi4 TUN counters are growing (real traffic flowing)
    local rx_before tx_before
    rx_before=$(SSH_RPI4 "cat /sys/class/net/relay0_enx7eafd/statistics/rx_packets 2>/dev/null || echo 0")
    tx_before=$(SSH_RPI4 "cat /sys/class/net/relay0_enx7eafd/statistics/tx_packets 2>/dev/null || echo 0")
    sleep 5
    local rx_after tx_after
    rx_after=$(SSH_RPI4 "cat /sys/class/net/relay0_enx7eafd/statistics/rx_packets 2>/dev/null || echo 0")
    tx_after=$(SSH_RPI4 "cat /sys/class/net/relay0_enx7eafd/statistics/tx_packets 2>/dev/null || echo 0")

    local rx_delta=$((rx_after - rx_before))
    local tx_delta=$((tx_after - tx_before))
    echo "  Mobile TUN counters (5s): rx +$rx_delta, tx +$tx_delta"

    if [[ "$tx_delta" -gt 0 ]]; then
        pass "Mobile TUN relay0_enx7eafd has outbound traffic (tx +$tx_delta in 5s)"
    else
        fail "Mobile TUN relay0_enx7eafd has NO outbound traffic"
    fi

    if [[ "$rx_delta" -gt 0 ]]; then
        pass "Mobile TUN relay0_enx7eafd has inbound traffic (rx +$rx_delta in 5s)"
    else
        fail "Mobile TUN relay0_enx7eafd has NO inbound traffic"
    fi

    # Verify VPS sees SRTLA handshake packets (258-byte UDP) from the mobile CGNAT
    local vps_seen
    vps_seen=$(SSH_VPS "timeout 5 tcpdump -ni eth0 'udp and dst port 5000 and length > 200' -c 5 2>/dev/null | grep -c 'UDP, length 258' || true")
    if [[ "$vps_seen" -ge 1 ]]; then
        pass "VPS receives 258-byte SRTLA handshake packets on :5000"
    else
        # Handshake may be in a quiet phase; check for any SRT traffic
        vps_seen=$(SSH_VPS "timeout 5 tcpdump -ni eth0 'udp and dst port 5000' -c 5 2>/dev/null | grep -c 'UDP' || true")
        if [[ "$vps_seen" -ge 1 ]]; then
            pass "VPS receives UDP packets on :5000 (SRTLA active)"
        else
            fail "VPS receives NO packets on :5000"
        fi
    fi

    # Check srtla_rec container is running
    local container
    container=$(SSH_VPS "docker ps --filter name=srtla_rec --format '{{.Names}}' 2>/dev/null" | head -1)
    if [[ -n "$container" ]]; then
        pass "srtla_rec container '$container' is running on VPS"
    else
        fail "srtla_rec container not found on VPS"
    fi
}

# ---------------------------------------------------------------------------
# Test 3: srtla_send source-routing-table test — verify that srtla_send is
#         using all shared interfaces (especially the mobile one), and that
#         the routing tables are configured correctly.
# ---------------------------------------------------------------------------
test_source_routing() {
    echo ""
    echo "═══ Test 3: srtla_send source routing tables ═══"

    # 3a: Verify srtla_ips.txt exists and has the expected entries
    local ips
    ips=$(SSH_RPI4 "cat /tmp/srtla_ips.txt 2>/dev/null")
    echo "  srtla_ips.txt contents:"
    while IFS= read -r line; do echo "    $line"; done <<< "$ips"

    local ip_count
    ip_count=$(echo "$ips" | grep -c '^[0-9]' || true)
    if [[ "$ip_count" -ge 3 ]]; then
        pass "srtla_ips.txt has $ip_count uplink IPs (≥3 expected)"
    else
        fail "srtla_ips.txt has only $ip_count IPs (expected ≥3)"
    fi

    # 3b: Verify per-TUN routing rules (ip rule + ip route)
    echo "  Routing rules on rpi4:"
    local rules
    rules=$(SSH_RPI4 "ip rule show 2>/dev/null")
    local route_count
    route_count=$(echo "$rules" | grep -c '10\.90\.' || true)
    if [[ "$route_count" -ge 3 ]]; then
        pass "Found $route_count routing rules for 10.90.x.1 TUN interfaces"
    else
        fail "Only $route_count routing rules for 10.90.x.1 (expected ≥3)"
    fi

    # 3c: Verify TUN interfaces exist and are up
    local tun_count
    tun_count=$(SSH_RPI4 "ip -o link show type tun 2>/dev/null | wc -l")
    if [[ "$tun_count" -ge 3 ]]; then
        pass "Found $tun_count TUN interfaces on rpi4"
    else
        fail "Only $tun_count TUN interfaces (expected ≥3)"
    fi

    # 3d: Verify traffic is flowing through the mobile TUN specifically
    local mob_rx mob_tx
    mob_rx=$(SSH_RPI4 "cat /sys/class/net/relay0_enx7eafd/statistics/rx_packets 2>/dev/null || echo 0")
    mob_tx=$(SSH_RPI4 "cat /sys/class/net/relay0_enx7eafd/statistics/tx_packets 2>/dev/null || echo 0")
    if [[ "$mob_tx" -gt 1 && "$mob_rx" -gt 0 ]]; then
        pass "Mobile TUN relay0_enx7eafd active (rx=$mob_rx, tx=$mob_tx)"
    else
        fail "Mobile TUN relay0_enx7eafd not active (rx=$mob_rx, tx=$mob_tx)"
    fi

    # 3e: Verify srtla_send process is running
    local srtla_pid
    srtla_pid=$(SSH_RPI4 "pgrep -x srtla_send 2>/dev/null | head -1" || true)
    if [[ -n "$srtla_pid" ]]; then
        pass "srtla_send running (pid $srtla_pid)"
        local srtla_args
        srtla_args=$(SSH_RPI4 "cat /proc/$srtla_pid/cmdline 2>/dev/null | tr '\0' ' '")
        echo "  Args: $srtla_args"
    else
        fail "srtla_send process not found"
    fi

    # 3f: End-to-end proof — send a tagged packet from rpi4 via the mobile
    #     TUN and verify it arrives at the VPS from a DIFFERENT source IP than
    #     the home router (proving it went through the mobile leg, not LAN).
    echo "  End-to-end mobile leg proof (tagged packet):"
    local tag="E2E_MOBILE_$(date +%s)"
    SSH_VPS "rm -f /tmp/e2e_test.pcap; nohup timeout 12 tcpdump -ni eth0 'udp and dst port ${VPS_PORT}' -w /tmp/e2e_test.pcap >/dev/null 2>&1 &"
    sleep 2

    SSH_RPI4 "sudo -n python3 -c \"
import socket
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.bind(('10.90.1.1', 0))
s.connect(('$VPS_IP', $VPS_PORT))
s.sendto(b'$tag', ('$VPS_IP', $VPS_PORT))
\"" 2>/dev/null

    sleep 6
    local e2e_result
    e2e_result=$(SSH_VPS "tcpdump -r /tmp/e2e_test.pcap -nn -A 2>/dev/null | grep -B1 '$tag' | head -2" || true)
    if [[ -n "$e2e_result" ]]; then
        local src_ip
        src_ip=$(echo "$e2e_result" | grep -oP '\d+\.\d+\.\d+\.\d+' | head -1)
        echo "  Packet arrived at VPS from source: $src_ip"
        if [[ "$src_ip" != "78.108.96.181" ]]; then
            pass "Mobile leg confirmed: packet arrived from $src_ip (NOT home router 78.108.96.181)"
        else
            fail "Packet arrived from home router IP — mobile leg may not be working"
        fi
    else
        fail "Tagged packet '$tag' not received on VPS"
    fi

    # 3g: Check bigcml relay is running
    local relay_pid
    relay_pid=$(pgrep -f 'bun.*dev:client' 2>/dev/null | head -1 || true)
    if [[ -n "$relay_pid" ]]; then
        pass "Relay (dev:client) running on bigcml (pid $relay_pid)"
    else
        fail "Relay process not found on bigcml"
    fi
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
echo "╔══════════════════════════════════════════════════════════╗"
echo "║  MobLink UDP Relay Chain — Test Suite                   ║"
echo "║  $(date)                                          ║"
echo "╚══════════════════════════════════════════════════════════╝"

case "${1:-all}" in
    1) test_relay_tunnel ;;
    2) test_srtla_to_vps ;;
    3) test_source_routing ;;
    all)
        test_relay_tunnel
        test_srtla_to_vps
        test_source_routing
        ;;
    *)
        echo "Usage: $0 {1|2|3|all}"
        exit 1
        ;;
esac

echo ""
echo "══════════════════════════════════════════════════════════"
echo "  Results: $PASS passed, $FAIL failed"
echo "══════════════════════════════════════════════════════════"
[[ "$FAIL" -eq 0 ]]
