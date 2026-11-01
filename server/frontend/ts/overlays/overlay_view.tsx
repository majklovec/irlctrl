/** @jsx m */
/*
 * OBS Browser Source runtime page (loaded at /overlay/:slug?token=…).
 * Fully transparent, no chrome, no console noise (handoff §7.3, §15).
 * - one project token in the URL query; a bad token just renders an empty page
 * - initial state + live updates over WS /overlay/:slug/ws
 * - on disconnect: hold last-known state, reconnect with exponential backoff
 * - a revalued variable fires the alerts that listen for its name; once the
 *   alert's duration has run, the page clears the variable (same token
 *   endpoint, no value) so a stream of repeats reads as a single trigger
 */
import m from "mithril";
import type {
	Asset,
	Canvas,
	OverlayElement,
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
	overlayElementView,
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

/** variable id -> the last non-empty value we fired a trigger for; a later
 * frame with the SAME value is a re-delivery (or the alert's own clear
 * round-trip), not a new trigger */
const triggeredVariables = new Map<string, VariableValue>();

let ws: WebSocket | undefined;
let delay = 1000;

/** Empty a variable through the token endpoint (empty value = clear), so
 * an alert re-fires on the next (non-empty) revaluation, not while its
 * own clear frame is round-tripping. */
function clearVariable(name: string): void {
	void fetch(
		"/overlay/variables?token=" +
			encodeURIComponent(token) +
			"&" +
			encodeURIComponent(name) +
			"=",
		{ method: "GET" },
	).catch(() => {});
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
		case "overlays.variables": {
			if (Array.isArray(data.variables)) {
				const next = data.variables as Variable[];
				const previous = new Map(
					state.variables.map((v) => [v.name, v.value]),
				);
				state.variables = next;
				// A revalued variable is a trigger: fire every alert that
				// listens for the variable's name — but empty values are
				// never triggers (they are how a finished alert empties
				// its variable), and a frame repeating the LAST fired
				// value is a re-delivery, not a new trigger.
				for (const v of next) {
					if (v.value === "") continue;
					const previousValue =
						previous.get(v.name) ?? triggeredVariables.get(v.id);
					if (previousValue === v.value) continue;
					triggeredVariables.set(v.id, v.value);
					fireVariableTrigger(v);
				}
			}
			break;
		}
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

/** End a trigger-driven element's life: play the outro window, then remove
 * it from the page. Re-firing restarts the whole cycle. When the element's
 * trigger variable is known, the variable is emptied at expiry — the alert
 * re-fires on the next non-empty revaluation, so a burst of equal values
 * reads as one trigger, not a self-clearing loop. */
function scheduleTriggerLifecycle(
	elementId: string,
	duration: number,
	variableName?: string,
): void {
	const [outroId, removeId] = triggerTimers.get(elementId) ?? [0, 0];
	clearTimeout(outroId);
	clearTimeout(removeId);
	const timers: [ReturnType<typeof setTimeout>, ReturnType<typeof setTimeout>] =
		[
			setTimeout(() => m.redraw(), duration - TRIGGER_OUTRO_MS),
			setTimeout(() => {
				state.activeTriggers.delete(elementId);
				triggerTimers.delete(elementId);
				if (variableName) clearVariable(variableName);
				m.redraw();
			}, duration),
		];
	triggerTimers.set(elementId, timers);
}

/** A revalued variable fires its alerts: the variable's name is the trigger
 * name, the new value the payload (a numeric value also surfaces as
 * `amount`, which variation/TTS thresholds compare against). */
function fireVariableTrigger(v: Variable): void {
	const payload: Record<string, unknown> = { value: v.value };
	if (v.value !== "") {
		const n = Number(v.value);
		if (Number.isFinite(n)) payload.amount = n;
	}
	handleTrigger(v.name, v.name, payload);
}

/** Route a trigger to every trigger-driven element in the scene. An element
 * claims the trigger (returns a duration) only when its configured event
 * name matches — and, for variation alerts, when the amount condition
 * holds. `variableName` (the revalued variable) is emptied when the claim
 * expires, so the next trigger starts from an empty value. */
function handleTrigger(
	eventName: string,
	variableName: string | undefined,
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
		const now = Date.now();
		state.activeTriggers.set(element.id, {
			startedAt: now,
			expiresAt: now + duration,
			payload,
		});
		scheduleTriggerLifecycle(element.id, duration, variableName);
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
