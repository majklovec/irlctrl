#!/usr/bin/env python3
"""UDP ingress/egress ENDPOINT (run on the remote server, e.g. 144.91.123.190).

Receives UDP datagrams on 0.0.0.0:PORT and echoes each one back to the sender
with a transformation ("ECHO:" + reversed payload) so a round-trip can be
distinguished from a loopback. Logs every receipt with source ip:port + hex.

Used as the stand-in for the OBS SRTLA ingress so the MobLink UDP relay can be
proven to carry traffic both ways over the real mobile uplink.

  python3 udp_bothways_responder.py [port] [duration_seconds]
"""
import socket
import sys
import time

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 4160
DURATION = int(sys.argv[2]) if len(sys.argv) > 2 else 120


def main() -> int:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.bind(("0.0.0.0", PORT))
    s.settimeout(2)
    end = time.time() + DURATION
    print(f"[responder] listening on 0.0.0.0:{PORT} for {DURATION}s", flush=True)
    sources = set()
    while time.time() < end:
        try:
            data, addr = s.recvfrom(65535)
        except socket.timeout:
            continue
        sources.add((addr[0], addr[1]))
        print(
            f"[responder] RX {addr[0]}:{addr[1]} len={len(data)} hex={data[:64].hex()}",
            flush=True,
        )
        s.sendto(b"ECHO:" + data[::-1], addr)
        print(f"[responder] TX echo -> {addr[0]}:{addr[1]}", flush=True)
    print(f"[responder] done. unique sources={sorted(sources)}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
