/** @jsx m */
/*
 * The chat overlay element: embeds a chat module's live overlay page
 * (`/chat/<dashboardId>/<widgetId>?token=…`) in an OBS overlay scene. The
 * inspector offers the user's chat modules as one-click targets — the list is
 * fetched here, on demand, so the editor core knows nothing about chat.
 */
import m from "mithril";
import type { Vnode } from "mithril";
import { Icon } from "../../../shared/ui/components/icons";
import { t } from "../../../shared/ui/i18n";
import { FRONTS } from "../../../shared/ui/module_registry";
import type {
	ElementContext,
	ElementProps,
	OverlayElement,
	OverlayElementDef,
} from "../../../shared/ui/overlay/element";
import { drawIframe, strProp } from "../../../shared/ui/overlay/element";
import { bindField } from "../../../shared/ui/overlay/fields";
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
	loading ??= fetch("/api/dashboards", { cache: "no-store" })
		.then((res) => (res.ok ? res.json() : null))
		.then(
			(
				body: {
					dashboards?: Array<{
						id: string;
						widgets?: Array<{
							id: string;
							type: string;
							name: string;
							config?: Record<string, string>;
						}>;
					}>;
				} | null,
			) => {
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
			},
		)
		.catch(() => undefined)
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

function draw(element: OverlayElement, _ctx: ElementContext): Vnode {
	const url = strProp(element.props, "url", "");
	const preview = overlayPreview(url);
	return preview ?? (drawIframe(element) as Vnode);
}

/** The module picker: a closure component so it can trigger the fetch on
 * mount without the editor knowing. */
const ChatPicker: m.ClosureComponent<ElementProps> = () => {
	void loadWidgets();
	return {
		view: ({ attrs: { element: e, mutate, variables } }) => {
			const current = String(e.props.url ?? "");
			const matched = widgets.find((w) => chatUrl(w) === current);
			return bindField(
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
				{ mutate, variables },
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
	return problems;
}

export const chatElement: OverlayElementDef = {
	type: "chat",
	labelKey: "overlay.add_chat",
	icon: () => <Icon name="chat" class="role-icon" />,
	order: 70,
	defaultProps: { ...DEFAULT_CHAT_PROPS },
	propKeys: ["url"],
	defaultSize: { width: 360, height: 480 },
	draw,
	editForm,
	validate,
	handles: "box",
};

export default [chatElement];
