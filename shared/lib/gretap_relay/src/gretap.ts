/* GRETAP tunnel core: the `ip` command surface + tunnel topology.
 *
 * A GRETAP tunnel carries L2 Ethernet frames inside GRE (IP protocol 47).
 * Each side runs the same shape:
 *
 *   br-<name>  (bridge)
 *     ├── gretap<name>   L2-over-GRE to `relay.host` (the peer box)
 *     └── <localIface>   the LAN NIC this side bridges into
 *
 * The kernel does all forwarding — there is no userspace packet path. The
 * library only shells out to `iproute2` (`node:child_process`); nothing else.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { networkInterfaces } from "node:os";

const pexecFile = promisify(execFile);

const IP_BIN = "/usr/sbin/ip";
const IFACE_NAME_RE = /^[a-zA-Z0-9_.-]{1,15}$/;
/** Default tunnel MTU (1500; the peer's WDS-facing NIC should carry 1600). */
export const DEFAULT_GRETAP_MTU = 1500;

/** Run `ip <args>`; throws on non-zero exit with the stderr text. */
export async function runIp(args: string[]): Promise<string> {
    try {
        const { stdout } = await pexecFile(IP_BIN, args, {
            encoding: "utf8",
            maxBuffer: 4 * 1024 * 1024,
        });
        return stdout;
    } catch (e) {
        const err = e as {
            code?: number;
            stderr?: string;
            message?: string;
        };
        const detail =
            (err.stderr ?? "").trim() || (err.message ?? String(e));
        throw new Error(`ip ${args.join(" ")} failed: ${detail}`);
    }
}

let ipRunnerImpl: (args: string[]) => Promise<string> = runIp;

/**
 * Inject the `ip` runner (unit tests replace it with a recorder). Passing
 * `undefined` restores the real `iproute2` binary.
 */
export function setIpRunner(
    runner: ((args: string[]) => Promise<string>) | undefined,
): void {
    ipRunnerImpl = runner ?? runIp;
}

/** The active `ip` runner (production: `runIp`; tests: injected). */
export function ipRunner(args: string[]): Promise<string> {
    return ipRunnerImpl(args);
}

/** Resolve `interfaceName` → its first IPv4 via os.networkInterfaces(). */
export function resolveInterfaceAddress(
    interfaceName: string,
    override?: string,
): string {
    if (override) {
        if (!/^\d+\.\d+\.\d+\.\d+$/.test(override))
            throw new Error(`interfaceAddress ${override} is not IPv4`);
        return override;
    }
    const all = networkInterfaces();
    const addresses = all[interfaceName] ?? [];
    const ipv4s = addresses.filter((a) => a.family === "IPv4");
    // Prefer a non-internal address (real NIC); fall back to loopback (`lo`).
    const ipv4 =
        ipv4s.find((a) => !a.internal) ?? ipv4s.find((a) => a.internal) ?? null;
    if (!ipv4)
        throw new Error(`no IPv4 address on interface ${interfaceName} to use`);
    return ipv4.address;
}

/**
 * Deterministic GRE key for a tunnel pair. Kernel GRE demux matching is
 * address-based for keyless tunnels (`daddr == remote`), which cannot match
 * a symmetric pair on heterogeneous subnets — a frame the relay sends to the
 * encoder's address matches no demux on the encoder. A keyed tunnel is
 * demuxed by (protocol, key) alone, so the outer addresses are irrelevant.
 * Both ends derive the same key from the endpoint pair.
 */
export function greKeyForEndpoints(ipA: string, ipB: string): number {
    const num = (ip: string) =>
        ip.split(".").reduce((acc, o) => (acc << 8) + parseInt(o, 10), 0) >>> 0;
    const [lo, hi] = num(ipA) <= num(ipB) ? [ipA, ipB] : [ipB, ipA];
    const s = `${lo}|${hi}`;
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h === 0 ? 1 : h;
}

/** The `ip` argv that creates one side of the tunnel (pure — unit-testable). */
export function gretapSetupCommands(
    name: string,
    peerIp: string,
    mtu: number,
    greKey?: number,
): string[][] {
    const keyArgs = greKey ? ["okey", String(greKey), "ikey", String(greKey)] : [];
    return [
        [
            "link",
            "add",
            `gretap${name}`,
            "type",
            "gretap",
            "remote",
            peerIp,
            ...keyArgs,
        ],
        ["link", "set", `gretap${name}`, "mtu", String(mtu)],
        ["link", "add", `br-${name}`, "type", "bridge"],
        ["link", "set", `br-${name}`, "up"],
        ["link", "set", `gretap${name}`, "master", `br-${name}`],
        ["link", "set", `gretap${name}`, "up"],
    ];
}

/** The `ip` argv that tears one side of the tunnel down (reverse order). */
export function gretapTeardownCommands(name: string): string[][] {
    return [
        ["link", "set", `gretap${name}`, "nomaster"],
        ["link", "del", `gretap${name}`],
        ["link", "del", `br-${name}`],
    ];
}

/** Best-effort teardown of one side (leftover devices from a previous run). */
export async function removeGretap(name: string): Promise<void> {
    for (const args of gretapTeardownCommands(name)) {
        try {
            await ipRunner(args);
        } catch {
            // Already gone (ENOENT) or partial — the next step covers it.
        }
    }
}

/** List existing GRETAP interfaces on the host (`ip -o link show type gretap`). */
export async function listGretapInterfaces(): Promise<
    Array<{ name: string; state: string }>
> {
    const out = await ipRunner(["-o", "link", "show", "type", "gretap"]);
    const result: Array<{ name: string; state: string }> = [];
    for (const line of out.split("\n").map((l) => l.trim()).filter(Boolean)) {
        // Format: `<idx>: <name>@<phy>: <flags> mtu ... state UP (...)`
        const m = line.match(/^\d+:\s+([^@:]+)@/);
        if (!m) continue;
        const stateM = line.match(/\bstate\s+([A-Z]+)/);
        result.push({ name: m[1], state: stateM?.[1] ?? "UNKNOWN" });
    }
    return result;
}

/**
 * Bring one side of the tunnel up. Creates `gretap<name>` (L2-over-GRE to
 * `peerIp`), `br-<name>`, and attaches both the tunnel and `localIface` to
 * the bridge. `localIface` is resolved from `localIp` when not given.
 *
 * Idempotent-ish: a `RTNETLINK answers: File exists` from a leftover device
 * is healed by tearing it down and retrying once.
 */
export async function setUpGretap(opts: {
    name: string;
    peerIp: string;
    localIp: string;
    localIface?: string;
    mtu?: number;
    greKey?: number;
}): Promise<{ name: string; bridge: string; localIface: string }> {
    const name = opts.name;
    const mtu = opts.mtu ?? DEFAULT_GRETAP_MTU;
    let localIface = opts.localIface;
    if (!localIface || localIface === "lo") {
        // No explicit NIC: prefer the interface that holds `localIp` — with a
        // VIRTUAL local IP (the legacy TUN address) that is the LAN egress NIC,
        // so fall back to it via the kernel routing table (best-effort).
        localIface =
            ifaceWithAddress(opts.localIp) ??
            (await egressIface(opts.peerIp)) ??
            undefined;
        if (!localIface)
            throw new Error(
                `no non-loopback interface holds ${opts.localIp} and no default egress route — pass localIface`,
            );
    }

    const runAll = async () => {
        for (const args of gretapSetupCommands(name, opts.peerIp, mtu, opts.greKey))
            await ipRunner(args);
        await ipRunner(["link", "set", localIface, "master", `br-${name}`]);
        await ipRunner(["link", "set", localIface, "up"]);
    };

    try {
        await runAll();
    } catch (first) {
        const msg = first instanceof Error ? first.message : String(first);
        if (!msg.includes("File exists")) throw first;
        // Leftover from a previous run — heal and retry once.
        await removeGretap(name);
        await runAll();
    }
    return { name: `gretap${name}`, bridge: `br-${name}`, localIface };
}

/**
 * The kernel counters of `ifaceName` (the tunneled interface), read
 * synchronously from the sysfs statistics files. Best-effort: missing files
 * (device down / not created) read as 0.
 */
export function readIfaceStats(
    ifaceName: string,
): {
    rxBytes: number;
    rxPackets: number;
    txBytes: number;
    txPackets: number;
    drops: number;
} {
    const stat = (file: string): number => {
        try {
            return Number.parseInt(readFileSync(file, "utf8").trim(), 10) || 0;
        } catch {
            return 0;
        }
    };
    const base = `/sys/class/net/${ifaceName}/statistics`;
    return {
        rxBytes: stat(`${base}/rx_bytes`),
        rxPackets: stat(`${base}/rx_packets`),
        txBytes: stat(`${base}/tx_bytes`),
        txPackets: stat(`${base}/tx_packets`),
        drops: stat(`${base}/dropped`),
    };
}

/**
 * The (non-loopback) interface the kernel uses to reach `destIp`, from
 * `ip route get <destIp>` — the LAN egress NIC. Best-effort: `null` when the
 * route is unknown (no default route, `ip` failure, DRY_RUN hosts).
 */
export async function egressIface(destIp: string): Promise<string | null> {
    try {
        const out = await ipRunner(["route", "get", destIp]);
        // Format: `<dest> dev <iface> src <local> ...`
        const m = out.match(/\bdev\s+([a-zA-Z0-9_.-]+)/);
        return m && m[1] !== "lo" ? m[1] : null;
    } catch {
        return null;
    }
}

/** Find the (non-loopback) interface whose IPv4 list contains `ip`. */
export function ifaceWithAddress(ip: string): string | null {
    const all = networkInterfaces();
    for (const [name, addrs] of Object.entries(all)) {
        if (name === "lo") continue;
        if ((addrs ?? []).some((a) => a.family === "IPv4" && a.address === ip))
            return name;
    }
    // Loopback last (tests / local-only setups).
    if ((all["lo"] ?? []).some((a) => a.family === "IPv4" && a.address === ip))
        return "lo";
    return null;
}

export { IFACE_NAME_RE };
