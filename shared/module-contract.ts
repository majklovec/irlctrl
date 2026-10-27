/**
 * The backend module registration contract — the only shape the core knows
 * about a module. `modules/<id>/backend.ts` default-exports one of these;
 * the registry (shared/registry.ts) discovers and validates it, the device
 * lifecycle (backend/client/modules.ts) drives it.
 *
 * Everything module-specific lives behind this contract: a module parses its
 * own CLI arguments, owns its persisted config sections (`core.state.data`),
 * validates its own RPC parameters in `dispatch`, and contributes status /
 * settings / setup / log wording / pages / widgets through the optional hooks
 * below. The core never names a module id, method prefix or status key.
 */
import type { LogWording } from "./logMessages";
import type { WidgetConfigField } from "./types";
import type { Role } from "./validate";

export type Params = Record<string, unknown>;

/** Options of a module-emitted push (`ctx.emit`). */
export interface EmitOptions {
	/** Rate-limit per sink (remote links push these less often). */
	throttle?: boolean;
	/** Keep the last frame and replay it to new connections; `false` drops a retained one. */
	retain?: boolean;
	/** Device-list summary fields the control server merges into the device entry. */
	summary?: Record<string, unknown>;
}

export type Emit = (event: string, data: unknown, opts?: EmitOptions) => void;

/** What `start()` receives. `TCore` is the process-services bag (see backend/client/module-core.ts). */
export interface ModuleStartContext<TCore = unknown> {
	/** The module's persisted settings slice (`settings.modules[<configKey>]`). */
	config: Record<string, unknown>;
	emit: Emit;
	log: (section: string, message: string) => void;
	core: TCore;
}

/** Log wording a module contributes (merged into shared/logMessages). */
export type ModuleLogWording = LogWording;

/** A module-owned page route: `match` tests the request path (device-relative). */
export interface ModulePage {
	match: RegExp;
	/** Page name — `modules/<id>/pages/<page>.html`. */
	page: string;
}

/** A device-bound dashboard widget the module renders (server-side validation + default size). */
export interface ModuleWidget {
	type: string;
	defaultSize: { w: number; h: number };
}

/** Channel-widget hub (device-independent dashboard widgets: stats, chat). */
export interface ModuleHub {
	widgetType: string;
	snapshotKey: string;
	defaultSize: { w: number; h: number };
	configFields: readonly WidgetConfigField[];
	/** One channel spec per configured source (`null` for unconfigured ones). */
	channelSpec: (
		config: Record<string, string> | undefined,
	) => readonly (string | null)[];
	create: (publish: (msg: string) => void) => ChannelHub;
}

export interface ChannelHub {
	sync(
		channels: Set<string>,
		configs?: readonly (Record<string, string> | undefined)[],
	): void;
	startedChannels(): string[];
	snapshot(): Record<string, unknown>;
	destroy(): void;
}

/** A module's persisted settings slice: `enabled` plus module-defined fields. */
export interface ModuleSlice {
	enabled: boolean;
	[field: string]: unknown;
}

export interface BackendModule<TCore = unknown> {
	kind: "device" | "widget";
	/** Module id = directory name. */
	id: string;
	title: string;

	// --- settings slice -----------------------------------------------------
	/** Key under `settings.modules` (defaults to `id`; lets a renamed module keep its stored slice). */
	configKey?: string;
	/** Defaults of the slice, deep-merged under the stored values (new fields backfill). */
	configDefaults?: Record<string, unknown>;
	/** Slice fields the status view masks as `{ configured: boolean }`. */
	secretFields?: readonly string[];
	/** Roles the module serves: its methods are rejected (409) on other roles and the
	 * slice starts `enabled` on these roles. Omit for "every role". */
	roles?: readonly Role[];
	/** Fresh devices start the module disabled even on its roles (default: enabled on its roles). */
	enabledByDefault?: boolean;
	/** Reject the module's methods (409) while its slice is disabled. */
	requireEnabled?: boolean;

	// --- RPC ------------------------------------------------------------------
	/** Ordered list of RPC methods this module answers (names are frozen API). */
	methods: readonly string[];
	/** Per-method role override (e.g. a combined-only method of a module that also serves encoders). */
	methodRoles?: Record<string, readonly Role[]>;
	/** Events the module emits. */
	events: readonly string[];
	/** Handle one RPC call: validate `params` (throw ApiError), act, return the result. */
	dispatch(method: string, params: Params): Promise<unknown>;
	/** Log wording for the module's methods and labels. */
	log?: ModuleLogWording;

	// --- lifecycle ------------------------------------------------------------
	/** Ids of modules that must `start()` first (also orders status / resume). */
	dependencies?: readonly string[];
	/** Bind the process-services bag at discovery (before start; a disabled module is still bound). */
	bind?(core: TCore): void;
	start(ctx: ModuleStartContext<TCore>): Promise<void>;
	stop(): Promise<void>;
	/** Autostart: resume the last saved run; `true` when something was (or is) running. */
	resume?(): Promise<boolean>;

	// --- contributions --------------------------------------------------------
	/** Status fragment, deep-merged into the `status` payload (nest under `state` for persisted bits). */
	status?(): Promise<Record<string, unknown>>;
	/** Fields merged into `settings.get`. */
	settings?(): Record<string, unknown>;
	/** Fields merged into `setup.get` (wizard data). */
	setupInfo?(): Promise<Record<string, unknown>>;
	/** Setup wizard: validate the module's answers and return the apply step (run once every
	 * module validated). Return nothing when the module has nothing to apply for `role`. */
	setup?(
		params: Params,
		role: Role,
	): Promise<(() => void | Promise<void>) | undefined>;
	/** Apply a `modules.configure` call to the slice (default: only `enabled`). */
	configure?(config: Params, slice: ModuleSlice): void;
	/** Module-owned pages (`modules/<id>/pages/*.html`) and the paths that serve them. */
	pages?: readonly ModulePage[];
	/** Device-bound dashboard widgets the module renders. */
	dashboardWidgets?: readonly ModuleWidget[];
	/** Capabilities offered to other modules (looked up by name through the bus). */
	services?: { capabilities?: Record<string, unknown> };
	/** Channel-widget hub (widget modules). */
	hub?: ModuleHub;
}
