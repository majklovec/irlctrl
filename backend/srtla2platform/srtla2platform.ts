#!/usr/bin/env bun
/**
 * srtla2platform — irlctrl device-side agent.
 *
 * Receives a bonded SRTLA stream from an encoder, de-bonds it to standard SRT
 * with `srtla_rec` (built from irlserver/srtla, rev b8359bc — the same
 * receiver the OBS plugin embeds), then remuxes SRT (MPEG-TS) → FLV/RTMP with
 * ffmpeg and publishes it to a user-configured platform (e.g. Kick).
 *
 * `srtla_rec` handles the packet-level bonding (REG1/REG2/REG3, link
 * aggregation, ACK throttling); this agent only orchestrates the processes
 * and the irlctrl control plane.
 *
 * It registers with the irlctrl control server over WebSocket as a device of
 * role `srtla2platform` and accepts `start` / `stop` / `status` commands.
 *
 * The media pipeline is independent of the control link: the stream keeps
 * flowing even while the WebSocket is down, and status/log events are replayed
 * on reconnect.
 *
 * Requires `srtla_rec` built from https://github.com/irlserver/srtla
 * (rev b8359bc, pinned by the OBS SRTLA input plugin) and ffmpeg on $PATH.
 *
 * The irlctrl token is supplied via the CONTROL_SERVER_TOKEN env var (never a
 * CLI flag, so it does not leak into the process list) or config file.
 *
 * The RTMP stream key (RTMP_KEY) is appended to RTMP_URL as the final path
 * segment (rtmp://host/live + key → rtmp://host/live/key); like the token it
 * is never a CLI flag. Precedence: URL = CLI flag > rtmpUrlFile (dynamic
 * source) > config file > RTMP_URL env var; key = config file > RTMP_KEY env
 * var. The config file is written by the web UI, so a UI edit stays
 * authoritative across restarts (the env vars are first-run bootstrap only).
 *
 * The `profile` config field selects an ffmpeg output profile. Profiles are
 * JSON files in the profiles directory (--profiles / PROFILES_DIR, default
 * ~/.config/srtla2platform/profiles; ./config/srtla2platform/profiles in the
 * container) holding the extra ffmpeg arguments to append after `-i`.
 * Defaults (copy-only, H.264/H.265 re-encode, audio-only) are shipped in the
 * repo (backend/srtla2platform/defaults/profiles/) and seeded into the
 * directory on first run (never overwriting user files); it can be edited or
 * extended by adding more <id>.json files.
 * The selected profile is appended to the fixed input→FLV→output command
 * chain.
 *
 * Usage:
 *   CONTROL_SERVER_TOKEN=<t> RTMP_KEY=<key> bun srtla2platform.ts \
 *     --server-url ws://host:7788/device \
 *     --rtmp-url rtmp://host/live --input-format ts
 *
 * All options can also be supplied via environment variables or `~/.config/
 * srtla2platform/config.json` (see ConfigFile).
 */

import { randomUUID } from "node:crypto";
import {
    type Dirent,
    copyFileSync,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    writeFileSync,
} from "node:fs";
import { homedir, hostname as osHostname } from "node:os";
import { join, resolve } from "node:path";

import { APP_VERSION } from "../../generated/version";
import { arg, argFail, enumArg, flag } from "../../shared/args";
import {
    COLOR_RE,
    DEFAULT_COLOR,
    HOSTNAME_RE,
    REMOTE_URL_RE,
} from "../../shared/validate";

/** Bun's WebSocket global is typed by lib.dom; Bun's accepts a `headers` option. */
const BunWebSocket = WebSocket as unknown as new (
    url: string,
    options?: Bun.WebSocketOptions,
) => Bun.WebSocket;

// ── Constants ────────────────────────────────────────────────────────────────

const ROLE = "srtla2platform";
const ID_RE = /^[\w.-]{1,64}$/;
const CONFIG_DIR = join(homedir(), ".config", "srtla2platform");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
const UUID_FILE = join(CONFIG_DIR, "uuid");

const DEFAULTS = {
    controlServerUrl: "ws://127.0.0.1:7788/device",
    srtlaPort: 5000,
    srtPort: 5002,
    bindHost: "127.0.0.1",
    // Upstream SRT encoders negotiate ~2000 ms of jitter buffering; ffmpeg's
    // SRT input defaults to 120 ms, which is too small for the relayed stream.
    srtLatencyMs: 2000,
    inputFormat: "ts" as InputFormat,
    profilesDir: join(CONFIG_DIR, "profiles"),
    profile: "copy",
};

const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
const PING_INTERVAL_MS = 15_000;
const STATUS_INTERVAL_MS = 15_000;
const PORT_READY_TIMEOUT_MS = 5_000;
const STOP_GRACE_MS = 3_000;
const HEALTH_CHECK_INTERVAL_MS = 5_000;
const HEALTH_CHECK_THRESHOLD = 3;
const LOG_MAX = 500;

type InputFormat = "ts" | "h264";
type LogLevel = "info" | "warn" | "error";
type StreamState = "idle" | "starting" | "running" | "stopping";

interface ConfigFile {
    controlServerUrl?: string;
    token?: string;
    hostname?: string;
    color?: string;
    srtlaPort?: number;
    srtPort?: number;
    srtLatencyMs?: number;
    metricsPort?: number;
    bindHost?: string;
    rtmpUrl?: string;
    rtmpUrlFile?: string;
    rtmpKey?: string;
    inputFormat?: InputFormat;
    profile?: string;
    profilesDir?: string;
    autoStart?: boolean;
}

interface Config {
    controlServerUrl: string;
    token: string;
    hostname: string;
    color: string;
    uuid: string;
    srtlaPort: number;
    srtPort: number;
    srtLatencyMs: number;
    metricsPort: number;
    bindHost: string;
    rtmpUrl: string;
    rtmpKey: string;
    inputFormat: InputFormat;
    /** Directory holding user-authored ffmpeg profile files (JSON). */
    profilesDir: string;
    /** The selected ffmpeg output profile id (built-in or a file in
     * profilesDir). */
    profile: string;
    autoStart: boolean;
    dryRun: boolean;
}

interface LogEntry {
    id: number;
    at: number;
    level: LogLevel;
    section: string;
    message: string;
}

/** Inbound server → device frames. */
interface ServerMessage {
    type?: string;
    id?: number;
    method?: string;
    params?: Record<string, unknown>;
    event?: string;
    data?: unknown;
}

// ── Module state ─────────────────────────────────────────────────────────────

let config: Config;

/** Apply a partial change to the live config (web-UI saves go through here;
 * callers persist with writeConfigFile() afterwards). */
function applyConfig(partial: Partial<Config>): void {
    Object.assign(config, partial);
}

let ws: Bun.WebSocket | null = null;
let linkStopped = true;
let backoff = BACKOFF_MIN_MS;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let pingTimer: ReturnType<typeof setInterval> | null = null;
let statusTimer: ReturnType<typeof setInterval> | null = null;

let streamState: StreamState = "idle";
let srtlaProc: Bun.Subprocess | null = null;
let ffmpegProc: Bun.Subprocess | null = null;
let epoch = 0;
let startedAt = 0;

// Operator intent: while a child crashes, a stream the operator started is
// restarted (with backoff) instead of being left dead; an explicit stop
// clears it so the stream stays down.
let wantsRunning = false;
let streamRestarts = 0;
let streamBackoff = BACKOFF_MIN_MS;
let restartTimer: ReturnType<typeof setTimeout> | null = null;

/** A stream that stayed up this long resets the restart backoff. */
const STREAM_RESTART_STABLE_MS = 60_000;

let logSeq = 0;
let lastFlushedId = 0;
const logBuffer: LogEntry[] = [];

// ── Small helpers ────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const errMsg = (e: unknown): string =>
    e instanceof Error ? e.message : String(e);

function detectLocale(): string {
    const raw =
        process.env.LC_ALL ?? process.env.LC_MESSAGES ?? process.env.LANG ?? "";
    const lang = raw.split(".", 1)[0] ?? "";
    return lang === "" ? "en" : lang;
}

function firstDefined<T>(...vals: Array<T | null | undefined>): T | undefined {
    for (const v of vals) if (v !== null && v !== undefined) return v;
    return undefined;
}

const toPort = (
    value: string | number | null | undefined,
    fallback: number,
    name: string,
): number => {
    if (value === undefined || value === null) return fallback;
    const n = Number(value);
    return Number.isInteger(n) && n >= 1 && n <= 65535
        ? n
        : argFail(name, String(value), "a TCP port (1-65535)");
};

/** SRT latency in ms — clamped to a sane range instead of failing, since it
 * arrives from the web-UI config file and only affects receive buffering. */
const toLatency = (
    value: string | number | null | undefined,
    fallback: number,
): number => {
    if (value === undefined || value === null) return fallback;
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(30_000, Math.max(50, Math.trunc(n)));
};

/** Like `toPort` but 0 (disabled) is a valid value. */
const toOptionalPort = (
    value: string | number | null | undefined,
    name: string,
): number => {
    if (value === undefined || value === null || value === "") return 0;
    const n = Number(value);
    return Number.isInteger(n) && n >= 0 && n <= 65535
        ? n
        : argFail(name, String(value), "a TCP port (0-65535, 0 = disabled)");
};

// ── Logging ──────────────────────────────────────────────────────────────────

function log(level: LogLevel, message: string, section = ROLE): void {
    logSeq += 1;
    const entry: LogEntry = {
        id: logSeq,
        at: Date.now(),
        level,
        section,
        message,
    };
    logBuffer.push(entry);
    if (logBuffer.length > LOG_MAX) logBuffer.shift();

    const line = `${new Date(entry.at).toISOString()} ${level
        .toUpperCase()
        .padEnd(5)} [${section}] ${message}`;
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);

    flushLogs();
}

function flushLogs(): void {
    if (!wsOpen()) return;
    const fresh = logBuffer.filter((e) => e.id > lastFlushedId);
    if (fresh.length === 0) return;
    lastFlushedId = fresh[fresh.length - 1].id;
    wsSend({ type: "event", event: "log", data: { entries: fresh } });
}

function replayLogs(): void {
    if (!wsOpen() || logBuffer.length === 0) return;
    lastFlushedId = logBuffer[logBuffer.length - 1].id;
    wsSend({
        type: "event",
        event: "log",
        data: { reset: true, entries: logBuffer },
    });
}

// ── Status ───────────────────────────────────────────────────────────────────

function currentStatus(): Record<string, unknown> {
    return {
        role: ROLE,
        setupRequired: config.rtmpUrl === "",
        state: {
            autostart: config.autoStart,
            stream: streamState,
            rtmp: config.rtmpUrl === "" ? null : effectiveRtmpUrl(),
            inputFormat: config.inputFormat,
            profile: config.profile,
            srtlaPort: config.srtlaPort,
            srtPort: config.srtPort,
            srtLatencyMs: config.srtLatencyMs,
            metricsPort: config.metricsPort,
            uptimeMs:
                streamState === "running" && startedAt > 0
                    ? Date.now() - startedAt
                    : 0,
            restarts: streamRestarts,
        },
        // The web-UI refreshes its module cards from this push; an empty
        // object would wipe every card's form values.
        modules: moduleSliceView(),
    };
}

function pushStatus(): void {
    if (!wsOpen()) return;
    wsSend({ type: "event", event: "status", data: currentStatus() });
}

// ── WebSocket link ───────────────────────────────────────────────────────────

const wsOpen = (): boolean => ws !== null && ws.readyState === WebSocket.OPEN;

function wsSend(obj: unknown): void {
    if (!wsOpen()) return;
    ws?.send(JSON.stringify(obj));
}

function stopTimers(): void {
    if (pingTimer) {
        clearInterval(pingTimer);
        pingTimer = null;
    }
    if (statusTimer) {
        clearInterval(statusTimer);
        statusTimer = null;
    }
}

function startTimers(): void {
    stopTimers();
    pingTimer = setInterval(() => {
        try {
            ws?.ping();
        } catch {
            /* ignore */
        }
    }, PING_INTERVAL_MS);
    statusTimer = setInterval(pushStatus, STATUS_INTERVAL_MS);
}

function scheduleConnect(): void {
    if (linkStopped || reconnectTimer) return;
    const delay =
        Math.min(backoff, BACKOFF_MAX_MS) * (0.5 + Math.random() * 0.5);
    backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
    }, delay);
}

function connect(): void {
    if (linkStopped || wsOpen()) return;

    const headers: Record<string, string> = {
        "x-device-id": config.uuid,
        "x-device-role": ROLE,
    };
    if (config.token) headers.authorization = `Bearer ${config.token}`;

    let socket: Bun.WebSocket;
    try {
        socket = new BunWebSocket(config.controlServerUrl, { headers });
    } catch (err) {
        log(
            "error",
            `connect() to ${config.controlServerUrl} threw: ${errMsg(err)}`,
        );
        scheduleConnect();
        return;
    }
    ws = socket;

    socket.addEventListener("open", () => {
        backoff = BACKOFF_MIN_MS;
        log("info", `control link connected to ${config.controlServerUrl}`);
        wsSend({
            type: "hello",
            id: config.uuid,
            role: ROLE,
            hostname: config.hostname,
            color: config.color,
            language: detectLocale(),
            version: APP_VERSION,
        });
        replayLogs();
        pushStatus();
        startTimers();
    });

    socket.addEventListener("message", (ev) => {
        let msg: ServerMessage;
        try {
            msg = JSON.parse(
                String((ev as MessageEvent).data),
            ) as ServerMessage;
        } catch {
            log("warn", "dropping malformed control frame");
            return;
        }
        handleServerMessage(msg);
    });

    socket.addEventListener("close", () => {
        stopTimers();
        ws = null;
        log("warn", "control link closed — reconnecting");
        scheduleConnect();
    });

    socket.addEventListener("error", () => {
        // The close handler follows and drives the reconnect.
    });
}

function handleServerMessage(msg: ServerMessage): void {
    if (
        (msg.type === "request" || typeof msg.id === "number") &&
        typeof msg.method === "string"
    ) {
        const id = msg.id as number;
        handleCommand(msg.method, msg.params ?? {})
            .then((result) =>
                wsSend({ type: "response", id, ok: true, result }),
            )
            .catch((err) =>
                wsSend({
                    type: "response",
                    id,
                    ok: false,
                    error: errMsg(err),
                }),
            );
        return;
    }
    // Server → device events (and anything else) are not actionable here.
}

async function handleCommand(
    method: string,
    params: Record<string, unknown>,
): Promise<unknown> {
    switch (method) {
        case "start":
            return startStream();
        case "stop":
            return explicitStop();
        case "status":
            return currentStatus();
        case "settings.get":
            return {
                settings: {
                    uuid: config.uuid,
                    hostname: config.hostname,
                    role: ROLE,
                    remoteUrl: config.controlServerUrl,
                    hasRemoteToken: config.token !== "",
                    color: config.color,
                },
                restartRequired: true,
            };
        case "settings.update":
            return settingsUpdate(params);
        case "modules.list":
            return { modules: moduleSliceView() };
        case "modules.configure":
            return modulesConfigure(params);
        default:
            log("warn", `ignoring unknown command: ${method}`);
            throw new Error(`Unknown method: ${method}`);
    }
}

/** Shared settings page save: name / color / remote url + token. The role is
 * locked (this box is always `srtla2platform`). A remote change re-dials the
 * socket so the fresh hello carries the new name / color / URL / token. */
function settingsUpdate(params: Record<string, unknown>): unknown {
    if (params.uuid !== undefined && params.uuid !== config.uuid)
        throw new Error("The device uuid can't be changed");
    if (params.role !== undefined && params.role !== ROLE)
        throw new Error("The role of this device is always srtla2platform");

    const hostname =
        typeof params.hostname === "string" && params.hostname !== ""
            ? params.hostname
            : config.hostname;
    if (!HOSTNAME_RE.test(hostname))
        throw new Error(`Invalid hostname: ${hostname}`);

    const color =
        typeof params.color === "string" && params.color !== ""
            ? params.color
            : config.color;
    if (!COLOR_RE.test(color)) throw new Error(`Invalid color: ${color}`);

    const remoteUrl =
        typeof params.remoteUrl === "string" && params.remoteUrl !== ""
            ? params.remoteUrl
            : config.controlServerUrl;
    if (REMOTE_URL_RE.test(remoteUrl) === false)
        throw new Error(
            `Remote URL must start with ws:// or wss://: ${remoteUrl}`,
        );

    let remoteToken = config.token;
    if (params.remoteToken !== undefined) {
        if (typeof params.remoteToken !== "string")
            throw new Error("remoteToken must be a string");
        remoteToken = params.remoteToken.trim();
    }

    const remoteChanged =
        remoteUrl !== config.controlServerUrl || remoteToken !== config.token;
    const renamed = hostname !== config.hostname;
    const colorChanged = color !== config.color;
    config.hostname = hostname;
    config.color = color;
    config.controlServerUrl = remoteUrl;
    config.token = remoteToken;
    writeConfigFile();

    if (remoteChanged || ((renamed || colorChanged) && remoteUrl !== ""))
        ws?.close(
            1001,
            remoteChanged
                ? "remote settings changed"
                : renamed
                  ? "device renamed"
                  : "device recoloured",
        );

    return {
        settings: {
            uuid: config.uuid,
            hostname: config.hostname,
            role: ROLE,
            remoteUrl: config.controlServerUrl,
            hasRemoteToken: config.token !== "",
            color: config.color,
        },
        restartRequired: true,
    };
}

/** RTMP destination / stream key from the settings card. The key is
 * write-only (an empty value keeps the current one) and a running stream is
 * restarted so it republishes to the new destination. */
async function modulesConfigure(
    params: Record<string, unknown>,
): Promise<unknown> {
    const id = params.id;
    if (id !== ROLE) throw new Error(`Unknown module: ${String(id)}`);
    const cfg = isRecord(params.config) ? params.config : {};

    if (typeof cfg.rtmpUrl === "string") {
        const url = cfg.rtmpUrl.trim();
        if (url !== "" && !isRtmpUrl(url))
            throw new Error(`RTMP URL must be an rtmp(s):// URL: ${url}`);
        // Apply to the live config — writeConfigFile() persists THAT, not
        // this temp object.
        applyConfig({ rtmpUrl: url });
    }
    if (typeof cfg.rtmpKey === "string" && cfg.rtmpKey !== "")
        applyConfig({ rtmpKey: cfg.rtmpKey.trim() });
    if (typeof cfg.profile === "string") {
        const id = cfg.profile.trim();
        if (id !== "" && findProfile(id) === undefined)
            throw new Error(`Unknown profile: ${id}`);
        applyConfig({ profile: id });
    }

    writeConfigFile();
    if (streamState === "running") await restartStream();
    pushStatus();
    return { ok: true, modules: moduleSliceView() };
}

// ── Preflight ────────────────────────────────────────────────────────────────

function which(bin: string): string | null {
    try {
        const r = Bun.spawnSync(["which", bin]);
        if (r.exitCode === 0) {
            const out = r.stdout.toString().trim();
            return out === "" ? null : out;
        }
    } catch {
        /* ignore */
    }
    return null;
}

function preflight(): void {
    const missing: string[] = [];
    if (which("srtla_rec") === null) missing.push("srtla_rec");
    if (which("ffmpeg") === null) missing.push("ffmpeg");
    if (missing.length > 0)
        throw new Error(
            `Missing binaries: ${missing.join(", ")}. Install them and retry.`,
        );
}

// ── Process management ───────────────────────────────────────────────────────

async function pumpOutput(
    stream: ReadableStream<Uint8Array>,
    label: string,
    level: LogLevel = "info",
): Promise<void> {
    const decoder = new TextDecoder();
    let buf = "";
    try {
        for await (const chunk of stream) {
            buf += decoder.decode(chunk, { stream: true });
            let nl = buf.indexOf("\n");
            while (nl >= 0) {
                const line = buf.slice(0, nl).replace(/\r$/, "").trim();
                buf = buf.slice(nl + 1);
                if (line !== "")
                    log(level, `[${label}] ${line.slice(0, 400)}`, label);
                nl = buf.indexOf("\n");
            }
        }
    } catch {
        /* stream closed */
    }
}

function onChildExit(label: string, code: number | null): void {
    const desc = code === null ? "via signal" : `with code ${code}`;
    // An exit is expected (info) when the process exits cleanly, or when we
    // are not running — i.e. it is a child we just SIGTERM'd during a stop
    // (143) or the ffmpeg that follows the first child dying. Only an
    // unclean exit *while running* is a real fault worth a warning.
    const expected = code === 0 || code === null || streamState !== "running";
    if (expected) log("info", `${label} exited ${desc}`);
    else log("warn", `${label} exited ${desc}`);

    // Either child dying while we believe the stream is up is a real
    // failure — tear the whole stream down so state stays honest. If the
    // operator wants the stream up, bring it back with backoff.
    if (
        (label === "ffmpeg" || label === "srtla_rec") &&
        streamState === "running"
    ) {
        if (wantsRunning) scheduleStreamRestart(`${label} is down`);
        else {
            log("warn", `${label} is down — stopping stream`);
            stopStream();
        }
    }
}

function spawnProc(
    name: string,
    args: string[],
    label: string,
): Bun.Subprocess {
    log("info", `spawning ${label}: ${name} ${args.join(" ")}`);
    const proc = Bun.spawn([name, ...args], {
        stdout: "pipe",
        stderr: "pipe",
    });
    void pumpOutput(proc.stdout as ReadableStream<Uint8Array>, label);
    void pumpOutput(proc.stderr as ReadableStream<Uint8Array>, label, "warn");
    proc.exited
        .then((code) => onChildExit(label, code))
        .catch(() => onChildExit(label, null));
    return proc;
}

function killProcs(): void {
    for (const p of [srtlaProc, ffmpegProc]) {
        if (!p) continue;
        try {
            p.kill("SIGTERM");
        } catch {
            /* already gone */
        }
    }
}

function resetStreamHandles(): void {
    srtlaProc = null;
    ffmpegProc = null;
}

// 5 s health monitor: srtla_rec's SRTLA UDP port is the liveness signal for
// the whole stream (bonded senders, SRT link, pipeline). Three consecutive
// misses tear the stream down (the spec's 15 s "not running" behavior).
let healthFails = 0;

function startHealthMonitor(): void {
    healthFails = 0;
    setInterval(() => {
        if (streamState !== "running") {
            healthFails = 0;
            return;
        }
        if (isUdpPortOpen(config.srtlaPort)) {
            healthFails = 0;
            // A stable run resets the backoff ladder.
            if (Date.now() - startedAt > STREAM_RESTART_STABLE_MS) {
                streamBackoff = BACKOFF_MIN_MS;
                streamRestarts = 0;
            }
            return;
        }
        healthFails += 1;
        if (healthFails >= HEALTH_CHECK_THRESHOLD) {
            healthFails = 0;
            const why = `SRTLA port ${config.srtlaPort} not open for ${
                (HEALTH_CHECK_THRESHOLD * HEALTH_CHECK_INTERVAL_MS) / 1000
            } s`;
            if (wantsRunning) scheduleStreamRestart(why);
            else {
                log("warn", `${why} — stopping stream`);
                stopStream();
            }
        }
    }, HEALTH_CHECK_INTERVAL_MS);
}

// ── ffmpeg output profiles ───────────────────────────────────────────────────

// The ffmpeg output profile is selected via the `profile` config field
// (written by the web UI). Profiles are JSON files in the profiles directory
// (one file per profile, named <id>.json) that supply the extra ffmpeg
// arguments appended after -i. A profile file is:
//   { "name": "My profile", "desc": "…", "args": ["-c:v","libx264", …] }
// The id is the file name (without .json); `args` defaults to copy. The
// default profiles (copy, re-encode, audio-only) are seeded into the
// directory from backend/srtla2platform/defaults/profiles/ on startup
// (never overwriting user files) and can be edited or extended.

interface FfmpegProfile {
    id: string;
    name: string;
    desc: string;
    args: string[];
}

const PROFILE_ID_RE = /^[\w.-]{1,64}$/;

const COPY_ARGS = ["-c", "copy"];

/** Scan the profiles directory for profile files. Returns the valid ones;
 * invalid files are skipped with a warning. */
function listProfiles(): FfmpegProfile[] {
    const dir = resolve(config.profilesDir);
    let entries: Dirent<string>[];
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    } catch {
        return []; // no directory yet (first run) — nothing to list
    }
    const out: FfmpegProfile[] = [];
    for (const e of entries) {
        if (!e.isFile() || e.name.startsWith(".") || !e.name.endsWith(".json"))
            continue;
        const id = e.name.slice(0, -5);
        if (!PROFILE_ID_RE.test(id)) continue;
        const p = join(dir, e.name);
        let raw: unknown;
        try {
            raw = JSON.parse(readFileSync(p, "utf8"));
        } catch (err) {
            log("warn", `profile file ${e.name} is not valid JSON — skipped`);
            continue;
        }
        if (!isRecord(raw)) {
            log("warn", `profile file ${e.name} must be an object — skipped`);
            continue;
        }
        const fileArgs = Array.isArray(raw.args)
            ? raw.args.filter((a): a is string => typeof a === "string")
            : [];
        out.push({
            id,
            name: typeof raw.name === "string" ? raw.name : id,
            desc: typeof raw.desc === "string" ? raw.desc : "",
            args: fileArgs.length > 0 ? fileArgs : COPY_ARGS,
        });
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
}

function findProfile(id: string): FfmpegProfile | undefined {
    return listProfiles().find((p) => p.id === id);
}

/** Seed the profiles directory with the default profile files shipped in the
 * repo (backend/srtla2platform/defaults/profiles/). Non-destructive: an
 * existing file is never overwritten, so user edits survive restarts. */
function seedDefaultProfiles(): void {
    const src = join(import.meta.dir, "defaults", "profiles");
    let files: string[];
    try {
        files = readdirSync(src).filter((n) => n.endsWith(".json"));
    } catch {
        return; // defaults not shipped in this build — nothing to seed
    }
    const dst = resolve(config.profilesDir);
    mkdirSync(dst, { recursive: true });
    for (const f of files) {
        const target = join(dst, f);
        if (!existsSync(target)) copyFileSync(join(src, f), target);
    }
}

// srtla_rec (b8359bc) is the SRT *caller* — it connect()s to the
// downstream address, so ffmpeg must be the SRT *listener*
// (mode=listener in the URI; the standalone -listen option was removed in
// ffmpeg 7).
// The input is a plain MPEG-TS over SRT (what srtla_rec forwards); ffmpeg
// auto-detects the TS, applies the selected output profile's arguments, and
// multiplexes into an FLV over RTMP(S).
function buildPipeline(): string[] {
    // The listener's SRT latency must match what the upstream encoders
    // negotiate (2000 ms through the relay); ffmpeg's 120 ms default is too
    // small and errors out mid-stream.
    const srtUri = `srt://${config.bindHost}:${config.srtPort}?mode=listener&latency=${config.srtLatencyMs}`;

    // Unknown/missing profile (e.g. the file was deleted) → fall back to
    // copy-only so the stream still flows.
    const selected =
        findProfile(config.profile) ??
        ({ id: "copy", name: "Copy", desc: "", args: COPY_ARGS } satisfies FfmpegProfile);

    return [
        "-hide_banner",
        "-loglevel",
        "warning",
        "-i",
        srtUri,
        ...selected.args,
        "-f",
        "flv",
        effectiveRtmpUrl(),
    ];
}

// SRT runs over UDP, so a TCP connect probe can never detect the
// ffmpeg SRT listener. Parse `ss -uln` for a bound socket on the port
// (matches both `*:5000` and `127.0.0.1:5002` style local addresses).
function isUdpPortOpen(port: number): boolean {
    try {
        const r = Bun.spawnSync(["ss", "-uln"]);
        if (r.exitCode !== 0) return false;
        const re = new RegExp(`(^|[\\s:])${port}(?=[\\s])`, "m");
        return re.test(r.stdout.toString());
    } catch {
        return false;
    }
}

function waitForUdpPort(
    port: number,
    timeoutMs: number,
    myEpoch: number,
): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    return (async () => {
        while (Date.now() < deadline) {
            if (myEpoch !== epoch) return false;
            if (isUdpPortOpen(port)) return true;
            await sleep(150);
        }
        return false;
    })();
}

async function startStream(): Promise<Record<string, unknown>> {
    if (streamState === "running")
        return { state: "running", alreadyRunning: true };
    if (streamState === "starting") return { state: "starting" };

    if (config.rtmpUrl === "")
        throw new Error("No RTMP URL configured (set --rtmp-url)");

    preflight();

    wantsRunning = true;
    epoch += 1;
    const myEpoch = epoch;
    streamState = "starting";
    pushStatus();
    log(
        "info",
        `starting stream: srtla:${config.srtlaPort} → srt:${config.bindHost}:${config.srtPort} → ${effectiveRtmpUrl()}`,
    );

    // ffmpeg is the SRT listener (srtla_rec calls into it), so it has to
    // be up first and its UDP port bound before srtla_rec connects out.
    ffmpegProc = spawnProc("ffmpeg", buildPipeline(), "ffmpeg");

    const ready = await waitForUdpPort(
        config.srtPort,
        PORT_READY_TIMEOUT_MS,
        myEpoch,
    );
    if (!ready) {
        if (myEpoch === epoch) {
            killProcs();
            resetStreamHandles();
            streamState = "idle";
            pushStatus();
        }
        throw new Error(`ffmpeg did not open SRT port ${config.srtPort} in time`);
    }

    // irlserver/srtla (rev b8359bc) flag-based invocation.
    const srtlaArgs = [
        "--srtla_port",
        String(config.srtlaPort),
        "--srt_hostname",
        config.bindHost,
        "--srt_port",
        String(config.srtPort),
    ];
    if (config.metricsPort > 0)
        srtlaArgs.push("--metrics_port", String(config.metricsPort));
    srtlaProc = spawnProc("srtla_rec", srtlaArgs, "srtla_rec");

    startedAt = Date.now();
    streamState = "running";
    pushStatus();
    log("info", "stream is running");
    return { state: "running", rtmp: effectiveRtmpUrl() };
}

function stopStream(): Record<string, unknown> {
    if (streamState === "idle") return { state: "idle" };

    epoch += 1;
    streamState = "stopping";
    log("info", "stopping stream");

    killProcs();
    const dying = [srtlaProc, ffmpegProc];
    resetStreamHandles();

    setTimeout(() => {
        for (const p of dying) {
            if (!p) continue;
            try {
                if (Number.isNaN(p.exitCode)) p.kill("SIGKILL");
            } catch {
                /* already gone */
            }
        }
    }, STOP_GRACE_MS);

    startedAt = 0;
    streamState = "idle";
    pushStatus();
    return { state: "idle" };
}

/** Operator-initiated stop: also clears the restart intent so a crashed
 * child does not bring the stream back. */
function explicitStop(): Record<string, unknown> {
    wantsRunning = false;
    if (restartTimer !== null) {
        clearTimeout(restartTimer);
        restartTimer = null;
    }
    streamRestarts = 0;
    streamBackoff = BACKOFF_MIN_MS;
    return stopStream();
}

/** A child (or the health check) failed while the operator wants the stream
 * up: tear it down and respawn with exponential backoff (1 s → 30 s). */
function scheduleStreamRestart(reason: string): void {
    if (restartTimer !== null) {
        clearTimeout(restartTimer);
        restartTimer = null;
    }
    streamRestarts += 1;
    const delay = streamBackoff;
    streamBackoff = Math.min(streamBackoff * 2, BACKOFF_MAX_MS);
    log(
        "warn",
        `${reason} — restarting stream in ${Math.round(delay / 1000)}s (restart #${streamRestarts})`,
    );
    stopStream();
    restartTimer = setTimeout(() => {
        restartTimer = null;
        if (!wantsRunning) return;
        startStream().catch((e) => {
            log("error", `auto-restart failed: ${errMsg(e)}`);
            scheduleStreamRestart("auto-restart failed");
        });
    }, delay);
    pushStatus();
}

/** Stop then start again (a config change to the RTMP destination); a failed
 * restart is logged, not fatal — the operator can start it manually. */
async function restartStream(): Promise<void> {
    log("info", "restarting stream to apply new settings");
    stopStream();
    try {
        await startStream();
    } catch (err) {
        log("warn", `restart after settings change failed: ${errMsg(err)}`);
    }
}

// ── Config ───────────────────────────────────────────────────────────────────

function readConfigFile(path: string | undefined): ConfigFile | undefined {
    const p = path ?? CONFIG_FILE;
    if (!existsSync(p)) return undefined;
    try {
        return JSON.parse(readFileSync(p, "utf8")) as ConfigFile;
    } catch (err) {
        argFail("--config", p, `valid JSON (got ${errMsg(err)})`);
    }
}

function readStoredUuid(): string | undefined {
    try {
        const v = readFileSync(UUID_FILE, "utf8").trim();
        return ID_RE.test(v) ? v : undefined;
    } catch {
        return undefined;
    }
}

function storeUuid(uuid: string): void {
    try {
        mkdirSync(CONFIG_DIR, { recursive: true });
        writeFileSync(UUID_FILE, `${uuid}\n`);
    } catch (err) {
        log("warn", `could not persist DEVICE_UUID: ${errMsg(err)}`);
    }
}

/** Persist the live `config` back to CONFIG_FILE, preserving fields (e.g.
 * rtmpUrlFile) that are read at load but not kept in the in-memory Config. */
function writeConfigFile(): void {
    try {
        mkdirSync(CONFIG_DIR, { recursive: true });
        const existing = readConfigFile(CONFIG_FILE) ?? {};
        const next: ConfigFile = {
            ...existing,
            controlServerUrl: config.controlServerUrl,
            token: config.token,
            hostname: config.hostname,
            color: config.color,
            srtlaPort: config.srtlaPort,
            srtPort: config.srtPort,
            srtLatencyMs: config.srtLatencyMs,
            metricsPort:
                config.metricsPort > 0 ? config.metricsPort : undefined,
            bindHost: config.bindHost,
            rtmpUrl: config.rtmpUrl,
            rtmpKey: config.rtmpKey,
            inputFormat: config.inputFormat,
            profile: config.profile,
            profilesDir: config.profilesDir,
            autoStart: config.autoStart,
        };
        writeFileSync(CONFIG_FILE, `${JSON.stringify(next, null, 4)}\n`);
    } catch (err) {
        log("warn", `could not persist config: ${errMsg(err)}`);
    }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);

/** The device's module slice for the settings page: the stream key comes back
 * masked as {configured}, matching the core's secret handling. */
function moduleSliceView(): Record<string, unknown> {
    return {
        srtla2platform: {
            enabled: true,
            rtmpUrl: config.rtmpUrl,
            rtmpKey: { configured: config.rtmpKey !== "" },
            profile: config.profile,
            profiles: listProfiles(),
            profilesDir: config.profilesDir,
        },
    };
}

function isRtmpUrl(url: string): boolean {
    try {
        return (
            new URL(url).protocol === "rtmp:" ||
            new URL(url).protocol === "rtmps:"
        );
    } catch {
        return false;
    }
}

// The stream key is a canonical RTMP path segment (rtmp://host/app/key).
// Append it to the URL's path; an empty key leaves the URL untouched.
function resolveRtmpUrl(rtmpUrl: string, rtmpKey: string): string {
    if (rtmpUrl === "" || rtmpKey === "") return rtmpUrl;
    try {
        const u = new URL(rtmpUrl);
        u.pathname = `${u.pathname.replace(/\/+$/, "")}/${rtmpKey}`;
        return u.toString();
    } catch {
        // Not parseable — fall back to a bare concatenation.
        return `${rtmpUrl.replace(/\/+$/, "")}/${rtmpKey}`;
    }
}

// The RTMP location the pipeline publishes to: RTMP_URL with the RTMP_KEY
// appended as the final path segment (empty key → unchanged).
function effectiveRtmpUrl(): string {
    return resolveRtmpUrl(config.rtmpUrl, config.rtmpKey);
}

function loadConfig(): Config {
    if (flag("--version")) {
        console.log(`srtla2platform ${APP_VERSION}`);
        process.exit(0);
    }

    const file = readConfigFile(arg("--config"));

    const storedUuid = readStoredUuid();
    const uuid =
        firstDefined(arg("--uuid"), process.env.DEVICE_UUID, storedUuid) ??
        randomUUID();
    if (uuid !== storedUuid) storeUuid(uuid);
    if (!ID_RE.test(uuid))
        argFail("--uuid", uuid, "a device id matching /^\\w[-\\w.]{0,63}$/");

    const rtmpUrlFile = firstDefined(arg("--rtmp-url-file"), file?.rtmpUrlFile);
    let rtmpFromUrlFile: string | undefined;
    if (rtmpUrlFile) {
        try {
            rtmpFromUrlFile = readFileSync(rtmpUrlFile, "utf8").trim();
        } catch (err) {
            argFail(
                "--rtmp-url-file",
                rtmpUrlFile,
                `a readable file (${errMsg(err)})`,
            );
        }
    }

    // Precedence: CLI flag > rtmpUrlFile (dynamic/auto-rotating source) >
    // config file (written by the web UI, so a UI edit stays authoritative
    // across restarts) > RTMP_URL env var (first-run bootstrap default).
    const rtmpUrl =
        firstDefined(
            arg("--rtmp-url"),
            rtmpFromUrlFile,
            file?.rtmpUrl,
            process.env.RTMP_URL,
        ) ?? "";
    if (rtmpUrl !== "" && !isRtmpUrl(rtmpUrl))
        log(
            "warn",
            `RTMP URL is not an rtmp(s):// URL and will fail at start: ${rtmpUrl}`,
        );

    // Stream key is never a CLI flag (it is a secret, like the token): config
    // file (web-UI persisted), then RTMP_KEY env var as a bootstrap default.
    // It is appended to rtmpUrl as the final path segment.
    const rtmpKey = firstDefined(file?.rtmpKey, process.env.RTMP_KEY) ?? "";

    const inputFormat = enumArg(
        "--input-format",
        ["ts", "h264"] as const,
        firstDefined(file?.inputFormat, DEFAULTS.inputFormat) ??
            DEFAULTS.inputFormat,
    );

    // ffmpeg output profiles: the user-authored JSON profile files live in
    // the profiles directory; the selected profile id comes from the config
    // file (written by the web UI), not a CLI flag.
    const profilesDir = firstDefined(
        arg("--profiles"),
        process.env.PROFILES_DIR,
        file?.profilesDir,
        DEFAULTS.profilesDir,
    ) as string;
    const profile = firstDefined(file?.profile, DEFAULTS.profile) as string;

    const cfg: Config = {
        controlServerUrl: firstDefined(
            arg("--server-url"),
            process.env.CONTROL_SERVER_URL,
            file?.controlServerUrl,
            DEFAULTS.controlServerUrl,
        ) as string,
        // Token is never a CLI flag — it would leak into the process list.
        // Source: CONTROL_SERVER_TOKEN env var, then config file.
        token:
            firstDefined(process.env.CONTROL_SERVER_TOKEN, file?.token) ?? "",
        hostname: file?.hostname ?? osHostname(),
        color: file?.color ?? DEFAULT_COLOR,
        uuid,
        srtlaPort: toPort(
            firstDefined<string | number>(
                arg("--srtla-port"),
                file?.srtlaPort,
                DEFAULTS.srtlaPort,
            ),
            DEFAULTS.srtlaPort,
            "--srtla-port",
        ),
        srtPort: toPort(
            firstDefined<string | number>(
                arg("--srt-port"),
                file?.srtPort,
                DEFAULTS.srtPort,
            ),
            DEFAULTS.srtPort,
            "--srt-port",
        ),
        srtLatencyMs: toLatency(
            firstDefined<string | number>(
                arg("--srt-latency-ms"),
                file?.srtLatencyMs,
                DEFAULTS.srtLatencyMs,
            ),
            DEFAULTS.srtLatencyMs,
        ),
        metricsPort: toOptionalPort(
            firstDefined<string | number>(
                arg("--metrics-port"),
                process.env.SRTLA_METRICS_PORT,
                file?.metricsPort,
            ),
            "--metrics-port",
        ),
        bindHost:
            firstDefined(
                arg("--bind-host"),
                process.env.SRT_BIND_HOST,
                file?.bindHost,
                DEFAULTS.bindHost,
            ) ?? DEFAULTS.bindHost,
        rtmpUrl,
        rtmpKey,
        inputFormat,
        profilesDir,
        profile,
        autoStart: flag("--autostart") || file?.autoStart === true,
        dryRun: flag("--dry-run"),
    };

    return cfg;
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

function shutdown(): void {
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    explicitStop();
    linkStopped = true;
    stopTimers();
    try {
        ws?.terminate();
    } catch {
        /* ignore */
    }
    process.exit(0);
}

function main(): void {
    config = loadConfig();
    seedDefaultProfiles();

    if (config.dryRun) {
        console.log(
            JSON.stringify(
                {
                    dryRun: true,
                    appVersion: APP_VERSION,
                    config: {
                        ...config,
                        token: config.token === "" ? "" : "***",
                        rtmpKey: config.rtmpKey === "" ? "" : "***",
                    },
                },
                null,
                2,
            ),
        );
        return;
    }

    log(
        "info",
        `srtla2platform ${APP_VERSION} starting (uuid=${config.uuid.slice(
            0,
            8,
        )}…, role=${ROLE})`,
    );

    startHealthMonitor();
    linkStopped = false;
    connect();

    if (config.autoStart) {
        setTimeout(() => {
            startStream().catch((e) =>
                log("error", `autostart failed: ${errMsg(e)}`),
            );
        }, 1_000);
    }

    for (const sig of ["SIGINT", "SIGTERM"] as const) {
        process.on(sig, () => shutdown());
    }
}

main();
