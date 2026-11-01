import m from "mithril";
import type { Vnode } from "mithril";
import { DEFAULT_CHAT_PROPS } from "../../../../shared/overlay";
import { t } from "../../../../shared/ui/i18n";
import { FRONTS } from "../../../../shared/ui/module_registry";
import type {
	ChatWidgetRef,
	ElementContext,
	ElementProps,
	OverlayElement,
	OverlayElementDef,
} from "./core";
import { drawIframe, strProp } from "./core";
import { bindField } from "./fields";

/** Absolute URL of a chat module's live overlay page.
 * The token lives in the query string (no cookies) so OBS can load it in an
 * external browser source. */
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

function draw(element: OverlayElement, _ctx: ElementContext): Vnode {
	const url = strProp(element.props, "url", "");
	const preview = overlayPreview(url);
	return preview ?? (drawIframe(element) as Vnode);
}

function editForm({
	element: e,
	mutate,
	variables,
	chatWidgets,
}: ElementProps): Vnode {
	const current = String(e.props.url ?? "");
	// Which chat module (if any) does the current URL point at?
	const matched = chatWidgets.find((w) => chatUrl(w) === current);
	return bindField(
		e,
		"props.url",
		t("overlay.chat_module"),
		m("select", {
			value: matched ? matched.widgetId : "",
			onchange: (ev: Event) => {
				const id = (ev.target as HTMLSelectElement).value;
				const w = chatWidgets.find((c) => c.widgetId === id);
				if (w) mutate((el) => (el.props.url = chatUrl(w)));
			},
		}, [
			m("option", { key: "", value: "" }, t("overlay.chat_no_module")),
			...chatWidgets.map((w) =>
				m("option", { key: w.widgetId, value: w.widgetId }, w.name),
			),
		]),
		{ mutate, variables },
	);
}

function validate(e: OverlayElement): string[] {
	const problems: string[] = [];
	if (typeof e.props.url !== "string")
		problems.push("url is not a string");
	return problems;
}

export const chatElement: OverlayElementDef = {
	type: "chat",
	defaultProps: { ...DEFAULT_CHAT_PROPS },
	propKeys: ["url"],
	defaultSize: { width: 360, height: 480 },
	draw,
	editForm,
	validate,
	handles: "box",
};
