/*
 * Persistent storage:
 *   config.json      permanent parameters only — the core device settings
 *                     (identity, role, control link, language, per-module
 *                     settings slices) plus every module's own config
 *                     sections, kept verbatim under `state.data`. Stable key
 *                     order, 2-space indent.
 *   in memory        live process state (running flags, pids, counters) is
 *                     module-owned and never written to disk.
 *
 * Modules mutate their `state.data.<section>` objects and their settings slice,
 * then call `saveState()`, which persists the permanent part. The core knows
 * no section by name.
 */
import { randomUUID } from "node:crypto";
import {
	asLanguage,
	DEFAULT_LANGUAGE,
	type Language,
	setCurrentLanguage,
} from "../../shared/i18n";
import type { ModuleSlice } from "../../shared/module-contract";
import { stableStringify } from "../../shared/util";
import { DEFAULT_COLOR, type Role } from "../../shared/validate";
import { CONFIG_EXISTS, CONFIG_FILE, DRY_RUN, INITIAL_CONFIG } from "./config";
import { writeFileAtomic } from "./files";

/** Per-module persisted settings, keyed by the module's `configKey` (default: id). */
export type ModulesState = Record<string, ModuleSlice>;

/** Device settings that can be changed from the control UI and used on restart. */
export interface DeviceSettings {
	/** Stable identity; the device registers with the control server under this uuid */
	uuid?: string;
	hostname?: string;
	role?: Role;
	remoteUrl?: string;
	remoteToken?: string;
	color?: string;
	/** UI language (see LANGUAGE_INFO in i18n.ts); defaults to "en". */
	language?: Language;
	modules?: ModulesState;
}

/** The core's own keys in the config file; everything else is a module section. */
const CORE_KEYS = [
	"autostart",
	"color",
	"hostname",
	"language",
	"modules",
	"remoteToken",
	"remoteUrl",
	"role",
	"uuid",
] as const;

/** Permanent device parameters persisted to the config file. */
export interface DeviceConfig extends Record<string, unknown> {
	autostart: boolean;
	color: string;
	hostname: string;
	language: Language;
	remoteUrl: string;
	role: Role;
	uuid: string;
	remoteToken?: string;
	modules?: ModulesState;
}

/** Merged in-memory view of the persisted config. */
export interface PersistentState {
	settings: DeviceSettings;
	/** Resume the last run when the service starts (modules implement `resume`). */
	autostart: boolean;
	/** Module-owned config sections (`data.<section>`), persisted verbatim. */
	data: Record<string, unknown>;
}

// A fresh device (no config file) shows the setup wizard first.
export let setupRequired = !CONFIG_EXISTS;

// ----------------------------------------------------------------------
// Projection between the merged in-memory state and the config file
// ----------------------------------------------------------------------

function projectConfig(s: PersistentState): DeviceConfig {
	const { settings } = s;
	const cfg: DeviceConfig = {
		...s.data,
		autostart: !!s.autostart,
		color: settings.color ?? DEFAULT_COLOR,
		hostname: settings.hostname ?? "",
		language: asLanguage(settings.language),
		remoteUrl: settings.remoteUrl ?? "",
		role: settings.role ?? "relay",
		uuid: settings.uuid ?? "",
	};
	if (settings.remoteToken) cfg.remoteToken = settings.remoteToken;
	if (settings.modules) cfg.modules = settings.modules;
	return cfg;
}

/** Split a config file into the core settings and the module sections. */
export function fromConfig(cfg: Record<string, unknown> | null): PersistentState {
	const c = cfg ?? {};
	const data: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(c))
		if (!(CORE_KEYS as readonly string[]).includes(key)) data[key] = value;
	return {
		settings: {
			uuid: c.uuid as string | undefined,
			hostname: (c.hostname as string | undefined) ?? "",
			role: c.role as Role | undefined,
			remoteUrl: (c.remoteUrl as string | undefined) ?? "",
			remoteToken: c.remoteToken as string | undefined,
			color: c.color as string | undefined,
			language: c.language as Language | undefined,
			modules: c.modules as ModulesState | undefined,
		},
		autostart: c.autostart === true,
		data,
	};
}

// ----------------------------------------------------------------------
// Change notification and save
// ----------------------------------------------------------------------
type ChangeListener = () => void;
const listeners = new Set<ChangeListener>();

/** Subscribe to state / uplink changes; returns an unsubscribe function. */
export function onStateChange(listener: ChangeListener): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function notifyStateChange(): void {
	for (const listener of listeners) listener();
}

let lastConfig = "";

/** Persist the permanent parameters; no-op when they have not changed. */
export async function saveState(): Promise<void> {
	notifyStateChange();
	if (DRY_RUN) return;
	const config = stableStringify(projectConfig(state));
	if (config === lastConfig) return;
	lastConfig = config;
	await writeFileAtomic(CONFIG_FILE, config);
}

/** Leave the setup wizard; the caller has seeded the module slices. */
export async function completeSetup(): Promise<void> {
	setupRequired = false;
	await saveState();
}

/** Shared mutable state; modules mutate their sections and call `saveState()`. */
export const state: PersistentState = CONFIG_EXISTS
	? fromConfig(INITIAL_CONFIG)
	: { settings: {}, autostart: false, data: {} };

// Hostnames change; the uuid is the device's permanent identity on the control server.
// It is auto-assigned here (backfilled into older config files) and never changes.
// Older config files have no language either; normalize so it is always present.
// A fresh device keeps both in memory only, so the setup wizard still runs.
{
	const backfill =
		CONFIG_EXISTS &&
		(!state.settings.uuid || state.settings.language === undefined);
	state.settings.uuid ||= randomUUID();
	state.settings.language ??= DEFAULT_LANGUAGE;
	if (backfill) await saveState();
}

// Seed the process-wide current language so t()/label() self-resolve to the
// device's saved UI language from the first log entry onward.
setCurrentLanguage(state.settings.language);

/** UI language as persisted in settings (defaults to "en"). */
export const uiLanguage = (): Language => asLanguage(state.settings.language);
