#!/usr/bin/env bun
/**
 * srtla2platform — irlctrl device-side agent.
 *
 * Receives a bonded SRTLA stream from an encoder, de-bonds it to standard SRT
 * with `srtla_rec` (built from irlserver/srtla, rev b8359bc — the same
 * receiver the OBS plugin embeds), then transcodes/muxes SRT → RTMP with
 * GStreamer and publishes it to a user-configured platform (e.g. mediamtx).
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
 * (rev b8359bc, pinned by the OBS SRTLA input plugin) and GStreamer on $PATH.
 *
 * The irlctrl token is supplied via the CONTROL_SERVER_TOKEN env var (never a
 * CLI flag, so it does not leak into the process list) or config file.
 *
 * Usage:
 *   CONTROL_SERVER_TOKEN=<t> bun srtla2platform.ts \
 *     --server-url ws://host:7788/device \
 *     --rtmp-url rtmp://host/live/key --input-format ts
 *
 * All options can also be supplied via environment variables or `~/.config/
 * srtla2platform/config.json` (see ConfigFile).
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname as osHostname } from "node:os";
import { join } from "node:path";

import { APP_VERSION } from "../../generated/version";
import { arg, argFail, enumArg, flag } from "../../shared/args";
import { DEFAULT_COLOR } from "../../shared/validate";

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
    inputFormat: "ts" as InputFormat,
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
    srtlaPort?: number;
    srtPort?: number;
    metricsPort?: number;
    bindHost?: string;
    rtmpUrl?: string;
    rtmpUrlFile?: string;
    inputFormat?: InputFormat;
    autoStart?: boolean;
}

interface Config {
    controlServerUrl: string;
    token: string;
    uuid: string;
    srtlaPort: number;
    srtPort: number;
    metricsPort: number;
    bindHost: string;
    rtmpUrl: string;
    inputFormat: InputFormat;
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

let ws: Bun.WebSocket | null = null;
let linkStopped = true;
let backoff = BACKOFF_MIN_MS;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let pingTimer: ReturnType<typeof setInterval> | null = null;
let statusTimer: ReturnType<typeof setInterval> | null = null;

let streamState: StreamState = "idle";
let srtlaProc: Bun.Subprocess | null = null;
let gstProc: Bun.Subprocess | null = null;
let epoch = 0;
let startedAt = 0;

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

function firstDefined<T>(
    ...vals: Array<T | null | undefined>
): T | undefined {
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

function log(
    level: LogLevel,
    message: string,
    section = ROLE,
): void {
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
            rtmp: config.rtmpUrl === "" ? null : config.rtmpUrl,
            inputFormat: config.inputFormat,
            srtlaPort: config.srtlaPort,
            srtPort: config.srtPort,
            metricsPort: config.metricsPort,
            uptimeMs:
                streamState === "running" && startedAt > 0
                    ? Date.now() - startedAt
                    : 0,
        },
        modules: {},
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
            hostname: osHostname(),
            color: DEFAULT_COLOR,
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
            msg = JSON.parse(String((ev as MessageEvent).data)) as ServerMessage;
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
            .then((result) => wsSend({ type: "response", id, ok: true, result }))
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
    _params: Record<string, unknown>,
): Promise<unknown> {
    switch (method) {
        case "start":
            return startStream();
        case "stop":
            return stopStream();
        case "status":
            return currentStatus();
        default:
            log("warn", `ignoring unknown command: ${method}`);
            throw new Error(`Unknown method: ${method}`);
    }
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
    if (which("gst-launch-1.0") === null) missing.push("gst-launch-1.0");
    if (missing.length > 0)
        throw new Error(
            `Missing binaries: ${missing.join(", ")}. Install them and retry.`,
        );

    const probe = Bun.spawnSync(["gst-inspect-1.0", "srtsrc"]);
    if (probe.exitCode !== 0)
        log(
            "warn",
            "gst-inspect-1.0 srtsrc failed — the srtsrc plugin may be missing",
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
                if (line !== "") log(level, `[${label}] ${line.slice(0, 400)}`, label);
                nl = buf.indexOf("\n");
            }
        }
    } catch {
        /* stream closed */
    }
}

function onChildExit(label: string, code: number | null): void {
    const desc = code === null ? "via signal" : `with code ${code}`;
    if (code === 0 || code === null) log("info", `${label} exited ${desc}`);
    else log("warn", `${label} exited ${desc}`);

    // Either child dying while we believe the stream is up is a real
    // failure — tear the whole stream down so state stays honest.
    if (
        (label === "gst" || label === "srtla_rec") &&
        streamState === "running"
    ) {
        log("warn", `${label} is down — stopping stream`);
        stopStream();
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
    for (const p of [srtlaProc, gstProc]) {
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
    gstProc = null;
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
            return;
        }
        healthFails += 1;
        if (healthFails >= HEALTH_CHECK_THRESHOLD) {
            healthFails = 0;
            log(
                "warn",
                `SRTLA port ${config.srtlaPort} not open for ${
                    (HEALTH_CHECK_THRESHOLD * HEALTH_CHECK_INTERVAL_MS) / 1000
                } s — stopping stream`,
            );
            stopStream();
        }
    }, HEALTH_CHECK_INTERVAL_MS);
}

// srtla_rec (b8359bc) is the SRT *caller* — it connect()s to the
// downstream address. GStreamer must therefore listen.
// gst-launch must receive the pipeline as separate argv tokens — a single
// quoted string is parsed as one (invalid) element name. flvmux's ghost pads
// cannot be negotiated from static caps (e.g. mpegts from tsparse), so mpegts
// input goes through tsdemux (h264 input through h264parse); the flvmux ghost
// pad is auto-negotiated from the preceding caps. `rtmpsink live=1` is not
// available in every gst-plugins-bad build, so it is omitted (the mux is
// already streamable).
function buildPipeline(): string[] {
    const srtUri = `srt://${config.bindHost}:${config.srtPort}?mode=listener`;
    const mid =
        config.inputFormat === "h264"
            ? ["h264parse", "!", "flvmux", "streamable=true"]
            : [
                  "tsdemux",
                  "name=d",
                  "d.",
                  "!",
                  "video/x-h264",
                  "!",
                  "flvmux",
                  "streamable=true",
              ];
    return [
        "srtsrc",
        `uri=${srtUri}`,
        "!",
        ...mid,
        "!",
        "rtmpsink",
        `location=${config.rtmpUrl}`,
    ];
}

// SRT runs over UDP, so a TCP connect probe can never detect the
// GStreamer listener. Parse `ss -uln` for a bound socket on the port
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

    epoch += 1;
    const myEpoch = epoch;
    streamState = "starting";
    pushStatus();
    log(
        "info",
        `starting stream: srtla:${config.srtlaPort} → srt:${config.bindHost}:${config.srtPort} → ${config.rtmpUrl}`,
    );

    // GStreamer is the SRT listener (srtla_rec calls into it), so it has to
    // be up first and its UDP port bound before srtla_rec connects out.
    gstProc = spawnProc("gst-launch-1.0", ["-q", ...buildPipeline()], "gst");

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
        throw new Error(
            `GStreamer did not open SRT port ${config.srtPort} in time`,
        );
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
    return { state: "running", rtmp: config.rtmpUrl };
}

function stopStream(): Record<string, unknown> {
    if (streamState === "idle") return { state: "idle" };

    epoch += 1;
    streamState = "stopping";
    log("info", "stopping stream");

    killProcs();
    const dying = [srtlaProc, gstProc];
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

function isRtmpUrl(url: string): boolean {
    try {
        return new URL(url).protocol === "rtmp:";
    } catch {
        return false;
    }
}

function loadConfig(): Config {
    if (flag("--version")) {
        console.log(`srtla2platform ${APP_VERSION}`);
        process.exit(0);
    }

    const file = readConfigFile(arg("--config"));

    const storedUuid = readStoredUuid();
    const uuid =
        firstDefined(
            arg("--uuid"),
            process.env.DEVICE_UUID,
            storedUuid,
        ) ?? randomUUID();
    if (uuid !== storedUuid) storeUuid(uuid);
    if (!ID_RE.test(uuid))
        argFail("--uuid", uuid, 'a device id matching /^\\w[-\\w.]{0,63}$/');

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

    const rtmpUrl =
        firstDefined(
            arg("--rtmp-url"),
            process.env.RTMP_URL,
            rtmpFromUrlFile,
            file?.rtmpUrl,
        ) ?? "";
    if (rtmpUrl !== "" && !isRtmpUrl(rtmpUrl))
        log(
            "warn",
            `RTMP URL is not an rtmp:// URL and will fail at start: ${rtmpUrl}`,
        );

    const inputFormat = enumArg(
        "--input-format",
        ["ts", "h264"] as const,
        firstDefined(file?.inputFormat, DEFAULTS.inputFormat) ??
            DEFAULTS.inputFormat,
    );

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
            firstDefined(
                process.env.CONTROL_SERVER_TOKEN,
                file?.token,
            ) ?? "",
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
        inputFormat,
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
    stopStream();
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

    if (config.dryRun) {
        console.log(
            JSON.stringify(
                {
                    dryRun: true,
                    appVersion: APP_VERSION,
                    config: {
                        ...config,
                        token: config.token === "" ? "" : "***",
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
