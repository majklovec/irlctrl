/** @jsx m */

import { i18nReady, t } from "@ui/i18n";
import m from "mithril";
import { APP_VERSION } from "../../../shared/app_version";
import { chatSpecsFromConfig } from "./config";
import chatModule, { chatFeed } from "./frontend";
import type { ChatOverlayState } from "./types";
import "./overlay.css";

const root = document.getElementById("app");
if (!root) throw new Error("Missing chat overlay root");

const token = new URLSearchParams(location.search).get("token") ?? "";
const endpoint = `/api${location.pathname}`;
let state: ChatOverlayState | undefined;
let error = false;
let stopped = false;
let attempt = 0;
let timer: ReturnType<typeof setTimeout>;
let socket: WebSocket | undefined;
/** This widget's channel specs; the hub stream carries every channel, so the
 * snapshot's config decides which live frames are relevant to this overlay. */
let specs = new Set<string>();
let reloading = false;

/**
 * A new deployment replaced the server while this page was open (a restart
 * drops the connection, so the fresh snapshot on reconnect carries the new
 * build's version). Ask a registered service worker to update so its cache
 * storage drops the previous bundle, then reload: the page is served
 * `no-store` and the bundles are content-hashed, so the reload loads the new
 * version from scratch.
 */
function reloadOnNewVersion(version: string): void {
	if (reloading || version === APP_VERSION) return;
	reloading = true;
	console.info(
		`[chat overlay] new server version v${version} (this page runs v${APP_VERSION}), reloading`,
	);
	navigator.serviceWorker
		?.getRegistration()
		.then((reg) => reg?.update())
		.catch(() => {});
	location.reload();
}

/**
 * The overlay's socket: same origin as the page, ws(s) scheme, token in the
 * query string — the browser WebSocket API cannot set the Authorization
 * header, and the server accepts the token via `?token=` on the upgrade.
 */
function socketUrl(): string {
	const url = new URL(`${endpoint}/ws`, location.origin);
	url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
	url.searchParams.set("token", token);
	return url.toString();
}

function connect(): void {
	if (stopped) return;
	const current = new WebSocket(socketUrl());
	socket = current;

	current.onopen = () => {
		attempt = 0;
	};

	current.onmessage = (event) => {
		let frame: { type?: string; event?: string; data?: unknown };
		try {
			frame = JSON.parse(String(event.data)) as typeof frame;
		} catch {
			return;
		}
		if (frame.type !== "event" || !frame.event) return;
		if (frame.event === "chat.overlay.snapshot") {
			const snap = frame.data as ChatOverlayState;
			if (typeof snap.version === "string") reloadOnNewVersion(snap.version);
			state = snap;
			specs = new Set(
				chatSpecsFromConfig(snap.widget.config).filter(
					(s): s is string => s !== null,
				),
			);
			chatModule.onFrame?.("widget.snapshot", { chat: snap.chat });
			error = false;
			m.redraw();
			return;
		}
		// The hub stream carries every channel — keep only this widget's.
		if (!frame.event.endsWith(".chat")) return;
		const channel = (frame.data as { channel?: unknown } | null)?.channel;
		if (typeof channel !== "string") return;
		const dot = frame.event.indexOf(".");
		if (!specs.has(`${frame.event.slice(0, dot)}:${channel.toLowerCase()}`))
			return;
		chatModule.onFrame?.(frame.event, frame.data);
		m.redraw();
	};

	current.onclose = (event) => {
		socket = undefined;
		if (stopped) return;
		if (event.code === 1008) {
			// The token was rotated, removed, or the widget is gone —
			// reconnecting can never succeed.
			stopped = true;
			state = undefined;
			error = true;
			m.redraw();
			return;
		}
		state = undefined;
		error = true;
		m.redraw();
		const delay = Math.min(1_000 * 2 ** attempt, 15_000);
		attempt += 1;
		console.warn(
			`[chat overlay] connection closed (${event.code}), retrying in ${delay} ms`,
		);
		timer = setTimeout(connect, delay);
	};
}

window.addEventListener("pagehide", () => {
	stopped = true;
	clearTimeout(timer);
	socket?.close();
});

await i18nReady;
m.mount(root, {
	view: () =>
		error
			? m("p.chat-overlay-error", { role: "alert" }, t("chat.overlay_error"))
			: state
				? chatFeed(state.widget, false)
				: null,
});
connect();
