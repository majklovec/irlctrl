/** @jsx m */
/*
 * Featured widget — "featured" the latest chat message (or the latest sender)
 * in a big card: the streamer's reaction board, the giveaway picker display,
 * the "question of the moment". `kind` picks message vs user. Fed by the
 * shared `LiveChatFeed` connector.
 */

import { Icon } from "@ui/components/icons";
import { t } from "@ui/i18n";
import type {
	ElementContext,
	ElementProps,
	OverlayElement,
	OverlayElementDef,
} from "@ui/overlay/element";
import { numProp, strProp } from "@ui/overlay/element";
import { bindableForm } from "@ui/overlay/fields";
import type { Vnode } from "mithril";
import m from "mithril";
import type { OverlayElementSchema } from "../../../../../core/overlay_element";
import { ChannelsField } from "../lib/list_field";
import {
	ChatLine,
	LiveChatFeed,
	normalizeChannels,
} from "../lib/live_chat_feed";
import type { ChannelRow } from "./schema_utils";
import { normalizeChannelRows } from "./schema_utils";

/* ── featured (chat-driven) ───────────────────────────────────────────── */
export interface FeaturedProps {
	channels: ChannelRow[];
	/** What to feature: "message" (latest chat line) or "user" (latest sender). */
	kind: "message" | "user";
	/** Card heading; empty falls back to the kind label. */
	title: string;
	color: string;
	accent: string;
	background: string;
	radius: number;
	fontSize: number;
	fontFamily: string;
}
export const DEFAULT_FEATURED_PROPS: Required<FeaturedProps> = {
	channels: [],
	kind: "message",
	title: "",
	color: "#ffffff",
	accent: "#38bdf8",
	background: "#111827",
	radius: 12,
	fontSize: 26,
	fontFamily: "Inter, system-ui, sans-serif",
};

function draw(element: OverlayElement, ctx: ElementContext): Vnode<any, any> {
	const p = element.props;
	const channels = normalizeChannels(p.channels);
	const kind = strProp(p, "kind", "message");
	const title = strProp(p, "title", "").trim();
	const color = strProp(p, "color", "#ffffff");
	const accent = strProp(p, "accent", "#38bdf8");
	const background = strProp(p, "background", "#111827");
	const radius = numProp(p, "radius", 12);
	const fontSize = numProp(p, "fontSize", 26);
	const fontFamily = strProp(p, "fontFamily", "Inter, system-ui, sans-serif");

	return m(LiveChatFeed, {
		token: ctx.token ?? "",
		overlayId: ctx.overlayId ?? "",
		channels,
		render({ lines }: { ready: boolean; lines: ChatLine[] }) {
			const latest = lines.length > 0 ? lines[lines.length - 1] : undefined;
			return (
				<div
					style={{
						width: "100%",
						height: "100%",
						boxSizing: "border-box",
						display: "flex",
						flexDirection: "column",
						alignItems: "center",
						justifyContent: "center",
						gap: `${Math.round(fontSize * 0.3)}px`,
						background,
						border: `2px solid ${accent}`,
						borderRadius: `${radius}px`,
						color,
						fontFamily,
						padding: `${fontSize * 0.5}px`,
						overflow: "hidden",
					}}
				>
					<div
						style={{
							fontSize: `${Math.round(fontSize * 0.45)}px`,
							fontWeight: "700",
							textTransform: "uppercase",
							letterSpacing: "0.12em",
							color: accent,
						}}
					>
						{title ||
							(kind === "user"
								? t("overlay.ft_user")
								: t("overlay.ft_message"))}
					</div>
					{latest ? (
						kind === "user" ? (
							<div
								style={{
									fontSize: `${fontSize}px`,
									fontWeight: "800",
									color:
										latest.msg.color &&
										/^#[0-9a-f]{3,8}$/i.test(latest.msg.color)
											? latest.msg.color
											: color,
									textAlign: "center",
									overflow: "hidden",
									textOverflow: "ellipsis",
									maxWidth: "100%",
								}}
							>
								{latest.msg.username ?? ""}
							</div>
						) : (
							<div
								style={{
									fontSize: `${fontSize}px`,
									fontWeight: "700",
									textAlign: "center",
									overflow: "hidden",
									display: "-webkit-box",
									WebkitLineClamp: 3,
									WebkitBoxOrient: "vertical",
								}}
							>
								{latest.msg.text ?? ""}
							</div>
						)
					) : (
						<div
							style={{
								opacity: "0.5",
								fontSize: `${Math.round(fontSize * 0.7)}px`,
							}}
						>
							{t("overlay.ft_waiting")}
						</div>
					)}
					{latest && latest.msg.username ? (
						<div
							style={{
								opacity: "0.7",
								fontSize: `${Math.round(fontSize * 0.55)}px`,
							}}
						>
							— {latest.msg.username}
						</div>
					) : null}
				</div>
			);
		},
	});
}

function editForm({ element: e, mutate, variables, variableUrl }: ElementProps): Vnode {
	const p = e.props;
	return bindableForm({
		element: e,
		mutate,
		variables,
		variableUrl,
		rows: [
			<ChannelsField element={e} mutate={mutate} variables={variables} />,
			[
				{
					path: "props.kind",
					labelKey: "overlay.ft_kind",
					type: "select",
					value: strProp(p, "kind", "message"),
					options: [
						{ value: "message", label: t("overlay.ft_kind.message") },
						{ value: "user", label: t("overlay.ft_kind.user") },
					],
				},
			],
			[
				{
					path: "props.title",
					labelKey: "overlay.ft_title",
					type: "text",
					value: strProp(p, "title", ""),
				},
			],
			[
				{
					path: "props.color",
					labelKey: "overlay.color",
					type: "color",
					value: strProp(p, "color", "#ffffff"),
				},
				{
					path: "props.accent",
					labelKey: "overlay.accent",
					type: "color",
					value: strProp(p, "accent", "#38bdf8"),
				},
				{
					path: "props.background",
					labelKey: "overlay.cd_background",
					type: "color",
					value: strProp(p, "background", "#111827"),
				},
			],
			[
				{
					path: "props.fontSize",
					labelKey: "overlay.font_size",
					type: "number",
					min: 8,
					max: 200,
					value: numProp(p, "fontSize", 26),
				},
			],
		],
	});
}

function validate(e: OverlayElement): string[] {
	return [];
}

export const featuredElement: OverlayElementDef & OverlayElementSchema = {
	type: "featured",
	category: "widgets",

	labelKey: "overlay.add_featured",
	icon: () => <Icon name="star" class="role-icon" />,
	order: 103,
	defaultProps: { ...DEFAULT_FEATURED_PROPS },
	/** `channels` is one composite control, not a bindField scalar. */
	propKeys: ["kind", "title", "color", "accent", "background", "fontSize"],
	defaultSize: { width: 420, height: 180 },
	draw,
	editForm,
	validate,
	handles: "box",
	normalizeProps(props, read) {
		const d = DEFAULT_FEATURED_PROPS;
		return {
			channels: normalizeChannelRows(props.channels),
			kind: read.oneOf("kind", ["message", "user"], d.kind),
			title: read.str("title", d.title, 100),
			color: read.hex("color", d.color),
			accent: read.hex("accent", d.accent),
			background: read.hex("background", d.background),
			radius: read.num("radius", d.radius, 0, 500),
			fontSize: read.num("fontSize", d.fontSize, 6, 400),
			fontFamily: read.str("fontFamily", d.fontFamily, 300),
		};
	},
};
