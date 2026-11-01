/** @jsx m */
import m from "mithril";
import type { Vnode } from "mithril";
import { DEFAULT_ELLIPSE_PROPS } from "../../../../shared/overlay";
import { t } from "../../../../shared/ui/i18n";
import type {
	ElementContext,
	ElementProps,
	OverlayElement,
	OverlayElementDef,
} from "./core";
import { strProp, numProp } from "./core";
import { bindField } from "./fields";

function draw(element: OverlayElement, ctx: ElementContext): Vnode {
	// `element` is already resolved by the renderer — props carry binding values.
	const p = element.props;
	const fill = strProp(p, "fill", DEFAULT_ELLIPSE_PROPS.fill);
	const stroke = strProp(p, "stroke", DEFAULT_ELLIPSE_PROPS.stroke);
	const strokeWidth = numProp(p, "strokeWidth", 0);
	return m(".overlay-shape", {
		style: {
			background: fill,
			border:
				strokeWidth > 0 ? `${strokeWidth}px solid ${stroke}` : undefined,
			borderRadius: "50%",
		},
	});
}

function editForm({ element: e, mutate, variables }: ElementProps): Vnode {
	const p = e.props;
	const sp = { mutate, variables };
	return (
		<>
			<div class="ov-grid2">
				{bindField(
					e,
					"props.fill",
					t("overlay.fill"),
					<input
						type="color"
						value={strProp(p, "fill", DEFAULT_ELLIPSE_PROPS.fill)}
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
					"props.stroke",
					t("overlay.stroke"),
					<input
						type="color"
						value={strProp(p, "stroke", DEFAULT_ELLIPSE_PROPS.stroke)}
						oninput={(ev: Event) =>
							mutate((el) => {
								el.props.stroke = (ev.target as HTMLInputElement).value;
							})
						}
					/>,
					sp,
				)}
			</div>
			{bindField(
				e,
				"props.strokeWidth",
				t("overlay.stroke_width"),
				<input
					type="number"
					value={numProp(p, "strokeWidth", 0)}
					oninput={(ev: Event) =>
						mutate((el) => {
							el.props.strokeWidth = Number(
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
	const w = numProp(e.props, "strokeWidth", 0);
	if (w < 0 || w > 500) problems.push("stroke width out of range (0–500)");
	return problems;
}

export const ellipseElement: OverlayElementDef = {
	type: "ellipse",
	defaultProps: { ...DEFAULT_ELLIPSE_PROPS },
	propKeys: ["fill", "stroke", "strokeWidth"],
	defaultSize: { width: 240, height: 160 },
	draw,
	editForm,
	validate,
	handles: "box",
};
