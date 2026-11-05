import { IconButton, Toolbar } from "@ui/components/";
import { Icon } from "@ui/components/icons";
import { t } from "@ui/i18n";
import { addableElements, elementDef } from "../registry";
import m from "mithril";
import {
	addElement,
	clamp,
	closeToolMenus,
	LIST_URL,
	overlay,
	redo,
	roundToStep,
	state,
	undo,
} from "../overlay_store";
import type { OverlayElementDef } from "../../../../../shared/ui/overlay/element";

/** Group 2: the element types drawn as a direct button ("core") … */
const CORE_TYPES = new Set(["text", "image", "video", "progress"]);
/** …in the shapes dropdown… */
const SHAPE_TYPES = new Set(["rectangle", "ellipse", "line"]);
/** …and in group 3 as a direct button, ahead of the widgets dropdown. */
const WIDGET_DIRECT_TYPES = new Set(["chat", "alert"]);

/** The "add" buttons for one set of element definitions, in registry order. */
function addButton(defs: readonly OverlayElementDef[]): m.Children {
	return defs.map((def) => (
		<IconButton
			key={def.type}
			label={t(def.labelKey ?? def.type)}
			icon={def.icon?.() ?? def.type}
			onclick={() => addElement(def.type)}
		/>
	));
}

/** A dropdown inside the toolbar: an `icon-link` trigger (chevron rotates
 * open) over an absolutely positioned menu. Only one menu is open at a time;
 * the fixed scrim closes the open one on any outside click. */
function toolMenu(
	open: boolean,
	onToggle: () => void,
	trigger: m.Vnode,
	menu: m.Vnode,
): m.Vnode {
	return (
		<span class={["ov-dd", open ? "is-open" : ""].join(" ")}>
			{trigger}
			{open ? menu : null}
		</span>
	);
}

/** Toolbar below the main nav: five groups — history, core editing (shapes
 * collapsed in a dropdown), widgets (the long tail in a grid dropdown) and,
 * right-aligned, zoom + the utility dialogs. */
export function editorToolbar(): m.Vnode {
	const defs = addableElements();
	const coreDefs = defs.filter((d) => CORE_TYPES.has(d.type));
	const shapeDefs = defs.filter((d) => SHAPE_TYPES.has(d.type));
	const directWidgets = defs.filter((d) => WIDGET_DIRECT_TYPES.has(d.type));
	const menuWidgets = defs
		.filter(
			(d) =>
				!CORE_TYPES.has(d.type) &&
				!SHAPE_TYPES.has(d.type) &&
				!WIDGET_DIRECT_TYPES.has(d.type),
		)
		.sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
	const shapeTriggerIcon =
		elementDef("rectangle")?.icon?.() ?? <Icon name="info" />;

	const setShapesOpen = () => {
		state.shapesMenuOpen = !state.shapesMenuOpen;
		state.widgetsMenuOpen = false;
		m.redraw();
	};
	const setWidgetsOpen = () => {
		state.widgetsMenuOpen = !state.widgetsMenuOpen;
		state.shapesMenuOpen = false;
		m.redraw();
	};

	return (
		<Toolbar class="ov-toolrow">
			{state.shapesMenuOpen || state.widgetsMenuOpen ? (
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

			{/* Group 2: core editing — text, shapes (dropdown), image, video,
				progress */}
			<span class="ov-tb-group">
				{addButton(coreDefs.filter((d) => d.type === "text"))}
				{toolMenu(
					state.shapesMenuOpen,
					setShapesOpen,
					<IconButton
						label={t("overlay.add_shapes")}
						icon={shapeTriggerIcon}
						class="ov-dd-trigger"
						aria-haspopup="true"
						aria-expanded={state.shapesMenuOpen ? "true" : "false"}
						onclick={setShapesOpen}
					/>,
					<span class="ov-dd-menu" role="menu">
						{addButton(shapeDefs)}
					</span>,
				)}
				{addButton(
					coreDefs.filter(
						(d) => d.type !== "text" && d.type !== "progress",
					),
				)}
				{addButton(coreDefs.filter((d) => d.type === "progress"))}
			</span>
			<span class="ov-tb-divider" aria-hidden="true" />

			{/* Group 3: widgets — chat + alerts direct, the rest in a grid */}
			<span class="ov-tb-group">
				{addButton(directWidgets)}
				{toolMenu(
					state.widgetsMenuOpen,
					setWidgetsOpen,
					<button
						type="button"
						class="icon-link ov-dd-textbtn"
						title={t("overlay.add_widgets")}
						aria-label={t("overlay.add_widgets")}
						aria-haspopup="true"
						aria-expanded={state.widgetsMenuOpen ? "true" : "false"}
						onclick={setWidgetsOpen}
					>
						<span>{t("overlay.add_widgets")}</span>
						<Icon name="chevron" class="role-icon ov-dd-chevron" />
					</button>,
					<span class="ov-dd-menu ov-dd-grid" role="menu">
						{addButton(menuWidgets)}
					</span>,
				)}
			</span>

			{/* Spacer: pushes the zoom + utility groups to the right edge */}
			<span class="ov-tb-spacer" aria-hidden="true" />

			{/* Group 4: zoom */}
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

			{/* Group 5: utilities */}
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
					strokeLinecap="round"
					strokeLinejoin="round"
					aria-hidden="true"
				>
					<path d="M10 12L6 8l4-4" />
				</svg>
			</a>{" "}
			{s ? s.name : null}
		</>
	);
}
