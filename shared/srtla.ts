/*
 * SRTLA transport primitives shared by the relay and encoder roles (10-SRTLA).
 *
 * `srtla_send` is the SRT→SRTLA bridge: it listens for a plain SRT stream on a
 * `sendPort` and re-emits it as an SRTLA stream to `remoteHost:remotePort`
 * across a bond of uplink interfaces. It takes plain `ip port` pairs plus an
 * uplinks file — not an `srt://` URL — and only a handful of optional flags,
 * which differ by build (the BELABOX C binary understands none of them).
 *
 * `srtla_rec` is the SRTLA→SRT receiver: it listens for SRTLA on a UDP port and
 * re-emits a single plain SRT stream to a (loopback) SRT hostname:port.
 *
 * Beyond the arg/flag helpers this module supervises the process itself
 * (`SrtlaSend`, used by both the relay's outbound leg and the encoder's
 * outbound leg) and speaks the JSON-RPC 2.0 control-socket protocol
 * (`SrtlaControlSocket`): the 1 Hz per-link `stats` pushes and the
 * scheduler mode / quality-scoring switches.
 * https://github.com/irlserver/srtla_send/blob/main/docs/CONTROL_PROTOCOL.md
 *
 * Backend only: this module probes binaries, spawns processes and shells out
 * to `ss` / `ip`, so it must not be imported from browser code.
 */
import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import type { Socket } from "bun";
import { t } from "./i18n";
import { errorMessage, textOf } from "./util";
import type { Supervisor } from "../client/backend/supervisor";

// ----------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------

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

/** The result of the `*.options` RPC: the effective options + live application. */
export interface SrtlaOptionsResult {
    options: SrtlaOptions;
    applied: boolean;
}

/** The control socket (`srtlaControl` status fragment). */
export interface SrtlaControlState {
    supported: boolean;
    connected: boolean;
}

/**
 * The SRTLA target a leg sends to. `listenPort` is the local SRTLA/SRT input
 * the operator configures; on the relay that is the UDP port `srtla_rec`
 * binds (the encoder → relay hop), on the encoder it is the SRT port
 * `srtla_send` listens on. The destination is what `srtla_send` sends to.
 */
export interface SrtlaTarget {
    listenPort: string;
    remoteHost: string;
    remotePort: string;
}

/** The running (or last) srtla_send leg: target, pid, reload counters. */
export interface SrtlaState {
    running: boolean;
    pid?: number;
    /** Local input port (`srtla_rec` UDP on the relay, SRT listen on the encoder). */
    listenPort?: string;
    /** The plain-SRT port `srtla_send` listens on (loopback internal port on the relay). */
    sendPort?: string;
    remoteHost?: string;
    remotePort?: string;
    startedAt?: number;
    lastReloadAt?: number;
    reloadCount?: number;
}

/**
 * The persisted config section of a leg: receiver target plus scheduler
 * options. The relay stores it under `relay`, the encoder under `stream`.
 */
export interface SrtlaConfig {
    listenPort: string;
    mode: SrtlaMode;
    quality: boolean;
    remoteHost: string;
    remotePort: string;
}

/** Per-link subset of srtla_send's `StatsSnapshot.links[]` that the UI shows. */
export interface SrtlaLinkStats {
    ip: string;
    label?: string;
    connected: boolean;
    timed_out: boolean;
    bitrate_bytes_per_sec: number;
    rtt_ms: number;
    rtt_min_ms: number;
    window: number;
    in_flight: number;
    nak_count: number;
    cc_loss_permille: number;
    cc_state?: string;
    cc_target_bps?: number;
    quality_multiplier?: number;
    base_score?: number;
    weak?: boolean;
    weak_reason?: string;
    stall_gated?: boolean;
    sole_carrier?: boolean;
}

/** The trimmed per-second stats snapshot pushed over the control socket. */
export interface SrtlaStats {
    mode?: SrtlaMode;
    quality_enabled?: boolean;
    active_links: number;
    total_links: number;
    total_in_flight: number;
    total_window: number;
    negotiated_latency_ms?: number;
    links: SrtlaLinkStats[];
}

/** The `relay.stats` / `stream.stats` push. */
export interface SrtlaStatsEvent {
    at: number;
    stats: SrtlaStats | null;
}

/** Everything a supervised leg needs to (re)spawn one `srtla_send`. */
export interface SrtlaSendLaunch {
    /** Positional arg 1: the SRT port the SRT stream arrives on. */
    sendPort: string;
    remoteHost: string;
    remotePort: string;
    /** Positional arg 4: the bonded uplinks file. */
    uplinksFile: string;
    /** Scheduler options applied as flags on (re)spawn. */
    options?: SrtlaOptions;
}

// ----------------------------------------------------------------------
// srtla_send / srtla_rec args and host probes
// ----------------------------------------------------------------------

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

// ----------------------------------------------------------------------
// Control socket client (JSON-RPC 2.0 over `--control-socket`)
// ----------------------------------------------------------------------
const CONTROL_RETRY_MS = 500;
const RPC_TIMEOUT_MS = 5_000;

const LINK_KEYS: readonly (keyof SrtlaLinkStats)[] = [
    "ip",
    "label",
    "connected",
    "timed_out",
    "bitrate_bytes_per_sec",
    "rtt_ms",
    "rtt_min_ms",
    "window",
    "in_flight",
    "nak_count",
    "cc_loss_permille",
    "cc_state",
    "cc_target_bps",
    "quality_multiplier",
    "base_score",
    "weak",
    "weak_reason",
    "stall_gated",
    "sole_carrier",
];
const STATS_KEYS: readonly (keyof SrtlaStats)[] = [
    "mode",
    "quality_enabled",
    "active_links",
    "total_links",
    "total_in_flight",
    "total_window",
    "negotiated_latency_ms",
];

const pick = <T>(src: Record<string, unknown>, keys: readonly (keyof T)[]): T =>
    Object.fromEntries(
        keys
            .filter((k) => src[k as string] !== undefined)
            .map((k) => [k, src[k as string]]),
    ) as T;

/** Keep the pushed snapshot small: it is forwarded to browsers and the control server every second. */
function trimStats(raw: unknown): SrtlaStats | null {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    const links = Array.isArray(r.links) ? r.links : [];
    return {
        ...pick<SrtlaStats>(r, STATS_KEYS),
        links: links
            .filter(
                (l): l is Record<string, unknown> =>
                    !!l && typeof l === "object",
            )
            .map((l) => pick<SrtlaLinkStats>(l, LINK_KEYS)),
    };
}

type StatsListener = (ev: SrtlaStatsEvent) => void;
type ChangeListener = () => void;

/**
 * JSON-RPC 2.0 client for one `srtla_send --control-socket` endpoint:
 * subscribes to the 1 Hz per-link `stats` topic and switches the scheduler
 * mode / quality scoring without a restart. Reconnects while the leg is
 * wanted; stale pending RPCs fail on every disconnect.
 */
export class SrtlaControlSocket {
    private socketPath: string | null = null; // non-null while srtla_send should be reachable
    private sock: Socket<undefined> | null = null;
    private retryTimer: ReturnType<typeof setTimeout> | null = null;
    private buffer = "";
    private nextId = 1;
    private supported = false;
    private lastStats: SrtlaStatsEvent = { at: 0, stats: null };
    private pending = new Map<
        number,
        {
            resolve: (v: unknown) => void;
            reject: (e: Error) => void;
            timer: ReturnType<typeof setTimeout>;
        }
    >();
    private statListeners = new Set<StatsListener>();
    private changeListeners = new Set<ChangeListener>();

    /** The `srtlaControl` status fragment. */
    state(): SrtlaControlState {
        return { supported: this.supported, connected: this.sock !== null };
    }

    /** The last stats push (`{ at: 0, stats: null }` before the first one). */
    latest(): SrtlaStatsEvent {
        return this.lastStats;
    }

    /** Subscribe to stats pushes; returns an unsubscribe function. */
    onStats(listener: StatsListener): () => void {
        this.statListeners.add(listener);
        return () => this.statListeners.delete(listener);
    }

    /** Subscribe to control connection up/down; returns an unsubscribe function. */
    onChange(listener: ChangeListener): () => void {
        this.changeListeners.add(listener);
        return () => this.changeListeners.delete(listener);
    }

    /**
     * Remove a stale socket left by a crashed srtla_send so we never talk to a
     * dead one, and record whether this build speaks the protocol at all.
     */
    prepare(path: string, isSupported: boolean): void {
        this.supported = isSupported;
        if (!isSupported) return;
        try {
            rmSync(path, { force: true });
        } catch {}
    }

    /** Start (re)connecting; call right after spawning srtla_send. */
    start(path: string): void {
        this.stop();
        this.supported = true;
        this.socketPath = path;
        void this.connect();
    }

    stop(): void {
        this.socketPath = null;
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.retryTimer = null;
        const s = this.sock;
        this.sock = null;
        this.failPending("srtla_send control stopped");
        s?.end();
        if (this.lastStats.stats) this.publishStats(null);
        if (s) this.notifyChange();
    }

    /** Send a JSON-RPC request and wait for its result. */
    rpc<T = unknown>(
        method: string,
        params?: Record<string, unknown>,
    ): Promise<T> {
        return new Promise((resolve, reject) => {
            if (!this.sock) {
                reject(new Error("srtla_send control socket not connected"));
                return;
            }
            const id = this.nextId++;
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`srtla_send ${method} timed out`));
            }, RPC_TIMEOUT_MS);
            this.pending.set(id, {
                resolve: (v) => resolve(v as T),
                reject,
                timer,
            });
            this.sock.write(
                `${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })}\n`,
            );
        });
    }

    private publishStats(stats: SrtlaStats | null): void {
        this.lastStats = { at: Date.now(), stats };
        for (const l of this.statListeners) l(this.lastStats);
    }

    private notifyChange(): void {
        for (const l of this.changeListeners) l();
    }

    private failPending(reason: string): void {
        for (const p of this.pending.values()) {
            clearTimeout(p.timer);
            p.reject(new Error(reason));
        }
        this.pending.clear();
    }

    private handleLine(line: string): void {
        let msg: {
            id?: unknown;
            method?: unknown;
            params?: { data?: unknown };
            result?: unknown;
            error?: { message?: string };
        };
        try {
            msg = JSON.parse(line);
        } catch {
            return;
        }
        if (typeof msg.id === "number" && this.pending.has(msg.id)) {
            const p = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            if (!p) return;
            clearTimeout(p.timer);
            if (msg.error)
                p.reject(new Error(msg.error.message ?? "srtla_send error"));
            else p.resolve(msg.result);
            return;
        }
        if (msg.method === "stats.update")
            this.publishStats(trimStats(msg.params?.data));
    }

    private scheduleConnect(): void {
        if (!this.socketPath || this.retryTimer) return;
        this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            void this.connect();
        }, CONTROL_RETRY_MS);
    }

    private async connect(): Promise<void> {
        const path = this.socketPath;
        if (!path || this.sock) return;
        // The socket handlers are contextually typed with their own `this`;
        // reach the instance through a captured alias instead.
        const self = this;
        try {
            await Bun.connect({
                unix: path,
                socket: {
                    open(s: Socket<undefined>) {
                        if (self.socketPath !== path) {
                            s.end();
                            return;
                        }
                        self.sock = s;
                        self.buffer = "";
                        console.log(
                            `srtla_send control socket connected (${path})`,
                        );
                        self.notifyChange();
                        self.rpc("subscribe", { topic: "stats" }).catch(
                            (err: unknown) =>
                                console.warn(
                                    `srtla_send stats subscribe failed: ${errorMessage(err)}`,
                                ),
                        );
                    },
                    data(_s, chunk: unknown) {
                        self.buffer += textOf(chunk);
                        let nl: number;
                        while ((nl = self.buffer.indexOf("\n")) >= 0) {
                            const line = self.buffer.slice(0, nl).trim();
                            self.buffer = self.buffer.slice(nl + 1);
                            if (line) self.handleLine(line);
                        }
                    },
                    close(s: Socket<undefined>) {
                        if (self.sock !== s) return;
                        self.sock = null;
                        self.failPending("srtla_send control socket closed");
                        self.notifyChange();
                        if (self.socketPath) {
                            self.publishStats(null);
                            self.scheduleConnect();
                        }
                    },
                    error() {
                        // `close` follows and handles the reconnect
                    },
                },
            });
        } catch {
            // Socket not there yet (srtla_send still starting) or refused: keep trying while wanted
            this.scheduleConnect();
        }
    }
}

// ----------------------------------------------------------------------
// Supervised srtla_send leg
// ----------------------------------------------------------------------

/** The process services a supervised leg borrows from the module core bag. */
export interface SrtlaSendServices {
    /** The core Supervisor constructor (shared/ must not import core at runtime). */
    Supervisor: typeof Supervisor;
    /** `--dry-run`: track state without spawning. */
    dryRun: boolean;
    logEvent: (
        level: "info" | "warn" | "error",
        section: string,
        message: string,
    ) => void;
    notifyStateChange: () => void;
}

/** Per-role configuration of one supervised leg. */
export interface SrtlaSendConfig {
    /** Log section: "SRTLA" (relay) / "SRTLA_SEND" (encoder). */
    section: string;
    /** The control-socket path ("" disables it). */
    controlSocket: string;
    /** Delay before an unexpected exit is retried. */
    restartDelayMs: number;
    /** How a reload reaches srtla_send: SIGHUP, or a full restart. */
    reloadMode: "signal" | "restart";
}

/**
 * One supervised `srtla_send` process: spawn, restart-on-exit, reload
 * (SIGHUP or respawn) and the scheduler options over the control socket.
 * The relay uses it for its outbound leg, the encoder for its only leg.
 */
export class SrtlaSend {
    /** The control-socket client (stats pushes + mode/quality RPC). */
    readonly control = new SrtlaControlSocket();

    private sup: Supervisor | undefined;
    private live: SrtlaState = { running: false };
    private dryRunActive = false; // --dry-run has no process to track
    private lastLaunch: { bin: string; launch: SrtlaSendLaunch } | undefined;

    constructor(
        private readonly services: SrtlaSendServices,
        private readonly cfg: SrtlaSendConfig,
    ) {}

    /** The supervisor (created lazily so a role that never streams keeps none). */
    private supervisor(): Supervisor {
        return (this.sup ??= new this.services.Supervisor(
            this.cfg.section,
            this.cfg.restartDelayMs,
            (code) => this.onExit(code),
        ));
    }

    get running(): boolean {
        return this.services.dryRun
            ? this.dryRunActive
            : this.sup?.running ?? false;
    }

    /** The running (or last) leg state. */
    state(): SrtlaState {
        return this.running
            ? this.live
            : { ...this.live, running: false, pid: undefined };
    }

    /**
     * Spawn (or track, in dry run) the srtla_send for `launch`. The starter
     * re-runs on every supervisor restart, so the launch — flags inclusive —
     * is the single source of truth for respawns.
     */
    async start(
        bin: string,
        launch: SrtlaSendLaunch,
        extra?: { listenPort?: string },
    ): Promise<SrtlaState> {
        const { sendPort, remoteHost, remotePort, uplinksFile } = launch;
        const caps = this.services.dryRun
            ? null
            : await srtlaSendCapabilities(bin);
        const flags = srtlaSendFlags(
            caps ?? { controlSocket: true, mode: true, quality: true },
            launch.options ?? {},
            this.cfg.controlSocket,
        );
        const withControl =
            !!this.cfg.controlSocket && !!caps?.controlSocket;
        const args = [
            ...flags,
            sendPort,
            remoteHost,
            remotePort,
            uplinksFile,
        ];
        console.log(`Starting ${bin} ${args.join(" ")}`);

        const started = (pid?: number): SrtlaState => ({
            running: true,
            listenPort: extra?.listenPort,
            sendPort,
            remoteHost,
            remotePort,
            startedAt: Date.now(),
            ...(pid === undefined
                ? {}
                : { pid, reloadCount: this.live.reloadCount ?? 0 }),
        });

        this.lastLaunch = { bin, launch };
        if (caps) {
            await this.supervisor().start(() => {
                // The starter re-runs on restarts: drop the stale socket and
                // (re)connect the control client on every (re)spawn.
                this.control.prepare(this.cfg.controlSocket, withControl);
                if (withControl) this.control.start(this.cfg.controlSocket);
                const proc = Bun.spawn([bin, ...args], {
                    stdout: "inherit",
                    stderr: "inherit",
                    stdin: "inherit",
                });
                this.live = started(proc.pid);
                return proc;
            });
        } else {
            this.dryRunActive = true;
            this.live = started();
        }
        this.services.notifyStateChange();
        return this.live;
    }

    async stop(): Promise<void> {
        if (!this.sup && !this.dryRunActive) return; // never started — nothing to stop
        await this.sup?.stop();
        this.control.stop();
        this.dryRunActive = false;
        this.live = { ...this.live, running: false, pid: undefined };
        this.services.notifyStateChange();
    }

    /** Send SIGHUP to srtla_send (ask it to re-read the uplinks file); true when delivered. */
    signalReload(): boolean {
        if (this.services.dryRun) {
            console.log("[DRY-RUN] SIGHUP srtla_send");
            return true;
        }
        const pid = this.running ? this.sup?.pid : undefined;
        if (!pid) return false;
        try {
            process.kill(pid, "SIGHUP");
            console.log(`Sent SIGHUP to srtla_send (pid ${pid})`);
            return true;
        } catch (err: unknown) {
            console.warn(`Failed to signal srtla_send: ${errorMessage(err)}`);
            return false;
        }
    }

    /** Reload after an uplinks-file change: SIGHUP by default, restart as fallback / on request. */
    async reload(): Promise<void> {
        if (!this.running) return;

        if (this.cfg.reloadMode === "signal") {
            if (this.signalReload()) {
                this.live = {
                    ...this.live,
                    lastReloadAt: Date.now(),
                    reloadCount: (this.live.reloadCount ?? 0) + 1,
                };
                this.services.notifyStateChange();
                return;
            }
            console.warn("SIGHUP failed — falling back to restart");
        }

        const { sendPort, remoteHost, remotePort } = this.live;
        if (!sendPort || !remoteHost || !remotePort) {
            console.warn("No srtla_send args cached — cannot restart");
            return;
        }
        const launch = this.lastLaunch;
        if (!launch) {
            console.warn("No srtla_send launch cached — cannot restart");
            return;
        }
        console.log("Restarting srtla_send to pick up new uplinks file...");
        await this.stop();
        await Bun.sleep(200);
        await this.start(launch.bin, launch.launch, {
            listenPort: this.live.listenPort,
        });
    }

    /**
     * Apply scheduler options to a running srtla_send over its control
     * socket. Returns false when they only take effect on the next start.
     * (Persistence is the caller's job.)
     */
    async applyOptions(opts: SrtlaOptions): Promise<boolean> {
        if (this.services.dryRun) {
            console.log(`[DRY-RUN] srtla_send options ${JSON.stringify(opts)}`);
            return this.running;
        }
        if (!this.running || !this.control.state().connected) return false;
        if (opts.mode) await this.control.rpc("set_mode", { mode: opts.mode });
        if (opts.quality !== undefined)
            await this.control.rpc("set_quality", { enabled: opts.quality });
        return true;
    }

    /** srtla_send died on its own (e.g. all uplinks lost): keep retrying. */
    private onExit(code: number | null): void {
        console.log(`srtla_send exited with code ${code}`);
        this.control.stop();
        this.live = { ...this.live, running: false, pid: undefined };
        this.services.notifyStateChange();
        if (!this.sup?.wanted) return;
        this.services.logEvent(
            "warn",
            this.cfg.section,
            t("log.srtla_exited", {
                code,
                delay: this.cfg.restartDelayMs / 1000,
            }),
        );
        this.sup?.scheduleRestart();
    }
}

/**
 * The device-summary fragment of a stats push: the total bitrate (bytes/s
 * across all links) and the link counts, merged into the device list row.
 */
export function srtlaStatsSummary(ev: SrtlaStatsEvent): {
    bitrate?: number;
    activeLinks?: number;
    totalLinks?: number;
} {
    return ev.stats
        ? {
              bitrate: ev.stats.links.reduce(
                  (sum, l) => sum + (l.bitrate_bytes_per_sec || 0),
                  0,
              ),
              activeLinks: ev.stats.active_links,
              totalLinks: ev.stats.total_links,
          }
        : {};
}
