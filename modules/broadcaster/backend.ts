/*
 * SRTLA → RTMP module: receives bonded SRTLA, exposes an SRT listener for
 * ffmpeg, and publishes to the configured RTMP destinations.
 */
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import audioOnlyProfile from "./defaults/profiles/audio-only.json";
import copyProfile from "./defaults/profiles/copy.json";
import reencodeH264Profile from "./defaults/profiles/reencode-h264.json";
import reencodeH265Profile from "./defaults/profiles/reencode-h265.json";
import type { ModuleCore } from "../../backend/client/module-core";
import type {
	BackendModule,
	ModuleStartContext,
	Params,
} from "../../shared/module-contract";
import { ApiError } from "../../shared/params";
import { errorMessage } from "../../shared/util";
import type { SrtlaKeepalive } from "./types";
import {
	configuredOutputs,
	effectiveOutputUrl,
	isRecord,
	outputMetadata,
	type OutputSecret,
} from "./persistence";
import {
	srtlaService,
	srtlaServiceForUrl,
	SRTLA_CUSTOM_SERVICE,
} from "./services";
import logWording from "./log";

type StreamState = "idle" | "starting" | "running" | "stopping";
type LogLevel = "info" | "warn" | "error";

interface Profile {
	id: string;
	name: string;
	desc: string;
	args: string[];
}

interface RuntimeConfig {
	srtlaPort: number;
	srtPort: number;
	srtLatencyMs: number;
	metricsPort: number;
	bindHost: string;
	inputFormat: "ts" | "h264";
	profile: string;
	profilesDir: string;
	outputs: OutputSecret[];
}

interface BroadcasterData extends Record<string, unknown> {
	outputsConfigured?: boolean;
	outputKeys?: string[];
}

const ID = "broadcaster";
const DEFAULT_PROFILES_DIR = join(homedir(), ".config", ID, "profiles");
const DEFAULTS = {
	srtlaPort: 5000,
	srtPort: 5002,
	srtLatencyMs: 2000,
	bindHost: "127.0.0.1",
	inputFormat: "ts" as const,
	profile: "copy",
	profilesDir: DEFAULT_PROFILES_DIR,
};
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
const PORT_READY_TIMEOUT_MS = 5_000;
const STOP_GRACE_MS = 3_000;
const HEALTH_CHECK_INTERVAL_MS = 5_000;
const HEALTH_CHECK_THRESHOLD = 3;
const STREAM_RESTART_STABLE_MS = 60_000;
const KEEPALIVE_PUSH_INTERVAL_MS = 2_000;
const PROFILE_ID_RE = /^[\w.-]{1,64}$/;
const COPY_ARGS = ["-c", "copy"];
const KEEPALIVE_RE =
	/Per-connection keepalive:\s*ID=(\d+),\s*BW:\s*([\d.]+)\s*kbits\/s,\s*Window=(\d+),\s*In-flight=(\d+),\s*RTT=(\d+)\s*ms,\s*NAKs=(\d+)/;

let core: ModuleCore;
let emit: ModuleStartContext<ModuleCore>["emit"] | undefined;
let contextLog: ModuleStartContext<ModuleCore>["log"] | undefined;
let runtime: RuntimeConfig | undefined;
let streamState: StreamState = "idle";
let srtlaProc: Bun.Subprocess | null = null;
let ffmpegProc: Bun.Subprocess | null = null;
let epoch = 0;
let startedAt = 0;
let wantsRunning = false;
let resumeAfterConfigure = false;
let streamRestarts = 0;
let streamBackoff = BACKOFF_MIN_MS;
let restartTimer: ReturnType<typeof setTimeout> | null = null;
let restartGeneration = 0;
let healthTimer: ReturnType<typeof setInterval> | null = null;
let healthFails = 0;
let dryRunRunning = false;
let lastKeepalivePushAt = 0;
const keepalives = new Map<number, SrtlaKeepalive>();

const sleep = (ms: number) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

function log(level: LogLevel, message: string, section = "broadcaster"): void {
	let safeMessage = message;
	for (const output of runtime?.outputs ?? [])
		if (output.key !== "")
			safeMessage = safeMessage.split(output.key).join("***");
	if (level === "info" && contextLog) contextLog(section, safeMessage);
	else core.logEvent(level, section, safeMessage);
}

function notifyStatus(): void {
	core.notifyStateChange();
	const summary = { stream: streamState };
	emit?.(
		"broadcaster.status",
		{ state: statusFields(), summary },
		{ retain: true, summary },
	);
}

function data(): BroadcasterData {
	const stored = core.state.data.broadcaster;
	return isRecord(stored) ? (stored as BroadcasterData) : {};
}

function storeData(patch: Record<string, unknown>): BroadcasterData {
	const next = { ...data(), ...patch };
	core.state.data.broadcaster = next;
	return next;
}

function moduleSlice(): Record<string, unknown> {
	return core.state.settings.modules?.broadcaster ?? {
		enabled: true,
		outputs: [],
		profile: DEFAULTS.profile,
		profilesDir: DEFAULTS.profilesDir,
		profiles: [],
	};
}

function updateModuleSlice(patch: Record<string, unknown>): void {
	const modules = core.state.settings.modules ?? {};
	const existing = modules.broadcaster;
	modules.broadcaster = existing
		? { ...existing, ...patch }
		: {
				enabled: true,
				outputs: [],
				profile: DEFAULTS.profile,
				profilesDir: DEFAULTS.profilesDir,
				profiles: [],
				...patch,
			};
	core.state.settings.modules = modules;
}

function argValue(name: string): string | undefined {
	const prefix = `${name}=`;
	const argv = core.config.argv;
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === name) return argv[index + 1];
		if (arg.startsWith(prefix)) return arg.slice(prefix.length);
	}
	return undefined;
}

function firstDefined<T>(...values: Array<T | undefined | null>): T | undefined {
	return values.find((value) => value !== undefined && value !== null);
}

function toPort(value: unknown, fallback: number, name: string): number {
	if (value === undefined || value === null || value === "") return fallback;
	const port = Number(value);
	if (!Number.isInteger(port) || port < 1 || port > 65535)
		throw new Error(`${name} must be a TCP port (1-65535)`);
	return port;
}

function toOptionalPort(value: unknown, name: string): number {
	if (value === undefined || value === null || value === "") return 0;
	const port = Number(value);
	if (!Number.isInteger(port) || port < 0 || port > 65535)
		throw new Error(`${name} must be a TCP port (0-65535, 0 = disabled)`);
	return port;
}

function toLatency(value: unknown): number {
	if (value === undefined || value === null || value === "") return DEFAULTS.srtLatencyMs;
	const latency = Number(value);
	if (!Number.isFinite(latency)) return DEFAULTS.srtLatencyMs;
	return Math.min(30_000, Math.max(50, Math.trunc(latency)));
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function readFallbackUrlFile(path: string | undefined): string | undefined {
	if (!path) return undefined;
	try {
		return readFileSync(path, "utf8").trim();
	} catch (error: unknown) {
		throw new Error(`--rtmp-url-file ${path} must be readable (${errorMessage(error)})`);
	}
}

function configuredOutputSecrets(): OutputSecret[] {
	const stored = data();
	const rows = Array.isArray(moduleSlice().outputs)
		? (moduleSlice().outputs as unknown[]).filter(isRecord)
		: [];
	const keys = Array.isArray(stored.outputKeys)
		? stored.outputKeys.map((key) => (typeof key === "string" ? key : ""))
		: [];
	return rows.map((row, index) => ({
		service: typeof row.service === "string" ? row.service : SRTLA_CUSTOM_SERVICE,
		url: typeof row.url === "string" ? row.url : "",
		key: keys[index] ?? "",
	}));
}

function resolveOutputs(): OutputSecret[] {
	const stored = data();
	if (stored.outputsConfigured === true) return configuredOutputSecrets();

	const urlFile = firstDefined(
		argValue("--rtmp-url-file"),
		process.env.RTMP_URL_FILE,
	);
	const dynamicUrl = readFallbackUrlFile(urlFile);
	const url = argValue("--rtmp-url") ?? dynamicUrl ?? process.env.RTMP_URL ?? "";
	if (url === "") return [];

	const keys = Array.isArray(stored.outputKeys) ? stored.outputKeys : [];
	const key = firstDefined(
		typeof keys[0] === "string" ? keys[0] : undefined,
		process.env.RTMP_KEY,
	) ?? "";
	return [
		{
			service: srtlaServiceForUrl(url),
			url,
			key,
		},
	];
}

function readConfig(): RuntimeConfig {
	const slice = moduleSlice();
	const profileDir =
		firstDefined(
			argValue("--profiles"),
			process.env.PROFILES_DIR,
			asString(slice.profilesDir),
			DEFAULTS.profilesDir,
		) ?? DEFAULTS.profilesDir;
	const rawInputFormat = firstDefined(
		argValue("--input-format"),
		process.env.INPUT_FORMAT,
		DEFAULTS.inputFormat,
	) as string;
	if (rawInputFormat !== "ts" && rawInputFormat !== "h264")
		throw new Error(`--input-format must be ts or h264 (got ${rawInputFormat})`);

	return {
		srtlaPort: toPort(
			firstDefined(argValue("--srtla-port"), process.env.SRTLA_PORT),
			DEFAULTS.srtlaPort,
			"--srtla-port",
		),
		srtPort: toPort(
			firstDefined(argValue("--srt-port"), process.env.SRT_PORT),
			DEFAULTS.srtPort,
			"--srt-port",
		),
		srtLatencyMs: toLatency(
			firstDefined(
				argValue("--srt-latency-ms"),
				process.env.SRT_LATENCY_MS,
			),
		),
		metricsPort: toOptionalPort(
			firstDefined(
				argValue("--metrics-port"),
				process.env.SRTLA_METRICS_PORT,
			),
			"--metrics-port",
		),
		bindHost:
			firstDefined(
				argValue("--bind-host"),
				process.env.SRT_BIND_HOST,
				DEFAULTS.bindHost,
			) ?? DEFAULTS.bindHost,
		inputFormat: rawInputFormat,
		profile:
			(typeof slice.profile === "string" ? slice.profile : undefined) ??
			DEFAULTS.profile,
		profilesDir: profileDir,
		outputs: resolveOutputs(),
	};
}

interface ProfileFile {
	name?: unknown;
	desc?: unknown;
	args?: unknown;
}

const DEFAULT_PROFILES: Record<string, ProfileFile> = {
	"audio-only.json": audioOnlyProfile,
	"copy.json": copyProfile,
	"reencode-h264.json": reencodeH264Profile,
	"reencode-h265.json": reencodeH265Profile,
};

function listProfiles(): Profile[] {
	const configuredDirectory = moduleSlice().profilesDir;
	const directory = resolve(
		runtime?.profilesDir ??
			(typeof configuredDirectory === "string"
				? configuredDirectory
				: DEFAULTS.profilesDir),
	);
	let entries: string[];
	try {
		entries = readdirSync(directory);
	} catch {
		return [];
	}
	const profiles: Profile[] = [];
	for (const filename of entries) {
		if (
			filename.startsWith(".") ||
			!filename.endsWith(".json") ||
			!PROFILE_ID_RE.test(filename.slice(0, -5))
		)
			continue;
		try {
			const raw: unknown = JSON.parse(
				readFileSync(join(directory, filename), "utf8"),
			);
			if (!isRecord(raw)) {
				log("warn", `profile file ${filename} must be an object — skipped`);
				continue;
			}
			const profile = raw as ProfileFile;
			const args = Array.isArray(profile.args)
				? profile.args.filter((item): item is string => typeof item === "string")
				: [];
			profiles.push({
				id: filename.slice(0, -5),
				name:
					typeof profile.name === "string"
						? profile.name
						: filename.slice(0, -5),
				desc: typeof profile.desc === "string" ? profile.desc : "",
				args: args.length > 0 ? args : COPY_ARGS,
			});
		} catch (error: unknown) {
			log("warn", `profile file ${filename} is invalid JSON — skipped`);
		}
	}
	return profiles.sort((a, b) => a.id.localeCompare(b.id));
}

function findProfile(id: string): Profile | undefined {
	return listProfiles().find((profile) => profile.id === id);
}

function seedDefaultProfiles(): void {
	const destination = resolve(runtime?.profilesDir ?? DEFAULTS.profilesDir);
	mkdirSync(destination, { recursive: true });
	for (const [filename, profile] of Object.entries(DEFAULT_PROFILES)) {
		const target = join(destination, filename);
		if (!existsSync(target))
			writeFileSync(target, `${JSON.stringify(profile, null, 2)}\n`);
	}
}

function syncPublicSlice(): void {
	if (!runtime) return;
	const profiles = listProfiles().map(({ id, name }) => ({ id, name }));
	const current = moduleSlice();
	const patch = {
		outputs: outputMetadata(runtime.outputs),
		profile: runtime.profile,
		profiles,
		profilesDir: runtime.profilesDir,
	};
	if (
		JSON.stringify(current.outputs) !== JSON.stringify(patch.outputs) ||
		current.profile !== patch.profile ||
		JSON.stringify(current.profiles) !== JSON.stringify(patch.profiles) ||
		current.profilesDir !== patch.profilesDir
	)
		updateModuleSlice(patch);
}

function statusFields(): Record<string, unknown> {
	const current = runtime;
	const rows = current?.outputs ?? configuredOutputSecrets();
	const profile = current?.profile ??
		(typeof moduleSlice().profile === "string"
			? (moduleSlice().profile as string)
			: DEFAULTS.profile);
	const profilesDir =
		current?.profilesDir ??
		(typeof moduleSlice().profilesDir === "string"
			? (moduleSlice().profilesDir as string)
			: DEFAULTS.profilesDir);
	return {
		stream: streamState,
		keepalives: [...keepalives.values()].sort((a, b) => a.id - b.id),
		outputs: outputMetadata(rows),
		inputFormat: current?.inputFormat ?? asString(data().inputFormat) ?? "ts",
		profile,
		profiles: listProfiles().map(({ id, name }) => ({ id, name })),
		profilesDir,
		srtlaPort: current?.srtlaPort ?? Number(data().srtlaPort ?? DEFAULTS.srtlaPort),
		srtPort: current?.srtPort ?? Number(data().srtPort ?? DEFAULTS.srtPort),
		srtLatencyMs:
			current?.srtLatencyMs ??
			Number(data().srtLatencyMs ?? DEFAULTS.srtLatencyMs),
		metricsPort: current?.metricsPort ?? Number(data().metricsPort ?? 0),
		uptimeMs:
			streamState === "running" && startedAt > 0
				? Date.now() - startedAt
				: 0,
		restarts: streamRestarts,
	};
}

function parseKeepalive(line: string): boolean {
	const match = KEEPALIVE_RE.exec(line);
	if (!match) return false;
	const id = Number(match[1]);
	keepalives.set(id, {
		id,
		bwKbits: Number(match[2]),
		window: Number(match[3]),
		inFlight: Number(match[4]),
		rttMs: Number(match[5]),
		naks: Number(match[6]),
		at: Date.now(),
	});
	const now = Date.now();
	if (now - lastKeepalivePushAt >= KEEPALIVE_PUSH_INTERVAL_MS) {
		lastKeepalivePushAt = now;
		core.notifyStateChange();
		emit?.(
			"broadcaster.keepalives",
			{ keepalives: [...keepalives.values()].sort((a, b) => a.id - b.id) },
			{ throttle: true, retain: true, summary: { stream: streamState } },
		);
	}
	return true;
}

type OnLine = (line: string) => boolean | void;

async function pumpOutput(
	stream: ReadableStream<Uint8Array>,
	label: string,
	level: LogLevel,
	onLine?: OnLine,
): Promise<void> {
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		for await (const chunk of stream) {
			buffer += decoder.decode(chunk, { stream: true });
			let newline = buffer.indexOf("\n");
			while (newline >= 0) {
				const line = buffer.slice(0, newline).replace(/\r$/, "").trim();
				buffer = buffer.slice(newline + 1);
				if (line && onLine?.(line) !== true)
					log(level, `[${label}] ${line.slice(0, 400)}`, label);
				newline = buffer.indexOf("\n");
			}
		}
	} catch {
		// The stream closes when the child exits.
	}
}

function maskCommand(args: readonly string[]): string {
	let command = args.join(" ");
	for (const output of runtime?.outputs ?? [])
		if (output.key !== "")
			command = command.split(output.key).join("***");
	return command;
}

function onChildExit(label: string, code: number | null, childEpoch: number): void {
	if (childEpoch !== epoch) return;
	const desc = code === null ? "via signal" : `with code ${code}`;
	const expected = code === 0 || code === null || streamState !== "running";
	log(expected ? "info" : "warn", `${label} exited ${desc}`, label);
	if (
		(label === "ffmpeg" || label === "srtla_rec") &&
		streamState === "running"
	) {
		if (wantsRunning) scheduleStreamRestart(`${label} is down`);
		else {
			log("warn", `${label} is down — stopping stream`);
			void stopStream();
		}
	}
}

function spawnProc(
	binary: string,
	args: string[],
	label: string,
	childEpoch: number,
	onStdoutLine?: OnLine,
): Bun.Subprocess {
	log("info", `spawning ${label}: ${binary} ${maskCommand(args)}`);
	const proc = Bun.spawn([binary, ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	void pumpOutput(proc.stdout as ReadableStream<Uint8Array>, label, "info", onStdoutLine);
	void pumpOutput(proc.stderr as ReadableStream<Uint8Array>, label, "warn");
	proc.exited
		.then((code) => onChildExit(label, code, childEpoch))
		.catch(() => onChildExit(label, null, childEpoch));
	return proc;
}

function which(binary: string): string | null {
	try {
		const result = Bun.spawnSync(["which", binary]);
		if (result.exitCode === 0) {
			const path = result.stdout.toString().trim();
			return path || null;
		}
	} catch {
		// Report missing optional executables together below.
	}
	return null;
}

function preflight(): void {
	if (core.config.DRY_RUN) return;
	const missing = ["srtla_rec", "ffmpeg"].filter((binary) => which(binary) === null);
	if (missing.length > 0)
		throw new Error(`Missing binaries: ${missing.join(", ")}. Install them and retry.`);
}

function buildPipeline(config: RuntimeConfig): string[] {
	const selected = findProfile(config.profile) ?? {
		id: "copy",
		name: "Copy",
		desc: "",
		args: COPY_ARGS,
	};
	const srtUri =
		`srt://${config.bindHost}:${config.srtPort}` +
		`?mode=listener&latency=${config.srtLatencyMs}`;
	return [
		"-hide_banner",
		"-loglevel",
		"warning",
		"-i",
		srtUri,
		...selected.args,
		...config.outputs.flatMap((output) => [
			"-f",
			"flv",
			effectiveOutputUrl(output.url, output.key),
		]),
	];
}

function isUdpPortOpen(port: number): boolean {
	try {
		const result = Bun.spawnSync(["ss", "-uln"]);
		if (result.exitCode !== 0) return false;
		const matcher = new RegExp(`(^|[\\s:])${port}(?=[\\s])`, "m");
		return matcher.test(result.stdout.toString());
	} catch {
		return false;
	}
}

async function waitForUdpPort(
	port: number,
	timeoutMs: number,
	runEpoch: number,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (runEpoch !== epoch) return false;
		if (isUdpPortOpen(port)) return true;
		await sleep(150);
	}
	return false;
}

function resetStreamHandles(): void {
	srtlaProc = null;
	ffmpegProc = null;
	keepalives.clear();
	lastKeepalivePushAt = 0;
}

async function stopStream(): Promise<Record<string, unknown>> {
	if (streamState === "idle" && !srtlaProc && !ffmpegProc && !dryRunRunning)
		return { state: "idle" };
	epoch += 1;
	streamState = "stopping";
	log("info", "stopping stream");
	const dying = [srtlaProc, ffmpegProc].filter(
		(proc): proc is Bun.Subprocess => proc !== null,
	);
	for (const proc of dying) {
		try {
			proc.kill("SIGTERM");
		} catch {
			// Already exited.
		}
	}
	if (dying.length > 0)
		await Promise.race([
			Promise.all(dying.map((proc) => proc.exited.catch(() => -1))),
			sleep(STOP_GRACE_MS),
		]);
	for (const proc of dying) {
		if (proc.exitCode !== null) continue;
		try {
			proc.kill("SIGKILL");
		} catch {
			// Already exited.
		}
	}
	dryRunRunning = false;
	resetStreamHandles();
	startedAt = 0;
	streamState = "idle";
	emit?.("broadcaster.keepalives", { keepalives: [] }, { retain: false });
	notifyStatus();
	return { state: "idle" };
}

async function startStream(): Promise<Record<string, unknown>> {
	const config = (runtime = readConfig());
	syncPublicSlice();
	if (streamState === "running")
		return { state: "running", alreadyRunning: true };
	if (streamState === "starting") return { state: "starting" };
	if (config.outputs.length === 0)
		throw new ApiError("No RTMP outputs configured (add at least one destination)");

	preflight();
	wantsRunning = true;
	epoch += 1;
	const runEpoch = epoch;
	streamState = "starting";
	notifyStatus();
	log(
		"info",
		`starting stream: srtla:${config.srtlaPort} → srt:${config.bindHost}:${config.srtPort} → ${config.outputs
			.map((output) => effectiveOutputUrl(output.url, output.key, true))
			.join(", ")}`,
	);

	if (core.config.DRY_RUN) {
		dryRunRunning = true;
		startedAt = Date.now();
		streamState = "running";
		notifyStatus();
		return {
			state: "running",
			outputs: config.outputs.map((output) =>
				effectiveOutputUrl(output.url, output.key, true),
			),
		};
	}

	try {
		ffmpegProc = spawnProc("ffmpeg", buildPipeline(config), "ffmpeg", runEpoch);
		const ready = await waitForUdpPort(
			config.srtPort,
			PORT_READY_TIMEOUT_MS,
			runEpoch,
		);
		if (!ready)
			throw new Error(`ffmpeg did not open SRT port ${config.srtPort} in time`);

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
		srtlaProc = spawnProc(
			"srtla_rec",
			srtlaArgs,
			"srtla_rec",
			runEpoch,
			parseKeepalive,
		);
		startedAt = Date.now();
		streamState = "running";
		notifyStatus();
		log("info", "stream is running");
		return {
			state: "running",
			outputs: config.outputs.map((output) =>
				effectiveOutputUrl(output.url, output.key, true),
			),
		};
	} catch (error: unknown) {
		if (runEpoch === epoch) await stopStream();
		throw error;
	}
}

async function explicitStop(): Promise<Record<string, unknown>> {
	wantsRunning = false;
	resumeAfterConfigure = false;
	restartGeneration += 1;
	if (restartTimer !== null) {
		clearTimeout(restartTimer);
		restartTimer = null;
	}
	streamRestarts = 0;
	streamBackoff = BACKOFF_MIN_MS;
	return stopStream();
}

function scheduleStreamRestart(reason: string): void {
	if (!wantsRunning) return;
	const generation = restartGeneration;
	if (restartTimer !== null) clearTimeout(restartTimer);
	restartTimer = null;
	streamRestarts += 1;
	const delay = streamBackoff;
	streamBackoff = Math.min(streamBackoff * 2, BACKOFF_MAX_MS);
	log(
		"warn",
		`${reason} — restarting stream in ${Math.round(delay / 1000)}s (restart #${streamRestarts})`,
	);
	void stopStream().then(() => {
		if (!wantsRunning || generation !== restartGeneration) return;
		restartTimer = setTimeout(() => {
			restartTimer = null;
			if (!wantsRunning) return;
			void startStream().catch((error: unknown) => {
				log("error", `auto-restart failed: ${errorMessage(error)}`);
				scheduleStreamRestart("auto-restart failed");
			});
		}, delay);
	});
	notifyStatus();
}

async function restartStream(): Promise<void> {
	log("info", "restarting stream to apply new settings");
	await stopStream();
	try {
		await startStream();
	} catch (error: unknown) {
		log("warn", `restart after settings change failed: ${errorMessage(error)}`);
	}
}

function startHealthMonitor(): void {
	if (healthTimer !== null) clearInterval(healthTimer);
	healthFails = 0;
	healthTimer = setInterval(() => {
		if (streamState !== "running" || core.config.DRY_RUN) {
			healthFails = 0;
			return;
		}
		const config = runtime;
		if (!config) return;
		if (isUdpPortOpen(config.srtlaPort)) {
			healthFails = 0;
			if (Date.now() - startedAt > STREAM_RESTART_STABLE_MS) {
				streamBackoff = BACKOFF_MIN_MS;
				streamRestarts = 0;
			}
			return;
		}
		healthFails += 1;
		if (healthFails < HEALTH_CHECK_THRESHOLD) return;
		healthFails = 0;
		const seconds =
			(HEALTH_CHECK_THRESHOLD * HEALTH_CHECK_INTERVAL_MS) / 1000;
		const reason = `SRTLA port ${config.srtlaPort} not open for ${seconds} s`;
		if (wantsRunning) scheduleStreamRestart(reason);
		else {
			log("warn", `${reason} — stopping stream`);
			void stopStream();
		}
	}, HEALTH_CHECK_INTERVAL_MS);
}

function getPublicStatus(): Record<string, unknown> {
	return {
		state: statusFields(),
		summary: { stream: streamState },
	};
}

function configure(configValue: Params, slice: Record<string, unknown>): void {
	const stored = data();
	let outputs: OutputSecret[] | undefined;
	if (Array.isArray(configValue.outputs)) {
		try {
			outputs = configuredOutputs(
				configValue.outputs,
				Array.isArray(stored.outputKeys)
					? stored.outputKeys.filter(
							(key): key is string => typeof key === "string",
						)
					: [],
			);
		} catch (error: unknown) {
			throw new ApiError(errorMessage(error));
		}
	}
	let profile: string | undefined;
	if (typeof configValue.profile === "string") {
		profile = configValue.profile.trim();
		if (profile !== "" && findProfile(profile) === undefined)
			throw new ApiError(`Unknown profile: ${profile}`);
	}

	if (outputs) {
		slice.outputs = outputMetadata(outputs);
		storeData({
			outputKeys: outputs.map((output) => output.key),
			outputsConfigured: true,
		});
	}
	if (profile !== undefined) {
		slice.profile = profile;
	}
	slice.profiles = listProfiles().map(({ id, name }) => ({ id, name }));
	slice.profilesDir =
		typeof slice.profilesDir === "string"
			? slice.profilesDir
			: runtime?.profilesDir ?? DEFAULTS.profilesDir;
	resumeAfterConfigure = wantsRunning;
}

const broadcasterModule: BackendModule<ModuleCore> = {
	kind: "device",
	id: ID,
	title: "SRTLA → RTMP",
	roles: ["broadcaster"],
	roleDefinitions: [
		{
			id: "broadcaster",
			titleKey: "role.broadcaster",
			order: 50,
			setupSelectable: true,
		},
	],
	configDefaults: {
		outputs: [],
		profile: DEFAULTS.profile,
		profiles: [],
		profilesDir: DEFAULTS.profilesDir,
	},
	methods: ["broadcaster.start", "broadcaster.stop"],
	events: ["broadcaster.status", "broadcaster.keepalives"],
	log: logWording,
	bind(boundCore) {
		core = boundCore;
	},
	async start(ctx) {
		core = ctx.core;
		emit = ctx.emit;
		contextLog = ctx.log;
		runtime = readConfig();
		seedDefaultProfiles();
		syncPublicSlice();
		await core.saveState();
		startHealthMonitor();
		if (wantsRunning) await restartStream();
	},
	async stop() {
		if (!resumeAfterConfigure) wantsRunning = false;
		resumeAfterConfigure = false;
		restartGeneration += 1;
		if (healthTimer !== null) clearInterval(healthTimer);
		healthTimer = null;
		if (restartTimer !== null) clearTimeout(restartTimer);
		restartTimer = null;
		await stopStream();
	},
	async resume() {
		if (core.role() !== "broadcaster") return false;
		runtime = readConfig();
		if (runtime.outputs.length === 0) return false;
		if (streamState !== "running") await startStream();
		return true;
	},
	async status() {
		return getPublicStatus();
	},
	configure(configValue, slice) {
		configure(configValue, slice);
	},
	async dispatch(method) {
		switch (method) {
			case "broadcaster.start":
				core.cancelAutostart();
				try {
					return await startStream();
				} catch (error: unknown) {
					if (error instanceof ApiError) throw error;
					const message = errorMessage(error);
					throw new ApiError(message, /already/.test(message) ? 409 : 500);
				}
			case "broadcaster.stop":
				core.cancelAutostart();
				return explicitStop();
			default:
				throw new ApiError(`Unknown method: ${method}`, 404);
		}
	},
};

export default broadcasterModule;

// Keep these module-owned helpers directly testable without importing core internals.
export { configuredOutputs as normalizeConfigureOutputs } from "./persistence";
export { effectiveOutputUrl } from "./persistence";
