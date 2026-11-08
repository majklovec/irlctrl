/* Profile page: change the login password. (Device tokens live on the
 * project page now — they are project-scoped, not per-user.) */

import { apiJson } from "@ui/api_client";
import {
	Actions,
	Badge,
	Button,
	Card,
	Field,
	FieldGroup,
	Form,
	Input,
	Page,
} from "@ui/components/";
import { ServerNav } from "./nav";
import { i18nReady, LanguageSelect, t } from "@ui/i18n";
import { mountPage } from "@ui/util";
import m from "mithril";

interface Invitation {
	code: string;
	created_at: string;
	expires_at: string | null;
	used_at: string | null;
	used_by: string | null;
	created_by: string | null;
}

const state = {
	username: "",

	current: "",
	next: "",
	confirm: "",
	pwBusy: false,
	pwOk: false,
	pwError: false,

	admin: false,
	invitations: undefined as Invitation[] | undefined,
	creatingInvite: false,
};

function render(): void {
	m.redraw();
}

/** Load the profile (username, admin flag) and, for admins, the invitation
 * history. Device tokens are project-scoped and live on the project page. */
async function load(): Promise<void> {
	try {
		const body = await apiJson<{ username: string; admin: boolean }>(
			"/api/profile",
		);
		state.username = body.username;
		state.admin = body.admin;
		render();
		if (body.admin) void loadInvitations();
	} catch {
		render();
	}
}

/** GET /api/invitations → the admin's invitation history (newest first). */
async function loadInvitations(): Promise<void> {
	try {
		const body = await apiJson<{ invitations: Invitation[] }>(
			"/api/invitations",
		);
		state.invitations = body.invitations;
		render();
	} catch {
		render();
	}
}

/** POST /api/invitations to mint a code, then refresh the list. */
function mintInvite(): void {
	if (state.creatingInvite) return;
	state.creatingInvite = true;
	render();
	void apiJson("/api/invitations", { method: "POST" })
		.then(() => loadInvitations())
		.catch(() => {})
		.finally(() => {
			state.creatingInvite = false;
			render();
		});
}

/** Copy the invite code to the clipboard (best effort, no toast). */
function copyInvite(code: string): void {
	void navigator.clipboard?.writeText(code).catch(() => {});
}

/** POST /api/profile/password, then clear the fields. */
function changePassword(): void {
	if (state.pwBusy) return;
	if (state.next !== state.confirm) {
		state.pwOk = false;
		state.pwError = true;
		render();
		return;
	}
	state.pwBusy = true;
	state.pwOk = false;
	state.pwError = false;
	render();
	void apiJson("/api/profile/password", {
		body: { current: state.current, new: state.next },
	})
		.then(() => {
			state.pwOk = true;
			state.current = "";
			state.next = "";
			state.confirm = "";
		})
		.catch(() => {
			state.pwError = true;
		})
		.finally(() => {
			state.pwBusy = false;
			render();
		});
}

const App: m.Component = {
	oncreate() {
		void load();
	},
	view: () => (
		<Page title={t("nav.profile")} nav={<ServerNav active="profile" />}>
			<Card title={t("profile.language.title")}>
				<div class="profile-language">
					<LanguageSelect />
				</div>
			</Card>
			<Card title={t("login.password")}>
				<Form onSubmit={changePassword}>
					<FieldGroup legend={t("profile.password.change")}>
						<Field
							label={t("profile.password.current")}
							control={
								<Input
									target={state}
									prop="current"
									type="password"
									autocomplete="current-password"
									disabled={state.pwBusy}
								/>
							}
						/>
						<Field
							label={t("profile.password.new")}
							control={
								<Input
									target={state}
									prop="next"
									type="password"
									autocomplete="new-password"
									disabled={state.pwBusy}
								/>
							}
						/>
						<Field
							label={t("profile.password.confirm")}
							control={
								<Input
									target={state}
									prop="confirm"
									type="password"
									autocomplete="new-password"
									disabled={state.pwBusy}
								/>
							}
						/>
						{state.pwOk ? (
							<p class="ok">{t("profile.password.saved")}</p>
						) : null}
						{state.pwError ? (
							<p class="error">{t("profile.password.error")}</p>
						) : null}
						<Actions>
							<button type="submit" disabled={state.pwBusy}>
								{t("profile.password.submit")}
							</button>
						</Actions>
					</FieldGroup>
				</Form>
			</Card>
			{state.admin ? (
				<Card
					title={t("profile.invitations.title")}
					headActions={
						<Button
							label={
								state.creatingInvite
									? t("invitations.generating")
									: t("invitations.create")
							}
							disabled={state.creatingInvite}
							onclick={mintInvite}
						/>
					}
				>
					{state.invitations === undefined ? (
						<p class="muted">{t("mgmt.loading")}</p>
					) : state.invitations.length === 0 ? (
						<p class="muted">{t("profile.invitations.empty")}</p>
					) : (
						<table class="dash-table">
							<thead>
								<tr>
									<th>{t("invitations.code")}</th>
									<th>{t("invitations.created")}</th>
									<th>{t("invitations.expires")}</th>
									<th>{t("invitations.status")}</th>
									<th />
								</tr>
							</thead>
							<tbody>
								{state.invitations.map((inv) => {
									const used = inv.used_by !== null;
									const expired =
										!used &&
										inv.expires_at !== null &&
										new Date(inv.expires_at) < new Date();
									const status = used
										? t("invitations.statusUsed", { user: inv.used_by ?? "" })
										: expired
											? t("invitations.statusExpired")
											: t("invitations.statusAvailable");
									const kind = used ? "off" : expired ? "warn" : "on";
									return (
										<tr key={inv.code}>
											<td>
												<code class="token-value">{inv.code}</code>
											</td>
											<td>{new Date(inv.created_at).toLocaleString()}</td>
											<td>
												{inv.expires_at
													? new Date(inv.expires_at).toLocaleString()
													: "—"}
											</td>
											<td>
												<Badge text={status} kind={kind} />
											</td>
											<td>
												{!used && !expired ? (
													<Button
														label={t("invitations.copy")}
														title={t("invitations.copy")}
														aria-label={t("invitations.copy")}
														onclick={() => copyInvite(inv.code)}
													/>
												) : null}
											</td>
										</tr>
									);
								})}
							</tbody>
						</table>
					)}
				</Card>
			) : null}
		</Page>
	),
};

void mountPage(() => t("nav.profile"), App);
// Redraw once the catalogs land so the first paint is already translated
void i18nReady.then(() => m.redraw());
