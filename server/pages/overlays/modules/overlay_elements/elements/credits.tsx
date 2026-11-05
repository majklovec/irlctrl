/** @jsx m */
/*
 * Credits widget — a scrolling end-credits list (name + role lines under a
 * title) for stream endings. The scroll is a CSS animation (smooth on the
 * OBS CEF capture, zero per-frame JS): the keyframe `ovCreditsScroll` is
 * declared in overlay.css (runtime) and overlay_editor.css (editor); the
 * duration is derived from the entry count and the `speed` prop (lines per
 * second). The editor shows the static list (design state).
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
import { DEFAULT_CREDITS_PROPS } from "./credits_schema";
import { ListField } from "../lib/list_field";

function draw(
	element: OverlayElement,
	ctx: ElementContext,
): Vnode {
	const p = element.props;
	const title = strProp(p, "title", "With special thanks to");
	const speed = numProp(p, "speed", 1);
	const loop = p.loop === true;
	const color = strProp(p, "color", "#ffffff");
	const accent = strProp(p, "accent", "#ffd700");
	const background = strProp(p, "background", "#000000");
	const fontSize = numProp(p, "fontSize", 24);
	const fontFamily = strProp(p, "fontFamily", "Inter, system-ui, sans-serif");
	const rawEntries = Array.isArray(p.entries) ? p.entries : [];
	const entries = rawEntries.map((item) => {
		const rec =
			typeof item === "object" && item !== null
				? (item as Record<string, unknown>)
				: {};
		return {
			name: typeof rec.name === "string" ? rec.name : "",
			role: typeof rec.role === "string" ? rec.role : "",
		};
	});

	// ~200ms per line at speed 1 → duration = (count + title pad) / speed.
	const durationSec = Math.max(2, (entries.length + 3) / speed);
	// Runtime only: the editor stays on the static (design) state.
	const live = ctx.activeTriggers !== undefined;

	const lines: Vnode[] = [
		m(
			"div",
			{
				key: "title",
				style: {
					fontSize: `${Math.round(fontSize * 0.9)}px`,
					fontWeight: "700",
					color: accent,
					textAlign: "center",
					paddingBottom: `${Math.round(fontSize * 1.5)}px`,
				},
			},
			title,
		),
		...entries.map(
			(e, i) =>
				m(
					"div",
					{
						key: i,
						style: {
							display: "flex",
							flexDirection: "column",
							alignItems: "center",
							gap: `${Math.round(fontSize * 0.1)}px`,
							padding: `${Math.round(fontSize * 0.4)}px 0`,
						},
					},
					[
						m("div", { style: { fontSize: `${fontSize}px`, fontWeight: "600" } }, e.name),
						e.role
							? m("div", { style: { fontSize: `${Math.round(fontSize * 0.6)}px`, opacity: "0.75" } }, e.role)
							: null,
					],
				),
		),
	];

	return (
		<div
			style={{
				width: "100%",
				height: "100%",
				boxSizing: "border-box",
				overflow: "hidden",
				background,
				color,
				fontFamily,
			}}
		>
			<div
				class="ov-credits-track"
				style={
					live
						? {
								animation: `ovCreditsScroll ${durationSec.toFixed(2)}s linear ${
									loop ? "infinite" : "1 forwards"
								}`,
						  }
						: undefined
				}
			>
				{lines}
			</div>
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
			{bindField(e, "props.title", t("overlay.cr_title"),
				<input type="text" value={strProp(p, "title", "With special thanks to")} oninput={setStr("title")} />, sp)}
			<ListField
				element={e}
				mutate={mutate}
				propKey="entries"
				label={t("overlay.cr_entries")}
				columns={[
					{ key: "name", label: t("overlay.cr_name") },
					{ key: "role", label: t("overlay.cr_role") },
				]}
				addRow={() => ({ name: "", role: "" })}
				addLabel={t("overlay.cr_add")}
			/>
			<div class="ov-grid2">
				{bindField(e, "props.speed", t("overlay.cr_speed"),
					<input type="number" min={0.1} max={20} step={0.5} value={numProp(p, "speed", 1)} oninput={setNum("speed")} />, sp)}
				{bindField(e, "props.loop", t("overlay.cr_loop"),
					<input type="checkbox" checked={p.loop === true} onchange={setBool("loop")} />, sp)}
			</div>
			<div class="ov-grid3">
				{bindField(e, "props.color", t("overlay.color"),
					<input type="color" value={strProp(p, "color", "#ffffff")} oninput={setStr("color")} />, sp)}
				{bindField(e, "props.accent", t("overlay.cr_accent"),
					<input type="color" value={strProp(p, "accent", "#ffd700")} oninput={setStr("accent")} />, sp)}
				{bindField(e, "props.background", t("overlay.cr_background"),
					<input type="color" value={strProp(p, "background", "#000000")} oninput={setStr("background")} />, sp)}
			</div>
			{bindField(e, "props.fontSize", t("overlay.font_size"),
				<input type="number" min={8} max={200} value={numProp(p, "fontSize", 24)} oninput={setNum("fontSize")} />, sp)}
		</>
	);
}

function validate(e: OverlayElement): string[] {
	return [];
}

export const creditsElement: OverlayElementDef = {
	type: "credits",
	category: "widgets",

	labelKey: "overlay.add_credits",
	icon: () => <Icon name="credits" class="role-icon" />,
	order: 96,
	defaultProps: { ...DEFAULT_CREDITS_PROPS },
	/** `entries` is one composite control (a row table), not a bindField scalar. */
	propKeys: [
		"title",
		"speed",
		"loop",
		"color",
		"accent",
		"background",
		"fontSize",
	],
	defaultSize: { width: 400, height: 500 },
	draw,
	editForm,
	validate,
	handles: "box",
};
