#!/usr/bin/env bash
IFACE="$1"
[[ -z "$IFACE" || ! -e "/sys/class/net/$IFACE/device" ]] && exit 0

PORT=$(basename "$(dirname "$(readlink -f "/sys/class/net/$IFACE/device")")")
HASH=$(printf '%s' "$PORT" | md5sum)
NEW_MAC="02:${HASH:0:2}:${HASH:2:2}:${HASH:4:2}:${HASH:6:2}:${HASH:8:2}"

ip link set dev "$IFACE" down 2>/dev/null || true
ip link set dev "$IFACE" address "$NEW_MAC"
