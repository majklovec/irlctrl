#!/usr/bin/env bun
/**
 * LIVE smoke test for `@irlctrl/udp-relay` on a real (mobile tethered)
 * interface. This is an integration test, NOT the mock-based unit suite
 * (`bun test shared/lib/udp_relay`): it drives a real `createUdpRelay` bound to
 * a physical NIC and verifies the forwarded packets on the wire with tcpdump.
 *
 * Topology under test (protocol.md §5):
 *
 *   fake encoder (this host) ──UDP──▶ createUdpRelay (bound to <iface>)
 *                                        │ raw socket, SNAT src → <iface IP>
 *                                        ▼
 *                                  <iface> (mobile) ──▶ OBS SRTLA ingress
 *
 * It runs three checks (matching `test-relay.md`):
 *   1. RELAY TUNNEL  — a framed data-frame sent to the relay's vif socket is
 *                       forwarded out the physical interface intact (verified
 *                       on the wire with tcpdump: right src/dst + payload).
 *   2. RELAY → OBS   — the same path aimed at the OBS SRTLA ingress; we verify
 *                       egress out <iface> and print the OBS-side tcpdump to
 *                       confirm receipt there (OBS is remote, we can't capture
 *                       it ourselves).
 *   3. SRTLA_SEND    — the real `srtla_send` binary bound to the iface's source
 *                       IP egresses via the per-source routing table (verified
 *                       with `ip route get` + tcpdump on <iface>).
 *
 * Requires: root (raw socket + SO_BINDTODEVICE), tcpdump, and (for test 3) the
 * `srtla_send` binary on PATH (or pass --srtla <path>).
 *
 * Usage:
 *   sudo bun scripts/test_udp_relay_live.ts \
 *       --iface enx7eafd60ad1a2 \
 *       --obs-host 83.208.44.38 --obs-port 5000
 *
 *   --iface <name>      physical NIC the relay binds + egresses through
 *   --obs-host <ip>     OBS SRTLA ingress address (default 83.208.44.38)
 *   --obs-port <n>      OBS SRTLA ingress port (default 5000)
 *   --relay-port <n>    the relay vif-socket UDP port (default 5101)
 *   --vif <ip>          virtual-interface (encoder) source IP (default 10.3.3.1)
 *   --srtla <path>      path to the srtla_send binary (default ./srtla_send)
 *   --skip-srtla        skip test 3
 *   --keep              don't delete temp captures
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
    buildUdpIpPacket,
    encodeDataFrame,
    createUdpRelay,
    resolveInterfaceAddress,
    type UdpRelay,
} from "../shared/lib/udp_relay/src/index";

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------
function arg(name: string, fallback: string): string {
    const i = process.argv.indexOf(`--${name}`);
    if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
    return fallback;
}
function flag(name: string): boolean {
    return process.argv.includes(`--${name}`);
}

const IFACE = arg("iface", "enx7eafd60ad1a2");
const OBS_HOST = arg("obs-host", "83.208.44.38");
const OBS_PORT = Number(arg("obs-port", "5000"));
const RELAY_PORT = Number(arg("relay-port", "5101"));
const VIF_IP = arg("vif", "10.3.3.1");
const SRTLA_BIN = resolve(process.cwd(), arg("srtla", "srtla_send"));
const IP_BIN = "/usr/sbin/ip";
const SKIP_SRTLA = flag("skip-srtla");
const KEEP = flag("keep");

const IFACE_IP = resolveInterfaceAddress(IFACE);

const tmp = mkdtempSync(join(tmpdir(), "udp-relay-live-"));
const pcap = (name: string) => join(tmp, name);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const enc = new TextEncoder();
const dec = new TextDecoder();

let pass = 0;
let fail = 0;
function ok(label: string, cond: boolean, detail = ""): void {
    if (cond) {
        pass++;
        console.log(`  \u2713 PASS  ${label}${detail ? ` — ${detail}` : ""}`);
    } else {
        fail++;
        console.log(`  \u2717 FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
    }
}
function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

/**
 * Start a tcpdump capture on `iface`, write to a pcap, resolve `p` with the
 * capture file path. The caller stops it with `stopCapture()`.
 */
function startCapture(file: string, filter: string): {
    child: ChildProcess;
    stop: () => Promise<void>;
} {
    const child = spawn(
        TCPDUMP,
        ["-i", IFACE, "-n", "-s", "0", "-w", file, filter],
        { stdio: ["ignore", "ignore", "ignore"] },
    );
    return {
        child,
        stop: async () => {
            // SIGINT makes tcpdump finalize (flush) the pcap, then exit.
            child.kill("SIGINT");
            try {
                await new Promise<void>((r) =>
                    child.on("exit", () => r()),
                );
            } catch {
                // already exited
            }
            await sleep(200);
        },
    };
}

/** True when the pcap contains at least one captured packet. */
function pcapHasPackets(file: string): boolean {
    if (!existsSync(file)) return false;
    // pcap global header is 24 bytes; a single small UDP packet is well under
    // 1 MiB. Any capture beyond the header means we saw traffic.
    const size = readFileSync(file).length;
    return size > 24;
}

/** True when the ASCII `marker` appears verbatim in the pcap bytes. */
function pcapHasMarker(file: string, marker: string): boolean {
    if (!existsSync(file)) return false;
    const buf = readFileSync(file);
    const needle = enc.encode(marker);
    for (let i = 0; i + needle.length <= buf.length; i++) {
        let hit = true;
        for (let j = 0; j < needle.length; j++) {
            if (buf[i + j] !== needle[j]) {
                hit = false;
                break;
            }
        }
        if (hit) return true;
    }
    return false;
}

// ---------------------------------------------------------------------------
// Preconditions
// ---------------------------------------------------------------------------
console.log(`udp-relay LIVE test`);
console.log(`  iface    = ${IFACE} (${IFACE_IP})`);
console.log(`  obs      = ${OBS_HOST}:${OBS_PORT}`);
console.log(`  relay    = ${IFACE_IP}:${RELAY_PORT}  (vif ${VIF_IP})`);
if (process.getuid?.() !== 0) {
    console.error("\nThis test must run as root (raw socket). Try: sudo bun ...");
    process.exit(2);
}
const TCPDUMP = "/usr/bin/tcpdump";
if (!existsSync(TCPDUMP) && !spawnSync("which", ["tcpdump"]).stdout?.toString().trim()) {
    console.error("tcpdump not found — install it to run this test.");
    process.exit(2);
}

// ---------------------------------------------------------------------------
// Test 1 — the relay tunnel (framed packet → forwarded out the interface)
// ---------------------------------------------------------------------------
console.log(`\n[1] RELAY TUNNEL  (relay on ${IFACE_IP} forwards a framed packet)`);
{
    let relay: UdpRelay | null = null;
    try {
        relay = await createUdpRelay({
            interfaceName: IFACE,
            listenPort: RELAY_PORT,
            interfaceAddress: IFACE_IP,
            nat: true,
        });
        await relay.start();
        ok("relay.start() bound vif socket + raw tap", relay.isRunning());

        const marker = `IRELAY-T1-${Date.now()}-x${Math.floor(Math.random() * 1e6)}`;
        // A whole IPv4/UDP packet: vif → OBS, carrying our marker.
        const inner = buildUdpIpPacket({
            srcIp: VIF_IP,
            dstIp: OBS_HOST,
            srcPort: 6000,
            dstPort: OBS_PORT,
            payload: enc.encode(marker),
        });
        const frame = encodeDataFrame(inner, VIF_IP);

        const cap = startCapture(pcap("t1.pcap"), `udp and host ${OBS_HOST} and port ${OBS_PORT}`);
        await sleep(300); // let tcpdump program the BPF filter

        // The "encoder" side: one framed datagram to the relay's vif socket.
        const sock = await Bun.udpSocket({ binaryType: "uint8array" });
        sock.send(frame, RELAY_PORT, IFACE_IP as any);
        await sleep(1500); // give the relay + wire time to deliver
        await cap.stop();

        // Read live counters (onStats fires only on start/stop/errors, not per-packet).
        const s = relay.stats();
        ok("relay saw the encoded frame (encRxPackets ≥ 1)", (s.encRxPackets ?? 0) >= 1, `encRx=${s.encRxPackets}`);
        ok("relay forwarded it out the interface (ifaceTxPackets ≥ 1)", (s.ifaceTxPackets ?? 0) >= 1, `ifaceTx=${s.ifaceTxPackets}`);
        ok("packet egressed out the physical interface (tcpdump)", pcapHasPackets(pcap("t1.pcap")), pcap("t1.pcap"));
        ok("payload intact on the wire (marker present)", pcapHasMarker(pcap("t1.pcap"), marker), marker);
        console.log(`\n    OBS-side check (run on ${OBS_HOST}):`);
        console.log(`      tcpdump -ni <iface> -s 0 'udp and host ${IFACE_IP} and port ${OBS_PORT}'`);
        console.log(`    → expect: IP ${IFACE_IP}.<ephemeral> > ${OBS_HOST}.${OBS_PORT} (payload "${marker}")`);
    } catch (e) {
        ok("test 1 ran without throwing", false, e instanceof Error ? e.message : String(e));
    } finally {
        await relay?.stop();
    }
}

// ---------------------------------------------------------------------------
// Test 2 — relay → OBS (same path, aimed at the real ingress)
// ---------------------------------------------------------------------------
console.log(`\n[2] RELAY → OBS  (datagrams leave ${IFACE} toward ${OBS_HOST}:${OBS_PORT})`);
{
    let relay: UdpRelay | null = null;
    try {
        relay = await createUdpRelay({
            interfaceName: IFACE,
            listenPort: RELAY_PORT,
            interfaceAddress: IFACE_IP,
            nat: true,
        });
        await relay.start();

        const cap = startCapture(pcap("t2.pcap"), `udp and host ${OBS_HOST} and port ${OBS_PORT}`);
        await sleep(300);

        // A short burst (SRT-like) so the ingress actually sees continuous traffic.
        const sock = await Bun.udpSocket({ binaryType: "uint8array" });
        for (let i = 0; i < 20; i++) {
            const inner = buildUdpIpPacket({
                srcIp: VIF_IP,
                dstIp: OBS_HOST,
                srcPort: 6000 + i,
                dstPort: OBS_PORT,
                payload: enc.encode(`T2-${i}`),
            });
            sock.send(encodeDataFrame(inner, VIF_IP), RELAY_PORT, IFACE_IP as any);
            await sleep(40);
        }
        await cap.stop();

        ok("≥1 datagram egressed out the interface toward OBS", pcapHasPackets(pcap("t2.pcap")), pcap("t2.pcap"));
        console.log(`\n    OBS-side check (run on ${OBS_HOST}):`);
        console.log(`      tcpdump -ni <iface> -c 5 'udp and host ${IFACE_IP} and port ${OBS_PORT}'`);
        console.log(`    → expect SRTLA handshake/data from ${IFACE_IP} → ${OBS_HOST}:${OBS_PORT}`);
    } catch (e) {
        ok("test 2 ran without throwing", false, e instanceof Error ? e.message : String(e));
    } finally {
        await relay?.stop();
    }
}

// ---------------------------------------------------------------------------
// Test 3 — srtla_send + per-source routing table
// ---------------------------------------------------------------------------
if (SKIP_SRTLA) {
    console.log(`\n[3] SRTLA_SEND  (skipped)`);
} else {
    console.log(`\n[3] SRTLA_SEND + SOURCE ROUTING  (${SRTLA_BIN} bound to ${IFACE_IP})`);
    try {
        // (a) Routing table check — the per-source rule must send <iface IP>
        //     traffic out <iface> via its own gateway (table for that source).
        const route = spawnSync(IP_BIN, ["route", "get", "from", IFACE_IP, OBS_HOST]);
        const routeOut = route.stdout?.toString() ?? "";
        console.log(`    ip route get from ${IFACE_IP} ${OBS_HOST}:`);
        console.log(`      ${routeOut.trim().split("\n").join("\n      ")}`);
        const viaIface = routeOut.includes(`dev ${IFACE}`);
        ok("source-routed out the physical interface (dev <iface>)", viaIface);
        // The per-source rule (from <iface IP> lookup <table>) that makes this work.
        const rules = spawnSync(IP_BIN, ["rule", "show"]);
        const ruleOut = rules.stdout?.toString() ?? "";
        const hasRule = ruleOut.includes(`from ${IFACE_IP}`);
        ok("per-source ip rule present (from <iface IP>)", hasRule, `rules: ${ruleOut.includes("from") ? "found" : "none"}`);

        // (b) Real srtla_send egress.
        if (!existsSync(SRTLA_BIN)) {
            ok("srtla_send binary present", false, `${SRTLA_BIN} not found (pass --srtla <path>)`);
        } else {
            const ipsFile = join(tmp, "srtla_ips.txt");
            writeFileSync(ipsFile, IFACE_IP + "\n");

            const cap = startCapture(pcap("t3.pcap"), `udp and host ${OBS_HOST} and port ${OBS_PORT}`);
            await sleep(300);

            const srtla = spawn(SRTLA_BIN, ["6000", OBS_HOST, String(OBS_PORT), ipsFile], {
                stdio: ["ignore", "ignore", "pipe"],
            });
            let srtlaLog = "";
            srtla.stderr?.on("data", (d: Buffer) => (srtlaLog += d.toString()));
            srtla.stdout?.on("data", (d: Buffer) => (srtlaLog += d.toString()));
            await sleep(6000); // SRTLA reg + data flow
            srtla.kill("SIGKILL");
            await cap.stop();

            ok("srtla_send egressed toward OBS out the interface", pcapHasPackets(pcap("t3.pcap")), srtlaLog ? `log tail: ${srtlaLog.trim().slice(-200)}` : "(no log)");

            console.log(`\n    OBS-side check (run on ${OBS_HOST}):`);
            console.log(`      tcpdump -ni <iface> -c 5 'udp and host ${IFACE_IP} and port ${OBS_PORT}'`);
        }
    } catch (e) {
        ok("test 3 ran without throwing", false, e instanceof Error ? e.message : String(e));
    }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${"=".repeat(52)}`);
console.log(`RESULT: ${pass} passed, ${fail} failed`);
console.log(`captures in: ${tmp}`);
if (!KEEP) rmSync(tmp, { recursive: true, force: true });
else console.log("(kept with --keep)");
process.exit(fail === 0 ? 0 : 1);
