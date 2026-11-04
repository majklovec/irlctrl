/** @jsx m */

import { Icon } from "@ui/components/icons";
import { t } from "@ui/i18n";
import type {
	ElementContext,
	ElementProps,
	OverlayElement,
	OverlayElementDef,
} from "@ui/overlay/element";
import { numProp, strProp } from "@ui/overlay/element";
import { bindField } from "@ui/overlay/fields";
import type { Vnode } from "mithril";
import m from "mithril";
import { DEFAULT_PROGRESS_PROPS } from "../overlay_schema";

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

function editForm({ element: e, mutate, variables }: ElementProps): Vnode {
	const p = e.props;
	const sp = { mutate, variables };
	return (
		<>
			{bindField(
				e,
				"props.value",
				t("overlay.value"),
				<input
					type="number"
					min={0}
					max={100}
					value={numProp(p, "value", DEFAULT_PROGRESS_PROPS.value)}
					oninput={(ev: Event) =>
						mutate((el) => {
							el.props.value = Number((ev.target as HTMLInputElement).value);
						})
					}
				/>,
				sp,
			)}
			<div class="ov-grid2">
				{bindField(
					e,
					"props.fill",
					t("overlay.fill"),
					<input
						type="color"
						value={strProp(p, "fill", DEFAULT_PROGRESS_PROPS.fill)}
						oninput={(ev: Event) =>
							mutate((el) => {
								el.props.fill = (ev.target as HTMLInputElement).value;
							})
						}
					/>,
					sp,
				)}
				{bindField(
					e,
					"props.background",
					t("overlay.background"),
					<input
						type="color"
						value={strProp(p, "background", DEFAULT_PROGRESS_PROPS.background)}
						oninput={(ev: Event) =>
							mutate((el) => {
								el.props.background = (ev.target as HTMLInputElement).value;
							})
						}
					/>,
					sp,
				)}
			</div>
			{bindField(
				e,
				"props.radius",
				t("overlay.radius"),
				<input
					type="number"
					min={0}
					value={numProp(p, "radius", DEFAULT_PROGRESS_PROPS.radius)}
					oninput={(ev: Event) =>
						mutate((el) => {
							el.props.radius = Number((ev.target as HTMLInputElement).value);
						})
					}
				/>,
				sp,
			)}
		</>
	);
}

function validate(e: OverlayElement): string[] {
	const problems: string[] = [];
	const v = numProp(e.props, "value", DEFAULT_PROGRESS_PROPS.value);
	if (v < 0 || v > 100) problems.push("value out of range (0–100)");
	const r = numProp(e.props, "radius", DEFAULT_PROGRESS_PROPS.radius);
	if (r < 0 || r > 10000) problems.push("radius out of range (0–10000)");
	return problems;
}

export const progressElement: OverlayElementDef = {
	type: "progress",
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
};
