/*
 * SRTLA transport primitives shared by the encoder and relay roles (10-SRTLA).
 *
 * `srtla_send` is the SRT→SRTLA bridge: it listens for a plain SRT stream on a
 * `listenPort` and re-emits it as an SRTLA stream to `remoteHost:remotePort`
 * across a bond of uplink interfaces. It takes plain `ip port` pairs plus an
 * uplinks file — not an `srt://` URL — and only a handful of optional flags,
 * which differ by build (the BELABOX C binary understands none of them).
 *
 * `srtla_rec` is the SRTLA→SRT receiver: it listens for SRTLA on a UDP port and
 * re-emits a single plain SRT stream to a (loopback) SRT hostname:port.
 *
 * The relay consumes these for both legs of its bridge and the encoder for its
 * outbound leg. Backend only: this module probes binaries and shells out to
 * `ss` / `ip`, so it must not be imported from browser code.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** The scheduler options that `srtla_send` understands over its control socket. */
export type SrtlaMode = "classic" | "enhanced";
export const SRTLA_MODES: readonly SrtlaMode[] = ["classic", "enhanced"];

/**
 * Which optional flags a given `srtla_send` build accepts. Probed from `--help`
 * because the BELABOX C build has none of them.
 */
export interface SrtlaSendCapabilities {
    controlSocket: boolean;
    mode: boolean;
    quality: boolean;
}

/** Scheduler options to pass to a flag-aware `srtla_send` build. */
export interface SrtlaOptions {
    mode?: SrtlaMode;
    quality?: boolean;
}

/**
 * The optional flags for `srtla_send`, filtering out any the binary's build
 * does not understand. The positional `listenPort remoteHost remotePort
 * uplinksFile` arguments are appended by the caller.
 */
export function srtlaSendFlags(
    caps: SrtlaSendCapabilities,
    opts: SrtlaOptions,
    controlSocket?: string,
): string[] {
    const flags: string[] = [];
    if (controlSocket && caps.controlSocket)
        flags.push("--control-socket", controlSocket);
    if (caps.mode && opts.mode) flags.push("--mode", opts.mode);
    if (caps.quality && opts.quality === false) flags.push("--no-quality");
    return flags;
}

/**
 * Probe a `srtla_send` build for the optional flags it understands, from its
 * `--help` output.
 */
export async function srtlaSendCapabilities(
    bin: string,
): Promise<SrtlaSendCapabilities> {
    let help = "";
    try {
        const proc = Bun.spawn([bin, "--help"], {
            stdout: "pipe",
            stderr: "pipe",
            stdin: "ignore",
        });
        const [out, err] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
        ]);
        await proc.exited;
        help = out + err;
    } catch {
        help = "";
    }
    return {
        controlSocket: help.includes("--control-socket"),
        mode: help.includes("--mode"),
        quality: help.includes("--no-quality"),
    };
}

/**
 * The argv for `srtla_rec`, which listens for an SRTLA stream on `srtlaPort`
 * and re-emits a plain SRT stream to `srtHost:srtPort` (loopback in the relay
 * bridge). The caller is responsible for spawning and supervising the process.
 */
export function srtlaRecArgs(
    srtlaPort: number,
    srtHost: string,
    srtPort: number,
): string[] {
    return [
        "--srtla_port",
        String(srtlaPort),
        "--srt_hostname",
        srtHost,
        "--srt_port",
        String(srtPort),
    ];
}

/** Whether a UDP port is bound, via `ss -uln`. False when `ss` is unavailable. */
export function isUdpPortOpen(port: number): boolean {
    try {
        const result = Bun.spawnSync(["ss", "-uln"]);
        if (result.exitCode !== 0) return false;
        const matcher = new RegExp(`(^|[\\s:])${port}(?=[\\s])`, "m");
        return matcher.test(result.stdout.toString());
    } catch {
        return false;
    }
}

/**
 * The host's default-route source IPv4 (for the `srtla_send` uplinks file);
 * null when it cannot be determined (e.g. `ip` is unavailable).
 */
export function defaultSourceIp(): string | null {
    try {
        const r = Bun.spawnSync(["ip", "route", "get", "1.1.0.1"]);
        return /\bsrc (\S+)/.exec(r.stdout?.toString() ?? "")?.[1] ?? null;
    } catch {
        return null;
    }
}

/**
 * Write a single-line uplinks file for a `srtla_send` leg (`sourceIp` — the
 * host's outbound IP; empty when unknown). Creates parent directories.
 */
export async function writeUplinksFile(
    path: string,
    sourceIp: string | null,
): Promise<void> {
    mkdirSync(dirname(path), { recursive: true });
    await Bun.write(path, `${sourceIp ?? ""}\n`);
}

/**
 * Poll `isUdpPortOpen` until `port` is bound or `timeoutMs` elapses. Returns
 * false when the deadline is reached, or when `isAborted()` flips (a
 * stop/restart invalidates a half-open readiness gate).
 */
export async function waitForUdpPort(
    port: number,
    timeoutMs: number,
    isAborted: () => boolean = () => false,
): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (isAborted()) return false;
        if (isUdpPortOpen(port)) return true;
        await Bun.sleep(150);
    }
    return false;
}
