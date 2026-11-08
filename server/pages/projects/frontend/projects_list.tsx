/** @jsx m */
/*
 * Projects page (TODO/01-projects.md): the user's projects with their
 * membership roles, plus the management of the selected project — rename,
 * delete, member roles and the single-use invite links. The same page
 * doubles as the invite-accept screen: under /projects/join/<token> it
 * shows the join card instead of the list.
 */
import { apiJson, isUnauthorized } from "@ui/api_client";
import {
	Badge,
	Button,
	Card,
	confirmDialog,
	EmptyState,
	Field,
	FieldGroup,
	Form,
	IconButton,
	Input,
	Modal,
	Page,
	RowActions,
	Select,
	Table,
	Toolbar,
} from "@ui/components/";
import { Icon } from "@ui/components/icons";
import { i18nReady, t } from "@ui/i18n";
import type { MithrilJSXComponent } from "@ui/jsx";
import { mountPage } from "@ui/util";
import m from "mithril";
import { ServerNav } from "../../../shell/nav";
import { setActiveProjectId } from "../../../shell/project_select";
import "./projects.css";

type ProjectRole = "owner" | "editor" | "viewer";
type InviteRole = "editor" | "viewer";

interface Project {
	id: string;
	name: string;
	role: ProjectRole;
}

interface Member {
	userId: number;
	login: string;
	role: ProjectRole;
}

interface Invite {
	id: string;
	role: InviteRole;
	url: string;
	createdAt: string;
	expiresAt: string | null;
	usedBy: string | null;
}

const state = {
	me: "",
	projects: undefined as Project[] | undefined,
	creating: false,
	newName: "",

	selected: null as Project | null,
	members: undefined as Member[] | undefined,
	invites: undefined as Invite[] | undefined,
	memberBusy: false,

	renameOpen: false,
	renameName: "",
	renameBusy: false,

	newInviteRole: "viewer" as InviteRole,
	inviteBusy: false,
	revoking: false,

	// The /projects/join/<token> screen.
	joinToken: "",
	joinBusy: false,
	joined: null as { name: string; role: string } | null,
	joinFailed: false,
};

const render = (): void => m.redraw();

/** The token this page was opened with ("" on the plain /projects/ page). */
function joinTokenFromPath(): string {
	const match = location.pathname.match(/^\/projects\/join\/([^/]+)$/);
	return match ? decodeURIComponent(match[1]) : "";
}

function isJoinPage(): boolean {
	return state.joinToken !== "";
}

async function loadProjects(): Promise<void> {
	try {
		const body = await apiJson<{ projects: Project[] }>("/api/projects");
		state.projects = body.projects;
		if (state.selected) {
			const fresh = body.projects.find((p) => p.id === state.selected?.id);
			if (!fresh) state.selected = null;
			else state.selected = fresh;
		} else if (!isJoinPage() && state.projects.length > 0)
			selectProject(state.projects[0].id);
		render();
	} catch {
		state.projects = state.projects ?? [];
		render();
	}
}

async function loadDetail(project: Project): Promise<void> {
	state.members = undefined;
	state.invites = undefined;
	render();
	try {
		const body = await apiJson<{ members: Member[] }>(
			`/api/projects/${project.id}/members`,
		);
		if (state.selected?.id === project.id) state.members = body.members;
		render();
	} catch {
		render();
	}
	if (project.role === "owner") await loadInvites(project.id);
}

async function loadInvites(projectId: string): Promise<void> {
	try {
		const body = await apiJson<{ invites: Invite[] }>(
			`/api/projects/${projectId}/invites`,
		);
		if (state.selected?.id === projectId) state.invites = body.invites;
		render();
	} catch {
		render();
	}
}

function selectProject(id: string): void {
	const project = state.projects?.find((p) => p.id === id) ?? null;
	state.selected = project;
	if (project) void loadDetail(project);
	render();
}

function createProject(): void {
	if (state.creating) return;
	const name = state.newName.trim();
	if (!name) return;
	state.creating = true;
	render();
	void apiJson<{ project: Project }>("/api/projects", {
		method: "POST",
		body: { name },
	})
		.then(({ project }) => {
			state.projects = [project, ...(state.projects ?? [])];
			state.newName = "";
			setActiveProjectId(project.id);
			selectProject(project.id);
		})
		.catch(render)
		.finally(() => {
			state.creating = false;
			render();
		});
}

function renameProject(): void {
	if (state.renameBusy || !state.selected) return;
	const name = state.renameName.trim();
	if (!name) return;
	const id = state.selected.id;
	state.renameBusy = true;
	render();
	void apiJson<{ project: Project }>(`/api/projects/${id}`, {
		method: "PATCH",
		body: { name },
	})
		.then(({ project }) => {
			if (state.selected?.id === id) state.selected = project;
			state.projects = (state.projects ?? []).map((p) =>
				p.id === project.id ? project : p,
			);
			state.renameOpen = false;
		})
		.catch(() => {})
		.finally(() => {
			state.renameBusy = false;
			render();
		});
}

async function deleteProject(project: Project): Promise<void> {
	const sure = await confirmDialog(
		t("projects.delete_confirm", { name: project.name }),
		{ okLabel: t("projects.delete"), danger: true },
	);
	if (!sure) return;
	try {
		await apiJson(`/api/projects/${project.id}`, { method: "DELETE" });
		if (state.selected?.id === project.id) {
			state.selected = null;
			setActiveProjectId(null);
		}
		await loadProjects();
	} catch {
		render();
	}
}

function patchMemberRole(member: Member, role: InviteRole): void {
	if (state.memberBusy || !state.selected) return;
	state.memberBusy = true;
	void apiJson(`/api/projects/${state.selected.id}/members/${member.userId}`, {
		method: "PATCH",
		body: { role },
	})
		.then(() => {
			state.members = (state.members ?? []).map((m) =>
				m.userId === member.userId ? { ...m, role } : m,
			);
			render();
		})
		.catch(render)
		.finally(() => {
			state.memberBusy = false;
			render();
		});
}

function removeMember(target: Member): void {
	if (!state.selected) return;
	void confirmDialog(`${target.login}`, {
		okLabel: t("projects.members.remove"),
		danger: true,
	}).then((sure) => {
		if (!sure || !state.selected) return;
		const id = state.selected.id;
		apiJson(`/api/projects/${id}/members/${target.userId}`, {
			method: "DELETE",
		})
			.then(() => {
				if (state.selected?.id !== id) return;
				state.members = (state.members ?? []).filter(
					(m) => m.userId !== target.userId,
				);
				render();
			})
			.catch(render);
	});
}

function createInvite(): void {
	if (state.inviteBusy || !state.selected) return;
	state.inviteBusy = true;
	render();
	void apiJson<{ invite: Invite }>(
		`/api/projects/${state.selected.id}/invites`,
		{ method: "POST", body: { role: state.newInviteRole } },
	)
		.then(({ invite }) => {
			state.invites = [invite, ...(state.invites ?? [])];
		})
		.catch(() => {})
		.finally(() => {
			state.inviteBusy = false;
			render();
		});
}

function copyInvite(url: string): void {
	void navigator.clipboard?.writeText(url).catch(() => {});
}

function revokeInvite(invite: Invite): void {
	if (state.revoking || !state.selected) return;
	state.revoking = true;
	render();
	void apiJson(`/api/projects/${state.selected.id}/invites/${invite.id}`, {
		method: "DELETE",
	})
		.then(() => {
			state.invites = (state.invites ?? []).filter((i) => i.id !== invite.id);
		})
		.catch(() => {})
		.finally(() => {
			state.revoking = false;
			render();
		});
}

function acceptInvite(): void {
	if (state.joinBusy || !state.joinToken) return;
	state.joinBusy = true;
	state.joinFailed = false;
	render();
	void apiJson<{ project: { name: string; role: string } }>(
		`/api/projects/join/${state.joinToken}`,
		{ method: "POST" },
	)
		.then(({ project }) => {
			state.joined = project;
			render();
		})
		.catch((err) => {
			if (isUnauthorized(err)) location.replace("/login");
			state.joinFailed = true;
			render();
		})
		.finally(() => {
			state.joinBusy = false;
			render();
		});
}

const roleBadge = (role: ProjectRole): m.Vnode => {
	const kind = role === "owner" ? "on" : role === "editor" ? "warn" : "off";
	return <Badge text={t(`projects.role.${role}`)} kind={kind} />;
};

/** The /projects/join/<token> screen: one card, the accept button, the result. */
const JoinViewComponent: m.Component = {
	view: () =>
		state.joined ? (
			<Card>
				<p class="ok">
					{t("projects.join.joined", {
						project: state.joined.name,
						role: t(`projects.role.${state.joined.role}`),
					})}
				</p>
				<div class="actions">
					<Button
						label={t("projects.join.open")}
						class="secondary"
						onclick={() => (location.href = "/projects/")}
					/>
				</div>
			</Card>
		) : (
			<Card title={t("projects.join.title")}>
				<code class="token-value join-token">{state.joinToken}</code>
				{state.joinFailed ? (
					<p class="error">{t("projects.join.failed")}</p>
				) : null}
				<div class="actions">
					<Button
						label={t("projects.join.accept")}
						disabled={state.joinBusy}
						onclick={acceptInvite}
					/>
				</div>
			</Card>
		),
};
const JoinView = JoinViewComponent as MithrilJSXComponent;

function createToolbar(): m.Vnode {
	return (
		<Toolbar label={t("projects.create_new")}>
			<Input
				target={state}
				prop="newName"
				placeholder={t("projects.new_placeholder")}
			/>
			<Button
				label={t("tpl.create")}
				onclick={createProject}
				disabled={state.creating || !state.newName.trim()}
				title={state.newName.trim() ? undefined : t("ui.enter_name_to_create")}
			/>
		</Toolbar>
	);
}

function projectsCard(): m.Children {
	if (state.projects === undefined) {
		return <p class="muted">{t("mgmt.loading")}</p>;
	}
	if (state.projects.length === 0) {
		return (
			<EmptyState message={t("projects.empty")}>{createToolbar()}</EmptyState>
		);
	}
	return [
		<Table
			columns={[
				{ key: "name", header: t("projects.name") },
				{ key: "role", header: t("mgmt.th.role") },
			]}
		>
			{state.projects.map((p) => (
				<tr
					key={p.id}
					class={state.selected?.id === p.id ? "active" : undefined}
					onclick={() => selectProject(p.id)}
				>
					<td>{p.name}</td>
					<td>{roleBadge(p.role)}</td>
					<RowActions>
						{p.role !== "viewer" ? (
							<IconButton
								label={t("projects.rename")}
								icon={<Icon name="edit" class="role-icon" />}
								onclick={(e: Event) => {
									e.stopPropagation();
									selectProject(p.id);
									state.renameName = state.selected?.name ?? p.name;
									state.renameOpen = true;
									render();
								}}
							/>
						) : null}
						{p.role === "owner" ? (
							<IconButton
								danger
								label={t("projects.delete")}
								icon={<Icon name="delete" class="role-icon" />}
								onclick={(e: Event) => {
									e.stopPropagation();
									void deleteProject(p);
								}}
							/>
						) : null}
					</RowActions>
				</tr>
			))}
		</Table>,
		createToolbar(),
	];
}

const App: m.Component = {
	oncreate() {
		state.joinToken = joinTokenFromPath();
		if (!isJoinPage()) void loadProjects();
	},
	view: () => (
		<Page nav={<ServerNav active="projects" />}>
			{isJoinPage() ? (
				<JoinView />
			) : (
				[
					<Card title={t("projects.title")} class="projects-list">
						{projectsCard()}
					</Card>,
					// The selected project's management (renamed above).
					state.selected
						? [
								<Card title={t("projects.members.title")}>
									{state.members === undefined ? (
										<p class="muted">{t("mgmt.loading")}</p>
									) : (
										<table class="dash-table">
											<thead>
												<tr>
													<th>{t("projects.name")}</th>
													<th>{t("mgmt.th.role")}</th>
													<th />
												</tr>
											</thead>
											<tbody>
												{state.members.map((mem) => (
													<tr key={mem.userId}>
														<td>
															{mem.login}
															{mem.login === state.me ? (
																<span class="muted">
																	{` (${t("projects.you")})`}
																</span>
															) : null}
														</td>
														<td>
															{mem.role === "owner" ? (
																roleBadge("owner")
															) : (
																<select
																	value={mem.role}
																	disabled={
																		state.memberBusy ||
																		state.selected?.role !== "owner"
																	}
																	onchange={(e: Event) =>
																		patchMemberRole(
																			mem,
																			(e.target as HTMLSelectElement)
																				.value as InviteRole,
																		)
																	}
																>
																	<option value="editor">
																		{t("projects.role.editor")}
																	</option>
																	<option value="viewer">
																		{t("projects.role.viewer")}
																	</option>
																</select>
															)}
														</td>
														<td>
															{state.selected?.role === "owner" &&
															mem.role !== "owner" ? (
																<Button
																	label={t("projects.members.remove")}
																	class="danger"
																	disabled={state.memberBusy}
																	onclick={() => removeMember(mem)}
																/>
															) : null}
														</td>
													</tr>
												))}
											</tbody>
										</table>
									)}
								</Card>,
								state.selected.role === "owner" ? (
									<Card title={t("projects.invites.title")}>
										{state.invites === undefined ? (
											<p class="muted">{t("mgmt.loading")}</p>
										) : state.invites.length === 0 ? (
											<p class="muted">{t("projects.invites.empty")}</p>
										) : (
											<table class="dash-table">
												<thead>
													<tr>
														<th>{t("projects.invites.link")}</th>
														<th>{t("mgmt.th.role")}</th>
														<th>{t("invitations.expires")}</th>
														<th />
													</tr>
												</thead>
												<tbody>
													{state.invites.map((inv) => (
														<tr key={inv.id}>
															<td>
																<code
																	class="token-value"
																	title={t("invitations.copy")}
																	onclick={() => copyInvite(inv.url)}
																>
																	{inv.url}
																</code>
																{inv.usedBy
																	? t("invitations.statusUsed", {
																			user: inv.usedBy,
																		})
																	: null}
															</td>
															<td>{t(`projects.role.${inv.role}`)}</td>
															<td>
																{inv.expiresAt
																	? new Date(inv.expiresAt).toLocaleString()
																	: "—"}
															</td>
															<td>
																{inv.usedBy ? null : (
																	<Button
																		label={t("projects.invites.revoke")}
																		class="danger"
																		disabled={state.revoking}
																		onclick={() => revokeInvite(inv)}
																	/>
																)}
															</td>
														</tr>
													))}
												</tbody>
											</table>
										)}
										<div class="actions invite-create">
											<Select
												target={state}
												prop="newInviteRole"
												disabled={state.inviteBusy}
											>
												<option value="editor">
													{t("projects.role.editor")}
												</option>
												<option value="viewer">
													{t("projects.role.viewer")}
												</option>
											</Select>
											<Button
												label={t("projects.invites.create")}
												disabled={state.inviteBusy}
												onclick={createInvite}
											/>
										</div>
									</Card>
								) : null,
								state.renameOpen ? (
									<Modal
										title={t("projects.rename")}
										onClose={() => {
											state.renameOpen = false;
											render();
										}}
									>
										<Form onSubmit={renameProject}>
											<FieldGroup legend={t("projects.rename")}>
												<Field
													label={t("projects.new_name")}
													control={<Input target={state} prop="renameName" />}
												/>
												<div class="actions">
													<Button
														label={t("ui.cancel")}
														class="secondary"
														onclick={() => {
															state.renameOpen = false;
															render();
														}}
													/>
													<button type="submit" disabled={state.renameBusy}>
														{t("projects.rename")}
													</button>
												</div>
											</FieldGroup>
										</Form>
									</Modal>
								) : null,
							]
						: null,
				]
			)}
		</Page>
	),
};

// The session login (for the "(you)" marker in the member list).
void apiJson<{ user?: string }>("/api/whoami")
	.then((body) => {
		state.me = body?.user ?? "";
		render();
	})
	.catch(() => {});

void mountPage(() => t("projects.title"), App);
// Redraw once the catalogs land so the first paint is already translated
void i18nReady.then(() => m.redraw());
