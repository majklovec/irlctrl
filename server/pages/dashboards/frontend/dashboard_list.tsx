/* Dashboards list page: create, view, edit, delete dashboards. The list stays
 * in sync over the shared feed websocket (dashboards.snapshot /
 * dashboards.changed); the initial fetch only loads the page before the socket
 * opens. */

import { ApiError, apiJson, apiTry } from "@ui/api_client";
import {
	Button,
	Card,
	EmptyState,
	IconButton,
	IconLink,
	Input,
	Page,
	RowActions,
	Table,
	Toolbar,
} from "@ui/components/";
import { ServerNav } from "../../../shell/nav";
import { confirmDialog } from "@ui/components/confirm";
import { Icon } from "@ui/components/icons";
import { t } from "@ui/i18n";
import { mountPage } from "@ui/util";
import m from "mithril";
import type { ServerDashboard } from "../../../../shared/contracts/wire";
import { serverLive } from "../../../shell/live";
import { dashboardViewUrl } from "./dashboard_urls";

const state = {
	dashboards: [] as ServerDashboard[],
	newName: "",
	saving: false,
	// Inline rename (overlay-style): the dashboard row whose name is being
	// edited and the text currently typed into that row's input.
	renamingDashboardId: null as string | null,
	renameValue: "",
};

serverLive.on({
	dashboards: (list) => {
		state.dashboards = list;
		m.redraw();
	},
});

// Rescope to the newly selected project when the shell's selector changes it.
window.addEventListener("project-changed", () => {
	void refresh();
});

async function refresh(): Promise<void> {
	const body = await apiTry<{ dashboards: ServerDashboard[] }>(
		"/api/dashboards",
	);
	if (body) {
		state.dashboards = body.dashboards;
		m.redraw();
	}
}

function createDashboard(): void {
	const name = state.newName.trim();
	if (!name) return;
	state.saving = true;
	m.redraw();
	void apiJson<{ dashboard: ServerDashboard; dashboards: ServerDashboard[] }>(
		"/api/dashboards",
		{ body: { name, widgets: [] } },
	)
		.then((body) => {
			state.dashboards = body.dashboards;
			state.newName = "";
		})
		.catch((err) => console.error("dashboard create:", err))
		.finally(() => {
			state.saving = false;
			m.redraw();
		});
}

function renameDashboard(d: ServerDashboard, rawName: string): void {
	const name = rawName.trim();
	if (!name) return;
	// Optimistic: show the new name immediately.
	state.dashboards = state.dashboards.map((x) =>
		x.id === d.id ? { ...x, name } : x,
	);
	m.redraw();
	const payload = {
		name,
		color: d.color,
		widgets: d.widgets,
		version: d.version,
	};
	void apiJson<{ dashboard: ServerDashboard; dashboards: ServerDashboard[] }>(
		`/api/dashboards/${encodeURIComponent(d.id)}`,
		{ method: "PUT", body: payload },
	)
		.then((body) => {
			state.dashboards = body.dashboards;
		})
		.catch((err) => {
			// A 409 means someone renamed it first: rebase onto the server's
			// version and retry once.
			if (err instanceof ApiError && err.status === 409) {
				const current = (err.body as { current?: ServerDashboard } | null)
					?.current;
				if (current && name !== current.name) {
					void apiJson<{ dashboards: ServerDashboard[] }>(
						`/api/dashboards/${encodeURIComponent(d.id)}`,
						{
							method: "PUT",
							body: {
								name,
								color: current.color,
								widgets: current.widgets,
								version: current.version,
							},
						},
					)
						.then((body) => {
							state.dashboards = body.dashboards;
							m.redraw();
						})
						.catch(() => void refresh());
				}
			} else {
				void refresh();
			}
		});
}

/** Inline rename control for a dashboard row (Enter / blur commit, Escape
 * cancels). */
function dashRenameInput() {
	return (
		<input
			class="dash-rename"
			value={state.renameValue}
			oninput={(ev: Event) =>
				(state.renameValue = (ev.target as HTMLInputElement).value)
			}
			onkeydown={(ev: KeyboardEvent) => {
				if (ev.key === "Enter") (ev.target as HTMLInputElement).blur();
				if (ev.key === "Escape") {
					state.renamingDashboardId = null;
					m.redraw();
				}
			}}
			onblur={() => {
				const d = state.dashboards.find(
					(x) => x.id === state.renamingDashboardId,
				);
				if (d) void renameDashboard(d, state.renameValue);
				state.renamingDashboardId = null;
				m.redraw();
			}}
			oncreate={(v) => {
				const el = v.dom as HTMLInputElement;
				el.focus();
				el.select();
			}}
		/>
	);
}

async function deleteDashboard(d: ServerDashboard): Promise<void> {
	if (
		!(await confirmDialog(t("dash.delete_confirm", { name: d.name }), {
			danger: true,
		}))
	)
		return;
	try {
		const body = await apiJson<{ dashboards: ServerDashboard[] }>(
			`/api/dashboards/${encodeURIComponent(d.id)}`,
			{ method: "DELETE" },
		);
		state.dashboards = body.dashboards;
	} catch (err) {
		console.error("dashboard delete:", err);
	}
	m.redraw();
}

function list(): m.Vnode {
	return (
		<Table
			columns={[
				{ key: "name", header: t("dash.name") },
				{ key: "widgets", header: t("dash.widgets") },
			]}
		>
			{state.dashboards.map((d) => (
				<tr key={d.id}>
					<td class="dash-name">
						{state.renamingDashboardId === d.id ? (
							dashRenameInput()
						) : (
							<a class="dash-row-link" href={dashboardViewUrl(d.id)}>
								<span
									class="dash-dot"
									style={
										d.color
											? `background:${d.color};color:${d.color}`
											: ""
									}
								/>
								{d.name}
							</a>
						)}
					</td>
					<td class="muted">{`${d.widgets.length} ${d.widgets.length === 1 ? t("dash.widget") : t("dash.widgets").toLowerCase()}`}</td>
					<RowActions>
						<IconLink
							href={dashboardViewUrl(d.id)}
							label={t("dash.view")}
							icon={<Icon name="view" class="role-icon" />}
						/>
						<IconButton
							label={t("dash.rename")}
							title={t("dash.rename")}
							icon={<Icon name="edit" class="role-icon" />}
							onclick={() => {
								state.renamingDashboardId = d.id;
								state.renameValue = d.name;
								m.redraw();
							}}
						/>
						<IconButton
							danger
							label={t("dash.delete")}
							icon={<Icon name="delete" class="role-icon" />}
							onclick={() => void deleteDashboard(d)}
						/>
					</RowActions>
				</tr>
			))}
		</Table>
	);
}

function createToolbar(): m.Vnode {
	return (
		<Toolbar label={t("dash.create_new")}>
			<Input
				target={state}
				prop="newName"
				placeholder={t("dash.new_placeholder")}
			/>
			<Button
				label={t("tpl.create")}
				onclick={createDashboard}
				disabled={state.saving || !state.newName.trim()}
				title={
					state.newName.trim()
						? undefined
						: t("ui.enter_name_to_create")
				}
			/>
		</Toolbar>
	);
}

function dashboardsCard(): m.Vnode {
	return (
		<Card>
			{state.dashboards.length ? (
				[list(), createToolbar()]
			) : (
				<EmptyState message={t("dash.empty")}>{createToolbar()}</EmptyState>
			)}
		</Card>
	);
}

const App: m.Component = {
	view: () => (
		<Page nav={<ServerNav active="dashboards" />}>{dashboardsCard()}</Page>
	),
};

void refresh();
void mountPage(() => t("dash.title"), App);
