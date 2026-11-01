import { IconButton, Toolbar } from "@ui/components/";
import { Icon } from "@ui/components/icons";
import { t } from "@ui/i18n";
import { addableElements } from "@ui/overlay/registry";
import m from "mithril";
import {
	addElement,
	clamp,
	LIST_URL,
	redo,
	roundToStep,
	scene,
	state,
	undo,
} from "../overlay_store";

/** Icon submenu below the main nav: undo/redo + one icon per element type. */
export function editorToolbar(): m.Vnode {
	return (
		<Toolbar class="ov-toolrow">
			<IconButton
				label={t("overlay.undo")}
				title={`${t("overlay.undo")} (Ctrl+Z)`}
				icon={<Icon name="undo" class="role-icon" />}
				disabled={!state.past.length}
				onclick={undo}
			/>
			<IconButton
				label={t("overlay.redo")}
				title={`${t("overlay.redo")} (Ctrl+Shift+Z)`}
				icon={<Icon name="redo" class="role-icon" />}
				disabled={!state.future.length}
				onclick={redo}
			/>
			<span class="ov-toolsep" aria-hidden="true" />
			{addableElements().map((def) => (
				<IconButton
					key={def.type}
					label={t(def.labelKey ?? def.type)}
					icon={def.icon?.() ?? def.type}
					onclick={() => addElement(def.type)}
				/>
			))}
			<span class="ov-zoom">
				<IconButton
					label={t("overlay.zoom_out")}
					title={t("overlay.zoom_out")}
					icon={<Icon name="zoom-out" class="role-icon" />}
					onclick={() =>
						(state.zoom = roundToStep(clamp(state.zoom - 0.05, 0.1, 3), 0.05))
					}
				/>
				<span class="ov-zoom-val">{Math.round(state.zoom * 1000) / 10}%</span>
				<IconButton
					label={t("overlay.zoom_in")}
					title={t("overlay.zoom_in")}
					icon={<Icon name="zoom-in" class="role-icon" />}
					onclick={() =>
						(state.zoom = roundToStep(clamp(state.zoom + 0.05, 0.1, 3), 0.05))
					}
				/>
			</span>
			<span class="ov-toolsep" aria-hidden="true" />
			<IconButton
				label={t("overlay.variables")}
				title={t("overlay.variables")}
				icon={<Icon name="link" class="role-icon" />}
				onclick={() => (state.variablesDialogOpen = true)}
			/>
			<IconButton
				label={t("overlay.runtime_url")}
				title={t("overlay.runtime_url")}
				icon={<Icon name="view" class="role-icon" />}
				onclick={() => (state.runtimeDialogOpen = true)}
			/>
		</Toolbar>
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
