/** @jsx m */
import m from "mithril";
import type { Vnode } from "mithril";
import { DEFAULT_IFRAME_PROPS } from "../../../shared/overlay";
import { t } from "../i18n";
import type {
	ElementContext,
	ElementProps,
	OverlayElement,
	OverlayElementDef,
} from "./core";
import { drawIframe } from "./core";
import { bindField } from "./fields";

function draw(element: OverlayElement, _ctx: ElementContext): Vnode {
	// `element` is already resolved by the renderer — drawIframe reads props.url.
	return drawIframe(element) as Vnode;
}

function editForm({ element: e, mutate, variables }: ElementProps): Vnode {
	const current = String(e.props.url ?? "");
	return (
		<>
			{bindField(
				e,
				"props.url",
				t("overlay.iframe_url"),
				<input
					type="text"
					value={current}
					oninput={(ev: Event) =>
						mutate((el) => {
							el.props.url = (ev.target as HTMLInputElement).value;
						})
					}
				/>,
				{ mutate, variables },
			)}
		</>
	);
}

function validate(e: OverlayElement): string[] {
	const problems: string[] = [];
	if (typeof e.props.url !== "string")
		problems.push("url is not a string");
	return problems;
}

export const iframeElement: OverlayElementDef = {
	type: "iframe",
	defaultProps: { ...DEFAULT_IFRAME_PROPS },
	propKeys: ["url"],
	defaultSize: { width: 360, height: 480 },
	draw,
	editForm,
	validate,
	handles: "box",
};
