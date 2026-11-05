/** @jsx m */
/*
 * Counter widget — up to four big number tiles (wins/losses, streaks, money
 * counters…). Each `value` is a bindable scalar by design — bind one to a
 * project variable and the tile tracks it live.
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
import { ListField } from "../lib/list_field";
import type { OverlayElementSchema } from "../../../../../core/overlay_element";
import { textRows, cleanNum } from "./schema_utils";

/* ── counter ──────────────────────────────────────────────────────────── */
export interface CounterProps {
	title: string;
	/** Up to four counters; `value` is bindable per-counter by variable. */
	counters: Array<{ label: string; value: number }>;
	layout: "row" | "column";
	color: string;
	accent: string;
	background: string;
	radius: number;
	fontSize: number;
	fontFamily: string;
}
export const DEFAULT_COUNTER_PROPS: Required<CounterProps> = {
	title: "",
	counters: [
		{ label: "Wins", value: 0 },
		{ label: "Losses", value: 0 },
	],
	layout: "row",
	color: "#ffffff",
	accent: "#f59e0b",
	background: "#111827",
	radius: 10,
	fontSize: 26,
	fontFamily: "Inter, system-ui, sans-serif",
};

function draw(element: OverlayElement, _ctx: ElementContext): Vnode {
	const p = element.props;
	const title = strProp(p, "title", "");
	const layout = strProp(p, "layout", "row");
	const color = strProp(p, "color", "#ffffff");
	const accent = strProp(p, "accent", "#f59e0b");
	const background = strProp(p, "background", "#111827");
	const radius = numProp(p, "radius", 10);
	const fontSize = numProp(p, "fontSize", 26);
	const fontFamily = strProp(p, "fontFamily", "Inter, system-ui, sans-serif");
	const rawCounters = Array.isArray(p.counters) ? p.counters : [];
	const counters = rawCounters.map((item) => {
		const rec =
			typeof item === "object" && item !== null
				? (item as Record<string, unknown>)
				: {};
		return {
			label: typeof rec.label === "string" ? rec.label : "",
			value: typeof rec.value === "number" ? rec.value : 0,
		};
	}).filter((c) => c.label || c.value !== 0);

	const isRow = layout === "row";
	return (
		<div
			style={{
				width: "100%",
				height: "100%",
				boxSizing: "border-box",
				display: "flex",
				flexDirection: isRow ? "row" : "column",
				gap: `${Math.round(fontSize * 0.3)}px`,
				justifyContent: "center",
				alignItems: "center",
				color,
				fontFamily,
			}}
		>
			{title
				? m(
						"div",
						{
							style: {
								position: "absolute",
								top: "0",
								left: "0",
								right: "0",
								fontSize: `${Math.round(fontSize * 0.6)}px`,
								fontWeight: "600",
								color: accent,
								textAlign: "center",
								paddingTop: `${Math.round(fontSize * 0.2)}px`,
							},
						},
						title,
				  )
				: null}
			{counters.map((c, i) => (
				<div
					key={i}
					style={{
						display: "flex",
						flexDirection: "column",
						alignItems: "center",
						justifyContent: "center",
						gap: `${Math.round(fontSize * 0.15)}px`,
						flex: "1 1 0",
						minWidth: 0,
						background,
						border: `1px solid ${accent}`,
						borderRadius: `${radius}px`,
						padding: `${Math.round(fontSize * 0.35)}px ${Math.round(fontSize * 0.3)}px`,
					}}
				>
					<span
						style={{
							fontSize: `${Math.round(fontSize * 1.4)}px`,
							fontWeight: "800",
							fontVariantNumeric: "tabular-nums",
							lineHeight: 1,
						}}
					>
						{c.value}
					</span>
					<span
						style={{
							fontSize: `${Math.round(fontSize * 0.55)}px`,
							opacity: "0.8",
							textTransform: "uppercase",
							letterSpacing: "0.06em",
						}}
					>
						{c.label}
					</span>
				</div>
			))}
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
	return (
		<>
			{bindField(e, "props.title", t("overlay.ct_title"),
				<input type="text" value={strProp(p, "title", "")} oninput={setStr("title")} />, sp)}
			<ListField
				element={e}
				mutate={mutate}
				propKey="counters"
				label={t("overlay.ct_counters")}
				columns={[
					{ key: "label", label: t("overlay.ct_label") },
					{ key: "value", label: t("overlay.ct_value"), type: "number" },
				]}
				addRow={() => ({ label: "", value: 0 })}
				addLabel={t("overlay.ct_add")}
			/>
			{bindField(e, "props.layout", t("overlay.ct_layout"),
				<select value={strProp(p, "layout", "row")} onchange={setSel("layout")}>
					<option value="row">row</option>
					<option value="column">column</option>
				</select>, sp)}
			<div class="ov-grid3">
				{bindField(e, "props.color", t("overlay.color"),
					<input type="color" value={strProp(p, "color", "#ffffff")} oninput={setStr("color")} />, sp)}
				{bindField(e, "props.accent", t("overlay.ct_accent"),
					<input type="color" value={strProp(p, "accent", "#f59e0b")} oninput={setStr("accent")} />, sp)}
				{bindField(e, "props.background", t("overlay.ct_background"),
					<input type="color" value={strProp(p, "background", "#111827")} oninput={setStr("background")} />, sp)}
			</div>
			{bindField(e, "props.fontSize", t("overlay.font_size"),
				<input type="number" min={8} max={200} value={numProp(p, "fontSize", 26)} oninput={(ev: Event) => mutate((el) => { el.props.fontSize = Number((ev.target as HTMLInputElement).value); })} />, sp)}
		</>
	);
}

function validate(e: OverlayElement): string[] {
	return [];
}

export const counterElement: OverlayElementDef & OverlayElementSchema = {
	type: "counter",
	category: "widgets",

	labelKey: "overlay.add_counter",
	icon: () => <Icon name="hash" class="role-icon" />,
	order: 99,
	defaultProps: { ...DEFAULT_COUNTER_PROPS },
	/** `counters` is one composite control (a row table), not a bindField scalar. */
	propKeys: [
		"title",
		"layout",
		"color",
		"accent",
		"background",
		"fontSize",
	],
	defaultSize: { width: 420, height: 120 },
	draw,
	editForm,
	validate,
	handles: "box",
	normalizeProps(props, read) {
		const d = DEFAULT_COUNTER_PROPS;
		return {
			title: read.str("title", d.title, 120),
			counters: textRows(props.counters, 4, {
				key: "value",
				kind: "num",
			}).map((r) => ({
				label: String(r.label),
				value: cleanNum(r.value, 0, -1e12, 1e12),
			})),
			layout: read.oneOf("layout", ["row", "column"], d.layout),
			color: read.hex("color", d.color),
			accent: read.hex("accent", d.accent),
			background: read.hex("background", d.background),
			radius: read.num("radius", d.radius, 0, 500),
			fontSize: read.num("fontSize", d.fontSize, 6, 400),
			fontFamily: read.str("fontFamily", d.fontFamily, 300),
		};
	},
};
