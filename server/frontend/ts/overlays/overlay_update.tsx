/** @jsx m */
/*
 * Overlay editor page (/overlays/edit/<overlay id>/):
 *   toolbar:    undo/redo + one "add" button per registered element type,
 *               and the runtime URL (dialog: the OBS source URL, copy/rotate)
 *   center:     zoomable canvas — select / drag / resize / nudge / snap
 *   right rail: the layers list, each row expanding into the element's
 *               inspector (transform, props, bindings)
 *   modal:      variables (live, opened from the toolbar icon)
 *
 * The overlay renders through the SHARED overlay render views so the preview is
 * pixel-identical to the OBS runtime; the editor only layers a selection box +
 * resize handles on top. The server is the source of truth: every mutation is
 * pushed to the REST API and the live feed re-syncs the local copy
 * (overlay_store.ts). Undo/redo (100 steps) tracks the active overlay's
 * elements. Controls are raw <input>/<select> bound imperatively (the ui
 * kit's bound controls target a fixed state object, which doesn't fit a
 * canvas editor).
 */

import { Page, ServerNav } from "@ui/components/";
import { t } from "@ui/i18n";
import { mountPage } from "@ui/util";
import m from "mithril";
import { canvasArea } from "./editor/canvas";
import { onKey } from "./editor/keyboard";
import { inspector } from "./editor/layers";
import { runtimeDialog } from "./editor/runtime_dialog";
import { editorTitle, editorToolbar } from "./editor/toolbar";
import { variablesDialog } from "./editor/variables";
import {
	fitZoom,
	LIST_URL,
	load,
	overlay,
	overlayIdFromLocation,
	state,
} from "./overlay_store";

const overlayUpdatePage: m.Component = {
	oncreate() {
		void load(overlayIdFromLocation()).then(() => {
			// the URL names an overlay that no longer exists → back to the list
			if (state.loaded && !overlay()) location.replace(LIST_URL);
			// default zoom: fit the whole canvas into the viewport
			else requestAnimationFrame(fitZoom);
		});
		window.addEventListener("keydown", onKey, true);
	},
	onremove() {
		window.removeEventListener("keydown", onKey, true);
	},
	view: () => {
		if (!state.loaded || !overlay())
			return (
				<Page nav={<ServerNav active="overlays" />}>
					<p class="muted">{t("overlay.loading")}</p>
				</Page>
			);
		return (
			<Page
				title={editorTitle()}
				nav={<ServerNav active="overlays" />}
				toolbar={editorToolbar()}
			>
				<div class="ov-layout">
					<div class="ov-center">{canvasArea()}</div>
					<div class="ov-right">{inspector()}</div>
				</div>
				{state.runtimeDialogOpen ? runtimeDialog() : null}
				{state.variablesDialogOpen ? variablesDialog() : null}
			</Page>
		);
	},
};

void mountPage(() => t("overlay.title"), overlayUpdatePage);
