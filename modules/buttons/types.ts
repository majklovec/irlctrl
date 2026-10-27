/*
 * Buttons widget — a virtual StreamDeck on the dashboard. One widget drives
 * any number of devices: every button names its device and one of that
 * device's module actions. The layout is stored under the `buttons` config
 * field as JSON (the dashboard API keeps widget configs as string records);
 * these are the shapes the server-side validation (backend.ts) and the
 * widget (frontend.tsx) share.
 */
import type { DashboardActionEntry } from "../../shared/types";

export type { DashboardActionEntry };

/** One configured button: a device, an action of its catalogue, optional overrides. */
export interface ButtonConfig {
	/** The device the action fires on. */
	deviceId: string;
	/** `<module>.<action>` — `DashboardActionEntry.key`. */
	actionId: string;
	labelOverride?: string;
	iconOverride?: string;
	/** Merged over the action's default params (`paramsOverride` wins). */
	paramsOverride?: Record<string, unknown>;
}

/** The name of the widget's single (hidden) config field. */
export const BUTTONS_FIELD = "buttons";

export const BUTTONS_WIDGET_TYPE = "buttons";
// Grid units are 60 px rows on a 12-column grid: 4×4 fits two rows of keys.
export const BUTTONS_DEFAULT_SIZE = { w: 4, h: 4 } as const;
export const BUTTONS_MIN_SIZE = { w: 2, h: 2 } as const;
export const BUTTONS_MAX_SIZE = { w: 12, h: 8 } as const;
export const BUTTONS_MAX = 32;

const BUTTON_FIELDS = new Set([
	"deviceId",
	"actionId",
	"labelOverride",
	"iconOverride",
	"paramsOverride",
]);

const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Parse the stored `buttons` config field. An empty string is an empty
 * layout; anything else must be a JSON array of well-formed entries. Throws
 * an Error naming the problem (the server turns it into a 400).
 */
export function parseButtons(raw: string | undefined): ButtonConfig[] {
	const text = (raw ?? "").trim();
	if (text === "") return [];
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new Error("buttons must be a JSON array");
	}
	if (!Array.isArray(value)) throw new Error("buttons must be a JSON array");
	if (value.length > BUTTONS_MAX)
		throw new Error(`buttons: at most ${BUTTONS_MAX} buttons`);
	return value.map((item, i) => {
		if (!isRecord(item) || typeof item.deviceId !== "string" || !item.deviceId)
			throw new Error(`buttons[${i}]: deviceId is required`);
		if (typeof item.actionId !== "string" || !item.actionId)
			throw new Error(`buttons[${i}]: actionId is required`);
		const out: ButtonConfig = { deviceId: item.deviceId, actionId: item.actionId };
		for (const key of ["labelOverride", "iconOverride"] as const) {
			const v = item[key];
			if (v === undefined || v === "") continue;
			if (typeof v !== "string")
				throw new Error(`buttons[${i}]: ${key} must be a string`);
			out[key] = v;
		}
		if (item.paramsOverride !== undefined) {
			if (!isRecord(item.paramsOverride))
				throw new Error(`buttons[${i}]: paramsOverride must be an object`);
			if (Object.keys(item.paramsOverride).length > 0)
				out.paramsOverride = item.paramsOverride;
		}
		for (const key of Object.keys(item))
			if (!BUTTON_FIELDS.has(key))
				throw new Error(`buttons[${i}]: unknown field ${key}`);
		return out;
	});
}

export const serializeButtons = (buttons: readonly ButtonConfig[]): string =>
	buttons.length ? JSON.stringify(buttons) : "";

/** The params a press sends: the action's defaults under the button's override. */
export const mergedParams = (
	action: DashboardActionEntry,
	button: ButtonConfig,
): Record<string, unknown> => ({
	...(action.params ?? {}),
	...(button.paramsOverride ?? {}),
});

/** The devices a layout refers to (each once). */
export const buttonDevices = (buttons: readonly ButtonConfig[]): string[] => [
	...new Set(buttons.map((b) => b.deviceId)),
];

/** Buttons whose action is missing from their device's catalogue (module
 * disabled / removed). A device without a known catalogue is skipped. */
export const orphanedButtons = (
	buttons: readonly ButtonConfig[],
	catalogue: (deviceId: string) => readonly DashboardActionEntry[] | undefined,
): ButtonConfig[] =>
	buttons.filter((b) => {
		const actions = catalogue(b.deviceId);
		return actions !== undefined && !actions.some((a) => a.key === b.actionId);
	});
