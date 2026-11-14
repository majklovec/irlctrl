/*
 * Network interface enumeration. Linux first: /sys/class/net lists every
 * interface (Node's os.networkInterfaces() hides ones without an address),
 * joined with os for IPv4/IPv6 addresses + MAC. Non-Linux (or a missing
 * /sys/class/net) falls back to os.networkInterfaces() keys.
 *
 * Both sources are injectable so tests can fake /sys/class/net + os.
 */
import { networkInterfaces as defaultOs } from "node:os";
import type { SpeedtestInterface } from "./types";

export type OsInterfaces = () => ReturnType<typeof defaultOs>;
export type SysReader = (name: string) => Promise<string | null>;

/**
 * Enumerate host interfaces. `sysNames` lists /sys/class/net entries (empty on
 * non-Linux), `readState` reads one interface's `-operstate`, `osInfo` is
 * `os.networkInterfaces()`.
 */
export async function listInterfaces(opts: {
    sysNames?: Promise<string[]>;
    readState?: SysReader;
    osInfo?: OsInterfaces;
} = {}): Promise<SpeedtestInterface[]> {
    const osInfo = opts.osInfo ?? defaultOs;
    const info = osInfo();

    let names: string[] = [];
    try {
        names = (await (opts.sysNames ?? realSysNames())).sort();
    } catch {
        names = [];
    }

    const out: SpeedtestInterface[] = [];
    if (names.length) {
        const readState = opts.readState ?? realReadState;
        for (const name of names) {
            const up = (await readState(name)) === "up";
            out.push({
                name,
                addresses: info[name] ? osAddresses(info[name]) : [],
                up,
            });
        }
        return out;
    }

    // Fallback: os-only (Windows/macOS — names differ; the card may hide it).
    for (const name of Object.keys(info))
        out.push({
            name,
            addresses: osAddresses(info[name]),
            up: true,
        });
    return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** First `up` non-loopback interface with an IPv4 address, else null. */
export function pickDefaultInterface(
    interfaces: SpeedtestInterface[],
): string | null {
    const pick = interfaces.find(
        (i) => i.name !== "lo" && i.up && i.addresses.some(isIPv4),
    );
    return pick?.name ?? null;
}

const isIPv4 = (a: string): boolean => a.includes(".") && !a.includes(":");

/** All IPv4/IPv6 addresses of one os interface family entry. */
function osAddresses(family: { address: string }[] | undefined): string[] {
    return (family ?? []).map((f) => f.address);
}

async function realSysNames(): Promise<string[]> {
    const { readdir } = await import("node:fs/promises");
    return readdir("/sys/class/net");
}

const realReadState: SysReader = async (name) => {
    const { readFile } = await import("node:fs/promises");
    return readFile(`/sys/class/net/${name}/-operstate`, "utf8")
        .then((s) => s.trim())
        .catch(() => null);
};
