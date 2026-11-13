On Ubuntu and Debian, systemd-udevd names USB network interfaces after their MAC address (wwx... / enx...) by default because MACAddressPolicy or NamePolicy prioritizes mac over path for USB devices.
You can force systemd to name all WWAN/USB network interfaces by their physical USB port path (e.g., wwp0s20f0u1u2) instead of their MAC address by overriding the default .link policy.

Step 1: Create a Custom systemd .link File

Create /etc/systemd/network/10-wwan-path-naming.link (files in /etc/systemd/network/ take priority over /usr/lib/systemd/network/99-default.link):
ini
[Match]
Type=wwan

[Link]
NamePolicy=keep kernel database onboard slot path
AlternativeNamesPolicy=database onboard slot path
Při použití kódu buďte obezřetní.
(Note: By removing mac from NamePolicy, systemd falls back to path, which constructs the interface name directly from the PCI controller and USB hub/port chain.)

Step 2: Update initramfs and Reboot (or Reload)

Because network interface naming happens early during boot and device initialization:
• Update initramfs so the rule is active at boot:bash
sudo update-initramfs -u
Při použití kódu buďte obezřetní.
• Reboot your machine (or unplug and replug the USB modems after running sudo udevadm control --reload-rules).

Verify the New Interface Names

After rebooting or replugging the modems, check your interface names and MAC addresses:
bash
ip -br link show | grep ww
Při použití kódu buďte obezřetní.
You will now see predictable, port-based names alongside your port-hashed MAC addresses—for example:
• wwp0s20f0u1u2 -> 02:a4:8f:19:c2:0b
• wwp0s20f0u1u3 -> 02:7b:11:4e:90:d1
What if the modem presents as usb0 / enx... (HiLink/CDC-ECM mode)?
If any of your modems expose an Ethernet-style interface (enx...) instead of wwan, change Type=wwan in the [Match] section to Driver=cdc_ncm huawei_cdc_ncm cdc_ether so it covers both Stick and HiLink modes.
If the interface names still show up as wwx... after replugging, paste the output of udevadm info -q property -p /sys/class/net/ww\* | grep -E 'ID_NET_NAME|DEVTYPE' so we can see which naming property systemd is picking up.
