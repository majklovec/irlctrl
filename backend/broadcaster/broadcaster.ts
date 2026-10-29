#!/usr/bin/env bun
/**
 * broadcaster — irlctrl device-side agent.
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
 * role `broadcaster` and accepts `start` / `stop` / `status` commands.
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
 * The relay publishes to one or more RTMP destinations (the `outputs` array:
 * service + url + stream key each). The service is a streaming-platform
 * catalog id (Kick, Twitch, YouTube, ... — see modules/broadcaster/services.ts)
 * whose server URL the web UI prefills; the stored url is authoritative and
 * may differ from the catalog server (custom override). Each key is appended
 * to its URL as the final path segment (rtmp://host/live + key →
 * rtmp://host/live/key). Outputs precedence:
 * the config file's `outputs` array (written by the web UI, authoritative
 * across restarts); otherwise a single destination is synthesized from the
 * legacy sources — URL = CLI flag > rtmpUrlFile (dynamic source) > legacy
 * rtmpUrl field > RTMP_URL env; key = legacy rtmpKey field > RTMP_KEY env (the
 * key is never a CLI flag, like the token — first-run bootstrap only).
 *
 * The `profile` config field selects an ffmpeg output profile. Profiles are
 * JSON files in the profiles directory (--profiles / PROFILES_DIR, default
 * ~/.config/broadcaster/profiles; ./config/broadcaster/profiles in the
 * container) holding the extra ffmpeg arguments to append after `-i`.
 * Defaults (copy-only, H.264/H.265 re-encode, audio-only) are shipped in the
 * repo (backend/broadcaster/defaults/profiles/) and seeded into the
 * directory on first run (never overwriting user files); it can be edited or
 * extended by adding more <id>.json files.
 * The selected profile is appended to the fixed input→FLV→output command
 * chain.
 *
 * Usage:
 *   CONTROL_SERVER_TOKEN=<t> RTMP_KEY=<key> bun broadcaster.ts \
 *     --remote ws://host:7788/device \
 *     --rtmp-url rtmp://host/live --input-format ts
 *
 * Every flag (except --server-url, a legacy alias of --remote) can also be
 * supplied via its environment variable, e.g. --remote / CONTROL_SERVER_URL,
 * or via `~/.config/broadcaster/config.json` (see ConfigFile). Resolution
 * order: CLI flag > env var > config file > default.
 */

import { randomUUID } from "node:crypto";
import {
	copyFileSync,
	type Dirent,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir, hostname as osHostname } from "node:os";
import { dirname, join, resolve } from "node:path";

import { APP_VERSION } from "../../generated/version";
import {
	SRTLA_CUSTOM_SERVICE,
	srtlaService,
	srtlaServiceForUrl,
} from "../../modules/broadcaster/services";
import type { SrtlaKeepalive } from "../../modules/broadcaster/types";
import { arg, argEnv, argFail, enumArgEnv, flag, flagOrEnv } from "../../shared/args";
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

const ROLE = "broadcaster";
const ID_RE = /^[\w.-]{1,64}$/;
const CONFIG_DIR = join(homedir(), ".config", "broadcaster");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
// Pre-change installs kept the UUID in this standalone file; one-time
// migration source (merge into config.json, then the file is ignored).
const LEGACY_UUID_FILE = join(CONFIG_DIR, "uuid");

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

/** One RTMP destination the ffmpeg pipeline publishes to. */
interface RtmpOutput {
	/** The catalog service id (e.g. "kick"); the URL is its server prefilled
	 * and can be overridden. Always present after normalization. */
	service: string;
	url: string;
	/** The stream key, appended to the URL as the final path segment. */
	key: string;
}

interface ConfigFile {
	controlServerUrl?: string;
	token?: string;
	hostname?: string;
	color?: string;
	uuid?: string;
	srtlaPort?: number;
	srtPort?: number;
	srtLatencyMs?: number;
	metricsPort?: number;
	bindHost?: string;
	outputs?: RtmpOutput[];
	// Legacy single-destination fields — read for migration only, no longer
	// written. Kept so existing config files keep working.
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
	/** The RTMP destinations to publish to (empty = setup incomplete). */
	outputs: RtmpOutput[];
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

// Latest per-connection SRTLA keepalive stats, parsed from `srtla_rec`'s
// stdout. Keyed by SRTLA connection id so a rebonded link (new id) starts a
// fresh entry; cleared when the stream stops.
const keepalives = new Map<number, SrtlaKeepalive>();
let lastKeepalivePushAt = 0;
const KEEPALIVE_PUSH_INTERVAL_MS = 2_000;

/**
 * One `Per-connection keepalive:` line, e.g.
 * `[2026-10-29 13:16:16.335] [info] [192.168.32.1:60401] [Group: 0x…]
 *  Per-connection keepalive: ID=4146118334, BW: 5946.18 kbits/s, Window=60000,
 *  In-flight=7, RTT=11ms, NAKs=0`
 *
 * Anchored on the `Per-connection keepalive:` marker (the leading timestamp,
 * level and peer are irrelevant) so the parser is robust to srtla_rec's
 * surrounding log decoration. All six fields are required — a line that only
 * partially matches is ignored rather than half-parsed.
 */
const KEEPALIVE_RE =
	/Per-connection keepalive:\s*ID=(\d+),\s*BW:\s*([\d.]+)\s*kbits\/s,\s*Window=(\d+),\s*In-flight=(\d+),\s*RTT=(\d+)\s*ms,\s*NAKs=(\d+)/;

/** Parse one srtla_rec stdout line; stores the connection's latest keepalive
 * and schedules a throttled status push so the web UI stays current.
 * Returns true when the line was a keepalive (so pumpOutput skips re-logging
 * it) — the values are already surfaced to the web UI as stats. */
function parseKeepalive(line: string): boolean {
	const m = KEEPALIVE_RE.exec(line);
	if (!m) return false;
	const id = Number(m[1]);
	keepalives.set(id, {
		id,
		bwKbits: Number(m[2]),
		window: Number(m[3]),
		inFlight: Number(m[4]),
		rttMs: Number(m[5]),
		naks: Number(m[6]),
		at: Date.now(),
	});
	// Keepalives arrive every 1–2 s per link; push at most once per interval so
	// the status stream stays chatty, not per-line.
	const now = Date.now();
	if (now - lastKeepalivePushAt >= KEEPALIVE_PUSH_INTERVAL_MS) {
		lastKeepalivePushAt = now;
		pushStatus();
	}
	return true;
}

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
		setupRequired: config.outputs.length === 0,
		state: {
			autostart: config.autoStart,
			stream: streamState,
			// Latest per-connection SRTLA keepalive stats (see parseKeepalive);
			// empty while the stream is down.
			keepalives: [...keepalives.values()].sort((a, b) => a.id - b.id),
			// The key is never part of the advertised URL — each destination is
			// reported separately with only a key-present flag.
			outputs: config.outputs.map((out) => ({
				service: out.service,
				url: out.url,
				keyConfigured: out.key !== "",
			})),
			inputFormat: config.inputFormat,
			profile: config.profile,
			profiles: listProfiles(),
			profilesDir: config.profilesDir,
			srtlaPort: config.srtlaPort,
			srtPort: config.srtPort,
			srtLatencyMs: config.srtLatencyMs,
			metricsPort: config.metricsPort,
			uptimeMs:
				streamState === "running" && startedAt > 0 ? Date.now() - startedAt : 0,
			restarts: streamRestarts,
		},
		// The web-UI refreshes its module cards from this push; an empty
		// object would wipe every card's form values.
		modules: moduleSliceView(),
		// Device-list slice the control server reads (devices.ts spreads it into
		// each DeviceSummary): the stream lifecycle so the "Stream" column can
		// show live / starting / stopped. Kept to just the state so the
		// throttled list fingerprint only re-broadcasts on a real transition,
		// not on every periodic status push.
		summary: { stream: streamState },
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
	const delay = Math.min(backoff, BACKOFF_MAX_MS) * (0.5 + Math.random() * 0.5);
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
		case "autostart.set":
			return setAutostart(params);
		default:
			log("warn", `ignoring unknown command: ${method}`);
			throw new Error(`Unknown method: ${method}`);
	}
}

/** Shared settings page save: name / color / remote url + token. The role is
 * locked (this box is always `broadcaster`). A remote change re-dials the
 * socket so the fresh hello carries the new name / color / URL / token. */
function settingsUpdate(params: Record<string, unknown>): unknown {
	if (params.uuid !== undefined && params.uuid !== config.uuid)
		throw new Error("The device uuid can't be changed");
	if (params.role !== undefined && params.role !== ROLE)
		throw new Error("The role of this device is always broadcaster");

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
		throw new Error(`Remote URL must start with ws:// or wss://: ${remoteUrl}`);

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

	if (Array.isArray(cfg.outputs)) {
		const outputs: RtmpOutput[] = cfg.outputs
			.filter(isRecord)
			.map((o) => ({
				service: typeof o.service === "string" ? o.service.trim() : "",
				url: urlOfConfigureOutput(
					typeof o.service === "string" ? o.service.trim() : "",
					typeof o.url === "string" ? o.url.trim() : "",
				),
				key: typeof o.key === "string" ? o.key.trim() : "",
			}))
			.filter((o) => o.url !== "");
		// A selection that is not in the catalog (or custom) is a client bug
		// (the UI only offers those ids) — reject it like an unknown profile.
		for (const out of outputs)
			if (
				out.service !== SRTLA_CUSTOM_SERVICE &&
				srtlaService(out.service) === undefined
			)
				throw new Error(`Unknown service: ${out.service}`);
		for (const out of outputs)
			if (!isRtmpUrl(out.url))
				throw new Error(`RTMP URL must be an rtmp(s):// URL: ${out.url}`);
		// Apply to the live config — writeConfigFile() persists THAT, not
		// this temp object.
		applyConfig({ outputs });
	}
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

/** Toggle the boot autostart flag (`autoStart` in the config file). A
 * pending `startStream()` on the next service start resumes the saved
 * outputs; `state.autostart` in the status mirrors the flag. */
function setAutostart(params: Record<string, unknown>): unknown {
	if (typeof params.enabled !== "boolean")
		throw new Error("enabled must be a boolean");
	config.autoStart = params.enabled;
	writeConfigFile();
	pushStatus();
	return { autostart: config.autoStart };
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

// onLine returns true when it fully consumes a line (e.g. a parsed keepalive);
// such lines are surfaced to the web UI as stats, so they are not re-logged.
type OnLine = (line: string) => boolean | void;

async function pumpOutput(
	stream: ReadableStream<Uint8Array>,
	label: string,
	level: LogLevel = "info",
	onLine?: OnLine,
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
				if (line !== "") {
					if (onLine?.(line) !== true)
						log(level, `[${label}] ${line.slice(0, 400)}`, label);
				}
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
	onStdoutLine?: OnLine,
): Bun.Subprocess {
	// The child's arguments may carry a stream key in each RTMP URL; logs
	// reach the web UI, so mask every configured key.
	let cmdline = args.join(" ");
	for (const out of config.outputs)
		if (out.key !== "") cmdline = cmdline.split(out.key).join("***");
	log("info", `spawning ${label}: ${name} ${cmdline}`);
	const proc = Bun.spawn([name, ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	void pumpOutput(
		proc.stdout as ReadableStream<Uint8Array>,
		label,
		"info",
		onStdoutLine,
	);
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
	// The stats belong to the run we just tore down; a stale keepalive from the
	// previous stream would read as "live" on the next start.
	keepalives.clear();
	lastKeepalivePushAt = 0;
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
// directory from backend/broadcaster/defaults/profiles/ on startup
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
 * repo (backend/broadcaster/defaults/profiles/). Non-destructive: an
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
		({
			id: "copy",
			name: "Copy",
			desc: "",
			args: COPY_ARGS,
		} satisfies FfmpegProfile);

	// Fan the single SRT input out to every configured destination. ffmpeg
	// applies the profile args (after -i) to all outputs; each output adds its
	// own `-f flv <url>`. A single output is byte-identical to the old form.
	return [
		"-hide_banner",
		"-loglevel",
		"warning",
		"-i",
		srtUri,
		...selected.args,
		...config.outputs.flatMap((out) => ["-f", "flv", effectiveRtmpUrl(out)]),
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

	if (config.outputs.length === 0)
		throw new Error(
			"No RTMP outputs configured (add at least one destination)",
		);

	preflight();

	wantsRunning = true;
	epoch += 1;
	const myEpoch = epoch;
	streamState = "starting";
	pushStatus();
	log(
		"info",
		`starting stream: srtla:${config.srtlaPort} → srt:${config.bindHost}:${config.srtPort} → ${config.outputs
			.map((out) => maskedRtmpUrl(out))
			.join(", ")}`,
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
	srtlaProc = spawnProc("srtla_rec", srtlaArgs, "srtla_rec", parseKeepalive);

	startedAt = Date.now();
	streamState = "running";
	pushStatus();
	log("info", "stream is running");
	return {
		state: "running",
		outputs: config.outputs.map((out) => maskedRtmpUrl(out)),
	};
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

/** Legacy installs stored the UUID in a standalone file; migrate it into
 * the config file once so the device identity survives the upgrade. */
function migrateLegacyUuid(
	configPath: string | undefined,
	file: ConfigFile | undefined,
): string | undefined {
	let legacy: string | undefined;
	try {
		const v = readFileSync(LEGACY_UUID_FILE, "utf8").trim();
		if (ID_RE.test(v)) legacy = v;
	} catch {
		return undefined;
	}
	if (legacy !== undefined && file?.uuid !== legacy) {
		const p = configPath ?? CONFIG_FILE;
		try {
			mkdirSync(dirname(p), { recursive: true });
			writeFileSync(
				p,
				`${JSON.stringify({ ...file, uuid: legacy }, null, 4)}\n`,
			);
			// Identity now lives in the config file — drop the stale file.
			try {
				unlinkSync(LEGACY_UUID_FILE);
			} catch {
				/* best effort */
			}
		} catch (err) {
			log("warn", `could not migrate DEVICE_UUID: ${errMsg(err)}`);
		}
	}
	return legacy;
}

/** Persist a freshly assigned UUID into the config file — writeConfigFile()
 * only runs on settings changes, so a first run with no UI edits would never
 * land the new UUID in the file. */
function storeUuid(configPath: string | undefined, uuid: string): void {
	const p = configPath ?? CONFIG_FILE;
	try {
		mkdirSync(dirname(p), { recursive: true });
		const existing = readConfigFile(p) ?? {};
		writeFileSync(p, `${JSON.stringify({ ...existing, uuid }, null, 4)}\n`);
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
			uuid: config.uuid,
			srtlaPort: config.srtlaPort,
			srtPort: config.srtPort,
			srtLatencyMs: config.srtLatencyMs,
			metricsPort: config.metricsPort > 0 ? config.metricsPort : undefined,
			bindHost: config.bindHost,
			outputs: config.outputs,
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
		broadcaster: {
			enabled: true,
			outputs: config.outputs.map((out) => ({
				service: out.service,
				url: out.url,
				keyConfigured: out.key !== "",
			})),
			profile: config.profile,
			profiles: listProfiles(),
			profilesDir: config.profilesDir,
		},
	};
}

function isRtmpUrl(url: string): boolean {
	try {
		return (
			new URL(url).protocol === "rtmp:" || new URL(url).protocol === "rtmps:"
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

// The destination URL configure accepts: the explicit URL, or — when the
// client sends none — the catalog service's server, so a freshly picked
// service works without the UI duplicating its server address.
function urlOfConfigureOutput(service: string, url: string): string {
	return url !== "" ? url : (srtlaService(service)?.servers[0]?.url ?? "");
}

// The destination URL for a config file entry: the explicit URL, or — when
// the entry declares a catalog service and no URL — that service's server,
// mirroring modulesConfigure.
function urlOfConfigOutput(service: string, url: string): string {
	return url !== "" ? url : (srtlaService(service)?.servers[0]?.url ?? "");
}

// The catalog service for a destination: a known id as declared, else
// custom.
function normalizeService(service: string, url: string): string {
	if (
		service !== "" &&
		service !== SRTLA_CUSTOM_SERVICE &&
		srtlaService(service) !== undefined
	)
		return service;
	return srtlaServiceForUrl(url) ?? SRTLA_CUSTOM_SERVICE;
}

// The RTMP location the pipeline publishes to for one destination: the URL
// with its key appended as the final path segment (empty key → unchanged).
function effectiveRtmpUrl(out: RtmpOutput): string {
	return resolveRtmpUrl(out.url, out.key);
}

// The same location with the key masked — for logs and action results, which
// reach the web UI.
function maskedRtmpUrl(out: RtmpOutput): string {
	return resolveRtmpUrl(out.url, out.key === "" ? "" : "***");
}

function loadConfig(): Config {
	if (flag("--version")) {
		console.log(`broadcaster ${APP_VERSION}`);
		process.exit(0);
	}

	const configPath = argEnv("--config", "CONFIG_FILE");
	const file = readConfigFile(configPath);

	// UUID precedence: CLI flag > DEVICE_UUID env var > config file (with a
	// one-time migration from the legacy standalone uuid file); a new UUID is
	// generated and persisted on first run.
	const storedUuid = file?.uuid ?? migrateLegacyUuid(configPath, file);
	const uuid =
		firstDefined(argEnv("--uuid", "DEVICE_UUID"), storedUuid) ?? randomUUID();
	if (!ID_RE.test(uuid))
		argFail("--uuid", uuid, "a device id matching /^\\w[-\\w.]{0,63}$/");
	if (uuid !== storedUuid) storeUuid(configPath, uuid);

	const rtmpUrlFile = firstDefined(
		argEnv("--rtmp-url-file", "RTMP_URL_FILE"),
		file?.rtmpUrlFile,
	);
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

	// Outputs precedence: a config file carrying an `outputs` array (written
	// by the web UI) is authoritative. Otherwise a single destination is
	// synthesized from the legacy sources — CLI --rtmp-url > rtmpUrlFile
	// (dynamic/auto-rotating) > legacy rtmpUrl field > RTMP_URL env, with the
	// key from the legacy rtmpKey field, then the RTMP_KEY env (a first-run
	// bootstrap). The key is never a CLI flag (it is a secret, like the token)
	// and is appended to each URL as the final path segment.
	const fileOutputs = Array.isArray(file?.outputs)
		? file.outputs
				.filter(isRecord)
				.map((o) => {
					const service = typeof o.service === "string" ? o.service.trim() : "";
					const key = typeof o.key === "string" ? o.key.trim() : "";
					// The UI only saves service + server together, but a
					// hand-edited file may keep one without the other —
					// fill the catalog server like modulesConfigure does.
					const url = urlOfConfigOutput(
						service,
						typeof o.url === "string" ? o.url.trim() : "",
					);
					// Configs written before the service select carry no id —
					// infer it from the URL (a Kick URL stays "kick").
					return {
						service: normalizeService(service, url),
						url,
						key,
					};
				})
				.filter((o) => o.url !== "")
		: [];

	const outputs: RtmpOutput[] =
		fileOutputs.length > 0
			? fileOutputs
			: (() => {
					const legacyUrl =
						firstDefined(
							arg("--rtmp-url"),
							rtmpFromUrlFile,
							file?.rtmpUrl,
							process.env.RTMP_URL,
						) ?? "";
					const legacyKey =
						firstDefined(file?.rtmpKey, process.env.RTMP_KEY) ?? "";
					return legacyUrl === ""
						? []
						: [
								{
									service: normalizeService("", legacyUrl),
									url: legacyUrl,
									key: legacyKey,
								},
							];
				})();
	for (const out of outputs)
		if (!isRtmpUrl(out.url))
			log(
				"warn",
				`RTMP URL is not an rtmp(s):// URL and will fail at start: ${out.url}`,
			);

	const inputFormat = enumArgEnv(
		"--input-format",
		["ts", "h264"] as const,
		"INPUT_FORMAT",
		(file?.inputFormat ?? DEFAULTS.inputFormat) as "ts" | "h264",
	);

	// ffmpeg output profiles: the user-authored JSON profile files live in
	// the profiles directory; the selected profile id comes from the config
	// file (written by the web UI), not a CLI flag.
	const profilesDir = argEnv(
		"--profiles",
		"PROFILES_DIR",
		file?.profilesDir ?? DEFAULTS.profilesDir,
	);
	const profile = firstDefined(file?.profile, DEFAULTS.profile) as string;

	const cfg: Config = {
		// --remote is the canonical flag (like in the other roles);
		// --server-url stays as a legacy alias.
		controlServerUrl: firstDefined(
			arg("--remote"),
			arg("--server-url"),
			process.env.CONTROL_SERVER_URL,
			file?.controlServerUrl,
			DEFAULTS.controlServerUrl,
		) as string,
		// Token is never a CLI flag — it would leak into the process list.
		// Source: CONTROL_SERVER_TOKEN env var, then config file.
		token: firstDefined(process.env.CONTROL_SERVER_TOKEN, file?.token) ?? "",
		hostname: file?.hostname ?? osHostname(),
		color: file?.color ?? DEFAULT_COLOR,
		uuid,
		srtlaPort: toPort(
			firstDefined<string | number>(
				arg("--srtla-port"),
				process.env.SRTLA_PORT,
				file?.srtlaPort,
				DEFAULTS.srtlaPort,
			),
			DEFAULTS.srtlaPort,
			"--srtla-port",
		),
		srtPort: toPort(
			firstDefined<string | number>(
				arg("--srt-port"),
				process.env.SRT_PORT,
				file?.srtPort,
				DEFAULTS.srtPort,
			),
			DEFAULTS.srtPort,
			"--srt-port",
		),
		srtLatencyMs: toLatency(
			firstDefined<string | number>(
				arg("--srt-latency-ms"),
				process.env.SRT_LATENCY_MS,
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
		outputs,
		inputFormat,
		profilesDir,
		profile,
		autoStart: flagOrEnv("--autostart", "AUTOSTART") || file?.autoStart === true,
		dryRun: flagOrEnv("--dry-run", "DRY_RUN"),
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
						outputs: config.outputs.map((out) => ({
							service: out.service,
							url: out.url,
							key: out.key === "" ? "" : "***",
						})),
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
		`broadcaster ${APP_VERSION} starting (uuid=${config.uuid}…, role=${ROLE})`,
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
