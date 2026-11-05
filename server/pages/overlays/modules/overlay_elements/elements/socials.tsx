/** @jsx m */
/*
 * Socials widget — a row of social/handle chips (platform label + handle)
 * that slides through the list one at a time. Inner component owns the
 * rotation interval; the chips render inline.
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
import { textRows } from "./schema_utils";

/* ── socials ──────────────────────────────────────────────────────────── */
export interface SocialsProps {
	entries: Array<{ label: string; handle: string }>;
	/** Cycle one entry at a time (slide). */
	slide: boolean;
	/** Per-entry time in ms (slide mode). */
	interval: number;
	color: string;
	background: string;
	accent: string;
	radius: number;
	fontSize: number;
	fontFamily: string;
}
export const DEFAULT_SOCIALS_PROPS: Required<SocialsProps> = {
	entries: [{ label: "Twitch", handle: "twitch.tv/you" }],
	slide: false,
	interval: 4000,
	color: "#ffffff",
	background: "#111827",
	accent: "#38bdf8",
	radius: 10,
	fontSize: 22,
	fontFamily: "Inter, system-ui, sans-serif",
};

interface SocialEntry {
	label: string;
	handle: string;
}

interface SBState {
	now: number;
	timer: ReturnType<typeof setInterval>;
}

interface SBAttrs {
	props: Record<string, unknown>;
}

const SocialsBox: m.Component<SBAttrs, SBState> = {
	oncreate(vnode) {
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
		const entries: SocialEntry[] = rawEntries.map((item) => {
			const rec =
				typeof item === "object" && item !== null
					? (item as Record<string, unknown>)
					: {};
			return {
				label: typeof rec.label === "string" ? rec.label : "",
				handle: typeof rec.handle === "string" ? rec.handle : "",
			};
		}).filter((e) => e.label || e.handle);
		const slide = p.slide === true;
		const interval = numProp(p, "interval", 4000);
		const color = strProp(p, "color", "#ffffff");
		const bg = strProp(p, "background", "#1f2937");
		const accent = strProp(p, "accent", "#38bdf8");
		const radius = numProp(p, "radius", 20);
		const fontSize = numProp(p, "fontSize", 20);
		const fontFamily = strProp(p, "fontFamily", "Inter, system-ui, sans-serif");

		const visible =
			!slide || entries.length <= 1
				? entries
				: [entries[Math.floor(s.now / interval) % entries.length]];

		return (
			<div
				style={{
					width: "100%",
					height: "100%",
					boxSizing: "border-box",
					display: "flex",
					flexWrap: "wrap",
					alignItems: "center",
					justifyContent: "center",
					gap: `${Math.round(fontSize * 0.4)}px`,
					padding: `${Math.round(fontSize * 0.4)}px`,
				}}
			>
				{visible.map((e, i) => (
					<div
						key={i}
						style={{
							display: "flex",
							alignItems: "center",
							gap: `${Math.round(fontSize * 0.35)}px`,
							padding: `${Math.round(fontSize * 0.35)}px ${Math.round(fontSize * 0.6)}px`,
							background: bg,
							border: `1px solid ${accent}`,
							borderRadius: `${radius}px`,
							color,
							fontFamily,
							fontSize: `${fontSize}px`,
						}}
					>
						<span style={{ opacity: "0.7", fontWeight: "600" }}>{e.label}</span>
						<span style={{ fontWeight: "700" }}>{e.handle}</span>
					</div>
				))}
			</div>
		);
	},
};

function draw(element: OverlayElement, _ctx: ElementContext): Vnode<any, any> {
	return m(SocialsBox, { props: element.props });
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
				label={t("overlay.so_entries")}
				columns={[
					{ key: "label", label: t("overlay.so_label") },
					{ key: "handle", label: t("overlay.so_handle") },
				]}
				addRow={() => ({ label: "", handle: "" })}
				addLabel={t("overlay.so_add")}
			/>
			<div class="ov-grid2">
				{bindField(e, "props.slide", t("overlay.so_slide"),
					<input type="checkbox" checked={p.slide === true} onchange={setBool("slide")} />, sp)}
				{p.slide === true ? (
					bindField(e, "props.interval", t("overlay.interval"),
						<input type="number" min={1000} max={600000} step={500} value={numProp(p, "interval", 4000)} oninput={setNum("interval")} />, sp)
				) : null}
			</div>
			<div class="ov-grid3">
				{bindField(e, "props.color", t("overlay.color"),
					<input type="color" value={strProp(p, "color", "#ffffff")} oninput={setStr("color")} />, sp)}
				{bindField(e, "props.background", t("overlay.cd_background"),
					<input type="color" value={strProp(p, "background", "#1f2937")} oninput={setStr("background")} />, sp)}
				{bindField(e, "props.accent", t("overlay.accent"),
					<input type="color" value={strProp(p, "accent", "#38bdf8")} oninput={setStr("accent")} />, sp)}
			</div>
			{bindField(e, "props.fontSize", t("overlay.font_size"),
				<input type="number" min={8} max={200} value={numProp(p, "fontSize", 20)} oninput={setNum("fontSize")} />, sp)}
		</>
	);
}

function validate(e: OverlayElement): string[] {
	return [];
}

export const socialsElement: OverlayElementDef & OverlayElementSchema = {
	type: "socials",
	category: "widgets",

	labelKey: "overlay.so_entries",
	icon: () => <Icon name="share" class="role-icon" />,
	order: 95,
	defaultProps: { ...DEFAULT_SOCIALS_PROPS },
	/** `entries` is one composite control (a row table), not a bindField scalar. */
	propKeys: [
		"slide",
		"interval",
		"color",
		"background",
		"accent",
		"fontSize",
	],
	defaultSize: { width: 460, height: 80 },
	draw,
	editForm,
	validate,
	handles: "box",
	normalizeProps(props, read) {
		const d = DEFAULT_SOCIALS_PROPS;
		return {
			entries: textRows(props.entries, 12, { key: "handle", kind: "str" }).map(
				(r) => ({ label: String(r.label), handle: String(r.handle) }),
			),
			slide: read.bool("slide"),
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
