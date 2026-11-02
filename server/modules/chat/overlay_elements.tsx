/** @jsx m */
/*
 * The chat overlay element: embeds a chat module's live overlay page
 * (`/chat/<dashboardId>/<widgetId>?token=…`) in an OBS overlay scene. The
 * inspector offers the user's chat modules as one-click targets — the list is
 * fetched here, on demand, so the editor core knows nothing about chat.
 */

import { apiTry } from "@ui/api_client";
import { Icon } from "@ui/components/icons";
import { t } from "@ui/i18n";
import { FRONTS } from "@ui/module_registry";
import type {
	ElementContext,
	ElementProps,
	OverlayElement,
	OverlayElementDef,
} from "@ui/overlay/element";
import { drawIframe, numProp, strProp } from "@ui/overlay/element";
import { bindField } from "@ui/overlay/fields";
import type { Vnode } from "mithril";
import m from "mithril";
import { DEFAULT_CHAT_PROPS } from "./overlay_schema";

/** A chat module (a dashboard widget of type "chat") the picker can offer. */
interface ChatWidgetRef {
	dashboardId: string;
	widgetId: string;
	/** Widget name — the label shown in the picker. */
	name: string;
	/** Per-widget auth token; required to load the live chat page. */
	token: string;
}

/** Absolute URL of a chat module's live overlay page. The token lives in
 * the query string (no cookies) so OBS can load it in an external browser
 * source. */
function chatUrl(w: ChatWidgetRef): string {
	return (
		location.origin +
		"/chat/" +
		encodeURIComponent(w.dashboardId) +
		"/" +
		encodeURIComponent(w.widgetId) +
		"?token=" +
		encodeURIComponent(w.token)
	);
}

/** The user's chat modules; re-read whenever the picker mounts, so a
 * dashboard change shows up on reselect. */
let widgets: ChatWidgetRef[] = [];
let loading: Promise<void> | null = null;

function loadWidgets(): Promise<void> {
	loading ??= apiTry<{
		dashboards?: Array<{
			id: string;
			widgets?: Array<{
				id: string;
				type: string;
				name: string;
				config?: Record<string, string>;
			}>;
		}>;
	}>("/api/dashboards")
		.then((body) => {
			widgets = [];
			for (const d of body?.dashboards ?? [])
				for (const w of d.widgets ?? [])
					if (w.type === "chat")
						widgets.push({
							dashboardId: d.id,
							widgetId: w.id,
							name: w.name,
							token: w.config?.token ?? "",
						});
			m.redraw();
		})
		.finally(() => {
			loading = null;
		});
	return loading;
}

/** The inline live preview of a chat element's overlay page, resolved through
 * the module registry: the owning module recognizes the URL
 * (`parseOverlayUrl`) and renders its own feed (`overlayPreview`) directly in
 * the canvas DOM — no `<iframe>`, because Chromium composites every iframe on
 * an opaque white layer that a transparent editor canvas cannot show through.
 * URLs no module claims keep the plain iframe fallback. */
function overlayPreview(url: string): Vnode | undefined {
	for (const reg of FRONTS) {
		if (reg.kind !== "widget") continue;
		const target = reg.parseOverlayUrl?.(url);
		if (target && reg.overlayPreview) return reg.overlayPreview(target);
	}
	return undefined;
}

/** The element's feed text style. The live preview's `.chat-feed` sets its own
 * font rules, so these ride down as CSS custom properties (see
 * `styles.css`) rather than relying on plain inheritance. */
function chatTextProps(p: Record<string, unknown>) {
	return {
		fontSize: numProp(p, "fontSize", 48),
		fontFamily: strProp(p, "fontFamily", "Inter, system-ui, sans-serif"),
		color: strProp(p, "color", "#ffffff"),
		fontWeight: numProp(p, "fontWeight", 600),
		lineHeight: numProp(p, "lineHeight", 1.2),
		messageSpacing: numProp(p, "messageSpacing", 0),
		fadeDirection: [
			"off",
			"top",
			"bottom",
		].includes(strProp(p, "fadeDirection", "off"))
			? (strProp(p, "fadeDirection", "off") as "off" | "top" | "bottom")
			: "off",
		fadeSize: numProp(p, "fadeSize", 96),
		textAlign: [
			"left",
			"center",
			"right",
			"justify",
		].includes(strProp(p, "textAlign", "left"))
			? (strProp(p, "textAlign", "left") as
					| "left"
					| "center"
					| "right"
					| "justify")
			: "left",
	};
}

function draw(element: OverlayElement, _ctx: ElementContext): Vnode {
	const url = strProp(element.props, "url", "");
	const preview = overlayPreview(url);
	const t = chatTextProps(element.props);
	return m(
		`.chat-element${
			t.fadeDirection !== "off" ? ` chat-element-fade-${t.fadeDirection}` : ""
		}`,
		{
			style: {
				width: "100%",
				height: "100%",
				"--ov-chat-font-size": `${t.fontSize}px`,
				"--ov-chat-font-family": t.fontFamily,
				"--ov-chat-color": t.color,
				"--ov-chat-font-weight": `${t.fontWeight}`,
				"--ov-chat-line-height": `${t.lineHeight}`,
				"--ov-chat-message-gap": `${t.messageSpacing}px`,
				"--ov-chat-fade": `${t.fadeSize}px`,
				"--ov-chat-text-align": t.textAlign,
			},
		},
		[preview ?? (drawIframe(element) as Vnode)],
	);
}

/** The module picker: a closure component so it can trigger the fetch on
 * mount without the editor knowing. */
const ChatPicker: m.ClosureComponent<ElementProps> = () => {
	void loadWidgets();
	return {
		view: ({ attrs: { element: e, mutate, variables } }) => {
			const p = e.props;
			const sp = { mutate, variables };
			const current = String(p.url ?? "");
			const matched = widgets.find((w) => chatUrl(w) === current);
			return (
				<>
					{bindField(
						e,
						"props.url",
						t("overlay.chat_module"),
						<select
							value={matched ? matched.widgetId : ""}
							onchange={(ev: Event) => {
								const id = (ev.target as HTMLSelectElement).value;
								const w = widgets.find((c) => c.widgetId === id);
								if (w) mutate((el) => (el.props.url = chatUrl(w)));
							}}
						>
							{[
								// one flat keyed list: mithril rejects a keyed vnode next to a fragment
								<option key="" value="">
									{t("overlay.chat_no_module")}
								</option>,
								...widgets.map((w) => (
									<option key={w.widgetId} value={w.widgetId}>
										{w.name}
									</option>
								)),
							]}
						</select>,
						sp,
					)}
					<div class="ov-grid2">
						{bindField(
							e,
							"props.fontSize",
							t("overlay.font_size"),
							<input
								type="number"
								value={Number(p.fontSize ?? 48)}
								oninput={(ev: Event) =>
									mutate((el) => {
										el.props.fontSize = Number(
											(ev.target as HTMLInputElement).value,
										);
									})
								}
							/>,
							sp,
						)}
						{bindField(
							e,
							"props.color",
							t("overlay.color"),
							<input
								type="color"
								value={String(p.color ?? "#ffffff")}
								oninput={(ev: Event) =>
									mutate((el) => {
										el.props.color = (ev.target as HTMLInputElement)
											.value;
									})
								}
							/>,
							sp,
						)}
					</div>
					<div class="ov-grid2">
						{bindField(
							e,
							"props.fontWeight",
							t("overlay.font_weight"),
							<select
								value={String(p.fontWeight ?? 600)}
								onchange={(ev: Event) =>
									mutate((el) => {
										el.props.fontWeight = Number(
											(ev.target as HTMLSelectElement).value,
										);
									})
								}
							>
								<option value="400">400</option>
								<option value="600">600</option>
								<option value="700">700</option>
								<option value="900">900</option>
							</select>,
							sp,
						)}
						{bindField(
							e,
							"props.lineHeight",
							t("overlay.line_height"),
							<input
								type="number"
								value={Number(p.lineHeight ?? 1.2)}
								oninput={(ev: Event) =>
									mutate((el) => {
										el.props.lineHeight = Number(
											(ev.target as HTMLInputElement).value,
										);
									})
								}
							/>,
							sp,
						)}
					</div>
					<div class="ov-grid2">
						{bindField(
							e,
							"props.messageSpacing",
							t("overlay.message_spacing"),
							<input
								type="number"
								value={Number(p.messageSpacing ?? 0)}
								oninput={(ev: Event) =>
									mutate((el) => {
										el.props.messageSpacing = Number(
											(ev.target as HTMLInputElement).value,
										);
									})
								}
							/>,
							sp,
						)}
						{bindField(
							e,
							"props.fadeDirection",
							t("overlay.fade_direction"),
							<select
								value={String(p.fadeDirection ?? "off")}
								onchange={(ev: Event) =>
									mutate((el) => {
										el.props.fadeDirection = (
											ev.target as HTMLSelectElement
										).value;
									})
								}
							>
								<option value="off">{t("overlay.fade_direction.off")}</option>
								<option value="top">{t("overlay.fade_direction.top")}</option>
								<option value="bottom">
									{t("overlay.fade_direction.bottom")}
								</option>
							</select>,
							sp,
						)}
					</div>
					{bindField(
						e,
						"props.fadeSize",
						t("overlay.fade_size"),
						<input
							type="number"
							value={Number(p.fadeSize ?? 96)}
							oninput={(ev: Event) =>
								mutate((el) => {
									el.props.fadeSize = Number(
										(ev.target as HTMLInputElement).value,
									);
								})
							}
						/>,
						sp,
					)}
					{bindField(
						e,
						"props.textAlign",
						t("overlay.text_align"),
						<select
							value={String(p.textAlign ?? "left")}
							onchange={(ev: Event) =>
								mutate((el) => {
									el.props.textAlign = (
										ev.target as HTMLSelectElement
									).value;
								})
							}
						>
							<option value="left">{t("overlay.text_align.left")}</option>
							<option value="center">
								{t("overlay.text_align.center")}
							</option>
							<option value="right">
								{t("overlay.text_align.right")}
							</option>
							<option value="justify">
								{t("overlay.text_align.justify")}
							</option>
						</select>,
						sp,
					)}
					{bindField(
						e,
						"props.fontFamily",
						t("overlay.font_family"),
						<input
							type="text"
							value={String(p.fontFamily ?? "Inter, system-ui, sans-serif")}
							oninput={(ev: Event) =>
								mutate((el) => {
									el.props.fontFamily = (ev.target as HTMLInputElement)
										.value;
								})
							}
						/>,
						sp,
					)}
				</>
			);
		},
	};
};

function editForm(props: ElementProps): Vnode {
	return m(ChatPicker, props) as unknown as Vnode;
}

function validate(e: OverlayElement): string[] {
	const problems: string[] = [];
	if (typeof e.props.url !== "string") problems.push("url is not a string");
	const size = numProp(e.props, "fontSize", 48);
	if (!(size >= 1 && size <= 2000))
		problems.push("font size out of range (1–2000)");
	return problems;
}

export const chatElement: OverlayElementDef = {
	type: "chat",
	labelKey: "overlay.add_chat",
	icon: () => <Icon name="chat" class="role-icon" />,
	order: 70,
	defaultProps: { ...DEFAULT_CHAT_PROPS },
	propKeys: [
		"url",
		"fontSize",
		"fontFamily",
		"color",
		"fontWeight",
		"lineHeight",
		"messageSpacing",
		"fadeDirection",
		"fadeSize",
		"textAlign",
	],
	defaultSize: { width: 360, height: 480 },
	draw,
	editForm,
	validate,
	handles: "box",
};

export default [chatElement];
