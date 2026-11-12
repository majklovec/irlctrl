#!/usr/bin/env python3
"""Decisive source-address probe (run on the relay/host, needs root).

Send a UDP datagram to a destination through a specific NIC, using a chosen
source IP, and see whether the echo reply comes back. This isolates whether the
reply-path failure is caused by the SNAT source address not being return-
routable by the upstream (phone/carrier NAT).

Usage: python3 udp_srcprobe.py <srcIP> <iface> <dstIP> <dstPort> <marker>
  e.g. python3 udp_srcprobe.py 172.21.254.128 enx7eafd60ad1a2 144.91.123.190 4160 TETHER-IP
      python3 udp_srcprobe.py 192.168.10.1   enx7eafd60ad1a2 144.91.123.190 4160 LAN-IP
"""
import socket, struct, sys, time, ctypes, ctypes.util, os

SOL_SOCKET = 1
SO_BINDTODEVICE = 25

def bindtodevice(fd: int, name: str) -> None:
    libc = ctypes.CDLL(ctypes.util.find_library("c"), use_errno=True)
    val = name.encode() + b"\x00"
    r = libc.setsockopt(fd, SOL_SOCKET, SO_BINDTODEVICE, ctypes.c_char_p(val), len(val))
    if r != 0:
        raise OSError(os.strerror(ctypes.get_errno()))

def main() -> int:
    if len(sys.argv) < 6:
        print(__doc__); return 2
    src, iface, dst, marker = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[5]
    dport = int(sys.argv[4])
    payload = marker.encode() + b"-" + str(time.time_ns() % 10**8).encode()
    print(f"[probe] src={src} out={iface} dst={dst}:{dport} marker={marker} len={len(payload)}")

    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        bindtodevice(s.fileno(), iface)
        s.bind((src, 0))
        s.settimeout(15.0)
        sent = s.sendto(payload, (dst, dport))
        print(f"[probe] sent {sent}B from {src}:{s.getsockname()[1]}")
        deadline = time.time() + 15.0
        while time.time() < deadline:
            try:
                data, peer = s.recvfrom(2048)
            except socket.timeout:
                break
            print(f"[probe] RX {len(data)}B from {peer[0]}:{peer[1]} payload={data.decode(errors='replace')!r}")
            if marker.encode() in data[::-1] or b"ECHO" in data:
                print(f"[probe] <<< REPLY RETURNED for src={src} >>>")
                return 0
        print(f"[probe] NO reply for src={src}")
        return 1
    finally:
        s.close()

if __name__ == "__main__":
    sys.exit(main())
