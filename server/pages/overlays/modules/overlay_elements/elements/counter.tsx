/** @jsx m */
/*
 * Counter widget — up to four big number tiles (wins/losses, streaks, money
 * counters…). The tiles' labels are a row table; their values live in ONE
 * bindable scalar, `values` — a comma-separated list, one entry per counter
 * ("10,5,0,0"). Bind it to a project variable and every tile tracks it live.
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
import { bindableForm } from "@ui/overlay/fields";
import type { Vnode } from "mithril";
import m from "mithril";
import type { OverlayElementSchema } from "../../../../../core/overlay_element";
import { ListField } from "../lib/list_field";
import { cleanNum, textRows } from "./schema_utils";

/* ── counter ──────────────────────────────────────────────────────────── */
export interface CounterProps {
	title: string;
	/** Up to four counters; each is a label — its value comes from `values`. */
	counters: Array<{ label: string }>;
	/** The counters' values in order, comma-separated (one per counter). */
	values: string;
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
	counters: [{ label: "Wins" }, { label: "Losses" }],
	values: "0,0",
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
	// `values` is ONE comma-separated list — the i-th counter takes the
	// i-th entry (0 when the list is shorter); extras are ignored.
	const values = strProp(p, "values", "")
		.split(",")
		.map((s) => {
			const n = Number(s.trim());
			return Number.isFinite(n) ? n : 0;
		});
	const counters = rawCounters
		.map((item, i) => {
			const rec =
				typeof item === "object" && item !== null
					? (item as Record<string, unknown>)
					: {};
			return {
				label: typeof rec.label === "string" ? rec.label : "",
				value: values[i] ?? 0,
			};
		})
		.filter((c) => c.label || c.value !== 0);

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

function editForm({ element: e, mutate, variables, variableUrl }: ElementProps): Vnode {
	const p = e.props;
	return bindableForm({
		element: e,
		mutate,
		variables,
		variableUrl,
		rows: [
			[
				{
					path: "props.title",
					labelKey: "overlay.cr_title",
					type: "text",
					value: strProp(p, "title", ""),
				},
			],
			// The counters row table is a bespoke composite control — kept verbatim.
			<ListField
				element={e}
				mutate={mutate}
				propKey="counters"
				label={t("overlay.ct_counters")}
				columns={[{ key: "label", label: t("overlay.label") }]}
				addRow={() => ({ label: "" })}
				addLabel={t("overlay.ct_add")}
			/>,
			[
				{
					path: "props.values",
					labelKey: "overlay.ct_values",
					type: "text",
					value: strProp(p, "values", ""),
				},
			],
			[
				{
					path: "props.layout",
					labelKey: "overlay.ct_layout",
					type: "select",
					value: strProp(p, "layout", "row"),
					options: [
						{ value: "row", label: "row" },
						{ value: "column", label: "column" },
					],
				},
			],
			[
				{
					path: "props.color",
					labelKey: "overlay.color",
					type: "color",
					value: strProp(p, "color", "#ffffff"),
				},
				{
					path: "props.accent",
					labelKey: "overlay.accent",
					type: "color",
					value: strProp(p, "accent", "#f59e0b"),
				},
				{
					path: "props.background",
					labelKey: "overlay.cd_background",
					type: "color",
					value: strProp(p, "background", "#111827"),
				},
			],
			[
				{
					path: "props.fontSize",
					labelKey: "overlay.font_size",
					type: "number",
					min: 8,
					max: 200,
					value: numProp(p, "fontSize", 26),
				},
			],
		],
	});
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
		"values",
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
		// `values` is the single comma-separated list; for pre-`values`
		// elements (no `values` key) the per-counter numbers migrate into
		// it, in row order.
		const raw =
			typeof props.values === "string"
				? props.values
				: (Array.isArray(props.counters) ? props.counters : [])
						.map((r) =>
							typeof r === "object" && r !== null
								? cleanNum((r as Record<string, unknown>).value, 0, -1e12, 1e12)
								: 0,
						)
						.join(",");
		// Each entry is a clamped number (the same bounds the per-counter
		// values had), re-joined in order.
		const values = raw
			.slice(0, 200)
			.split(",")
			.map((s) => String(cleanNum(s, 0, -1e12, 1e12)))
			.join(",");
		return {
			title: read.str("title", d.title, 120),
			values,
			counters: textRows(props.counters, 4).map((r) => ({
				label: String(r.label),
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
