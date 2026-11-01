/** @jsx m */
/*
 * OBS Browser Source runtime page (loaded at /overlay/:slug?token=…).
 * Fully transparent, no chrome, no console noise (handoff §7.3, §15).
 * - one project token in the URL query; a bad token just renders an empty page
 * - initial state + live updates over WS /overlay/:slug/ws
 * - on disconnect: hold last-known state, reconnect with exponential backoff
 * - an `overlays.alert` frame shows every alert element whose event matches
 *   the frame's name; an element already showing an alert queues the new
 *   one FIFO and starts it when the current one expires (variables set by
 *   the trigger endpoint persist — they are never cleared here)
 */
import m from "mithril";
import type {
	Asset,
	Canvas,
	Scene,
	Variable,
	VariableValue,
} from "../../../../shared/overlay";
import {
	type ElementContext,
	TRIGGER_OUTRO_MS,
	type TriggerState,
} from "../../../../shared/ui/overlay/element";
import { elementDef } from "../../../../shared/ui/overlay/registry";
import {
	assetUrl,
	sceneElementsView,
} from "./overlay_render";
import "../../css/overlay.css";

interface RuntimeState {
	scene: Scene | undefined;
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
const slug = location.pathname.split("/").filter(Boolean).pop() ?? "";
const wsBase =
	(location.protocol === "https:" ? "wss://" : "ws://") + location.host;
const wsUrl =
	wsBase + "/overlay/" + encodeURIComponent(slug) + "/ws?token=" + token;

const state: RuntimeState = {
	scene: undefined,
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

/** element id -> FIFO of pending alerts (the element is showing an earlier
 * one); drained when the element's current trigger expires */
const alertQueues = new Map<
	string,
	{ eventName: string; payload: Record<string, unknown> }[]
>();

let ws: WebSocket | undefined;
let delay = 1000;

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
	const scene = data.scene as Scene | null | undefined;
	if (scene) state.scene = scene;
	if (Array.isArray(data.variables)) state.variables = data.variables;
	const canvas = data.canvas as Canvas | undefined;
	if (canvas) state.canvas = canvas;
	if (Array.isArray(data.assets)) state.assets = data.assets;
	m.redraw();
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
		case "overlays.snapshot":
			applySnapshot(data);
			first.open = true;
			break;
		case "overlays.scene": {
			const scene = data.scene as Scene | null | undefined;
			if (scene && scene.id === state.scene?.id) state.scene = scene;
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

/** Element render context carrying assets, variables and live trigger state. */
function runtimeCtx(): ElementContext {
	return {
		assetUrls: assetMap(),
		variables: variableMap(),
		variableNames: variableNamesMap(),
		activeTriggers: state.activeTriggers,
	};
}

/** Show a claimed trigger: active until its duration runs out, with the
 * outro window fading it. When an alert was queued for this element (it
 * was already showing one), the next one starts right at expiry. */
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
					const [next, ...rest] = queue;
					if (rest.length > 0)
						alertQueues.set(elementId, rest);
					else alertQueues.delete(elementId);
					activateTrigger(elementId, next.payload, next.duration);
				}
				m.redraw();
			}, duration),
		];
	triggerTimers.set(elementId, timers);
}

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

/** Route an `overlays.alert` frame to every trigger-driven element in the
 * scene. An element claims the trigger (returns a duration) only when its
 * configured event name matches — and, for variation alerts, when the
 * amount condition holds. Claims on an element that is still showing an
 * earlier alert are queued FIFO and start at that alert's expiry (the
 * values the trigger endpoint set persist; nothing is cleared here). */
function handleTrigger(
	eventName: string,
	payload: Record<string, unknown>,
): void {
	const scene = state.scene;
	if (!scene || !eventName) return;
	const ctx = runtimeCtx();
	for (const element of scene.elements) {
		const def = elementDef(element.type);
		if (!def?.onTrigger) continue;
		const duration = def.onTrigger(element, eventName, payload, ctx);
		if (duration === undefined || !Number.isFinite(duration) || duration <= 0)
			continue;
		if (state.activeTriggers.has(element.id)) {
			// the element is showing an earlier alert: queue this claim
			const queue = alertQueues.get(element.id) ?? [];
			queue.push({ payload, duration });
			alertQueues.set(element.id, queue);
			continue;
		}
		activateTrigger(element.id, payload, duration);
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
		const scene = state.scene;
		if (!scene) return null; // blank (transparent) until the first frame
		const ctx = runtimeCtx();
		const elements = sceneElementsView(scene.elements, ctx);
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
