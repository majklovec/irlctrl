/** @jsx m */
/*
 * The full chat feed's rendering half for the `chat` overlay element: line
 * rendering (segments with inline emotes, sender badges, timestamps, platform
 * icons), the auto-scroll feed container, and the text decoration
 * (links, @mentions, DM dimming).
 *
 * Deliberately self-contained, like `live_chat_feed.tsx`: the chat DASHBOARD
 * WIDGET keeps its own copy of this machinery in the dashboards chat module;
 * the two share only the server's wire protocol, so nothing crosses a module
 * boundary.
 */

import { currentLanguage } from "@ui/i18n";
import type { Children } from "mithril";
import m from "mithril";
import type { ChatLine } from "./live_chat_feed";

/** `msg.type` value marking a message removed by the platform's moderation. */
export const CHAT_BANNED_TYPE = "banned" as const;

/** Distance from the bottom at which auto-scroll re-engages. */
const DISTANCE_THRESHOLD = 50;

/** A line ready to display: the buffered message plus its moderation flag. */
export interface FeedLine extends ChatLine {
	/** The line was removed by moderation (struck-through per the element). */
	banned: boolean;
}

// ── Inline platform SVGs (shown per line when the element enables icons) ──
// `width/height="1em"` are intrinsic: the editor page loads no element CSS,
// so an unsized SVG (viewBox only) would render at its default 300×150.
// The runtime's `overlay.css` sizes the same box to 1em — no visual change
// on the OBS page.

const PLATFORM_ICONS: Record<ChatLine["platform"], string> = {
	twitch: `<svg viewBox="0 0 256 268" width="1em" height="1em" aria-hidden="true"><path fill="#9146ff" d="M17.46 0L0 46.56v185.21h63.14V268h46.87l36.49-36.23h54.91L256 177.68V0H17.46zm23.07 23.07H232.9v143.14l-41.47 41.47h-69.15L85.79 244.2v-36.52H40.53V23.07zm69.15 104.55h23.07V69.26h-23.07v58.36zm63.14 0h23.07V69.26h-23.07v58.36z"/></svg>`,
	youtube: `<svg viewBox="0 0 576 512" width="1em" height="1em" aria-hidden="true"><path fill="#ff0000" d="M549.66 124.63a68.28 68.28 0 0 0-48.05-48.28C458.78 64 288 64 288 64S117.22 64 74.39 76.35a68.28 68.28 0 0 0-48.05 48.28C14.48 167.83 14.48 256 14.48 256s0 88.17 11.86 131.37a68.28 68.28 0 0 0 48.05 48.28C117.22 448 288 448 288 448s170.78 0 213.61-12.35a68.28 68.28 0 0 0 48.05-48.28C561.52 344 561.52 256 561.52 256s0-88.17-11.86-131.37zM232.15 337.28V174.72L374.86 256l-142.71 81.28z"/></svg>`,
	kick: `<svg viewBox="0 0 24 24" width="1em" height="1em" aria-hidden="true"><g fill="#53fc18"><rect x="3.5" y="2" width="5" height="20" rx="1.2"/><polygon points="9,12 21,2.5 21,8.5 11.5,15.5"/><polygon points="9,12 21,21.5 21,15.5 11.5,8.5"/></g></svg>`,
	tiktok: `<svg viewBox="0 0 448 512" width="1em" height="1em" aria-hidden="true"><path fill="#eef4ff" d="M448,209.91a210.06,210.06,0,0,1-122.77-39.25V349.38A162.55,162.55,0,1,1,185,188.31V278.2a74.62,74.62,0,1,0,52.23,71.18V0l88,0a121.18,121.18,0,0,0,1.86,22.17h0A122.18,122.18,0,0,0,381,102.39a121.43,121.43,0,0,0,67,20.14Z"/></svg>`,
};

// ── Timestamps ───────────────────────────────────────────────────────────

/** A message's arrival time (HH:MM:SS, locale-aware) or "" when the platform
 * didn't provide one. The formatter is cached per language. */
let timestampFormatter: Intl.DateTimeFormat | undefined;
let timestampFormatterLang: string | undefined;

function formatTimestamp(ts: number): string {
	if (!Number.isFinite(ts) || ts <= 0) return "";
	const lang = currentLanguage();

	if (timestampFormatterLang !== lang) {
		timestampFormatterLang = lang;
		timestampFormatter = new Intl.DateTimeFormat(lang, {
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
			hour12: false,
		});
	}
	const fmt = timestampFormatter;
	if (!fmt) return "";
	return fmt.format(ts);
}

// ── Message decoration (escaped HTML: links, bold @mentions, DM dimming) ──

/** A message starting with @username is a DM — render it muted. */
const DM_RE = /^\s*@[A-Za-z0-9_-]+/;

export function decorateText(text: string): string {
	const escapeHtml = (str: string): string =>
		str.replace(/[&<>"']/g, (ch) => {
			const map: Record<string, string> = {
				"&": "&amp;",
				"<": "&lt;",
				">": "&gt;",
				'"': "&quot;",
				"'": "&#039;",
			};
			return map[ch];
		});

	const urlRegex = /((?:https?:\/\/|www\.)[^\s]+)/gi;
	// @mentions in bold; only at text start or after whitespace, so
	// e-mail-style "user@domain" runs are left untouched.
	const mentionRegex = /(^|\s)@([A-Za-z0-9_-]+)/g;

	// A DM line: the whole leading text run (everything before the first URL)
	// is wrapped in a span the page can dim.
	const dm = DM_RE.test(text);

	return text
		.split(urlRegex)
		.map((part: string, index: number): string => {
			if (!/^(?:https?:\/\/|www\.)/i.test(part)) {
				const out = escapeHtml(part).replace(mentionRegex, "$1<b>@$2</b>");
				return dm && index === 0 && out
					? `<span class="dm">${out}</span>`
					: out;
			}

			let url = part;
			let trailing = "";

			const trailingMatch = url.match(/[.,!?;:)\]}'"]+$/);
			if (trailingMatch) {
				trailing = trailingMatch[0];
				url = url.slice(0, -trailing.length);
			}

			const href = /^www\./i.test(url) ? `http://${url}` : url;

			return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>${escapeHtml(trailing)}`;
		})
		.join("");
}

// ── Emotes (URL upgrader, segment parser, rendering) ─────────────────────

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

/** Render a sender's badges before the username as images, mirroring Kick's
 * own chat art (subscriber month squares, level, custom/global badges). The
 * provider only emits badges that resolve to an image, so each entry is an
 * `<img>`; a badge with no url is skipped. */
function renderBadges(badges: ChatLine["msg"]["badges"]): m.Children {
	// The provider only emits badges that resolve to an image, but guard
	// against a stray image-less entry: filter first (returning holes inside a
	// keyed `.map` makes Mithril throw on mixed key/none fragments).
	const images = (badges ?? []).filter((badge) => badge.url);
	if (!images.length) return null;
	return (
		<span class="chat-badges">
			{images.map((badge, index) => {
				const label = badge.text ?? badge.type ?? "";
				const title = badge.count ? `${label} (${badge.count})` : label;
				return (
					<img
						class="chat-badge"
						key={index}
						// Intrinsic 1em height: the editor page doesn't load
						// overlay.css, so without this the raw badge art
						// renders at its natural (huge) size there.
						height="1em"
						src={badge.url}
						alt={label}
						title={title}
						loading="lazy"
					/>
				);
			})}
		</span>
	);
}

// ── The feed container (auto-scroll) ─────────────────────────────────────

/** Per-feed auto-follow flag (bottom mode only). */
const chatAutoScroll = new WeakMap<HTMLElement, boolean>();

type ChatFeedAttrs = {
	/** Lines in DISPLAY order (top order: newest first; bottom: oldest first). */
	lines: FeedLine[];
	bottom: boolean;
	showPlatformIcons: boolean;
	/** Show each line's arrival time next to it. */
	showTimestamps: boolean;
	/** Show the sender's badges in front of the username. */
	showBadges: boolean;
	feedKey: string;
	// Feed text display values. The feed styles itself from these instead of
	// relying on `overlay.css` consuming the element's `--ov-chat-*` props —
	// the editor page loads no element CSS, so every value that only lived in
	// that stylesheet (text-align, font, fade, spacing) ignored the settings
	// outside the overlay. Same values both places → identical rendering.
	/** Feed text size in px. */
	fontSize: number;
	/** Feed text font stack. */
	fontFamily: string;
	/** Feed text colour (`#rrggbb`). */
	color: string;
	/** Feed text weight. */
	fontWeight: number;
	/** Feed text line-height (unitless). */
	lineHeight: number;
	/** Spacing between feed lines in px. */
	messageSpacing: number;
	/** Alignment of the feed text. */
	textAlign: "left" | "center" | "right" | "justify";
	/** Which feed edge fades out (`"off"` = no fade). */
	fadeDirection: "off" | "top" | "bottom";
	/** Fade-out size in px. */
	fadeSize: number;
};

/**
 * The feed draws every line it is given; the element box clips the rest.
 *
 * (It used to count how many lines "fit" the box by measuring one rendered
 * line and re-slicing after every redraw. That counted the newest line's
 * height as the unit — so a wrapped line arriving (or any other redraw, from
 * a trigger timer, the weather ticker, …) changed the count and the top of
 * the feed jumped. CSS clipping is the same visual result at zero per-frame
 * DOM churn; the line buffers feeding this feed are capped server-side.)
 *
 * In bottom mode:
 * - follows new messages while the user is at the bottom;
 * - pauses when the user scrolls up;
 * - resumes when the user returns to the bottom.
 *
 * In top mode it does not force scrolling.
 */
export const ChatFeedView: m.Component<ChatFeedAttrs> = {
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

		if (!vnode.attrs.bottom) {
			// Top order: new lines enter at the top of the feed. Pin the feed
			// there — without this, a feed that was following its bottom in
			// bottom order stays scrolled to the (stable) tail and the new
			// top lines stay off-clip in a non-scrollable (overflow:hidden)
			// element.
			if (el.scrollTop > 0) el.scrollTop = 0;
			return;
		}

		if (!chatAutoScroll.get(el)) return;

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
		const {
			lines,
			bottom,
			showPlatformIcons,
			showTimestamps,
			showBadges,
			feedKey,
			fontSize,
			fontFamily,
			color,
			fontWeight,
			lineHeight,
			messageSpacing,
			textAlign,
			fadeDirection,
			fadeSize,
		} = vnode.attrs;

		return (
			<div
				class={bottom ? "chat-feed chat-feed-bottom" : "chat-feed"}
				key={feedKey}
				// The feed styles itself from its attrs (mirroring the
				// `--ov-chat-*` rules in overlay.css, which the editor page
				// never loads) so the editor and the overlay render identically:
				// font/colour, text-align, line spacing and the edge fade.
				// `min-width:0` lets flex items wrap; the flex column +
				// `justify-content:flex-end` pins bottom order flush on the
				// element's bottom edge (excess lines clip off the top).
				style={[
					"min-width:0",
					// `white-space:normal` resets the `pre` inherited from the
					// element wrapper (overlay.css does the same for runtime).
					"white-space:normal",
					"height:100%",
					"overflow:hidden",
					"display:flex",
					"flex-direction:column",
					bottom ? "justify-content:flex-end" : "",
					`font-size:${fontSize}px`,
					`font-family:${fontFamily}`,
					`color:${color}`,
					`font-weight:${fontWeight}`,
					`line-height:${lineHeight}`,
					`text-align:${textAlign}`,
					fadeDirection === "bottom"
						? `--ov-chat-fade-opaque:#fff;--ov-chat-fade-clear:#fff0;-webkit-mask-image:linear-gradient(180deg,#fff 0,#fff calc(100% - ${fadeSize}px),#fff0 100%);mask-image:linear-gradient(180deg,#fff 0,#fff calc(100% - ${fadeSize}px),#fff0 100%)`
						: fadeDirection === "top" && lines.length >= 3
							? `--ov-chat-fade-opaque:#fff;--ov-chat-fade-clear:#fff0;-webkit-mask-image:linear-gradient(0deg,#fff 0,#fff calc(100% - ${fadeSize}px),#fff0 100%);mask-image:linear-gradient(0deg,#fff 0,#fff calc(100% - ${fadeSize}px),#fff0 100%)`
							: "",
				]
					.filter(Boolean)
					.join(";")}
				onscroll={(event: Event) => {
					// The top-order pin (onupdate) scrolls the feed too — don't
					// let that reset the auto-follow state, which only bottom
					// order uses.
					if (!bottom) return;
					const el = event.currentTarget as HTMLElement;

					const distance = el.scrollHeight - el.clientHeight - el.scrollTop;

					// Re-enable auto-scroll only when the user reaches the bottom
					// threshold. Scrolling up disables it.
					chatAutoScroll.set(el, distance <= DISTANCE_THRESHOLD);
				}}
			>
				{lines.map((line) => (
					<div
						class={line.banned ? "chat-line chat-line-banned" : "chat-line"}
						key={line.key}
						// The line is a flex item of `.chat-feed`; `min-width:0`
						// (also in overlay.css) is what lets it wrap in the
						// editor, where the stylesheet isn't loaded. The text
						// alignment rides on the full-width line boxes (same as
						// overlay.css), and banned lines are dimmed + struck.
						style={`min-width:0;text-align:${textAlign};${
							messageSpacing ? `margin-bottom:${messageSpacing}px;` : ""
						}${line.banned ? "opacity:0.5" : ""}`}
					>
						{showPlatformIcons && (
							<span class="chat-icon" title={line.platform}>
								{m.trust(PLATFORM_ICONS[line.platform])}
							</span>
						)}

						{showTimestamps && line.msg.ts != null && (
							<span
								class="chat-time"
								title={new Date(line.msg.ts).toISOString()}
							>
								{formatTimestamp(line.msg.ts)}
							</span>
						)}

						{showBadges ? renderBadges(line.msg.badges) : null}

						{line.msg.username && (
							<>
								<span
									class="chat-user"
									style={`${
										line.msg.color ? `color:${line.msg.color};` : ""
									}${line.banned ? "text-decoration:line-through" : ""}`}
								>
									{line.msg.username}
								</span>
								<span class="chat-separator">:&nbsp;</span>
							</>
						)}

						<span
							class="chat-text"
							style={`word-break:break-word;${
								line.banned ? "text-decoration:line-through" : ""
							}`}
						>
							{lineSegments(line.msg.text ?? "")}
						</span>
					</div>
				))}
			</div>
		);
	},
};
