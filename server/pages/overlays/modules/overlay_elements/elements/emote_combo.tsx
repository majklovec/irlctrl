/** @jsx m */
/*
 * Emote-combo widget — counts repeated chat messages inside a rolling window
 * and shows a "×N <message>" hype bar when the count reaches the threshold
 * (KOMU/POG storm call-outs). The streak state is module-scoped per element
 * id (Mithril re-creates `draw` per render, so a render-closure state would
 * reset); each new matching message bumps the streak, any other message (or
 * an out-of-window gap) resets it.
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
import { DEFAULT_EMOTE_COMBO_PROPS } from "../overlay_schema";
import {
	ChatLine,
	LiveChatFeed,
	normalizeChannels,
} from "../lib/live_chat_feed";
import { ChannelsField } from "../lib/list_field";

/** Per-element combo streak (mutated by the feed callback; `m.redraw()`
 * re-renders the box, which reads these fields). */
interface ComboTracker {
	text: string;
	count: number;
	lastAt: number;
	timer: ReturnType<typeof setTimeout> | undefined;
}

const trackers = new Map<string, ComboTracker>();

function draw(element: OverlayElement, ctx: ElementContext): Vnode<any, any> {
	const p = element.props;
	const channels = normalizeChannels(p.channels);
	const windowMs = numProp(p, "windowSec", 5) * 1000;

	const st: ComboTracker =
		trackers.get(element.id) ?? { text: "", count: 0, lastAt: 0, timer: undefined };
	trackers.set(element.id, st);

	const onLine = (line: ChatLine): void => {
		const now = Date.now();
		const text = (line.msg.text ?? "").trim();
		if (!text) return;
		if (text === st.text && now - st.lastAt <= windowMs) {
			st.count += 1;
		} else {
			st.text = text;
			st.count = 1;
		}
		st.lastAt = now;
		// Reset after the window lapses with no further matches.
		if (st.timer) clearTimeout(st.timer);
		st.timer = setTimeout(() => {
			st.count = 0;
			st.text = "";
			m.redraw();
		}, windowMs + 250);
		m.redraw();
	};

	return m(LiveChatFeed, {
		token: ctx.token ?? "",
		overlayId: ctx.overlayId ?? "",
		channels,
		onMessage: onLine,
		render() {
			const threshold = numProp(p, "threshold", 3);
			const color = strProp(p, "color", "#ffffff");
			const accent = strProp(p, "accent", "#ffd700");
			const background = strProp(p, "background", "#111827");
			const radius = numProp(p, "radius", 10);
			const fontSize = numProp(p, "fontSize", 28);
			const fontFamily = strProp(p, "fontFamily", "Inter, system-ui, sans-serif");
			const active = st.count >= threshold && st.text !== "";
			return (
				m(
					"div",
					{
						onremove: () => {
							// The element left the scene — drop its tracker.
							if (st.timer) clearTimeout(st.timer);
							trackers.delete(element.id);
						},
						style: {
							width: "100%",
							height: "100%",
							boxSizing: "border-box",
							display: "flex",
							alignItems: "center",
							justifyContent: "center",
							gap: `${Math.round(fontSize * 0.4)}px`,
							background,
							border: `2px solid ${active ? accent : "transparent"}`,
							borderRadius: `${radius}px`,
							color,
							fontFamily,
							opacity: active ? 1 : 0.3,
							padding: `${fontSize * 0.4}px`,
							overflow: "hidden",
						},
					},
					active
						? [
								m(
									"span",
									{
										key: "n",
										style: {
											fontSize: `${Math.round(fontSize * 1.3)}px`,
											fontWeight: "900",
											color: accent,
											fontVariantNumeric: "tabular-nums",
										},
									},
									`×${st.count}`,
								),
								m(
									"span",
									{
										key: "t",
										style: {
											fontSize: `${fontSize}px`,
											fontWeight: "700",
											overflow: "hidden",
											textOverflow: "ellipsis",
											whiteSpace: "nowrap",
										},
									},
									st.text,
								),
						  ]
						: m("span", { key: "w", style: { opacity: "0.7" } }, t("overlay.ec_waiting")),
				)
			);
		},
	});
}

function editForm({ element: e, mutate, variables }: ElementProps): Vnode {
	const p = e.props;
	const sp = { mutate, variables };
	const setNum = (key: string) => (ev: Event) =>
		mutate((el) => {
			el.props[key] = Number((ev.target as HTMLInputElement).value);
		});
	const setStr = (key: string) => (ev: Event) =>
		mutate((el) => {
			el.props[key] = (ev.target as HTMLInputElement).value;
		});
	return (
		<>
			<ChannelsField element={e} mutate={mutate} variables={variables} />
			<div class="ov-grid2">
				{bindField(e, "props.windowSec", t("overlay.ec_window"),
					<input type="number" min={1} max={120} value={numProp(p, "windowSec", 5)} oninput={setNum("windowSec")} />, sp)}
				{bindField(e, "props.threshold", t("overlay.ec_threshold"),
					<input type="number" min={2} max={1000} value={numProp(p, "threshold", 3)} oninput={setNum("threshold")} />, sp)}
			</div>
			<div class="ov-grid3">
				{bindField(e, "props.color", t("overlay.color"),
					<input type="color" value={strProp(p, "color", "#ffffff")} oninput={setStr("color")} />, sp)}
				{bindField(e, "props.accent", t("overlay.ec_accent"),
					<input type="color" value={strProp(p, "accent", "#ffd700")} oninput={setStr("accent")} />, sp)}
				{bindField(e, "props.background", t("overlay.ec_background"),
					<input type="color" value={strProp(p, "background", "#111827")} oninput={setStr("background")} />, sp)}
			</div>
			{bindField(e, "props.fontSize", t("overlay.font_size"),
				<input type="number" min={8} max={200} value={numProp(p, "fontSize", 28)} oninput={setNum("fontSize")} />, sp)}
		</>
	);
}

function validate(e: OverlayElement): string[] {
	return [];
}

export const emoteComboElement: OverlayElementDef = {
	type: "emote_combo",
	labelKey: "overlay.add_emote_combo",
	icon: () => <Icon name="hash" class="role-icon" />,
	order: 102,
	defaultProps: { ...DEFAULT_EMOTE_COMBO_PROPS },
	/** `channels` is one composite control, not a bindField scalar. */
	propKeys: [
		"windowSec",
		"threshold",
		"color",
		"accent",
		"background",
		"fontSize",
	],
	defaultSize: { width: 360, height: 100 },
	draw,
	editForm,
	validate,
	handles: "box",
};
