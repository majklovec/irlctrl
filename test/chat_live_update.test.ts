import { beforeAll, describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import type m from "mithril";

type ChatModule = typeof import("../server/modules/chat/frontend");

let chat: ChatModule;
let chatFeed: (w: { id: string; config: Record<string, string> }, showEmpty?: boolean) => m.Children;
let mithril: typeof import("mithril");
let getRoot: () => HTMLElement;

beforeAll(async () => {
	const { Window } = await import("happy-dom");
	const win = new Window();
	const g = globalThis as Record<string, unknown>;
	// Wire the happy-dom window up as the global DOM before Mithril loads so its
	// real DOM path (mount, diff, requestAnimationFrame) runs.
	g.window = win;
	g.document = win.document;
	g.navigator = win.navigator;
	g.HTMLElement = win.HTMLElement;
	g.Element = win.Element;
	g.Node = win.Node;
	g.requestAnimationFrame = win.requestAnimationFrame;
	g.cancelAnimationFrame = win.cancelAnimationFrame;

	const i18nStub =
		"export const currentLanguage = () => 'en'; export const t = (k) => k; export const i18nReady = Promise.resolve();";
	const compStub = "export const Badge = {};";

	const result = await Bun.build({
		entrypoints: [new URL("../server/modules/chat/frontend.tsx", import.meta.url).pathname],
		target: "browser",
		format: "cjs",
		external: ["mithril"],
		loader: { ".css": "text" },
		plugins: [
			{
				name: "chat-browser-shell",
				setup(b: { onLoad(o: { filter: RegExp }, cb: () => { contents: string; loader: string }): void }) {
					b.onLoad({ filter: /shared\/ui\/i18n\.tsx$/ }, () => ({ contents: i18nStub, loader: "js" }));
					b.onLoad({ filter: /shared\/ui\/components\/index\.tsx$/ }, () => ({ contents: compStub, loader: "js" }));
				},
			},
		],
	});
	if (!result.success) throw new AggregateError(result.logs, "Chat test bundle failed");

	const require = createRequire(import.meta.url);
	const mod = { exports: {} };
	new Function(
		"module",
		"exports",
		"require",
		"window",
		"document",
		await result.outputs[0].text(),
	)(mod, mod.exports, require, win, win.document);
	chat = (mod.exports as { default: ChatModule }).default;
	chatFeed = (mod.exports as { chatFeed: typeof chatFeed }).chatFeed;
	mithril = require("mithril") as typeof mithril;
	getRoot = () => {
		const el = win.document.createElement("div");
		win.document.body.appendChild(el);
		return el;
	};
});

/** Mount the exact root component the standalone overlay page (`overlay.tsx`)
 * mounts — `chatFeed(widget)` behind a nullable `state` — and return handles to
 * drive it the way the overlay's websocket handler does. */
function mountOverlayRoot() {
	const root = getRoot();
	let state: { widget: { id: string; config: Record<string, string> } } | undefined;
	let setState: (widget: { id: string; config: Record<string, string> }) => void;

	mithril.mount(root, {
		view: () => state ? chatFeed(state.widget, false) : null,
	});

	setState = (widget) => {
		state = { widget };
		mithril.redraw();
	};

	const pushFrame = (event: string, data: unknown) => {
		chat.onFrame?.(event, data);
		mithril.redraw();
	};

	const flush = () => new Promise((r) => setTimeout(r, 40));
	const lines = () => root.querySelectorAll(".chat-line").length;

	return { root, setState, pushFrame, flush, lines };
}

describe("chat overlay live update (headless DOM)", () => {
	test("a live *.chat frame appears without a page refresh", async () => {
		const { setState, pushFrame, flush, lines } = mountOverlayRoot();

		// The snapshot seeds state, like the `chat.overlay.snapshot` frame does.
		setState({ id: "chat", config: { twitch: "alice" } });
		chat.onFrame?.("widget.snapshot", {
			chat: {
				"twitch:alice": {
					connected: true,
					messages: [{ id: "1", username: "A", text: "hi", ts: 1 }],
				},
			},
		});
		mithril.redraw();
		await flush();
		expect(lines()).toBe(1);

		// A live frame arrives; the overlay calls onFrame + m.redraw().
		pushFrame("twitch.chat", {
			channel: "alice",
			message: { id: "2", username: "B", text: "there", ts: 2 },
		});
		await flush();
		expect(lines()).toBe(2);

		pushFrame("twitch.chat", {
			channel: "alice",
			message: { id: "3", username: "C", text: "again", ts: 3 },
		});
		await flush();
		expect(lines()).toBe(3);
	});

	test("frames for a channel the widget does not display are ignored by the feed", async () => {
		const { setState, pushFrame, flush, lines } = mountOverlayRoot();
		setState({ id: "chat", config: { twitch: "alice" } });
		chat.onFrame?.("widget.snapshot", {
			chat: { "twitch:alice": { connected: true, messages: [{ id: "1", username: "A", text: "hi" }] } },
		});
		mithril.redraw();
		await flush();
		expect(lines()).toBe(1);

		// A different channel's frame is folded into `live`, but the widget only
		// shows its configured channel, so the feed is unchanged.
		pushFrame("kick.chat", { channel: "nobody", message: { id: "x", username: "Z", text: "nope" } });
		await flush();
		expect(lines()).toBe(1);
	});

	test("kick badges render before the username from the payload", async () => {
		const { root, setState, pushFrame, flush } = mountOverlayRoot();
		setState({ id: "chat", config: { kick: "live" } });
		chat.onFrame?.("widget.snapshot", {
			chat: { "kick:live": { connected: true, messages: [] } },
		});
		mithril.redraw();
		await flush();

		pushFrame("kick.chat", {
			channel: "live",
			message: {
				id: "10",
				username: "Tom",
				text: "hello",
				ts: 10,
				badges: [
					{
						type: "subscriber",
						text: "Subscriber",
						count: 3,
						url: "https://files.kick.com/channel_subscriber_badges/3/conversion/original-fullsize.png",
					},
					{ type: "moderator", text: "Moderator" },
				],
			},
		});
		pushFrame("kick.chat", {
			channel: "live",
			message: {
				id: "11",
				username: "Jane",
				text: "yo",
				ts: 11,
				badges: [{ type: "vip", text: "VIP", url: "https://files.kick.com/badge.png" }],
			},
		});
		await flush();

		// Both lines carry a badge group, rendered before the username.
		const lines = root.querySelectorAll(".chat-line");
		const withBadges = [...lines].filter((l) => l.querySelector(".chat-badges")).length;
		expect(withBadges).toBe(2);

		// Badges render as images (Kick's art), not text chips. The moderator
		// has no url so it is skipped; the subscriber and the vip render as
		// <img>.
		const imgBadges = [...root.querySelectorAll(".chat-badge")];
		expect(imgBadges.length).toBe(2);
		expect(imgBadges.every((el) => el.tagName === "IMG")).toBe(true);
		expect(
			imgBadges.some((el) =>
				el.getAttribute("src")?.startsWith(
					"https://files.kick.com/channel_subscriber_badges/",
				),
			),
		).toBe(true);
		// No text chip badges are emitted.
		expect(root.querySelector(".chat-badge--chip")).toBeNull();
	});
});
