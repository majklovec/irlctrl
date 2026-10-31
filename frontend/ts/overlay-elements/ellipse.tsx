/** @jsx m */
import m from "mithril";
import type { Vnode } from "mithril";
import { DEFAULT_ELLIPSE_PROPS } from "../../../shared/overlay";
import { t } from "../i18n";
import type {
	ElementContext,
	ElementProps,
	OverlayElement,
	OverlayElementDef,
} from "./core";
import { resolveElementProps, strProp, numProp } from "./core";
import { bindingRow, lbl } from "./fields";

function draw(element: OverlayElement, ctx: ElementContext): Vnode {
	const p = resolveElementProps(element, ctx.variables);
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
	return (
		<>
			<div class="ov-grid2">
				<label class="ov-field">
					{lbl(t("overlay.fill"))}
					<input
						type="color"
						value={strProp(p, "fill", DEFAULT_ELLIPSE_PROPS.fill)}
						oninput={(ev: Event) =>
							mutate((el) => {
								el.props.fill = (ev.target as HTMLInputElement).value;
							})
						}
					/>
				</label>
				<label class="ov-field">
					{lbl(t("overlay.stroke"))}
					<input
						type="color"
						value={strProp(p, "stroke", DEFAULT_ELLIPSE_PROPS.stroke)}
						oninput={(ev: Event) =>
							mutate((el) => {
								el.props.stroke = (ev.target as HTMLInputElement).value;
							})
						}
					/>
				</label>
			</div>
			<label class="ov-field">
				{lbl(t("overlay.stroke_width"))}
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
				/>
			</label>
			{bindingRow(e, "fill", { mutate, variables })}
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
	defaultSize: { width: 240, height: 160 },
	draw,
	editForm,
	validate,
	handles: "box",
};
