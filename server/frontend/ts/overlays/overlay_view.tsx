/** @jsx m */
/*
 * OBS Browser Source runtime page (loaded at /overlay/:id?token=…).
 * Fully transparent, no chrome, no console noise (handoff §7.3, §15).
 * - one project token in the URL query; a bad token just renders an empty page
 * - initial state + live updates over WS /overlay/:id/ws
 * - when the snapshot's server version differs from this bundle's, reload
 *   (a new deployment replaced the server while the page was open)
 * - on disconnect: hold last-known state, reconnect with exponential backoff
 * - an `overlays.alert` frame shows every alert element whose event matches
 *   the frame's name; an element already showing an alert queues the new
 *   one FIFO and starts it when the current one expires
 * - a trigger's `?<name>=<value>` pairs ride in the frame's payload and
 *   are written into the project variables only when that alert goes on
 *   air (never while it waits in the queue), then persisted via the
 *   `overlays.applyAlert` WS uplink — so a queued alert's values never
 *   clobber the on-air ones early, and the written values persist
 */

import {
	type ElementContext,
	TRIGGER_OUTRO_MS,
	type TriggerState,
} from "@ui/overlay/element";
import { elementDef } from "@ui/overlay/registry";
import m from "mithril";
import { APP_VERSION } from "../../../../shared/app_version";
import type {
	Asset,
	Canvas,
	Overlay,
	OverlayElement,
	Variable,
	VariableValue,
} from "../../../../shared/overlay";
import { assetUrl, sceneElementsView } from "./overlay_render";
import "../../css/overlay.css";

interface RuntimeState {
	overlay: Overlay | undefined;
	canvas: Canvas;
	variables: Variable[];
	assets: Asset[];
	/** active trigger state per trigger-driven element id (intro/show/outro) */
	activeTriggers: Map<string, TriggerState>;
}

interface FeedMessage {
	event?: string;
	data?: unknown;
}

const root = document.getElementById("app");
if (!root) throw new Error("Missing overlay root");

const token = new URLSearchParams(location.search).get("token") ?? "";
const overlayId = location.pathname.split("/").filter(Boolean).pop() ?? "";
const wsBase =
	(location.protocol === "https:" ? "wss://" : "ws://") + location.host;
const wsUrl =
	wsBase + "/overlay/" + encodeURIComponent(overlayId) + "/ws?token=" + token;

const state: RuntimeState = {
	overlay: undefined,
	canvas: { width: 1920, height: 1080 },
	variables: [],
	assets: [],
	activeTriggers: new Map(),
};

/** element id -> timers keeping its trigger lifecycle (outro + removal) */
const triggerTimers = new Map<
	string,
	[ReturnType<typeof setTimeout>, ReturnType<typeof setTimeout>]
>();

/** an alert claim: the element that wants it, when it was claimed, and
 * the values that must go on air with it */
interface PendingAlert {
	element: OverlayElement;
	eventName: string;
	payload: Record<string, unknown>;
}

/** element id -> FIFO of pending alerts (the element is showing an earlier
 * one); drained when the element's current trigger expires. Values are
 * applied only when the alert plays, so queued alerts never clobber the
 * on-air values early */
const alertQueues = new Map<string, PendingAlert[]>();

let ws: WebSocket | undefined;
let delay = 1000;
let reloading = false;

/**
 * A new deployment replaced the server while this page was open (a restart
 * drops the socket, so the fresh snapshot on reconnect carries the new
 * build's version). Ask a registered service worker to update so its cache
 * storage drops the previous bundle, then reload: the page is served
 * `no-store` and the bundles are content-hashed, so the reload loads the
 * new version from scratch.
 */
/** Ask a registered service worker to drop its stale cache, then reload: the
 * page is served `no-store` and the bundles are content-hashed, so the reload
 * loads the fresh content from scratch. */
function reloadPage(reason: string): void {
	if (reloading) return;
	reloading = true;
	console.info(`[overlay] ${reason}, reloading`);
	navigator.serviceWorker
		?.getRegistration()
		.then((reg) => reg?.update())
		.catch(() => {});
	location.reload();
}

function reloadOnNewVersion(version: string): void {
	if (version === APP_VERSION) return;
	reloadPage(
		`new server version v${version} (this page runs v${APP_VERSION})`,
	);
}

function variableMap(): Map<string, Variable["value"]> {
	return new Map(state.variables.map((v) => [v.id, v.value]));
}

function variableNamesMap(): Map<string, VariableValue> {
	return new Map(state.variables.map((v) => [v.name, v.value]));
}

function assetMap(): Map<string, string> {
	return new Map(state.assets.map((a) => [a.id, assetUrl(a)]));
}

function applySnapshot(data: Record<string, unknown>): void {
	const overlay = data.overlay as Overlay | null | undefined;
	if (overlay) {
		state.overlay = overlay;
		if (overlay.canvas) state.canvas = overlay.canvas;
		if (Array.isArray(overlay.variables)) state.variables = overlay.variables;
		if (Array.isArray(overlay.assets)) state.assets = overlay.assets;
	}
	m.redraw();
}

/** A full `overlays.overlay` frame (element/canvas/variable change): apply the
 * whole overlay, dropping a stale push (lower rev) that lags a fresher one. */
function applyOverlayFrame(overlay: Overlay): void {
	const local = state.overlay;
	if (
		local &&
		typeof local.rev === "number" &&
		typeof overlay.rev === "number" &&
		overlay.rev < local.rev
	)
		return;
	applySnapshot({ overlay });
}

function handleMessage(raw: MessageEvent, first: { open: boolean }): void {
	let message: FeedMessage;
	try {
		message = JSON.parse(String(raw.data)) as FeedMessage;
	} catch {
		return;
	}
	if (!message.event || typeof message.data !== "object") return;
	const data = message.data as Record<string, unknown>;
	switch (message.event) {
		case "overlays.snapshot": {
			const version = data.version;
			if (typeof version === "string") reloadOnNewVersion(version);
			applySnapshot(data);
			first.open = true;
			break;
		}
		case "overlays.overlay": {
			const overlay = data.overlay as Overlay | null | undefined;
			if (overlay) applyOverlayFrame(overlay);
			break;
		}
		case "overlays.variables":
			// values only render into templates/`amount`; triggering is the
			// dedicated `overlays.alert` frame
			if (Array.isArray(data.variables))
				state.variables = data.variables as Variable[];
			break;
		case "overlays.alert":
			// fired by GET /overlay/alert/<name>: show every alert element
			// whose event matches <name>, queueing per element
			handleTrigger(
				String(data.name ?? ""),
				(data.payload ?? {}) as Record<string, unknown>,
			);
			break;
		case "overlays.assets":
			if (Array.isArray(data.assets)) state.assets = data.assets;
			break;
		case "overlays.canvas":
			if (data.canvas) state.canvas = data.canvas as Canvas;
			break;
		default:
			return;
	}
	m.redraw();
}

/** Element render context carrying assets, variables, live trigger state, and
 * the overlay's token + id (a self-contained chat element uses both to open
 * its token-scoped feed). */
function runtimeCtx(): ElementContext {
	return {
		assetUrls: assetMap(),
		variables: variableMap(),
		variableNames: variableNamesMap(),
		activeTriggers: state.activeTriggers,
		token,
		overlayId,
	};
}

/** Mark a playing trigger: active until its duration runs out, with the
 * outro window fading it. */
function activateTrigger(
	elementId: string,
	payload: Record<string, unknown>,
	duration: number,
): void {
	const now = Date.now();
	state.activeTriggers.set(elementId, {
		startedAt: now,
		expiresAt: now + duration,
		payload,
	});
	scheduleTriggerLifecycle(elementId, duration);
}

/** Show a claimed trigger: apply its values to the project variables
 * first (they were validated by the trigger endpoint, so the names exist
 * here), then let the element decide (event match + variation condition
 * + side effects) with the live values in place. Returns `false` when the
 * element declines the claim. */
function playAlert(
	element: OverlayElement,
	eventName: string,
	payload: Record<string, unknown>,
): boolean {
	for (const [name, value] of Object.entries(payload)) {
		const variable = state.variables.find((v) => v.name === name);
		if (variable) variable.value = value as VariableValue;
	}
	const duration = elementDef(element.type)?.onTrigger?.(
		element,
		eventName,
		payload,
		runtimeCtx(),
	);
	if (duration === undefined || !Number.isFinite(duration) || duration <= 0)
		return false;
	activateTrigger(element.id, payload, duration);
	// persist the on-air values (best-effort: the alert plays even if the
	// socket is momentarily down)
	if (Object.keys(payload).length > 0 && ws?.readyState === WebSocket.OPEN)
		ws.send(
			JSON.stringify({
				type: "event",
				event: "overlays.applyAlert",
				data: { values: payload },
			}),
		);
	return true;
}

/** Run the per-element trigger lifecycle: outro window, then removal —
 * and the FIFO drain of queued claims for this element (a claim whose
 * condition fails at play time is dropped and the queue continues). */
function scheduleTriggerLifecycle(elementId: string, duration: number): void {
	const [outroId, removeId] = triggerTimers.get(elementId) ?? [0, 0];
	clearTimeout(outroId);
	clearTimeout(removeId);
	const timers: [ReturnType<typeof setTimeout>, ReturnType<typeof setTimeout>] =
		[
			setTimeout(() => m.redraw(), duration - TRIGGER_OUTRO_MS),
			setTimeout(() => {
				state.activeTriggers.delete(elementId);
				triggerTimers.delete(elementId);
				const queue = alertQueues.get(elementId);
				if (queue && queue.length > 0) {
					while (queue.length > 0) {
						const [next, ...rest] = queue;
						if (rest.length > 0) alertQueues.set(elementId, rest);
						else alertQueues.delete(elementId);
						if (playAlert(next.element, next.eventName, next.payload)) break;
					}
				}
				m.redraw();
			}, duration),
		];
	triggerTimers.set(elementId, timers);
}

/** Route an `overlays.alert` frame to every trigger-driven element in the
 * scene. A claim plays immediately (values applied, `onTrigger` evaluated
 * with the live values) when the element is free, and is queued FIFO with
 * its values when the element is still showing an earlier alert — the
 * queued values only land at play time, and the written values persist
 * via the `overlays.applyAlert` uplink (nothing is cleared here). */
function handleTrigger(
	eventName: string,
	payload: Record<string, unknown>,
): void {
	const overlay = state.overlay;
	if (!overlay || !eventName) return;
	for (const element of overlay.elements) {
		if (!elementDef(element.type)?.onTrigger) continue;
		if (state.activeTriggers.has(element.id)) {
			// the element is showing an earlier alert: queue the claim
			// with its values; they apply at play time
			const queue = alertQueues.get(element.id) ?? [];
			queue.push({ element, eventName, payload });
			alertQueues.set(element.id, queue);
			continue;
		}
		playAlert(element, eventName, payload);
	}
}

function connect(): void {
	const first = { open: false };
	ws = new WebSocket(wsUrl);
	ws.onopen = () => {
		delay = 1000;
	};
	ws.onmessage = (raw) => handleMessage(raw, first);
	ws.onclose = () => {
		ws = undefined;
		// invalid token: the server closes with 1008 and we stay blank
		// (a bad token never gets past the first open)
		setTimeout(() => connect(), delay);
		delay = Math.min(delay * 2, 30_000);
	};
}

m.mount(root, {
	view: () => {
		const overlay = state.overlay;
		if (!overlay) return null; // blank (transparent) until the first frame
		const ctx = runtimeCtx();
		const elements = sceneElementsView(overlay.elements, ctx);
		return m(
			".overlay-canvas",
			{
				style: {
					width: `${state.canvas.width}px`,
					height: `${state.canvas.height}px`,
				},
			},
			elements,
		);
	},
});

connect();
