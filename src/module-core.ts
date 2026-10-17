/*
 * Core bag — every service a backend module may need, aggregated into one
 * object the registry hands to modules: at discovery via `bind()` (the bag
 * is process-scoped — process config, state, exec — so a module's lazy
 * objects stay constructible even when the module is not started) and
 * again at start via `ctx.core` (alongside the start-scoped ctx fields).
 *
 * This is the single dependency edge from a module into the core. A module
 * never imports from `../../src/*`: it reads what it needs from the bag it
 * was handed (and the registry fills `moduleById` after discovery).
 * The bag is intentionally broad-and-structural: a module types only the
 * fields it uses, locally.
 *
 * The file also keeps the role/core-facing module helpers that are not
 * module-specific (moduleEnabled / safeModules / configureModule).
 */

import { requireCapability } from "./capabilities";
import {
	BITRATE_FILE,
	CERACODER_CONF,
	DRY_RUN,
	ENCODER_BIN,
	IS_CERA,
	LOG_FILE,
	PIPELINES_DIR,
	RELOAD_MODE,
	SRTLA_SOCKET,
	UPLINKS_FILE,
} from "./config";
import { logEvent } from "./eventlog";
import { run } from "./exec";
import { writeFileAtomic } from "./files";
import { t } from "./i18n";
import { ApiError } from "./params";
import { listDevices, requestDevice } from "./remote";
import {
	latestSrtlaStats,
	prepareSrtlaControl,
	rpc,
	SRTLA_MODES,
	type SrtlaCapabilities,
	srtlaCapabilities,
	srtlaControlState,
	startSrtlaControl,
	stopSrtlaControl,
} from "./srtlaControl";
import {
	notifyStateChange,
	type ModulesState,
	type PersistentState,
	type SrtlaOptions,
	type SrtlaOptionsResult,
	saveState,
	state,
} from "./state";
import { Supervisor } from "./supervisor";
import { errorMessage, readLines } from "./util";

/** The live process state a module mutates and persists with `saveState`. */
export type DeviceState = PersistentState;

/** srtla_send control-socket surface (SRTLA module). */
export interface SrtlaControl {
	SRTLA_MODES: readonly string[];
	srtlaCapabilities: typeof srtlaCapabilities;
	prepareSrtlaControl: typeof prepareSrtlaControl;
	startSrtlaControl: typeof startSrtlaControl;
	stopSrtlaControl: typeof stopSrtlaControl;
	srtlaControlState: typeof srtlaControlState;
	latestSrtlaStats: typeof latestSrtlaStats;
	rpc: typeof rpc;
}

/** A module's live status fragment, as collected by the registry. */
export type ModuleStatus = () => Promise<Record<string, unknown>>;

export interface ModuleCore {
	config: {
		BITRATE_FILE: string;
		CERACODER_CONF: string;
		DRY_RUN: boolean;
		ENCODER_BIN: string;
		IS_CERA: boolean;
		PIPELINES_DIR: string;
		SRTLA_SOCKET: string;
		UPLINKS_FILE: string;
		RELOAD_MODE: "signal" | "restart";
		LOG_FILE: string;
	};
	state: DeviceState;
	saveState: () => Promise<void>;
	notifyStateChange: () => void;
	logEvent: typeof logEvent;
	t: typeof t;
	writeFileAtomic: typeof writeFileAtomic;
	Supervisor: typeof Supervisor;
	run: typeof run;
	errorMessage: typeof errorMessage;
	readLines: typeof readLines;
	ApiError: typeof ApiError;
	srtlaControl: SrtlaControl;
	/**
	 * Capability bus — module-to-module calls flow through it (names, not
	 * module ids); the switcher's per-source metrics use it.
	 */
	requireCapability: typeof requireCapability;
	/**
	 * Resolve a registered module's live status by id (the switcher's combined
	 * source). Filled by the registry after discovery. Returns null when the id
	 * is unknown.
	 */
	moduleById: (id: string) => { id: string; status?: ModuleStatus } | undefined;
	/**
	 * The control server's device registry (the devices this box is registered
	 * with). Empty when no remote link is configured / connected; rejects when
	 * the link is down.
	 */
	listDevices: typeof listDevices;
	/** Request a method on another registered device (server-mediated). */
	requestDevice: typeof requestDevice;
}

/** Live srtla scheduler-options types (re-exported for modules to avoid a core import). */
export type { SrtlaCapabilities, SrtlaOptions, SrtlaOptionsResult };

/**
 * Build the bag once. `moduleById` delegates to `lookup` (a mutable slot the
 * registry fills after discovery), keeping module → core one-directional with
 * no import cycle.
 */
export function buildModuleCore(
	lookup: (id: string) => { id: string; status?: ModuleStatus } | undefined,
): ModuleCore {
	return {
		config: {
			BITRATE_FILE,
			CERACODER_CONF,
			DRY_RUN,
			ENCODER_BIN,
			IS_CERA,
			PIPELINES_DIR,
			SRTLA_SOCKET,
			UPLINKS_FILE,
			RELOAD_MODE,
			LOG_FILE,
		},
		state,
		saveState,
		notifyStateChange,
		logEvent,
		t,
		writeFileAtomic,
		Supervisor,
		run,
		errorMessage,
		readLines,
		ApiError,
		srtlaControl: {
			SRTLA_MODES,
			srtlaCapabilities,
			prepareSrtlaControl,
			startSrtlaControl,
			stopSrtlaControl,
			srtlaControlState,
			latestSrtlaStats,
			rpc,
		},
		requireCapability,
		moduleById: lookup,
		listDevices,
		requestDevice,
	};
}

// ---------------------------------------------------------------------------
// Role/core-facing module helpers (every real module runs through the
// registry in registry.ts; these are the pieces that are not module-specific)
// ---------------------------------------------------------------------------

const mods = (): ModulesState | undefined => state.settings.modules;

export const moduleEnabled = (id: string): boolean => {
	const m = mods();
	if (!m) return false;
	return (m as unknown as Record<string, { enabled: boolean }>)[id]?.enabled ?? false;
};

/** Apply a module's persisted configuration (secrets kept); caller saves state. */
export function configureModule(id: string, config: Record<string, unknown>): void {
	const m = mods();
	if (!m) return;
	switch (id) {
		case "relay":
		case "encoder": {
			if (typeof config.enabled === "boolean") m[id].enabled = config.enabled;
			// Subprocess wiring follows the process role and applies on restart
			break;
		}
	}
}

/** The persisted module map for the status; secret strings come back as `{configured}`. */
export function safeModules(): object {
	const m = mods();
	if (!m) return {};
	const mask = (cfg: Record<string, unknown>) =>
		Object.fromEntries(
			Object.entries(cfg).map(([k, v]) =>
				/password|token/i.test(k) && typeof v === "string" ? [k, { configured: v !== "" }] : [k, v],
			),
		);
	return Object.fromEntries(
		Object.entries(m as unknown as Record<string, Record<string, unknown>>).map(([id, cfg]) => [id, mask(cfg)]),
	);
}
