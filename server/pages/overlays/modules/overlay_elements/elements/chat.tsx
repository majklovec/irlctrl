/** @jsx m */
/*
 * OBS overlay chat element — a self-contained live chat feed that draws its
 * platforms and channels directly on the element, independent of any
 * dashboard chat widget.
 *   - Channels: a filters-style list — add rows, pick a platform, type the
 *     handle. No widget to link, no URL to paste.
 *   - Display: new-message order, banned-message handling, timestamps and
 *     platform icons. The visible history is not a prop — the feed sizes
 *     itself to the element's box.
 *   - Feed text: size, weight, colour, line-height, spacing, fade, alignment.
 * The live text renders straight into the same DOM the overlay composites, so
 * a browser tab shows the exact feed OBS sees. It never uses an <iframe> — a
 * browser-source capture composites iframes opaquely. The feed is fed by the
 * scene token + id through the module's `LiveChatFeed` connector (the
 * overlay's token-scoped chat WebSocket); props are normalized & clamped by
 * this element's definition, so the form only edits.
 */

import { Icon } from "@ui/components/icons";
import { t } from "@ui/i18n";
import type {
	ElementContext,
	ElementProps,
	OverlayElement,
	OverlayElementDef,
} from "@ui/overlay/element";
import { bindableForm } from "@ui/overlay/fields";
import type { Vnode } from "mithril";
import m from "mithril";
import {
	CHAT_BANNED_TYPE,
	ChatFeedView,
	type FeedLine,
} from "../lib/chat_render";
import type { ChatLine } from "../lib/live_chat_feed";
import { LiveChatFeed, normalizeChannels } from "../lib/live_chat_feed";
import { ChannelsField } from "../lib/list_field";
import type { OverlayElementSchema } from "../../../../../core/overlay_element";
import { normalizeChannelRows, type ChannelRow } from "./schema_utils";

/* ── chat (full live feed) ────────────────────────────────────────────── */
export interface ChatProps {
	/** The platform channels to display (a dynamic list; empty = nothing). */
	channels: ChannelRow[];
	/** Where new messages enter the feed: "top" (newest first) or "bottom". */
	order: "top" | "bottom";
	/** How moderated (removed) messages present: "strike-through" or "hide". */
	bannedMessages: "strike" | "hide";
	/** Show each message's arrival time. */
	timestamps: "off" | "on";
	/** Show the sender's badges (subscriber/moderator, …) in front of the name. */
	badges: "off" | "on";
	/** Platform icons: "auto" (only when >1 channel), forced "on", or "off". */
	platformIcons: "auto" | "on" | "off";
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
	/** Spacing between feed lines in px (0 = none). */
	messageSpacing: number;
	/** Which feed edge fades out into the background. */
	fadeDirection: "off" | "top" | "bottom";
	/** Fade-out size in px. */
	fadeSize: number;
	/** Alignment of the feed text. */
	textAlign: "left" | "center" | "right" | "justify";
}
export const DEFAULT_CHAT_PROPS: Required<ChatProps> = {
	channels: [],
	order: "top",
	bannedMessages: "strike",
	timestamps: "off",
	badges: "on",
	platformIcons: "auto",
	fontSize: 48,
	fontFamily: "Inter, system-ui, sans-serif",
	color: "#ffffff",
	fontWeight: 600,
	lineHeight: 1.2,
	messageSpacing: 0,
	fadeDirection: "off",
	// ~6rem — the size of a few feed lines.
	fadeSize: 96,
	textAlign: "left",
};


/** The display list for one snapshot of the feed: banned lines filtered
 * (or flagged, per the element's `bannedMessages`), in the element's message
 * order (top: newest first; bottom: oldest first). */
function shownLines(p: ChatProps, lines: ChatLine[]): FeedLine[] {
	const hideBanned = p.bannedMessages === "hide";
	const kept = lines
		.filter((line) => line.msg.type !== CHAT_BANNED_TYPE || !hideBanned)
		.map((line) => ({ ...line, banned: line.msg.type === CHAT_BANNED_TYPE }));
	// `LiveChatFeed` buffers oldest→newest; top order reads newest first.
	return p.order === "bottom" ? kept : kept.reverse();
}

/** The feed content for one (re)render: the auto-fit container with the
 * element's display options. */
function feedView(element: OverlayElement, p: ChatProps, lines: ChatLine[]): m.Children {
	const cut = shownLines(p, lines);
	if (!cut.length) return null;

	const channels = normalizeChannels(p.channels);
	const channelCount = channels.filter((c) => c.channel).length;
	const showPlatformIcons =
		p.platformIcons === "on" ||
		(p.platformIcons === "auto" && channelCount > 1);
	const bottom = p.order === "bottom";

	return m(ChatFeedView, {
		lines: cut,
		bottom,
		showPlatformIcons,
		showTimestamps: p.timestamps === "on",
		showBadges: p.badges !== "off",
		feedKey: `chat-feed:${element.id}`,
		fontSize: p.fontSize,
		fontFamily: p.fontFamily,
		color: p.color,
		fontWeight: p.fontWeight,
		lineHeight: p.lineHeight,
		messageSpacing: p.messageSpacing,
		textAlign: p.textAlign,
		fadeDirection: p.fadeDirection,
		fadeSize: p.fadeSize,
	});
}

/** Draw the element as a live chat feed in the current DOM. `ctx` carries the
 * scene token + id the feed opens its WebSocket with: in the editor those are
 * the project token and the draft scene's id; at runtime both come from the
 * overlay URL. */
function draw(element: OverlayElement, ctx: ElementContext): Vnode {
	const p = element.props as unknown as ChatProps;
	// `--ov-chat-*` custom properties + the fade-<dir> modifier class are the
	// contract `overlay.css` reads (see its `.chat-element` rules).
	// `height:100%;overflow:hidden` mirror that rule inline: the editor loads
	// no element CSS, and without a filled wrapper the feed's `height:100%`
	// has nothing to resolve to, so bottom order can't pin to the box's
	// bottom edge (it just flows from the top).
	return (
		<div
			class={`chat-element${
				p.fadeDirection !== "off" ? ` chat-element-fade-${p.fadeDirection}` : ""
			}`}
			style={{
				height: "100%",
				overflow: "hidden",
				"--ov-chat-font-size": `${p.fontSize}px`,
				"--ov-chat-font-family": p.fontFamily,
				"--ov-chat-color": p.color,
				"--ov-chat-font-weight": String(p.fontWeight),
				"--ov-chat-line-height": String(p.lineHeight),
				"--ov-chat-message-gap": `${p.messageSpacing}px`,
				"--ov-chat-fade": `${p.fadeSize}px`,
				"--ov-chat-text-align": p.textAlign,
			}}
		>
			{m(LiveChatFeed, {
				token: ctx.token ?? "",
				overlayId: ctx.overlayId ?? "",
				channels: normalizeChannels(p.channels),
				render({ ready, lines }: { ready: boolean; lines: ChatLine[] }) {
					return ready
						? feedView(element, p, lines)
						: m("p.chat-overlay-error", { role: "alert" }, "…");
				},
			})}
		</div>
	);
}

function editForm({ element: e, mutate, variables, variableUrl }: ElementProps): Vnode {
	const p = e.props as unknown as ChatProps;

	return bindableForm({
		element: e,
		mutate,
		variables,
		variableUrl,
		rows: [
			// The channel rows are a composite list widget, not a descriptor
			// per row, so it stays a raw Vnode (never gets a binding toggle).
			<ChannelsField element={e} mutate={mutate} variables={variables} />,
			[
				{
					path: "props.order",
					labelKey: "dash.widget_order",
					type: "select",
					value: p.order,
					options: [
						{ value: "top", label: t("dash.widget_order.top") },
						{ value: "bottom", label: t("dash.widget_order.bottom") },
					],
				},
			],
			[
				{
					path: "props.bannedMessages",
					labelKey: "dash.widget_bannedMessages",
					type: "select",
					value: p.bannedMessages,
					options: [
						{
							value: "strike",
							label: t("dash.widget_bannedMessages.strike"),
						},
						{
							value: "hide",
							label: t("dash.widget_bannedMessages.hide"),
						},
					],
				},
			],
			[
				{
					path: "props.timestamps",
					labelKey: "dash.widget_timestamps",
					type: "select",
					value: p.timestamps,
					options: [
						{ value: "off", label: t("dash.widget_timestamps.off") },
						{ value: "on", label: t("dash.widget_timestamps.on") },
					],
				},
			],
			[
				{
					path: "props.badges",
					labelKey: "dash.widget_badges",
					type: "select",
					value: p.badges,
					options: [
						{ value: "on", label: t("dash.widget_badges.on") },
						{ value: "off", label: t("dash.widget_badges.off") },
					],
				},
			],
			[
				{
					path: "props.platformIcons",
					labelKey: "dash.widget_platformIcons",
					type: "select",
					value: p.platformIcons,
					options: [
						{
							value: "auto",
							label: t("dash.widget_platformIcons.auto"),
						},
						{ value: "on", label: t("dash.widget_platformIcons.on") },
						{ value: "off", label: t("dash.widget_platformIcons.off") },
					],
				},
			],
			[
				{
					path: "props.fontSize",
					labelKey: "overlay.font_size",
					type: "number",
					value: p.fontSize,
					min: 8,
				},
			],
			[
				{
					path: "props.fontWeight",
					labelKey: "overlay.font_weight",
					type: "select",
					value: p.fontWeight,
					options: [
						{ value: "400", label: "400" },
						{ value: "500", label: "500" },
						{ value: "700", label: "700" },
					],
				},
			],
			[
				{
					path: "props.color",
					labelKey: "overlay.color",
					type: "color",
					value: p.color,
				},
			],
			[
				{
					path: "props.lineHeight",
					labelKey: "overlay.line_height",
					type: "number",
					value: p.lineHeight,
					min: 0.5,
					step: 0.1,
				},
			],
			[
				{
					path: "props.messageSpacing",
					labelKey: "overlay.message_spacing",
					type: "number",
					value: p.messageSpacing,
					min: 0,
				},
			],
			[
				{
					path: "props.fadeDirection",
					labelKey: "overlay.fade_direction",
					type: "select",
					value: p.fadeDirection,
					options: [
						{
							value: "off",
							label: t("overlay.fade_direction.off"),
						},
						{
							value: "top",
							label: t("overlay.fade_direction.top"),
						},
						{
							value: "bottom",
							label: t("overlay.fade_direction.bottom"),
						},
					],
				},
			],
			[
				{
					path: "props.fadeSize",
					labelKey: "overlay.fade_size",
					type: "number",
					value: p.fadeSize,
					min: 0,
				},
			],
			[
				{
					path: "props.textAlign",
					labelKey: "overlay.text_align",
					type: "select",
					value: p.textAlign,
					options: [
						{ value: "left", label: t("overlay.text_align.left") },
						{ value: "center", label: t("overlay.text_align.center") },
						{ value: "right", label: t("overlay.text_align.right") },
						{ value: "justify", label: t("overlay.text_align.justify") },
					],
				},
			],
		],
	});
}

function validate(_e: OverlayElement): string[] {
	// Channels are optional while editing (an empty list just shows nothing),
	// and there is no URL to point at — so there is nothing to check.
	return [];
}

export const chatElement: OverlayElementDef & OverlayElementSchema = {
	type: "chat",
	category: "widgets",

	labelKey: "overlay.add_chat",
	icon: () => <Icon name="chat" class="role-icon" />,
	order: 10,
	defaultProps: { ...DEFAULT_CHAT_PROPS },
	/** The channel rows are one composite control, not a bindField-wrapped
	 * scalar, so `propKeys` lists only the bindable scalar props. */
	propKeys: [
		"order",
		"bannedMessages",
		"timestamps",
		"badges",
		"platformIcons",
		"fontSize",
		"fontWeight",
		"color",
		"lineHeight",
		"messageSpacing",
		"fadeDirection",
		"fadeSize",
		"textAlign",
	],
	defaultSize: { width: 420, height: 380 },
	draw,
	editForm,
	validate,
	handles: "box",
	normalizeProps(props, read) {
		const d = DEFAULT_CHAT_PROPS;
		return {
			// `channels` is an object array, so it is normalized directly from
			// the raw record (the scalar `read` helpers can't touch it).
			channels: normalizeChannelRows(props.channels),
			order: read.oneOf("order", ["top", "bottom"], d.order),
			bannedMessages: read.oneOf(
				"bannedMessages",
				["strike", "hide"],
				d.bannedMessages,
			),
			timestamps: read.oneOf("timestamps", ["off", "on"], d.timestamps),
			badges: read.oneOf("badges", ["off", "on"], d.badges),
			platformIcons: read.oneOf(
				"platformIcons",
				["auto", "on", "off"],
				d.platformIcons,
			),
			fontSize: read.num("fontSize", d.fontSize, 1, 2000),
			fontFamily: read.str("fontFamily", d.fontFamily, 300),
			color: read.hex("color", d.color),
			fontWeight: read.num("fontWeight", d.fontWeight, 100, 900),
			lineHeight: read.num("lineHeight", d.lineHeight, 0.1, 10),
			messageSpacing: read.num("messageSpacing", d.messageSpacing, 0, 100),
			fadeDirection: read.oneOf(
				"fadeDirection",
				["off", "top", "bottom"],
				d.fadeDirection,
			),
			fadeSize: read.num("fadeSize", d.fadeSize, 1, 500),
			textAlign: read.oneOf(
				"textAlign",
				["left", "center", "right", "justify"],
				d.textAlign,
			),
		};
	},
};

export default [chatElement];
