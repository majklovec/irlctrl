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
 * scene token + id via `EmbeddedChat` (./frontend.tsx); props are normalized
 * & clamped by ./overlay_schema.ts, so the form only edits.
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
import { CHAT_PLATFORMS, type ChatChannel, chatPropsToConfig } from "./config";
import { EmbeddedChat } from "./frontend";
import { type ChatProps, DEFAULT_CHAT_PROPS } from "./overlay_schema";

/** Platform option label keys — YouTube/Twitch/Kick live in the core catalog
 * and TikTok in this module's; all resolve once every catalog is registered. */
const PLATFORM_LABEL_KEY: Record<string, string> = {
	youtube: "dash.widget_youtube",
	twitch: "dash.widget_twitch",
	tiktok: "dash.widget_tiktok",
	kick: "dash.widget_kick",
};
const platformLabel = (p: string): string => t(PLATFORM_LABEL_KEY[p] ?? p);

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

/** Filters-style channel list: add rows, pick a platform, type a handle,
 * remove. Mutates `props.channels` (a normalized `ChatChannel[]`); the schema
 * normalizes on load so the stored value is always a clean array. */
function channelsField(props: ElementProps): Children {
	const element = props.element;
	const channels = (element.props.channels ?? []) as ChatChannel[];
	const set = (next: ChatChannel[]): void =>
		props.mutate((el) => {
			el.props.channels = next;
		});
	return (
		<div class="ov-field">
			<span class="ov-lbl">{t("overlay.chat_channels")}</span>
			<div class="ov-channels">
				{channels.length === 0 ? (
					<div class="ov-channels-empty">{t("overlay.chat_no_channels")}</div>
				) : (
					channels.map((c, i) => (
						<div class="ov-channel-row" key={i}>
							<select
								value={c.platform}
								aria-label={t("overlay.chat_platform")}
								onchange={(ev: Event) => {
									const platform = (ev.target as HTMLSelectElement)
										.value as ChatChannel["platform"];
									set(
										channels.map((row, j) =>
											j === i ? { ...row, platform } : row,
										),
									);
								}}
							>
								{CHAT_PLATFORMS.map((pf) => (
									<option key={pf} value={pf}>
										{platformLabel(pf)}
									</option>
								))}
							</select>
							<input
								value={c.channel}
								placeholder={t("overlay.chat_channel_ph")}
								aria-label={t("overlay.chat_channel")}
								oninput={(ev: Event) => {
									const channel = (ev.target as HTMLInputElement).value;
									set(
										channels.map((row, j) =>
											j === i ? { ...row, channel } : row,
										),
									);
								}}
							/>
							<button
								class="ov-channel-remove"
								type="button"
								aria-label={t("overlay.chat_remove_channel")}
								onclick={() => set(channels.filter((_, j) => j !== i))}
							>
								<Icon name="close" width="12" height="12" />
							</button>
						</div>
					))
				)}
				<button
					class="ov-channel-add"
					type="button"
					onclick={() =>
						set([...channels, { platform: CHAT_PLATFORMS[0], channel: "" }])
					}
				>
					+ {t("overlay.chat_add_channel")}
				</button>
			</div>
		</div>
	);
}

/** Draw the element as a live chat feed in the current DOM. `ctx` carries the
 * scene token + id the feed opens its WebSocket with: in the editor those are
 * the project token and the draft scene's id; at runtime both come from the
 * overlay URL. */
function draw(element: OverlayElement, ctx: ElementContext): Vnode {
	const p = element.props as unknown as ChatProps;
	// `--ov-chat-*` custom properties + the fade-<dir> modifier class are the
	// contract `styles.css` reads (see its `.chat-element` rules).
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
			{m(EmbeddedChat, {
				id: element.id,
				config: chatPropsToConfig(element.props),
				token: ctx.token ?? "",
				sceneId: ctx.sceneId ?? "",
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
			{channelsField(props)}

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
	// and there is no URL to point at any more — so there is nothing to check.
	return [];
}

export const chatElement: OverlayElementDef = {
	type: "chat",
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
};

export default [chatElement];
