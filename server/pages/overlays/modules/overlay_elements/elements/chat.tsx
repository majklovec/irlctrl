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
import { bindField } from "@ui/overlay/fields";
import type { Children, Vnode } from "mithril";
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

/** One inspector field wrapping a `<select>` of fixed choices. `bindField`
 * shows no binding toggle for selects (a fixed choice set can't take a
 * variable binding), so this is purely presentational. */
function choiceField(
	e: OverlayElement,
	path: string,
	label: string,
	value: string,
	options: { value: string; label: string }[],
	apply: (v: string) => void,
	props: ElementProps,
): Vnode {
	return bindField(
		e,
		path,
		label,
		<select
			value={value}
			oninput={(ev: Event) => apply((ev.target as HTMLSelectElement).value)}
		>
			{options.map((o) => (
				<option key={o.value} value={o.value}>
					{o.label}
				</option>
			))}
		</select>,
		props,
	);
}

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
	return (
		<div
			class={`chat-element${
				p.fadeDirection !== "off" ? ` chat-element-fade-${p.fadeDirection}` : ""
			}`}
			style={{
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

function editForm(props: ElementProps): Children {
	const e = props.element;
	const p = e.props as unknown as ChatProps;
	const mutate = (fn: (el: OverlayElement) => void): void => props.mutate(fn);

	return (
		<>
			<ChannelsField element={e} mutate={mutate} variables={props.variables} />

			{choiceField(
				e,
				"props.order",
				t("dash.widget_order"),
				p.order,
				[
					{ value: "top", label: t("dash.widget_order.top") },
					{
						value: "bottom",
						label: t("dash.widget_order.bottom"),
					},
				],
				(v) =>
					mutate((el) => {
						el.props.order = v as ChatProps["order"];
					}),
				props,
			)}
			{choiceField(
				e,
				"props.bannedMessages",
				t("dash.widget_bannedMessages"),
				p.bannedMessages,
				[
					{
						value: "strike",
						label: t("dash.widget_bannedMessages.strike"),
					},
					{
						value: "hide",
						label: t("dash.widget_bannedMessages.hide"),
					},
				],
				(v) =>
					mutate((el) => {
						el.props.bannedMessages = v as ChatProps["bannedMessages"];
					}),
				props,
			)}
			{choiceField(
				e,
				"props.timestamps",
				t("dash.widget_timestamps"),
				p.timestamps,
				[
					{
						value: "off",
						label: t("dash.widget_timestamps.off"),
					},
					{ value: "on", label: t("dash.widget_timestamps.on") },
				],
				(v) =>
					mutate((el) => {
						el.props.timestamps = v as ChatProps["timestamps"];
					}),
				props,
			)}
			{choiceField(
				e,
				"props.badges",
				t("dash.widget_badges"),
				p.badges,
				[
					{
						value: "on",
						label: t("dash.widget_badges.on"),
					},
					{
						value: "off",
						label: t("dash.widget_badges.off"),
					},
				],
				(v) =>
					mutate((el) => {
						el.props.badges = v as ChatProps["badges"];
					}),
				props,
			)}
			{choiceField(
				e,
				"props.platformIcons",
				t("dash.widget_platformIcons"),
				p.platformIcons,
				[
					{
						value: "auto",
						label: t("dash.widget_platformIcons.auto"),
					},
					{ value: "on", label: t("dash.widget_platformIcons.on") },
					{
						value: "off",
						label: t("dash.widget_platformIcons.off"),
					},
				],
				(v) =>
					mutate((el) => {
						el.props.platformIcons = v as ChatProps["platformIcons"];
					}),
				props,
			)}

			{bindField(
				e,
				"props.fontSize",
				t("overlay.font_size"),
				<input
					type="number"
					min={8}
					value={p.fontSize}
					oninput={(ev: Event) =>
						mutate((el) => {
							el.props.fontSize =
								Number((ev.target as HTMLInputElement).value) || 8;
						})
					}
				/>,
				props,
			)}
			{bindField(
				e,
				"props.fontWeight",
				t("overlay.font_weight"),
				<select
					value={p.fontWeight}
					oninput={(ev: Event) =>
						mutate((el) => {
							el.props.fontWeight = Number(
								(ev.target as HTMLSelectElement).value,
							);
						})
					}
				>
					<option value={400}>400</option>
					<option value={500}>500</option>
					<option value={700}>700</option>
				</select>,
				props,
			)}
			{bindField(
				e,
				"props.color",
				t("overlay.color"),
				<input
					type="color"
					value={p.color}
					oninput={(ev: Event) =>
						mutate((el) => {
							el.props.color = (ev.target as HTMLInputElement).value;
						})
					}
				/>,
				props,
			)}
			{bindField(
				e,
				"props.lineHeight",
				t("overlay.line_height"),
				<input
					type="number"
					step={0.1}
					min={0.5}
					value={p.lineHeight}
					oninput={(ev: Event) =>
						mutate((el) => {
							el.props.lineHeight =
								Number((ev.target as HTMLInputElement).value) || 1;
						})
					}
				/>,
				props,
			)}
			{bindField(
				e,
				"props.messageSpacing",
				t("overlay.message_spacing"),
				<input
					type="number"
					min={0}
					value={p.messageSpacing}
					oninput={(ev: Event) =>
						mutate((el) => {
							el.props.messageSpacing =
								Number((ev.target as HTMLInputElement).value) || 0;
						})
					}
				/>,
				props,
			)}
			{choiceField(
				e,
				"props.fadeDirection",
				t("overlay.fade_direction"),
				p.fadeDirection,
				[
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
				(v) =>
					mutate((el) => {
						el.props.fadeDirection = v as ChatProps["fadeDirection"];
					}),
				props,
			)}
			{bindField(
				e,
				"props.fadeSize",
				t("overlay.fade_size"),
				<input
					type="number"
					min={0}
					value={p.fadeSize}
					oninput={(ev: Event) =>
						mutate((el) => {
							el.props.fadeSize =
								Number((ev.target as HTMLInputElement).value) || 0;
						})
					}
				/>,
				props,
			)}
			{choiceField(
				e,
				"props.textAlign",
				t("overlay.text_align"),
				p.textAlign,
				[
					{ value: "left", label: t("overlay.text_align.left") },
					{
						value: "center",
						label: t("overlay.text_align.center"),
					},
					{
						value: "right",
						label: t("overlay.text_align.right"),
					},
					{
						value: "justify",
						label: t("overlay.text_align.justify"),
					},
				],
				(v) =>
					mutate((el) => {
						el.props.textAlign = v as ChatProps["textAlign"];
					}),
				props,
			)}
		</>
	);
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
