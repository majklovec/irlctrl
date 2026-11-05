import { IconButton, Toolbar } from "@ui/components/";
import { Icon } from "@ui/components/icons";
import { t } from "@ui/i18n";
import m from "mithril";
import { elementCatalog } from "./element_catalog";
import {
	clamp,
	closeToolMenus,
	LIST_URL,
	overlay,
	redo,
	roundToStep,
	state,
	undo,
} from "../overlay_store";

/** Toolbar below the main nav: history, the single "+" element-catalog
 * button, then — right-aligned — zoom + the utility dialogs. */
export function editorToolbar(): m.Vnode {
	const setCatalogOpen = (): void => {
		state.catalogOpen = !state.catalogOpen;
		m.redraw();
	};
	return (
		<Toolbar class="ov-toolrow">
			{state.catalogOpen ? (
				<div class="ov-dd-scrim" aria-hidden="true" onclick={closeToolMenus} />
			) : null}

			{/* Group 1: history */}
			<span class="ov-tb-group">
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
			</span>
			<span class="ov-tb-divider" aria-hidden="true" />

			{/* Group 2: the one "add element" button — opens the catalog. */}
			<span class="ov-tb-group">
				<span class={["ov-dd", state.catalogOpen ? "is-open" : ""].join(" ")}>
					<IconButton
						label={t("overlay.add_element")}
						icon={<Icon name="plus" class="role-icon" />}
						class="ov-dd-trigger"
						aria-haspopup="true"
						aria-expanded={state.catalogOpen ? "true" : "false"}
						onclick={setCatalogOpen}
					/>
					{state.catalogOpen ? elementCatalog() : null}
				</span>
			</span>

			{/* Spacer: pushes the zoom + utility groups to the right edge */}
			<span class="ov-tb-spacer" aria-hidden="true" />

			{/* Group 3: zoom */}
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
			<span class="ov-tb-divider" aria-hidden="true" />

			{/* Group 4: utilities */}
			<span class="ov-tb-group">
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
			</span>
		</Toolbar>
	);
}

/** Editor header: back-to-list link + "Overlays / <overlay>". */
export function editorTitle(): m.Vnode {
	const s = overlay();
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
					linecap="round"
					linejoin="round"
					aria-hidden="true"
				>
					<path d="M10 12L6 8l4-4" />
				</svg>
			</a>{" "}
			{s ? s.name : null}
		</>
	);
}
