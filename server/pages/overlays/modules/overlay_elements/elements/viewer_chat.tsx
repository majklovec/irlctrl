/** @jsx m */
/*
 * Viewer-chat widget — a compact live chat feed (the most recent N lines of
 * the element's channels) for a "chat corner" in the scene. Unlike the full
 * `chat` element it is a lightweight widget: fixed line count, no fade/badge
 * options, sender name optional. Fed by the shared `LiveChatFeed` connector
 * (the overlay's token-scoped chat WebSocket).
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
import { DEFAULT_VIEWER_CHAT_PROPS } from "../overlay_schema";
import {
	ChatLine,
	LiveChatFeed,
	normalizeChannels,
} from "../lib/live_chat_feed";
import { ChannelsField } from "../lib/list_field";

function draw(element: OverlayElement, ctx: ElementContext): Vnode<any, any> {
	const p = element.props;
	const channels = normalizeChannels(p.channels);
	const maxLines = numProp(p, "maxLines", 8);
	const order = strProp(p, "order", "top");
	const showName = p.showName === true;
	const color = strProp(p, "color", "#ffffff");
	const background = strProp(p, "background", "#111827");
	const radius = numProp(p, "radius", 8);
	const fontSize = numProp(p, "fontSize", 20);
	const fontFamily = strProp(p, "fontFamily", "Inter, system-ui, sans-serif");
	const lineSpacing = numProp(p, "lineSpacing", 4);

	return m(LiveChatFeed, {
		token: ctx.token ?? "",
		overlayId: ctx.overlayId ?? "",
		channels,
		render({ lines }: { ready: boolean; lines: ChatLine[] }) {
			// Newest last → show the latest `maxLines`; `order` picks which
			// end of the box the newest line sits at.
			const recent = lines.slice(-maxLines);
			const shown = order === "top" ? recent.slice().reverse() : recent;
			return (
				<div
					style={{
						width: "100%",
						height: "100%",
						boxSizing: "border-box",
						display: "flex",
						flexDirection: "column",
						justifyContent: order === "top" ? "flex-start" : "flex-end",
						gap: `${lineSpacing}px`,
						overflow: "hidden",
						background: background,
						borderRadius: `${radius}px`,
						color,
						fontFamily,
						fontSize: `${fontSize}px`,
						padding: `${Math.round(fontSize * 0.4)}px ${Math.round(fontSize * 0.5)}px`,
						lineHeight: 1.35,
					}}
				>
					{shown.map((line) => (
						m(
							"div",
							{
								key: `${line.spec}:${String(line.msg.id)}`,
								style: {
									minWidth: 0,
									overflow: "hidden",
									textOverflow: "ellipsis",
								},
							},
							showName && line.msg.username
								? [
										m(
											"span",
											{
												style: {
													fontWeight: "700",
													color:
														line.msg.color &&
														/^#[0-9a-f]{3,8}$/i.test(
															line.msg.color,
														)
															? line.msg.color
															: undefined,
												},
											},
											`${line.msg.username}: `,
										),
										m(
											"span",
											{ style: { wordBreak: "break-word" } },
											line.msg.text ?? "",
										),
								  ]
								: m(
										"span",
										{ style: { wordBreak: "break-word" } },
										line.msg.text ?? "",
								  ),
						)
					))}
				</div>
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
	const setSel = (key: string) => (ev: Event) =>
		mutate((el) => {
			el.props[key] = (ev.target as HTMLSelectElement).value;
		});
	const setBool = (key: string) => (ev: Event) =>
		mutate((el) => {
			el.props[key] = (ev.target as HTMLInputElement).checked;
		});
	const setStr = (key: string) => (ev: Event) =>
		mutate((el) => {
			el.props[key] = (ev.target as HTMLInputElement).value;
		});
	return (
		<>
			<ChannelsField element={e} mutate={mutate} variables={variables} />
			<div class="ov-grid2">
				{bindField(e, "props.maxLines", t("overlay.vc_max_lines"),
					<input type="number" min={1} max={100} value={numProp(p, "maxLines", 8)} oninput={setNum("maxLines")} />, sp)}
				{bindField(e, "props.order", t("overlay.vc_order"),
					<select value={strProp(p, "order", "top")} onchange={setSel("order")}>
						<option value="top">{t("dash.widget_order.top")}</option>
						<option value="bottom">{t("dash.widget_order.bottom")}</option>
					</select>, sp)}
			</div>
			{bindField(e, "props.showName", t("overlay.vc_show_name"),
				<input type="checkbox" checked={p.showName === true} onchange={setBool("showName")} />, sp)}
			<div class="ov-grid2">
				{bindField(e, "props.color", t("overlay.color"),
					<input type="color" value={strProp(p, "color", "#ffffff")} oninput={setStr("color")} />, sp)}
				{bindField(e, "props.background", t("overlay.vc_background"),
					<input type="color" value={strProp(p, "background", "#111827")} oninput={setStr("background")} />, sp)}
			</div>
			<div class="ov-grid2">
				{bindField(e, "props.fontSize", t("overlay.font_size"),
					<input type="number" min={8} max={200} value={numProp(p, "fontSize", 20)} oninput={setNum("fontSize")} />, sp)}
				{bindField(e, "props.lineSpacing", t("overlay.vc_line_spacing"),
					<input type="number" min={0} max={100} value={numProp(p, "lineSpacing", 4)} oninput={setNum("lineSpacing")} />, sp)}
			</div>
		</>
	);
}

function validate(e: OverlayElement): string[] {
	return [];
}

export const viewerChatElement: OverlayElementDef = {
	type: "viewer_chat",
	labelKey: "overlay.add_viewer_chat",
	icon: () => <Icon name="smile" class="role-icon" />,
	order: 104,
	defaultProps: { ...DEFAULT_VIEWER_CHAT_PROPS },
	/** `channels` is one composite control, not a bindField scalar. */
	propKeys: [
		"maxLines",
		"order",
		"showName",
		"color",
		"background",
		"fontSize",
		"lineSpacing",
	],
	defaultSize: { width: 380, height: 300 },
	draw,
	editForm,
	validate,
	handles: "box",
};
