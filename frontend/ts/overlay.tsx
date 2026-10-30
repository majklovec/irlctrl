/** @jsx m */
/*
 * OBS Browser Source runtime page (loaded at /overlay/:slug?token=…).
 * Fully transparent, no chrome, no console noise (handoff §7.3, §15).
 * - one project token in the URL query; a bad token just renders an empty page
 * - initial state + live updates over WS /overlay/:slug/ws
 * - on disconnect: hold last-known state, reconnect with exponential backoff
 */
import m from "mithril";
import type {
	Asset,
	Canvas,
	OverlayElement,
	Scene,
	Variable,
} from "../../shared/overlay";
import {
	assetUrl,
	overlayElementView,
	sceneElementsView,
} from "./overlay-render";
import "../css/overlay.css";

interface RuntimeState {
	scene: Scene | undefined;
	canvas: Canvas;
	variables: Variable[];
	assets: Asset[];
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
};

let ws: WebSocket | undefined;
let delay = 1000;

function variableMap(): Map<string, Variable["value"]> {
	return new Map(state.variables.map((v) => [v.id, v.value]));
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
			if (Array.isArray(data.variables)) state.variables = data.variables;
			break;
		case "overlays.assets":
			if (Array.isArray(data.assets)) state.assets = data.assets;
			break;
		case "overlays.canvas":
			if (data.canvas) state.canvas = data.canvas as Canvas;
			break;
		case "overlays.trigger":
			// v1: triggers are delivered for forward compatibility
			break;
		default:
			return;
	}
	m.redraw();
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
		const ctx = {
			assetUrls: assetMap(),
			variables: variableMap(),
		};
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
