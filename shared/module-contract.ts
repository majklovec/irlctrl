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
import type { Status, WidgetConfigField } from "./types";
import type { Role } from "./validate";

export type Params = Record<string, unknown>;

/**
 * One operator action a module offers to the dashboard's Buttons widget: a
 * press invokes `method` (one of the module's RPC methods) on the device with
 * `params`. The control server merges the actions of every enabled module into
 * the device's cached status (`status.actions`); the widget never names a module.
 */
export interface DashboardAction {
	/** Unique within the module (the widget config stores `<module>.<id>`). */
	id: string;
	/** Default button label (an i18n key is resolved when one exists). */
	label: string;
	/** Short glyph shown before the label (an emoji or a few characters). */
	icon?: string;
	/** RPC method name on the device (must be one of the module's `methods`). */
	method: string;
	/** Default params; a widget may override them per button. */
	params?: Record<string, unknown>;
	/** Ask the operator before firing. */
	confirm?: boolean;
	/** Device roles the action applies on (default: `methodRoles[method]`, then the module's `roles`). */
	roles?: readonly Role[];
}

/** A dashboard action as published in `status.actions`: tagged with its owning module. */
export interface DashboardActionEntry extends DashboardAction {
	/** `<module id>.<action id>` — what a widget config refers to. */
	key: string;
	module: string;
	moduleTitle: string;
}

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

/** What a device widget's server-side `validateConfig` can look at. */
export interface WidgetConfigContext {
	/** True when the dashboard is being created (POST); a later save (PUT) is
	 * lenient so a module disabled or a device pruned in the meantime cannot
	 * brick the dashboard. */
	strict: boolean;
	/** The bound device's last cached status (device-bound widgets only). */
	status: Status | undefined;
	/** Any device's last cached status (undefined before it reported one / unknown id). */
	deviceStatus(deviceId: string): Status | undefined;
	/** Whether the dashboard's owner owns `deviceId`. */
	ownsDevice(deviceId: string): boolean;
	/** Whether `deviceId` is still registered at all (a pruned device is not;
	 * a lenient save may keep it, a foreign live device is always rejected). */
	deviceExists(deviceId: string): boolean;
}

/** A device-bound dashboard widget the module renders (server-side validation + default size). */
export interface ModuleWidget {
	type: string;
	defaultSize: { w: number; h: number };
	/** Fleet widget: not bound to one device — it is offered once and its
	 * config names the devices it drives (so `deviceId` stays empty). */
	fleet?: boolean;
	/** Config parameters the widget stores (string values, validated like the channel widgets'). */
	configFields?: readonly WidgetConfigField[];
	/** Extra validation of a widget's config (throw an Error to reject the save). */
	validateConfig?(
		config: Record<string, string>,
		context: WidgetConfigContext,
	): void;
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
	/** Operator actions offered to the dashboard's Buttons widget (each fires one of `methods`). */
	dashboardActions?: readonly DashboardAction[];
	/** Capabilities offered to other modules (looked up by name through the bus). */
	services?: { capabilities?: Record<string, unknown> };
	/** Channel-widget hub (widget modules). */
	hub?: ModuleHub;
}
