/* Dashboards list page: create, view, edit, delete dashboards. The list stays
 * in sync over the shared feed websocket (dashboards.snapshot /
 * dashboards.changed); the initial fetch only loads the page before the socket
 * opens. */
import m from "mithril";
import { apiJson, apiTry } from "../../../../shared/ui/api_client";
import { confirmDialog } from "../../../../shared/ui/components/confirm";
import { dashboardUpdateUrl, dashboardViewUrl } from "./dashboard_urls";
import type { ServerDashboard } from "../../../../shared/contracts/wire";
import { Icon } from "../../../../shared/ui/components/icons";
import {
	Button,
	Card,
	Input,
	Page,
	ServerNav,
} from "../../../../shared/ui/components/ui";
import { t } from "../../../../shared/ui/i18n";
import { serverLive } from "../services/serverws";
import { mountPage } from "../../../../shared/ui/util";

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
		<table class="dash-table">
			<thead>
				<tr>
					<th>{t("dash.name")}</th>
					<th>{t("dash.widgets")}</th>
					<th />
				</tr>
			</thead>
			<tbody>
				{state.dashboards.map((d) => (
					<tr key={d.id}>
						<td class="dash-name">
							<a class="dash-row-link" href={dashboardViewUrl(d.id)}>
								<span
									class="dash-dot"
									style={
										d.color ? `background:${d.color};color:${d.color}` : ""
									}
								/>
								{d.name}
							</a>
						</td>
						<td class="muted">{`${d.widgets.length} ${d.widgets.length === 1 ? t("dash.widget") : t("dash.widgets").toLowerCase()}`}</td>
						<td class="actions-cell">
							<div class="dash-row-actions">
								{[
									<a
										class="icon-link"
										href={dashboardViewUrl(d.id)}
										title={t("dash.view")}
										aria-label={t("dash.view")}
									>
										<Icon name="view" class="role-icon" />
									</a>,
									<a
										class="icon-link"
										href={dashboardUpdateUrl(d.id)}
										title={t("dash.edit")}
										aria-label={t("dash.edit")}
									>
										<Icon name="edit" class="role-icon" />
									</a>,
									<Button
										label={<Icon name="delete" class="role-icon" />}
										class="icon-link dash-delete"
										title={t("dash.delete")}
										aria-label={t("dash.delete")}
										onclick={() => void deleteDashboard(d)}
									/>,
								]}
							</div>
						</td>
					</tr>
				))}
			</tbody>
		</table>
	);
}

function createToolbar(): m.Vnode {
	return (
		<div class="dash-toolbar">
			<span class="dash-empty-text">{t("dash.create_new")}</span>
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
		</div>
	);
}

function dashboardsCard(): m.Vnode {
	return (
		<Card>
			{state.dashboards.length ? (
				[list(), createToolbar()]
			) : (
				<div class="dash-empty">
					<p class="muted">{t("dash.empty")}</p>
					{createToolbar()}
				</div>
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
