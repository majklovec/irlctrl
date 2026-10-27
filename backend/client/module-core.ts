/*
 * Core bag — the process services a backend module may use, handed over at
 * discovery (`bind`) and again at `start` (`ctx.core`). It is the single
 * dependency edge from a module into the device core: a module never imports
 * backend/client files, it reads what it needs from the bag (and imports the
 * dependency-free helpers in shared/ directly — args, params, i18n, util).
 *
 * The bag is generic: nothing in it belongs to one module. Module-specific
 * services travel between modules through the capability bus.
 */
import type { Role } from "../../shared/validate";
import { cancelAutostart } from "./autostart";
import { hasCapability, requireCapability } from "./capabilities";
import { argv, CONFIG_FILE, DRY_RUN, LOG_FILE, ROLE } from "./config";
import { logEvent } from "./eventlog";
import { run } from "./exec";
import { writeFileAtomic } from "./files";
import { listDevices, requestDevice } from "./remote";
import {
	notifyStateChange,
	onStateChange,
	type PersistentState,
	saveState,
	state,
} from "./state";
import { Supervisor } from "./supervisor";

export interface ModuleCore {
	config: {
		argv: readonly string[];
		CONFIG_FILE: string;
		DRY_RUN: boolean;
		LOG_FILE: string;
		/** The process role from the CLI / config file. */
		ROLE: Role;
	};
	/** Effective role: saved settings win over the process argument. */
	role(): Role;
	/** Settings + module sections (`state.data.<section>`); mutate, then `saveState()`. */
	state: PersistentState;
	saveState(): Promise<void>;
	notifyStateChange(): void;
	onStateChange(listener: () => void): () => void;
	/** Whether a module's settings slice is enabled (by id or config key). */
	moduleEnabled(id: string): boolean;
	/** A hand-issued start/stop takes over from a pending autostart retry. */
	cancelAutostart(): void;
	logEvent: typeof logEvent;
	run: typeof run;
	writeFileAtomic: typeof writeFileAtomic;
	Supervisor: typeof Supervisor;
	/** Capability bus — module-to-module calls flow through it (names, not module ids). */
	requireCapability: typeof requireCapability;
	hasCapability: typeof hasCapability;
	/** The control server's device registry; rejects when the link is down. */
	listDevices: typeof listDevices;
	/** Request a method on another registered device (server-mediated). */
	requestDevice: typeof requestDevice;
}

export function buildModuleCore(
	moduleEnabled: (id: string) => boolean,
): ModuleCore {
	return {
		config: { argv, CONFIG_FILE, DRY_RUN, LOG_FILE, ROLE },
		role: () => state.settings.role ?? ROLE,
		state,
		saveState,
		notifyStateChange,
		onStateChange,
		moduleEnabled,
		cancelAutostart,
		logEvent,
		run,
		writeFileAtomic,
		Supervisor,
		requireCapability,
		hasCapability,
		listDevices,
		requestDevice,
	};
}
