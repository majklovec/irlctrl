/** @jsx m */
/*
 * Frame widget — a decorative border around whatever it is placed over
 * (typically a camera): a colored edge with an optional corner label. The
 * element is transparent in the middle; the "background" prop only fills the
 * padding ring when set ("" = fully transparent centre).
 */

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

/* ── frame ────────────────────────────────────────────────────────────── */
export interface FrameProps {
	border: string;
	borderWidth: number;
	borderStyle: "solid" | "dashed" | "double";
	cornerRadius: number;
	/** The corner/padding fill; "" = fully transparent centre. */
	background: string;
	/** A label pinned in a corner ("" = none). */
	label: string;
	color: string;
	fontSize: number;
	fontFamily: string;
}
export const DEFAULT_FRAME_PROPS: Required<FrameProps> = {
	border: "#f59e0b",
	borderWidth: 8,
	borderStyle: "solid",
	cornerRadius: 0,
	background: "",
	label: "LIVE",
	color: "#ffffff",
	fontSize: 22,
	fontFamily: "Inter, system-ui, sans-serif",
};

function draw(element: OverlayElement, _ctx: ElementContext): Vnode {
	const p = element.props;
	const border = strProp(p, "border", "#f59e0b");
	const borderWidth = numProp(p, "borderWidth", 8);
	const borderStyle = strProp(p, "borderStyle", "solid");
	const cornerRadius = numProp(p, "cornerRadius", 0);
	const background = strProp(p, "background", "");
	const label = strProp(p, "label", "LIVE");
	const color = strProp(p, "color", "#ffffff");
	const fontSize = numProp(p, "fontSize", 22);
	const fontFamily = strProp(p, "fontFamily", "Inter, system-ui, sans-serif");

	return (
		<div
			style={{
				width: "100%",
				height: "100%",
				boxSizing: "border-box",
				position: "relative",
				border: `${borderWidth}px ${borderStyle} ${border}`,
				borderRadius: `${cornerRadius}px`,
				background: background || "transparent",
				padding: Math.max(0, Math.round(Math.min(borderWidth * 2.5, 40)) - borderWidth),
			}}
		>
			{label ? (
				<div
					style={{
						position: "absolute",
						top: `${-Math.round(fontSize * 0.55)}px`,
						left: "16px",
						padding: `${Math.round(fontSize * 0.15)}px ${Math.round(fontSize * 0.5)}px`,
						background: border,
						borderRadius: `${Math.max(2, Math.round(cornerRadius * 0.4))}px`,
						color,
						fontFamily,
						fontSize: `${fontSize}px`,
						fontWeight: "700",
						letterSpacing: "0.1em",
					}}
				>
					{label}
				</div>
			) : null}
		</div>
	);
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
					path: "props.border",
					labelKey: "overlay.frame_color",
					type: "color",
					value: strProp(e.props, "border", "#f59e0b"),
				},
				{
					path: "props.borderWidth",
					labelKey: "overlay.frame_width",
					type: "number",
					min: 0,
					max: 80,
					value: numProp(e.props, "borderWidth", 8),
				},
			],
			[
				{
					path: "props.borderStyle",
					labelKey: "overlay.frame_style",
					type: "select",
					value: strProp(e.props, "borderStyle", "solid"),
					options: [
						{ value: "solid", label: "solid" },
						{ value: "dashed", label: "dashed" },
						{ value: "double", label: "double" },
					],
				},
				{
					path: "props.cornerRadius",
					labelKey: "overlay.frame_radius",
					type: "number",
					min: 0,
					max: 200,
					value: numProp(e.props, "cornerRadius", 0),
				},
			],
			[
				{
					path: "props.label",
					labelKey: "overlay.frame_label",
					type: "text",
					value: strProp(e.props, "label", "LIVE"),
				},
			],
			[
				{
					path: "props.color",
					labelKey: "overlay.frame_label_color",
					type: "color",
					value: strProp(e.props, "color", "#ffffff"),
				},
				{
					path: "props.fontSize",
					labelKey: "overlay.frame_label_size",
					type: "number",
					min: 8,
					max: 200,
					value: numProp(e.props, "fontSize", 22),
				},
			],
		],
	});
}

function validate(e: OverlayElement): string[] {
	return [];
}

export const frameElement: OverlayElementDef & OverlayElementSchema = {
	type: "frame",
	category: "widgets",

	labelKey: "overlay.add_frame",
	icon: () => <Icon name="frame" class="role-icon" />,
	order: 94,
	defaultProps: { ...DEFAULT_FRAME_PROPS },
	propKeys: [
		"border",
		"borderWidth",
		"borderStyle",
		"cornerRadius",
		"background",
		"label",
		"color",
		"fontSize",
	],
	defaultSize: { width: 640, height: 360 },
	draw,
	editForm,
	validate,
	handles: "box",
	normalizeProps(_p, read) {
		const d = DEFAULT_FRAME_PROPS;
		return {
			border: read.hex("border", d.border),
			borderWidth: read.num("borderWidth", d.borderWidth, 0, 200),
			borderStyle: read.oneOf(
				"borderStyle",
				["solid", "dashed", "double"],
				d.borderStyle,
			),
			cornerRadius: read.num("cornerRadius", d.cornerRadius, 0, 1000),
			// background is "" (transparent) by design, not a stored hex —
			// normalize it as a string.
			background:
				typeof _p.background === "string" && _p.background !== ""
					? read.hex("background", _p.background)
					: "",
			label: read.str("label", d.label, 24),
			color: read.hex("color", d.color),
			fontSize: read.num("fontSize", d.fontSize, 6, 400),
			fontFamily: read.str("fontFamily", d.fontFamily, 300),
		};
	},
};
