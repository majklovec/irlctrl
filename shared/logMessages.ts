/*
 * Event log entry shape and the log wording of API methods. Dependency-free so the
 * web UI can import it too.
 *
 * Sections and actions are canonical English constants (they are stored in log
 * entries and used for filtering); success wording is localized at creation time using
 * the current UI language. Display-time section localization uses label().
 *
 * Stays dependency-free (the web UI imports it): the runtime installs its
 * translator with setLogTranslator (Bun → shared/i18n, browser → frontend/ts/i18n).
 */

/** Translator injected by whichever runtime uses the log wording (see above). */
let translate: (key: string, options?: Record<string, unknown>) => string = (
	key,
) => key;
export const setLogTranslator = (
	fn: (key: string, options?: Record<string, unknown>) => string,
): void => {
	translate = fn;
};

/** Cap shared by every view of the event log (device, control server, UI). */
export const LOG_MAX = 200;

export type LogLevel = "info" | "warn" | "error";

export interface LogEntry {
	id: number;
	/** Set by the control server on entries it adds itself (device online / offline); the web UI
	 *  uses "browser" for its own page-local entries. */
	origin?: "server" | "browser";
	at: number; // last occurrence, ms since epoch
	level: LogLevel;
	section: string; // canonical English section name
	message: string; // localized at creation time
	count?: number; // consecutive repeats folded into this entry
}

/** `event: "log"` payload: the full history when `reset`, otherwise new or updated entries. */
export interface LogEvent {
	reset?: boolean;
	entries: LogEntry[];
}

type Params = Record<string, unknown>;

export interface MethodLog {
	section: string;
	action: string; // canonical English, for `<action> failed: <reason>`
	done: (p: Params) => string; // resolves the current language at call time
}

/** Build one method's log wording; `done` is an i18n key or a function of the params. */
export const wording = (
	section: string,
	action: string,
	done: string | ((p: Params) => string),
): MethodLog => ({
	section,
	action,
	done: typeof done === "string" ? () => translate(done) : done,
});

/** Translate with the installed runtime translator (for module `done` functions). */
export const logTranslate = (
	key: string,
	options?: Record<string, unknown>,
): string => translate(key, options);

/** Core methods that change something; module methods register theirs (registerLogWording). */
const METHOD_LOG: Record<string, MethodLog> = {
	"autostart.set": wording("Autostart", "Update", (p) =>
		translate(p.enabled ? "mlog.done.enabled" : "mlog.done.disabled"),
	),
	"modules.enable": wording("Modules", "Enable", (p) =>
		translate("mlog.done.module_enabled", { id: p.id }),
	),
	"modules.disable": wording("Modules", "Disable", (p) =>
		translate("mlog.done.module_disabled", { id: p.id }),
	),
	"modules.configure": wording("Modules", "Configuration", (p) =>
		translate("mlog.done.module_configured", { id: p.id }),
	),
};

/** Section for unknown methods, by prefix (modules add theirs). */
const SECTIONS: Record<string, string> = {
	autostart: "Autostart",
	modules: "Modules",
};

/** Canonical label (section / action) → i18n key. Labels are English constants so log
 *  entries keep stable, filterable values; the UI localizes them at display time. */
const LABEL_KEYS: Record<string, string> = {
	// sections
	Autostart: "ui.autostart",
	Settings: "mlog.section.settings",
	Service: "mlog.section.service",
	Connection: "mlog.section.connection",
	Device: "mgmt.th.device",
	Setup: "mlog.section.setup",
	Unknown: "mlog.section.unknown",
	Modules: "mlog.section.modules",
	// actions
	Start: "ui.start",
	Stop: "ui.stop",
	Reload: "ui.reload",
	Enable: "ui.enable",
	Disable: "ui.disable",
	Connect: "ui.connect",
	Disconnect: "ui.disconnect",
	Reset: "ui.reset",
	Reconfigure: "ui.reconfigure",
	Load: "mlog.action.load",
	Configuration: "mlog.action.configuration",
	Create: "mlog.action.create",
	Delete: "mlog.action.delete",
	Activate: "mlog.action.activate",
	Update: "mlog.action.update",
};

/** Log wording a module contributes (both registries call this at load). */
export interface LogWording {
	/** Methods that change something (recorded in the event log). */
	methods?: Record<string, MethodLog>;
	/** Read-only methods that still need wording for browser-side failures. */
	reads?: Record<string, MethodLog>;
	/** Method prefix → section, for methods without explicit wording. */
	sections?: Record<string, string>;
	/** Canonical label → i18n key. */
	labels?: Record<string, string>;
}

const READ_LOG: Record<string, MethodLog> = {};

export function registerLogWording(w: LogWording): void {
	Object.assign(METHOD_LOG, w.methods);
	Object.assign(READ_LOG, w.reads);
	Object.assign(SECTIONS, w.sections);
	Object.assign(LABEL_KEYS, w.labels);
}

/** Whether the device records this method in its event log. */
export const isLoggedMethod = (method: string): boolean =>
	Object.hasOwn(METHOD_LOG, method);

/**
 * Log wording for an API method. `done` self-resolves the current language. On
 * failure the caller renders the localized "<action> failed: <reason>" (mlog.failed).
 */
export function methodLog(method: string): MethodLog {
	const own = (table: Record<string, MethodLog>) =>
		Object.hasOwn(table, method) ? table[method] : undefined;
	return (
		own(METHOD_LOG) ??
		own(READ_LOG) ??
		wording(SECTIONS[method.split(".")[0]] ?? method, method, () =>
			translate("mlog.done.generic", { method }),
		)
	);
}

/** Localize a canonical log section/action label for display (unknown labels pass through). */
export function label(name: string): string {
	const key = LABEL_KEYS[name];
	return key ? translate(key) : name;
}
