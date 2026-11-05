/** @jsx m */
/*
 * Shared live-chat connector for the chat-driven overlay widgets (emote wall,
 * emote combo, featured, viewer chat). It opens the overlay's token-scoped
 * chat WebSocket (`/api/overlay/chat/:id/ws?token=…` — the same feed the
 * `chat` element uses), keeps a rolling buffer of the messages for the
 * element's channels, and notifies on every new message.
 *
 * Deliberately self-contained: it consumes the server's chat API directly
 * rather than importing the dashboard chat module, so the overlay-elements
 * module keeps no cross-module dependency. The wire protocol is the
 * server's own (the `<platform>.chat` frames + `chat.overlay.snapshot`), so
 * there is nothing to keep in sync with a module.
 */

import type { Children } from "mithril";
import m from "mithril";

export const CHAT_PLATFORMS = ["youtube", "twitch", "tiktok", "kick"] as const;
export type ChatPlatform = (typeof CHAT_PLATFORMS)[number];

/** One platform channel a chat-driven widget can display. */
export interface ChatChannel {
	platform: ChatPlatform;
	channel: string;
}

/** A sender badge (platform artwork); `url` is effectively always present. */
export interface ChatBadge {
	type?: string;
	text?: string;
	count?: number;
	url?: string;
}

/** One chat message, as the server's chat providers emit it. */
export interface ChatMessage {
	id: string | number;
	username?: string;
	color?: string;
	text?: string;
	badges?: ChatBadge[];
	/** Message classification; `banned` marks a moderation-removed line. */
	type?: string;
	/** Message time (epoch ms) when the platform provides it. */
	ts?: number;
}

/** A buffered line: the message plus the channel it came from. */
export interface ChatLine {
	/** `<platform>:<channel>` — the hub spec key. */
	spec: string;
	platform: ChatPlatform;
	channel: string;
	msg: ChatMessage;
}

/** Rolling buffer size per widget; far less than the chat element's, these
 * widgets only look at the most recent lines. */
const CAP = 200;

const channelPart = (value: string | undefined): string =>
	(typeof value === "string" ? value : "").trim().toLowerCase();

/** Defensively coerce a stored `channels` prop to a clean list (keeps
 * in-progress rows with an empty handle so the editor round-trip works). */
export function normalizeChannels(raw: unknown): ChatChannel[] {
	if (!Array.isArray(raw)) return [];
	const out: ChatChannel[] = [];
	for (const item of raw) {
		if (typeof item !== "object" || item === null) continue;
		const platform = (item as { platform?: unknown }).platform;
		if (typeof platform !== "string") continue;
		if (!(CHAT_PLATFORMS as readonly string[]).includes(platform))
			continue;
		const channel = channelPart(
			(item as { channel?: unknown }).channel as string | undefined,
		);
		out.push({
			platform: platform as ChatPlatform,
			channel,
		});
	}
	return out;
}

/** The hub specs (`<platform>:<channel>`) for a channel list; empty rows
 * (an in-progress editor row) produce no spec. */
export function chatSpecs(channels: ChatChannel[]): string[] {
	return channels
		.filter((c) => c.channel)
		.map((c) => `${c.platform}:${c.channel}`);
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
	if (a.size !== b.size) return false;
	for (const v of a) if (!b.has(v)) return false;
	return true;
}

export interface LiveChatFeedAttrs {
	/** The OBS overlay's token ("" = not live, e.g. the editor's draft). */
	token: string;
	/** The overlay id (selects which overlay's channels stream). */
	overlayId: string;
	/** The channels to subscribe to (a normalized `ChatChannel[]`). */
	channels: ChatChannel[];
	/** Fired once per new message for one of the element's channels. Use it
	 * for imperative side effects (spawn a floating emote, bump a combo). */
	onMessage?: (line: ChatLine) => void;
	/** Reactive render of the element's content, re-run on each new message
	 * and when the connection (re)establishes. */
	render?: (state: { ready: boolean; lines: ChatLine[] }) => Children;
}

interface LiveChatFeedState {
	stopped: boolean;
	attempt: number;
	ready: boolean;
	specs: Set<string>;
	lines: ChatLine[];
	timer?: ReturnType<typeof setTimeout>;
	socket?: WebSocket;
}

/**
 * The live feed for one chat-driven element. Renders `render({ready, lines})`
 * (or an empty node) and feeds it from the scene-token WebSocket: a snapshot
 * seeds the buffer, then each hub frame is narrowed to the element's channel
 * specs. On close, 1008 is fatal (token gone); anything else retries with
 * exponential backoff.
 */
export const LiveChatFeed: m.Component<
	LiveChatFeedAttrs,
	LiveChatFeedState
> = {
	oninit(vnode) {
		// `state` is pre-initialized by mithril; mutate it, never reassign.
		vnode.state.stopped = false;
		vnode.state.attempt = 0;
		vnode.state.ready = false;
		vnode.state.lines = [];
		vnode.state.specs = new Set(chatSpecs(vnode.attrs.channels));
		connect(vnode);
	},
	onupdate(vnode) {
		// Channels added/removed in the inspector change the spec set; refresh
		// it and reconnect so the narrowed stream tracks the config.
		const wanted = new Set(chatSpecs(vnode.attrs.channels));
		if (!sameSet(vnode.state.specs, wanted)) {
			vnode.state.specs = wanted;
			// Drop the connection AND any pending retry: a retry that fires
			// after this reconnect would open a second socket (doubled
			// messages).
			clearTimeout(vnode.state.timer);
			vnode.state.timer = undefined;
			vnode.state.attempt = 0;
			const old = vnode.state.socket;
			vnode.state.socket = undefined;
			old?.close();
			connect(vnode);
		}
	},
	onremove(vnode) {
		vnode.state.stopped = true;
		clearTimeout(vnode.state.timer);
		vnode.state.socket?.close();
		vnode.state.socket = undefined;
	},
	view(vnode) {
		const s = vnode.state;
		if (!vnode.attrs.render) return m("div");
		return vnode.attrs.render({ ready: s.ready, lines: s.lines });
	},
};

/** Open the element's feed socket (see `LiveChatFeed`). Same origin, ws(s)
 * scheme, the scene token in the query string (the browser WebSocket API can't
 * set the Authorization header). */
function connect(vnode: m.Vnode<LiveChatFeedAttrs, LiveChatFeedState>): void {
	const s = vnode.state;
	if (s.stopped) return;
	const { token, overlayId } = vnode.attrs;
	if (!token || !overlayId) return;
	const url = new URL(
		`/api/overlay/chat/${encodeURIComponent(overlayId)}/ws`,
		location.origin,
	);
	url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
	url.searchParams.set("token", token);
	const socket = new WebSocket(url);
	s.socket = socket;

	// A replacement socket supersedes this one (channel change, retry): its
	// close/retry must never touch the connection that came after it.
	const isActive = (): boolean => s.socket === socket;

	socket.onopen = () => {
		if (!isActive()) return;
		s.attempt = 0;
	};

	socket.onmessage = (event) => {
		if (!isActive()) return;
		let frame: { type?: string; event?: string; data?: unknown };
		try {
			frame = JSON.parse(String(event.data)) as typeof frame;
		} catch {
			return;
		}
		if (frame.type !== "event" || !frame.event) return;
		if (frame.event === "chat.overlay.snapshot") {
			const snap = frame.data as {
				chat?: Record<string, { messages?: ChatMessage[] }>;
			};
			// Seed the buffer with the rolling history for our channels. The
			// server sends each channel's history NEWEST first; the widgets
			// read the tail of `lines` as "most recent", so sort oldest→newest.
			const seeded: ChatLine[] = [];
			for (const [spec, entry] of Object.entries(snap.chat ?? {})) {
				if (!s.specs.has(spec)) continue;
				const colon = spec.indexOf(":");
				const platform = spec.slice(0, colon).toLowerCase() as ChatPlatform;
				const channel = spec.slice(colon + 1).toLowerCase();
				for (const msg of entry.messages ?? [])
					seeded.push({ spec, platform, channel, msg });
			}
			seeded.sort((a, b) => (a.msg.ts ?? 0) - (b.msg.ts ?? 0));
			s.lines = seeded;
			s.ready = true;
			m.redraw();
			return;
		}
		// The hub stream carries every channel — keep only this element's.
		if (!frame.event.endsWith(".chat")) return;
		const data = frame.data as
			| {
					channel?: unknown;
					message?: ChatMessage;
					reconnect?: boolean;
					messages?: ChatMessage[];
			  }
			| null;
		if (!data) return;
		const channel =
			typeof data.channel === "string"
				? data.channel.toLowerCase()
				: "";
		if (!channel) return;
		const dot = frame.event.indexOf(".");
		const platform = frame.event.slice(0, dot).toLowerCase() as ChatPlatform;
		const spec = `${platform}:${channel}`;
		if (!s.specs.has(spec)) return;
		// `reconnect` re-sends rolling history; a plain frame carries one new
		// `message`.
		const fresh: ChatMessage[] = data.reconnect
			? data.messages ?? []
			: data.message
				? [data.message]
				: [];
		for (const msg of fresh) {
			const line: ChatLine = { spec, platform, channel, msg };
			s.lines.push(line);
			if (s.lines.length > CAP) s.lines = s.lines.slice(-CAP);
			vnode.attrs.onMessage?.(line);
		}
		m.redraw();
	};

	socket.onclose = (event) => {
		if (!isActive()) return;
		s.socket = undefined;
		if (s.stopped) return;
		if (event.code === 1008) {
			// The scene token was rotated/removed — reconnecting can't succeed.
			s.stopped = true;
			s.ready = false;
			m.redraw();
			return;
		}
		s.ready = false;
		m.redraw();
		const delay = Math.min(1_000 * 2 ** s.attempt, 15_000);
		s.attempt += 1;
		s.timer = setTimeout(() => connect(vnode), delay);
	};
}
