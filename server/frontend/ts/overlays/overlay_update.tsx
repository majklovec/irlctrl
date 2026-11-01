/** @jsx m */
/*
 * Overlay editor page (/overlays/edit/<scene id>/):
 *   toolbar:    undo/redo + one "add" button per registered element type
 *   center:     zoomable canvas — select / drag / resize / nudge / snap
 *   right rail: the layers list, each row expanding into the element's
 *               inspector (transform, props, bindings)
 *   footers:    variables (live), triggers (fire), runtime URL (copy/rotate)
 *
 * The scene renders through the SHARED overlay render views so the preview is
 * pixel-identical to the OBS runtime; the editor only layers a selection box +
 * resize handles on top. The server is the source of truth: every mutation is
 * pushed to the REST API and the live feed re-syncs the local copy
 * (overlay_store.ts). Undo/redo (100 steps) tracks the active scene's
 * elements. Controls are raw <input>/<select> bound imperatively (the ui
 * kit's bound controls target a fixed state object, which doesn't fit a
 * canvas editor).
 */

import { Page, ServerNav } from "@ui/components";
import m from "mithril";
import { t } from "../../../../shared/ui/i18n";
import { mountPage } from "../../../../shared/ui/util";
import { canvasArea } from "./editor/canvas";
import { onKey } from "./editor/keyboard";
import { inspector } from "./editor/layers";
import { runtimePanel } from "./editor/runtime_panel";
import { editorTitle, editorToolbar } from "./editor/toolbar";
import { triggersPanel } from "./editor/triggers";
import { variablesPanel } from "./editor/variables";
import {
	LIST_URL,
	load,
	scene,
	sceneIdFromLocation,
	state,
} from "./overlay_store";

const overlayUpdatePage: m.Component = {
	oncreate() {
		void load(sceneIdFromLocation()).then(() => {
			// the URL names a scene that no longer exists → back to the list
			if (state.loaded && !scene()) location.replace(LIST_URL);
		});
		window.addEventListener("keydown", onKey, true);
	},
	onremove() {
		window.removeEventListener("keydown", onKey, true);
	},
	view: () => {
		if (!state.loaded || !scene())
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
					<div class="ov-footers">
						{variablesPanel()}
						{triggersPanel()}
						{runtimePanel()}
					</div>
				</div>
			</Page>
		);
	},
};

void mountPage(() => t("overlay.title"), overlayUpdatePage);
