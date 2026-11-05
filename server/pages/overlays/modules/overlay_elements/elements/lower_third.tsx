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
import { bindField } from "@ui/overlay/fields";
import type { Vnode } from "mithril";
import m from "mithril";
import { DEFAULT_LOWER_THIRD_PROPS } from "../overlay_schema";
import { ListField } from "../lib/list_field";

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
							<div style={{ fontSize: `${Math.round(fontSize * 0.6)}px`, opacity: "0.85" }}>
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

function editForm({ element: e, mutate, variables }: ElementProps): Vnode {
	const p = e.props;
	const sp = { mutate, variables };
	const setBool = (key: string) => (ev: Event) =>
		mutate((el) => {
			el.props[key] = (ev.target as HTMLInputElement).checked;
		});
	const setNum = (key: string) => (ev: Event) =>
		mutate((el) => {
			el.props[key] = Number((ev.target as HTMLInputElement).value);
		});
	const setStr = (key: string) => (ev: Event) =>
		mutate((el) => {
			el.props[key] = (ev.target as HTMLInputElement).value;
		});
	return (
		<>
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
			/>
			{bindField(e, "props.rotate", t("overlay.lt_rotate"),
				<input type="checkbox" checked={p.rotate === true} onchange={setBool("rotate")} />, sp)}
			{p.rotate === true ? (
				bindField(e, "props.interval", t("overlay.lt_interval"),
					<input type="number" min={1000} max={600000} step={500} value={numProp(p, "interval", 6000)} oninput={setNum("interval")} />, sp)
			) : null}
			<div class="ov-grid3">
				{bindField(e, "props.color", t("overlay.color"),
					<input type="color" value={strProp(p, "color", "#ffffff")} oninput={setStr("color")} />, sp)}
				{bindField(e, "props.background", t("overlay.lt_background"),
					<input type="color" value={strProp(p, "background", "#111827")} oninput={setStr("background")} />, sp)}
				{bindField(e, "props.accent", t("overlay.lt_accent"),
					<input type="color" value={strProp(p, "accent", "#38bdf8")} oninput={setStr("accent")} />, sp)}
			</div>
			{bindField(e, "props.fontSize", t("overlay.font_size"),
				<input type="number" min={8} max={300} value={numProp(p, "fontSize", 30)} oninput={setNum("fontSize")} />, sp)}
		</>
	);
}

function validate(e: OverlayElement): string[] {
	return [];
}

export const lowerThirdElement: OverlayElementDef = {
	type: "lower_third",
	labelKey: "overlay.add_lower_third",
	icon: () => <Icon name="subtitles" class="role-icon" />,
	order: 93,
	defaultProps: { ...DEFAULT_LOWER_THIRD_PROPS },
	/** `entries` is one composite control (a row table), not a bindField scalar. */
	propKeys: [
		"rotate",
		"interval",
		"color",
		"background",
		"accent",
		"fontSize",
	],
	defaultSize: { width: 420, height: 90 },
	draw,
	editForm,
	validate,
	handles: "box",
};
