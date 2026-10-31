/** @jsx m */
import m from "mithril";
import type { Vnode } from "mithril";
import { DEFAULT_LINE_PROPS } from "../../../shared/overlay";
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
	const t2 = element.transform;
	// draw a line through the box, oriented along its w/h delta
	const stroke = strProp(p, "stroke", DEFAULT_LINE_PROPS.stroke);
	const strokeWidth = numProp(p, "strokeWidth", DEFAULT_LINE_PROPS.strokeWidth);
	const length = Math.hypot(t2.width, t2.height);
	const angle = (Math.atan2(t2.height, t2.width) * 180) / Math.PI;
	const thickness = Math.max(1, strokeWidth || 4);
	return m(".overlay-shape", {
		style: {
			width: `${Math.max(1, length)}px`,
			height: `${thickness}px`,
			background: stroke,
			transform: `rotate(${angle}deg)`,
			left: "50%",
			top: "50%",
			margin: `${(-(thickness / 2).toFixed(1))}px ${(-(Math.max(1, length) / 2).toFixed(1))}px 0 0`,
			position: "absolute",
		},
	});
}

function editForm({ element: e, mutate, variables }: ElementProps): Vnode {
	const p = e.props;
	// A line is edited as two endpoints (see `handles`), so this form exposes
	// ONLY line properties — never the rectangle/ellipse fill+radius editing.
	return (
		<>
			<div class="ov-grid2">
				<label class="ov-field">
					{lbl(t("overlay.stroke"))}
					<input
						type="color"
						value={strProp(p, "stroke", DEFAULT_LINE_PROPS.stroke)}
						oninput={(ev: Event) =>
							mutate((el) => {
								el.props.stroke = (ev.target as HTMLInputElement).value;
							})
						}
					/>
				</label>
				<label class="ov-field">
					{lbl(t("overlay.stroke_width"))}
					<input
						type="number"
						value={numProp(p, "strokeWidth", DEFAULT_LINE_PROPS.strokeWidth)}
						oninput={(ev: Event) =>
							mutate((el) => {
								el.props.strokeWidth = Number(
									(ev.target as HTMLInputElement).value,
								);
							})
						}
					/>
				</label>
			</div>
			{bindingRow(e, "stroke", { mutate, variables })}
		</>
	);
}

function validate(e: OverlayElement): string[] {
	const problems: string[] = [];
	const w = numProp(e.props, "strokeWidth", DEFAULT_LINE_PROPS.strokeWidth);
	if (w < 1 || w > 500) problems.push("stroke width out of range (1–500)");
	return problems;
}

export const lineElement: OverlayElementDef = {
	type: "line",
	defaultProps: { ...DEFAULT_LINE_PROPS },
	defaultSize: { width: 240, height: 160 },
	draw,
	editForm,
	validate,
	// endpoints, not a box: a line is structurally two endpoints, so the
	// rectangle's 8-handle box editing can never be presented for it
	handles: "endpoints",
};
