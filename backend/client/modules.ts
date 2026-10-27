/*
 * Device-side module lifecycle: the registry's registrations driven by the
 * device process — settings slices (defaults, backfill, enable/disable),
 * start/stop/restart, RPC ownership and gating, status / settings / setup
 * contributions, and autostart. Nothing here names a module id, method
 * prefix or status key: every decision reads the registration contract
 * (shared/module-contract.ts).
 */
import type {
	BackendModule,
	ModuleSlice,
	Params,
} from "../../shared/module-contract";
import { ALL_MODULES, moduleById } from "../../shared/registry";
import { deepMerge } from "../../shared/util";
import type { Role } from "../../shared/validate";
import { runAutostart as runAutostartWith } from "./autostart";
import { provideCapability } from "./capabilities";
import { logEvent } from "./eventlog";
import { buildModuleCore, type ModuleCore } from "./module-core";
import { pushModuleEvent } from "./push";
import {
	completeSetup,
	type ModulesState,
	setupRequired,
	state,
} from "./state";

export { ALL_MODULES, moduleById };

type Module = BackendModule<ModuleCore>;

const DEVICE_MODULES = ALL_MODULES.filter(
	(m) => m.kind === "device",
) as Module[];

// ---------------------------------------------------------------------------
// Settings slices
// ---------------------------------------------------------------------------

const configKey = (mod: BackendModule): string => mod.configKey ?? mod.id;

/** The module's persisted settings slice (undefined before setup / for unknown ids). */
export const moduleSlice = (mod: BackendModule): ModuleSlice | undefined =>
	state.settings.modules?.[configKey(mod)];

export const moduleEnabled = (id: string): boolean => {
	const mod = moduleById(id);
	return mod ? moduleSlice(mod)?.enabled === true : false;
};

const servesRole = (mod: BackendModule, role: Role): boolean =>
	!mod.roles || mod.roles.includes(role);

/** The slice a fresh device gets for `mod` on `role`. */
const defaultSlice = (mod: BackendModule, role: Role): ModuleSlice =>
	deepMerge(
		{ enabled: servesRole(mod, role) && mod.enabledByDefault !== false },
		mod.configDefaults,
	);

/** Default slices of every device module for `role` (the role presets). */
export const defaultModules = (role: Role): ModulesState =>
	Object.fromEntries(
		DEVICE_MODULES.map((m) => [configKey(m), defaultSlice(m, role)]),
	);

/**
 * Make sure every device module has a complete slice: missing modules get the
 * role's default, existing slices are backfilled with new default fields
 * (stored values win). Unknown stored keys are kept.
 */
export function ensureModuleSlices(role: Role = effectiveRole()): ModulesState {
	const stored = state.settings.modules ?? {};
	const modules: ModulesState = { ...stored };
	for (const mod of DEVICE_MODULES) {
		const key = configKey(mod);
		modules[key] = deepMerge(defaultSlice(mod, role), stored[key]);
	}
	state.settings.modules = modules;
	return modules;
}

/** The persisted module map for the status; secret strings come back as `{configured}`. */
export function safeModules(): Record<string, Record<string, unknown>> {
	const out: Record<string, Record<string, unknown>> = {};
	for (const [key, slice] of Object.entries(state.settings.modules ?? {})) {
		const secrets = new Set(moduleById(key)?.secretFields ?? []);
		out[key] = Object.fromEntries(
			Object.entries(slice).map(([k, v]) =>
				(secrets.has(k) || /password|token/i.test(k)) && typeof v === "string"
					? [k, { configured: v !== "" }]
					: [k, v],
			),
		);
	}
	return out;
}

/** Apply a `modules.configure` payload (the module's hook, or just `enabled`). */
export function configureModule(mod: Module, config: Params): void {
	const slice = ensureModuleSlices()[configKey(mod)];
	if (mod.configure) mod.configure(config, slice);
	else if (typeof config.enabled === "boolean") slice.enabled = config.enabled;
}

export function setModuleEnabled(mod: Module, enabled: boolean): void {
	ensureModuleSlices()[configKey(mod)].enabled = enabled;
}

// ---------------------------------------------------------------------------
// Discovery wiring: capabilities + the core bag
// ---------------------------------------------------------------------------

const core = buildModuleCore(moduleEnabled);
export const effectiveRole = (): Role => core.role();

for (const mod of ALL_MODULES)
	for (const [name, impl] of Object.entries(
		mod.services?.capabilities ?? {},
	))
		provideCapability(name, impl);

// Bind the process bag before start: a module's lazy objects must work —
// reporting "stopped" — even when its start never runs.
for (const mod of DEVICE_MODULES) mod.bind?.(core);

// A configured device gets its slices completed at load (new modules / fields).
if (!setupRequired) ensureModuleSlices();

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

const startCtx = (mod: Module) => ({
	config: { ...(moduleSlice(mod) ?? {}) },
	core,
	emit: (event: string, data: unknown, opts?: Parameters<typeof pushModuleEvent>[3]) =>
		pushModuleEvent(event, data, mod.id, opts),
	log: (section: string, message: string) =>
		logEvent("info", section, message),
});

const shouldRun = (mod: Module): boolean =>
	servesRole(mod, effectiveRole()) && moduleSlice(mod)?.enabled === true;

/** Start every settings-enabled module that serves the current role, in dependency order. */
export async function startModules(): Promise<void> {
	for (const mod of DEVICE_MODULES)
		if (shouldRun(mod)) await mod.start(startCtx(mod));
}

/** Stop every module (unstarted ones are no-ops by contract). */
export async function stopModules(): Promise<void> {
	for (const mod of [...DEVICE_MODULES].reverse()) await mod.stop();
}

/** Restart one module (stop, then start when it should run). */
export async function restartModule(mod: Module): Promise<void> {
	await mod.stop();
	if (shouldRun(mod)) await mod.start(startCtx(mod));
}

/** Modules whose contributions apply to the current role (enabled or not). */
const applicable = (): Module[] =>
	DEVICE_MODULES.filter((m) => servesRole(m, effectiveRole()));

/** Every applicable module's status fragment, deep-merged (keys never collide by design). */
export async function moduleStatuses(): Promise<Record<string, unknown>> {
	let out: Record<string, unknown> = {};
	for (const mod of applicable())
		if (mod.status) out = deepMerge(out, await mod.status());
	return out;
}

export const moduleSettings = (): Record<string, unknown> =>
	Object.assign({}, ...applicable().map((m) => m.settings?.() ?? {}));

export async function moduleSetupInfo(): Promise<Record<string, unknown>> {
	let out: Record<string, unknown> = {};
	for (const mod of applicable())
		if (mod.setupInfo) out = deepMerge(out, await mod.setupInfo());
	return out;
}

/**
 * Setup wizard: let every module serving `role` validate its answers, then
 * apply them all (nothing is applied while any module may still reject).
 */
export async function setupModules(
	params: Params,
	role: Role,
): Promise<() => Promise<void>> {
	const applies: (() => void | Promise<void>)[] = [];
	for (const mod of DEVICE_MODULES) {
		if (!servesRole(mod, role) || !mod.setup) continue;
		const apply = await mod.setup(params, role);
		if (apply) applies.push(apply);
	}
	return async () => {
		for (const apply of applies) await apply();
	};
}

/** Seed the module slices for the role picked in the wizard and leave setup. */
export async function finishSetup(role: Role): Promise<void> {
	ensureModuleSlices(role);
	await completeSetup();
}

// ---------------------------------------------------------------------------
// RPC ownership and gating
// ---------------------------------------------------------------------------

const METHOD_OWNER = new Map<string, Module>();
for (const mod of DEVICE_MODULES)
	for (const method of mod.methods) METHOD_OWNER.set(method, mod);

export const methodOwner = (method: string): Module | undefined =>
	METHOD_OWNER.get(method);

/** Whether a module method may run now (role + enabled gates from the registration). */
export function methodAllowed(method: string): boolean {
	const mod = METHOD_OWNER.get(method);
	if (!mod) return true;
	const roles = mod.methodRoles?.[method] ?? mod.roles;
	if (roles && !roles.includes(effectiveRole())) return false;
	if (mod.requireEnabled && moduleSlice(mod)?.enabled !== true) return false;
	return true;
}

/** Dispatch an RPC method to the module that owns it. */
export function callModule(method: string, params: Params): Promise<unknown> {
	const mod = METHOD_OWNER.get(method);
	if (!mod) return Promise.reject(new Error(`unknown method ${method}`));
	return mod.dispatch(method, params);
}

/** Autostart: resume every running module's last run (see autostart.ts). */
export const runAutostart = (): void =>
	runAutostartWith(async () => {
		let resumed = false;
		for (const mod of DEVICE_MODULES)
			if (shouldRun(mod) && mod.resume && (await mod.resume())) resumed = true;
		return resumed;
	});
