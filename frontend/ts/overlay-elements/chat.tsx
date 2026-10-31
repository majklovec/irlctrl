/** @jsx m */
import m from "mithril";
import type { Vnode } from "mithril";
import { DEFAULT_CHAT_PROPS } from "../../../shared/overlay";
import { t } from "../i18n";
import type {
	ChatWidgetRef,
	ElementContext,
	ElementProps,
	OverlayElement,
	OverlayElementDef,
} from "./core";
import { drawIframe } from "./core";
import { lbl } from "./fields";

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

function draw(element: OverlayElement, ctx: ElementContext): Vnode {
	return drawIframe(element, ctx) as Vnode;
}

function editForm({
	element: e,
	mutate,
	chatWidgets,
}: ElementProps): Vnode {
	const current = String(e.props.url ?? "");
	// Which chat module (if any) does the current URL point at?
	const matched = chatWidgets.find((w) => chatUrl(w) === current);
	return (
		<label class="ov-field">
			{lbl(t("overlay.chat_module"))}
			<select
				value={matched ? matched.widgetId : ""}
				onchange={(ev: Event) => {
					const id = (ev.target as HTMLSelectElement).value;
					const w = chatWidgets.find((c) => c.widgetId === id);
					if (w) mutate((el) => (el.props.url = chatUrl(w)));
				}}
			>
				<option value="">{t("overlay.chat_no_module")}</option>
				{chatWidgets.map((w) => (
					<option key={w.widgetId} value={w.widgetId}>
						{w.name}
					</option>
				))}
			</select>
		</label>
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
	defaultSize: { width: 360, height: 480 },
	draw,
	editForm,
	validate,
	handles: "box",
};
