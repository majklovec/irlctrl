Tohole to vsechno nastavi spravne pojmenovani WWAN rozhrani a MAC adresy pro Huawei modemy.

```sh
#!/usr/bin/env bash
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
   echo "Error: Please run this script as root (sudo)." >&2
   exit 1
fi

echo "[1/5] Cleaning up old/conflicting naming rules..."
rm -f /etc/systemd/network/00-wwan-path-naming.link \
      /etc/systemd/network/10-wwan-path-naming.link \
      /etc/udev/rules.d/75-huawei-mac.rules \
      /etc/udev/rules.d/75-huawei-universal-mac.rules \
      /etc/udev/rules.d/75-huawei-port-mac.rules

echo "[2/5] Creating MAC & ARP helper script (/usr/local/sbin/set-huawei-port-mac.sh)..."
cat << 'EOF' > /usr/local/sbin/set-huawei-port-mac.sh
#!/usr/bin/env bash
IFACE="$1"
[[ -z "$IFACE" || ! -e "/sys/class/net/$IFACE/device" ]] && exit 0

PORT=$(basename "$(dirname "$(readlink -f "/sys/class/net/$IFACE/device")")")
HASH=$(printf '%s' "$PORT" | md5sum)
NEW_MAC="02:${HASH:0:2}:${HASH:2:2}:${HASH:4:2}:${HASH:6:2}:${HASH:8:2}"

ip link set dev "$IFACE" down 2>/dev/null || true
ip link set dev "$IFACE" address "$NEW_MAC" arp off
EOF
chmod 0755 /usr/local/sbin/set-huawei-port-mac.sh

echo "[3/5] Installing WWAN naming & MAC udev rule (/etc/udev/rules.d/85-huawei-port-mac.rules)..."
cat << 'EOF' > /etc/udev/rules.d/85-huawei-port-mac.rules
SUBSYSTEM=="net", ACTION=="add", ATTRS{idVendor}=="12d1", PROGRAM="/bin/bash -c 'PORT=$(basename $(dirname $(readlink -f /sys/class/net/%k/device))); echo wwp${PORT//[-.]/u} | cut -c1-15'", NAME="%c", RUN+="/usr/local/sbin/set-huawei-port-mac.sh %c"
EOF
chmod 0644 /etc/udev/rules.d/85-huawei-port-mac.rules

echo "[4/5] Installing UDisks ignore rule (/etc/udev/rules.d/99-huawei-modem-ignore.rules)..."
cat << 'EOF' > /etc/udev/rules.d/99-huawei-modem-ignore.rules
ACTION=="add", SUBSYSTEM=="usb", ATTR{idVendor}=="12d1", ATTR{idProduct}=="1506", ENV{UDISKS_IGNORE}="1"
EOF
chmod 0644 /etc/udev/rules.d/99-huawei-modem-ignore.rules

echo "[5/5] Reloading udev rules and updating initramfs..."
udevadm control --reload-rules
udevadm trigger --subsystem-match=usb --attr-match=idVendor=12d1 --attr-match=idProduct=1506
if command -v update-initramfs >/dev/null 2>&1; then
    update-initramfs -u
fi

# Re-bind any currently attached Huawei NCM/WWAN USB interfaces so naming/MAC/ARP apply immediately
for dev in /sys/class/net/*; do
    [[ -e "$dev/device" ]] || continue
    if udevadm info -a -p "$dev" 2>/dev/null | grep -q 'ATTRS{idVendor}=="12d1"'; then
        IFACE=$(basename "$dev")
        USB_IFACE=$(basename "$(readlink -f "$dev/device")")
        DRIVER=$(basename "$(readlink -f "$dev/device/driver")" 2>/dev/null || true)
        if [[ -n "$DRIVER" && -e "/sys/bus/usb/drivers/$DRIVER/unbind" ]]; then
            echo "Rebinding $IFACE ($USB_IFACE on $DRIVER)..."
            echo "$USB_IFACE" > "/sys/bus/usb/drivers/$DRIVER/unbind"
            sleep 0.5
            echo "$USB_IFACE" > "/sys/bus/usb/drivers/$DRIVER/bind"
        fi
    fi
done

echo ""
echo "Done! Current WWAN interfaces:"
ip -br link show | grep ww || echo "No WWAN interfaces found."
```
