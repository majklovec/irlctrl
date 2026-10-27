/* Shared device status, event, and RPC plumbing. Card state is per connection:
 * the device page runs the global `card` below, while dashboards create a host
 * for each viewer websocket. Module-owned form state stays in each module. */
import m from "mithril";
import { type LogEvent, label, methodLog } from "../../../shared/logMessages";
import { errorMessage } from "../../../shared/util";
import type { DeviceInfo, ModulesView, Status } from "../../types";
import type { Level } from "../components/icons";
import { t } from "../i18n";
import { type Params, RpcClient, RpcError, socketUrl } from "../services/rpc";
import { setHeaderColor } from "../util";
import { applyLog, log } from "./log";

// Status pushes are debounced; keep a finished action's button disabled until the new state
// arrives (or this long, if the action changed nothing) so it does not flicker back on
const AWAIT_STATUS_MS = 2_000;

/** Shared per-connection state; module events remain opaque to the store. */
export interface CardState {
	status: Status | null;
	events: Map<string, { data: unknown; at: number }>;
}

/** Generic RPC and live-event host shared by device module cards. */
export interface DeviceCard {
	st: CardState;
	/** Keys of requests in flight (buttons, toggles) — their controls are disabled meanwhile. */
	busy: Set<string>;
	pending: (id: string) => boolean;
	act: <T = unknown>(
		key: string | null,
		method: string,
		params?: Params,
	) => Promise<T | undefined>;
	press: (id: string, method: string, params?: Params) => void;
	applyStatus: (status: Status) => void;
	/** Retain and dispatch one opaque module event for this connection. */
	handleEvent: (event: string, data: unknown) => void;
	clearEvents: () => void;
	provideCapability: <T>(name: string, capability: T) => void;
	getCapability: <T>(name: string) => T | undefined;
}

/**
 * Build a card bound to one device connection. `logFn` receives the browser log
 * entries for failed requests (the page log on the device page; a no-op on the
 * dashboards page, where failures are not device log entries).
 */
export function createCardHost(opts: {
	rpc: RpcClient;
	logFn?: (level: Level, section: string, message: string) => void;
}): DeviceCard {
	const { rpc, logFn } = opts;
	const st: CardState = {
		status: null,
		events: new Map(),
	};
	const busy = new Set<string>();
	const awaiting = new Set<string>();
	const capabilities = new Map<string, unknown>();
	let host: DeviceCard;

	const pending = (id: string): boolean => busy.has(id) || awaiting.has(id);

	/** Run a method; logs failures the device did not. While it runs, `busy` holds `key`. */
	async function act<T = unknown>(
		key: string | null,
		method: string,
		params?: Params,
	): Promise<T | undefined> {
		if (key) {
			if (pending(key)) return undefined;
			busy.add(key);
			m.redraw();
		}
		try {
			const result = await rpc.call<T>(method, params);
			if (key) {
				awaiting.add(key);
				setTimeout(() => {
					awaiting.delete(key);
					m.redraw();
				}, AWAIT_STATUS_MS);
			}
			return result;
		} catch (err) {
			if (logFn && !(err instanceof RpcError && err.logged)) {
				const { section, action } = methodLog(method);
				logFn(
					"error",
					section,
					t("mlog.failed", {
						action: label(action),
						reason: errorMessage(err),
					}),
				);
			}
			return undefined;
		} finally {
			if (key) busy.delete(key);
			m.redraw();
		}
	}

	/** Run a UI action unless the same action is already in flight. */
	const press = (id: string, method: string, params?: Params): void => {
		if (!pending(id)) void act(id, method, params);
	};

	const applyStatus = (status: Status): void => {
		if (!status?.state) return;
		st.status = status;
		awaiting.clear();
		m.redraw();
		dispatchFrontendEvent("status", status, host);
	};

	const handleEvent = (event: string, data: unknown): void => {
		st.events.set(event, { data, at: Date.now() });
		dispatchFrontendEvent(event, data, host);
		m.redraw();
	};

	const clearEvents = (): void => {
		st.events.clear();
		m.redraw();
	};
	const provideCapability = <T>(name: string, capability: T): void => {
		capabilities.set(name, capability);
	};
	const getCapability = <T>(name: string): T | undefined =>
		capabilities.get(name) as T | undefined;

	host = {
		st,
		busy,
		pending,
		act,
		press,
		applyStatus,
		handleEvent,
		clearEvents,
		provideCapability,
		getCapability,
	};
	return host;
}

// ----------------------------------------------------------------------
// The global card: the device page's single instance
// ----------------------------------------------------------------------
// relative to the page, works at / and at /d/<id>/
// Built without auto-connect: dashboards create their own card hosts and must
// not open a socket to the device page's connection.
// the page entry (app.ts) calls connectDevice().
const rpc = new RpcClient(() => socketUrl("ws"), false);

/** Open the device websocket (idempotent). */
export const connectDevice = (): void => rpc.ensureConnected();

/** The device page's card, bound to the page's device connection. */
export const card: DeviceCard = createCardHost({ rpc, logFn: log });

/** Page-level state around the card: socket state, device info, the module settings view. */
export const st = Object.assign(card.st, {
	socketOpen: false,
	connectionLost: false,
	/** Set only when served by the control server for a remote device. */
	device: null as DeviceInfo | null,
	autostartBusy: false,
	// Module system: persisted settings + live module state
	modules: {} as ModulesView,
});

export const act = card.act;

// Frontend event dispatch is injected by the module registry instead of
// imported from it: store.ts is reached by every module frontend (store →
// registry → frontend → store), so a direct import creates a cycle that the
// bundler can resolve with a null module namespace. Setting the sink is the
// registry's first act; events arriving before it are dropped.
let frontendEventSink:
	| ((event: string, data: unknown, host?: DeviceCard) => void)
	| null = null;

/** Injected by the module registry at module-evaluation time. */
export const setFrontendEventSink = (
	sink: (event: string, data: unknown, host?: DeviceCard) => void,
): void => {
	frontendEventSink = sink;
};

/** Route one push to the dispatcher the registry registered. */
const dispatchFrontendEvent = (
	event: string,
	data: unknown,
	host?: DeviceCard,
): void => frontendEventSink?.(event, data, host);

async function loadAppearance(): Promise<void> {
	const result = await rpc
		.call<{ settings: { color: string } }>("settings.get")
		.catch(() => null);
	if (result) setHeaderColor(result.settings.color);
}

// ----------------------------------------------------------------------
// Server pushes
// ----------------------------------------------------------------------
rpc.on("open", () => {
	st.socketOpen = true;
	card.handleEvent("open", undefined);
	void loadAppearance();
	if (st.connectionLost) log("info", label("Connection"), t("dev.reconnected"));
	st.connectionLost = false;
	m.redraw();
});
rpc.on("close", () => {
	// Only once per outage, not on every reconnect attempt
	if (st.socketOpen) {
		st.connectionLost = true;
		log("warn", label("Connection"), t("dev.lost_reconnecting"));
	}
	st.socketOpen = false;
	card.clearEvents();
	m.redraw();
});
rpc.on("status", (data) => {
	const status = data as Status;
	card.applyStatus(status);
	st.modules = status.modules ?? st.modules;
	m.redraw();
});
rpc.on("device", (data) => {
	const info = data as DeviceInfo;
	st.device = info;
	document.title = `${info.hostname || info.id} ${t("ui.title_suffix")}`;
	if (!info.online) card.clearEvents();
	m.redraw();
});
rpc.on("log", (data) => applyLog(data as LogEvent));
rpc.onAny((event, data) => {
	if (event !== "status" && event !== "open" && event !== "close")
		card.handleEvent(event, data);
});
