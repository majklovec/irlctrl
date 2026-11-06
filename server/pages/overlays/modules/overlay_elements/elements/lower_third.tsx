/** @jsx m */
/*
 * Lower-third widget — a name + topic bar. With `rotate` on it cycles through
 * its entries every `interval` ms (inner component owns the interval); with it
 * off it shows the first entry. Classic streamer intro bar.
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
import { bindableForm, type FormRow } from "@ui/overlay/fields";
import type { Vnode } from "mithril";
import m from "mithril";
import { ListField } from "../lib/list_field";
import type { OverlayElementSchema } from "../../../../../core/overlay_element";
import { cleanStr } from "./schema_utils";

/* ── lower third ──────────────────────────────────────────────────────── */
export interface LowerThirdProps {
	/** The name/topic lines; rotate cycles through them. */
	entries: Array<{ name: string; topic: string }>;
	rotate: boolean;
	/** Per-entry time in ms (rotation). */
	interval: number;
	color: string;
	background: string;
	accent: string;
	radius: number;
	fontSize: number;
	fontFamily: string;
}
export const DEFAULT_LOWER_THIRD_PROPS: Required<LowerThirdProps> = {
	entries: [{ name: "Your Name", topic: "Your topic here" }],
	rotate: false,
	interval: 6000,
	color: "#ffffff",
	background: "#111827",
	accent: "#38bdf8",
	radius: 8,
	fontSize: 30,
	fontFamily: "Inter, system-ui, sans-serif",
};

interface LTEntry {
	name: string;
	topic: string;
}

interface LTState {
	index: number;
	now: number;
	timer: ReturnType<typeof setInterval>;
}

interface LTAttrs {
	props: Record<string, unknown>;
}

const LowerThirdBox: m.Component<LTAttrs, LTState> = {
	oncreate(vnode) {
		vnode.state.index = 0;
		vnode.state.now = Date.now();
		vnode.state.timer = setInterval(() => {
			vnode.state.now = Date.now();
			m.redraw();
		}, 500);
	},
	onremove(vnode) {
		clearInterval(vnode.state.timer);
	},
	view(vnode) {
		const p = vnode.attrs.props;
		const s = vnode.state;
		const rawEntries = Array.isArray(p.entries) ? p.entries : [];
		const entries: LTEntry[] = rawEntries.map((item) => {
			const rec =
				typeof item === "object" && item !== null
					? (item as Record<string, unknown>)
					: {};
			return {
				name: typeof rec.name === "string" ? rec.name : "",
				topic: typeof rec.topic === "string" ? rec.topic : "",
			};
		});
		const rotate = p.rotate === true;
		const interval = numProp(p, "interval", 6000);
		const color = strProp(p, "color", "#ffffff");
		const bg = strProp(p, "background", "#111827");
		const accent = strProp(p, "accent", "#38bdf8");
		const radius = numProp(p, "radius", 8);
		const fontSize = numProp(p, "fontSize", 30);
		const fontFamily = strProp(p, "fontFamily", "Inter, system-ui, sans-serif");

		const count = Math.max(entries.length, 1);
		// Advance the index on the interval grid (stable across redraws).
		if (rotate && entries.length > 1)
			s.index = Math.floor(s.now / interval) % entries.length;
		const entry = entries.length > 0 ? entries[s.index % count] : undefined;

		return (
			<div
				style={{
					width: "100%",
					height: "100%",
					boxSizing: "border-box",
					display: "flex",
					alignItems: "stretch",
					background: bg,
					borderRadius: `${radius}px`,
					overflow: "hidden",
					color,
					fontFamily,
				}}
			>
				<div
					style={{
						width: `${Math.max(4, Math.round(fontSize * 0.35))}px`,
						background: accent,
						flexShrink: 0,
					}}
				/>
				{entry ? (
					<div
						style={{
							display: "flex",
							flexDirection: "column",
							justifyContent: "center",
							gap: `${Math.round(fontSize * 0.15)}px`,
							padding: `${fontSize * 0.35}px ${fontSize * 0.6}px`,
							minWidth: 0,
						}}
					>
						<div style={{ fontSize: `${fontSize}px`, fontWeight: "700" }}>
							{entry.name}
						</div>
						{entry.topic ? (
							<div
								style={{
									fontSize: `${Math.round(fontSize * 0.6)}px`,
									opacity: "0.85",
								}}
							>
								{entry.topic}
							</div>
						) : null}
					</div>
				) : (
					<div
						style={{
							display: "flex",
							alignItems: "center",
							padding: `${fontSize * 0.35}px ${fontSize * 0.6}px`,
							opacity: "0.5",
							fontSize: `${Math.round(fontSize * 0.7)}px`,
						}}
					>
						{t("overlay.lt_empty")}
					</div>
				)}
			</div>
		);
	},
};

function draw(element: OverlayElement, _ctx: ElementContext): Vnode<any, any> {
	return m(LowerThirdBox, { props: element.props });
}

function editForm({ element: e, mutate, variables, variableUrl }: ElementProps): Vnode {
	const p = e.props;
	// `interval` is only meaningful while rotating, so it is a conditional
	// row — present in `rows` only when `rotate` is on (mirrors the original
	// `p.rotate === true ? <input> : null`).
	const intervalRow: FormRow = [
		{
			path: "props.interval",
			labelKey: "overlay.interval",
			type: "number",
			value: numProp(p, "interval", 6000),
			min: 1000,
			max: 600000,
			step: 500,
		},
	];
	const rows: FormRow[] = [
		<ListField
			element={e}
			mutate={mutate}
			propKey="entries"
			label={t("overlay.lt_entries")}
			columns={[
				{ key: "name", label: t("overlay.lt_name") },
				{ key: "topic", label: t("overlay.lt_topic") },
			]}
			addRow={() => ({ name: "", topic: "" })}
			addLabel={t("overlay.lt_add_entry")}
		/>,
		[
			{
				path: "props.rotate",
				labelKey: "overlay.lt_rotate",
				type: "checkbox",
				value: p.rotate === true,
			},
		],
		...(p.rotate === true ? [intervalRow] : []),
		[
			{
				path: "props.color",
				labelKey: "overlay.color",
				type: "color",
				value: strProp(p, "color", "#ffffff"),
			},
			{
				path: "props.background",
				labelKey: "overlay.cd_background",
				type: "color",
				value: strProp(p, "background", "#111827"),
			},
			{
				path: "props.accent",
				labelKey: "overlay.accent",
				type: "color",
				value: strProp(p, "accent", "#38bdf8"),
			},
		],
		[
			{
				path: "props.fontSize",
				labelKey: "overlay.font_size",
				type: "number",
				value: numProp(p, "fontSize", 30),
				min: 8,
				max: 300,
			},
		],
	];
	return bindableForm({ element: e, mutate, variables, variableUrl, rows });
}

function validate(e: OverlayElement): string[] {
	return [];
}

export const lowerThirdElement: OverlayElementDef & OverlayElementSchema = {
	type: "lower_third",
	category: "widgets",

	labelKey: "overlay.add_lower_third",
	icon: () => <Icon name="subtitles" class="role-icon" />,
	order: 93,
	defaultProps: { ...DEFAULT_LOWER_THIRD_PROPS },
	/** `entries` is one composite control (a row table), not a bindField scalar. */
	propKeys: ["rotate", "interval", "color", "background", "accent", "fontSize"],
	defaultSize: { width: 420, height: 90 },
	draw,
	editForm,
	validate,
	handles: "box",
	normalizeProps(props, read) {
		const d = DEFAULT_LOWER_THIRD_PROPS;
		const raw = Array.isArray(props.entries) ? props.entries : [];
		return {
			entries: raw.slice(0, 16).map((item) => {
				const rec =
					typeof item === "object" && item !== null
						? (item as Record<string, unknown>)
						: {};
				return {
					name: cleanStr(rec.name, 120),
					topic: cleanStr(rec.topic, 200),
				};
			}),
			rotate: read.bool("rotate"),
			interval: read.num("interval", d.interval, 1000, 600000),
			color: read.hex("color", d.color),
			background: read.hex("background", d.background),
			accent: read.hex("accent", d.accent),
			radius: read.num("radius", d.radius, 0, 500),
			fontSize: read.num("fontSize", d.fontSize, 6, 400),
			fontFamily: read.str("fontFamily", d.fontFamily, 300),
		};
	},
};
