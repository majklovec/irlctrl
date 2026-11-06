/** @jsx m */

import { Icon } from "@ui/components/icons";
import type {
	ElementContext,
	ElementProps,
	OverlayElement,
	OverlayElementDef,
} from "@ui/overlay/element";
import { drawIframe, strProp } from "@ui/overlay/element";
import { bindableForm } from "@ui/overlay/fields";
import type { Vnode } from "mithril";
import m from "mithril";
import type { OverlayElementSchema } from "../../../../../core/overlay_element";

export interface IframeProps {
	/** The page to embed. Any absolute URL; `""` renders a placeholder box. */
	url: string;
}

export const DEFAULT_IFRAME_PROPS: Required<IframeProps> = { url: "" };

function draw(element: OverlayElement, _ctx: ElementContext): Vnode {
	// `element` is already resolved by the renderer — drawIframe reads props.url.
	return drawIframe(element) as Vnode;
}

function editForm({ element: e, mutate, variables, variableUrl }: ElementProps): Vnode {
	return bindableForm({
		element: e,
		mutate,
		variables,
		variableUrl,
		rows: [
			[
				{
					path: "props.url",
					labelKey: "overlay.iframe_url",
					type: "text",
					value: strProp(e.props, "url", DEFAULT_IFRAME_PROPS.url),
				},
			],
		],
	});
}

function validate(e: OverlayElement): string[] {
	const problems: string[] = [];
	if (typeof e.props.url !== "string") problems.push("url is not a string");
	return problems;
}

export const iframeElement: OverlayElementDef & OverlayElementSchema = {
	type: "iframe",
	category: "media",

	labelKey: "overlay.add_iframe",
	icon: () => <Icon name="iframe" class="role-icon" />,
	order: 80,
	defaultProps: { ...DEFAULT_IFRAME_PROPS },
	propKeys: ["url"],
	defaultSize: { width: 360, height: 480 },
	draw,
	editForm,
	validate,
	handles: "box",
	normalizeProps(_props, read) {
		return { url: read.str("url", "") };
	},
};
