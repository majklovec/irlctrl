/*
 * obs-controller module: owns the ObsClient connection to the paired OBS
 * Studio, answers the obs.* API methods (raw obs-websocket passthrough) and
 * forwards OBS events into the irlctrl event stream (pushed with a
 * `module: "obs-controller"` tag). The low-bitrate switcher rides on the same
 * client and lives in this module's settings slice.
 *
 * Self-contained: wire types live in ./types; the only core edge is the bag.
 */
import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ModuleCore } from "../../backend/client/module-core";
import type { BackendModule, Params } from "../../shared/module-contract";
import {
	DEFAULT_EVENT_SUBSCRIPTIONS,
	EventSubscription,
	OBS_DISCONNECTED_EVENT,
	ObsClient,
	type ObsEvent,
	type ObsRequest,
	type ObsRequestBatch,
} from "../../shared/obs/client";
import { ApiError, optionalStringList, requireString } from "../../shared/params";
import { collectSrtSample, type SrtBaseline } from "./srt-metrics";
import { type ObsSnapshot, SwitcherEngine } from "./switcher-engine";
import type { Emit, ObsSlice, SwitcherConfig, SwitcherMetrics } from "./types";

const SECTION = "LowBitrateSwitcher";
const MODULE_ID = "obs-controller";

/** Core bag, bound at discovery and re-filled at start (a module never imports the core). */
let core: ModuleCore;

/** This module's settings slice (created by the core from `configDefaults`). */
const slice = (): ObsSlice | undefined =>
	core.state.settings.modules?.[MODULE_ID] as ObsSlice | undefined;

/**
 * Switcher defaults — the same values the card form carries, so the slice
 * seeded on first run is complete and the engine can start before the form
 * has ever saved. The switcher rides on the OBS module (`switcherEnabled`
 * defaults to on).
 */
const SWITCHER_DEFAULTS = {
	obsSourceName: "",
	failBehaviour: "pause" as const,
	autoSwitch: true,
	onlySwitchWhenStreaming: false,
	instantlySwitchOnRecover: true,
	retryAttempts: 5,
	pollIntervalMs: 1000,
	triggers: { low: 500, offline: 400, rtt: 1500 },
	scenes: { normal: "", low: "", offline: "" },
	optionalScenes: { starting: "", ending: "", privacy: "" },
	logToFile: true,
};

// op5 events forwarded to the UI; the ones an operator dashboard reacts to.
// OBS v5 output events carry no "Current" prefix — they are StreamStateChanged /
// RecordStateChanged (the names the dashboards already listen for), unlike the
// scene/input events above. InputVolumeMeters feeds the card's VU meter,
// InputMute keeps its mute button honest.
const FORWARDED_EVENTS = [
	"CurrentProgramSceneChanged",
	"CurrentPreviewSceneChanged",
	"CurrentProgramSceneItemChanged",
	"CurrentTransitionChanged",
	"CurrentProgramInputChanged",
	"ActiveInputChanged",
	"SceneItemAdded",
	"SceneItemRemoved",
	"MediaInputPlaybackStateChanged",
	"MediaInputStateChanged",
	"StreamStateChanged",
	"RecordStateChanged",
	"InputVolumeMeters",
	"InputMute",
	"InputMuteStateChanged",
] as const;

const EVENT_SUBSCRIPTION_NAMES: Record<string, number> = {
	General: EventSubscription.General,
	Config: EventSubscription.Config,
	Scenes: EventSubscription.Scenes,
	Inputs: EventSubscription.Inputs,
	Transitions: EventSubscription.Transitions,
	Filters: EventSubscription.Filters,
	Outputs: EventSubscription.Outputs,
	SceneItems: EventSubscription.SceneItems,
	MediaInputs: EventSubscription.MediaInputs,
	Vendors: EventSubscription.Vendors,
	Ui: EventSubscription.Ui,
	InputVolumeMeters: EventSubscription.InputVolumeMeters,
	InputActiveStateChanged: EventSubscription.InputActiveStateChanged,
	InputShowStateChanged: EventSubscription.InputShowStateChanged,
	SceneItemTransformChanged: EventSubscription.SceneItemTransformChanged,
};

/** Case-insensitive: the map is keyed by upper-cased event names. */
const EVENT_SUBSCRIPTION_LOOKUP: Record<string, number> = Object.fromEntries(
	Object.entries(EVENT_SUBSCRIPTION_NAMES).map(([name, bit]) => [
		name.toUpperCase(),
		bit,
	]),
);

let obsClient: ObsClient | null = null;

/** The live client, or a 409 asking the operator to enable the module. */
const requiredClient = (): ObsClient => {
	if (!obsClient)
		throw new ApiError("The obs-controller module is not running", 409);
	return obsClient;
};

/** OR of the event bits for the given names (case-insensitive; unknown names are skipped). */
const subscriptionMask = (names: string[]): number =>
	names.reduce(
		(acc, name) =>
			acc |
			(EVENT_SUBSCRIPTION_LOOKUP[name.toUpperCase()] ?? EventSubscription.None),
		0,
	);

const record = (v: unknown): Record<string, unknown> | undefined =>
	v && typeof v === "object" && !Array.isArray(v)
		? (v as Record<string, unknown>)
		: undefined;

const requestId = (v: unknown): string =>
	typeof v === "string" && v ? v : randomUUID();

/** Normalize an `obs.requestBatch` body (op9) — validates every request's type. */
function parseBatch(p: Params): ObsRequestBatch {
	const requests = p.requests;
	if (!Array.isArray(requests) || !requests.length)
		throw new ApiError("requests must be a non-empty array");
	for (const r of requests)
		if (typeof record(r)?.requestType !== "string")
			throw new ApiError("Each request needs a string requestType");
	return {
		requestId: requestId(p.requestId),
		requests: requests.map((r) => {
			const it = r as Record<string, unknown>;
			return {
				requestType: it.requestType as string,
				requestId: requestId(it.requestId),
				...(it.requestData ? { requestData: record(it.requestData) } : {}),
			};
		}),
		...(p.haltOnFailure !== undefined
			? { haltOnFailure: !!p.haltOnFailure }
			: {}),
		...(p.executionType !== undefined
			? { executionType: p.executionType as 0 | 1 | 2 }
			: {}),
	} as ObsRequestBatch;
}

const forward =
	(name: string, emit: Emit) =>
	(_data: Record<string, unknown>, event: ObsEvent) =>
		emit("obs.event", {
			eventType: name,
			eventIntent: event.eventIntent,
			eventData: event.eventData,
		});

async function teardown(): Promise<void> {
	stopEngine();
	obsClient?.disconnect();
	obsClient = null;
}

// ============================================================================
// Low-bitrate switcher — runs on this module's client. It polls the SRTLA
// source's vendor stats and drives scene changes through the same websocket.
// Its settings live in this module's slice (settings.modules["obs-controller"]).

const fileLog = (): string =>
	join(dirname(core.config.LOG_FILE), "lowBitrateSwitcher.log");

let engine: SwitcherEngine | null = null;
/** The active switcher settings (kept to hot-apply without re-reading state). */
let cfg: SwitcherConfig;
/** Baseline of the SRT byte counters (reset on each poll for the bitrate delta). */
let srtBaseline: SrtBaseline | null = null;
/** The program scene / streaming flag as last reported by the client. */
let scene: string | null = null;
let streaming = false;
/** The client the event listeners are attached to (a fresh client per start). */
let attachedTo: ObsClient | null = null;
let fileLogBroken = false;
/** The registry-provided emitter; the engine's status rides on this event. */
let emit: Emit = () => {};

function moduleLog(level: "info" | "warn" | "error", message: string): void {
	core.logEvent(level, SECTION, message);
	if (cfg?.logToFile && !fileLogBroken) {
		const line = `${JSON.stringify({ at: Date.now(), level, message })}\n`;
		const path = fileLog();
		mkdir(dirname(path), { recursive: true })
			.then(() => appendFile(path, line))
			.catch(() => {
				fileLogBroken = true;
			});
	}
}

/**
 * The module's switcher slice (the obs-controller slice; the switcher rides on
 * OBS). Incomplete slices (no `obsSourceName`) resolve to null: the engine
 * idles until the card form saves.
 */
function moduleSlice(): SwitcherConfig | null {
	const stored = slice();
	return stored && typeof stored.obsSourceName === "string"
		? (stored as unknown as SwitcherConfig)
		: null;
}

/**
 * One SRT sample read from OBS (see srt-metrics.ts for the vendor protocol and
 * the recent-bitrate delta math). Returns null when the client is down or the
 * query fails — the engine then sees a metrics gap and stays put.
 */
async function collectSrtMetrics(): Promise<SwitcherMetrics | null> {
	if (!obsClient) return null;
	const sourceName = (cfg?.obsSourceName ?? "").trim();
	if (!sourceName) return null;
	const { sample, baseline } = await collectSrtSample(
		obsClient,
		sourceName,
		srtBaseline,
		streaming,
		srtWarn,
	);
	srtBaseline = baseline;
	return sample;
}

/** Throttled SRT warning (a bad source name would otherwise log every poll). */
let lastSrtWarnAt = 0;
function srtWarn(message: string): void {
	const now = Date.now();
	if (now - lastSrtWarnAt < 30_000) return;
	lastSrtWarnAt = now;
	moduleLog("warn", message);
}

/** The client's obs snapshot for the engine (null: client down). */
function obsSnapshot(): ObsSnapshot | null {
	if (!obsClient) return null;
	return {
		connected: obsClient.connected && obsClient.identified,
		streaming,
		scene,
	};
}

async function obsSetScene(name: string): Promise<boolean> {
	if (!obsClient) return false;
	try {
		const res = await obsClient.sendRequest({
			requestType: "SetCurrentProgramScene",
			requestId: randomUUID(),
			// obs-websocket 5 wants camelCase `sceneName` (PascalCase is rejected).
			requestData: { sceneName: name },
		});
		return res.requestStatus.result;
	} catch {
		return false;
	}
}

/**
 * Is the output active? obs-websocket v5 sends the boolean `outputActive` (and
 * a numeric `outputState`); the older v4 forms stay tolerated.
 */
function readStreaming(d: Record<string, unknown> | null | undefined): boolean {
	if (!d) return false;
	if (typeof d.outputActive === "boolean") return d.outputActive as boolean;
	for (const k of ["outputState", "OutputState"])
		if (typeof d[k] === "number") return (d[k] as number) === 1;
	return false;
}

/** Warm the scene / streaming tracking from OBS itself. */
async function obsWarmStart(): Promise<void> {
	const client = obsClient;
	if (!client) return;
	try {
		const [sc, st] = await Promise.all([
			client.sendRequest({
				requestType: "GetCurrentProgramScene",
				requestId: randomUUID(),
				requestData: {},
			}),
			client.sendRequest({
				requestType: "GetStreamStatus",
				requestId: randomUUID(),
				requestData: {},
			}),
		]);
		// v5 answers { currentProgramSceneName } (v4: CurrentProgramSceneName).
		const sceneName =
			sc.responseData?.currentProgramSceneName ??
			sc.responseData?.CurrentProgramSceneName;
		if (typeof sceneName === "string") scene = sceneName;
		streaming = readStreaming(st.responseData);
	} catch {
		// Identification is in flight; the event handlers pick it up
	}
}

/**
 * Attach the scene / streaming event listeners to this module's client (a fresh
 * client on every start, so the set is re-created each time).
 */
function attachObsEvents(): void {
	const client = obsClient;
	if (!client) return;
	if (attachedTo === client) return;
	attachedTo = client;
	client.on("CurrentProgramSceneChanged", (d: Record<string, unknown>) => {
		// v5 answers events with `sceneName` (v4: CurrentProgramSceneName).
		const name = d.sceneName ?? d.CurrentProgramSceneName;
		if (typeof name === "string") scene = name;
	});
	client.on("StreamStateChanged", (d: Record<string, unknown>) => {
		streaming = readStreaming(d);
	});
}

function push(): void {
	emit("lowBitrateSwitcher.state", engine?.status() ?? null);
}

async function startEngine(): Promise<void> {
	const slice = moduleSlice();
	if (!slice) {
		moduleLog(
			"warn",
			"no OBS SRT source set; switcher idle until the card form saves",
		);
		return;
	}
	cfg = slice;
	srtBaseline = null;
	engine = new SwitcherEngine(cfg, {
		obs: obsSnapshot,
		setScene: obsSetScene,
		metrics: collectSrtMetrics,
		log: moduleLog,
		onUpdate: () => push(),
		now: () => Date.now(),
	});
	engine.start();
	attachObsEvents();
	void obsWarmStart();
	moduleLog("info", `started (OBS source: "${cfg.obsSourceName}")`);
}

function stopEngine(): void {
	engine?.stop();
	engine = null;
	attachedTo = null;
	srtBaseline = null;
}

/**
 * Apply the switcher settings (the lowBitrateSwitcher.save body) over the
 * obs-controller slice: a field keeps the previous value when the sent one is
 * not of the expected shape. The form is the source of the defaults.
 */
function applyConfig(raw: Record<string, unknown>): SwitcherConfig {
	const stored = slice() ?? ({} as ObsSlice);
	const base: SwitcherConfig = cfg ?? (stored as unknown as SwitcherConfig);
	const out: SwitcherConfig = structuredClone(base);
	if (typeof raw.obsSourceName === "string")
		out.obsSourceName = raw.obsSourceName;
	if (raw.failBehaviour === "pause" || raw.failBehaviour === "ignore")
		out.failBehaviour = raw.failBehaviour;
	if (raw.autoSwitch === true) out.autoSwitch = true;
	else if (raw.autoSwitch === false) out.autoSwitch = false;
	for (const key of [
		"onlySwitchWhenStreaming",
		"instantlySwitchOnRecover",
		"logToFile",
	] as const) {
		if (raw[key] === true) out[key] = true;
		else if (raw[key] === false) out[key] = false;
	}
	if (
		typeof raw.retryAttempts === "number" &&
		Number.isInteger(raw.retryAttempts) &&
		raw.retryAttempts >= 1 &&
		raw.retryAttempts <= 100
	) {
		out.retryAttempts = raw.retryAttempts;
	}
	if (
		typeof raw.pollIntervalMs === "number" &&
		Number.isInteger(raw.pollIntervalMs) &&
		raw.pollIntervalMs >= 200 &&
		raw.pollIntervalMs <= 3_600_000
	) {
		out.pollIntervalMs = raw.pollIntervalMs;
	}
	if (raw.triggers && typeof raw.triggers === "object") {
		const t = raw.triggers as Record<string, unknown>;
		for (const key of ["low", "offline", "rtt"] as const) {
			if (
				typeof t[key] === "number" &&
				Number.isFinite(t[key]) &&
				(t[key] as number) >= 0
			)
				out.triggers[key] = t[key];
		}
	}
	for (const key of ["normal", "low", "offline"] as const) {
		if (
			raw.scenes &&
			typeof raw.scenes === "object" &&
			typeof (raw.scenes as Record<string, unknown>)[key] === "string"
		)
			out.scenes[key] = (raw.scenes as Record<string, unknown>)[key] as string;
	}
	for (const key of ["starting", "ending", "privacy"] as const) {
		if (
			raw.optionalScenes &&
			typeof raw.optionalScenes === "object" &&
			typeof (raw.optionalScenes as Record<string, unknown>)[key] === "string"
		)
			out.optionalScenes[key] = (raw.optionalScenes as Record<string, unknown>)[
				key
			] as string;
	}
	// Persist the applied values (the whole switcher lives in the obs slice).
	Object.assign(stored, out);
	(core.state.settings.modules ??= {})[MODULE_ID] = stored;
	return out;
}

const registration: BackendModule<ModuleCore> = {
	kind: "device",
	id: MODULE_ID,
	title: "OBS",
	// Enabled by the operator (any role); the methods need a running client.
	enabledByDefault: false,
	requireEnabled: true,
	configDefaults: {
		obsUrl: "",
		obsPassword: "",
		sceneEvents: true,
		...SWITCHER_DEFAULTS,
	},
	secretFields: ["obsPassword"],
	methods: [
		"obs.request",
		"obs.requestBatch",
		"obs.setEventSubscriptions",
		"lowBitrateSwitcher.save",
	],
	events: ["obs.event", "lowBitrateSwitcher.state"],
	dashboardWidgets: [{ type: "obs", defaultSize: { w: 6, h: 6 } }],
	bind(c) {
		core = c;
	},
	async start(ctx) {
		core = ctx.core;
		emit = ctx.emit;
		await teardown();
		const cfg = ctx.config;
		if (cfg.enabled !== true) return;
		if (typeof cfg.obsUrl !== "string" || !cfg.obsUrl) {
			ctx.log(MODULE_ID, "enabled but no obsUrl set; module idle");
			return;
		}
		const obsPassword = cfg.obsPassword;
		obsClient = new ObsClient({
			url: cfg.obsUrl,
			...(obsPassword ? { password: obsPassword as string } : {}),
			// The VU meter needs the InputVolumeMeters bit (absent from the defaults);
			// InputMute rides in on the Inputs bit below.
			eventSubscriptions:
				cfg.sceneEvents === true
					? DEFAULT_EVENT_SUBSCRIPTIONS | EventSubscription.InputVolumeMeters
					: EventSubscription.None,
			log: (msg, ...rest) =>
				ctx.log(MODULE_ID, [msg, ...rest].map(String).join(" ")),
		});
		for (const name of FORWARDED_EVENTS)
			obsClient.on(name, forward(name, ctx.emit));
		// Synthetic drop event (clearly marked as non-standard by the client)
		obsClient.on(OBS_DISCONNECTED_EVENT, () =>
			ctx.emit("obs.event", { disconnected: true }),
		);
		// The low-bitrate switcher rides on this client. It is on by default
		// (the module's enabled flag is the master switch) and can be turned
		// off with its own switcherEnabled flag.
		if (cfg.switcherEnabled !== false) await startEngine();
	},
	async stop() {
		await teardown();
	},
	/** `modules.configure`: only the connection fields present in `config` are touched. */
	configure(config, s) {
		if (typeof config.enabled === "boolean") s.enabled = config.enabled;
		if (typeof config.obsUrl === "string") s.obsUrl = config.obsUrl;
		if (typeof config.obsPassword === "string")
			s.obsPassword = config.obsPassword;
		if (typeof config.sceneEvents === "boolean")
			s.sceneEvents = config.sceneEvents;
	},
	async status() {
		// The low-bitrate switcher's live state (null = not running): the card reads it.
		return { lowBitrateSwitcher: engine?.status() ?? null };
	},
	async dispatch(method, params) {
		switch (method) {
			case "obs.request": {
				const request: ObsRequest = {
					requestType: requireString(params, "requestType"),
					requestId: requestId(params.requestId),
					requestData: record(params.requestData) ?? {},
				};
				// op7 passthrough: the obs-websocket v5 response `d`, statuses unmapped
				return requiredClient().sendRequest(request);
			}
			case "obs.requestBatch": {
				// op9 passthrough: the obs-websocket v5 batch response `d`
				const batch = parseBatch(params);
				return requiredClient().sendBatch(batch);
			}
			case "obs.setEventSubscriptions": {
				const intents = subscriptionMask(
					optionalStringList(params, "eventSubscriptions") ?? [],
				);
				requiredClient().setEventSubscriptions(intents);
				return { ok: true, eventSubscriptions: intents };
			}
			case "lowBitrateSwitcher.save": {
				// The form sends the full flat switcher slice; a field that does
				// not match its shape keeps the previous value.
				const next = applyConfig(record(params.config) ?? params);
				await core.saveState();
				// Hot-apply: the running engine picks up the new values right away;
				// when it idled (no source set) it starts now.
				if (engine) {
					srtBaseline = null; // the observed source / counters may have changed
					engine.updateConfig(next);
					engine.start();
				} else if (obsClient && next.obsSourceName) {
					cfg = next;
					await startEngine();
				}
				push();
				return { ok: true };
			}
			default:
				throw new ApiError(`Unknown method: ${method}`, 404);
		}
	},
};

export default registration;
