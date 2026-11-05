/** @jsx m */
/*
 * Goal widget — a progress bar towards a target (sub goal, viewers goal…).
 * `value` is a bindable scalar: bind it to a project variable and the bar
 * tracks the variable live in the overlay (the classic "goal bar" pattern).
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
import type { OverlayElementSchema } from "../../../../../core/overlay_element";

/* ── goal ─────────────────────────────────────────────────────────────── */
export interface GoalProps {
	label: string;
	/** The target value to reach. */
	target: number;
	/** Current progress; bind this to a variable to make it live. */
	value: number;
	color: string;
	fill: string;
	background: string;
	radius: number;
	fontSize: number;
	fontFamily: string;
	showValue: boolean;
}
export const DEFAULT_GOAL_PROPS: Required<GoalProps> = {
	label: "Sub goal",
	target: 100,
	value: 0,
	color: "#ffffff",
	fill: "#22c55e",
	background: "#e5e7eb",
	radius: 8,
	fontSize: 20,
	fontFamily: "Inter, system-ui, sans-serif",
	showValue: true,
};

function draw(element: OverlayElement, _ctx: ElementContext): Vnode {
	const p = element.props;
	const label = strProp(p, "label", "Sub goal");
	const target = Math.max(1, numProp(p, "target", 100));
	const value = Math.max(0, numProp(p, "value", 0));
	const color = strProp(p, "color", "#ffffff");
	const fill = strProp(p, "fill", "#22c55e");
	const background = strProp(p, "background", "#e5e7eb");
	const radius = numProp(p, "radius", 8);
	const fontSize = numProp(p, "fontSize", 20);
	const fontFamily = strProp(p, "fontFamily", "Inter, system-ui, sans-serif");
	const showValue = p.showValue === true;

	const pct = Math.min(100, (value / target) * 100);

	return (
		<div
			style={{
				width: "100%",
				height: "100%",
				boxSizing: "border-box",
				display: "flex",
				flexDirection: "column",
				justifyContent: "center",
				gap: `${Math.round(fontSize * 0.3)}px`,
				color,
				fontFamily,
				padding: `${fontSize * 0.4}px ${fontSize * 0.2}px`,
			}}
		>
			<div
				style={{
					display: "flex",
					justifyContent: "space-between",
					fontSize: `${fontSize}px`,
					fontWeight: "600",
				}}
			>
				<span>{label}</span>
				{showValue ? (
					<span style={{ fontVariantNumeric: "tabular-nums", opacity: "0.9" }}>
						{`${Math.round(value * 100) / 100} / ${Math.round(target * 100) / 100}`}
					</span>
				) : null}
			</div>
			<div
				style={{
					width: "100%",
					height: `${Math.max(8, Math.round(fontSize * 0.6))}px`,
					background,
					borderRadius: `${radius}px`,
					overflow: "hidden",
				}}
			>
				<div
					style={{
						width: `${pct}%`,
						height: "100%",
						background: fill,
						borderRadius: `${radius}px`,
						transition: "width 0.6s ease",
					}}
				/>
			</div>
		</div>
	);
}

function editForm({ element: e, mutate, variables, variableUrl }: ElementProps): Vnode {
	const p = e.props;
	const sp = { mutate, variables, variableUrl };
	const setStr = (key: string) => (ev: Event) =>
		mutate((el) => {
			el.props[key] = (ev.target as HTMLInputElement).value;
		});
	const setNum = (key: string) => (ev: Event) =>
		mutate((el) => {
			el.props[key] = Number((ev.target as HTMLInputElement).value);
		});
	const setBool = (key: string) => (ev: Event) =>
		mutate((el) => {
			el.props[key] = (ev.target as HTMLInputElement).checked;
		});
	return (
		<>
			{bindField(e, "props.label", t("overlay.label"),
				<input type="text" value={strProp(p, "label", "Sub goal")} oninput={setStr("label")} />, sp)}
			<div class="ov-grid2">
				{bindField(e, "props.target", t("overlay.gl_target"),
					<input type="number" min={1} value={numProp(p, "target", 100)} oninput={setNum("target")} />, sp)}
				{bindField(e, "props.value", t("overlay.gl_value"),
					<input type="number" min={0} value={numProp(p, "value", 0)} oninput={setNum("value")} />, sp)}
			</div>
			{bindField(e, "props.showValue", t("overlay.gl_show_value"),
				<input type="checkbox" checked={p.showValue === true} onchange={setBool("showValue")} />, sp)}
			<div class="ov-grid3">
				{bindField(e, "props.color", t("overlay.color"),
					<input type="color" value={strProp(p, "color", "#ffffff")} oninput={setStr("color")} />, sp)}
				{bindField(e, "props.fill", t("overlay.gl_fill"),
					<input type="color" value={strProp(p, "fill", "#22c55e")} oninput={setStr("fill")} />, sp)}
				{bindField(e, "props.background", t("overlay.gl_track"),
					<input type="color" value={strProp(p, "background", "#e5e7eb")} oninput={setStr("background")} />, sp)}
			</div>
			{bindField(e, "props.fontSize", t("overlay.font_size"),
				<input type="number" min={8} max={200} value={numProp(p, "fontSize", 20)} oninput={setNum("fontSize")} />, sp)}
		</>
	);
}

function validate(e: OverlayElement): string[] {
	const problems: string[] = [];
	if (numProp(e.props, "target", 1) <= 0) problems.push("target must be > 0");
	return problems;
}

export const goalElement: OverlayElementDef & OverlayElementSchema = {
	type: "goal",
	category: "widgets",

	labelKey: "overlay.add_goal",
	icon: () => <Icon name="target" class="role-icon" />,
	order: 98,
	defaultProps: { ...DEFAULT_GOAL_PROPS },
	propKeys: [
		"label",
		"target",
		"value",
		"showValue",
		"color",
		"fill",
		"background",
		"fontSize",
	],
	defaultSize: { width: 360, height: 90 },
	draw,
	editForm,
	validate,
	handles: "box",
	normalizeProps(_p, read) {
		const d = DEFAULT_GOAL_PROPS;
		return {
			label: read.str("label", d.label, 120),
			target: read.num("target", d.target, 1, 1e12),
			value: read.num("value", d.value, 0, 1e12),
			color: read.hex("color", d.color),
			fill: read.hex("fill", d.fill),
			background: read.hex("background", d.background),
			radius: read.num("radius", d.radius, 0, 500),
			fontSize: read.num("fontSize", d.fontSize, 6, 400),
			fontFamily: read.str("fontFamily", d.fontFamily, 300),
			showValue: read.bool("showValue"),
		};
	},
};
