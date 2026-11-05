/** @jsx m */
/*
 * Tasks widget — a "today's goals" checklist: label rows with a done
 * tick. Static in the overlay (the streamer updates it in the editor, or
 * binds nothing — it's a display-only element like a text block).
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
import { DEFAULT_TASKS_PROPS } from "./tasks_schema";
import { ListField } from "../lib/list_field";

function draw(element: OverlayElement, _ctx: ElementContext): Vnode {
	const p = element.props;
	const title = strProp(p, "title", "Today's goals");
	const color = strProp(p, "color", "#ffffff");
	const accent = strProp(p, "accent", "#22c55e");
	const background = strProp(p, "background", "#111827");
	const radius = numProp(p, "radius", 10);
	const fontSize = numProp(p, "fontSize", 22);
	const fontFamily = strProp(p, "fontFamily", "Inter, system-ui, sans-serif");
	const rawEntries = Array.isArray(p.entries) ? p.entries : [];
	const entries = rawEntries.map((item) => {
		const rec =
			typeof item === "object" && item !== null
				? (item as Record<string, unknown>)
				: {};
		return {
			label: typeof rec.label === "string" ? rec.label : "",
			done: rec.done === true,
		};
	}).filter((e) => e.label);

	const pad = Math.round(fontSize * 0.15);
	return (
		<div
			style={{
				width: "100%",
				height: "100%",
				boxSizing: "border-box",
				display: "flex",
				flexDirection: "column",
				gap: `${Math.round(fontSize * 0.3)}px`,
				background,
				borderRadius: `${radius}px`,
				color,
				fontFamily,
				padding: `${fontSize * 0.5}px ${fontSize * 0.6}px`,
				overflow: "hidden",
			}}
		>
			{title ? (
				<div
					style={{ fontSize: `${Math.round(fontSize * 0.85)}px`, fontWeight: "700", color: accent }}
				>
					{title}
				</div>
			) : null}
			{entries.map((e, i) => (
				<div
					key={i}
					style={{
						display: "flex",
						alignItems: "center",
						gap: `${Math.round(fontSize * 0.4)}px`,
						fontSize: `${fontSize}px`,
						opacity: e.done ? 0.6 : 1,
					}}
				>
					<span
						style={{
							display: "inline-flex",
							alignItems: "center",
							justifyContent: "center",
							width: `${fontSize * 1.1}px`,
							height: `${fontSize * 1.1}px`,
							border: `2px solid ${e.done ? accent : "rgba(255,255,255,0.4)"}`,
							borderRadius: `${pad}px`,
							color: accent,
							fontWeight: "700",
							flexShrink: 0,
						}}
					>
						{e.done ? "✓" : ""}
					</span>
					<span style={{ textDecoration: e.done ? "line-through" : "none", minWidth: 0 }}>
						{e.label}
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
	const setNum = (key: string) => (ev: Event) =>
		mutate((el) => {
			el.props[key] = Number((ev.target as HTMLInputElement).value);
		});
	return (
		<>
			{bindField(e, "props.title", t("overlay.tk_title"),
				<input type="text" value={strProp(p, "title", "Today's goals")} oninput={setStr("title")} />, sp)}
			<ListField
				element={e}
				mutate={mutate}
				propKey="entries"
				label={t("overlay.tk_entries")}
				columns={[
					{ key: "label", label: t("overlay.tk_label") },
					{ key: "done", label: t("overlay.tk_done"), type: "bool" },
				]}
				addRow={() => ({ label: "", done: false })}
				addLabel={t("overlay.tk_add")}
			/>
			<div class="ov-grid3">
				{bindField(e, "props.color", t("overlay.color"),
					<input type="color" value={strProp(p, "color", "#ffffff")} oninput={setStr("color")} />, sp)}
				{bindField(e, "props.accent", t("overlay.tk_accent"),
					<input type="color" value={strProp(p, "accent", "#22c55e")} oninput={setStr("accent")} />, sp)}
				{bindField(e, "props.background", t("overlay.tk_background"),
					<input type="color" value={strProp(p, "background", "#111827")} oninput={setStr("background")} />, sp)}
			</div>
			{bindField(e, "props.fontSize", t("overlay.font_size"),
				<input type="number" min={8} max={200} value={numProp(p, "fontSize", 22)} oninput={setNum("fontSize")} />, sp)}
		</>
	);
}

function validate(e: OverlayElement): string[] {
	return [];
}

export const tasksElement: OverlayElementDef = {
	type: "tasks",
	category: "widgets",

	labelKey: "overlay.add_tasks",
	icon: () => <Icon name="checklist" class="role-icon" />,
	order: 97,
	defaultProps: { ...DEFAULT_TASKS_PROPS },
	/** `entries` is one composite control (a row table), not a bindField scalar. */
	propKeys: ["title", "color", "accent", "background", "fontSize"],
	defaultSize: { width: 320, height: 220 },
	draw,
	editForm,
	validate,
	handles: "box",
};
