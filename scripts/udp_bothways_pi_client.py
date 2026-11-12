#!/usr/bin/env python3
"""UDP both-ways ENCODER-SIDE CLIENT (run on the RPi4 at 192.168.10.101).

Builds a MobLink relay *data frame* containing a full IPv4/UDP packet and sends
it to the relay's vif ingress (192.168.10.1:4150). Then listens (bound to
0.0.0.0) for the *returned* frame — the server's echo — which comes back via the
relay de-SNATed to the vif IP. Verifies the payload round-tripped.

Proves the relay carries traffic from the RPi4 to the remote destination and the
reply returns, i.e. communication works both ways.

  python3 udp_bothways_pi_client.py [relay_ip] [relay_port] [server_ip] [server_port]
"""
import socket
import struct
import sys
import time

RELAY_IP = sys.argv[1] if len(sys.argv) > 1 else "192.168.10.1"
RELAY_PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 4150
SERVER_IP = sys.argv[3] if len(sys.argv) > 3 else "144.91.123.190"
SERVER_PORT = int(sys.argv[4]) if len(sys.argv) > 4 else 4160

VIF_IP = "10.3.3.1"
SRC_PORT = 6500
MARKER = f"PI-BOTHWAYS-{int(time.time())}".encode()


def ip4(s: str) -> bytes:
    return bytes(int(x) for x in s.split("."))


def ip_cksum(h: bytes) -> int:
    s = 0
    for i in range(0, len(h), 2):
        if i + 1 < len(h):
            s += (h[i] << 8) | h[i + 1]
        else:
            s += h[i] << 8
    while s >> 16:
        s = (s & 0xFFFF) + (s >> 16)
    return (~s) & 0xFFFF


def udp_cksum(udp: bytes, src: bytes, dst: bytes) -> int:
    plen = len(udp)
    pseudo = src + dst + bytes([0, 17]) + struct.pack(">H", plen)
    buf = pseudo + udp
    if len(buf) % 2:
        buf += b"\x00"
    s = 0
    for i in range(0, len(buf), 2):
        s += (buf[i] << 8) | buf[i + 1]
    while s >> 16:
        s = (s & 0xFFFF) + (s >> 16)
    return (~s) & 0xFFFF


def build_inner(payload: bytes) -> bytes:
    src, dst = ip4(VIF_IP), ip4(SERVER_IP)
    udp_len = 8 + len(payload)
    udp_hdr0 = struct.pack(">HHHH", SRC_PORT, SERVER_PORT, udp_len, 0)
    udp_ck = udp_cksum(udp_hdr0 + payload, src, dst)
    udp = struct.pack(">HHHH", SRC_PORT, SERVER_PORT, udp_len, udp_ck) + payload
    total = 20 + len(udp)
    # version/ihl, tos, totlen, id, flags/frag, ttl, proto, cksum, src, dst
    ip = struct.pack(">BBHHHBBH", 0x45, 0, total, 0, 0, 64, 17, 0) + src + dst
    ck = ip_cksum(ip)
    ip = ip[:10] + struct.pack(">H", ck) + ip[12:]
    return ip + udp


def build_frame(inner: bytes) -> bytes:
    # type(1) flags(1) reserved(2) vifIp(4) inner(N)
    return b"\x01\x00\x00\x00" + ip4(VIF_IP) + inner


def parse_frame(buf: bytes):
    if len(buf) < 8 or buf[0] != 0x01:
        return None
    vif = ".".join(str(b) for b in buf[4:8])
    return vif, buf[8:]


def main() -> int:
    # Single socket for BOTH send and recv: the relay replies to this socket's
    # source ip:port, so it must be the same socket we received on.
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(("0.0.0.0", 0))
    my_port = sock.getsockname()[1]
    sock.settimeout(15)

    frame = build_frame(build_inner(MARKER))
    print(f"[pi] local={my_port} sending {len(frame)}B frame to {RELAY_IP}:{RELAY_PORT}", flush=True)
    sock.sendto(frame, (RELAY_IP, RELAY_PORT))

    got = False
    try:
        while True:
            data, addr = sock.recvfrom(65535)
            pf = parse_frame(data)
            print(f"[pi] RX {len(data)}B from {addr[0]}:{addr[1]}", flush=True)
            if not pf:
                continue
            vif, inner = pf
            print(f"[pi] frame vif={vif} inner_len={len(inner)}", flush=True)
            # inner is the *reply*: server src -> vif dst. Payload = ECHO:<rev marker>.
            payload = inner[28:]
            print(f"[pi] reply payload = {payload[:64]!r}", flush=True)
            expected = b"ECHO:" + MARKER[::-1]
            if expected in payload:
                print(f"[pi] ✓ BOTH WAYS CONFIRMED: marker round-tripped via relay", flush=True)
                got = True
                break
    except socket.timeout:
        pass
    finally:
        sock.close()
    print(f"[pi] {'PASS' if got else 'FAIL'}", flush=True)
    return 0 if got else 1


if __name__ == "__main__":
    sys.exit(main())
