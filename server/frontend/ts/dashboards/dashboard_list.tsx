/* Dashboards list page: create, view, edit, delete dashboards. The list stays
 * in sync over the shared feed websocket (dashboards.snapshot /
 * dashboards.changed); the initial fetch only loads the page before the socket
 * opens. */

import {
	Button,
	Card,
	EmptyState,
	IconButton,
	IconLink,
	Input,
	Page,
	RowActions,
	ServerNav,
	Table,
	Toolbar,
} from "@ui/components";
import m from "mithril";
import type { ServerDashboard } from "../../../../shared/contracts/wire";
import { apiJson, apiTry } from "../../../../shared/ui/api_client";
import { confirmDialog } from "../../../../shared/ui/components/confirm";
import { Icon } from "../../../../shared/ui/components/icons";
import { t } from "../../../../shared/ui/i18n";
import { mountPage } from "../../../../shared/ui/util";
import { serverLive } from "../services/serverws";
import { dashboardUpdateUrl, dashboardViewUrl } from "./dashboard_urls";

const state = {
	dashboards: [] as ServerDashboard[],
	newName: "",
	saving: false,
};

serverLive.on({
	dashboards: (list) => {
		state.dashboards = list;
		m.redraw();
	},
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
						<a class="dash-row-link" href={dashboardViewUrl(d.id)}>
							<span
								class="dash-dot"
								style={d.color ? `background:${d.color};color:${d.color}` : ""}
							/>
							{d.name}
						</a>
					</td>
					<td class="muted">{`${d.widgets.length} ${d.widgets.length === 1 ? t("dash.widget") : t("dash.widgets").toLowerCase()}`}</td>
					<RowActions>
						<IconLink
							href={dashboardViewUrl(d.id)}
							label={t("dash.view")}
							icon={<Icon name="view" class="role-icon" />}
						/>
						<IconLink
							href={dashboardUpdateUrl(d.id)}
							label={t("dash.edit")}
							icon={<Icon name="edit" class="role-icon" />}
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
				label={t("dash.create")}
				onclick={createDashboard}
				disabled={state.saving || !state.newName.trim()}
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
