import m from "mithril";
import { Icon } from "../../../../../shared/ui/components/icons";
import { Button } from "../../../../../shared/ui/components/ui";
import { t } from "../../../../../shared/ui/i18n";
import { addableElements } from "../../../../../shared/ui/overlay/registry";
import {
	LIST_URL,
	addElement,
	clamp,
	redo,
	scene,
	state,
	undo,
} from "../overlay_store";

/** Icon submenu below the main nav: undo/redo + one icon per element type. */
export function editorToolbar(): m.Vnode {
	return (
		<div class="ov-toolrow" role="toolbar">
			<Button
				label={<Icon name="undo" class="role-icon" />}
				class="icon-link"
				title={`${t("overlay.undo")} (Ctrl+Z)`}
				aria-label={t("overlay.undo")}
				disabled={!state.past.length}
				onclick={undo}
			/>
			<Button
				label={<Icon name="redo" class="role-icon" />}
				class="icon-link"
				title={`${t("overlay.redo")} (Ctrl+Shift+Z)`}
				aria-label={t("overlay.redo")}
				disabled={!state.future.length}
				onclick={redo}
			/>
			<span class="ov-toolsep" aria-hidden="true" />
			{addableElements().map((def) => (
				<Button
					key={def.type}
					label={def.icon?.() ?? def.type}
					class="icon-link"
					title={t(def.labelKey ?? def.type)}
					aria-label={t(def.labelKey ?? def.type)}
					onclick={() => addElement(def.type)}
				/>
			))}
		</div>
	);
}

export function headerRight(): m.Vnode {
	return (
		<span class="ov-zoom">
			<Button
				label="−"
				title={t("overlay.zoom_out")}
				onclick={() => (state.zoom = clamp(state.zoom * 0.8, 0.1, 3))}
			/>
			<span class="ov-zoom-val">{Math.round(state.zoom * 100)}%</span>
			<Button
				label="+"
				title={t("overlay.zoom_in")}
				onclick={() => (state.zoom = clamp(state.zoom * 1.25, 0.1, 3))}
			/>
		</span>
	);
}

/** Editor header: back-to-list link + "Overlays / <scene>". */
export function editorTitle(): m.Vnode {
	const s = scene();
	return (
		<>
			<a
				class="icon-link page-back"
				href={LIST_URL}
				title={t("overlay.back_list")}
				aria-label={t("overlay.back_list")}
			>
				<span class="sr-only">{t("overlay.back_list")}</span>
				<svg
					width={16}
					height={16}
					viewBox="0 0 16 16"
					fill="none"
					stroke="currentColor"
					strokeWidth={1.75}
					strokeLinecap="round"
					strokeLinejoin="round"
					aria-hidden="true"
				>
					<path d="M10 12L6 8l4-4" />
				</svg>
			</a>{" "}
			{t("overlay.title")}
			{s ? <> / {s.name}</> : null}
		</>
	);
}
