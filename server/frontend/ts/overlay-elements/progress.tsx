/** @jsx m */
import m from "mithril";
import type { Vnode } from "mithril";
import { DEFAULT_PROGRESS_PROPS } from "../../../../shared/overlay";
import { t } from "../../../../shared/ui/i18n";
import type {
	ElementContext,
	ElementProps,
	OverlayElement,
	OverlayElementDef,
} from "./core";
import { strProp, numProp } from "./core";
import { bindField } from "./fields";

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
	const background = strProp(p, "background", DEFAULT_PROGRESS_PROPS.background);
	const radius = numProp(p, "radius", DEFAULT_PROGRESS_PROPS.radius);
	return m(
		".overlay-progress",
		{
			style: {
				width: "100%",
				height: "100%",
				background,
				borderRadius: `${radius}px`,
				boxSizing: "border-box",
				display: "flex",
			},
		},
		[
			m(".overlay-progress-fill", {
				key: "fill",
				style: {
					width: `${value}%`,
					height: "100%",
					background: fill,
					borderRadius: `${radius}px`,
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
								el.props.background =
									(ev.target as HTMLInputElement).value;
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
							el.props.radius = Number(
								(ev.target as HTMLInputElement).value,
							);
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
	defaultProps: { ...DEFAULT_PROGRESS_PROPS },
	propKeys: ["value", "fill", "background", "radius"],
	defaultSize: { width: 320, height: 40 },
	draw,
	editForm,
	validate,
	handles: "box",
};
