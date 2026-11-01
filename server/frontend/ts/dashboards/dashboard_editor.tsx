/* The dashboard grid page, shared by the two entity pages:
 *   dashboard_view.tsx    /dashboards/view/<id>/  read-only
 *   dashboard_update.tsx  /dashboards/edit/<id>/  editing
 * One GridStack grid renders the live widgets; the update page makes the
 * dashboard name and colour editable and lets widgets be dragged/resized,
 * hidden, removed, renamed and re-configured; new widgets are added on the
 * dedicated page `/dashboards/add/<id>/` (dashboard_add.tsx). "Edit" / "Done"
 * navigate between the two URLs. Layout + name changes autosave (debounced)
 * with optimistic concurrency: a 409 reloads the server copy and toasts the
 * conflict. Broadcast `dashboards.changed` events rebase the dashboard from
 * the server. */

import {
	Button,
	IconButton,
	Page,
	ServerNav,
	TitleWithBack,
	Toast,
	useToast,
} from "@ui/components/";
import m from "mithril";
import type {
	ServerDashboard,
	ServerDashboardWidget,
} from "../../../../shared/contracts/wire";
import { ApiError, apiJson, apiTry } from "../../../../shared/ui/api_client";
import { Icon } from "../../../../shared/ui/components/icons";
import { t } from "../../../../shared/ui/i18n";
import { mountPage, setHeaderColor } from "../../../../shared/ui/util";
import { DEFAULT_COLOR } from "../../../../shared/validate";
import { GridDashboard } from "./dashboard_grid";
import {
	DASHBOARD_LIST_URL,
	dashboardAddUrl,
	dashboardUpdateUrl,
	dashboardViewUrl,
} from "./dashboard_urls";
import {
	ensureDashboardsWs,
	refreshDevices,
	setDashboardChangedSink,
	setWidgetConfigSaver,
	syncConnectionsFor,
	type WidgetActions,
} from "./dashboard_widgets";

const SAVE_DEBOUNCE_MS = 500;
const PATH_RE = /\/dashboards\/(?:view|edit)\/([^/]+)\/?$/;

export type DashboardPageMode = "view" | "update";

type SaveState = "idle" | "saving" | "saved" | "error";

const state = {
	dash: undefined as ServerDashboard | undefined,
	notFound: false,
	editMode: false,
	saveState: "idle" as SaveState,
	saving: false,
};

let saveTimer: number | null = null;
let savedTimer: number | null = null;
const toast = useToast();

// -------------------------------------------------------------------- helpers

function colsOf(dash: ServerDashboard | undefined): number {
	return dash?.columns ?? 12;
}

async function toggleFullscreen(): Promise<void> {
	try {
		if (document.fullscreenElement) await document.exitFullscreen();
		else {
			const main = document.querySelector("main");
			if (!main) throw new Error("Main element not found");
			await main.requestFullscreen();
		}
	} catch (err) {
		toast.show(
			t("dash.fullscreen_error", {
				error: err instanceof Error ? err.message : String(err),
			}),
		);
	}
}

// ---------------------------------------------------------------------- save

function scheduleSave(): void {
	state.saveState = "saving";
	if (saveTimer !== null) window.clearTimeout(saveTimer);
	saveTimer = window.setTimeout(() => void doSave(), SAVE_DEBOUNCE_MS);
	m.redraw();
}

async function doSave(): Promise<void> {
	const dash = state.dash;
	if (!dash || state.saving) return;
	if (saveTimer !== null) {
		window.clearTimeout(saveTimer);
		saveTimer = null;
	}
	state.saving = true;
	state.saveState = "saving";
	m.redraw();
	try {
		const body = await apiJson<{ dashboard?: ServerDashboard }>(
			`/api/dashboards/${encodeURIComponent(dash.id)}`,
			{
				method: "PUT",
				body: {
					name: dash.name,
					color: dash.color,
					widgets: dash.widgets,
					version: dash.version,
				},
			},
		);
		const fresh = body.dashboard;
		if (fresh) {
			// Adopt the bumped version so the next save targets the latest revision;
			// keep our local widget objects (live bodies reference them).
			dash.version = fresh.version;
			dash.name = fresh.name;
			dash.color = fresh.color;
			dash.columns = fresh.columns;
		}
		state.saveState = "saved";
		if (savedTimer !== null) window.clearTimeout(savedTimer);
		savedTimer = window.setTimeout(() => (state.saveState = "idle"), 2_000);
	} catch (err) {
		if (err instanceof ApiError && err.status === 409) {
			// another client saved first: rebase onto its copy
			const conflict = err.body as { current?: ServerDashboard } | null;
			await resync(conflict?.current);
			toast.show(t("dash.conflict"), true);
			return;
		}
		state.saveState = "error";
		// Show the server's reason (e.g. a widget bound to a removed device);
		// validation failures come back as `ok: false` with that reason.
		const detail =
			err instanceof Error && err.message ? ` (${err.message})` : "";
		toast.show(t("dash.save_error") + detail);
	} finally {
		state.saving = false;
		m.redraw();
	}
}

/** Rebase the dashboard onto the server copy (a saved `prefer` or a fresh GET). */
async function resync(prefer?: ServerDashboard): Promise<void> {
	const id = state.dash?.id;
	if (!id) return;
	let fresh = prefer;
	if (!fresh)
		fresh = (
			await apiTry<{ dashboard?: ServerDashboard }>(
				`/api/dashboards/${encodeURIComponent(id)}`,
			)
		)?.dashboard;
	if (fresh) {
		state.dash = {
			...state.dash!,
			widgets: fresh.widgets,
			version: fresh.version,
			name: fresh.name,
			color: fresh.color,
			columns: fresh.columns,
		};
		syncConnectionsFor(state.dash);
	}
	state.saveState = "idle";
	m.redraw();
}

// -------------------------------------------------------------- widget edits

function onLayout(widgets: ServerDashboardWidget[]): void {
	if (!state.dash) return;
	state.dash = { ...state.dash!, widgets };
	scheduleSave();
}

function removeWidget(widget: ServerDashboardWidget): void {
	const dash = state.dash;
	if (!dash) return;
	state.dash = {
		...dash,
		widgets: dash.widgets.filter((w) => w.id !== widget.id),
	};
	syncConnectionsFor(state.dash);
	scheduleSave();
}

function hideWidget(widget: ServerDashboardWidget): void {
	const dash = state.dash;
	if (!dash) return;
	state.dash = {
		...dash,
		widgets: dash.widgets.map((w) =>
			w.id === widget.id ? { ...w, visible: !w.visible } : w,
		),
	};
	scheduleSave();
}

const actions: WidgetActions = { remove: removeWidget, hide: hideWidget };

// ------------------------------------------------------------- dashboard ops

function onNameInput(value: string): void {
	const dash = state.dash;
	if (!dash) return;
	dash.name = value;
	// The API rejects a blank name, so only save once there is one.
	if (value.trim()) scheduleSave();
}

function onColorInput(value: string): void {
	const dash = state.dash;
	if (!dash) return;
	dash.color = value;
	setHeaderColor(value);
	scheduleSave();
}

function onDashboardsChanged(
	data: {
		id: string;
		color?: string;
		widgets: ServerDashboardWidget[];
		version: number;
	} | null,
): void {
	// Saved from another client/window: rebase onto the server copy silently.
	if (!data || data.id !== state.dash?.id) return;
	void resync({
		...state.dash!,
		color: data.color,
		widgets: data.widgets,
		version: data.version,
	});
}

// ----------------------------------------------------------------------- view

const App: m.Component = {
	view() {
		if (state.notFound) {
			return (
				<Page title={t("dash.title")} nav={<ServerNav active="dashboards" />}>
					<p class="muted">{t("dash.not_found")}</p>
				</Page>
			);
		}
		const dash = state.dash;
		return (
			<Page
				title={
					<TitleWithBack href={DASHBOARD_LIST_URL} backLabel={t("dash.back")}>
						{dash ? (
							state.editMode ? (
								<input
									class="dash-name-input"
									type="text"
									value={dash.name}
									aria-label={t("dash.rename")}
									oninput={(e: Event) =>
										onNameInput((e.target as HTMLInputElement).value)
									}
								/>
							) : (
								dash.name
							)
						) : (
							t("dash.title")
						)}
					</TitleWithBack>
				}
				nav={
					dash ? (
						<>
							{state.editMode ? (
								<input
									class="dash-color-input"
									type="color"
									value={dash.color ?? DEFAULT_COLOR}
									title={t("dash.color")}
									aria-label={t("dash.color")}
									oninput={(e: Event) =>
										onColorInput((e.target as HTMLInputElement).value)
									}
								/>
							) : null}
							<Button
								class="dash-edittoggle secondary"
								aria-pressed={state.editMode}
								label={t(state.editMode ? "dash.done" : "dash.edit")}
								onclick={() => {
									location.href = state.editMode
										? dashboardViewUrl(dash.id)
										: dashboardUpdateUrl(dash.id);
								}}
							/>
						</>
					) : undefined
				}
				headerRight={[
					dash
						? [
								<span
									class={["dash-save", `dash-save-${state.saveState}`]
										.filter(Boolean)
										.join(" ")}
								>
									{state.saveState === "idle"
										? ""
										: t(
												state.saveState === "saving"
													? "dash.saving"
													: state.saveState === "saved"
														? "dash.saved"
														: "dash.save_error",
											)}
								</span>,
								<IconButton
									class="dash-fullscreen"
									label={t(
										document.fullscreenElement
											? "dash.exit_fullscreen"
											: "dash.fullscreen",
									)}
									icon={
										<Icon
											name={
												document.fullscreenElement
													? "exit-fullscreen"
													: "fullscreen"
											}
											class="role-icon"
										/>
									}
									aria-pressed={!!document.fullscreenElement}
									disabled={!document.fullscreenEnabled}
									onclick={() => void toggleFullscreen()}
								/>,
							]
						: null,
				]}
			>
				{dash ? (
					[
						<Toast message={toast.message} />,
						state.editMode ? (
							<div class="dash-add-bar">
								<button
									class="dash-add"
									type="button"
									onclick={() => {
										location.href = dashboardAddUrl(dash.id);
									}}
								>{`+ ${t("dash.add_widget")}`}</button>
							</div>
						) : null,
						<GridDashboard
							widgets={dash.widgets}
							columns={colsOf(dash)}
							editMode={state.editMode}
							actions={actions}
							onLayout={onLayout}
						/>,
						dash.widgets.length ? null : (
							<p class="dash-empty muted">{t("dash.no_widgets")}</p>
						),
					]
				) : (
					<p class="muted">{t("mgmt.loading")}</p>
				)}
			</Page>
		);
	},
};

// -------------------------------------------------------------------- startup

/** Mount the page in the given mode; the dashboard id comes from the URL. */
export function mountDashboardPage(mode: DashboardPageMode): void {
	state.editMode = mode === "update";
	void (async () => {
		const id = PATH_RE.exec(location.pathname)?.[1] ?? "";
		const body = await apiTry<{ dashboard: ServerDashboard }>(
			`/api/dashboards/${encodeURIComponent(id)}`,
		);
		if (body?.dashboard) {
			state.dash = body.dashboard;
			setHeaderColor(state.dash.color ?? DEFAULT_COLOR);
		} else state.notFound = true;
		setWidgetConfigSaver(() => scheduleSave());
		setDashboardChangedSink(onDashboardsChanged);
		await refreshDevices();
		syncConnectionsFor(state.dash);
		// One-time startup sync: devices.changed then keeps the devices and the
		// widget connections in step, so no polling timer is needed.
		ensureDashboardsWs();
		m.redraw();
	})();
	document.addEventListener("fullscreenchange", () => m.redraw());
	void mountPage(() => t("dash.title"), App);
}
