/** @jsx m */

import { Icon } from "@ui/components/icons";
import type {
	ElementContext,
	ElementProps,
	OverlayElement,
	OverlayElementDef,
} from "@ui/overlay/element";
import { numProp, strProp } from "@ui/overlay/element";
import { bindableForm } from "@ui/overlay/fields";
import type { Vnode } from "mithril";
import m from "mithril";
import type { OverlayElementSchema } from "../../../../../core/overlay_element";

export interface EllipseProps {
	fill: string;
	stroke: string;
	strokeWidth: number;
}

export const DEFAULT_ELLIPSE_PROPS: Required<EllipseProps> = {
	fill: "#3b82f6",
	stroke: "#000000",
	strokeWidth: 0,
};

function draw(element: OverlayElement, ctx: ElementContext): Vnode {
	// `element` is already resolved by the renderer — props carry binding values.
	const p = element.props;
	const fill = strProp(p, "fill", DEFAULT_ELLIPSE_PROPS.fill);
	const stroke = strProp(p, "stroke", DEFAULT_ELLIPSE_PROPS.stroke);
	const strokeWidth = numProp(p, "strokeWidth", 0);
	return m(".overlay-shape", {
		style: {
			background: fill,
			border: strokeWidth > 0 ? `${strokeWidth}px solid ${stroke}` : undefined,
			borderRadius: "50%",
		},
	});
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
					path: "props.fill",
					labelKey: "overlay.fill",
					type: "color",
					value: strProp(e.props, "fill", DEFAULT_ELLIPSE_PROPS.fill),
				},
				{
					path: "props.stroke",
					labelKey: "overlay.stroke",
					type: "color",
					value: strProp(e.props, "stroke", DEFAULT_ELLIPSE_PROPS.stroke),
				},
			],
			[
				{
					path: "props.strokeWidth",
					labelKey: "overlay.stroke_width",
					type: "number",
					value: numProp(e.props, "strokeWidth", 0),
				},
			],
		],
	});
}

function validate(e: OverlayElement): string[] {
	const problems: string[] = [];
	const w = numProp(e.props, "strokeWidth", 0);
	if (w < 0 || w > 500) problems.push("stroke width out of range (0–500)");
	return problems;
}

export const ellipseElement: OverlayElementDef & OverlayElementSchema = {
	type: "ellipse",
	category: "basics",

	labelKey: "overlay.add_ellipse",
	icon: () => <Icon name="ellipse" class="role-icon" />,
	order: 30,
	defaultProps: { ...DEFAULT_ELLIPSE_PROPS },
	propKeys: ["fill", "stroke", "strokeWidth"],
	defaultSize: { width: 240, height: 160 },
	draw,
	editForm,
	validate,
	handles: "box",
	normalizeProps(_props, read) {
		const d = DEFAULT_ELLIPSE_PROPS;
		return {
			fill: read.hex("fill", d.fill),
			stroke: read.hex("stroke", d.stroke),
			strokeWidth: read.num("strokeWidth", d.strokeWidth, 0, 500),
		};
	},
};
