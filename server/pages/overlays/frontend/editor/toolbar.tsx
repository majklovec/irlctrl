import { Button, IconButton, Toolbar } from "@ui/components/";
import { Icon } from "@ui/components/icons";
import { t } from "@ui/i18n";
import m from "mithril";
import {
	clamp,
	closeToolMenus,
	fitZoom,
	LIST_URL,
	overlay,
	redo,
	roundToStep,
	state,
	undo,
} from "../overlay_store";
import { elementCatalog } from "./element_catalog";

/** Toolbar below the main nav: history, the "add element" + utility
 * buttons, then — right-aligned — zoom. */
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

			{/* Group 2: "add element" (opens the catalog) + utility dialogs. */}
			<span class="ov-button-group">
				<span class={["ov-dd", state.catalogOpen ? "is-open" : ""].join(" ")}>
					<Button
						label={
							<>
								<Icon name="plus" class="role-icon" />
								{t("overlay.add_element")}
							</>
						}
						class="ov-dd-trigger"
						aria-haspopup="true"
						aria-expanded={state.catalogOpen ? "true" : "false"}
						onclick={setCatalogOpen}
					/>
					{state.catalogOpen ? elementCatalog() : null}
				</span>
				<Button
					label={
						<>
							<Icon name="link" class="role-icon" />
							{t("overlay.variables")}
						</>
					}
					class="ov-dd-trigger"
					title={t("overlay.variables")}
					onclick={() => (state.variablesDialogOpen = true)}
				/>
				<Button
					label={
						<>
							<Icon name="view" class="role-icon" />
							{t("overlay.runtime_url")}
						</>
					}
					class="ov-dd-trigger"
					title={t("overlay.runtime_url")}
					onclick={() => (state.runtimeDialogOpen = true)}
				/>
			</span>

			{/* Spacer: pushes the zoom group to the right edge */}
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
				<IconButton
					label={t("overlay.zoom_fit")}
					title={t("overlay.zoom_fit")}
					icon={<Icon name="frame" class="role-icon" />}
					onclick={fitZoom}
				/>
				<IconButton
					label={t("overlay.zoom_in")}
					title={t("overlay.zoom_in")}
					icon={<Icon name="zoom-in" class="role-icon" />}
					onclick={() =>
						(state.zoom = roundToStep(clamp(state.zoom + 0.05, 0.1, 3), 0.05))
					}
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
