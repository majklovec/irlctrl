/** @jsx m */
/*
 * Emote-wall widget — every chat message spawns a floating chip (the sender's
 * color + name, the message text) that drifts up the scene and fades out,
 * the classic "emote rain" board. The float is a CSS animation
 * (`ovEmoteFloat`, declared in overlay.css / overlay_editor.css); each chip
 * gets a deterministic horizontal position + duration jitter from a hash of
 * the message id, so the wall is a lively curtain of messages. `maxEmotes`
 * caps concurrent chips (oldest dropped first). The editor shows the design
 * state (an empty board) — the float needs the live feed.
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
import {
	ChatLine,
	LiveChatFeed,
	normalizeChannels,
} from "../lib/live_chat_feed";
import { ChannelsField } from "../lib/list_field";
import { hashUnit } from "../lib/ticker";
import type { OverlayElementSchema } from "../../../../../core/overlay_element";
import type { ChannelRow } from "./schema_utils";
import { normalizeChannelRows } from "./schema_utils";

/* ── emote wall (chat-driven) ─────────────────────────────────────────── */
export interface EmoteWallProps {
	channels: ChannelRow[];
	/** How the emotes move. */
	motion: "calm" | "normal" | "chaos" | "bounce";
	/** Max concurrent floating emotes. */
	maxEmotes: number;
	/** Float lifetime in ms. */
	lifetime: number;
	fontSize: number;
	fontFamily: string;
}
export const DEFAULT_EMOTE_WALL_PROPS: Required<EmoteWallProps> = {
	channels: [],
	motion: "normal",
	maxEmotes: 24,
	lifetime: 8000,
	fontSize: 40,
	fontFamily: "Inter, system-ui, sans-serif",
};

interface FloatChip {
	key: string;
	name: string;
	text: string;
	color: string;
	/** Deterministic 0..1 from the message id (x position, duration jitter). */
	r: number;
}

/** Per-element chip list (module-scoped: `draw` is re-created per render). */
const chips = new Map<string, FloatChip[]>();

function draw(element: OverlayElement, ctx: ElementContext): Vnode<any, any> {
	const p = element.props;
	const channels = normalizeChannels(p.channels);
	const motion = strProp(p, "motion", "normal");
	const maxEmotes = numProp(p, "maxEmotes", 24);
	const lifetime = numProp(p, "lifetime", 8000);
	const fontSize = numProp(p, "fontSize", 40);
	const fontFamily = strProp(p, "fontFamily", "Inter, system-ui, sans-serif");

	const live = ctx.activeTriggers !== undefined;
	const list = chips.get(element.id) ?? [];
	chips.set(element.id, list);

	const onLine = (line: ChatLine): void => {
		const text = (line.msg.text ?? "").trim();
		if (!text) return;
		const el = list;
		el.push({
			// `line.key` is stamped unique per line — `msg.id` alone can
			// collide across duplicate/re-sent provider ids.
			key: line.key,
			name: line.msg.username ?? "",
			text,
			color:
				line.msg.color && /^#[0-9a-f]{3,8}$/i.test(line.msg.color)
					? line.msg.color
					: "#ffffff",
			r: hashUnit(line.key),
		});
		while (el.length > maxEmotes) el.shift();
		m.redraw();
	};

	// Motion → speed multiplier + horizontal drift amplitude (% of width).
	const speedMul =
		motion === "calm" ? 1.6 : motion === "chaos" ? 0.45 : motion === "bounce" ? 1.1 : 1;
	const drift =
		motion === "chaos" ? 30 : motion === "bounce" ? 14 : motion === "calm" ? 4 : 10;

	return m(LiveChatFeed, {
		token: ctx.token ?? "",
		overlayId: ctx.overlayId ?? "",
		channels,
		onMessage: onLine,
		render() {
			return (
				<div
					onremove={() => {
						// The element left the scene — drop its chip list.
						chips.delete(element.id);
					}}
					style={{
						width: "100%",
						height: "100%",
						boxSizing: "border-box",
						position: "relative",
						overflow: "hidden",
						fontFamily,
					}}
				>
					{!live
						? m(
								"div",
								{
									style: {
										position: "absolute",
										inset: 0,
										display: "flex",
										alignItems: "center",
										justifyContent: "center",
										color: "rgba(255,255,255,0.4)",
										fontSize: `${Math.round(fontSize * 0.5)}px`,
									},
								},
								t("overlay.ew_design"),
						  )
						: null}
					{list.map((chip) => {
						const dur = (lifetime / 1000) * speedMul * (0.8 + chip.r * 0.4);
						const x = 4 + chip.r * (92 - drift);
						return m(
							"div",
							{
								key: chip.key,
								class: "ov-emote-chip",
								style: {
									left: `${x}%`,
									bottom: "-12%",
									color: chip.color,
									fontSize: `${Math.round(fontSize * (0.7 + chip.r * 0.5))}px`,
									animationDuration: `${dur.toFixed(2)}s`,
									"--ew-drift": `${(chip.r > 0.5 ? 1 : -1) * drift * chip.r}%`,
								},
							},
							[
								chip.name
									? m("span", { key: "n", style: { fontWeight: "800" } }, `${chip.name}: `)
									: null,
								m("span", { key: "t" }, chip.text),
							],
						);
					})}
				</div>
			);
		},
	});
}

function editForm({ element: e, mutate, variables }: ElementProps): Vnode {
	const p = e.props;
	const sp = { mutate, variables };
	const setSel = (key: string) => (ev: Event) =>
		mutate((el) => {
			el.props[key] = (ev.target as HTMLSelectElement).value;
		});
	const setNum = (key: string) => (ev: Event) =>
		mutate((el) => {
			el.props[key] = Number((ev.target as HTMLInputElement).value);
		});
	return (
		<>
			<ChannelsField element={e} mutate={mutate} variables={variables} />
			{bindField(e, "props.motion", t("overlay.ew_motion"),
				<select value={strProp(p, "motion", "normal")} onchange={setSel("motion")}>
					<option value="calm">{t("overlay.ew_motion.calm")}</option>
					<option value="normal">{t("overlay.ew_motion.normal")}</option>
					<option value="chaos">{t("overlay.ew_motion.chaos")}</option>
					<option value="bounce">{t("overlay.ew_motion.bounce")}</option>
				</select>, sp)}
			<div class="ov-grid2">
				{bindField(e, "props.maxEmotes", t("overlay.ew_max"),
					<input type="number" min={1} max={200} value={numProp(p, "maxEmotes", 24)} oninput={setNum("maxEmotes")} />, sp)}
				{bindField(e, "props.lifetime", t("overlay.ew_lifetime"),
					<input type="number" min={1} max={120} value={Math.round(numProp(p, "lifetime", 8000) / 1000)} oninput={setNum("lifetime")} />, sp)}
			</div>
			{bindField(e, "props.fontSize", t("overlay.font_size"),
				<input type="number" min={8} max={200} value={numProp(p, "fontSize", 40)} oninput={setNum("fontSize")} />, sp)}
		</>
	);
}

function validate(e: OverlayElement): string[] {
	return [];
}

export const emoteWallElement: OverlayElementDef & OverlayElementSchema = {
	type: "emote_wall",
	category: "widgets",

	labelKey: "overlay.add_emote_wall",
	icon: () => <Icon name="smile" class="role-icon" />,
	order: 101,
	defaultProps: { ...DEFAULT_EMOTE_WALL_PROPS },
	/** `channels` is one composite control, not a bindField scalar. */
	propKeys: [
		"motion",
		"maxEmotes",
		"lifetime",
		"fontSize",
	],
	defaultSize: { width: 480, height: 480 },
	draw,
	editForm,
	validate,
	handles: "box",
	normalizeProps(props, read) {
		const d = DEFAULT_EMOTE_WALL_PROPS;
		return {
			channels: normalizeChannelRows(props.channels),
			motion: read.oneOf(
				"motion",
				["calm", "normal", "chaos", "bounce"],
				d.motion,
			),
			maxEmotes: read.num("maxEmotes", d.maxEmotes, 1, 200),
			lifetime: read.num("lifetime", d.lifetime, 1000, 120000),
			fontSize: read.num("fontSize", d.fontSize, 6, 400),
			fontFamily: read.str("fontFamily", d.fontFamily, 300),
		};
	},
};
