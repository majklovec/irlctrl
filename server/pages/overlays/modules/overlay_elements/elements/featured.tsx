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
import { bindField } from "@ui/overlay/fields";
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
	const sp = { mutate, variables, variableUrl };
	const setSel = (key: string) => (ev: Event) =>
		mutate((el) => {
			el.props[key] = (ev.target as HTMLSelectElement).value;
		});
	const setStr = (key: string) => (ev: Event) =>
		mutate((el) => {
			el.props[key] = (ev.target as HTMLInputElement).value;
		});
	const setNum = (key: string) => (ev: Event) =>
		mutate((el) => {
			el.props[key] = Number((ev.target as HTMLInputElement).value);
		});
	return (
		<>
			<ChannelsField element={e} mutate={mutate} variables={variables} />
			{bindField(
				e,
				"props.kind",
				t("overlay.ft_kind"),
				<select value={strProp(p, "kind", "message")} onchange={setSel("kind")}>
					<option value="message">{t("overlay.ft_kind.message")}</option>
					<option value="user">{t("overlay.ft_kind.user")}</option>
				</select>,
				sp,
			)}
			{bindField(
				e,
				"props.title",
				t("overlay.ft_title"),
				<input
					type="text"
					value={strProp(p, "title", "")}
					oninput={setStr("title")}
				/>,
				sp,
			)}
			<div class="ov-grid3">
				{bindField(
					e,
					"props.color",
					t("overlay.color"),
					<input
						type="color"
						value={strProp(p, "color", "#ffffff")}
						oninput={setStr("color")}
					/>,
					sp,
				)}
				{bindField(
					e,
					"props.accent",
					t("overlay.accent"),
					<input
						type="color"
						value={strProp(p, "accent", "#38bdf8")}
						oninput={setStr("accent")}
					/>,
					sp,
				)}
				{bindField(
					e,
					"props.background",
					t("overlay.cd_background"),
					<input
						type="color"
						value={strProp(p, "background", "#111827")}
						oninput={setStr("background")}
					/>,
					sp,
				)}
			</div>
			{bindField(
				e,
				"props.fontSize",
				t("overlay.font_size"),
				<input
					type="number"
					min={8}
					max={200}
					value={numProp(p, "fontSize", 26)}
					oninput={setNum("fontSize")}
				/>,
				sp,
			)}
		</>
	);
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
