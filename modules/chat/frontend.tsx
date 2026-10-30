/** @jsx m */
// Chat frontend — dashboard widget for the chat channel module.
// Self-contained: owns its per-channel live map, fed by dashboard websocket
// frames it cares about; the core only forwards frames through onFrame().

import m from "mithril";
import { Badge } from "../../frontend/ts/components/ui";
import { currentLanguage, t } from "../../frontend/ts/i18n";
import type {
	ChannelWidgetModule,
	WidgetContext,
} from "../../frontend/ts/module-contracts";
import type { ServerDashboardWidget } from "../../shared/types";
import {
	CHAT_CONFIG_FIELDS,
	CHAT_PLATFORMS,
	bannedMessagesFromConfig,
	chatOrderFromConfig,
	chatPlatformIconsFromConfig,
	chatTimestampsFromConfig,
	chatTtsConfig,
	chatTtsShouldSpeak,
	historyLengthFromConfig,
	platformChannel,
} from "./config";
import { decorateText } from "./text";
import {
	banSpeech,
	enqueueSpeech,
	ensureVoices,
	initTts,
	isReady,
	setRate,
	speechVoices,
	stopSpeech,
	voiceName,
} from "./tts";
import {
	CHAT_BANNED_TYPE,
	type ChannelLive,
	type ChatLive,
	type ChatPlatform,
} from "./types";
import "./styles.css";

/** Live chat buffer size per channel; matches the backend rolling buffer. */
const CAP = 500;

/** Distance from the bottom at which auto-scroll re-engages. */
const DISTANCE_THRESHOLD = 50;

// ── Czech TTS: widget config cache and status (module-scoped) ─────────────
// `onFrame` carries no widget, so the latest config is cached from `body()`
// (once per render). TTS state itself is global in `tts.ts` — one queue and
// one voice shared across every chat widget on the dashboard.
let cachedConfig: Record<string, string> | undefined;
let ttsEnabled = false;
let ttsReady = false;

/** Wire the speech queue to the current widget's config (per render). */
function ttsSync(w: ServerDashboardWidget): void {
	const cfg = chatTtsConfig(w.config);
	cachedConfig = w.config;
	if (cfg.enabled !== ttsEnabled) {
		ttsEnabled = cfg.enabled;
		// TTS was switched off — silence the queue and the in-flight speech.
		if (!ttsEnabled) stopSpeech();
	} else if (ttsEnabled) {
		setRate(cfg.rate);
		// The voice list arrives async; refresh the status flag once it is.
		initTts(cfg.voice).then(() => {
			ttsReady = isReady();
			m.redraw();
		});
		ttsReady = isReady();
	}
}

/** The browser's full voice list for the `ttsVoice` select — voices of the
 * current UI language first, then the rest (browser order preserved inside
 * each group). Empty while the list is still loading. */
function ttsVoiceOptions(): string[] {
	const lang = currentLanguage();
	const base = (l: string): string => l.split(/[-_]/)[0].toLowerCase();
	const all = speechVoices();
	return [
		...all.filter((v) => base(v.lang) === lang),
		...all.filter((v) => base(v.lang) !== lang),
	].map((v) => v.name);
}

type ChatSpec = { platform: ChatPlatform; spec: string };
type FeedWidget = Pick<ServerDashboardWidget, "id" | "config">;
type MergedLine = {
	line: ChatLive;
	key: string;
	platform: ChatPlatform;
	/** The line was removed by moderation (struck-through per config). */
	banned: boolean;
};

/** One `<platform>:<channel>` spec for each configured platform channel. */
function chatSpecsOf(w: Pick<FeedWidget, "config">): ChatSpec[] {
	const out: ChatSpec[] = [];

	for (const platform of CHAT_PLATFORMS) {
		const channel = platformChannel(platform, w.config);
		if (channel) out.push({ platform, spec: `${platform}:${channel}` });
	}

	return out;
}

/** Live data accumulated from dashboard websocket frames. */
const live = new Map<string, ChannelLive>();

const liveFor = (spec: string): ChannelLive => {
	let channel = live.get(spec);

	if (!channel) {
		channel = { chat: [] };
		live.set(spec, channel);
	}

	return channel;
};

type ChatFrame =
	| { channel?: string; message: ChatLive }
	| { channel?: string; reconnect: boolean; messages: ChatLive[] }
	| { channel?: string; banned: { ids: (string | number)[] } }
	| { channel?: string; disconnected: boolean };

const CHAT_EVENTS = new Set([
	"youtube.chat",
	"twitch.chat",
	"tiktok.chat",
	"kick.chat",
]);

/** Fold chat-related dashboard websocket frames into live state. */
function onFrame(event: string, data: unknown): void {
	if (event === "widget.snapshot") {
		const snapshot = data as {
			chat?: Record<string, { connected?: boolean; messages?: ChatLive[] }>;
		};

		for (const [spec, channel] of Object.entries(snapshot.chat ?? {})) {
			const target = liveFor(spec);
			target.connected = channel.connected;
			target.chat = (channel.messages ?? []).slice(0, CAP);
		}

		return;
	}

	if (!CHAT_EVENTS.has(event)) return;

	const frame = data as ChatFrame;
	if (!frame.channel) return;

	// The event is platform-tagged; the channel itself is not.
	const platform = event.slice(0, event.indexOf("."));
	const target = liveFor(`${platform}:${frame.channel}`);

	if ("message" in frame) {
		target.chat = [frame.message, ...(target.chat ?? [])].slice(0, CAP);

		// Read the new message out loud (the batch snapshot frames don't). The
		// speech id is namespaced per platform so a ban can cancel the exact
		// message even when platform id spaces overlap.
		if (
			cachedConfig &&
			chatTtsShouldSpeak(frame.message, chatTtsConfig(cachedConfig))
		) {
			const username = (frame.message.username ?? "").trim();
			const text = (frame.message.text ?? "").trim();
			enqueueSpeech(
				`${platform}:${frame.message.id}`,
				username ? `${username} říká: ${text}` : text,
			);
		}
	} else if ("banned" in frame) {
		// A message was removed by moderation: flag it in the live buffer and
		// stop its in-flight (or queued) TTS immediately.
		const banned = new Set(frame.banned.ids.map((id) => `${platform}:${id}`));
		for (const line of target.chat ?? []) {
			if (banned.has(`${platform}:${line.id}`)) line.type = CHAT_BANNED_TYPE;
		}
		for (const id of frame.banned.ids) {
			banSpeech(`${platform}:${id}`);
		}
	} else if ("messages" in frame) {
		target.chat = frame.messages.slice(0, CAP);
		target.connected = true;
	} else if ("disconnected" in frame) {
		target.connected = false;
	}
}

/** Merge configured channels, newest first by timestamp, and cap history.
 * Banned lines are dropped when the widget is set to `hide`, kept (flagged)
 * when set to `strike`. */
function mergedLines(
	w: Pick<FeedWidget, "config">,
	specs: ChatSpec[],
): MergedLine[] {
	const hideBanned = bannedMessagesFromConfig(w.config) === "hide";
	const all: MergedLine[] = [];

	for (const { platform, spec } of specs) {
		for (const line of live.get(spec)?.chat ?? []) {
			const banned = line.type === CHAT_BANNED_TYPE;
			if (banned && hideBanned) continue;
			all.push({
				line,
				key: `${platform}:${line.id}`,
				platform,
				banned,
			});
		}
	}

	all.sort((a, b) => (b.line.ts ?? 0) - (a.line.ts ?? 0));

	const visible = historyLengthFromConfig(w.config);
	const cut = all.slice(0, Math.max(1, visible));

	// "bottom" means oldest first and newest at the bottom.
	if (chatOrderFromConfig(w.config) === "bottom") cut.reverse();

	return cut;
}

/** Inline platform SVGs, shown only when multiple platforms are merged. */
const PLATFORM_ICONS: Record<ChatPlatform, string> = {
	twitch: `<svg viewBox="0 0 256 268" aria-hidden="true"><path fill="#9146ff" d="M17.46 0L0 46.56v185.21h63.14V268h46.87l36.49-36.23h54.91L256 177.68V0H17.46zm23.07 23.07H232.9v143.14l-41.47 41.47h-69.15L85.79 244.2v-36.52H40.53V23.07zm69.15 104.55h23.07V69.26h-23.07v58.36zm63.14 0h23.07V69.26h-23.07v58.36z"/></svg>`,
	youtube: `<svg viewBox="0 0 576 512" aria-hidden="true"><path fill="#ff0000" d="M549.66 124.63a68.28 68.28 0 0 0-48.05-48.28C458.78 64 288 64 288 64S117.22 64 74.39 76.35a68.28 68.28 0 0 0-48.05 48.28C14.48 167.83 14.48 256 14.48 256s0 88.17 11.86 131.37a68.28 68.28 0 0 0 48.05 48.28C117.22 448 288 448 288 448s170.78 0 213.61-12.35a68.28 68.28 0 0 0 48.05-48.28C561.52 344 561.52 256 561.52 256s0-88.17-11.86-131.37zM232.15 337.28V174.72L374.86 256l-142.71 81.28z"/></svg>`,
	kick: `<svg viewBox="0 0 24 24" aria-hidden="true"><g fill="#53fc18"><rect x="3.5" y="2" width="5" height="20" rx="1.2"/><polygon points="9,12 21,2.5 21,8.5 11.5,15.5"/><polygon points="9,12 21,21.5 21,15.5 11.5,8.5"/></g></svg>`,
	tiktok: `<svg viewBox="0 0 448 512" aria-hidden="true"><path fill="#eef4ff" d="M448,209.91a210.06,210.06,0,0,1-122.77-39.25V349.38A162.55,162.55,0,1,1,185,188.31V278.2a74.62,74.62,0,1,0,52.23,71.18V0l88,0a121.18,121.18,0,0,0,1.86,22.17h0A122.18,122.18,0,0,0,381,102.39a121.43,121.43,0,0,0,67,20.14Z"/></svg>`,
};

function toCurrentColor(svg: string): string {
	return svg.replace(/fill="[^"]+"/g, 'fill="currentColor"');
}

/** The same platform glyphs recolored to `currentColor` for status badges. */
const PLATFORM_STATUS_ICONS: Record<ChatPlatform, string> = {
	twitch: toCurrentColor(PLATFORM_ICONS.twitch),
	youtube: toCurrentColor(PLATFORM_ICONS.youtube),
	kick: toCurrentColor(PLATFORM_ICONS.kick),
	tiktok: toCurrentColor(PLATFORM_ICONS.tiktok),
};

/** Status badge: one icon per configured platform, green when its channel is
 * connected, red while disconnected. */
function badge(w: ServerDashboardWidget, _ctx: WidgetContext): m.Vnode {
	const specs = chatSpecsOf(w);
	const dashboard = /^\/dashboards\/(?:view|edit)\/([^/]+)\/?$/.exec(location.pathname);
	const overlayUrl = dashboard && w.config?.token
		? `/chat/${dashboard[1]}/${encodeURIComponent(w.id)}?token=${encodeURIComponent(w.config.token)}`
		: undefined;

	if (!specs.length) {
		return <Badge text={t("dash.widget_not_configured")} kind="warn" />;
	}

	return (
		<span class="chat-status">
			{overlayUrl && (
				<a class="chat-status-icon" href={overlayUrl} target="_blank" rel="noopener noreferrer" title={t("chat.overlay")} aria-label={t("chat.overlay")}>
					<span class="sr-only">{t("chat.overlay")}</span>
					<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
						<path d="M12,24C5.383,24,0,18.617,0,12S5.383,0,12,0s12,5.383,12,12S18.617,24,12,24z M12,1.109 C5.995,1.109,1.11,5.995,1.11,12C1.11,18.005,5.995,22.89,12,22.89S22.89,18.005,22.89,12C22.89,5.995,18.005,1.109,12,1.109z M6.182,5.99c0.352-1.698,1.503-3.229,3.05-3.996c-0.269,0.273-0.595,0.483-0.844,0.78c-1.02,1.1-1.48,2.692-1.199,4.156 c0.355,2.235,2.455,4.06,4.732,4.028c1.765,0.079,3.485-0.937,4.348-2.468c1.848,0.063,3.645,1.017,4.7,2.548 c0.54,0.799,0.962,1.736,0.991,2.711c-0.342-1.295-1.202-2.446-2.375-3.095c-1.135-0.639-2.529-0.802-3.772-0.425 c-1.56,0.448-2.849,1.723-3.293,3.293c-0.377,1.25-0.216,2.628,0.377,3.772c-0.825,1.429-2.315,2.449-3.932,2.756 c-1.244,0.261-2.551,0.059-3.709-0.464c1.036,0.302,2.161,0.355,3.191-0.011c1.381-0.457,2.522-1.567,3.024-2.935 c0.556-1.49,0.345-3.261-0.591-4.54c-0.7-1.007-1.803-1.717-3.002-1.969c-0.38-0.068-0.764-0.098-1.148-0.134 c-0.611-1.231-0.834-2.66-0.528-3.996L6.182,5.99z" />
					</svg>
				</a>
			)}
			{specs.map(({ platform, spec }) => {
				const connected = live.get(spec)?.connected === true;
				return (
					<span
						class={`chat-status-icon ${connected ? "on" : "off"}`}
						key={platform}
						title={`${platform} · ${connected ? t("dev.badge.online") : t("dev.badge.offline")}`}
					>
						{m.trust(PLATFORM_STATUS_ICONS[platform])}
					</span>
				);
			})}

			{/* 🔇 TTS off · 🔊 on (dimmed until the Czech voice is ready) */}
			<span
				class={`chat-status-icon chat-tts ${ttsReady ? "on" : "off"}`}
				title={
					ttsEnabled
						? ttsReady
							? `${t("chat.tts.on")} · ${voiceName()}`
							: t("chat.tts.waiting")
						: t("chat.tts.off")
				}
			>
				{ttsEnabled ? "🔊" : "🔇"}
			</span>
		</span>
	);
}

// ── Emote URL upgrader (adapted from robdiesalot main-PJhqqCv3.js) ─────

/**
 * Upgrade an emote image URL to its highest available resolution.
 * Handles 7TV, BetterTTV, FrankerFaceZ, Twitch, Kick, and YouTube CDNs.
 * Non-matching URLs pass through unchanged.
 */
function upgradeEmoteUrl(raw: string): string {
	const url = raw;

	// 7TV:  .../emote/{id}/{1-4}x.ext  →  4x.ext
	if (url.startsWith("https://cdn.7tv.app/")) {
		return url.replace(/\/[1-4]x(\.\w+)$/, "/4x$1");
	}

	// BetterTTV:  .../emote/{id}/{1-3}x.ext  →  3x.ext
	if (url.startsWith("https://cdn.betterttv.net/")) {
		return url.replace(/\/[1-3]x(\.\w+)?$/, "/3x$1");
	}

	// FrankerFaceZ:  .../emote/{id}/{1,2,4}  →  4
	if (url.startsWith("https://cdn.frankerfacez.com/")) {
		return url.replace(/\/(?:1|2|4)$/, "/4");
	}

	// Twitch:  .../emoticons/v2/{id}/{type}/{theme}/{1-3}.0  →  3.0
	if (url.startsWith("https://static-cdn.jtvnw.net/")) {
		return url.replace(/\/(?:1|2|3)\.0$/, "/3.0");
	}

	// YouTube:  yt3.ggpht.com images use =s{size} suffixes; =s0 is max.
	if (
		url.startsWith("https://yt3.ggpht.com/") ||
		url.startsWith("https://lh3.googleusercontent.com/")
	) {
		return url.replace(/=s\d+(-[a-z-]+)?$/, "=s0$1");
	}

	// Kick already serves fullsize in our constructed URLs; nothing to do.
	return url;
}

// ── YouTube global emoji shortcodes → Unicode ─────────────────────────
// YouTube's live-chat API sometimes surfaces global emojis as `:name:`
// shortcodes rather than inline images. Map the common ones to their
// Unicode equivalents so they render natively without a CDN lookup.

const YOUTUBE_EMOJI: Record<string, string> = {
	smile: "😄",
	heart: "❤️",
	fire: "🔥",
	"100": "💯",
	tada: "🎉",
	cry: "😢",
	laughing: "😆",
	wink: "😉",
	sunglasses: "😎",
	thinking: "🤔",
	thumbsup: "👍",
	thumbsdown: "👎",
	pray: "🙏",
	clap: "👏",
	eyes: "👀",
	rocket: "🚀",
	star: "⭐",
	check: "✅",
	x: "❌",
	warning: "⚠️",
	heart_eyes: "😍",
	joy: "😂",
	sob: "😭",
	angry: "😠",
	cool: "😎",
	sad: "😔",
	wow: "😮",
	party: "🥳",
	hug: "🤗",
	kiss: "😘",
	blush: "😊",
	stuck_out_tongue: "😛",
	zipper_mouth: "🤐",
	neutral_face: "😐",
	smirk: "😏",
	heartbeat: "💓",
	sparkles: "✨",
	boom: "💥",
	muscle: "💪",
	ok_hand: "👌",
	v: "✌️",
	raised_hands: "🙌",
	crown: "👑",
	gem: "💎",
	gift: "🎁",
	trophy: "🏆",
	medal: "🏅",
	camera: "📷",
	video_camera: "📹",
	microphone: "🎤",
	headphones: "🎧",
	guitar: "🎸",
	game: "🎮",
	dice: "🎲",
	soccer: "⚽",
	basketball: "🏀",
	football: "🏈",
	baseball: "⚾",
	tennis: "🎾",
	"8ball": "🎱",
	bowling: "🎳",
};

// ── Segment parser ────────────────────────────────────────────────────

type ChatSegment =
	| { kind: "text"; value: string }
	| { kind: "emote"; id: string; name: string; url?: string }
	| { kind: "emoji"; name: string; value: string };

/**
 * Combined segment regex:
 *   1. Kick:      [emote:<id>:<name>]
 *   2. YouTube:   :<shortcode>:            (only known emojis)
 *   3. Image URL: direct https link to a known emote CDN
 */
const SEGMENT_RE =
	/\[emote:(\d+):([^\]]*)\]|:([a-zA-Z0-9_+-]{1,40}):|(https?:\/\/(?:cdn\.7tv\.app|cdn\.betterttv\.net|cdn\.frankerfacez\.com|static-cdn\.jtvnw\.net|yt3\.ggpht\.com|lh3\.googleusercontent\.com|files\.kick\.com)\/[^\s<>"']+)/g;

function parseSegments(text: string): ChatSegment[] {
	const out: ChatSegment[] = [];
	let last = 0;

	for (const match of text.matchAll(SEGMENT_RE)) {
		const index = match.index ?? 0;
		let segment: ChatSegment;

		// ── Kick inline emote: [emote:id:name] ──
		if (match[1] !== undefined) {
			segment = {
				kind: "emote",
				id: `kick:${match[1]}`,
				name: match[2].trim(),
				url: `https://files.kick.com/emotes/${match[1]}/fullsize`,
			};
		} else if (match[3] !== undefined) {
			// ── YouTube shortcode: :name: ──
			const name = match[3];
			const emoji = YOUTUBE_EMOJI[name];

			// Only treat as an emote if the name is a known emoji; otherwise
			// leave the colons in the surrounding text.
			if (!emoji) continue;
			segment = { kind: "emoji", name, value: emoji };
		} else if (match[4] !== undefined) {
			// ── Direct image URL from a known emote CDN ──
			const url = match[4];
			segment = {
				kind: "emote",
				id: url,
				name: url.split("/").pop() ?? "emote",
				url,
			};
		} else {
			continue;
		}

		if (index > last)
			out.push({ kind: "text", value: text.slice(last, index) });
		out.push(segment);
		last = index + match[0].length;
	}

	if (last < text.length) {
		out.push({ kind: "text", value: text.slice(last) });
	}

	return out;
}

// Failed emotes are rendered as plain names instead of broken images.
const failedEmotes = new Set<string>();

/** Render formatted text and inline emotes using JSX. */
function lineSegments(text: string): m.Children {
	return parseSegments(text).map((segment, index) => {
		if (segment.kind === "text") {
			return <span key={index}>{m.trust(decorateText(segment.value))}</span>;
		}

		if (segment.kind === "emoji") {
			return (
				<span class="chat-emoji" key={index} title={`:${segment.name}:`}>
					{segment.value}
				</span>
			);
		}

		// ── emote image ──
		if (failedEmotes.has(segment.id)) {
			return (
				<span class="chat-emote-name" key={index}>
					{segment.name}
				</span>
			);
		}

		const rawUrl =
			segment.url ?? `https://files.kick.com/emotes/${segment.id}/fullsize`;
		const src = upgradeEmoteUrl(rawUrl);

		return (
			<img
				class="chat-emote"
				key={index}
				src={src}
				alt={segment.name}
				loading="lazy"
				onerror={() => {
					failedEmotes.add(segment.id);
					m.redraw();
				}}
			/>
		);
	});
}

/**
 * Reusable feed component.
 *
 * In bottom mode:
 * - follows new messages while the user is at the bottom;
 * - pauses when the user scrolls up;
 * - resumes when the user returns to the bottom.
 *
 * In top mode it does not force scrolling.
 */
const chatAutoScroll = new WeakMap<HTMLElement, boolean>();

/** A message's arrival time (HH:MM:SS, locale-aware) or "" when the platform
 * didn't provide one. The formatter is cached per language. */
let timestampFormatter: (ts: number) => string;
let timestampFormatterLang: string | undefined;

function formatTimestamp(ts: number): string {
	if (!Number.isFinite(ts) || ts <= 0) return "";
	const lang = currentLanguage();

	if (timestampFormatterLang !== lang) {
		timestampFormatter = new Intl.DateTimeFormat(lang, {
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
			hour12: false,
		});
		timestampFormatterLang = lang;
	}

	return timestampFormatter.format(ts);
}

type ChatFeedAttrs = {
	lines: MergedLine[];
	bottom: boolean;
	showPlatformIcons: boolean;
	/** Show each line's arrival time next to it. */
	showTimestamps: boolean;
	feedKey: string;
};

const ChatFeed: m.Component<ChatFeedAttrs> = {
	oncreate(vnode) {
		const el = vnode.dom as HTMLElement;

		// Start by following the bottom of the feed.
		chatAutoScroll.set(el, true);

		if (vnode.attrs.bottom) {
			requestAnimationFrame(() => {
				if (el.isConnected) {
					el.scrollTop = el.scrollHeight;
				}
			});
		}
	},

	onupdate(vnode) {
		const el = vnode.dom as HTMLElement;

		if (!vnode.attrs.bottom || !chatAutoScroll.get(el)) {
			return;
		}

		requestAnimationFrame(() => {
			if (el.isConnected && chatAutoScroll.get(el)) {
				el.scrollTop = el.scrollHeight;
			}
		});
	},

	onremove(vnode) {
		chatAutoScroll.delete(vnode.dom as HTMLElement);
	},

	view(vnode) {
		const { lines, showPlatformIcons, showTimestamps, feedKey } = vnode.attrs;

		return (
			<div
				class="chat-feed"
				key={feedKey}
				onscroll={(event: Event) => {
					const el = event.currentTarget as HTMLElement;

					const distance = el.scrollHeight - el.clientHeight - el.scrollTop;

					// Re-enable auto-scroll only when the user reaches the bottom
					// threshold. Scrolling up disables it.
					chatAutoScroll.set(el, distance <= DISTANCE_THRESHOLD);
				}}
			>
				{lines.map(({ line, key, platform, banned }) => (
					<div
						class={banned ? "chat-line chat-line-banned" : "chat-line"}
						key={key}
					>
						{showPlatformIcons && (
							<span class="chat-icon" title={platform}>
								{m.trust(PLATFORM_ICONS[platform])}
							</span>
						)}

						{showTimestamps && line.ts != null && (
							<span class="chat-time" title={new Date(line.ts).toISOString()}>
								{formatTimestamp(line.ts)}
							</span>
						)}

						{line.username && (
							<span
								class="chat-user"
								style={line.color ? `color:${line.color}` : undefined}
							>
								{line.username}
							</span>
						)}

						<span class="chat-text">{lineSegments(line.text ?? "")}</span>
					</div>
				))}
			</div>
		);
	},
};

// Stop the speech when the page is closed (the queue is global, so one
// listener per chat widget is not needed).
window.addEventListener("beforeunload", stopSpeech);

/** The merged feed for every configured platform channel. */
function body(w: ServerDashboardWidget, _ctx: WidgetContext): m.Children {
	ttsSync(w);
	return chatFeed(w);
}

/** Shared rendering without dashboard chrome or TTS side effects. */
export function chatFeed(w: FeedWidget, showEmpty = true): m.Children {
	const specs = chatSpecsOf(w);

	if (!specs.length) {
		return showEmpty ? <p class="muted">{t("dash.widget_not_configured")}</p> : null;
	}

	const lines = mergedLines(w, specs);

	if (!lines.length) {
		return showEmpty ? <p class="muted">{t("chat.empty")}</p> : null;
	}

	const showPlatformIcons = chatPlatformIconsFromConfig(w.config, specs.length);
	const bottom = chatOrderFromConfig(w.config) === "bottom";
	const showTimestamps = chatTimestampsFromConfig(w.config);
	const feedKey = `chat-feed:${specs.map((spec) => spec.spec).join(",")}`;

	return m(ChatFeed, {
		key: feedKey,
		feedKey,
		lines,
		bottom,
		showPlatformIcons,
		showTimestamps,
	});
}

const chatModule: ChannelWidgetModule<ServerDashboardWidget> = {
	id: "chat",
	kind: "widget",
	widgetTypes: ["chat"],
	defaultSize: { w: 3, h: 8 },
	configFields: CHAT_CONFIG_FIELDS,
	/** `ttsVoice` is a dynamic select — the browser's voices, UI language first. */
	configSelectOptions(name: string): string[] | undefined {
		if (name !== "ttsVoice") return undefined;
		// The list loads async; refresh the open config form once it arrives.
		ensureVoices().then(() => m.redraw());
		return ttsVoiceOptions();
	},
	body,
	badge,
	onFrame,
};

export default chatModule;
