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
import { bindingRow, lbl } from "./fields";

function draw(element: OverlayElement, ctx: ElementContext): Vnode {
	return drawIframe(element, ctx) as Vnode;
}

function editForm({ element: e, mutate, variables }: ElementProps): Vnode {
	const current = String(e.props.url ?? "");
	return (
		<>
			<label class="ov-field">
				{lbl(t("overlay.iframe_url"))}
				<input
					type="text"
					value={current}
					oninput={(ev: Event) =>
						mutate((el) => {
							el.props.url = (ev.target as HTMLInputElement).value;
						})
					}
				/>
			</label>
			{bindingRow(e, "url", { mutate, variables })}
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
	defaultSize: { width: 360, height: 480 },
	draw,
	editForm,
	validate,
	handles: "box",
};
