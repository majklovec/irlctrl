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

export interface LineProps {
	/** the line's color */
	stroke: string;
	/** the line's thickness in px */
	strokeWidth: number;
	/**
	 * Which box diagonal the line runs along. The box is stored in
	 * min/abs form (negative deltas are impossible in CSS), so this flag
	 * disambiguates: false = top-left → bottom-right, true = top-right →
	 * bottom-left.
	 */
	flip: boolean;
}

export const DEFAULT_LINE_PROPS: Required<LineProps> = {
	stroke: "#3b82f6",
	strokeWidth: 4,
	flip: false,
};

/**
 * Which box diagonal a drag delta runs along. The box is stored in min/abs
 * form, so only the sign *combination* of the delta matters: same-sign
 * components (both forward, both backward) land on the same diagonal
 * (180° symmetry → flip = false); opposite signs land on the other one
 * (flip = true). A zero component is a box edge — no diagonal ambiguity.
 */
export const lineFlipFromDelta = (dx: number, dy: number): boolean =>
	dx * dy < 0;

function draw(element: OverlayElement, ctx: ElementContext): Vnode {
	// `element` is already resolved by the renderer, so both props and
	// transform carry any binding values — bound geometry works for free.
	const p = element.props;
	const t2 = element.transform;
	// draw a line through the box, oriented along its w/h delta
	const stroke = strProp(p, "stroke", DEFAULT_LINE_PROPS.stroke);
	const strokeWidth = numProp(p, "strokeWidth", DEFAULT_LINE_PROPS.strokeWidth);
	const length = Math.hypot(t2.width, t2.height);
	// The box is stored in min/abs form, so the slope's vertical sign comes
	// from props.flip: false = top-left → bottom-right, true = top-right →
	// bottom-left.
	const dy = p.flip === true ? -t2.height : t2.height;
	const angle = (Math.atan2(dy, t2.width) * 180) / Math.PI;
	const thickness = Math.max(1, strokeWidth || 4);
	return m(".overlay-shape", {
		style: {
			width: `${Math.max(1, length)}px`,
			height: `${thickness}px`,
			background: stroke,
			transform: `rotate(${angle}deg)`,
			left: "50%",
			top: "50%",
			// margin shorthand is top/right/bottom/left — the -length/2 must be on
			// the LEFT side so the bar's center (and rotation axis) lands on the
			// box center; the line then spans corner-to-corner of w/h
			margin: `${-(thickness / 2).toFixed(1)}px 0 0 ${-(Math.max(1, length) / 2).toFixed(1)}px`,
			position: "absolute",
		},
	});
}

function editForm({ element: e, mutate, variables, variableUrl }: ElementProps): Vnode {
	// A line is edited as two endpoints (see `handles`), so this form exposes
	// ONLY line properties — never the rectangle/ellipse fill+radius editing.
	return bindableForm({
		element: e,
		mutate,
		variables,
		variableUrl,
		rows: [
			[
				{
					path: "props.stroke",
					labelKey: "overlay.stroke",
					type: "color",
					value: strProp(e.props, "stroke", DEFAULT_LINE_PROPS.stroke),
				},
				{
					path: "props.strokeWidth",
					labelKey: "overlay.stroke_width",
					type: "number",
					value: numProp(
						e.props,
						"strokeWidth",
						DEFAULT_LINE_PROPS.strokeWidth,
					),
				},
			],
		],
	});
}

function validate(e: OverlayElement): string[] {
	const problems: string[] = [];
	const w = numProp(e.props, "strokeWidth", DEFAULT_LINE_PROPS.strokeWidth);
	if (w < 1 || w > 500) problems.push("stroke width out of range (1–500)");
	return problems;
}

export const lineElement: OverlayElementDef & OverlayElementSchema = {
	type: "line",
	category: "basics",

	labelKey: "overlay.add_line",
	icon: () => <Icon name="line" class="role-icon" />,
	order: 40,
	defaultProps: { ...DEFAULT_LINE_PROPS },
	propKeys: ["stroke", "strokeWidth", "flip"],
	defaultSize: { width: 240, height: 160 },
	draw,
	editForm,
	validate,
	// endpoints, not a box: a line is structurally two endpoints, so the
	// rectangle's 8-handle box editing can never be presented for it
	handles: "endpoints",
	onEndpointDrag: (e, dx, dy) => {
		e.props.flip = lineFlipFromDelta(dx, dy);
	},
	normalizeProps(_props, read) {
		const d = DEFAULT_LINE_PROPS;
		return {
			stroke: read.hex("stroke", d.stroke),
			strokeWidth: read.num("strokeWidth", d.strokeWidth, 1, 500),
			flip: read.bool("flip"),
		};
	},
};
