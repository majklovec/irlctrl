/** @jsx m */
/*
 * Frame widget — a decorative border around whatever it is placed over
 * (typically a camera): a colored edge with an optional corner label. The
 * element is transparent in the middle; the "background" prop only fills the
 * padding ring when set ("" = fully transparent centre).
 */

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
import { DEFAULT_FRAME_PROPS } from "./frame_schema";

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

function editForm({ element: e, mutate, variables }: ElementProps): Vnode {
	const p = e.props;
	const sp = { mutate, variables };
	const setStr = (key: string) => (ev: Event) =>
		mutate((el) => {
			el.props[key] = (ev.target as HTMLInputElement).value;
		});
	const setSel = (key: string) => (ev: Event) =>
		mutate((el) => {
			el.props[key] = (ev.target as HTMLSelectElement).value;
		});
	const setNum = (key: string) => (ev: Event) =>
		mutate((el) => {
			el.props[key] = Number((ev.target as HTMLInputElement).value);
		});
	return (
		<>
			<div class="ov-grid2">
				{bindField(e, "props.border", t("overlay.frame_color"),
					<input type="color" value={strProp(p, "border", "#f59e0b")} oninput={setStr("border")} />, sp)}
				{bindField(e, "props.borderWidth", t("overlay.frame_width"),
					<input type="number" min={0} max={80} value={numProp(p, "borderWidth", 8)} oninput={setNum("borderWidth")} />, sp)}
			</div>
			<div class="ov-grid2">
				{bindField(e, "props.borderStyle", t("overlay.frame_style"),
					<select value={strProp(p, "borderStyle", "solid")} onchange={setSel("borderStyle")}>
						<option value="solid">solid</option>
						<option value="dashed">dashed</option>
						<option value="double">double</option>
					</select>, sp)}
				{bindField(e, "props.cornerRadius", t("overlay.frame_radius"),
					<input type="number" min={0} max={200} value={numProp(p, "cornerRadius", 0)} oninput={setNum("cornerRadius")} />, sp)}
			</div>
			{bindField(e, "props.label", t("overlay.frame_label"),
				<input type="text" value={strProp(p, "label", "LIVE")} oninput={setStr("label")} />, sp)}
			<div class="ov-grid2">
				{bindField(e, "props.color", t("overlay.frame_label_color"),
					<input type="color" value={strProp(p, "color", "#ffffff")} oninput={setStr("color")} />, sp)}
				{bindField(e, "props.fontSize", t("overlay.frame_label_size"),
					<input type="number" min={8} max={200} value={numProp(p, "fontSize", 22)} oninput={setNum("fontSize")} />, sp)}
			</div>
		</>
	);
}

function validate(e: OverlayElement): string[] {
	return [];
}

export const frameElement: OverlayElementDef = {
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
};
