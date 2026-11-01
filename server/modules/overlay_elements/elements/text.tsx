/** @jsx m */
import m from "mithril";
import { Icon } from "../../../../shared/ui/components/icons";
import type { Vnode } from "mithril";
import { DEFAULT_TEXT_PROPS } from "../overlay_schema";
import { t } from "../../../../shared/ui/i18n";
import type {
	ElementContext,
	ElementProps,
	OverlayElement,
	OverlayElementDef,
} from "../../../../shared/ui/overlay/element";
import { strProp, numProp } from "../../../../shared/ui/overlay/element";
import { bindField } from "../../../../shared/ui/overlay/fields";

interface TextProps {
	text: string;
	fontSize: number;
	fontFamily: string;
	color: string;
	fontWeight: number;
	lineHeight: number;
	textAlign: "left" | "center" | "right";
}

function textProps(p: Record<string, unknown>): TextProps {
	const align = p.textAlign;
	return {
		text: strProp(p, "text", ""),
		fontSize: numProp(p, "fontSize", 48),
		fontFamily: strProp(p, "fontFamily", "Inter, system-ui, sans-serif"),
		color: strProp(p, "color", "#ffffff"),
		fontWeight: numProp(p, "fontWeight", 600),
		lineHeight: numProp(p, "lineHeight", 1.2),
		textAlign:
			align === "center" || align === "right" ? align : "left",
	};
}

function draw(element: OverlayElement, ctx: ElementContext): Vnode {
	// `element` is already resolved by the renderer — props carry binding values.
	const props = textProps(element.props);
	return m(
		".overlay-text",
		{
			style: {
				fontFamily: props.fontFamily,
				fontSize: `${props.fontSize}px`,
				color: props.color,
				fontWeight: `${props.fontWeight}`,
				lineHeight: `${props.lineHeight}`,
				justifyContent:
					props.textAlign === "left"
						? "flex-start"
						: props.textAlign === "center"
							? "center"
							: "flex-end",
			},
		},
		props.text ?? "",
	);
}

function editForm({ element: e, mutate, variables }: ElementProps): Vnode {
	const p = e.props;
	const sp = { mutate, variables };
	return (
		<>
			{bindField(
				e,
				"props.text",
				t("overlay.text"),
				<input
					type="text"
					value={String(p.text ?? "")}
					oninput={(ev: Event) =>
						mutate((el) => {
							el.props.text = (ev.target as HTMLInputElement).value;
						})
					}
				/>,
				sp,
			)}
			<div class="ov-grid2">
				{bindField(
					e,
					"props.fontSize",
					t("overlay.font_size"),
					<input
						type="number"
						value={Number(p.fontSize ?? 48)}
						oninput={(ev: Event) =>
							mutate((el) => {
								el.props.fontSize = Number(
									(ev.target as HTMLInputElement).value,
								);
							})
						}
					/>,
					sp,
				)}
				{bindField(
					e,
					"props.color",
					t("overlay.color"),
					<input
						type="color"
						value={String(p.color ?? "#ffffff")}
						oninput={(ev: Event) =>
							mutate((el) => {
								el.props.color = (ev.target as HTMLInputElement).value;
							})
						}
					/>,
					sp,
				)}
			</div>
			<div class="ov-grid2">
				{bindField(
					e,
					"props.fontWeight",
					t("overlay.font_weight"),
					<select
						value={String(p.fontWeight ?? 600)}
						onchange={(ev: Event) =>
							mutate((el) => {
								el.props.fontWeight = Number(
									(ev.target as HTMLSelectElement).value,
								);
							})
						}
					>
						<option value="400">400</option>
						<option value="600">600</option>
						<option value="700">700</option>
						<option value="900">900</option>
					</select>,
					sp,
				)}
				{bindField(
					e,
					"props.textAlign",
					t("overlay.align"),
					<select
						value={String(p.textAlign ?? "left")}
						onchange={(ev: Event) =>
							mutate((el) => {
								el.props.textAlign = (
									ev.target as HTMLSelectElement
								).value;
							})
						}
					>
						<option value="left">left</option>
						<option value="center">center</option>
						<option value="right">right</option>
					</select>,
					sp,
				)}
			</div>
		</>
	);
}

function validate(e: OverlayElement): string[] {
	const problems: string[] = [];
	if (typeof e.props.text !== "string")
		problems.push("text is not a string");
	const size = numProp(e.props, "fontSize", 48);
	if (!(size >= 1 && size <= 2000))
		problems.push("font size out of range (1–2000)");
	return problems;
}

export const textElement: OverlayElementDef = {
	type: "text",
	labelKey: "overlay.add_text",
	icon: () => <Icon name="text" class="role-icon" />,
	order: 10,
	defaultProps: { ...DEFAULT_TEXT_PROPS },
	propKeys: [
		"text",
		"fontSize",
		"fontFamily",
		"color",
		"fontWeight",
		"lineHeight",
		"textAlign",
	],
	defaultSize: { width: 320, height: 80 },
	draw,
	editForm,
	validate,
	handles: "box",
	// double-click edits the text in place, in the element's own font
	inlineEdit: {
		prop: "text",
		style: (p) => {
			const props = textProps(p);
			return {
				fontFamily: props.fontFamily,
				fontSize: `${props.fontSize}px`,
				fontWeight: `${props.fontWeight}`,
				lineHeight: `${props.lineHeight}`,
				color: props.color,
				textAlign: props.textAlign,
			};
		},
	},
};
