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

/** Rectangle / ellipse / line are distinct element types; each carries its
 * own (slimmer) prop set instead of one `shape` discriminator. */
export interface RectangleProps {
	fill: string;
	stroke: string;
	strokeWidth: number;
	/** corner radius in px (0 = square corners) */
	radius: number;
}

export const DEFAULT_RECTANGLE_PROPS: Required<RectangleProps> = {
	fill: "#3b82f6",
	stroke: "#000000",
	strokeWidth: 0,
	radius: 0,
};

function draw(element: OverlayElement, ctx: ElementContext): Vnode {
	// `element` is already resolved by the renderer — props carry binding values.
	const p = element.props;
	const fill = strProp(p, "fill", DEFAULT_RECTANGLE_PROPS.fill);
	const stroke = strProp(p, "stroke", DEFAULT_RECTANGLE_PROPS.stroke);
	const strokeWidth = numProp(p, "strokeWidth", 0);
	const radius = numProp(p, "radius", DEFAULT_RECTANGLE_PROPS.radius);
	return m(".overlay-shape", {
		style: {
			background: fill,
			border: strokeWidth > 0 ? `${strokeWidth}px solid ${stroke}` : undefined,
			borderRadius: `${radius}px`,
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
					value: strProp(e.props, "fill", DEFAULT_RECTANGLE_PROPS.fill),
				},
				{
					path: "props.stroke",
					labelKey: "overlay.stroke",
					type: "color",
					value: strProp(e.props, "stroke", DEFAULT_RECTANGLE_PROPS.stroke),
				},
			],
			[
				{
					path: "props.strokeWidth",
					labelKey: "overlay.stroke_width",
					type: "number",
					value: numProp(e.props, "strokeWidth", 0),
				},
				{
					path: "props.radius",
					labelKey: "overlay.radius",
					type: "number",
					min: 0,
					value: numProp(e.props, "radius", DEFAULT_RECTANGLE_PROPS.radius),
				},
			],
		],
	});
}

function validate(e: OverlayElement): string[] {
	const problems: string[] = [];
	const w = numProp(e.props, "strokeWidth", 0);
	if (w < 0 || w > 500) problems.push("stroke width out of range (0–500)");
	const r = numProp(e.props, "radius", DEFAULT_RECTANGLE_PROPS.radius);
	if (r < 0 || r > 10000) problems.push("radius out of range (0–10000)");
	return problems;
}

export const rectangleElement: OverlayElementDef & OverlayElementSchema = {
	type: "rectangle",
	category: "basics",

	labelKey: "overlay.add_rectangle",
	icon: () => <Icon name="rectangle" class="role-icon" />,
	order: 20,
	defaultProps: { ...DEFAULT_RECTANGLE_PROPS },
	propKeys: ["fill", "stroke", "strokeWidth", "radius"],
	defaultSize: { width: 240, height: 160 },
	draw,
	editForm,
	validate,
	handles: "box",
	normalizeProps(_props, read) {
		const d = DEFAULT_RECTANGLE_PROPS;
		return {
			fill: read.hex("fill", d.fill),
			stroke: read.hex("stroke", d.stroke),
			strokeWidth: read.num("strokeWidth", d.strokeWidth, 0, 500),
			radius: read.num("radius", d.radius, 0, 10000),
		};
	},
};
