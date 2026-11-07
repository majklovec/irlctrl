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

export interface ProgressProps {
	/** progress percentage, 0–100 */
	value: number;
	/** color of the filled portion */
	fill: string;
	/** color of the empty track behind the fill */
	background: string;
	/** corner radius in px (0 = square corners) */
	radius: number;
}

export const DEFAULT_PROGRESS_PROPS: Required<ProgressProps> = {
	value: 25,
	fill: "#22c55e",
	background: "#e5e7eb",
	radius: 6,
};

/** Clamp the (possibly bound) value into 0–100 so a bad variable can't widen
 * the fill past the track. */
function clampedValue(p: Record<string, unknown>): number {
	const v = numProp(p, "value", DEFAULT_PROGRESS_PROPS.value);
	return Math.max(0, Math.min(100, v));
}

function draw(element: OverlayElement, ctx: ElementContext): Vnode {
	// `element` is already resolved by the renderer — props carry binding values.
	const p = element.props;
	const value = clampedValue(p);
	const fill = strProp(p, "fill", DEFAULT_PROGRESS_PROPS.fill);
	const background = strProp(
		p,
		"background",
		DEFAULT_PROGRESS_PROPS.background,
	);
	const radius = numProp(p, "radius", DEFAULT_PROGRESS_PROPS.radius);
	// The fill is laid out with absolute positioning, NOT flexbox. OBS's
	// embedded Chromium (CEF) can collapse a flex container whose height
	// comes from a percentage chain and never repaint it, which made the bar
	// invisible in the stream while it rendered fine in a regular browser.
	// Positioning against the explicit-px wrapper sizes identically everywhere;
	// the track's overflow clips the fill to the rounded corners.
	return m(
		".overlay-progress",
		{
			style: {
				position: "relative",
				width: "100%",
				height: "100%",
				background,
				borderRadius: `${radius}px`,
				boxSizing: "border-box",
				overflow: "hidden",
			},
		},
		[
			m(".overlay-progress-fill", {
				key: "fill",
				style: {
					position: "absolute",
					left: 0,
					top: 0,
					width: `${value}%`,
					height: "100%",
					background: fill,
					transition: "width 120ms linear",
				},
			}),
		],
	);
}

function editForm({
	element: e,
	mutate,
	variables,
	variableUrl,
}: ElementProps): Vnode {
	return bindableForm({
		element: e,
		mutate,
		variables,
		variableUrl,
		rows: [
			[
				{
					path: "props.value",
					labelKey: "overlay.value",
					type: "number",
					min: 0,
					max: 100,
					value: numProp(e.props, "value", DEFAULT_PROGRESS_PROPS.value),
				},
			],
			[
				{
					path: "props.fill",
					labelKey: "overlay.fill",
					type: "color",
					value: strProp(e.props, "fill", DEFAULT_PROGRESS_PROPS.fill),
				},
				{
					path: "props.background",
					labelKey: "overlay.background",
					type: "color",
					value: strProp(
						e.props,
						"background",
						DEFAULT_PROGRESS_PROPS.background,
					),
				},
			],
			[
				{
					path: "props.radius",
					labelKey: "overlay.radius",
					type: "number",
					min: 0,
					value: numProp(e.props, "radius", DEFAULT_PROGRESS_PROPS.radius),
				},
			],
		],
	});
}

function validate(e: OverlayElement): string[] {
	const problems: string[] = [];
	const v = numProp(e.props, "value", DEFAULT_PROGRESS_PROPS.value);
	if (v < 0 || v > 100) problems.push("value out of range (0–100)");
	const r = numProp(e.props, "radius", DEFAULT_PROGRESS_PROPS.radius);
	if (r < 0 || r > 10000) problems.push("radius out of range (0–10000)");
	return problems;
}

export const progressElement: OverlayElementDef & OverlayElementSchema = {
	type: "progress",
	category: "widgets",

	labelKey: "overlay.add_progress",
	icon: () => <Icon name="progress" class="role-icon" />,
	order: 50,
	defaultProps: { ...DEFAULT_PROGRESS_PROPS },
	propKeys: ["value", "fill", "background", "radius"],
	defaultSize: { width: 320, height: 40 },
	draw,
	editForm,
	validate,
	handles: "box",
	normalizeProps(_props, read) {
		const d = DEFAULT_PROGRESS_PROPS;
		return {
			value: read.num("value", d.value, 0, 100),
			fill: read.hex("fill", d.fill),
			background: read.hex("background", d.background),
			radius: read.num("radius", d.radius, 0, 10000),
		};
	},
};
